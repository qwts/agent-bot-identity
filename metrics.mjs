// Optional, read-only runtime metrics (qwts/agent-comms#86, ADR-0007
// decisions 5 to 8).
//
//   agent-bot metrics collect [--json]   read new session-log lines, update
//   agent-bot metrics show [--json]      print the latest observations
//   agent-bot metrics record-session     (session-start hook) record this
//                                        session for the worktree's soul
//
// A collector binds an observation to a soul only through a harness session
// recorded for it: the one its identity minted with (`transcript`), or one
// the session-start hook recorded from the worktree's binding or Agent ID
// pin. Never by matching names, paths, or model strings. A recorded session
// whose log cannot be found is reported as missing and nothing is assigned.
//
// Reads are incremental: one checkpoint per source (file identity + byte
// offset). A partial trailing line is left for the next run, and the
// checkpoint never moves past a line that was not handled. Each run reads at
// most `maxBytes` per source. A new source, or one whose identity changed or
// that got shorter, starts at its last `maxBytes`; the history before that is
// reported as `skippedBytes`, never silently passed over.
//
// Only allowlisted fields are kept: the reported model and the per-call token
// counts, with the call's timestamp. No message content, tool input, path, or
// raw line is stored. Messaging never depends on any of this: nothing here
// joins, registers, or authorizes anything, and collector errors are reported
// beside the observations instead of failing the caller.

import process from 'node:process';
import {
  closeSync, fchmodSync, fsyncSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, renameSync, statSync, writeSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
import { readAgentIdentity, stateDirectory, validateAgentId } from './agent-identity.mjs';
import { readBinding } from './agent-binding.mjs';

export const SOURCE_CLAUDE = 'claude-session-log';
const DEFAULT_MAX_BYTES = 8 << 20;
const SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9-]{7,127}$/;
const AGENT_ID = /^agent_[0-9a-f-]{36}$/;
const SESSIONS_PER_SOUL = 5;

export function metricsDirectory({ env = process.env, home = homedir() } = {}) {
  return join(dirname(stateDirectory({ env, home })), 'metrics');
}

function claudeProjectsDir({ env, home }) {
  return join(env.CLAUDE_CONFIG_DIR ?? join(home, '.claude'), 'projects');
}

function writePrivateJson(path, value) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.${process.pid}.tmp`;
  const fd = openSync(tmp, 'w', 0o600);
  try {
    fchmodSync(fd, 0o600);
    writeSync(fd, `${JSON.stringify(value, null, 2)}\n`);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, path);
}

function readJson(path, fallback) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    if (error?.code === 'ENOENT') return fallback;
    throw error;
  }
}

/**
 * The soul a worktree belongs to: its live binding, else its Agent ID pin.
 * Git reads ignore ambient GIT_CONFIG_* and repository overrides.
 */
export function worktreeSoul({ cwd, env = process.env, git } = {}) {
  try {
    const binding = readBinding({ env: { ...env, AGENT_BOT_BINDING: '' }, cwd });
    if (binding?.agentId) return binding.agentId;
  } catch { /* an unreadable binding falls through to the pin */ }
  const clean = Object.fromEntries(Object.entries(env).filter(([key]) => !/^GIT_/.test(key)));
  const run = git ?? ((args) => execFileSync('git', args, { cwd, env: clean, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }));
  for (const key of ['agentbot.agentid', 'qwts.agentId']) {
    try {
      const value = run(['config', '--worktree', '--get', key]).trim();
      if (value) return validateAgentId(value);
    } catch { /* unset */ }
  }
  return null;
}

/**
 * Records `{ provider, sessionId }` for the soul of `cwd`, keeping the newest
 * few per soul. Returns the agentId recorded, or null outside a soul's
 * worktree. Called by the session-start hook.
 */
export function recordSession({ provider, sessionId, cwd, env = process.env, home = homedir(), now = () => new Date(), git } = {}) {
  if (provider !== 'claude' || !SESSION_ID.test(sessionId ?? '') || !cwd) return null;
  const agentId = worktreeSoul({ cwd, env, git });
  if (!agentId) return null;
  return recordSoulSession({ agentId, provider, sessionId, env, home, now });
}

/**
 * Records `{ provider, sessionId }` for a soul the caller already knows,
 * such as the daemon's ACP turns, whose soul home is not a git worktree.
 * Returns the agentId recorded, or null for a non-Claude or invalid session.
 */
export function recordSoulSession({ agentId, provider, sessionId, env = process.env, home = homedir(), now = () => new Date(), history = null } = {}) {
  if (provider !== 'claude' || !SESSION_ID.test(sessionId ?? '') || !AGENT_ID.test(agentId ?? '')) return null;
  const path = join(metricsDirectory({ env, home }), 'sessions.json');
  const sessions = readJson(path, {});
  const kept = (sessions[agentId] ?? []).filter((entry) => entry.sessionId !== sessionId);
  const recordedAt = now().toISOString();
  sessions[agentId] = [{ provider, sessionId, recordedAt }, ...kept].slice(0, SESSIONS_PER_SOUL);
  writePrivateJson(path, sessions);
  // The soul's own copy of the binding (#583 decision 9): the session id
  // and harness, as the daemon records them, never the session's contents.
  if (history) { try { history.turn(agentId, { id: sessionId, kind: 'session', startedAt: recordedAt, harness: provider }); } catch { /* best effort */ } }
  return agentId;
}

/**
 * Every Claude session recorded for a soul: `[{ agentId, sessionId }]`, from
 * identity transcripts and from the session-start hook's records.
 */
export function claudeBoundSessions({ stateDir, metricsDir }) {
  const seen = new Set();
  const out = [];
  const add = (agentId, sessionId) => {
    const key = `${agentId}\u0000${sessionId}`;
    if (seen.has(key) || !AGENT_ID.test(agentId) || !SESSION_ID.test(sessionId ?? '')) return;
    seen.add(key);
    out.push({ agentId, sessionId });
  };
  for (const soul of claudeBoundSouls({ stateDir })) add(soul.agentId, soul.sessionId);
  const recorded = readJson(join(metricsDir, 'sessions.json'), {});
  for (const [agentId, entries] of Object.entries(recorded ?? {})) {
    for (const entry of Array.isArray(entries) ? entries : []) {
      if (entry?.provider === 'claude') add(agentId, entry.sessionId);
    }
  }
  return out;
}

/** Souls whose identity recorded a Claude session: `[{ agentId, sessionId }]`. */
export function claudeBoundSouls({ stateDir }) {
  let names;
  try {
    names = readdirSync(stateDir);
  } catch (error) {
    if (error?.code === 'ENOENT') return [];
    throw error;
  }
  const souls = [];
  for (const name of names.sort()) {
    if (!name.endsWith('.json')) continue;
    const agentId = name.slice(0, -5);
    if (!AGENT_ID.test(agentId)) continue;
    let record;
    try {
      record = readAgentIdentity(agentId, { stateDir });
    } catch {
      continue; // an invalid record binds nothing
    }
    const transcript = record.transcript;
    if (transcript?.provider === 'claude' && SESSION_ID.test(transcript.id ?? '')) {
      souls.push({ agentId, sessionId: transcript.id });
    }
  }
  return souls;
}

/** The session's log, found only by its exact recorded session id. */
export function findClaudeSessionLog(sessionId, { env = process.env, home = homedir() } = {}) {
  if (!SESSION_ID.test(sessionId)) return null;
  const root = claudeProjectsDir({ env, home });
  let projects;
  try {
    projects = readdirSync(root, { withFileTypes: true });
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
  for (const project of projects) {
    if (!project.isDirectory()) continue;
    const candidate = join(root, project.name, `${sessionId}.jsonl`);
    try {
      if (statSync(candidate).isFile()) return candidate;
    } catch { /* not in this project */ }
  }
  return null;
}

/** The allowlisted fields of one session-log line, or null when it carries no call usage. */
export function claudeCallFromLine(line) {
  let entry;
  try {
    entry = JSON.parse(line);
  } catch {
    return null;
  }
  if (entry?.type !== 'assistant' || entry.isSidechain === true) return null;
  const message = entry.message;
  const usage = message?.usage;
  if (!usage || typeof message.id !== 'string') return null;
  const count = (value) => (Number.isInteger(value) && value >= 0 ? value : null);
  return {
    id: message.id,
    model: typeof message.model === 'string' && message.model.length <= 120 ? message.model : null,
    inputTokens: count(usage.input_tokens),
    cacheReadTokens: count(usage.cache_read_input_tokens),
    cacheCreationTokens: count(usage.cache_creation_input_tokens),
    outputTokens: count(usage.output_tokens),
    at: typeof entry.timestamp === 'string' && !Number.isNaN(Date.parse(entry.timestamp)) ? new Date(entry.timestamp).toISOString() : null,
  };
}

/**
 * Reads new complete lines of `path` from `checkpoint`. Returns the calls
 * found and the next checkpoint, which never passes an unhandled line.
 */
export function readNewLines(path, checkpoint, { maxBytes = DEFAULT_MAX_BYTES } = {}) {
  const stat = statSync(path);
  const identity = `${stat.dev}:${stat.ino}`;
  const known = checkpoint?.identity === identity && checkpoint.offset <= stat.size;
  let offset = known ? checkpoint.offset : 0;
  const restarted = !known && (checkpoint?.offset ?? 0) > 0;
  // A source seen for the first time starts at its last `maxBytes`: only the
  // latest call matters, and history before the first collection is reported
  // as skipped, not read. The first (partial) line there is dropped below.
  const skippedBytes = known ? 0 : Math.max(0, stat.size - maxBytes);
  offset += skippedBytes;
  const length = Math.min(stat.size - offset, maxBytes);
  const calls = [];
  if (length > 0) {
    const buffer = Buffer.alloc(length);
    const fd = openSync(path, 'r');
    let read = 0;
    try {
      while (read < length) {
        const n = readSync(fd, buffer, read, length - read, offset + read);
        if (n === 0) break;
        read += n;
      }
    } finally {
      closeSync(fd);
    }
    const end = buffer.subarray(0, read).lastIndexOf(0x0a);
    // Starting mid-file, the bytes up to the first newline are a partial line.
    const start = skippedBytes > 0 ? buffer.indexOf(0x0a) + 1 : 0;
    if (end >= 0) {
      for (const line of buffer.subarray(start, end).toString('utf8').split('\n')) {
        const call = claudeCallFromLine(line);
        if (call) calls.push(call);
      }
      offset += end + 1;
    }
  }
  return { calls, checkpoint: { identity, offset }, restarted, skippedBytes, behind: stat.size - offset };
}

function observation(metric, value, { unit = null, scope = 'call', kind = 'reported', method, at }) {
  return {
    metric, value: value ?? 'unknown', unit, scope, source: SOURCE_CLAUDE, kind,
    ...(method ? { method } : {}), observedAt: at,
  };
}

/** Observations for a soul's latest call, per ADR-0007 decision 6. */
export function observationsFor(call) {
  const parts = [call.inputTokens, call.cacheReadTokens, call.cacheCreationTokens];
  const used = parts.every((value) => value !== null) ? parts.reduce((a, b) => a + b, 0) : null;
  return [
    observation('model_reported', call.model, { at: call.at }),
    observation('context_used_tokens', used, { unit: 'tokens', method: 'last-call-usage', at: call.at }),
    observation('context_capacity_tokens', null, { unit: 'tokens', kind: 'configured', at: call.at }),
    observation('output_tokens', call.outputTokens, { unit: 'tokens', at: call.at }),
  ];
}

/**
 * One collection pass. Updates `metrics/latest.json` and
 * `metrics/checkpoints.json`, and returns what it found. Never throws for
 * one soul's failure; those are listed in `errors`.
 */
export function collectMetrics({ env = process.env, home = homedir(), now = () => new Date(), maxBytes = DEFAULT_MAX_BYTES } = {}) {
  const dir = metricsDirectory({ env, home });
  const checkpointsPath = join(dir, 'checkpoints.json');
  const latestPath = join(dir, 'latest.json');
  const checkpoints = readJson(checkpointsPath, {});
  const latest = readJson(latestPath, { souls: {} });
  const result = { collectedAt: now().toISOString(), souls: {}, missing: [], errors: [] };
  const sessions = claudeBoundSessions({ stateDir: stateDirectory({ env, home }), metricsDir: dir });
  const found = new Set();
  for (const { agentId, sessionId } of sessions) {
    try {
      const path = findClaudeSessionLog(sessionId, { env, home });
      if (!path) continue;
      found.add(agentId);
      const key = `${SOURCE_CLAUDE}:${sessionId}`;
      const { calls, checkpoint, behind, skippedBytes } = readNewLines(path, checkpoints[key], { maxBytes });
      checkpoints[key] = checkpoint;
      // Several log lines can carry the same API message; the latest line wins.
      const newest = calls.filter((call) => call.at).sort((a, b) => a.at.localeCompare(b.at)).at(-1);
      const previous = latest.souls[agentId];
      if (newest && (!previous?.lastCallAt || newest.at >= previous.lastCallAt)) {
        latest.souls[agentId] = { lastCallAt: newest.at, observations: observationsFor(newest) };
      }
      const tally = result.souls[agentId] ?? { calls: 0, behindBytes: 0, skippedBytes: 0 };
      result.souls[agentId] = {
        calls: tally.calls + calls.length, behindBytes: tally.behindBytes + behind, skippedBytes: tally.skippedBytes + skippedBytes,
      };
    } catch (error) {
      result.errors.push({ agentId, source: SOURCE_CLAUDE, code: error?.code ?? 'collect-failed', message: String(error?.message ?? error) });
    }
  }
  for (const agentId of new Set(sessions.map((entry) => entry.agentId))) {
    if (!found.has(agentId)) result.missing.push({ agentId, source: SOURCE_CLAUDE });
  }
  latest.collectedAt = result.collectedAt;
  latest.errors = result.errors;
  latest.missing = result.missing;
  writePrivateJson(checkpointsPath, checkpoints);
  writePrivateJson(latestPath, latest);
  return result;
}

/** The latest stored observations, without reading any session log. */
export function showMetrics({ env = process.env, home = homedir() } = {}) {
  return readJson(join(metricsDirectory({ env, home }), 'latest.json'), { souls: {}, errors: [], missing: [], collectedAt: null });
}

function formatShow(metrics) {
  const lines = [`collected: ${metrics.collectedAt ?? 'never'}`];
  for (const [agentId, soul] of Object.entries(metrics.souls ?? {})) {
    const value = (name) => soul.observations.find((o) => o.metric === name)?.value ?? 'unknown';
    lines.push(`${agentId}  model ${value('model_reported')}  context ${value('context_used_tokens')} tokens  at ${soul.lastCallAt}`);
  }
  for (const error of metrics.errors ?? []) lines.push(`error ${error.agentId}: ${error.code}`);
  return `${lines.join('\n')}\n`;
}

export function main(argv = process.argv.slice(2), { env = process.env, home = homedir(), writeOut = (s) => process.stdout.write(s), writeErr = (s) => process.stderr.write(s) } = {}) {
  const [command, ...rest] = argv;
  if (command === 'record-session' && rest.length === 0) {
    // Session-start hook: never fails the session.
    try {
      recordSession({ provider: env.AGENT_HOOK_HARNESS, sessionId: env.AGENT_HOOK_SESSION_ID, cwd: env.AGENT_HOOK_CWD ?? process.cwd(), env, home });
    } catch (error) {
      writeErr(`agent-bot metrics: could not record the session: ${error instanceof Error ? error.message : String(error)}\n`);
    }
    return 0;
  }
  if (command === '--help' || command === '-h') {
    writeOut('usage: agent-bot metrics collect|show [--json]\n       agent-bot metrics record-session   (session-start hook)\n');
    return 0;
  }
  const json = rest.includes('--json');
  const unexpected = rest.filter((arg) => arg !== '--json');
  if (!['collect', 'show'].includes(command) || unexpected.length > 0) {
    writeErr('usage: agent-bot metrics collect|show [--json]\n');
    return 2;
  }
  try {
    if (command === 'collect') {
      const result = collectMetrics({ env, home });
      writeOut(json ? `${JSON.stringify(result)}\n`
        : `collected ${Object.keys(result.souls).length} soul(s), ${result.missing.length} missing, ${result.errors.length} error(s)\n`);
    } else {
      const metrics = showMetrics({ env, home });
      writeOut(json ? `${JSON.stringify(metrics)}\n` : formatShow(metrics));
    }
    return 0;
  } catch (error) {
    writeErr(`agent-bot metrics: ${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  process.exitCode = main();
}
