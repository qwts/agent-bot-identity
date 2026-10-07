#!/usr/bin/env node

// `agent-bot soul remove <agentId|name> [--json] [--principal-stdin]`
// (#420): take a soul out of this account. Nothing is deleted. The soul
// stops waking, leaves agent-comms, is retired in its identity record and
// the census (a tombstone; there is no un-retire, #46), and its folder moves
// to `<souls root>/.archive/`. Owner only, and never while the soul runs.
// A retired soul can be removed again, which finishes a cleanup a failed
// launch or an earlier remove left undone (#419).
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { appendAuditReceipt } from './agent-principals.mjs';
import { stateDirectory, validateAgentId } from './agent-identity.mjs';
import { archiveSoulDirs, populationFile, retireIdentityWithPopulation, showSoul, showSoulByName, soulDirectory, soulShownName } from './agent-population.mjs';
import { leaveLaunchedSoul } from './agent-daemon.mjs';
import { readColdWakeSettings, setColdWake, wakeSetting } from './cold-wake-settings.mjs';
import { assertOwnerAction } from './owner-gate.mjs';
import { soulRunning } from './soul-comms.mjs';

const USAGE = 'usage: agent-bot soul remove <agentId|name> [--json] [--principal-stdin]';

function resolveSoul(target, file) {
  try { return showSoul(validateAgentId(target), { file }); }
  catch (error) {
    if (/^agent_/.test(target)) throw error;
    return showSoulByName(target, { file });
  }
}

export async function soulRemoveCommand(argv, {
  env = process.env,
  home = homedir(),
  cwd = process.cwd(),
  now = () => new Date(),
  readStdin = () => readFileSync(0, 'utf8'),
  write = (text) => process.stdout.write(text),
  gate = (action, { principal }) => assertOwnerAction(action, { principal, env, cwd }),
  status = undefined,
  leave = (soul) => leaveLaunchedSoul(soul, { env }),
  archive = (id, options) => archiveSoulDirs(id, options),
} = {}) {
  const json = argv.includes('--json');
  const presented = argv.includes('--principal-stdin');
  const args = argv.filter((arg) => arg !== '--json' && arg !== '--principal-stdin');
  const [target, ...rest] = args;
  if (!target || rest.length) throw new Error(USAGE);
  let principal = null;
  if (presented) {
    try { principal = JSON.parse(readStdin()); }
    catch { throw new Error('--principal-stdin needs the principal credential as JSON on stdin'); }
  }
  const file = populationFile({ env, home });
  const soul = resolveSoul(target, file);
  const running = () => soulRunning(soul.id, { ...(status ? { status } : {}), env, home });
  const refuseRunning = () => Object.assign(new Error(`${soul.id} is running; stop it before removing it`), { code: 'soul-running' });
  if (await running()) throw refuseRunning();
  await gate(`soul remove ${soul.id}`, { principal });
  // The owner may take a while to approve; the soul may have started since.
  if (await running()) throw refuseRunning();

  // Each step is safe to repeat, so a remove that stops part way can be rerun.
  let directory = null;
  try { directory = soulDirectory(soul.id, { file, env, home }); } catch { /* no soul directory */ }
  const result = { agentId: soul.id, name: soulShownName(soul, directory), handle: soul.name, wake: 'off', comms: 'left', retired: true, archived: [] };
  if (wakeSetting(readColdWakeSettings({ env, home })[soul.id]) !== null) setColdWake(soul.id, false, { env, home, now });
  // Leave while the soul is still active: the hub sees it go as itself.
  try { await leave({ agentId: soul.id }); }
  catch (error) { result.comms = `not left: ${error.message}`; }
  if (soul.status !== 'retired') {
    retireIdentityWithPopulation(soul.id, { file, stateDir: stateDirectory({ env, home }), now });
  }
  // The soul is retired by now, so a folder that will not move names the
  // step and what to do: this error is what GeniusBar shows (#531, GeniusBar#196).
  try { result.archived = archive(soul.id, { env, home, now, file }); }
  catch (error) {
    throw Object.assign(new Error(`${soul.id} is retired, but its folder could not be moved into the souls folder's .archive: ${error.message}; `
      + 'close whatever holds the folder open (or move it there by hand), then run soul remove again'), { code: 'soul-archive-failed', cause: error });
  }
  appendAuditReceipt({ event: 'soul-remove', agentId: soul.id, decision: result.comms === 'left' ? 'removed' : 'removed:comms-pending' }, { env, home, now });
  write(json ? `${JSON.stringify(result)}\n`
    : `${soul.id} removed: wake off, ${result.comms === 'left' ? 'left agent-comms' : `agent-comms ${result.comms}`}, retired, `
      + `${result.archived.length ? `folder archived to ${result.archived.map(({ to }) => to).join(', ')}` : 'no folder to archive'}\n`);
  return result;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  soulRemoveCommand(process.argv.slice(2)).catch((error) => {
    if (process.argv.includes('--json')) {
      process.stdout.write(`${JSON.stringify({ error: { code: error.code ?? 'soul-remove-failed', message: error.message } })}\n`);
    }
    process.stderr.write(`agent-bot soul remove: ${error.message}\n`);
    process.exitCode = 1;
  });
}
