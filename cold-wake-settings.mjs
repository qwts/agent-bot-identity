#!/usr/bin/env node
import { randomUUID } from 'node:crypto';
import { chmodSync, closeSync, constants, fsyncSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';
import { appendAuditReceipt, validateAgentId } from './identity-format.mjs';
import { assertColdWakeLock, coldWakeFile, withColdWakeLock } from './cold-wake-lock.mjs';
export { coldWakeFile } from './cold-wake-lock.mjs';
import { loadConfig } from './config.mjs';
import { assertOwnerAction } from './owner-action.mjs';
import { resolveAgentSlug } from './identity-soul.mjs';
import { RESUME_POLICIES } from './wake-resume.mjs';
import { checkWebhook, readWebhookLocked, removeWebhookLocked, saveWebhookLocked } from './wake-webhook-store.mjs';

function readSettingsLocked(context) {
  assertColdWakeLock(context);
  try { const parsed = JSON.parse(readFileSync(context.file, 'utf8')); return parsed?.settings ?? {}; }
  catch (error) { if (error.code === 'ENOENT') return {}; throw new Error('cold wake settings could not be read'); }
}
export function readColdWakeSettings(options = {}) {
  return withColdWakeLock(options, readSettingsLocked);
}
// Existing trusted daemon/owner readers get one selected-soul state before any
// asynchronous work. The secret stays in-process, as with readWebhook before.
export function readColdWakeSnapshot(agentId, options = {}) {
  const id = validateAgentId(agentId);
  return withColdWakeLock(options, (context) => {
    const setting = readSettingsLocked(context)[id];
    const webhook = wakeSetting(setting)?.lane === 'webhook' ? readWebhookLocked(id, context) : null;
    return Object.freeze({ setting, webhook: webhook && Object.freeze(webhook) });
  });
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
export function describeSetting(value) {
  const setting = wakeSetting(value);
  if (setting === null) return 'off';
  if (setting.lane === 'acp') return 'on';
  return setting.lane === 'resume' ? `resume ${setting.policy}` : 'webhook';
}
function syncDirectory(directory) {
  if (process.platform === 'win32') return;
  const fd = openSync(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try { fsyncSync(fd); } finally { closeSync(fd); }
}
function writeSettingsLocked(id, enabled, context) {
  const settings = readSettingsLocked(context);
  settings[id] = enabled;
  const file = context.file;
  const temp = `${file}.${process.pid}.${randomUUID()}.tmp`;
  let published = false;
  try {
    const fd = openSync(temp, 'wx', 0o600);
    try { writeFileSync(fd, `${JSON.stringify({ schemaVersion: 1, settings }, null, 2)}\n`); fsyncSync(fd); }
    finally { closeSync(fd); }
    renameSync(temp, file);
    published = true;
    chmodSync(file, 0o600);
    syncDirectory(path.dirname(file));
    syncDirectory(path.dirname(path.dirname(file)));
  } catch {
    const error = new Error(published ? 'cold wake settings publication occurred but durability is uncertain' : 'cold wake settings could not be stored');
    error.code = published ? 'cold-wake-publication-uncertain' : 'cold-wake-storage-failed';
    throw error;
  } finally {
    try { rmSync(temp, { force: true }); }
    catch { throw Object.assign(new Error('cold wake temporary file cleanup failed'), { code: published ? 'cold-wake-publication-uncertain' : 'cold-wake-storage-failed' }); }
  }
}
function changeColdWake(agentId, enabled, webhook, { env = process.env, home = homedir(), now = () => new Date() } = {}) {
  const id = validateAgentId(agentId);
  const lane = typeof enabled === 'boolean' ? null : wakeSetting(enabled)?.lane;
  if (typeof enabled !== 'boolean' && lane !== 'resume' && lane !== 'webhook') throw new Error('cold wake setting must be on, off, resume with a policy, or webhook');
  if (lane === 'resume') enabled = { lane: 'resume', policy: enabled.policy };
  if (lane === 'webhook') enabled = { lane: 'webhook' };
  const checked = webhook === undefined ? undefined : checkWebhook(webhook);
  const result = withColdWakeLock({ env, home }, (context) => {
    let changed = false;
    try {
      const saved = checked === undefined ? null : saveWebhookLocked(id, checked, context);
      if (saved) changed = true;
      writeSettingsLocked(id, enabled, context);
      changed = true;
      // Secret removal and setting publication share the same lock. This is
      // coherent for readers, not a two-file crash-atomic transaction.
      if (lane !== 'webhook') removeWebhookLocked(id, context);
      return saved;
    } catch (cause) {
      if (!changed && cause.code !== 'cold-wake-publication-uncertain') throw cause;
      const error = new Error('cold wake change failed after partial or uncertain publication; inspect current settings before retry');
      error.code = 'cold-wake-publication-uncertain';
      throw error;
    }
  });
  try { appendAuditReceipt({ event: 'cold-wake-setting', agentId: id, decision: describeSetting(enabled).replace(' ', ':') }, { env, home, now }); }
  catch { throw Object.assign(new Error('cold wake change persisted but its audit receipt failed'), { code: 'cold-wake-audit-failed' }); }
  return { enabled, result };
}
// Local mechanism entries: callers authenticate before entering this synchronous
// core. No callback can substitute for the existing owner gate.
export function setColdWake(agentId, enabled, options = {}) {
  return changeColdWake(agentId, enabled, undefined, options).enabled;
}
export function setColdWakeWebhook(agentId, webhook, options = {}) {
  return changeColdWake(agentId, { lane: 'webhook' }, checkWebhook(webhook), options).result;
}

// Reads a secret from a file, or from stdin for `-`. The value is never
// echoed.
function readSecretFile(file, readStdin) {
  return (file === '-' ? readStdin() : readFileSync(file, 'utf8')).trim();
}

// The owner gate for cold wake changes (#293): any soul marker refuses, then
// the owner proves themselves with a presented principal or the consent
// dialog. Harness detection stays off here, as before: only stated markers
// count.
export const ownerGate = (action, { principal, target, env, cwd }) => assertOwnerAction(action, { principal, target, env, cwd, detect: false });

// `agent-bot soul cold-wake`. Every change (on, off, resume, webhook) passes
// the owner gate; `show` is read-only and only refuses a marked soul. The
// gate, stdin and output are injectable so tests need no dialog or broker.
export async function coldWakeCommand(argv, {
  gate = ownerGate,
  readStdin = () => readFileSync(0, 'utf8'),
  write = (text) => process.stdout.write(text),
  env = process.env,
  home = homedir(),
  cwd = process.cwd(),
} = {}) {
  const usage = `usage: agent-bot soul cold-wake <agentId> [on|off|show|resume ${RESUME_POLICIES.join('|')}|webhook --url-file PATH --key-file PATH|-] [--principal-stdin] [--json (show only)]`;
  const json = argv.includes('--json');
  if (argv.filter((arg) => arg === '--json').length > 1) throw new Error(usage);
  argv = argv.filter((arg) => arg !== '--json');
  if (json && argv[1] !== undefined && argv[1] !== 'show') throw new Error(usage);
  const presented = argv.includes('--principal-stdin');
  argv = argv.filter((arg) => arg !== '--principal-stdin');
  // The principal is read once, before anything else could consume stdin.
  const principal = () => {
    if (!presented) return null;
    try { return JSON.parse(readStdin()); }
    catch { throw new Error('--principal-stdin needs the principal credential as JSON on stdin'); }
  };
  if (argv[1] === 'webhook') {
    const [id, , ...flags] = argv;
    const files = {};
    for (let i = 0; i < flags.length; i += 2) {
      if (!['--url-file', '--key-file'].includes(flags[i]) || !flags[i + 1] || files[flags[i]]) throw new Error(usage);
      files[flags[i]] = flags[i + 1];
    }
    if (!files['--url-file'] || !files['--key-file'] || (files['--url-file'] === '-' && files['--key-file'] === '-')) throw new Error(usage);
    // Stdin carries one thing: the principal, or a webhook secret.
    if (presented && (files['--url-file'] === '-' || files['--key-file'] === '-')) {
      throw new Error('--principal-stdin uses stdin; pass the webhook URL and key as files, not -');
    }
    validateAgentId(id);
    const authorization = await gate(`soul cold-wake ${id} webhook`, { principal: principal(), target: Object.freeze({ agentId: id }), env, cwd });
    const { host } = setColdWakeWebhook(id, { url: readSecretFile(files['--url-file'], readStdin), key: readSecretFile(files['--key-file'], readStdin) }, { env, home });
    write(`${id} cold wake webhook ${host}\n`);
    return authorization;
  }
  const [id, value, policy, ...rest] = argv;
  if (!id || rest.length || (value !== undefined && !['on', 'off', 'show', 'resume'].includes(value))) throw new Error(usage);
  if ((value === 'resume') !== (policy !== undefined) || (policy !== undefined && !RESUME_POLICIES.includes(policy))) throw new Error(usage);
  validateAgentId(id);
  if (value === undefined || value === 'show') {
    if (presented) throw new Error(usage);
    if (resolveAgentSlug({ env, cwd, config: loadConfig({ env, home }), detect: false }) !== null) throw new Error('cold wake settings are owner only');
    // JSON show has always been setting-only: do not read a secret for it.
    const { setting: value, webhook } = json
      ? { setting: readColdWakeSettings({ env, home })[id], webhook: null }
      : readColdWakeSnapshot(id, { env, home });
    const setting = describeSetting(value);
    if (json) {
      const wake = wakeSetting(value);
      write(`${JSON.stringify({ agentId: id, setting: setting.split(' ')[0], policy: wake?.policy ?? null, lane: wake?.lane ?? null })}\n`);
      return null;
    }
    write(`${setting}${webhook ? ` ${new URL(webhook.url).host}` : setting === 'webhook' ? ' (no webhook stored)' : ''}\n`);
    return null;
  }
  const change = value === 'resume' ? `resume ${policy}` : value;
  const authorization = await gate(`soul cold-wake ${id} ${change}`, { principal: principal(), target: Object.freeze({ agentId: id }), env, cwd });
  setColdWake(id, value === 'resume' ? { lane: 'resume', policy } : value === 'on', { env, home });
  write(`${id} cold wake ${change}\n`);
  return authorization;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) coldWakeCommand(process.argv.slice(2)).catch((error) => {
  if (process.argv.includes('--json')) process.stdout.write(`${JSON.stringify({ error: { code: 'cold-wake-failed', message: error.message } })}\n`);
  else process.stderr.write(`agent-bot soul cold-wake: ${error.message}\n`);
  process.exitCode = 1;
});
