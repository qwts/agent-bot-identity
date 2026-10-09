// Resume wake (#323): wake a soul by resuming its own harness session for
// one headless turn. Nothing runs between messages, and each turn continues
// the conversation the last one left, so a soul keeps its context without
// polling and without an ACP adapter.
//
// A headless turn has nobody to approve a tool call, so the owner picks a
// permission policy per soul ahead of time and each harness enforces it with
// its own flags: `read-only` answers but changes nothing; `workspace` edits
// files and runs commands in the soul's worktree, with network, so it can
// push its work. Whatever the policy does not allow is denied, never asked.
//
// The daemon owns these sessions: the first wake starts one and records its
// id, and every later wake resumes it. A session a human has open in a
// window is not shared, because Devin and Codex refuse a second writer.

import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { chmodSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { validateAgentId, withLock } from './agent-identity.mjs';
import { REACH_CORRELATION_ENV } from './reach-env.mjs';
import { whichOnPath } from './acp-registry.mjs';
import { composeTurnEnv } from './turn-env.mjs';

export const RESUME_POLICIES = Object.freeze(['read-only', 'workspace']);

const MAX_OUTPUT_BYTES = 8 * 1024 * 1024;

function jsonLines(stdout) {
  const events = [];
  for (const line of String(stdout).split('\n')) {
    if (!line.trim()) continue;
    try { events.push(JSON.parse(line)); } catch { /* a harness may print a stray non-JSON line */ }
  }
  return events;
}

// Each row turns (sessionId, prompt, policy) into one headless run, and the
// run's output into { reply, sessionId }. `stdin` carries the prompt where
// the harness reads it there, so a long message never meets argv limits.
// docs/resume-harnesses.md is the checklist for adding a row.
export const RESUME_HARNESSES = Object.freeze({
  codex: Object.freeze({
    command: 'codex',
    plan({ sessionId, prompt, policy }) {
      const sandbox = policy === 'workspace'
        ? ['-c', 'sandbox_mode="workspace-write"', '-c', 'sandbox_workspace_write.network_access=true']
        : ['-c', 'sandbox_mode="read-only"'];
      const args = ['exec', ...(sessionId ? ['resume', sessionId] : []), '--json', '--skip-git-repo-check',
        '-c', 'approval_policy="never"', ...sandbox, '-'];
      return { args, stdin: prompt, env: {} };
    },
    parse(stdout) {
      let reply = '';
      let sessionId = null;
      let failure = null;
      for (const event of jsonLines(stdout)) {
        if (event.type === 'thread.started' && typeof event.thread_id === 'string') sessionId = event.thread_id;
        else if (event.type === 'item.completed' && event.item?.type === 'agent_message' && typeof event.item.text === 'string') reply = event.item.text;
        else if (event.type === 'turn.failed' || event.type === 'error') failure = event.error?.message ?? event.message ?? 'codex turn failed';
      }
      return { reply, sessionId, failure };
    },
  }),
  opencode: Object.freeze({
    command: 'opencode',
    plan({ sessionId, prompt, policy }) {
      // OPENCODE_PERMISSION is merged over the user's config, so no rule is
      // left at `ask`: an ask with nobody to answer can hang a headless run.
      // Read-only denies edits, shell and subagents outright. OpenCode's free
      // tier refuses a request whose tools were switched off, so there a
      // read-only turn fails closed rather than running with less denied.
      // OpenCode has no OS sandbox: `workspace` trusts the soul with shell
      // in its worktree, confined only by `external_directory`.
      const noAsk = { external_directory: 'deny', doom_loop: 'deny', read: { '*': 'allow', '*.env': 'deny', '*.env.*': 'deny' } };
      const permission = policy === 'workspace'
        ? { '*': 'allow', ...noAsk }
        : { ...noAsk, edit: 'deny', bash: 'deny', task: 'deny' };
      const args = ['run', '--format', 'json', ...(sessionId ? ['--session', sessionId] : []), '--', prompt];
      return { args, stdin: null, env: { OPENCODE_PERMISSION: JSON.stringify(permission) } };
    },
    parse(stdout) {
      // The reply is the text after the turn's last tool call, as on the ACP
      // path: earlier text is narration between steps.
      let reply = '';
      let sessionId = null;
      let failure = null;
      for (const event of jsonLines(stdout)) {
        if (typeof event.sessionID === 'string') sessionId = event.sessionID;
        if (event.type === 'text' && typeof event.part?.text === 'string') reply += event.part.text;
        else if (event.type === 'tool_use') reply = '';
        else if (event.type === 'error') failure = event.error?.data?.message ?? event.error?.message ?? 'opencode turn failed';
      }
      return { reply, sessionId, failure };
    },
  }),
  devin: Object.freeze({
    command: 'devin',
    plan({ sessionId, prompt, policy }) {
      // `--sandbox` confines commands' writes to the workspace, so the
      // workspace policy can approve every tool inside it.
      const mode = policy === 'workspace' ? ['--sandbox', '--permission-mode', 'dangerous'] : ['--permission-mode', 'auto'];
      const args = [...(sessionId ? ['--resume', sessionId] : []), '--print', '--prompt-file', '/dev/stdin',
        '--respect-workspace-trust', 'false', ...mode];
      return { args, stdin: prompt, env: {} };
    },
    // Print mode writes the answer as plain text and no session id; the id
    // comes from `devin list` in the worktree afterwards.
    parse(stdout) {
      return { reply: String(stdout).trim(), sessionId: null, failure: null };
    },
    listArgs: Object.freeze(['list', '--format', 'json']),
    // Ids of the sessions `devin list` shows for exactly this worktree. A row
    // without a working directory belongs to no worktree, so it never
    // matches.
    sessionsIn(stdout, cwd) {
      let sessions;
      try { sessions = JSON.parse(String(stdout)); } catch { return null; }
      if (!Array.isArray(sessions)) return null;
      const real = (dir) => { try { return realpathSync(dir); } catch { return path.resolve(dir); } };
      const here = real(cwd);
      return sessions
        .filter((s) => typeof s?.id === 'string' && typeof s.working_directory === 'string' && s.working_directory && real(s.working_directory) === here)
        .map((s) => s.id);
    },
  }),
  grok: Object.freeze({
    command: 'grok',
    // Grok saves the sandbox profile with the session and refuses a resume
    // under another one, so a policy change starts a new session.
    policyFixedAtStart: true,
    plan({ sessionId, prompt, policy }) {
      // Both policies run under Grok's OS sandbox. Read-only also denies
      // edits and shell by rule and approves nothing else, so the denials
      // hold even where the sandbox cannot be applied; a denied call fails
      // and is reported to the model, never asked.
      const mode = policy === 'workspace'
        ? ['--sandbox', 'workspace', '--always-approve']
        : ['--sandbox', 'read-only', '--permission-mode', 'dontAsk', '--deny', 'Edit', '--deny', 'Write', '--deny', 'Bash'];
      const args = [...(sessionId ? ['--resume', sessionId] : []), '--prompt-file', '/dev/stdin', '--output-format', 'json', ...mode];
      return { args, stdin: prompt, env: {} };
    },
    parse(stdout) {
      let result;
      try { result = JSON.parse(String(stdout)); } catch { return { reply: '', sessionId: null, failure: 'grok printed no JSON result' }; }
      const sessionId = typeof result?.sessionId === 'string' ? result.sessionId : null;
      const failure = result?.stopReason === 'refusal' ? 'grok refused the turn' : null;
      return { reply: typeof result?.text === 'string' ? result.text : '', sessionId, failure };
    },
  }),
});

export function resumeHarnessSupported(harness) {
  return Object.hasOwn(RESUME_HARNESSES, harness);
}

// --- the daemon's record of each soul's session ---------------------------

export function wakeSessionsFile({ env = process.env, home = homedir() } = {}) {
  const base = env.XDG_STATE_HOME ? path.resolve(env.XDG_STATE_HOME) : path.join(home, '.local', 'state');
  return path.join(base, 'agent-bot', 'wake-sessions.json');
}

export function createWakeSessions({ file }) {
  const read = () => {
    try { return JSON.parse(readFileSync(file, 'utf8'))?.sessions ?? {}; }
    catch (error) { if (error.code === 'ENOENT') return {}; throw new Error('wake sessions could not be read'); }
  };
  return {
    // A session belongs to one harness: a soul moved to another harness
    // starts fresh rather than handing a foreign id to the new one. Given a
    // policy, it must also be the policy the session was started under.
    get(agentId, harness, policy) {
      const entry = read()[validateAgentId(agentId)];
      if (entry?.harness !== harness || typeof entry.sessionId !== 'string') return null;
      return policy === undefined || entry.policy === policy ? entry.sessionId : null;
    },
    set(agentId, harness, sessionId, policy) {
      const id = validateAgentId(agentId);
      mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
      withLock(`${file}.lock`, 'wake sessions', () => {
        const sessions = read();
        sessions[id] = { harness, sessionId, ...(policy ? { policy } : {}) };
        const temp = `${file}.${process.pid}.${randomUUID()}.tmp`;
        try { writeFileSync(temp, `${JSON.stringify({ schemaVersion: 1, sessions }, null, 2)}\n`, { flag: 'wx', mode: 0o600 }); renameSync(temp, file); chmodSync(file, 0o600); }
        finally { rmSync(temp, { force: true }); }
      });
    },
  };
}

// --- running a turn --------------------------------------------------------

// Resolves { code, stdout, stderr }; rejects only when the process cannot
// start. Output past the cap is dropped rather than buffered without bound.
export function runProcess(command, args, { cwd, env, stdin = null, timeoutMs, signal }) {
  return new Promise((resolve, reject) => {
    signal?.throwIfAborted();
    const child = spawn(command, args, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    const take = (current, chunk) => (current.length < MAX_OUTPUT_BYTES ? current + chunk : current);
    child.stdout.setEncoding('utf8').on('data', (chunk) => { stdout = take(stdout, chunk); });
    child.stderr.setEncoding('utf8').on('data', (chunk) => { stderr = take(stderr, chunk); });
    const timer = setTimeout(() => child.kill('SIGTERM'), timeoutMs);
    const abort = () => child.kill('SIGTERM');
    signal?.addEventListener('abort', abort, { once: true });
    const cleanup = () => { clearTimeout(timer); signal?.removeEventListener('abort', abort); };
    child.once('error', (error) => { cleanup(); reject(error); });
    child.once('close', (code, exitSignal) => { cleanup(); resolve({ code: exitSignal ? null : code, signal: exitSignal, stdout, stderr }); });
    child.stdin.on('error', () => { /* a harness that exits early closes its stdin */ });
    child.stdin.end(stdin ?? '');
  });
}

// A launchd daemon gets a bare PATH, and harness CLIs and agent-comms live in
// ~/.local/bin or Homebrew. Those are appended, so a host's own tool path
// (GeniusBar's bundled tools) comes before them. On the resume lane this is
// the base a soul's declared runtimes and harness installs are put ahead of
// (#617 slice 3b).
export function resumePath(env, home) {
  const dirs = [...(env.PATH || '').split(path.delimiter), path.join(home, '.local', 'bin'), '/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin', '/usr/sbin', '/sbin'];
  return [...new Set(dirs.filter(Boolean))].join(path.delimiter);
}

function lastLine(text) {
  return String(text).trim().split('\n').pop()?.slice(0, 300) || '';
}

/**
 * The resume lane's executor: ({ invocation, message, env, policy }) →
 * { reply }. `invocation` carries the soul's agentId, harness, and worktree
 * (cwd); `env` carries its binding. Fails with a plain Error the cold waker
 * records, leaving the message unacked for the next wake.
 */
export function createResumeExecutor({ sessions, baseEnv = process.env, home = homedir(), run = runProcess, turnTimeoutMs = 30 * 60_000,
  runtimeEnvFor = null, toolHomeEnvFor = null, providerEnvFor = null }) {
  return async ({ invocation, message, env = {}, policy, signal }) => {
    const { agentId, harness, cwd } = invocation;
    const row = RESUME_HARNESSES[harness];
    if (!row) throw new Error(`resume wake does not support the ${harness} harness`);
    if (!RESUME_POLICIES.includes(policy)) throw new Error('resume wake needs a read-only or workspace policy');
    // Only the target's own binding is presented: one the daemon inherited
    // never reaches a soul that has none. The same holds for the thread key.
    const { AGENT_BOT_BINDING: _inherited, [REACH_CORRELATION_ENV]: _thread, ...hostEnv } = baseEnv;
    // The soul's turn env, composed by the daemon's shared ports as an ACP
    // turn's is (#617 slice 3b): its declared runtimes and harness installs
    // first on PATH, its tool home, its provider secret. A declaration that
    // cannot be met throws here, before any harness process (Devin's
    // session listing included) starts, so the message stays unacked and the
    // recorded session is kept. Undeclared tools keep the host PATH.
    const { harnessEnv } = composeTurnEnv({ agentId, harness, env,
      baseEnv: { ...hostEnv, HOME: baseEnv.HOME || home, PATH: resumePath(baseEnv, home) },
      runtimeEnvFor, toolHomeEnvFor, providerEnvFor });
    // The harness CLI the composed PATH selects, so a soul-installed one
    // wins over the host's; none is a refusal, never another lookup.
    const command = whichOnPath(row.command, harnessEnv);
    if (!command) throw Object.assign(new Error(`resume wake: ${row.command} is not on ${agentId}'s PATH`), { code: 'harness-tool-missing' });
    const sessionId = sessions.get(agentId, harness, row.policyFixedAtStart ? policy : undefined);
    const plan = row.plan({ sessionId, prompt: message, policy });
    // A relayed turn's thread key (#392) reaches the harness's own reach
    // server through its environment, so send_message and start_soul's brief
    // stay in the woken message's thread on this lane too.
    const correlation = typeof invocation.correlation === 'string' && invocation.correlation !== ''
      && invocation.correlation.length <= 128 ? invocation.correlation : null;
    const runEnv = {
      ...harnessEnv, ...plan.env,
      ...(correlation ? { [REACH_CORRELATION_ENV]: correlation } : {}),
    };
    // A harness that prints no session id is asked which sessions exist in
    // the worktree before and after a fresh turn; only a single new one is
    // recorded, so a wake never adopts another soul's or project's session.
    const listIds = async () => {
      const listed = await run(command, row.listArgs, { cwd, env: runEnv, stdin: null, timeoutMs: 30_000, signal }).catch(() => null);
      return listed?.code === 0 ? row.sessionsIn(listed.stdout, cwd) : null;
    };
    const before = !sessionId && row.listArgs ? await listIds() : null;
    const result = await run(command, plan.args, { cwd, env: runEnv, stdin: plan.stdin, timeoutMs: turnTimeoutMs, signal });
    signal?.throwIfAborted();
    const parsed = row.parse(result.stdout);
    if (result.code !== 0 || parsed.failure) {
      const detail = parsed.failure || lastLine(result.stderr) || lastLine(result.stdout) || (result.signal ? `stopped by ${result.signal}` : `exit ${result.code}`);
      throw new Error(`${harness} turn failed: ${detail}`);
    }
    let nextSession = parsed.sessionId;
    if (!nextSession && before) {
      const created = (await listIds())?.filter((id) => !before.includes(id)) ?? [];
      if (created.length === 1) nextSession = created[0];
    }
    if (nextSession && nextSession !== sessionId) sessions.set(agentId, harness, nextSession, policy);
    return { reply: parsed.reply };
  };
}
