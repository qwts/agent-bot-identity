// Read-only maintenance input capture. The host supplies the registered,
// canonical soul directory; no model-provided locator chooses another root.
import { createHash } from 'node:crypto';
import { closeSync, constants, fstatSync, lstatSync, opendirSync, openSync, readSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { computePackageRevisionFromEntries, readSoulPackageEntries } from './soul-package.mjs';
import { kindOf } from './soul-profile.mjs';
import { toolHomePath } from './soul-tool-homes.mjs';

export const DREAM_INPUT_LIMITS = Object.freeze({ entries: 100, bytes: 1024 * 1024, excerptBytes: 64 * 1024 });
export const DREAM_PACKAGE_LIMITS = Object.freeze({ maxEntries: 4096, maxBytes: 16 * 1024 * 1024, maxFileBytes: 1024 * 1024, maxDepth: 32 });
export const DREAM_CONVERSATION_LIMITS = Object.freeze({ excerptBytes: 64 * 1024, entries: 4096 });
// Conversation coverage from input format 2: `supported` delivered an excerpt,
// `unsupported` has no reader for this soul (no recorded session, a session in
// the host's store, or a harness without a reader), `unavailable` names a
// recorded soul-store session that could not be read safely.
const CONVERSATION_COVERAGE = ['supported', 'unsupported', 'unavailable'];
const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const fail = (code, message) => { throw Object.assign(new Error(message), { code }); };
const digest = bytes => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
const eligible = entry => entry.mode !== '040000' && (['AGENTS.md', 'soul.md', 'SOUL.md'].includes(entry.path)
  || entry.path.startsWith('skills/') && kindOf(entry.path) === 'skill');

// Durable preparation metadata contains identifiers and sizes, never excerpts.
// It establishes what was captured, not that the harness received or reviewed it.
export function validateDreamInputMetadata(value) {
  const invalid = () => fail('dream-input-metadata-invalid', 'Invalid bounded maintenance input metadata.');
  const keys = (object, names) => {
    if (!object || typeof object !== 'object' || Array.isArray(object) || Object.keys(object).length !== names.length
      || names.some(name => !Object.hasOwn(object, name))) invalid();
  };
  const hash = value => typeof value === 'string' && value.length === 71 && /^sha256:[a-f0-9]{64}$/.test(value);
  const count = (value, max) => Number.isSafeInteger(value) && value >= 0 && value <= max;
  const sourcePath = value => typeof value === 'string' && value.length <= 4096 && !!kindOf(value)
    && eligible({ path: value });
  keys(value, ['schemaVersion', 'revision', 'sources', 'coverage', 'nextCursor', ...(value?.schemaVersion >= 2 ? ['conversation'] : []),
    ...(value?.schemaVersion === 3 ? ['memory'] : [])]);
  if (![1, 2, 3].includes(value.schemaVersion) || !hash(value.revision) || !Array.isArray(value.sources)
    || value.sources.length > DREAM_INPUT_LIMITS.entries) invalid();
  const paths = new Set();
  let suppliedBytes = 0;
  for (const source of value.sources) {
    keys(source, ['path', 'kind', 'digest', 'size', 'excerptBytes', 'truncated']);
    if (!sourcePath(source.path) || paths.has(source.path) || source.kind !== kindOf(source.path) || !hash(source.digest)
      || !count(source.size, DREAM_PACKAGE_LIMITS.maxFileBytes) || !count(source.excerptBytes, DREAM_INPUT_LIMITS.excerptBytes)
      || source.excerptBytes > source.size || source.truncated !== (source.excerptBytes < source.size)) invalid();
    paths.add(source.path); suppliedBytes += source.excerptBytes;
  }
  keys(value.coverage, ['definition', 'memory', 'conversations', 'eligible', 'selected', 'suppliedBytes', 'skippedBinary', 'remaining']);
  const coverage = value.coverage;
  // Format 1 never read conversations; formats 2 and 3 name the one delivered.
  const conversation = value.schemaVersion >= 2 ? value.conversation : null;
  if (conversation !== null) {
    keys(conversation, ['harness', 'sessionId', 'digest', 'size', 'excerptBytes', 'truncated']);
    if (!Object.hasOwn(CONVERSATION_READERS, conversation.harness) || typeof conversation.sessionId !== 'string' || !SESSION_ID.test(conversation.sessionId)
      || !hash(conversation.digest) || !Number.isSafeInteger(conversation.size) || conversation.size < 0
      || !count(conversation.excerptBytes, DREAM_CONVERSATION_LIMITS.excerptBytes) || conversation.excerptBytes > conversation.size
      || conversation.truncated !== (conversation.excerptBytes < conversation.size)) invalid();
  }
  if (value.schemaVersion === 1 ? coverage.conversations !== 'unsupported'
    : !CONVERSATION_COVERAGE.includes(coverage.conversations) || (coverage.conversations === 'supported') !== (conversation !== null)) invalid();
  // Before format 3 memory was never read; format 3 names what it delivered.
  if (value.schemaVersion === 3) {
    const memory = value.memory;
    if (!MEMORY_COVERAGE.includes(coverage.memory) || (coverage.memory === 'supported') !== (memory !== null)) invalid();
    if (memory !== null) {
      keys(memory, ['harness', 'items', 'remaining']);
      if (!Object.hasOwn(MEMORY_READERS, memory.harness) || !Array.isArray(memory.items) || memory.items.length > DREAM_MEMORY_LIMITS.items
        || !Number.isSafeInteger(memory.remaining) || memory.remaining < 0) invalid();
      let previous = null, memoryBytes = 0;
      for (const item of memory.items) {
        keys(item, ['path', 'digest', 'size', 'excerptBytes', 'truncated']);
        // Path order, so each item appears once.
        if (!memoryPath(memory.harness, item.path) || (previous !== null && !(previous < item.path)) || !hash(item.digest)
          || !Number.isSafeInteger(item.size) || item.size < 0 || !count(item.excerptBytes, DREAM_MEMORY_LIMITS.excerptBytes)
          || item.excerptBytes > item.size || item.truncated !== (item.excerptBytes < item.size)) invalid();
        previous = item.path; memoryBytes += item.excerptBytes;
      }
      if (memoryBytes > DREAM_MEMORY_LIMITS.bytes) invalid();
    }
  } else if (coverage.memory !== 'unsupported') invalid();
  if (coverage.definition !== 'supported'
    || !['eligible', 'selected', 'skippedBinary', 'remaining'].every(key => count(coverage[key], DREAM_PACKAGE_LIMITS.maxEntries))
    || coverage.selected !== value.sources.length || coverage.suppliedBytes !== suppliedBytes || suppliedBytes > DREAM_INPUT_LIMITS.bytes
    || coverage.selected + coverage.skippedBinary + coverage.remaining > coverage.eligible) invalid();
  if (value.nextCursor !== null) {
    keys(value.nextCursor, ['revision', 'path']);
    if (value.nextCursor.revision !== value.revision || !sourcePath(value.nextCursor.path) || coverage.remaining === 0) invalid();
  }
  // Bounds include JSON escaping and multibyte paths as well as source counts.
  if (Buffer.byteLength(JSON.stringify(value)) > 512 * 1024) invalid();
  return value;
}

export function dreamInputMetadata(inputs) {
  const conversation = inputs.schemaVersion >= 2 && inputs.conversation !== null
    ? (({ harness, sessionId, digest, size, excerptBytes, truncated }) => ({ harness, sessionId, digest, size, excerptBytes, truncated }))(inputs.conversation)
    : null;
  return validateDreamInputMetadata({ schemaVersion: inputs.schemaVersion, revision: inputs.revision,
    sources: inputs.sources.map(({ path, kind, digest, size, excerptBytes, truncated }) => ({ path, kind, digest, size, excerptBytes, truncated })),
    coverage: structuredClone(inputs.coverage), nextCursor: structuredClone(inputs.nextCursor),
    ...(inputs.schemaVersion >= 2 ? { conversation } : {}),
    ...(inputs.schemaVersion === 3 ? { memory: inputs.memory === null ? null : { harness: inputs.memory.harness, remaining: inputs.memory.remaining,
      items: inputs.memory.items.map(({ path, digest, size, excerptBytes, truncated }) => ({ path, digest, size, excerptBytes, truncated })) } } : {}) });
}

// The soul's own conversation (#603, owner decision 1): only the session the
// wake-session record names, only when that record says it lives in the soul's
// tool home (`store: 'soul'`), and only through a reader for its harness. The
// host's store, other souls' sessions and `.soul-state/runs` are never read,
// and the current routing is not consulted: the recorded origin decides.
// Codex keeps `sessions/YYYY/MM/DD/rollout-<time>-<thread id>.jsonl` under its
// CODEX_HOME, which a routed soul's tool home is. When a thread has more than
// one rollout file, the newest one is read.
const CONVERSATION_READERS = Object.freeze({
  codex: Object.freeze({ dir: 'sessions', depth: 3, matches: (name, sessionId) => name.startsWith('rollout-') && name.endsWith(`-${sessionId}.jsonl`) }),
});

// Each directory is pinned while it is listed: it must not be a link before
// it is opened, the descriptor opened with O_DIRECTORY | O_NOFOLLOW must be
// that directory, and the name must still be that same directory, not a
// link, once it has been listed. Node cannot list a directory through a
// descriptor, hence the pin. Anything else, or more than `limit` entries,
// throws. Entries come back in descending name order.
const same = (a, b) => a.dev === b.dev && a.ino === b.ino;
function listPinned(directory, limit, afterDirectoryOpen = () => {}) {
  const before = lstatSync(directory);
  if (!before.isDirectory() || before.isSymbolicLink()) throw new Error('unsafe directory');
  const pin = openSync(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  const names = [];
  try {
    if (!same(fstatSync(pin), before)) throw new Error('directory changed');
    afterDirectoryOpen(directory);
    const dir = opendirSync(directory);
    try {
      for (let entry; (entry = dir.readSync()) !== null;) {
        if (names.length === limit) throw new Error('limit');
        names.push(entry);
      }
    } finally { dir.closeSync(); }
    const after = lstatSync(directory);
    if (after.isSymbolicLink() || !same(after, before) || !same(fstatSync(pin), before)) throw new Error('directory changed');
  } finally { closeSync(pin); }
  return names.sort((a, b) => (a.name < b.name ? 1 : a.name > b.name ? -1 : 0));
}

// As the package reader does: no hardlink (another store's file can share
// the inode), and the opened descriptor must be the file that was checked.
// Once open, the file's only name must still be this path, reached through
// no link. Returns the open descriptor and size, or null; the caller closes it.
function openPinnedFile(file) {
  const checked = lstatSync(file);
  if (!checked.isFile() || checked.nlink !== 1 || realpathSync(file) !== file) return null;
  const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const info = fstatSync(fd);
    if (!info.isFile() || info.nlink !== 1 || info.dev !== checked.dev || info.ino !== checked.ino) { closeSync(fd); return null; }
    const reached = lstatSync(file);
    if (reached.isSymbolicLink() || reached.dev !== info.dev || reached.ino !== info.ino || realpathSync(file) !== file) { closeSync(fd); return null; }
    return { fd, size: info.size };
  } catch (error) { closeSync(fd); throw error; }
}

// The whole file, not only what is delivered, must be text: one streaming
// pass in bounded chunks, so memory stays bounded however long it grows.
// `onChunk` sees every byte read, for a whole-file digest.
function scanText(fd, size, onChunk = () => {}) {
  const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }), chunk = Buffer.alloc(64 * 1024);
  try {
    for (let offset = 0; offset < size;) {
      const count = readSync(fd, chunk, 0, Math.min(chunk.length, size - offset), offset);
      if (count === 0) return false;
      const part = chunk.subarray(0, count);
      if (part.includes(0)) return false;
      decoder.decode(part, { stream: true });
      onChunk(part);
      offset += count;
    }
    decoder.decode();
    return true;
  } catch { return false; }
}

// Finds and reads the recorded session's file, or says why it cannot. The
// excerpt is the newest whole lines within the byte bound, since the file is
// a live, append-only log; its digest is of the delivered excerpt.
// `afterDirectoryOpen` is a test seam, called once each directory is opened
// and before it is listed.
export function captureDreamConversation(soulDir, session, { afterDirectoryOpen = () => {} } = {}) {
  const reader = session && Object.hasOwn(CONVERSATION_READERS, session.harness) ? CONVERSATION_READERS[session.harness] : null;
  if (!reader || session.store !== 'soul' || typeof session.sessionId !== 'string' || !SESSION_ID.test(session.sessionId)) {
    return { coverage: 'unsupported', conversation: null };
  }
  const unavailable = { coverage: 'unavailable', conversation: null };
  let fd = null;
  try {
    const home = realpathSync(toolHomePath(soulDir, session.harness));
    if (home !== path.join(realpathSync(soulDir), path.relative(soulDir, toolHomePath(soulDir, session.harness)))) return unavailable;
    // Newest first, never following a link: Codex names day directories and
    // rollout files by start time, so descending name order reaches the most
    // recent session first and the walk stops at its first match. No budget
    // spans the whole store, so a growing history cannot make a recorded
    // session unreadable; each directory listing is bounded instead, and
    // only a single directory over that bound reports `unavailable`.
    //
    // Each directory (the store root and every year, month and day) is
    // pinned while it is listed; anything unsafe refuses the session rather
    // than skipping ahead.
    const list = directory => listPinned(directory, DREAM_CONVERSATION_LIMITS.entries, afterDirectoryOpen);
    // The newest name that matches is the session's file, whatever it is: a
    // link or anything else there refuses the session below rather than
    // falling back to an older rollout.
    const walk = (directory, depth) => {
      for (const entry of list(directory)) {
        const file = path.join(directory, entry.name);
        if (depth < reader.depth) {
          if (entry.isDirectory()) { const match = walk(file, depth + 1); if (match) return match; }
        } else if (reader.matches(entry.name, session.sessionId)) return file;
      }
      return null;
    };
    // The store root must resolve to itself inside the tool home.
    const root = path.join(home, reader.dir);
    if (realpathSync(root) !== root) return unavailable;
    const file = walk(root, 0);
    if (file === null) return unavailable;
    const opened = openPinnedFile(file);
    if (opened === null) return unavailable;
    ({ fd } = opened);
    const { size } = opened;
    if (!scanText(fd, size)) return unavailable;
    const start = Math.max(0, size - DREAM_CONVERSATION_LIMITS.excerptBytes);
    const buffer = Buffer.alloc(size - start);
    let read = 0;
    while (read < buffer.length) {
      const bytes = readSync(fd, buffer, read, buffer.length - read, start + read);
      if (bytes === 0) break;
      read += bytes;
    }
    let bytes = buffer.subarray(0, read);
    // A tail that starts mid-file starts after its first line break, so no
    // partial line or split UTF-8 character is delivered.
    if (start > 0) { const newline = bytes.indexOf(0x0a); bytes = newline === -1 ? bytes.subarray(bytes.length) : bytes.subarray(newline + 1); }
    const excerpt = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
    return { coverage: 'supported', conversation: { harness: session.harness, sessionId: session.sessionId, digest: digest(bytes), size,
      excerpt, excerptBytes: bytes.length, truncated: bytes.length < size } };
  } catch { return unavailable; }
  finally { if (fd !== null) closeSync(fd); }
}

// The soul's harness memory (#903, owner decision 2026-10-11): only files the
// harness keeps as memory inside the soul's own tool home, read with the same
// containment as the conversation reader. The Agent Space, the host's harness
// store and other souls are never read. Claude keeps
// `projects/<project>/memory/*.md` under its CLAUDE_CONFIG_DIR, which a routed
// soul's tool home is. An item is identified by its path in the tool home and
// the digest of the whole file; the excerpt is its first bytes. A memory earns
// no processing credit here, and age never makes one disposable.
export const DREAM_MEMORY_LIMITS = Object.freeze({ items: 64, excerptBytes: 64 * 1024, bytes: 256 * 1024, entries: 4096, visited: 16384 });
const MEMORY_COVERAGE = ['supported', 'unsupported', 'unavailable'];
const MEMORY_READERS = Object.freeze({
  claude: Object.freeze({ dir: 'projects', sub: 'memory', matches: name => name.endsWith('.md') && name.length > 3 }),
});
const segment = name => typeof name === 'string' && name.length > 0 && name.length <= 255 && name !== '.' && name !== '..'
  && !name.includes('/') && !name.includes('\0');
const memoryPath = (harness, value) => {
  const reader = MEMORY_READERS[harness];
  if (typeof value !== 'string' || value.length > 4096) return false;
  const parts = value.split('/');
  return parts.length === 4 && parts[0] === reader.dir && segment(parts[1]) && parts[2] === reader.sub
    && segment(parts[3]) && reader.matches(parts[3]);
};

// `unsupported`: the harness has no memory reader, or the soul's tool home
// holds no memory store for it (its memory may live in the host's store,
// which is never read). `unavailable`: the store exists but something in it
// is unsafe or past a listing bound; the run continues without memory.
// `supported`: every memory file was found without a link; the first ones in
// path order are checked and delivered within the limits, and `remaining`
// counts the rest.
// `afterDirectoryOpen` is a test seam, as for conversations; `afterFileScan`
// (called once a file is hashed) and `visitedLimit` are test seams too.
export function captureDreamMemory(soulDir, harness, { afterDirectoryOpen = () => {}, afterFileScan = () => {}, visitedLimit = DREAM_MEMORY_LIMITS.visited } = {}) {
  const reader = typeof harness === 'string' && Object.hasOwn(MEMORY_READERS, harness) ? MEMORY_READERS[harness] : null;
  const unsupported = { coverage: 'unsupported', memory: null }, unavailable = { coverage: 'unavailable', memory: null };
  if (!reader) return unsupported;
  const exists = file => { try { lstatSync(file); return true; } catch (error) { if (error.code === 'ENOENT') return false; throw error; } };
  try {
    if (!exists(toolHomePath(soulDir, harness))) return unsupported;
    const home = realpathSync(toolHomePath(soulDir, harness));
    if (home !== path.join(realpathSync(soulDir), path.relative(soulDir, toolHomePath(soulDir, harness)))) return unavailable;
    const root = path.join(home, reader.dir);
    if (!exists(root)) return unsupported;
    if (realpathSync(root) !== root) return unavailable;
    // Each listing is bounded, and so is the whole walk: past `visited`
    // directory entries in all, the store is `unavailable` rather than held
    // in memory and sorted.
    let visited = 0;
    const list = directory => {
      const names = listPinned(directory, DREAM_MEMORY_LIMITS.entries, afterDirectoryOpen);
      visited += names.length;
      if (visited > visitedLimit) throw new Error('limit');
      return names;
    };
    // Every project's memory directory, and every memory file in it, is
    // found before any is read. A link where a project, its memory directory
    // or a memory file would be refuses the whole store; other names are not
    // memory and are ignored.
    const files = [];
    for (const project of list(root).reverse()) {
      if (project.isSymbolicLink()) throw new Error('linked project');
      if (!project.isDirectory()) continue;
      const projectDir = path.join(root, project.name);
      const entry = list(projectDir).find(item => item.name === reader.sub);
      if (!entry) continue;
      if (!entry.isDirectory() || entry.isSymbolicLink()) throw new Error('unsafe memory directory');
      const memoryDir = path.join(projectDir, reader.sub);
      for (const item of list(memoryDir).reverse()) {
        if (!reader.matches(item.name)) continue;
        if (!item.isFile()) throw new Error('unsafe memory file');
        const relative = `${reader.dir}/${project.name}/${reader.sub}/${item.name}`;
        if (!memoryPath(harness, relative)) throw new Error('unsafe memory name');
        files.push({ file: path.join(memoryDir, item.name), relative });
      }
    }
    // Path order (code units), the order format 3 metadata requires.
    files.sort((a, b) => (a.relative < b.relative ? -1 : a.relative > b.relative ? 1 : 0));
    const items = [];
    let supplied = 0;
    for (const { file, relative } of files) {
      if (items.length === DREAM_MEMORY_LIMITS.items || supplied === DREAM_MEMORY_LIMITS.bytes) break;
      const opened = openPinnedFile(file);
      if (opened === null) return unavailable;
      try {
        // The excerpt is taken in the same pass that hashes the file, and the
        // descriptor must show the same size, change times and single link
        // afterwards, so digest, excerpt, size and truncation all describe
        // one version of the file. A file changed while read is `unavailable`.
        const before = fstatSync(opened.fd, { bigint: true });
        if (before.size !== BigInt(opened.size)) return unavailable;
        const hash = createHash('sha256'), limit = Math.min(DREAM_MEMORY_LIMITS.excerptBytes, DREAM_MEMORY_LIMITS.bytes - supplied, opened.size);
        const head = Buffer.alloc(limit);
        let read = 0;
        const scanned = scanText(opened.fd, opened.size, part => {
          hash.update(part);
          if (read < limit) read += part.copy(head, read, 0, Math.min(part.length, limit - read));
        });
        if (!scanned) return unavailable;
        afterFileScan(file);
        const after = fstatSync(opened.fd, { bigint: true });
        if (after.size !== before.size || after.mtimeNs !== before.mtimeNs || after.ctimeNs !== before.ctimeNs || after.nlink !== 1n
          || after.dev !== before.dev || after.ino !== before.ino) return unavailable;
        // A head cut mid-character drops the partial character.
        const excerpt = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(head.subarray(0, read), { stream: read < opened.size });
        const excerptBytes = Buffer.byteLength(excerpt);
        if (excerptBytes === 0 && opened.size > 0) break;
        supplied += excerptBytes;
        items.push({ path: relative, digest: `sha256:${hash.digest('hex')}`, size: opened.size, excerpt, excerptBytes, truncated: excerptBytes < opened.size });
      } finally { closeSync(opened.fd); }
    }
    return { coverage: 'supported', memory: { harness, items, remaining: files.length - items.length } };
  } catch { return unavailable; }
}

export const dreamInputMetadataDigest = value => digest(Buffer.from(JSON.stringify(validateDreamInputMetadata(value))));

// This cursor is selection progress, never evidence of completed maintenance.
// A new revision invalidates it; an unknown same-revision path is refused.
// Given `session` (the host's wake-session record for this soul, or null),
// capture uses input format 2 and adds the soul's own conversation. Given
// `memory` ({ harness }, the soul's harness), it uses format 3 and also adds
// the soul's harness memory.
export function captureDreamInputs(soulDir, { cursor = null, session, memory } = {}) {
  let snapshot;
  try {
    snapshot = readSoulPackageEntries(soulDir, { limits: DREAM_PACKAGE_LIMITS, requiredFormatVersion: 2 });
  } catch (error) {
    if (error.code === 'soul-package-read-limit') fail('dream-input-limit', 'Soul package exceeds the bounded verification limits.');
    fail('dream-input-unavailable', 'Soul package cannot be safely verified for maintenance.');
  }
  const revision = computePackageRevisionFromEntries(snapshot);
  if (snapshot.manifest.revision !== revision) fail('dream-input-drift', 'Soul package bytes do not match its declared revision.');
  const candidates = snapshot.entries.filter(eligible);
  let start = 0;
  if (cursor !== null) {
    if (!cursor || typeof cursor !== 'object' || Array.isArray(cursor) || Object.keys(cursor).length !== 2
      || !['revision', 'path'].every(key => Object.hasOwn(cursor, key)) || typeof cursor.revision !== 'string'
      || cursor.revision.length !== 71 || !/^sha256:[a-f0-9]{64}$/.test(cursor.revision) || typeof cursor.path !== 'string' || cursor.path.length > 4096) {
      fail('dream-input-cursor-invalid', 'Invalid maintenance selection cursor.');
    }
    if (cursor.revision === revision) {
      start = candidates.findIndex(entry => entry.path === cursor.path) + 1;
      if (start === 0) fail('dream-input-cursor-invalid', 'Selection cursor does not name an eligible source.');
    }
  }
  const sources = [];
  let suppliedBytes = 0, skippedBinary = 0, index = start;
  for (; index < candidates.length; index++) {
    if (sources.length === DREAM_INPUT_LIMITS.entries || suppliedBytes === DREAM_INPUT_LIMITS.bytes) break;
    const entry = candidates[index];
    // Check the whole bounded file before exposing an excerpt, so binary or
    // malformed content after the prefix cannot masquerade as a text source.
    try {
      if (entry.bytes.includes(0)) throw new Error('binary');
      new TextDecoder('utf-8', { fatal: true }).decode(entry.bytes);
    } catch { skippedBinary++; continue; }
    const limit = Math.min(DREAM_INPUT_LIMITS.excerptBytes, DREAM_INPUT_LIMITS.bytes - suppliedBytes);
    const excerpt = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(entry.bytes.subarray(0, limit), { stream: entry.bytes.length > limit });
    const excerptBytes = Buffer.byteLength(excerpt);
    if (excerptBytes === 0 && entry.bytes.length > 0) break; // leave a split UTF-8 character for the next page
    suppliedBytes += excerptBytes;
    sources.push({ path: entry.path, kind: kindOf(entry.path), digest: digest(entry.bytes), size: entry.bytes.length,
      excerpt, excerptBytes, truncated: excerptBytes < entry.bytes.length });
  }
  const schemaVersion = memory !== undefined ? 3 : session !== undefined ? 2 : 1;
  const conversation = session === undefined ? (schemaVersion === 3 ? { coverage: 'unsupported', conversation: null } : null) : captureDreamConversation(soulDir, session);
  const remembered = memory === undefined ? null : captureDreamMemory(soulDir, memory?.harness);
  return {
    schemaVersion, revision, sources,
    coverage: { definition: 'supported', memory: remembered?.coverage ?? 'unsupported', conversations: conversation?.coverage ?? 'unsupported',
      eligible: candidates.length, selected: sources.length, suppliedBytes, skippedBinary, remaining: candidates.length - index },
    nextCursor: index < candidates.length && index > start ? { revision, path: candidates[index - 1].path } : null,
    ...(conversation ? { conversation: conversation.conversation } : {}),
    ...(remembered ? { memory: remembered.memory } : {}),
  };
}
