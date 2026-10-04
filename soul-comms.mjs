#!/usr/bin/env node

// `agent-bot soul comms <soul> [show|on|off] [--json] [--principal-stdin]`
// (#381): read or set a soul's agent-comms setting. agent-comms is part of
// every soul; `off` withholds the teammate tools (fleet, send_message) from
// its daemon turns. The setting lives in the soul's soul.json (an edit of its
// revision) and in the census row its turns read. It can change only while
// the soul is not running, and only by the owner.
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { homedir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { stateDirectory, validateAgentId } from './agent-identity.mjs';
import { populationFile, setSoulComms, showSoul, showSoulByName, soulDirectory, soulShownName } from './agent-population.mjs';
import { daemonStatus } from './agent-daemon.mjs';
import { assertOwnerAction } from './owner-gate.mjs';
import { soulCommsSetting, writeSoulComms } from './soul-package.mjs';
import { revisionHistory, editSoulRevision } from './soul-revisions.mjs';

const USAGE = 'usage: agent-bot soul comms <agentId|name> [show|on|off] [--json] [--principal-stdin]';

function resolveSoul(target, file) {
  try { return showSoul(validateAgentId(target), { file }); }
  catch (error) {
    if (/^agent_/.test(target)) throw error;
    return showSoulByName(target, { file });
  }
}

// A soul is running while the daemon has a turn in flight for it or its
// harness holds a warm connection. No daemon means nothing is running.
export async function soulRunning(agentId, { status = daemonStatus, env, home } = {}) {
  const daemon = await status({ env, home });
  if (!daemon?.running) return false;
  return (daemon.warmPool?.[agentId] ?? 0) > 0 || (daemon.busy ?? []).includes(agentId);
}

function describe(soul, { file, env, home, running }) {
  let directory = null;
  try { directory = soulDirectory(soul.id, { file, env, home }); } catch { /* no soul directory */ }
  const setting = directory ? soulCommsSetting(directory) : null;
  return { agentId: soul.id, name: soulShownName(soul, directory), handle: soul.name, managed: soul.managed === true,
    comms: setting ?? soul.comms !== false, running, directory };
}

export async function soulCommsCommand(argv, {
  env = process.env,
  home = homedir(),
  cwd = process.cwd(),
  readStdin = () => readFileSync(0, 'utf8'),
  write = (text) => process.stdout.write(text),
  gate = (action, { principal }) => assertOwnerAction(action, { principal, env, cwd }),
  status = daemonStatus,
  revisions = { history: revisionHistory, edit: editSoulRevision },
} = {}) {
  const json = argv.includes('--json');
  const presented = argv.includes('--principal-stdin');
  const args = argv.filter((arg) => arg !== '--json' && arg !== '--principal-stdin');
  const [target, action = 'show', ...rest] = args;
  if (!target || rest.length || !['show', 'on', 'off'].includes(action)) throw new Error(USAGE);
  if (action === 'show' && presented) throw new Error(USAGE);
  // The principal is read once, before anything else could consume stdin.
  let principal = null;
  if (presented) {
    try { principal = JSON.parse(readStdin()); }
    catch { throw new Error('--principal-stdin needs the principal credential as JSON on stdin'); }
  }
  const file = populationFile({ env, home });
  const soul = resolveSoul(target, file);
  const running = await soulRunning(soul.id, { status, env, home });
  const before = describe(soul, { file, env, home, running });
  const print = (result) => {
    const { directory, ...shown } = result;
    write(json ? `${JSON.stringify(shown)}\n`
      : `${shown.agentId} ${shown.managed ? 'managed' : 'unmanaged'} comms ${shown.comms ? 'on' : 'off'}${shown.running ? ' (running)' : ''}\n`);
    return shown;
  };
  if (action === 'show') return print(before);

  const comms = action === 'on';
  const refuseRunning = () => Object.assign(new Error(`${soul.id} is running; stop it before changing its comms setting (the setting is fixed while a soul runs)`),
    { code: 'soul-running' });
  if (running) throw refuseRunning();
  const authorization = await gate(`soul comms ${soul.id} ${action}`, { principal });
  if (before.comms === comms) return print(before);
  if (!before.directory) throw new Error(`${soul.id} has no soul directory with a soul.json to change`);
  // The owner may take a while to approve; the soul may have started since.
  // This narrows, but does not close, the window: a turn that starts after
  // this check reads the census at its own start.
  if (await soulRunning(soul.id, { status, env, home })) throw refuseRunning();
  const previous = writeSoulComms(before.directory, comms);
  const census = soul.comms !== false;
  let censusWritten = false;
  try {
    setSoulComms(soul.id, comms, { file });
    censusWritten = true;
    // A soul with a revision chain records the change as an owner edit.
    // History cannot be unwritten, so it is appended last.
    const stateDir = stateDirectory({ env, home });
    if (previous !== null && revisions.history(soul.id, { stateDir }).length) {
      await revisions.edit(soul.id, before.directory, { reason: `comms ${action}`, stateDir,
        ...(authorization?.method ? { authorization } : {}) });
    }
  } catch (error) {
    if (censusWritten) { try { setSoulComms(soul.id, census, { file }); } catch { /* reported by the original error */ } }
    if (previous !== null) writeFileSync(path.join(before.directory, 'soul.json'), previous);
    throw error;
  }
  return print({ ...before, comms });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  soulCommsCommand(process.argv.slice(2)).catch((error) => {
    // --json callers get a stable code (`soul-running` while the soul runs).
    if (process.argv.includes('--json')) {
      process.stdout.write(`${JSON.stringify({ error: { code: error.code ?? 'soul-comms-failed', message: error.message } })}\n`);
    }
    process.stderr.write(`agent-bot soul comms: ${error.message}\n`);
    process.exitCode = 1;
  });
}
