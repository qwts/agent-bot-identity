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
import { RESUME_POLICIES } from './wake-resume.mjs';
import { readWebhook, removeWebhook, saveWebhook } from './wake-webhook.mjs';

export function coldWakeFile({ env = process.env, home = homedir() } = {}) {
  const base = env.XDG_STATE_HOME ? path.resolve(env.XDG_STATE_HOME) : path.join(home, '.local', 'state');
  return path.join(base, 'agent-bot', 'cold-wake.json');
}
export function readColdWakeSettings(options = {}) {
  try { const parsed = JSON.parse(readFileSync(coldWakeFile(options), 'utf8')); return parsed?.settings ?? {}; }
  catch (error) { if (error.code === 'ENOENT') return {}; throw new Error('cold wake settings could not be read'); }
}
// A soul's setting is `true` (an ACP turn, #259), `{ lane: 'resume', policy }`
// (its own harness session resumed for one turn, #323), `{ lane: 'webhook' }`
// (its harness's routine called, #334), or off. Anything else, such as a
// resume setting with an unknown policy, is off.
export function wakeSetting(value) {
  if (value === true) return { lane: 'acp' };
  if (value?.lane === 'resume' && RESUME_POLICIES.includes(value.policy)) return { lane: 'resume', policy: value.policy };
  if (value?.lane === 'webhook') return { lane: 'webhook' };
  return null;
}
function describeSetting(value) {
  const setting = wakeSetting(value);
  if (setting === null) return 'off';
  if (setting.lane === 'acp') return 'on';
  return setting.lane === 'resume' ? `resume ${setting.policy}` : 'webhook';
}
export function setColdWake(agentId, enabled, { env = process.env, home = homedir(), now = () => new Date() } = {}) {
  const id = validateAgentId(agentId);
  const lane = typeof enabled === 'boolean' ? null : wakeSetting(enabled)?.lane;
  if (typeof enabled !== 'boolean' && lane !== 'resume' && lane !== 'webhook') throw new Error('cold wake setting must be on, off, resume with a policy, or webhook');
  if (lane === 'resume') enabled = { lane: 'resume', policy: enabled.policy };
  if (lane === 'webhook') enabled = { lane: 'webhook' };
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
  // A webhook is a secret: a soul that no longer wakes by webhook keeps none.
  if (lane !== 'webhook') removeWebhook(id, { env, home });
  appendAuditReceipt({ event: 'cold-wake-setting', agentId: id, decision: describeSetting(enabled).replace(' ', ':') }, { env, home, now });
  return enabled;
}

// Reads a secret from a file, or from stdin for `-`. The value is never
// echoed.
function readSecretFile(file) {
  return readFileSync(file === '-' ? 0 : file, 'utf8').trim();
}
async function main() {
  const usage = `usage: agent-bot soul cold-wake <agentId> [on|off|show|resume ${RESUME_POLICIES.join('|')}|webhook --url-file PATH --key-file PATH|-]`;
  const argv = process.argv.slice(2);
  if (argv[1] === 'webhook') {
    const [id, , ...flags] = argv;
    const files = {};
    for (let i = 0; i < flags.length; i += 2) {
      if (!['--url-file', '--key-file'].includes(flags[i]) || !flags[i + 1] || files[flags[i]]) throw new Error(usage);
      files[flags[i]] = flags[i + 1];
    }
    if (!files['--url-file'] || !files['--key-file'] || (files['--url-file'] === '-' && files['--key-file'] === '-')) throw new Error(usage);
    if (resolveAgentSlug({ detect: false }) !== null) throw new Error('cold wake settings are owner only');
    const { host } = saveWebhook(validateAgentId(id), { url: readSecretFile(files['--url-file']), key: readSecretFile(files['--key-file']) });
    setColdWake(id, { lane: 'webhook' });
    process.stdout.write(`${id} cold wake webhook ${host}\n`);
    return;
  }
  const [id, value, policy, ...rest] = argv;
  if (!id || rest.length || (value !== undefined && !['on', 'off', 'show', 'resume'].includes(value))) throw new Error(usage);
  if ((value === 'resume') !== (policy !== undefined) || (policy !== undefined && !RESUME_POLICIES.includes(policy))) throw new Error(usage);
  if (resolveAgentSlug({ detect: false }) !== null) throw new Error('cold wake settings are owner only');
  if (value === undefined || value === 'show') {
    const setting = describeSetting(readColdWakeSettings()[validateAgentId(id)]);
    const webhook = setting === 'webhook' ? readWebhook(id) : null;
    process.stdout.write(`${setting}${webhook ? ` ${new URL(webhook.url).host}` : setting === 'webhook' ? ' (no webhook stored)' : ''}\n`);
  }
  else if (value === 'resume') { setColdWake(id, { lane: 'resume', policy }); process.stdout.write(`${id} cold wake resume ${policy}\n`); }
  else { setColdWake(id, value === 'on'); process.stdout.write(`${id} cold wake ${value}\n`); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch((error) => { process.stderr.write(`agent-bot soul cold-wake: ${error.message}\n`); process.exit(1); });
