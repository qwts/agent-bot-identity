// The daemon's lifecycle as other processes see it (#1386): start it
// detached and wait until it answers, stop it through its state record, and
// warn when the wrong account runs it. agent-web.mjs and daemon-supervisor.mjs
// call these, and agent-daemon.mjs loads the supervisor, so they sit apart from
// the daemon's server in this daemon state module, which keeps the three out
// of an import cycle (HQ plan §2.4, C5). agent-daemon.mjs re-exports each name.
import { spawn } from 'node:child_process';
import { rmSync, statSync } from 'node:fs';
import { homedir, userInfo } from 'node:os';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { daemonStateFile, probeDaemonHealth, readDaemonState } from './daemon-client.mjs';
import { daemonStatus } from './daemon-status.mjs';

const START_TIMEOUT_MS = 8_000;
const STOP_TIMEOUT_MS = 8_000;
const POLL_INTERVAL_MS = 150;

function sleep(ms) {
  return new Promise((resolve) => { setTimeout(resolve, ms); });
}

// When run on a managed macOS host under `admin` (the Homebrew/agent-machine
// account), warn that agent-daemon and `web open` belong to the owner's `user`
// session rather than the `admin` account.
export function wrongAccountWarning({
  env = process.env,
  uid = typeof process.getuid === 'function' ? process.getuid() : null,
  username = null,
  stat = statSync,
  command = 'daemon start',
} = {}) {
  let acct = username ?? env.USER ?? env.LOGNAME ?? null;
  if (!acct) {
    try { acct = userInfo().username; } catch { acct = null; }
  }
  let isAdminAccount = acct === 'admin';
  if (!isAdminAccount && typeof uid === 'number' && uid !== 0) {
    for (const prefix of ['/opt/homebrew', '/usr/local/Homebrew']) {
      try {
        const st = stat(prefix);
        if (st.uid === uid && acct && acct !== 'user') { isAdminAccount = true; break; }
      } catch { /* absent */ }
    }
  }
  if (!isAdminAccount) return null;
  return `warning: \`agent-bot ${command}\` is running as '${acct ?? 'admin'}' (the Homebrew and agent-machine account); the agent-bot daemon runs in the owner's user account`;
}

export async function startDaemon({
  env = process.env,
  home = homedir(),
  // The daemon's own entry: `node agent-daemon.mjs run`.
  moduleUrl = new URL('./agent-daemon.mjs', import.meta.url).href,
  warn = (line) => process.stderr.write(`${line}\n`),
  accountWarning = wrongAccountWarning,
} = {}) {
  const notice = accountWarning({ env, command: 'daemon start' });
  if (notice) warn(notice);
  const existing = await daemonStatus({ env, home });
  if (existing.running) return { ...existing, alreadyRunning: true };
  // fileURLToPath, not URL.pathname: a checkout path with spaces stays
  // percent-encoded in the pathname and the child exits module-not-found
  // (and drive letters break on Windows).
  const child = spawn(process.execPath, [fileURLToPath(moduleUrl), 'run'], {
    detached: true,
    stdio: 'ignore',
    env,
  });
  child.unref();
  const deadline = Date.now() + START_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const status = await daemonStatus({ env, home });
    if (status.running) return { ...status, alreadyRunning: false };
    await sleep(POLL_INTERVAL_MS);
  }
  throw new Error('daemon did not become healthy within the startup deadline');
}

export async function stopDaemon({ env = process.env, home = homedir(), fetchImpl = fetch } = {}) {
  const file = daemonStateFile({ env, home });
  const state = readDaemonState(file);
  if (!state) return { stopped: false, reason: 'no daemon state file' };
  // A recorded PID can be reused by an unrelated process after a crash or
  // reboot. Only the token-authenticated health probe proves the record still
  // names our daemon, so a failed probe removes the stale record and signals
  // nothing.
  if (!(await probeDaemonHealth(state, { fetchImpl }))) {
    rmSync(file, { force: true });
    return {
      stopped: false,
      reason: 'recorded daemon did not answer the authenticated health probe; removed stale state',
    };
  }
  try {
    process.kill(state.pid, 'SIGTERM');
  } catch (error) {
    if (error.code === 'ESRCH') {
      rmSync(file, { force: true });
      return { stopped: false, reason: 'recorded daemon was not running; removed stale state' };
    }
    throw error;
  }
  const deadline = Date.now() + STOP_TIMEOUT_MS;
  while (Date.now() < deadline) {
    try {
      process.kill(state.pid, 0);
    } catch {
      rmSync(file, { force: true });
      return { stopped: true, pid: state.pid };
    }
    await sleep(POLL_INTERVAL_MS);
  }
  throw new Error(`daemon pid ${state.pid} did not exit within the shutdown deadline`);
}
