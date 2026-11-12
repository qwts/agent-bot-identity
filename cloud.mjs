#!/usr/bin/env node
// agent-bot cloud: bring a short-lived machine (a Claude Code cloud
// container, a CI runner) to a working state at the start of a session and
// take it down at the end.
//
//   up             idempotent: start the identity daemon when it is not
//                  running, and enroll the device with the agent-bot server
//                  when it is not enrolled. Enrollment uses
//                  AGENT_BOT_ENROLL_TOKEN when set; otherwise it starts the
//                  device grant in the background and returns the approval
//                  link at once, so a session-start hook never blocks.
//   down           stop the daemon and unenroll (`server logout`, which
//                  revokes the device at the server).
//   install-hooks  register `cloud up --hook` and `cloud down --hook` as the
//                  Claude Code SessionStart and SessionEnd hooks.
//
// A container's processes do not survive the container being paused while
// its disk does, so `up` is meant to run again on every session start and
// resume: it repairs what is down and changes nothing that is up.
import process from 'node:process';
import { spawn as spawnChild, spawnSync } from 'node:child_process';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { loadConfig, slugForHarness } from './config.mjs';
import { detectHarness } from './detect-harness.mjs';
import { installationPaths } from './install.mjs';
import { ServerSession, loadDevice, serverHarness, serverStateDir, serverUrl } from './identity/server-client.mjs';

const ROOT = dirname(fileURLToPath(import.meta.url));
const SELF = fileURLToPath(import.meta.url);

export const CLOUD_USAGE = `usage: agent-bot cloud up [--harness APP_SLUG] [--hook] [--json]
       agent-bot cloud down [--hook] [--json]
       agent-bot cloud install-hooks [--settings PATH] [--json]

Bring a short-lived machine to a working state and take it down again.
up starts the identity daemon if it is not running and enrolls the device
with the agent-bot server (AGENT_BOT_SERVER) if it is not enrolled. With
AGENT_BOT_ENROLL_TOKEN set it enrolls without a browser; otherwise it starts
the device grant in the background and prints the approval link. Run it again
at any time: it repairs only what is down. --harness defaults to
AGENT_BOT_SERVER_HARNESS, else the App the detected harness maps to.
down stops the daemon and unenrolls the device (server logout).
install-hooks adds \`cloud up --hook\` and \`cloud down --hook\` to the Claude
Code SessionStart and SessionEnd hooks (~/.claude/settings.json). --hook
prints Claude Code hook JSON and always exits 0, so a hook never blocks.
`;

// How long `up` waits for the background enrollment to log its prompt.
const PROMPT_WAIT_MS = 15_000;

export function cloudStateDir(opts = {}) {
  return join(dirname(serverStateDir(opts)), 'cloud');
}

function pendingPath(opts) { return join(cloudStateDir(opts), 'enroll-pending.json'); }
function logPath(opts) { return join(cloudStateDir(opts), 'enroll.log'); }

export function parseCloudArgs(argv) {
  const [sub, ...rest] = argv;
  const out = { sub, hook: false, json: false, harness: null, settings: null };
  for (let i = 0; i < rest.length; i += 1) {
    const a = rest[i];
    const val = () => { const v = rest[++i]; if (!v || v.startsWith('--')) throw new Error(`${a} requires a value`); return v; };
    if (a === '--hook') out.hook = true;
    else if (a === '--json') out.json = true;
    else if (a === '--harness') out.harness = serverHarness(val());
    else if (a === '--settings') out.settings = val();
    else throw new Error(`unknown option: ${a}\n${CLOUD_USAGE}`);
  }
  if (!['up', 'down', 'install-hooks', undefined, 'help', '--help', '-h'].includes(sub)) throw new Error(`unknown cloud command: ${sub}\n${CLOUD_USAGE}`);
  return out;
}

// The App the device enrolls for: the flag, then AGENT_BOT_SERVER_HARNESS,
// then the App the running harness maps to in the organization profile.
export function resolveAppSlug({ flag = null, env = process.env, config } = {}) {
  if (flag) return flag;
  if (env.AGENT_BOT_SERVER_HARNESS) return serverHarness(env.AGENT_BOT_SERVER_HARNESS);
  const harness = detectHarness(env);
  if (!harness) return null;
  try { return slugForHarness(harness, config ?? loadConfig({ env }), { env }); } catch { return null; }
}

// Runs this runtime's own CLI, never whatever `agent-bot` is first on PATH.
export function runAgentBot(args, { env = process.env, timeout = 120_000 } = {}) {
  const r = spawnSync(process.execPath, [join(ROOT, 'agent-bot.mjs'), ...args], { env, encoding: 'utf8', timeout });
  return { status: r.status ?? 1, stdout: r.stdout ?? '', stderr: r.stderr ?? (r.error?.message ?? '') };
}

export function ensureDaemon({ run = runAgentBot, env = process.env } = {}) {
  const status = run(['daemon', 'status'], { env });
  if (status.status === 0 && /^running\b/m.test(status.stdout)) return { state: 'running' };
  const started = run(['daemon', 'start'], { env });
  if (started.status === 0) return { state: 'started', detail: started.stdout.trim().split('\n').pop() };
  return { state: 'failed', detail: (started.stderr || started.stdout).trim().split('\n').pop() };
}

function readPending(opts) {
  try { return JSON.parse(readFileSync(pendingPath(opts), 'utf8')); } catch { return null; }
}

// The worker is spawned detached, so it leads its own process group, and the
// enroll it runs is in that group: the group is what is alive or stopped.
// Killing only the worker would orphan the enroll, still polling the server.
function groupAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try { process.kill(-pid, 0); return true; } catch (error) { return error?.code === 'EPERM'; }
}

function stopGroup(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return;
  // Only the group: a bare pid may by now belong to an unrelated process.
  try { process.kill(-pid, 'SIGTERM'); } catch { /* already gone */ }
}

// The approval prompt `server enroll --json` streams as one JSON line.
export function promptFromLog(text) {
  for (const line of String(text).split('\n').reverse()) {
    try {
      const parsed = JSON.parse(line);
      if (parsed?.prompt?.verification_uri_complete) return parsed.prompt;
    } catch { /* not a JSON line */ }
  }
  return null;
}

// Starts `cloud __enroll-worker` detached: it runs the device grant, and
// restarts the daemon once the grant is approved so the daemon picks up the
// new enrollment. Returns the approval prompt as soon as the worker logs it.
export async function startBackgroundEnroll({ slug, force, env = process.env, spawn = spawnChild, wait = PROMPT_WAIT_MS, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), now = Date.now } = {}) {
  const opts = { env };
  const server = serverUrl({ env });
  const pending = readPending(opts);
  // Reused only for the same App and server: a grant for another target
  // would show the owner an approval for something this run did not ask for.
  if (pending && pending.slug === slug && pending.server === server && groupAlive(pending.pid)
    && pending.prompt && Date.parse(pending.prompt.expires_at ?? 0) > now()) {
    return { state: 'pending', prompt: pending.prompt, reused: true };
  }
  if (pending) stopGroup(pending.pid);
  mkdirSync(cloudStateDir(opts), { recursive: true, mode: 0o700 });
  const log = logPath(opts);
  writeFileSync(log, '', { mode: 0o600 });
  const fd = openSync(log, 'a');
  let child;
  try {
    child = spawn(process.execPath, [SELF, '__enroll-worker', '--harness', slug, ...(force ? ['--force'] : [])], {
      env, detached: true, stdio: ['ignore', fd, fd],
    });
  } finally {
    closeSync(fd);
  }
  child.unref?.();
  // Recorded before waiting, so `cloud down` finds the worker even when no
  // prompt ever appears.
  writePrivateJson(pendingPath(opts), { pid: child.pid, slug, server, prompt: null });
  const deadline = now() + wait;
  for (;;) {
    let text = '';
    try { text = readFileSync(log, 'utf8'); } catch { /* not written yet */ }
    const prompt = promptFromLog(text);
    if (prompt) {
      const record = { pid: child.pid, slug, server, prompt: { ...prompt, expires_at: new Date(now() + (Number(prompt.expires_in) || 900) * 1000).toISOString() } };
      writePrivateJson(pendingPath(opts), record);
      return { state: 'pending', prompt: record.prompt, reused: false };
    }
    if (/^enrolled\b/m.test(text) || /"device_id"/.test(text)) return { state: 'enrolled' };
    if (now() >= deadline) {
      // A worker that never showed a prompt is stopped, not left to enroll
      // and restart the daemon after the caller has moved on.
      stopGroup(child.pid);
      try { rmSync(pendingPath(opts), { force: true }); } catch { /* already gone */ }
      return { state: 'failed', detail: text.trim().split('\n').pop() || 'no approval prompt within the wait' };
    }
    await sleep(250);
  }
}

function writePrivateJson(path, value) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, path);
}

// Enrolled for this server and App, and not known to be revoked. A device the
// server since revoked or expired is found by its first call and re-enrolled
// by `up` run again with that knowledge (enroll --force).
export function enrollmentState({ base, slug, env = process.env, now = Date.now } = {}) {
  let device = null;
  try { device = loadDevice({ env }, { includeOutcomes: false }); } catch { return { state: 'unreadable' }; }
  if (!device) return { state: 'none' };
  if (device.server !== base) return { state: 'other-server', device };
  if (device.revoked_at) return { state: 'revoked', device };
  if (device.expires_at && Date.parse(device.expires_at) <= now()) return { state: 'expired', device };
  if (slug && Array.isArray(device.harnesses) && !device.harnesses.includes(slug)) return { state: 'other-app', device };
  return { state: 'enrolled', device };
}

// The server's own answer for a device that looks enrolled locally: an idle
// expiry or a revoke from /devices leaves no local trace. Only a refusal
// re-enrolls; an unreachable server leaves the enrollment as it is.
export async function verifyEnrollment({ base, env = process.env, fetchImpl = fetch } = {}) {
  try {
    await new ServerSession({ base, env, fetchImpl }).whoami();
    return { ok: true };
  } catch (error) {
    if (error?.code === 'device-revoked' || error?.code === 'invalid_grant') return { ok: false, reason: error.code };
    return { ok: true, unverified: error?.message ?? String(error) };
  }
}

export async function cloudUp({ harness = null, env = process.env, run = runAgentBot, background = startBackgroundEnroll, verify = verifyEnrollment } = {}) {
  const base = serverUrl({ env });
  const result = { server: base, daemon: null, enrollment: null, app: null };
  if (!base) {
    result.enrollment = { state: 'failed', detail: 'server mode is off: set AGENT_BOT_SERVER=https://… in the environment' };
    result.daemon = ensureDaemon({ run, env });
    return result;
  }
  const serverEnv = { ...env, AGENT_BOT_SERVER: base };
  const slug = resolveAppSlug({ flag: harness, env });
  result.app = slug;
  let current = enrollmentState({ base, slug, env });
  if (current.state === 'enrolled') {
    const live = await verify({ base, env: serverEnv });
    if (!live.ok) current = { state: live.reason === 'device-revoked' ? 'revoked' : 'expired', device: current.device };
    else if (live.unverified) result.warning = `could not confirm the enrollment with the server: ${live.unverified}`;
  }
  if (current.state === 'enrolled') {
    result.enrollment = { state: 'enrolled', device: current.device.device_id };
    try { rmSync(pendingPath({ env }), { force: true }); } catch { /* nothing pending */ }
  } else if (!slug) {
    result.enrollment = { state: 'failed', detail: 'no App to enroll for: pass --harness <app-slug> or set AGENT_BOT_SERVER_HARNESS' };
  } else {
    const force = current.state !== 'none';
    if (env.AGENT_BOT_ENROLL_TOKEN) {
      const enrolled = run(['server', 'enroll', '--harness', slug, '--tag', 'cloud', ...(force ? ['--force'] : [])], { env: serverEnv });
      result.enrollment = enrolled.status === 0
        ? { state: 'enrolled', device: loadDevice({ env }, { includeOutcomes: false })?.device_id ?? null, via: 'token' }
        : { state: 'failed', detail: (enrolled.stderr || enrolled.stdout).trim().split('\n').pop() };
    } else {
      result.enrollment = await background({ slug, force, env: serverEnv });
    }
  }
  result.daemon = ensureDaemon({ run, env: serverEnv });
  return result;
}

export function cloudDown({ env = process.env, run = runAgentBot } = {}) {
  const opts = { env };
  const pending = readPending(opts);
  if (pending) {
    stopGroup(pending.pid);
    try { rmSync(pendingPath(opts), { force: true }); } catch { /* already gone */ }
  }
  const stopped = run(['daemon', 'stop'], { env });
  const logout = run(['server', 'logout', '--json'], { env });
  let remote = null;
  try { remote = JSON.parse(logout.stdout.trim().split('\n').pop()).remote; } catch { /* no JSON */ }
  return {
    daemon: stopped.status === 0 ? 'stopped' : 'not-running',
    enrollment: remote ?? (logout.status === 0 ? 'removed' : 'failed'),
    ...(logout.status === 0 ? {} : { detail: logout.stderr.trim().split('\n').pop() }),
  };
}

export function formatUp(r) {
  const lines = [];
  const e = r.enrollment ?? {};
  if (e.state === 'pending') {
    lines.push(`approve this device: ${e.prompt.verification_uri_complete}`, `  code: ${e.prompt.user_code}`, `  key:  ${e.prompt.jkt}`);
    lines.push(`  (enrolling for ${r.app}; the daemon restarts once it is approved)`);
  } else if (e.state === 'enrolled') lines.push(`enrolled: ${e.device ?? 'yes'} (${r.app ?? 'unknown app'}) at ${r.server}`);
  else lines.push(`enrollment: ${e.state ?? 'unknown'}${e.detail ? ` — ${e.detail}` : ''}`);
  if (r.warning) lines.push(`warning: ${r.warning}`);
  const d = r.daemon ?? {};
  lines.push(`daemon: ${d.state ?? 'unknown'}${d.detail ? ` — ${d.detail}` : ''}`);
  return `${lines.join('\n')}\n`;
}

function hookContext(text, event) {
  return `${JSON.stringify({ hookSpecificOutput: { hookEventName: event, additionalContext: text } })}\n`;
}

// Adds the two hook entries unless an entry this command owns is already
// there, keeping every other setting and hook as it is.
export function installHooks({ settingsPath, executable }) {
  let settings = {};
  if (existsSync(settingsPath)) {
    const raw = readFileSync(settingsPath, 'utf8');
    settings = raw.trim() ? JSON.parse(raw) : {};
    if (!settings || typeof settings !== 'object' || Array.isArray(settings)) throw new Error(`${settingsPath} is not a JSON object`);
  }
  const quoted = `'${executable.replaceAll("'", `'\\''`)}'`;
  const wanted = { SessionStart: 'up', SessionEnd: 'down' };
  settings.hooks ??= {};
  const changed = [];
  for (const [event, verb] of Object.entries(wanted)) {
    const command = `${quoted} cloud ${verb} --hook`;
    const groups = Array.isArray(settings.hooks[event]) ? settings.hooks[event] : [];
    // Any agent-bot `cloud <verb> --hook` entry counts, whatever path it runs.
    const owned = groups.some((g) => (g?.hooks ?? []).some((h) => typeof h?.command === 'string' && h.command.endsWith(` cloud ${verb} --hook`) && /agent-bot/.test(h.command)));
    if (owned) continue;
    groups.push({ hooks: [{ type: 'command', command, timeout: 60 }] });
    settings.hooks[event] = groups;
    changed.push(event);
  }
  if (changed.length) writePrivateJson(settingsPath, settings);
  return { settings: settingsPath, added: changed };
}

export async function main(argv = process.argv.slice(2), { env = process.env, out = process.stdout, err = process.stderr, run = runAgentBot, background = startBackgroundEnroll } = {}) {
  let a;
  try { a = parseCloudArgs(argv); } catch (error) { err.write(`agent-bot cloud: ${error.message}\n`); return 1; }
  if (!a.sub || ['help', '--help', '-h'].includes(a.sub)) { out.write(CLOUD_USAGE); return 0; }
  try {
    if (a.sub === 'up') {
      const r = await cloudUp({ harness: a.harness, env, run, background });
      if (a.hook) {
        const text = r.enrollment?.state === 'pending'
          ? `agent-bot cloud: this container is not enrolled yet. Tell the user to approve it: ${r.enrollment.prompt.verification_uri_complete} (code ${r.enrollment.prompt.user_code}, key ${r.enrollment.prompt.jkt}).\n${formatUp(r)}`
          : `agent-bot cloud:\n${formatUp(r)}`;
        out.write(hookContext(text, 'SessionStart'));
        return 0;
      }
      out.write(a.json ? `${JSON.stringify(r)}\n` : formatUp(r));
      return r.enrollment?.state === 'failed' || r.daemon?.state === 'failed' ? 1 : 0;
    }
    if (a.sub === 'down') {
      const r = cloudDown({ env, run });
      if (a.hook) return 0;
      out.write(a.json ? `${JSON.stringify(r)}\n` : `daemon: ${r.daemon}\nenrollment: ${r.enrollment}${r.detail ? ` — ${r.detail}` : ''}\n`);
      return r.enrollment === 'failed' || r.enrollment === 'unreadable' ? 1 : 0;
    }
    const home = env.HOME || homedir();
    const r = installHooks({ settingsPath: a.settings ?? join(home, '.claude', 'settings.json'), executable: installationPaths(home).executable });
    out.write(a.json ? `${JSON.stringify(r)}\n` : (r.added.length ? `added ${r.added.join(' and ')} hooks to ${r.settings}\n` : `${r.settings} already runs agent-bot cloud\n`));
    return 0;
  } catch (error) {
    if (a.hook) return 0;
    err.write(`agent-bot cloud: ${error.message}\n`);
    return 1;
  }
}

// The background device grant: enroll, then restart the daemon so it picks
// the new enrollment up. Its output goes to the enroll log `up` reads.
async function enrollWorker(argv, { env = process.env } = {}) {
  // Inherited stdio: the prompt line must reach the log while the grant is
  // still waiting for approval, not when it ends.
  const enrolled = spawnSync(process.execPath, [join(ROOT, 'agent-bot.mjs'), 'server', 'enroll', '--json', '--tag', 'cloud', ...argv],
    { env, stdio: ['ignore', 'inherit', 'inherit'], timeout: 30 * 60_000 });
  if (enrolled.status !== 0) return enrolled.status ?? 1;
  runAgentBot(['daemon', 'stop'], { env });
  runAgentBot(['daemon', 'start'], { env });
  return 0;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  process.exitCode = process.argv[2] === '__enroll-worker'
    ? await enrollWorker(process.argv.slice(3))
    : await main();
}
