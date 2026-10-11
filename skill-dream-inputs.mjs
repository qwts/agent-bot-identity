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
  keys(value, ['schemaVersion', 'revision', 'sources', 'coverage', 'nextCursor', ...(value?.schemaVersion === 2 ? ['conversation'] : [])]);
  if (![1, 2].includes(value.schemaVersion) || !hash(value.revision) || !Array.isArray(value.sources)
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
  // Format 1 never read conversations; format 2 names the one it delivered.
  const conversation = value.schemaVersion === 2 ? value.conversation : null;
  if (conversation !== null) {
    keys(conversation, ['harness', 'sessionId', 'digest', 'size', 'excerptBytes', 'truncated']);
    if (!Object.hasOwn(CONVERSATION_READERS, conversation.harness) || typeof conversation.sessionId !== 'string' || !SESSION_ID.test(conversation.sessionId)
      || !hash(conversation.digest) || !Number.isSafeInteger(conversation.size) || conversation.size < 0
      || !count(conversation.excerptBytes, DREAM_CONVERSATION_LIMITS.excerptBytes) || conversation.excerptBytes > conversation.size
      || conversation.truncated !== (conversation.excerptBytes < conversation.size)) invalid();
  }
  if (value.schemaVersion === 1 ? coverage.conversations !== 'unsupported'
    : !CONVERSATION_COVERAGE.includes(coverage.conversations) || (coverage.conversations === 'supported') !== (conversation !== null)) invalid();
  if (coverage.definition !== 'supported' || coverage.memory !== 'unsupported'
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
  const conversation = inputs.schemaVersion === 2 && inputs.conversation !== null
    ? (({ harness, sessionId, digest, size, excerptBytes, truncated }) => ({ harness, sessionId, digest, size, excerptBytes, truncated }))(inputs.conversation)
    : null;
  return validateDreamInputMetadata({ schemaVersion: inputs.schemaVersion, revision: inputs.revision,
    sources: inputs.sources.map(({ path, kind, digest, size, excerptBytes, truncated }) => ({ path, kind, digest, size, excerptBytes, truncated })),
    coverage: structuredClone(inputs.coverage), nextCursor: structuredClone(inputs.nextCursor),
    ...(inputs.schemaVersion === 2 ? { conversation } : {}) });
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

// Finds and reads the recorded session's file, or says why it cannot. The
// excerpt is the newest whole lines within the byte bound, since the file is
// a live, append-only log; its digest is of the delivered excerpt.
export function captureDreamConversation(soulDir, session) {
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
    const list = directory => {
      const dir = opendirSync(directory);
      const names = [];
      try {
        for (let entry; (entry = dir.readSync()) !== null;) {
          if (names.length === DREAM_CONVERSATION_LIMITS.entries) throw new Error('limit');
          names.push(entry);
        }
      } finally { dir.closeSync(); }
      return names.sort((a, b) => (a.name < b.name ? 1 : a.name > b.name ? -1 : 0));
    };
    const walk = (directory, depth) => {
      for (const entry of list(directory)) {
        const file = path.join(directory, entry.name);
        if (depth < reader.depth) {
          if (entry.isDirectory()) { const match = walk(file, depth + 1); if (match) return match; }
        } else if (entry.isFile() && reader.matches(entry.name, session.sessionId)) return file;
      }
      return null;
    };
    // The store root itself is checked before it is listed: a link there,
    // or a root that resolves elsewhere, is never walked.
    const root = path.join(home, reader.dir), rootInfo = lstatSync(root);
    if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink() || realpathSync(root) !== root) return unavailable;
    const file = walk(root, 0);
    if (file === null) return unavailable;
    if (!lstatSync(file).isFile() || realpathSync(file) !== file) return unavailable;
    fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
    const info = fstatSync(fd), { size } = info;
    if (!info.isFile()) return unavailable;
    // The whole file, not only the delivered tail, must be text: one
    // streaming pass in excerpt-sized chunks, so memory stays bounded
    // however long the session grows.
    {
      const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }), chunk = Buffer.alloc(DREAM_CONVERSATION_LIMITS.excerptBytes);
      for (let offset = 0; offset < size;) {
        const count = readSync(fd, chunk, 0, Math.min(chunk.length, size - offset), offset);
        if (count === 0) return unavailable;
        const part = chunk.subarray(0, count);
        if (part.includes(0)) return unavailable;
        decoder.decode(part, { stream: true });
        offset += count;
      }
      decoder.decode();
    }
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

export const dreamInputMetadataDigest = value => digest(Buffer.from(JSON.stringify(validateDreamInputMetadata(value))));

// This cursor is selection progress, never evidence of completed maintenance.
// A new revision invalidates it; an unknown same-revision path is refused.
// Given `session` (the host's wake-session record for this soul, or null),
// capture uses input format 2 and adds the soul's own conversation.
export function captureDreamInputs(soulDir, { cursor = null, session } = {}) {
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
  const conversation = session === undefined ? null : captureDreamConversation(soulDir, session);
  return {
    schemaVersion: conversation ? 2 : 1, revision, sources,
    coverage: { definition: 'supported', memory: 'unsupported', conversations: conversation?.coverage ?? 'unsupported',
      eligible: candidates.length, selected: sources.length, suppliedBytes, skippedBinary, remaining: candidates.length - index },
    nextCursor: index < candidates.length && index > start ? { revision, path: candidates[index - 1].path } : null,
    ...(conversation ? { conversation: conversation.conversation } : {}),
  };
}
