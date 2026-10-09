// Read-only maintenance input capture. The host supplies the registered,
// canonical soul directory; no model-provided locator chooses another root.
import { createHash } from 'node:crypto';
import { computePackageRevisionFromEntries, readSoulPackageEntries } from './soul-package.mjs';
import { kindOf } from './soul-profile.mjs';

export const DREAM_INPUT_LIMITS = Object.freeze({ entries: 100, bytes: 1024 * 1024, excerptBytes: 64 * 1024 });
export const DREAM_PACKAGE_LIMITS = Object.freeze({ maxEntries: 4096, maxBytes: 16 * 1024 * 1024, maxFileBytes: 1024 * 1024, maxDepth: 32 });
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
  keys(value, ['schemaVersion', 'revision', 'sources', 'coverage', 'nextCursor']);
  if (value.schemaVersion !== 1 || !hash(value.revision) || !Array.isArray(value.sources)
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
  if (coverage.definition !== 'supported' || coverage.memory !== 'unsupported' || coverage.conversations !== 'unsupported'
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
  return validateDreamInputMetadata({ schemaVersion: inputs.schemaVersion, revision: inputs.revision,
    sources: inputs.sources.map(({ path, kind, digest, size, excerptBytes, truncated }) => ({ path, kind, digest, size, excerptBytes, truncated })),
    coverage: structuredClone(inputs.coverage), nextCursor: structuredClone(inputs.nextCursor) });
}

export const dreamInputMetadataDigest = value => digest(Buffer.from(JSON.stringify(validateDreamInputMetadata(value))));

// This cursor is selection progress, never evidence of completed maintenance.
// A new revision invalidates it; an unknown same-revision path is refused.
export function captureDreamInputs(soulDir, { cursor = null } = {}) {
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
  return {
    schemaVersion: 1, revision, sources,
    coverage: { definition: 'supported', memory: 'unsupported', conversations: 'unsupported',
      eligible: candidates.length, selected: sources.length, suppliedBytes, skippedBinary, remaining: candidates.length - index },
    nextCursor: index < candidates.length && index > start ? { revision, path: candidates[index - 1].path } : null,
  };
}
