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
