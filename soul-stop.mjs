#!/usr/bin/env node

import { homedir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { daemonClient } from './daemon-client.mjs';
import { validateAgentId } from './agent-identity.mjs';
import { populationFile, showSoul, showSoulByName } from './agent-population.mjs';
import { soulMarkers } from './owner-gate.mjs';

export async function soulControlCommand(action, argv, {
  env = process.env, home = homedir(), cwd = process.cwd(),
  client = daemonClient({ env, home, cwd }),
  write = (text) => process.stdout.write(text),
} = {}) {
  const json = argv.includes('--json');
  const [target, ...rest] = argv.filter((arg) => arg !== '--json');
  if (!target || target.startsWith('-') || rest.length) throw new Error(`usage: agent-bot soul ${action} <agentId|name> [--json]`);
  // Same local caller gate as approvals; stopping never prompts for Touch ID.
  const markers = soulMarkers({ env, cwd });
  if (markers.length) throw Object.assign(new Error(`soul ${action} is the owner's; this caller carries a soul marker (${markers.join(', ')})`), { code: 'not-owner' });
  const file = populationFile({ env, home });
  let soul;
  try { soul = showSoul(validateAgentId(target), { file }); }
  catch (error) {
    if (/^agent_/.test(target)) throw error;
    soul = showSoulByName(target, { file });
  }
  const result = await client[`${action}Soul`](soul.id);
  const state = action === 'stop' ? (result.stopped ? 'stopped' : 'idle') : (result.paused ? 'paused' : 'resumed');
  write(json ? `${JSON.stringify(result)}\n` : `${result.agentId} ${state}\n`);
  return result;
}

export const soulStopCommand = (argv, options) => soulControlCommand('stop', argv, options);

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  soulStopCommand(process.argv.slice(2)).catch((error) => {
    if (process.argv.includes('--json')) {
      process.stdout.write(`${JSON.stringify({ error: { code: error.code ?? 'soul-stop-failed', message: error.message } })}\n`);
    }
    process.stderr.write(`agent-bot soul stop: ${error.message}\n`);
    process.exitCode = 1;
  });
}
