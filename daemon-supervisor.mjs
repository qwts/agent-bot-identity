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
//
// An embedded host (GeniusBar) sets AGENT_BOT_SERVICE_LABEL so its unit
// cannot collide with an installed agent-bot's, and registers its bundled
// runtime with `agent-bot daemon install` (#302).

import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join } from 'node:path';
import process from 'node:process';

import { daemonStateFile, daemonStatus, stopDaemon } from './agent-daemon.mjs';
import { daemonLogMaxBytes, daemonLogPath } from './daemon-log.mjs';

export const LAUNCHD_LABEL = 'dev.qwts.agent-bot.daemon';
export const SYSTEMD_UNIT = 'agent-bot-daemon.service';
export const SERVICE_LABEL_VARIABLE = 'AGENT_BOT_SERVICE_LABEL';

/**
 * The host-supplied service label, or null for the defaults. It names a
 * launchctl target and a unit file, so it must be one safe token.
 */
export function hostServiceLabel(env = process.env) {
  const label = env[SERVICE_LABEL_VARIABLE];
  if (label === undefined || label === '') return null;
  if (!/^[A-Za-z0-9_][A-Za-z0-9_.-]*$/.test(label)) {
    throw Object.assign(new Error(
      `usage: ${SERVICE_LABEL_VARIABLE} must use letters, digits, dots, underscores or hyphens and start with a letter, digit or underscore`,
    ), { code: 'usage' });
  }
  return label;
}

export function supervisorSkipLoad(env = process.env) {
  return env.AGENT_BOT_SUPERVISOR_SKIP_LOAD === '1';
}

export function supervisorPaths(home = homedir(), platform = process.platform, env = process.env) {
  const hostLabel = hostServiceLabel(env);
  if (platform === 'darwin') {
    const label = hostLabel ?? LAUNCHD_LABEL;
    return {
      platform,
      kind: 'launchd',
      label,
      unitPath: join(home, 'Library', 'LaunchAgents', `${label}.plist`),
      // launchd sends a job's stdio to /dev/null unless the unit names a
      // file, so the daemon's stderr diagnostics would be lost without one.
      logPath: daemonLogPath(home),
    };
  }
  if (platform === 'linux') {
    const label = hostLabel ? `${hostLabel}.service` : SYSTEMD_UNIT;
    return {
      platform,
      kind: 'systemd',
      label,
      unitPath: join(home, '.config', 'systemd', 'user', label),
      // systemd's journal captures the unit's stdio.
      logPath: null,
    };
  }
  return {
    platform,
    kind: null,
    label: null,
    unitPath: null,
    logPath: null,
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
  const label = hostServiceLabel(env);
  return {
    AGENT_BOT_DAEMON_STATE_PATH: daemonStateFile({ env, home }),
    ...(env.AGENT_BOT_DAEMON_LOG_MAX_BYTES !== undefined
      ? { AGENT_BOT_DAEMON_LOG_MAX_BYTES: String(daemonLogMaxBytes(env)) } : {}),
    // The supervised daemon resolves the same label as the host that installed it.
    ...(label ? { [SERVICE_LABEL_VARIABLE]: label } : {}),
    // A host's own npm, which installs soul harnesses (ADR-0276).
    ...(env.AGENT_BOT_NPM && isAbsolute(env.AGENT_BOT_NPM) ? { AGENT_BOT_NPM: env.AGENT_BOT_NPM } : {}),
    ...(env.AGENT_BOT_EXECUTOR === '1' ? { AGENT_BOT_EXECUTOR: '1' } : {}),
    // The host's agent-comms and agent-bot, put first on souls' PATH.
    ...(env.AGENT_BOT_TOOL_PATH && isAbsolute(env.AGENT_BOT_TOOL_PATH) ? { AGENT_BOT_TOOL_PATH: env.AGENT_BOT_TOOL_PATH } : {}),
  };
}

// #321: Homebrew keg paths are versioned (`.../Cellar/<formula>/<version>/...`)
// and vanish on `brew upgrade` + `brew cleanup`, leaving launchd looping on a
// missing binary. The stable `.../opt/<formula>/...` symlink survives upgrades,
// so supervised units must record the opt form, never the Cellar form. Paths
// without a Cellar segment — the ~/.local/bin launcher, /usr/local/bin, and
// app bundles such as /Applications/GeniusBar.app/... — are already stable
// and pass through untouched.
const HOMEBREW_CELLAR_SEGMENT = /^(.*)\/Cellar\/([^/]+)\/[^/]+(\/.*)$/;

export function stableHomebrewPath(path) {
  if (typeof path !== 'string') return path;
  const match = path.match(HOMEBREW_CELLAR_SEGMENT);
  if (!match) return path;
  return `${match[1]}/opt/${match[2]}${match[3]}`;
}

export function stableDaemonProgramArguments(programArguments) {
  if (!Array.isArray(programArguments)) return programArguments;
  return programArguments.map((arg) => stableHomebrewPath(arg));
}

function checkProgram({ executable, programArguments }) {
  const program = programArguments ?? [executable, 'daemon', 'run'];
  if (!Array.isArray(program) || program.length === 0
    || program.some((arg) => typeof arg !== 'string' || arg.length === 0 || arg.includes('\0'))) {
    throw new Error('supervisor executable must be a non-empty path');
  }
  return program;
}

// systemd splits ExecStart on whitespace, honours quotes and C escapes, and
// expands $ and % specifiers: quote every word and escape all of them.
function systemdWord(arg) {
  return `"${arg.replaceAll('\\', '\\\\').replaceAll('"', '\\"').replaceAll('$', '$$$$').replaceAll('%', '%%')
    .replaceAll('\n', '\\n')}"`;
}

function environmentEntries(environment = {}) {
  return Object.entries(environment).filter(([, value]) => typeof value === 'string' && value.length > 0);
}

// `logPath`, when given, receives the job's stdout and stderr (the daemon's
// own diagnostics); without it launchd discards both.
export function renderLaunchdPlist({ executable, programArguments, environment = {}, label = LAUNCHD_LABEL, logPath = null }) {
  const program = checkProgram({ executable, programArguments });
  const logBlock = typeof logPath === 'string' && logPath.length > 0
    ? `\n  <key>StandardOutPath</key>\n  <string>${xmlEscape(logPath)}</string>\n  <key>StandardErrorPath</key>\n  <string>${xmlEscape(logPath)}</string>`
    : '';
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
  <string>${xmlEscape(label)}</string>
  <key>ProgramArguments</key>
  <array>
${program.map((arg) => `    <string>${xmlEscape(arg)}</string>`).join('\n')}
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>${logBlock}${envBlock}
</dict>
</plist>
`;
}

export function renderSystemdUnit({ executable, programArguments, environment = {} }) {
  checkProgram({ executable, programArguments });
  // The default form is unchanged; a host's argument list is fully quoted.
  const execStart = programArguments
    ? programArguments.map(systemdWord).join(' ')
    : `${executable.includes(' ') ? `"${executable.replaceAll('"', '\\"')}"` : executable} daemon run`;
  const envLines = environmentEntries(environment)
    .map(([key, value]) => `Environment=${key}=${value.replaceAll('\n', '')}`)
    .join('\n');
  return `[Unit]
Description=agent-bot identity daemon
After=default.target

[Service]
ExecStart=${execStart}
${envLines ? `${envLines}\n` : ''}Restart=always
RestartSec=2

[Install]
WantedBy=default.target
`;
}

export function renderSupervisorUnit({ kind, executable, programArguments, environment = {}, label, logPath = null }) {
  if (kind === 'launchd') return renderLaunchdPlist({ executable, programArguments, environment, label, logPath });
  if (kind === 'systemd') return renderSystemdUnit({ executable, programArguments, environment });
  throw new Error(`unsupported supervisor kind: ${kind}`);
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
  const paths = supervisorPaths(home, platform, env);
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
  // A host's own runtime and entry, replacing `executable daemon run`.
  programArguments,
  // install/update always restart; `daemon install` reloads only on change.
  reloadUnchanged = true,
  probe = daemonStatus,
  stopDetached = stopDaemon,
  exists = existsSync,
  read = readFileSync,
  write = writeFileSync,
  mkdir = mkdirSync,
  exec = runCommand,
} = {}) {
  const paths = supervisorPaths(home, platform, env);
  if (!paths.kind) {
    return { applied: false, reason: 'unsupported-platform', platform };
  }
  const skipLoad = supervisorSkipLoad(env);
  const environment = supervisorEnvironment({ env, home });
  const supervisorEnv = { ...env, ...environment };
  // Resolve through the stable opt paths, not the versioned Cellar realpath:
  // a unit that pins a Cellar path breaks on the next `brew upgrade` +
  // `brew cleanup`, while the opt form (or an already-stable launcher or app
  // bundle path) survives. A previous unit that pins Cellar paths therefore
  // always differs from the freshly rendered body, so `install` reports
  // `changed: true` and repairs it on the next run.
  const stableExecutable = stableHomebrewPath(executable);
  const stableArguments = stableDaemonProgramArguments(programArguments);
  const body = renderSupervisorUnit({
    kind: paths.kind, executable: stableExecutable, programArguments: stableArguments, environment, label: paths.label, logPath: paths.logPath,
  });
  mkdir(dirname(paths.unitPath), { recursive: true });
  // launchd opens the log file itself, but only inside a directory that
  // exists; a unit written before this file existed differs from this body,
  // so `daemon install` repairs it.
  if (paths.logPath) mkdir(dirname(paths.logPath), { recursive: true, mode: 0o700 });
  let previous = null;
  try {
    previous = read(paths.unitPath, 'utf8');
  } catch {
    previous = null;
  }
  if (!reloadUnchanged && previous === body) {
    const unchanged = inspectSupervisor({ home, env, platform, exists, exec });
    if (unchanged.loaded) {
      return {
        applied: true,
        loaded: true,
        skippedLoad: skipLoad,
        refreshed: false,
        platform,
        kind: paths.kind,
        label: paths.label,
        unitPath: paths.unitPath,
        statePath: environment.AGENT_BOT_DAEMON_STATE_PATH,
      };
    }
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
      label: paths.label,
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
    label: paths.label,
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
  const paths = supervisorPaths(home, platform, env);
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
    label: paths.label,
    unitPath: paths.unitPath,
  };
}
