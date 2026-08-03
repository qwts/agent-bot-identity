#!/usr/bin/env node

// The runner every harness's generated config calls. It normalizes the vendor
// payload, runs whatever executables live in agent-hooks/<event>/, combines
// their verdicts, and encodes one answer in the caller's dialect.
//
// Dialect and event arrive as ARGUMENTS, from the generated config — never
// inferred from the payload. The emitter already knows who it is writing for,
// so it says so; inference would be a drift bug waiting to happen.
//
// Adding a hook is `cp` + `chmod +x`. Nothing here is regenerated, because the
// configs wire every event unconditionally: they describe harnesses, which
// change rarely, not hooks, which change constantly.

import process from 'node:process';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  CANONICAL_EVENTS,
  budgetMs,
  encodeDecision,
  envelopeEnv,
  isBlocking,
  normalizeEnvelope,
} from './hook-dialects.mjs';

const ROOT = dirname(fileURLToPath(import.meta.url));

export function hooksDir(env = process.env) {
  return env.AGENT_BOT_HOOKS_DIR || join(ROOT, 'agent-hooks');
}

export function parseArgs(argv) {
  const parsed = { dialect: null, event: null };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--dialect' || arg === '--event') {
      const value = argv[i + 1];
      if (!value || value.startsWith('--')) throw new Error(`${arg} requires a value`);
      parsed[arg.slice(2)] = value;
      i += 1;
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  if (!parsed.dialect) throw new Error('--dialect is required');
  if (!parsed.event) throw new Error('--event is required');
  if (!CANONICAL_EVENTS.includes(parsed.event)) {
    throw new Error(`unknown event: ${parsed.event}`);
  }
  return parsed;
}

// Lexicographic by filename, so `10-` runs before `50-`. Non-executables are
// skipped rather than failed: a README or a .DS_Store in the folder is not an
// error, but a non-executable script would otherwise be a silent no-op, so the
// directory contract test catches that separately.
export function discoverHooks(dir, event) {
  const eventDir = join(dir, event);
  if (!existsSync(eventDir)) return [];
  return readdirSync(eventDir)
    .sort()
    .map((name) => join(eventDir, name))
    .filter((file) => {
      try {
        const stat = statSync(file);
        return stat.isFile() && (stat.mode & 0o111) !== 0;
      } catch {
        return false;
      }
    });
}

function readStdin() {
  // Some harnesses send no stdin for session events; reading fd 0 on a TTY
  // would block forever.
  if (process.stdin.isTTY) return '';
  try {
    return readFileSync(0, 'utf8');
  } catch {
    return '';
  }
}

export function parsePayload(text) {
  if (!text || text.trim() === '') return {};
  try {
    const value = JSON.parse(text);
    return value && typeof value === 'object' ? value : {};
  } catch {
    // A payload we cannot parse is not a reason to deny — the harness sent it,
    // not the hook. Hooks still run, with `raw` empty and the env mirror set
    // from whatever we could recover (nothing).
    return {};
  }
}

// A hook says: exit 0 allow, exit 2 deny (stderr is the reason), anything else
// is an error. Optionally one stdout line `agent-hook: {json}` for a richer
// verdict. Unparseable output is an ERROR, never an allow — garbage must not
// be a pass.
export function readVerdict({ status, stdout = '', stderr = '' }) {
  const line = stdout.split('\n').find((l) => l.startsWith('agent-hook:'));
  if (line) {
    try {
      const parsed = JSON.parse(line.slice('agent-hook:'.length).trim());
      const decision = parsed?.decision;
      if (['allow', 'deny', 'ask'].includes(decision)) {
        return { decision, reason: parsed.reason ?? stderr.trim() };
      }
      return { decision: 'error', reason: `hook returned an unknown decision: ${decision}` };
    } catch {
      return { decision: 'error', reason: 'hook emitted an unparseable agent-hook: line' };
    }
  }
  if (status === 0) return { decision: 'allow', reason: '' };
  if (status === 2) return { decision: 'deny', reason: stderr.trim() || 'denied by hook' };
  return { decision: 'error', reason: stderr.trim() || `hook exited ${status}` };
}

// deny > ask > allow, first denial wins, and an error resolves through the
// EVENT's fail mode — which is why a hook needs no manifest to be safe.
export function combine(results, event) {
  const reasons = [];
  let decision = 'allow';
  for (const result of results) {
    let { decision: verdict } = result;
    if (verdict === 'error') {
      if (!isBlocking(event)) {
        process.stderr.write(`agent-hook: ${result.name}: ${result.reason}\n`);
        continue;
      }
      verdict = 'deny';
    }
    if (verdict === 'deny') return { decision: 'deny', reason: `${result.name}: ${result.reason}` };
    if (verdict === 'ask') {
      decision = 'ask';
      reasons.push(`${result.name}: ${result.reason}`);
    }
  }
  return { decision, reason: reasons.join('; ') };
}

export function runHooks({ dialectKey, event, payload, dir, env = process.env }) {
  const envelope = normalizeEnvelope({ dialectKey, event, payload });
  const stdin = JSON.stringify(envelope);
  // AGENT_HOOK_TIMEOUT_MS only ever tightens: budgetMs caps it against the
  // vendor's window, so an operator can be stricter but never leak past a
  // dialect that fails open on its own timer.
  const requested = Number(env.AGENT_HOOK_TIMEOUT_MS) || 10000;
  const timeout = budgetMs(dialectKey, event, requested);
  const results = [];

  for (const file of discoverHooks(dir, event)) {
    const name = file.slice(dir.length + 1);
    const run = spawnSync(file, [], {
      input: stdin,
      encoding: 'utf8',
      timeout,
      env: { ...env, ...envelopeEnv(envelope) },
      cwd: envelope.cwd && existsSync(envelope.cwd) ? envelope.cwd : undefined,
    });
    if (run.error?.code === 'ETIMEDOUT' || run.signal === 'SIGTERM') {
      // We answer on our own clock, strictly inside the vendor's window. On
      // Copilot that is the whole point: its preToolUse fails OPEN on a vendor
      // timeout, so the vendor's timer must never be the one that fires.
      results.push({ name, decision: 'error', reason: `timed out after ${timeout}ms` });
      continue;
    }
    if (run.error) {
      results.push({ name, decision: 'error', reason: run.error.message });
      continue;
    }
    results.push({ name, ...readVerdict(run) });
  }
  return combine(results, event);
}

export function main(argv = process.argv.slice(2), env = process.env) {
  let parsed;
  try {
    parsed = parseArgs(argv);
  } catch (error) {
    // A malformed invocation is our bug, not the agent's. Never block on it.
    process.stderr.write(`agent-hook: ${error.message}\n`);
    return 0;
  }
  const { dialect: dialectKey, event } = parsed;
  const { decision, reason } = runHooks({
    dialectKey,
    event,
    payload: parsePayload(readStdin()),
    dir: hooksDir(env),
    env,
  });
  const encoded = encodeDecision({ dialectKey, event, decision, reason });
  if (encoded.stdout) process.stdout.write(encoded.stdout);
  if (encoded.stderr) process.stderr.write(`${encoded.stderr}\n`);
  return encoded.exitCode;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = main();
}
