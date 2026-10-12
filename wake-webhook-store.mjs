// Internal comms-owned webhook persistence; no owner authorization here.
import { randomUUID } from 'node:crypto';
import { chmodSync, closeSync, constants, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { validateAgentId } from './identity-format.mjs';
import { withLock } from './file-lock.mjs';
import { assertColdWakeLock } from './cold-wake-lock.mjs';

export function webhookDir({ env = process.env, home = homedir() } = {}) {
  const base = env.XDG_STATE_HOME ? path.resolve(env.XDG_STATE_HOME) : path.join(home, '.local', 'state');
  return path.join(base, 'agent-bot', 'webhooks');
}

export function webhookFile(agentId, options = {}) {
  return path.join(webhookDir(options), `${validateAgentId(agentId)}.json`);
}

// Checks a webhook before it is stored. Errors name what is wrong, never the
// value: the URL may embed a token.
export function checkWebhook({ url, key }) {
  let parsed;
  try { parsed = new URL(String(url).trim()); } catch { throw new Error('webhook URL is not a valid URL'); }
  if (parsed.protocol !== 'https:') throw new Error('webhook URL must use https');
  if (parsed.username || parsed.password) throw new Error('webhook URL must not carry credentials');
  const secret = String(key ?? '').trim();
  if (!secret) throw new Error('webhook key is empty');
  if (/[\r\n]/.test(secret)) throw new Error('webhook key must be one line');
  return { url: parsed.href, key: secret };
}

// Internal comms storage helpers: callers must hold the common settings
// lock, then this per-soul webhook lock. Nothing awaits within either lock.
function withWebhookLock(agentId, context, operation) {
  assertColdWakeLock(context);
  const file = webhookFile(agentId, context.options);
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  chmodSync(path.dirname(file), 0o700);
  return withLock(`${file}.lock`, 'webhook', () => operation(file), { keepLiveOwners: true });
}
function syncDirectory(directory) {
  if (process.platform === 'win32') return;
  const fd = openSync(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try { fsyncSync(fd); } finally { closeSync(fd); }
}
export function saveWebhookLocked(agentId, webhook, context) {
  const checked = checkWebhook(webhook);
  return withWebhookLock(agentId, context, (file) => {
    const temp = `${file}.${process.pid}.${randomUUID()}.tmp`;
    let published = false;
    try {
      const fd = openSync(temp, 'wx', 0o600);
      try { writeFileSync(fd, `${JSON.stringify({ schemaVersion: 1, ...checked })}\n`); fsyncSync(fd); }
      finally { closeSync(fd); }
      renameSync(temp, file);
      published = true;
      chmodSync(file, 0o600);
      syncDirectory(path.dirname(file));
      syncDirectory(path.dirname(path.dirname(file)));
    } catch {
      const error = new Error(published ? 'webhook publication occurred but durability is uncertain' : 'webhook could not be stored');
      error.code = published ? 'cold-wake-publication-uncertain' : 'cold-wake-storage-failed';
      throw error;
    } finally {
      try { rmSync(temp, { force: true }); }
      catch { throw Object.assign(new Error('webhook temporary file cleanup failed'), { code: published ? 'cold-wake-publication-uncertain' : 'cold-wake-storage-failed' }); }
    }
    return { host: new URL(checked.url).host };
  });
}
export function readWebhookLocked(agentId, context) {
  return withWebhookLock(agentId, context, (file) => {
    try { return checkWebhook(JSON.parse(readFileSync(file, 'utf8'))); }
    catch (error) {
      if (error.code === 'ENOENT') return null;
      throw new Error('webhook settings could not be read');
    }
  });
}
export function removeWebhookLocked(agentId, context) {
  return withWebhookLock(agentId, context, (file) => {
    let removed = false;
    try {
      try { rmSync(file); removed = true; }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
      if (removed) syncDirectory(path.dirname(file));
    } catch {
      const error = new Error(removed ? 'webhook removal occurred but durability is uncertain' : 'webhook could not be removed');
      error.code = removed ? 'cold-wake-publication-uncertain' : 'cold-wake-storage-failed';
      throw error;
    }
  });
}
