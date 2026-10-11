// Soul skill search (#902; owner decisions relayed 2026-10-11). The host's
// `settings.skillSearchAdapter` picks the adapter; unset, search says plainly
// that none is configured and exits nonzero. No service is ever set up.
//
// `local-text` is the first adapter: a case-insensitive text match over the
// soul's own definition and skill files, the same files dream maintenance
// may read (root AGENTS.md, soul.md/SOUL.md and eligible skills/ files). It
// reads the live package once, hashes it and refuses unless the bytes are the
// declared revision, so every citation is the soul revision, the file's path
// and the sha256 of its bytes, which anyone can check again. A removed file
// is not in the revision and so never cited. Every result is `sourced`: it
// quotes a line of the file it cites; this adapter infers nothing.
import { createHash } from 'node:crypto';
import { loadConfig, skillSearchAdapterSetting } from './config.mjs';
import { validateAgentId } from './agent-identity.mjs';
import { soulDirectory } from './agent-population.mjs';
import { computePackageRevisionFromEntries, readSoulPackageEntries } from './soul-package.mjs';
import { kindOf } from './soul-profile.mjs';

export const SKILL_SEARCH_LIMITS = Object.freeze({ queryBytes: 4096, terms: 16, results: 100, lineChars: 240,
  package: Object.freeze({ maxEntries: 8192, maxBytes: 64 * 1024 * 1024, maxFileBytes: 8 * 1024 * 1024, maxDepth: 32 }) });
const fail = (code, message) => { throw Object.assign(new Error(message), { code }); };
const digest = bytes => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
// The dream input rule (skill-dream-inputs.mjs), so search and maintenance
// see the same knowledge and nothing private, generated or manifest-only.
const eligible = entry => entry.mode !== '040000' && (['AGENTS.md', 'soul.md', 'SOUL.md'].includes(entry.path)
  || entry.path.startsWith('skills/') && kindOf(entry.path) === 'skill');

export function soulSkillSearch(agentId, query, { config, ...options } = {}) {
  validateAgentId(agentId);
  if (typeof query !== 'string' || !query.trim() || query.includes('\0') || Buffer.byteLength(query) > SKILL_SEARCH_LIMITS.queryBytes) {
    fail('skill-search-query-invalid', `the search query must be non-empty text of at most ${SKILL_SEARCH_LIMITS.queryBytes} bytes`);
  }
  const terms = [...new Set(query.toLowerCase().split(/\s+/u).filter(Boolean))];
  if (terms.length > SKILL_SEARCH_LIMITS.terms) fail('skill-search-query-invalid', `the search query may have at most ${SKILL_SEARCH_LIMITS.terms} words`);
  const directory = soulDirectory(agentId, { ...options, readOnly: true });
  const adapter = skillSearchAdapterSetting(config ?? loadConfig({ home: options.home, env: options.env }));
  if (adapter === null) {
    fail('skill-search-no-adapter', 'no knowledge search adapter is configured for this soul; agent-bot sets up no search service, so nothing was searched');
  }
  let snapshot;
  try { snapshot = readSoulPackageEntries(directory, { limits: SKILL_SEARCH_LIMITS.package, requiredFormatVersion: 2 }); }
  catch (error) {
    if (error.code === 'soul-package-read-limit') fail('skill-search-limit', 'the soul package is past the search read limits');
    fail('skill-search-unavailable', `the soul package cannot be read safely: ${error.message}`);
  }
  const revision = computePackageRevisionFromEntries(snapshot);
  if (snapshot.manifest.revision !== revision) {
    fail('skill-search-drift', 'the soul package bytes do not match its declared revision, so nothing could be cited');
  }
  const results = [];
  let eligibleCount = 0, searched = 0, skippedBinary = 0, truncated = false;
  for (const entry of snapshot.entries) {
    if (truncated) break;
    if (!eligible(entry)) continue;
    eligibleCount++;
    let text;
    try {
      if (entry.bytes.includes(0)) throw new Error('binary');
      text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(entry.bytes);
    } catch { skippedBinary++; continue; }
    searched++;
    const lines = text.split(/\r?\n/u), fileDigest = digest(entry.bytes);
    for (let index = 0; index < lines.length; index++) {
      const lower = lines[index].toLowerCase();
      if (!terms.every(term => lower.includes(term))) continue;
      if (results.length === SKILL_SEARCH_LIMITS.results) { truncated = true; break; }
      const chars = Array.from(lines[index].trim());
      results.push({ path: entry.path, digest: fileDigest, line: index + 1,
        text: chars.length > SKILL_SEARCH_LIMITS.lineChars ? `${chars.slice(0, SKILL_SEARCH_LIMITS.lineChars).join('')}…` : chars.join(''),
        relationship: 'sourced' });
    }
  }
  return { agentId, adapter, revision, verification: 'verified', query, results, truncated,
    coverage: { eligible: eligibleCount, searched, skippedBinary } };
}
