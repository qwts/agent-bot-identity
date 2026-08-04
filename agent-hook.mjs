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
  DIALECTS,
  budgetMs,
  encodeDecision,
  envelopeEnv,
  isBlocking,
  normalizeEnvelope,
} from './hook-dialects.mjs';

const ROOT = dirname(fileURLToPath(import.meta.url));

// Injectable so the deadline is testable without sleeping through it.
const now = () => Date.now();

// Where the hooks actually live, in priority order:
//   1. AGENT_BOT_HOOKS_DIR — explicit wins.
//   2. The repo being worked in. `agent-bot` is normally a symlink in
//      ~/.local/bin pointing at one clone, so resolving relative to this
//      module would look inside the *toolkit* and silently find nothing when a
//      project carries its own agent-hooks/. Hooks that never run are the
//      failure mode this whole layer exists to avoid, so the working tree is
//      asked first.
//   3. This module's own directory, which is the right answer when the toolkit
//      repo is itself the project.
export function hooksDir(env = process.env, cwd = process.cwd()) {
  if (env.AGENT_BOT_HOOKS_DIR) return env.AGENT_BOT_HOOKS_DIR;
  const repo = repoRoot(cwd);
  if (repo) {
    const candidate = join(repo, 'agent-hooks');
    if (existsSync(candidate)) return candidate;
  }
  return join(ROOT, 'agent-hooks');
}

function repoRoot(cwd) {
  try {
    const out = spawnSync('git', ['rev-parse', '--show-toplevel'], {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const root = (out.stdout ?? '').trim();
    return root === '' ? null : root;
  } catch {
    return null;
  }
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
  // Validate here rather than letting budgetMs/encodeDecision throw further in.
  // A generated config naming a dialect we do not know is our bug, and main()
  // turns a parse error into exit 0 — an unknown dialect must not become a
  // stack trace and a nonzero exit that the harness reads as a verdict.
  if (!DIALECTS.some((d) => d.key === parsed.dialect)) {
    throw new Error(`unknown dialect: ${parsed.dialect}`);
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

export function parsePayload(text, { dialectKey, event } = {}) {
  // Git's pre-push hook sends ref updates as plain text, not JSON. Preserve it
  // verbatim in the normalized envelope and env mirror for the git backstop.
  if (dialectKey === 'git' && event === 'pre-push') return { git_stdin: text };
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
        // The exit status outranks the line. A hook that prints allow and then
        // dies -- a failing cleanup step, a `set -e` trap after the verdict --
        // has not allowed anything; it has failed while claiming success. Only
        // an exit 0 may say allow, and a printed allow can never soften a
        // nonzero exit.
        if (status === 0) return { decision, reason: parsed.reason ?? stderr.trim() };
        if (status === 2) {
          return { decision: 'deny', reason: parsed.reason ?? (stderr.trim() || 'denied by hook') };
        }
        return {
          decision: 'error',
          reason: `hook printed "${decision}" then exited ${status}: ${stderr.trim()}`.trim(),
        };
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
  // ONE budget for the whole run, not one per hook. A per-hook timeout meant
  // n slow hooks could take n × budget, so two hooks under Claude's 15s outer
  // timeout could reach 20s and two under Copilot could sail past the 30s cap
  // into its fail-open path — defeating the very thing answering on our own
  // clock is meant to guarantee. Each hook gets what is left of the deadline.
  const budget = budgetMs(dialectKey, event, requested);
  const deadline = now() + budget;
  const results = [];

  for (const file of discoverHooks(dir, event)) {
    const name = file.slice(dir.length + 1);
    const remaining = deadline - now();
    if (remaining <= 0) {
      // Out of time before this hook ran at all. On a blocking event that is a
      // deny, via the same fail mode as any other error — silently skipping
      // the tail of the list would be a guard that stopped guarding.
      results.push({ name, decision: 'error', reason: 'budget exhausted before this hook ran' });
      continue;
    }
    const run = spawnSync(file, [], {
      input: stdin,
      encoding: 'utf8',
      timeout: remaining,
      env: { ...env, ...envelopeEnv(envelope) },
      cwd: envelope.cwd && existsSync(envelope.cwd) ? envelope.cwd : undefined,
    });
    if (run.error?.code === 'ETIMEDOUT' || run.signal === 'SIGTERM') {
      // We answer on our own clock, strictly inside the vendor's window. On
      // Copilot that is the whole point: its preToolUse fails OPEN on a vendor
      // timeout, so the vendor's timer must never be the one that fires.
      results.push({ name, decision: 'error', reason: `timed out after ${remaining}ms` });
      continue;
    }
    // EPIPE means the hook exited before reading the envelope we were writing.
    // That is the NORMAL case, not a failure: the common hook is five lines of
    // sh that reads the env mirror and never touches stdin. The process still
    // ran and still returned a status, so honour it — otherwise every such hook
    // reports an internal error instead of its own reason. (Only Linux
    // surfaces this; macOS buffers the write away, which is why it took CI to
    // find.)
    if (run.error && !(run.error.code === 'EPIPE' && typeof run.status === 'number')) {
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
    payload: parsePayload(readStdin(), { dialectKey, event }),
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
