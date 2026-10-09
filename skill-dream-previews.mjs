// Host-local store for dream report previews (#603). Preview text is untrusted
// display data kept outside the hash-chained journal, so it can be pruned
// without rewriting history. The journal keeps each preview's digest.
import { randomUUID } from 'node:crypto';
import { closeSync, constants, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, opendirSync,
  readSync, realpathSync, renameSync, unlinkSync, writeSync } from 'node:fs';
import path from 'node:path';
import { isAgentId } from './agent-identity.mjs';
import { DREAM_OUTCOME_LIMITS, dreamPreviewDigest } from './skill-dream-outcomes.mjs';

export const DREAM_PREVIEW_RETAIN = 20;
const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const PREVIEW = /^[0-9]{16}-[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}\.txt$/;
const fail = (code, message) => { throw Object.assign(new Error(message), { code }); };
const owned = info => info.uid === process.getuid() && (info.mode & 0o077) === 0;

/**
 * One private directory per soul holds that soul's latest previews, named by
 * run start time so the newest sort last. Runs of one soul never overlap, so
 * start order is run order. A preview is written before the journal commit
 * that names its digest; a commit that never lands leaves a file the next
 * prune removes in turn. Reads check the digest, so an edited file is refused.
 */
export function createDreamPreviewStore({ directory, retain = DREAM_PREVIEW_RETAIN } = {}) {
  if (process.platform === 'win32') fail('dream-store-unsupported', 'dream previews require POSIX directory semantics');
  if (typeof directory !== 'string' || !path.isAbsolute(directory) || path.resolve(directory) !== directory
    || !Number.isSafeInteger(retain) || retain < 1 || retain > DREAM_PREVIEW_RETAIN) {
    fail('dream-store-configuration', 'dream previews require a canonical private directory and bounded retention');
  }
  const privateDirectory = target => {
    const info = lstatSync(target);
    if (!info.isDirectory() || info.isSymbolicLink() || realpathSync(target) !== target || !owned(info)) {
      fail('dream-store-directory', 'dream preview directory must be canonical, private and owned by this account');
    }
  };
  const syncDirectory = target => {
    const fd = openSync(target, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    try { fsyncSync(fd); } finally { closeSync(fd); }
  };
  const soulDirectory = (agentId, create) => {
    privateDirectory(directory);
    if (!isAgentId(agentId)) fail('dream-preview-invalid', 'dream preview requires a valid soul ID');
    const target = path.join(directory, agentId);
    if (create) {
      try { mkdirSync(target, { mode: 0o700 }); syncDirectory(directory); }
      catch (error) { if (error.code !== 'EEXIST') throw error; }
    } else {
      try { lstatSync(target); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
    }
    privateDirectory(target);
    return target;
  };
  const name = ({ runId, startedAt }) => {
    const at = Date.parse(startedAt);
    if (typeof runId !== 'string' || !UUID.test(runId) || !Number.isSafeInteger(at) || at < 0) fail('dream-preview-invalid', 'dream preview requires a run ID and start time');
    return `${String(at).padStart(16, '0')}-${runId}.txt`;
  };
  function write({ agentId, runId, startedAt, text }) {
    if (typeof text !== 'string' || Buffer.byteLength(text) > DREAM_OUTCOME_LIMITS.textBytes) fail('dream-preview-invalid', 'dream preview text is not bounded');
    const target = soulDirectory(agentId, true), file = path.join(target, name({ runId, startedAt }));
    const temp = path.join(target, `.${randomUUID()}.tmp`), bytes = Buffer.from(text, 'utf8');
    let fd;
    try {
      fd = openSync(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      let offset = 0;
      while (offset < bytes.length) {
        const written = writeSync(fd, bytes, offset, bytes.length - offset);
        if (!written) fail('dream-preview-write', 'dream preview write made no progress');
        offset += written;
      }
      fsyncSync(fd); closeSync(fd); fd = undefined;
      renameSync(temp, file);
      syncDirectory(target);
    } finally {
      if (fd !== undefined) closeSync(fd);
      try { unlinkSync(temp); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    return dreamPreviewDigest(text);
  }
  // `unavailable` covers pruned and never-written previews alike; `invalid`
  // means the stored bytes no longer match the journal's digest.
  function read({ agentId, runId, startedAt, digest }) {
    const target = soulDirectory(agentId, false);
    if (target === null) return { status: 'unavailable', text: null };
    let fd;
    try { fd = openSync(path.join(target, name({ runId, startedAt })), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
    catch (error) {
      if (error.code === 'ENOENT') return { status: 'unavailable', text: null };
      if (error.code === 'ELOOP') return { status: 'invalid', text: null };
      throw error;
    }
    try {
      const info = fstatSync(fd);
      if (!info.isFile() || !owned(info) || info.size > DREAM_OUTCOME_LIMITS.textBytes) return { status: 'invalid', text: null };
      const bytes = Buffer.alloc(info.size + 1);
      let size = 0, count;
      while (size < bytes.length && (count = readSync(fd, bytes, size, bytes.length - size, null))) size += count;
      if (size !== info.size) return { status: 'invalid', text: null };
      let text;
      try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, size)); }
      catch { return { status: 'invalid', text: null }; }
      return dreamPreviewDigest(text) === digest ? { status: 'available', text } : { status: 'invalid', text: null };
    } finally { closeSync(fd); }
  }
  // Keep the newest `retain` previews for one soul. Unrecognised entries are
  // left alone; they are never treated as previews.
  function prune(agentId) {
    const target = soulDirectory(agentId, false);
    if (target === null) return 0;
    const names = [];
    const dir = opendirSync(target);
    try {
      let entry;
      while ((entry = dir.readSync())) if (PREVIEW.test(entry.name) && entry.isFile()) names.push(entry.name);
    } finally { dir.closeSync(); }
    const removed = names.sort().slice(0, Math.max(0, names.length - retain));
    for (const file of removed) unlinkSync(path.join(target, file));
    if (removed.length) syncDirectory(target);
    return removed.length;
  }
  return { write, read, prune, status: () => ({ location: 'outside-journal', retainPerSoul: retain }) };
}
