// Shared lock/path mechanism only. Reads no setting or credential. The token
// permits lock-held storage helpers only during this synchronous section.
// Internal callbacks must be synchronous. The thenable check diagnoses misuse
// after invocation; it is not a sandbox for arbitrary asynchronous callbacks.
import { closeSync, constants, existsSync, fsyncSync, mkdirSync, openSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { withLock } from './file-lock.mjs';

const held = new WeakSet();
function ensureDirectory(directory) {
  const missing = [];
  for (let entry = directory; !existsSync(entry); entry = path.dirname(entry)) missing.push(entry);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  if (process.platform === 'win32' || !missing.length) return;
  // Persist every newly created directory entry, including an absent state
  // root; flushing only the final file's immediate parent is insufficient.
  for (const entry of [...missing, path.dirname(missing.at(-1))]) {
    const fd = openSync(entry, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    try { fsyncSync(fd); } finally { closeSync(fd); }
  }
}
export function coldWakeFile({ env = process.env, home = homedir() } = {}) {
  const base = env.XDG_STATE_HOME ? path.resolve(env.XDG_STATE_HOME) : path.join(home, '.local', 'state');
  return path.join(base, 'agent-bot', 'cold-wake.json');
}
export function assertColdWakeLock(context) {
  if (!held.has(context)) throw new Error('cold wake storage requires its synchronous lock');
}
export function withColdWakeLock(options, operation) {
  const file = coldWakeFile(options);
  ensureDirectory(path.dirname(file));
  return withLock(`${file}.lock`, 'cold wake settings', () => {
    const context = Object.freeze({ file, options });
    held.add(context);
    try {
      const result = operation(context);
      if (result?.then) throw new Error('cold wake storage operation must be synchronous');
      return result;
    } finally { held.delete(context); }
  }, { keepLiveOwners: true });
}
