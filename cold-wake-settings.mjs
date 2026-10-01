#!/usr/bin/env node
import { randomUUID } from 'node:crypto';
import { chmodSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';
import { appendAuditReceipt } from './agent-principals.mjs';
import { validateAgentId, withLock } from './agent-identity.mjs';
import { resolveAgentSlug } from './resolve-agent.mjs';

export function coldWakeFile({ env = process.env, home = homedir() } = {}) {
  const base = env.XDG_STATE_HOME ? path.resolve(env.XDG_STATE_HOME) : path.join(home, '.local', 'state');
  return path.join(base, 'agent-bot', 'cold-wake.json');
}
export function readColdWakeSettings(options = {}) {
  try { const parsed = JSON.parse(readFileSync(coldWakeFile(options), 'utf8')); return parsed?.settings ?? {}; }
  catch (error) { if (error.code === 'ENOENT') return {}; throw new Error('cold wake settings could not be read'); }
}
export function setColdWake(agentId, enabled, { env = process.env, home = homedir(), now = () => new Date() } = {}) {
  const id = validateAgentId(agentId);
  if (typeof enabled !== 'boolean') throw new Error('cold wake setting must be on or off');
  const file = coldWakeFile({ env, home });
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  // Read, change, and replace under one lock, so two owner commands for
  // different souls cannot each drop the other's change.
  withLock(`${file}.lock`, 'cold wake settings', () => {
    const settings = readColdWakeSettings({ env, home });
    settings[id] = enabled;
    const temp = `${file}.${process.pid}.${randomUUID()}.tmp`;
    try { writeFileSync(temp, `${JSON.stringify({ schemaVersion: 1, settings }, null, 2)}\n`, { flag: 'wx', mode: 0o600 }); renameSync(temp, file); chmodSync(file, 0o600); }
    finally { rmSync(temp, { force: true }); }
  });
  appendAuditReceipt({ event: 'cold-wake-setting', agentId: id, decision: enabled ? 'on' : 'off' }, { env, home, now });
  return enabled;
}
async function main() {
  const [id, value, ...rest] = process.argv.slice(2);
  if (!id || rest.length || (value !== undefined && !['on', 'off', 'show'].includes(value))) throw new Error('usage: agent-bot soul cold-wake <agentId> [on|off|show]');
  if (resolveAgentSlug({ detect: false }) !== null) throw new Error('cold wake settings are owner only');
  if (value === undefined || value === 'show') process.stdout.write(`${readColdWakeSettings()[validateAgentId(id)] === true ? 'on' : 'off'}\n`);
  else { setColdWake(id, value === 'on'); process.stdout.write(`${id} cold wake ${value}\n`); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch((error) => { process.stderr.write(`agent-bot soul cold-wake: ${error.message}\n`); process.exit(1); });
