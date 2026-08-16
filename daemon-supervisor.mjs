// User-level supervisor for the identity daemon (#106).
//
// install/update/bootstrap write and load a launchd agent (macOS) or systemd
// user unit (Linux) that execs the installed `agent-bot daemon run` entrypoint.
// The OS restarts it at login and on failure. MCP stays per-conversation stdio
// and is never supervised. The unit file is secret-free and loopback policy
// stays in the daemon itself — this module does not pass a bind address.
//
//   ensureDaemonSupervisor  — write/refresh the unit and keep it loaded
//   disableDaemonSupervisor — unload the unit and stop the daemon
//   inspectSupervisor       — secret-free status for doctor
//   admitDaemonStart        — ENG-0138 admission before spawn

import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import process from 'node:process';

import { daemonStateFile, daemonStatus, stopDaemon } from './agent-daemon.mjs';
import { decideAdmission, deriveBudget } from './tools/agent-guard/lib/budget.mjs';
import { readLeases } from './tools/agent-guard/lib/leases.mjs';
import { readMemoryStatus } from './tools/agent-guard/lib/system-memory.mjs';

export const LAUNCHD_LABEL = 'dev.qwts.agent-bot.daemon';
export const SYSTEMD_UNIT = 'agent-bot-daemon.service';
// One Node HTTP listener. Kept at the light-run floor so pressure/swap gates
// that exist for Electron-sized lanes do not refuse the identity service.
export const DAEMON_RESERVE_MB = 256;

export function supervisorSkipLoad(env = process.env) {
  return env.AGENT_BOT_SUPERVISOR_SKIP_LOAD === '1';
}

export function supervisorPaths(home = homedir(), platform = process.platform) {
  if (platform === 'darwin') {
    return {
      platform,
      kind: 'launchd',
      label: LAUNCHD_LABEL,
      unitPath: join(home, 'Library', 'LaunchAgents', `${LAUNCHD_LABEL}.plist`),
    };
  }
  if (platform === 'linux') {
    return {
      platform,
      kind: 'systemd',
      label: SYSTEMD_UNIT,
      unitPath: join(home, '.config', 'systemd', 'user', SYSTEMD_UNIT),
    };
  }
  return {
    platform,
    kind: null,
    label: null,
    unitPath: null,
  };
}

function xmlEscape(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

export function supervisorEnvironment({ env = process.env, home = homedir() } = {}) {
  return {
    AGENT_BOT_DAEMON_STATE_PATH: daemonStateFile({ env, home }),
  };
}

function environmentEntries(environment = {}) {
  return Object.entries(environment).filter(([, value]) => typeof value === 'string' && value.length > 0);
}

export function renderLaunchdPlist({ executable, environment = {} }) {
  if (typeof executable !== 'string' || executable.length === 0 || executable.includes('\0')) {
    throw new Error('supervisor executable must be a non-empty path');
  }
  const envXml = environmentEntries(environment).map(([key, value]) => (
    `    <key>${xmlEscape(key)}</key>\n    <string>${xmlEscape(value)}</string>`
  )).join('\n');
  const envBlock = envXml
    ? `\n  <key>EnvironmentVariables</key>\n  <dict>\n${envXml}\n  </dict>`
    : '';
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${xmlEscape(LAUNCHD_LABEL)}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${xmlEscape(executable)}</string>
    <string>daemon</string>
    <string>run</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>${envBlock}
</dict>
</plist>
`;
}

export function renderSystemdUnit({ executable, environment = {} }) {
  if (typeof executable !== 'string' || executable.length === 0 || executable.includes('\0')) {
    throw new Error('supervisor executable must be a non-empty path');
  }
  const execStart = executable.includes(' ') ? `"${executable.replaceAll('"', '\\"')}"` : executable;
  const envLines = environmentEntries(environment)
    .map(([key, value]) => `Environment=${key}=${value.replaceAll('\n', '')}`)
    .join('\n');
  return `[Unit]
Description=agent-bot identity daemon
After=default.target

[Service]
ExecStart=${execStart} daemon run
${envLines ? `${envLines}\n` : ''}Restart=always
RestartSec=2

[Install]
WantedBy=default.target
`;
}

export function renderSupervisorUnit({ kind, executable, environment = {} }) {
  if (kind === 'launchd') return renderLaunchdPlist({ executable, environment });
  if (kind === 'systemd') return renderSystemdUnit({ executable, environment });
  throw new Error(`unsupported supervisor kind: ${kind}`);
}

export function admitDaemonStart({
  requestMb = DAEMON_RESERVE_MB,
  env = process.env,
  readMemory = readMemoryStatus,
  listLeases = readLeases,
  budgetFor = deriveBudget,
  decide = decideAdmission,
} = {}) {
  const memory = readMemory();
  const budget = budgetFor(memory.totalMb);
  if (requestMb > budget.maxRunMb) {
    throw new Error(
      `identity daemon reserve ${requestMb} MB exceeds the ENG-0138 machine cap of ${budget.maxRunMb} MB`,
    );
  }
  const decision = decide({
    budget,
    memory,
    leases: listLeases(env),
    requestMb,
  });
  if (!decision.granted) {
    throw new Error(`identity daemon was not admitted: ${decision.message}`);
  }
  return decision;
}

function runCommand(command, args, { env = process.env } = {}) {
  return execFileSync(command, args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env,
  });
}

function launchdDomain() {
  return `gui/${process.getuid?.() ?? '501'}`;
}

export function inspectSupervisor({
  home = homedir(),
  env = process.env,
  platform = process.platform,
  exists = existsSync,
  exec = runCommand,
} = {}) {
  const paths = supervisorPaths(home, platform);
  if (!paths.kind) {
    return {
      supported: false,
      applied: false,
      loaded: false,
      platform,
      kind: null,
      unitPath: null,
      label: null,
    };
  }
  const applied = exists(paths.unitPath);
  let loaded = false;
  if (supervisorSkipLoad(env) && applied) {
    loaded = true;
  } else if (applied) {
    try {
      if (paths.kind === 'launchd') {
        exec('launchctl', ['list', paths.label], { env });
        loaded = true;
      } else {
        const state = exec('systemctl', ['--user', 'is-enabled', paths.label], { env }).trim();
        loaded = state === 'enabled' || state === 'static' || state === 'linked';
      }
    } catch {
      loaded = false;
    }
  }
  return {
    supported: true,
    applied,
    loaded,
    platform,
    kind: paths.kind,
    unitPath: paths.unitPath,
    label: paths.label,
  };
}

function commandErrorText(error) {
  return `${error?.stderr ?? ''} ${error?.stdout ?? ''} ${error?.message ?? ''}`;
}

export function isInactiveSupervisorError(error) {
  return /not (?:found|loaded|enabled|installed|been started)|could not find|no such process|inactive|does not exist/i
    .test(commandErrorText(error));
}

function loadSupervisor(paths, { env, exec, skipLoad }) {
  if (skipLoad) return { loaded: true, skipped: true };
  if (paths.kind === 'launchd') {
    try {
      exec('launchctl', ['bootout', `${launchdDomain()}/${paths.label}`], { env });
    } catch {
      try {
        exec('launchctl', ['unload', '-w', paths.unitPath], { env });
      } catch {
        /* first install, or an already-unloaded agent */
      }
    }
    try {
      exec('launchctl', ['bootstrap', launchdDomain(), paths.unitPath], { env });
    } catch {
      exec('launchctl', ['load', '-w', paths.unitPath], { env });
    }
    return { loaded: true, skipped: false };
  }
  exec('systemctl', ['--user', 'daemon-reload'], { env });
  exec('systemctl', ['--user', 'enable', '--now', paths.label], { env });
  // enable --now will not restart an already-active unit; update must.
  exec('systemctl', ['--user', 'restart', paths.label], { env });
  return { loaded: true, skipped: false };
}

function unloadSupervisor(paths, { env, exec, skipLoad }) {
  if (skipLoad) return { unloaded: true, skipped: true };
  if (paths.kind === 'launchd') {
    try {
      exec('launchctl', ['bootout', `${launchdDomain()}/${paths.label}`], { env });
    } catch (error) {
      if (!isInactiveSupervisorError(error)) throw error;
      try {
        exec('launchctl', ['unload', '-w', paths.unitPath], { env });
      } catch (unloadError) {
        if (!isInactiveSupervisorError(unloadError)) throw unloadError;
      }
    }
    return { unloaded: true, skipped: false };
  }
  try {
    exec('systemctl', ['--user', 'disable', '--now', paths.label], { env });
  } catch (error) {
    if (!isInactiveSupervisorError(error)) throw error;
  }
  try {
    exec('systemctl', ['--user', 'daemon-reload'], { env });
  } catch {
    /* reload is best-effort after a confirmed disable */
  }
  return { unloaded: true, skipped: false };
}

const HEALTH_WAIT_MS = 8_000;
const HEALTH_POLL_MS = 150;

function sleep(ms) {
  return new Promise((resolve) => { setTimeout(resolve, ms); });
}

async function waitHealthy({ env, home, probe, timeoutMs = HEALTH_WAIT_MS }) {
  const deadline = Date.now() + timeoutMs;
  let status;
  while (Date.now() < deadline) {
    status = await probe({ env, home });
    if (status.running) return status;
    await sleep(HEALTH_POLL_MS);
  }
  throw new Error(status?.reason ?? 'daemon did not become healthy after supervisor load');
}

export async function ensureDaemonSupervisor({
  home = homedir(),
  env = process.env,
  platform = process.platform,
  executable = join(home, '.local', 'bin', 'agent-bot'),
  admit = admitDaemonStart,
  probe = daemonStatus,
  stopDetached = stopDaemon,
  exists = existsSync,
  read = readFileSync,
  write = writeFileSync,
  mkdir = mkdirSync,
  exec = runCommand,
} = {}) {
  const paths = supervisorPaths(home, platform);
  if (!paths.kind) {
    return { applied: false, reason: 'unsupported-platform', platform };
  }
  const skipLoad = supervisorSkipLoad(env);
  if (!skipLoad) admit({ env });
  const environment = supervisorEnvironment({ env, home });
  const supervisorEnv = { ...env, ...environment };
  const body = renderSupervisorUnit({ kind: paths.kind, executable, environment });
  mkdir(dirname(paths.unitPath), { recursive: true });
  let previous = null;
  try {
    previous = read(paths.unitPath, 'utf8');
  } catch {
    previous = null;
  }
  write(paths.unitPath, body, { mode: 0o644 });
  const inspection = inspectSupervisor({ home, env, platform, exists, exec });
  const current = await probe({ env: supervisorEnv, home });
  if (current.running && !inspection.loaded && !skipLoad) {
    await stopDetached({ env: supervisorEnv, home });
  }
  // Always reload/restart. The installed symlink path is stable, so an
  // unchanged unit body still means the checkout behind it may have moved.
  loadSupervisor(paths, { env, exec, skipLoad });
  if (skipLoad) {
    return {
      applied: true,
      loaded: true,
      skippedLoad: true,
      refreshed: previous !== body,
      platform,
      kind: paths.kind,
      unitPath: paths.unitPath,
      statePath: environment.AGENT_BOT_DAEMON_STATE_PATH,
    };
  }
  const healthy = await waitHealthy({ env: supervisorEnv, home, probe });
  return {
    applied: true,
    loaded: true,
    skippedLoad: false,
    refreshed: previous !== body,
    alreadyRunning: false,
    pid: healthy.pid,
    port: healthy.port,
    platform,
    kind: paths.kind,
    unitPath: paths.unitPath,
    statePath: environment.AGENT_BOT_DAEMON_STATE_PATH,
  };
}

export async function disableDaemonSupervisor({
  home = homedir(),
  env = process.env,
  platform = process.platform,
  probe = daemonStatus,
  stop = stopDaemon,
  exists = existsSync,
  remove = rmSync,
  exec = runCommand,
} = {}) {
  const paths = supervisorPaths(home, platform);
  if (!paths.kind) {
    return { unloaded: false, reason: 'unsupported-platform', platform };
  }
  const skipLoad = supervisorSkipLoad(env);
  const supervisorEnv = { ...env, ...supervisorEnvironment({ env, home }) };
  if (exists(paths.unitPath) || inspectSupervisor({ home, env, platform, exists, exec }).loaded) {
    unloadSupervisor(paths, { env, exec, skipLoad });
  }
  if (exists(paths.unitPath)) remove(paths.unitPath, { force: true });
  const status = await probe({ env: supervisorEnv, home });
  if (status.running) await stop({ env: supervisorEnv, home });
  return {
    unloaded: true,
    stopped: Boolean(status.running),
    platform,
    kind: paths.kind,
    unitPath: paths.unitPath,
  };
}
