// Host-local POSIX journal adapter for dream scheduling. Hosts supply a private,
// already-created canonical directory; this module activates no scheduler.
import { createHash, randomUUID } from 'node:crypto';
import { closeSync, constants, fstatSync, fsyncSync, linkSync, lstatSync, openSync,
  opendirSync, readSync, realpathSync, unlinkSync, writeSync } from 'node:fs';
import path from 'node:path';
import { validateDreamEvents, validateDreamState } from './skill-dream-scheduler.mjs';

export const DREAM_STORE_LIMITS = Object.freeze({ transactions: 100_000, recordBytes: 8 * 1024 * 1024, page: 16, temporaryFiles: 1024 });
const RECORD = /^[0-9]{16}\.json$/;
const TEMP = /^\.[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}\.tmp$/;
const HASH = /^[a-f0-9]{64}$/;
const fail = (code, message) => { throw Object.assign(new Error(message), { code }); };
const invalid = () => fail('dream-journal-invalid', 'dream journal is invalid; dispatch is refused');
const filename = revision => `${String(revision).padStart(16, '0')}.json`;
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');

function validateRecord(record, revision) {
  if (!record || typeof record !== 'object' || Array.isArray(record)
    || Object.keys(record).length !== 5 || !['schemaVersion', 'previousDigest', 'state', 'events', 'digest'].every(key => Object.hasOwn(record, key))
    || record.schemaVersion !== 1 || record.state?.revision !== revision
    || !(revision === 1 ? record.previousDigest === null : HASH.test(record.previousDigest)) || !HASH.test(record.digest)) invalid();
  validateDreamState(record.state);
  validateDreamEvents(record.events);
  const { schemaVersion, previousDigest, state, events } = record;
  if (digest({ schemaVersion, previousDigest, state, events }) !== record.digest) invalid();
  return record;
}

/**
 * Each numbered immutable record is BOTH the complete state and its history
 * events. A no-clobber hard link to the next revision is the compare-and-swap:
 * racing writers cannot overwrite the same revision. No head pointer or stale
 * lock is needed. File fsync precedes publish; directory fsync precedes success.
 *
 * `checkpoint` is a synchronous test fault-injection port. It must be omitted
 * by production hosts. Throwing at an uncertain point never reports success.
 * Tests cover process interruption, not physical power loss. In particular,
 * Node fsync is not macOS F_FULLFSYNC; no sudden-power-loss guarantee is made.
 */
export function createDreamFileStore({ directory, capacity = DREAM_STORE_LIMITS.transactions, checkpoint = () => {} } = {}) {
  if (process.platform === 'win32') fail('dream-store-unsupported', 'dream journal requires POSIX hard-link and directory-fsync semantics');
  if (typeof directory !== 'string' || !path.isAbsolute(directory) || path.resolve(directory) !== directory
    || !Number.isSafeInteger(capacity) || capacity < 1 || capacity > DREAM_STORE_LIMITS.transactions || typeof checkpoint !== 'function') {
    fail('dream-store-configuration', 'dream journal requires a canonical private directory and bounded capacity');
  }
  let head = null, temporaryFiles = 0;
  function checkRoot() {
    const info = lstatSync(directory);
    if (!info.isDirectory() || info.isSymbolicLink() || realpathSync(directory) !== directory
      || info.uid !== process.getuid() || (info.mode & 0o077) !== 0) {
      fail('dream-store-directory', 'dream journal directory must be canonical, private and owned by this account');
    }
  }
  function syncDirectory() {
    const fd = openSync(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    try { fsyncSync(fd); } finally { closeSync(fd); }
  }
  function inventory() {
    checkRoot();
    let count = 0, highest = 0, temporary = 0;
    const dir = opendirSync(directory);
    try {
      let entry;
      while ((entry = dir.readSync())) {
        if (TEMP.test(entry.name)) {
          if (!entry.isFile() || ++temporary > DREAM_STORE_LIMITS.temporaryFiles) invalid();
          continue; // incomplete, unpublished attempts never affect state
        }
        if (!RECORD.test(entry.name) || !entry.isFile()) invalid();
        const revision = Number(entry.name.slice(0, 16));
        if (!Number.isSafeInteger(revision) || revision < 1 || ++count > capacity) invalid();
        highest = Math.max(highest, revision);
      }
    } finally { dir.closeSync(); }
    // Distinct positive numbered filenames must form the complete prefix.
    if (highest !== count) invalid();
    return { revision: highest, temporaryFiles: temporary };
  }
  function record(revision) {
    const fd = openSync(path.join(directory, filename(revision)), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const info = fstatSync(fd);
      if (!info.isFile() || info.uid !== process.getuid() || (info.mode & 0o077) !== 0
        || info.size < 1 || info.size > DREAM_STORE_LIMITS.recordBytes) invalid();
      const bytes = Buffer.alloc(info.size + 1);
      let size = 0, count;
      while (size < bytes.length && (count = readSync(fd, bytes, size, bytes.length - size, null))) size += count;
      if (size !== info.size) invalid();
      let value;
      try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, size))); }
      catch { invalid(); }
      return validateRecord(value, revision);
    } finally { closeSync(fd); }
  }
  function exists(revision) {
    try { lstatSync(path.join(directory, filename(revision))); return true; }
    catch (error) { if (error.code === 'ENOENT') return false; throw error; }
  }
  function latest() {
    if (head === null) {
      const found = inventory();
      head = found.revision; temporaryFiles = found.temporaryFiles;
    } else {
      checkRoot();
      const next = exists(head + 1), afterNext = exists(head + 2);
      if (afterNext && !next) invalid();
      if (next) fail('dream-journal-foreign-writer', 'another writer advanced the dream journal; reopen through daemon recovery');
    }
    if (!head) return { revision: 0, temporaryFiles, current: null };
    const current = record(head);
    if (head > 1 && current.previousDigest !== record(head - 1).digest) invalid();
    // A previous process may have died after publishing but before syncing the
    // directory. Establish durability of the recovered complete record before
    // any scheduler can use it as dispatch authority.
    syncDirectory();
    return { revision: head, temporaryFiles, current };
  }
  function commit({ expectedRevision, state, events }) {
    validateDreamState(state); validateDreamEvents(events);
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0 || state.revision !== expectedRevision + 1) invalid();
    let before;
    try { before = latest(); }
    catch (error) { if (error.code === 'dream-journal-foreign-writer') return false; throw error; }
    if (before.revision !== expectedRevision) return false;
    if (before.revision >= capacity) fail('dream-journal-full', 'dream journal capacity reached; no records were pruned and no dispatch is allowed');
    const payload = { schemaVersion: 1, previousDigest: before.current?.digest ?? null, state, events };
    const bytes = Buffer.from(`${JSON.stringify({ ...payload, digest: digest(payload) })}\n`);
    if (bytes.length > DREAM_STORE_LIMITS.recordBytes) fail('dream-journal-limit', 'dream transaction exceeds the journal record limit');
    const temp = path.join(directory, `.${randomUUID()}.tmp`);
    let fd;
    try {
      checkpoint('before-create');
      fd = openSync(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      checkpoint('after-create');
      // Two explicit chunks let conformance tests kill the writer mid-record.
      const middle = Math.floor(bytes.length / 2);
      for (const [from, to] of [[0, middle], [middle, bytes.length]]) {
        let offset = from;
        while (offset < to) {
          const written = writeSync(fd, bytes, offset, to - offset);
          if (!written) fail('dream-journal-write', 'dream journal write made no progress');
          offset += written;
        }
        checkpoint(to === middle ? 'after-partial-write' : 'after-write');
      }
      fsyncSync(fd); checkpoint('after-file-fsync');
      closeSync(fd); fd = undefined;
      try { linkSync(temp, path.join(directory, filename(state.revision))); }
      catch (error) { if (error.code === 'EEXIST') return false; throw error; }
      checkpoint('after-publish');
      syncDirectory(); checkpoint('after-directory-fsync');
      head = state.revision;
      return true;
    } finally {
      if (fd !== undefined) closeSync(fd);
      try { unlinkSync(temp); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
  }
  function history({ afterRevision = 0, limit = DREAM_STORE_LIMITS.page } = {}) {
    if (!Number.isSafeInteger(afterRevision) || afterRevision < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > DREAM_STORE_LIMITS.page) {
      fail('dream-history-query', 'dream history requires a nonnegative revision and a bounded page size');
    }
    const end = latest().revision, records = [];
    let previous = afterRevision > 0 && afterRevision <= end ? record(afterRevision).digest : null;
    for (let revision = afterRevision + 1; revision <= end && records.length < limit; revision++) {
      const value = record(revision);
      if (value.previousDigest !== previous) invalid();
      records.push({ revision, events: value.events }); previous = value.digest;
    }
    const nextRevision = records.at(-1)?.revision ?? afterRevision;
    return { records, nextRevision, remaining: Math.max(0, end - nextRevision) };
  }
  return {
    read: () => latest().current?.state ?? null,
    commit, history,
    status() {
      const found = latest();
      const audit = inventory();
      if (audit.revision !== found.revision) fail('dream-journal-foreign-writer', 'dream journal changed during status inspection');
      return { revision: found.revision, transactions: found.revision, capacity, full: found.revision >= capacity,
        temporaryFiles: audit.temporaryFiles, automaticPruning: false, maxRecordBytes: DREAM_STORE_LIMITS.recordBytes };
    },
  };
}
