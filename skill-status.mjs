// Soul skill status (#603; owner decision 3, 2026-10-10): what is known about
// one soul's skills, from records that already exist. It reads the live
// package and writes nothing. Each answer says how it is known: `verified`
// means agent-bot rechecked the bytes now; `agent-reported` means a receipt
// records an agent's claim; `unknown` means nothing can check it yet.
// Dream maintenance lives in the daemon; `soul skill dream --status` reports it.
// An installed skill's record and its folder are compared as uninstall does.
import path from 'node:path';
import { validateAgentId } from './agent-identity.mjs';
import { soulDirectory } from './agent-population.mjs';
import { readSoulPackageEntries } from './soul-package.mjs';
import { installDrift, installRecordPath } from './skill-install.mjs';
import { learningReceipts } from './skill-learning.mjs';

// The library's per-skill bounds, applied to the whole package read.
export const SKILL_STATUS_LIMITS = Object.freeze({ maxEntries: 8192, maxBytes: 64 * 1024 * 1024, maxFileBytes: 8 * 1024 * 1024, maxDepth: 32 });
const fail = (code, message) => { throw Object.assign(new Error(message), { code }); };
const SKILL = /^skills\/([^/]+)(?:\/|$)/, RECORD = /^provenance\/skill-installs\/([^/]+)\.json$/;

export function soulSkillStatus(agentId, options = {}) {
  validateAgentId(agentId);
  const directory = soulDirectory(agentId, { ...options, readOnly: true });
  let snapshot;
  try { snapshot = readSoulPackageEntries(directory, { limits: SKILL_STATUS_LIMITS }); }
  catch (error) {
    if (error.code === 'soul-package-read-limit') fail('skill-status-limit', 'the soul package is past the status read limits');
    fail('skill-status-unavailable', `the soul package cannot be read safely: ${error.message}`);
  }
  const skills = new Set(), records = new Set();
  for (const entry of snapshot.entries) {
    const skill = entry.path.match(SKILL), record = entry.path.match(RECORD);
    if (skill && (entry.path !== `skills/${skill[1]}` || entry.mode === '040000')) skills.add(skill[1]);
    if (record && entry.mode !== '040000') records.add(record[1]);
  }
  const names = new Set([...skills, ...records]);
  const installs = [...names].sort((a, b) => a.localeCompare(b, 'en')).map(name => {
    if (!skills.has(name)) return { name, verification: 'missing', changes: null, recorded: true };
    const drift = installDrift(path.join(directory, 'skills', name), path.join(directory, installRecordPath(name)), records.has(name));
    return { name, ...drift, recorded: records.has(name) };
  });
  const learning = learningReceipts(snapshot.entries, agentId).map(receipt => receipt.status === 'invalid-receipt' ? receipt : {
    libraryId: receipt.libraryId, status: 'valid', recordedAt: receipt.recordedAt ?? null,
    pieces: receipt.pieces.map(({ source, status, destination, method, verification }) => ({ source, status,
      ...(destination ? { destination } : {}), ...(method ? { method } : {}), verification: verification ?? 'not-adopted' })),
    knowledge: (receipt.knowledge ?? []).map(({ capability, status, reason }) => ({ capability, status, reason, verification: 'agent-reported' })),
  });
  return { agentId, revision: snapshot.manifest.revision, installs, learning,
    knowledge: { status: 'unknown', verification: 'no-capability-adapter', provisioned: false } };
}

// Soul skill search (#902): no retrieval adapter exists yet, so search says so
// plainly and exits nonzero. It sets up no service, reads no package content
// and returns no results; which adapter comes first, and its citation shape,
// is decided on #902. The soul must exist and the query must be bounded text.
export const SKILL_SEARCH_QUERY_BYTES = 4096;
export function soulSkillSearch(agentId, query, options = {}) {
  validateAgentId(agentId);
  if (typeof query !== 'string' || !query.trim() || query.includes('\0') || Buffer.byteLength(query) > SKILL_SEARCH_QUERY_BYTES) {
    fail('skill-search-query-invalid', `the search query must be non-empty text of at most ${SKILL_SEARCH_QUERY_BYTES} bytes`);
  }
  soulDirectory(agentId, { ...options, readOnly: true });
  fail('skill-search-no-adapter', 'no knowledge search adapter is configured for this soul; agent-bot sets up no search service, so nothing was searched');
}
