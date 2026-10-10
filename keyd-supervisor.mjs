#!/usr/bin/env node
// Supervising agent-bot-keyd under launchd (#397): the host side of keyd,
// beside the daemon's own supervisor. keyd-client.mjs keeps the protocol,
// grants and status; this file writes and loads the unit (#645).
//
//   agent-bot keyd install --bin PATH [--json]   supervise keyd under launchd
//   agent-bot keyd uninstall [--json]            unload it (its keys stay)
//   agent-bot keyd status [--json]               whether it answers, and the pin
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';
import { renderLaunchdPlist, supervisorSkipLoad } from './daemon-supervisor.mjs';
import { KEYD_LABEL, KEYD_LABEL_VARIABLE, keydPaths, keydStatus, keydVersionAction, readKeydRecord } from './keyd-client.mjs';
import { vouchStateDir } from './vouch.mjs';

export function keydLabel(env = process.env) {
  const label = env[KEYD_LABEL_VARIABLE];
  if (label === undefined || label === '') return KEYD_LABEL;
  if (!/^[A-Za-z0-9_][A-Za-z0-9_.-]*$/.test(label)) throw new Error(`${KEYD_LABEL_VARIABLE} must use letters, digits, dots, underscores or hyphens`);
  return label;
}

function unitPath(label, home) {
  return path.join(home, 'Library', 'LaunchAgents', `${label}.plist`);
}

function launchctl(args, env) {
  return execFileSync('launchctl', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env });
}

// Supervise keyd under launchd from `bin`, the copy a host ships. Rewritten
// and reloaded only when the unit changes, like `daemon install`.
export function installKeyd({ bin, env = process.env, home = homedir(), platform = process.platform, exec = launchctl } = {}) {
  if (platform !== 'darwin') throw new Error('agent-bot-keyd runs only on macOS');
  if (typeof bin !== 'string' || !path.isAbsolute(bin) || !existsSync(bin)) throw new Error('--bin must be the absolute path of an agent-bot-keyd binary');
  const label = keydLabel(env);
  const unit = unitPath(label, home);
  const state = vouchStateDir({ env, home });
  const body = renderLaunchdPlist({ programArguments: [bin, 'serve', '--state-dir', state], label });
  let previous = null;
  try { previous = readFileSync(unit, 'utf8'); } catch { /* first install */ }
  const paths = keydPaths({ env, home });
  mkdirSync(paths.dir, { recursive: true, mode: 0o700 });
  const changed = previous !== body;
  if (changed) {
    mkdirSync(path.dirname(unit), { recursive: true });
    writeFileSync(unit, body, { mode: 0o644 });
    if (!supervisorSkipLoad(env)) {
      const domain = `gui/${process.getuid()}`;
      try { exec(['bootout', `${domain}/${label}`], env); } catch { /* not loaded yet */ }
      exec(['bootstrap', domain, unit], env);
    }
  }
  // Published last: the daemon injects keyd's relay only for a record, so
  // a unit that failed to write or load must not leave one behind.
  writeFileSync(paths.record, `${JSON.stringify({ bin, label })}\n`, { mode: 0o600 });
  return { label, unitPath: unit, bin, changed, loaded: true };
}

export function uninstallKeyd({ env = process.env, home = homedir(), platform = process.platform, exec = launchctl } = {}) {
  if (platform !== 'darwin') return { unloaded: false, reason: 'unsupported-platform' };
  // The label install saved wins over today's environment, so an install
  // under a custom label is removed without repeating that variable.
  const saved = readKeydRecord({ env, home })?.label;
  const label = typeof saved === 'string' && /^[A-Za-z0-9_][A-Za-z0-9_.-]*$/.test(saved) ? saved : keydLabel(env);
  const unit = unitPath(label, home);
  const present = existsSync(unit);
  if (present && !supervisorSkipLoad(env)) {
    try { exec(['bootout', `gui/${process.getuid()}/${label}`], env); } catch { /* already stopped */ }
  }
  rmSync(unit, { force: true });
  rmSync(keydPaths({ env, home }).record, { force: true });
  return { unloaded: present, label, unitPath: unit };
}


const USAGE = 'usage: agent-bot keyd install --bin PATH [--json] | uninstall [--json] | status [--json]';

export async function keydCommand(argv, { env = process.env, home = homedir(), write = (text) => process.stdout.write(text) } = {}) {
  const [action, ...rest] = argv;
  const json = rest.includes('--json');
  const args = rest.filter((arg) => arg !== '--json');
  let result;
  if (action === 'install') {
    if (args.length !== 2 || args[0] !== '--bin') throw new Error(USAGE);
    result = installKeyd({ bin: args[1], env, home });
    if (!json) write(`agent-bot-keyd ${result.changed ? 'installed' : 'unchanged'}: ${result.label} (${result.bin})\n`);
  } else if (action === 'uninstall' && args.length === 0) {
    result = uninstallKeyd({ env, home });
    if (!json) write(result.unloaded ? 'agent-bot-keyd unloaded; its Keychain items stay\n' : 'agent-bot-keyd was not installed\n');
  } else if (action === 'status' && args.length === 0) {
    result = await keydStatus({ env, home });
    if (!json) {
      write(result.running ? `agent-bot-keyd ${result.version} running; daemon key ${result.pinned ? 'pinned' : 'not pinned'}\n` : 'agent-bot-keyd is not running\n');
      if (result.running && result.versionMatches !== true) write(`this agent-bot is pinned to agent-bot-keyd ${result.expectedVersion}; ${keydVersionAction(result)}\n`);
    }
  } else {
    throw new Error(USAGE);
  }
  if (json) write(`${JSON.stringify(result)}\n`);
  return result;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  keydCommand(process.argv.slice(2)).catch((error) => {
    if (process.argv.includes('--json')) process.stdout.write(`${JSON.stringify({ error: { code: error.code ?? 'keyd-failed', message: error.message } })}\n`);
    process.stderr.write(`agent-bot keyd: ${error.message}\n`);
    process.exitCode = 1;
  });
}
