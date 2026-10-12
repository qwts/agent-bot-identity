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
import { spawnSync, execFile, execFileSync } from 'node:child_process';
import { existsSync, readSync, readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { isatty } from 'node:tty';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  CANONICAL_EVENTS,
  DIALECTS,
  budgetMs,
  contextNote,
  encodeContext,
  encodeDecision,
  envelopeEnv,
  isBlocking,
  normalizeEnvelope,
  scansCommand,
} from './hook-dialects.mjs';

import {
  expandAlias, hookBypassReason, readBinding, scanGitPublish, statedBotSlug, unboundBotReason,
  unboundBotSlug, unprovableBotReason
} from './identity-host.mjs';
import { minimalChildEnv } from './child-env.mjs';
import { confinementCheck } from './confinement.mjs';

const ROOT = dirname(fileURLToPath(import.meta.url));

// Injectable so the deadline is testable without sleeping through it.
const now = () => Date.now();

// Where the hooks actually live:
//   1. AGENT_BOT_HOOKS_DIR — explicit wins. The soul builder and the owner's
//      own configuration set it.
//   2. This toolkit's own agent-hooks/, which the owner installed.
// The checkout being worked in is never asked (#1065). Its agent-hooks/ is
// content of whatever repository the session opened, so running its
// executables from a machine-wide adapter would hand host-user code
// execution to any checkout before anyone decided to trust it. A project
// that needs its own lifecycle hooks is opted in by the owner pointing
// AGENT_BOT_HOOKS_DIR at it. `cwd` stays in the signature for callers.
export function hooksDir(env = process.env, cwd = process.cwd()) {
  if (env.AGENT_BOT_HOOKS_DIR) return env.AGENT_BOT_HOOKS_DIR;
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

// The most stdin the runner will take from a harness (#1071). Real payloads
// are kilobytes: even a Write of a large file or a long tool response is well
// under a megabyte, and the model's own output limit keeps them there. Past
// the cap nothing more is kept, so an oversized payload is never allocated or
// parsed whole. Over the cap, a blocking event is denied and any other event
// runs with an empty payload, the same as one we cannot parse.
export const MAX_HOOK_INPUT_BYTES = 16 * 1024 * 1024;

// `incomplete` means the deadline passed before the harness finished writing.
// `deadline` is when the runner must stop waiting and answer.
export function readStdin({
  fd = 0, isTTY = isatty(fd), limit = MAX_HOOK_INPUT_BYTES, deadline = Infinity,
} = {}) {
  // Some harnesses send no stdin for session events; reading fd 0 on a TTY
  // would block forever. isatty, not process.stdin.isTTY: touching
  // process.stdin opens a stream that switches fd 0 to non-blocking.
  if (isTTY) return { text: '', oversize: false, incomplete: false };
  const chunks = [];
  let total = 0;
  let oversize = false;
  const chunk = Buffer.alloc(64 * 1024);
  const pause = new Int32Array(new SharedArrayBuffer(4));
  for (;;) {
    let n;
    try {
      n = readSync(fd, chunk, 0, chunk.length, null);
    } catch (error) {
      // Windows pipes report end-of-input as an EOF error rather than a 0 read.
      if (error?.code === 'EOF') break;
      // A non-blocking pipe with nothing in it yet: wait a moment and retry,
      // but never past the deadline.
      if (error?.code === 'EAGAIN' && now() < deadline) { Atomics.wait(pause, 0, 0, 2); continue; }
      if (error?.code === 'EAGAIN') return { text: '', oversize, incomplete: !oversize };
      return { text: '', oversize, incomplete: false };
    }
    if (n === 0) break;
    total += n;
    if (oversize) {
      // Over the cap: keep draining, discarding, so the harness's write
      // finishes rather than failing on a closed pipe, but only while the
      // budget lasts. The answer must still beat the vendor's timer.
      if (now() >= deadline) break;
      continue;
    }
    if (total > limit) { oversize = true; chunks.length = 0; continue; }
    chunks.push(Buffer.from(chunk.subarray(0, n)));
  }
  if (oversize) return { text: '', oversize, incomplete: false };
  return { text: Buffer.concat(chunks, total).toString('utf8'), oversize, incomplete: false };
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
//
// The same line may carry `context`: advisory text for the model rather than a
// verdict about the action (SessionStart's "arm the wake listener" is the case
// that needs it). A context-only line is an allow, exactly like an empty
// stdout. Context is honoured on an allow at exit 0 and dropped on every other
// outcome: a hook that denied, errored, or died mid-cleanup has not reliably
// said anything, and its text must not reach the session on the strength of a
// line it printed before failing.
export function readVerdict({ status, stdout = '', stderr = '' }) {
  const line = stdout.split('\n').find((l) => l.startsWith('agent-hook:'));
  if (line) {
    try {
      const parsed = JSON.parse(line.slice('agent-hook:'.length).trim());
      const context =
        typeof parsed?.context === 'string' && parsed.context.trim() !== '' ? parsed.context : null;
      const decision = parsed?.decision === undefined && context ? 'allow' : parsed?.decision;
      if (['allow', 'deny', 'ask'].includes(decision)) {
        // The exit status outranks the line. A hook that prints allow and then
        // dies -- a failing cleanup step, a `set -e` trap after the verdict --
        // has not allowed anything; it has failed while claiming success. Only
        // an exit 0 may say allow, and a printed allow can never soften a
        // nonzero exit.
        if (status === 0) {
          return {
            decision,
            reason: parsed.reason ?? stderr.trim(),
            context: decision === 'allow' ? context : null,
          };
        }
        if (status === 2) {
          return {
            decision: 'deny',
            reason: parsed.reason ?? (stderr.trim() || 'denied by hook'),
            context: null,
          };
        }
        return {
          decision: 'error',
          reason: `hook printed "${decision}" then exited ${status}: ${stderr.trim()}`.trim(),
          context: null,
        };
      }
      return {
        decision: 'error',
        reason: `hook returned an unknown decision: ${parsed?.decision}`,
        context: null,
      };
    } catch {
      return {
        decision: 'error',
        reason: 'hook emitted an unparseable agent-hook: line',
        context: null,
      };
    }
  }
  if (status === 0) return { decision: 'allow', reason: '', context: null };
  if (status === 2) return { decision: 'deny', reason: stderr.trim() || 'denied by hook', context: null };
  return { decision: 'error', reason: stderr.trim() || `hook exited ${status}`, context: null };
}

// deny > ask > allow, first denial wins, and an error resolves through the
// EVENT's fail mode — which is why a hook needs no manifest to be safe.
export function combine(results, event) {
  const reasons = [];
  const contexts = [];
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
    if (verdict === 'deny') return { decision: 'deny', reason: `${result.name}: ${result.reason}`, contexts: [] };
    if (verdict === 'ask') {
      decision = 'ask';
      reasons.push(`${result.name}: ${result.reason}`);
    }
    // An ask is already an answer about the action, so its context has nowhere
    // to go; only hooks that allowed contribute text.
    if (verdict === 'allow' && result.context) contexts.push(result.context);
  }
  return { decision, reason: reasons.join('; '), contexts };
}

// No human fallback (#749): a shell command that commits or pushes from a
// session that stated a bot identity its target checkout is not bound to is
// refused, here and again by hooks/pre-commit and hooks/pre-push. Built into
// the runner like confinement, so a project's own agent-hooks/ cannot
// displace it. The target is the repository git will actually write
// (`-C`, `--git-dir`, `cd`, aliases), because `--no-verify` skips that
// repository's own hook. A target the scan cannot place is refused only for
// a session that stated a bot; the delegate and a human shell are allowed.
// A stated bot is also refused a command that skips the hooks themselves
// (`--no-verify`, `commit -n`, a `core.hooksPath` override), bound or not:
// they are the backstop for git this scan cannot see.
function opaqueUnboundReason(slug) {
  return `agent-bot: this session stated bot identity ${slug}, but this checkout is not bound to it, `
    + 'and this command runs a script, interpreter or task runner that could commit or push as the human. '
    + 'Run `agent-bot setup-worktree` in a linked worktree (a primary checkout is refused) '
    + 'and check `agent-bot doctor`, then retry.';
}

function targetGit(target, env) {
  const prefix = [];
  if (target.gitDir) prefix.push(`--git-dir=${target.gitDir}`);
  if (target.workTree) prefix.push(`--work-tree=${target.workTree}`);
  return (args, { cwd }) => execFileSync('git', [...prefix, ...args], {
    cwd, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
  });
}

export function unboundIdentityCheck(envelope, { env = process.env, cwd = process.cwd() } = {}) {
  const allow = { decision: 'allow' };
  if (!scansCommand(envelope) || !envelope.command) return allow;
  const command = envelope.command;
  const scan = scanGitPublish(command, { cwd, env });
  if (!scan.publishes.length && !scan.aliases.length && !scan.ambiguous && !scan.opaqueExecution && !scan.skipsHooks) return allow;
  // A command word the scan cannot read only matters when git could be in it.
  let uncertain = scan.ambiguous && /git|commit|push/i.test(command.replace(/[\\'"]/g, ''));
  const publishes = [...scan.publishes];
  let skipsHooks = scan.skipsHooks;
  const bypasses = [...scan.bypasses];
  const aliases = [...scan.aliases];
  const opaque = [...scan.opaque];
  for (let n = 0; aliases.length && n < 16; n += 1) {
    const alias = aliases.shift();
    if (!alias.cwd || !existsSync(alias.cwd)) { uncertain = true; continue; }
    let value;
    try {
      value = targetGit(alias, env)(['config', '--get', `alias.${alias.name}`], { cwd: alias.cwd }).trim();
    } catch (error) {
      if (error.status !== 1) uncertain = true;
      continue;
    }
    const inner = expandAlias(value, alias, alias.rest, {
      env: new Map(Object.entries(env)), hooksOverridden: alias.hooksOverridden,
    });
    publishes.push(...inner.publishes);
    aliases.push(...inner.aliases);
    uncertain ||= inner.ambiguous;
    skipsHooks ||= inner.skipsHooks;
    bypasses.push(...inner.bypasses);
    opaque.push(...inner.opaque);
  }
  if (aliases.length) uncertain = true;
  if (skipsHooks) {
    // A checkout pin is a stated identity too, so ask the session's directory
    // and every repository the bypass reaches.
    try {
      // A target git cannot read is a git command that fails on its own, so
      // it does not deny the delegate or a human.
      const pinned = (target) => {
        if (!target.cwd || !existsSync(target.cwd)) return null;
        try { return statedBotSlug({ env, cwd: target.cwd, git: targetGit(target, env) }); } catch { return null; }
      };
      const slug = statedBotSlug({ env, cwd }) || bypasses.map(pinned).find(Boolean);
      if (slug) return { decision: 'deny', reason: hookBypassReason(slug) };
    } catch (error) {
      return { decision: 'deny', reason: `cannot verify the stated bot identity: ${error.message}` };
    }
  }
  for (const target of publishes) {
    if (!target.cwd || !existsSync(target.cwd)) { uncertain = true; continue; }
    try {
      const slug = unboundBotSlug({ env, cwd: target.cwd, git: targetGit(target, env), identity: target.identity ?? {} });
      if (slug) return { decision: 'deny', reason: unboundBotReason(slug) };
    } catch {
      uncertain = true;
    }
  }
  // A script, interpreter or task runner may run git the scan cannot read.
  // A stated bot is refused it in a checkout it is not bound to (setup
  // failed or never ran), where that git would be attributed to the human.
  // A bound bot keeps its prior behaviour, so `node --test` or
  // `python3 build.py` still run; this is not a sandbox, since opaque code
  // can override `core.hooksPath` too. Each runs where the scan placed it; a
  // directory it cannot place, or one outside any repository, is judged by
  // the session's own checkout.
  if (opaque.length) {
    const inRepo = (dir) => {
      try { targetGit({}, env)(['rev-parse', '--git-dir'], { cwd: dir }); return true; } catch { return false; }
    };
    const dirs = new Set(opaque.map(({ cwd: dir }) => (dir && existsSync(dir) && inRepo(dir) ? dir : cwd)));
    for (const dir of dirs) {
      try {
        const slug = unboundBotSlug({ env, cwd: dir, git: targetGit({}, env) });
        if (slug) return { decision: 'deny', reason: opaqueUnboundReason(slug) };
      } catch (error) {
        return { decision: 'deny', reason: `cannot verify the stated bot identity: ${error.message}` };
      }
    }
  }
  if (!uncertain) return allow;
  try {
    const slug = statedBotSlug({ env, cwd });
    return slug ? { decision: 'deny', reason: unprovableBotReason(slug) } : allow;
  } catch (error) {
    return { decision: 'deny', reason: `cannot verify the stated bot identity: ${error.message}` };
  }
}

export function runHooks({ dialectKey, event, payload, dir, env = process.env, startedAt = now() }) {
  const envelope = normalizeEnvelope({ dialectKey, event, payload });
  let binding;
  try { binding = readBinding({ env, cwd: envelope.cwd ?? process.cwd() }); }
  catch { return { decision: 'deny', reason: 'untrusted agent binding' }; }
  if (binding) env = { ...env, QWTS_AGENT_ID: binding.agentId };
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
  // The clock starts when the runner did, not here (#1071): reading and
  // parsing stdin spend the same vendor window the hooks do.
  const budget = budgetMs(dialectKey, event, requested);
  const deadline = startedAt + budget;
  const checkCwd = envelope.cwd && existsSync(envelope.cwd) ? envelope.cwd : process.cwd();
  const results = [{ name: 'identity', ...unboundIdentityCheck(envelope, { env, cwd: checkCwd }) }];
  results.push({ name: 'confinement', ...confinementCheck(envelope, {
    env, binding, cwd: envelope.cwd ?? process.cwd(),
    boundCheckout: binding ? repoRoot(envelope.cwd ?? process.cwd()) : null,
  }) });

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

// The comms CLI owns account pairing and refuses an unpaired join. Do not
// inspect its private state or initiate pairing here. Keep this asynchronous:
// join may call back into this daemon for the sibling vouch operation.
// The daemon calls this with its own environment, and the hooks are the
// owner's configured or installed ones, never the soul checkout's (#1065);
// both children get the child boundary (#785); the timeout setting only ever
// tightens and passes.
export async function runSpawnHooks({ agentId, parent, binding, name, harness, cwd, env = process.env }) {
  const childEnv = { ...minimalChildEnv(env),
    ...(typeof env.AGENT_HOOK_TIMEOUT_MS === 'string' ? { AGENT_HOOK_TIMEOUT_MS: env.AGENT_HOOK_TIMEOUT_MS } : {}),
    AGENT_BOT_BINDING: binding, AGENT_BOT_ID: agentId,
    QWTS_AGENT_ID: agentId, AGENT_BOT_PARENT_ID: parent, QWTS_AGENT_PARENT_ID: parent };
  const warnings = [];
  await new Promise((resolve) => {
    execFile('agent-comms', ['join', '--name', name, '--harness', harness], {
      cwd, env: childEnv, timeout: 10000, maxBuffer: 64 * 1024,
    }, (error) => {
      if (error && error.code !== 'ENOENT') warnings.push('agent-comms join failed (account must be paired)');
      resolve();
    });
  });
  const result = runHooks({ dialectKey: 'claude', event: 'spawn',
    payload: { cwd, agentId, parent, name, harness }, dir: hooksDir(childEnv, cwd), env: childEnv });
  if (result.decision !== 'allow') warnings.push(`spawn hook: ${result.reason}`);
  return warnings.join('; ') || null;
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
  const startedAt = now();
  // Reading stdin spends the run's budget, so stop waiting with a margin left
  // to answer in.
  const input = readStdin({
    deadline: startedAt + budgetMs(dialectKey, event, Number(env.AGENT_HOOK_TIMEOUT_MS) || 10000) - 250,
  });
  const refusal = input.oversize
    ? `hook input is larger than ${MAX_HOOK_INPUT_BYTES} bytes; refusing to evaluate it`
    : input.incomplete ? 'hook input did not finish arriving within the time budget' : null;
  const { decision, reason, contexts } = refusal && isBlocking(event)
    ? { decision: 'deny', reason: refusal, contexts: [] }
    : runHooks({
      dialectKey,
      event,
      payload: parsePayload(input.text, { dialectKey, event }),
      dir: hooksDir(env),
      env,
      startedAt,
    });
  const encoded = encodeDecision({ dialectKey, event, decision, reason });
  // Context replaces the neutral allow response rather than joining it: a
  // dialect that can carry text answers with that text, and a dialect that
  // cannot still answers with its own neutral shape — Cursor's `{}` — so
  // failClosed never reads a dropped injection as a denial.
  const injected =
    decision === 'allow' && contexts.length > 0
      ? encodeContext({ dialectKey, event, contexts })
      : null;
  if (decision === 'allow' && contexts.length > 0 && !injected) {
    // A declared gap is reported, never silently dropped: the hook believes it
    // told the session something, and on this harness it did not.
    process.stderr.write(
      `agent-hook: ${dialectKey} has no ${event} context channel — ${
        contextNote(dialectKey) ?? 'none is documented'
      }\n`,
    );
  }
  const output = injected ?? encoded;
  if (output.stdout) process.stdout.write(output.stdout);
  if (output.stderr) process.stderr.write(`${output.stderr}\n`);
  return output.exitCode;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = main();
}
