#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { appendAuditReceipt } from './agent-principals.mjs';
import { validateAgentId } from './agent-identity.mjs';
import { ownerGate } from './cold-wake-settings.mjs';
import { soulMarkers } from './owner-gate.mjs';
import { setSoulComputerUse } from './agent-population.mjs';
import { daemonClient } from './daemon-client.mjs';

export async function soulComputerUseCommand(argv, {
  gate = ownerGate,
  readStdin = () => readFileSync(0, 'utf8'),
  write = (text) => process.stdout.write(text),
  env = process.env,
  home = homedir(),
  cwd = process.cwd(),
  now = () => new Date(),
  client = daemonClient({ env, home, cwd }),
} = {}) {
  const usage = 'usage: agent-bot soul computer-use <agentId|name> [show|on|off] [--json] [--principal-stdin]';
  const json = argv.includes('--json');
  const presented = argv.includes('--principal-stdin');
  const [target, action = 'show', ...rest] = argv.filter((arg) => arg !== '--json' && arg !== '--principal-stdin');
  if (!target || rest.length || !['show', 'on', 'off'].includes(action)
    || argv.filter((arg) => arg === '--json').length > 1
    || argv.filter((arg) => arg === '--principal-stdin').length > 1
    || (action === 'show' && presented)) throw new Error(usage);
  let principal = null;
  if (presented) {
    try { principal = JSON.parse(readStdin()); }
    catch { throw new Error('--principal-stdin needs the principal credential as JSON on stdin'); }
  }
  // Resolve IDs and both census names like soul mode.
  const { populationFile, showSoul, showSoulByName } = await import('./agent-population.mjs');
  const file = populationFile({ env, home });
  let soul;
  try { soul = showSoul(validateAgentId(target), { file }); }
  catch (error) {
    if (/^agent_/.test(target)) throw error;
    soul = showSoulByName(target, { file });
  }
  let result = { agentId: soul.id, computerUse: soul.computerUse };
  if (action !== 'show') {
    const description = `switch ${soul.id} computer use ${action}`;
    // The daemon cannot inspect the calling process's soul markers.
    const markers = soulMarkers({ env, cwd, detect: false });
    if (markers.length) throw new Error(`${description} is owner only; this caller has a soul's ${markers.join(', ')}`);
    if (await client.available()) {
      // Presence/principal verification happens in the daemon; never fall back
      // to a local write after a refused or failed daemon request.
      result = await client.setComputerUse(soul.id, action === 'on', { principal });
    } else {
      await gate(description, { principal, env, cwd });
      const updated = setSoulComputerUse(soul.id, action === 'on', { file });
      appendAuditReceipt({ event: 'computer-use', agentId: soul.id, operation: 'set', decision: action }, { env, home, now });
      result = { agentId: soul.id, computerUse: updated.computerUse };
    }
  }
  write(json ? `${JSON.stringify(result)}\n` : `computer use: ${result.computerUse ? 'on' : 'off'}${result.stopped ? ' (stopped)' : ''}\n`);
  return result;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) soulComputerUseCommand(process.argv.slice(2)).catch((error) => {
  if (process.argv.includes('--json')) process.stdout.write(`${JSON.stringify({ error: { code: 'soul-computer-use-failed', message: error.message } })}\n`);
  else process.stderr.write(`agent-bot soul computer-use: ${error.message}\n`);
  process.exitCode = 1;
});
