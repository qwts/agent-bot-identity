#!/usr/bin/env node
import { randomUUID } from 'node:crypto';
import { chmodSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';
import { appendAuditReceipt } from './agent-principals.mjs';
import { validateAgentId, withLock } from './agent-identity.mjs';
import { ownerGate } from './cold-wake-settings.mjs';

export const SOUL_MODES = Object.freeze(['safe', 'autopilot']);

export function soulModeFile({ env = process.env, home = homedir() } = {}) {
  const base = env.XDG_STATE_HOME ? path.resolve(env.XDG_STATE_HOME) : path.join(home, '.local', 'state');
  return path.join(base, 'agent-bot', 'soul-modes.json');
}

export function readSoulModes(options = {}) {
  try {
    const settings = JSON.parse(readFileSync(soulModeFile(options), 'utf8'))?.settings ?? {};
    if (typeof settings !== 'object' || Array.isArray(settings)) throw new Error('invalid settings');
    for (const [id, mode] of Object.entries(settings)) {
      validateAgentId(id);
      if (!SOUL_MODES.includes(mode)) throw new Error('invalid mode');
    }
    return settings;
  } catch (error) {
    if (error.code === 'ENOENT') return {};
    throw new Error('soul mode settings could not be read');
  }
}

export function soulMode(agentId, options = {}) {
  return readSoulModes(options)[validateAgentId(agentId)] ?? 'safe';
}

export function setSoulMode(agentId, mode, { env = process.env, home = homedir(), now = () => new Date() } = {}) {
  const id = validateAgentId(agentId);
  if (!SOUL_MODES.includes(mode)) throw new Error(`soul mode must be one of: ${SOUL_MODES.join(', ')}`);
  const file = soulModeFile({ env, home });
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  // Keep concurrent changes to different souls under the same lock.
  withLock(`${file}.lock`, 'soul mode settings', () => {
    const settings = readSoulModes({ env, home });
    settings[id] = mode;
    const temp = `${file}.${process.pid}.${randomUUID()}.tmp`;
    try { writeFileSync(temp, `${JSON.stringify({ schemaVersion: 1, settings }, null, 2)}\n`, { flag: 'wx', mode: 0o600 }); renameSync(temp, file); chmodSync(file, 0o600); }
    finally { rmSync(temp, { force: true }); }
  });
  appendAuditReceipt({ event: 'soul-mode', agentId: id, operation: 'set', decision: mode }, { env, home, now });
  return mode;
}

export async function soulModeCommand(argv, {
  gate = ownerGate,
  readStdin = () => readFileSync(0, 'utf8'),
  write = (text) => process.stdout.write(text),
  env = process.env,
  home = homedir(),
  cwd = process.cwd(),
  now = () => new Date(),
} = {}) {
  const usage = 'usage: agent-bot soul mode <agentId|name> [show|safe|autopilot] [--json] [--principal-stdin]';
  const json = argv.includes('--json');
  const presented = argv.includes('--principal-stdin');
  const [target, action = 'show', ...rest] = argv.filter((arg) => arg !== '--json' && arg !== '--principal-stdin');
  if (!target || rest.length || !['show', ...SOUL_MODES].includes(action)
    || argv.filter((arg) => arg === '--json').length > 1
    || argv.filter((arg) => arg === '--principal-stdin').length > 1
    || (action === 'show' && presented)) throw new Error(usage);
  let principal = null;
  if (presented) {
    try { principal = JSON.parse(readStdin()); }
    catch { throw new Error('--principal-stdin needs the principal credential as JSON on stdin'); }
  }
  // Load census helpers only for the CLI; population reads modes too.
  const { populationFile, showSoul, showSoulByName } = await import('./agent-population.mjs');
  const file = populationFile({ env, home });
  let soul;
  try { soul = showSoul(validateAgentId(target), { file }); }
  catch (error) {
    if (/^agent_/.test(target)) throw error;
    soul = showSoulByName(target, { file });
  }
  let authorization = null;
  if (action !== 'show') {
    // The owner gate expands the ID to the census name in its presence prompt.
    authorization = await gate(`switch ${soul.id} to ${action === 'autopilot' ? 'Auto-Pilot' : 'Safe'}`, { principal, env, cwd });
    setSoulMode(soul.id, action, { env, home, now });
  }
  const mode = soulMode(soul.id, { env, home });
  write(json ? `${JSON.stringify({ agentId: soul.id, mode })}\n` : `mode: ${mode}\n`);
  return authorization;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) soulModeCommand(process.argv.slice(2)).catch((error) => {
  if (process.argv.includes('--json')) process.stdout.write(`${JSON.stringify({ error: { code: 'soul-mode-failed', message: error.message } })}\n`);
  else process.stderr.write(`agent-bot soul mode: ${error.message}\n`);
  process.exitCode = 1;
});
