// Explicit portable source comparison (#312). Reads accepted package evidence,
// fetches through the shared bounded transport, and stages data for review.
// It never changes accepted captures, local adaptations, or revision history.
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { soulDirectory } from './agent-population.mjs';
import { proposeSkillLearning, readLearnedSkillSource } from './skill-learning.mjs';
import { acquireHttpsSkill } from './skill-library.mjs';

const refuse = (code, message) => { throw Object.assign(new Error(message), { code }); };
const fail = () => { throw Object.assign(new Error('Portable source check staging is unavailable or unsafe.'), { code: 'skill-check-staging-invalid' }); };
const safe = file => typeof file === 'string' && file.length > 0 && file.length <= 1024 && file.split('/').every(part => part && part !== '.' && part !== '..'
  && !/[\\:*?"<>|\x00-\x1f\x7f]/.test(part) && !/[. ]$/.test(part) && !/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part));
function stagingRoot(agentId, options) {
  const soul = realpathSync(soulDirectory(agentId, { ...options, readOnly: true }));
  const state = path.join(soul, '.soul-state'), tmp = path.join(state, 'tmp'), marker = path.join(state, 'agent-id');
  if (!lstatSync(state).isDirectory() || lstatSync(state).isSymbolicLink()) fail();
  const info = lstatSync(marker);
  if (!info.isFile() || info.isSymbolicLink() || info.size > 256 || readFileSync(marker, 'utf8').trim() !== agentId) fail();
  try { mkdirSync(tmp, { mode: 0o700 }); } catch (error) { if (error.code !== 'EEXIST') throw error; }
  if (!lstatSync(tmp).isDirectory() || lstatSync(tmp).isSymbolicLink()) fail();
  return tmp;
}

function compareRetained(before, after, complete) {
  const available = new Map(after.map(entry => [entry.path, entry]));
  const changes = { modified: [], removed: [], uncaptured: [], unchanged: [], unbaselined: [] }, textDiffs = [];
  const retained = new Set(before.map(entry => entry.path));
  let budget = 64 * 1024;
  for (const entry of before) {
    const next = available.get(entry.path);
    if (next && next.mode === entry.mode && next.bytes.equals(entry.bytes)) { changes.unchanged.push(entry.path); continue; }
    // Missing bytes in an incomplete capture are not evidence of deletion.
    if (!next && !complete) { changes.uncaptured.push(entry.path); continue; }
    changes[next ? 'modified' : 'removed'].push(entry.path);
    const right = next?.bytes ?? Buffer.alloc(0);
    if (entry.bytes.length + right.length > budget || entry.bytes.includes(0) || right.includes(0)) {
      textDiffs.push({ path: entry.path, text: null, reason: entry.bytes.includes(0) || right.includes(0) ? 'binary' : 'diff-limit' }); continue;
    }
    let leftText, rightText;
    try { const decoder = new TextDecoder('utf-8', { fatal: true }); leftText = decoder.decode(entry.bytes); rightText = decoder.decode(right); }
    catch { textDiffs.push({ path: entry.path, text: null, reason: 'non-utf8' }); continue; }
    const section = (text, prefix) => text ? [...text.replace(/\n$/, '').split('\n').map(line => `${prefix}${line}`), ...(text.endsWith('\n') ? [] : ['\\ No newline at end of file'])] : [];
    const leftLines = leftText ? leftText.replace(/\n$/, '').split('\n').length : 0, rightLines = rightText ? rightText.replace(/\n$/, '').split('\n').length : 0;
    const text = [`--- a/${entry.path}`, `+++ b/${entry.path}`, `@@ -${leftLines ? 1 : 0},${leftLines} +${rightLines ? 1 : 0},${rightLines} @@`, ...section(leftText, '-'), ...section(rightText, '+')].join('\n');
    if (Buffer.byteLength(text) > budget) { textDiffs.push({ path: entry.path, text: null, reason: 'diff-limit' }); continue; }
    budget -= Buffer.byteLength(text); textDiffs.push({ path: entry.path, text, beforeMode: entry.mode, afterMode: next?.mode ?? null });
  }
  changes.unbaselined = after.filter(entry => !retained.has(entry.path)).map(entry => entry.path);
  for (const values of Object.values(changes)) values.sort();
  return { basis: 'retained-accepted-files-only', changes, textDiffs };
}

function saveCheck(tmp, result, content) {
  const directory = mkdtempSync(path.join(tmp, 'skill-check-'));
  try {
    if (content) {
      const payload = path.join(directory, 'payload'); mkdirSync(payload, { mode: 0o700 });
      for (const entry of content.entries) {
        if (!safe(entry.path) || !['100644', '100755'].includes(entry.mode)) fail();
        const target = path.join(payload, entry.path);
        mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
        writeFileSync(target, entry.bytes, { flag: 'wx', mode: entry.mode === '100755' ? 0o755 : 0o644 });
        chmodSync(target, entry.mode === '100755' ? 0o755 : 0o644);
      }
      const capture = { schemaVersion: 1, owner: result.libraryId, name: content.name, manifest: { digest: content.digest, files: content.files },
        source: content.source, capturedAt: result.checkedAt, dependencies: content.dependencies, coverage: content.coverage,
        excluded: content.excluded, materialized: content.materialized, locations: content.locations, hosts: content.hosts,
        ...(content.repository ? { repository: content.repository } : {}) };
      const bytes = Buffer.from(`${JSON.stringify(capture, null, 2)}\n`);
      if (bytes.length > 4 * 1024 * 1024) fail();
      writeFileSync(path.join(directory, 'manifest.json'), bytes, { flag: 'wx', mode: 0o600 });
    }
    const bytes = Buffer.from(`${JSON.stringify(result, null, 2)}\n`);
    if (bytes.length > 4 * 1024 * 1024) fail();
    writeFileSync(path.join(directory, 'check.json'), bytes, { flag: 'wx', mode: 0o600 });
    return { ...result, staging: directory };
  } catch (error) { rmSync(directory, { recursive: true, force: true }); throw error; }
}

export async function checkSoulSkillSource(libraryId, agentId, { now = () => new Date(), ...options } = {}) {
  const source = readLearnedSkillSource(libraryId, agentId, options), tmp = stagingRoot(agentId, options);
  const checkedAt = now().toISOString();
  const result = { schemaVersion: 1, agentId, libraryId, parentRevision: source.parentRevision, receiptDigest: source.receiptDigest,
    checkedAt, accepted: source.provenance?.digest ?? null, candidate: null, status: 'unavailable', reason: null,
    acceptedChanged: false, livePackageChanged: false, contentTrust: 'untrusted-source-data', adoption: 'existing-revision-proposal-policy', universalRetrieval: false };
  if (source.provenance?.source.kind !== 'https') {
    result.reason = source.provenance ? 'skill-local-source-not-portable' : 'skill-source-provenance-missing';
    return saveCheck(tmp, result, null);
  }
  let content;
  try { content = await acquireHttpsSkill(source.provenance.source.url, libraryId, options); }
  catch (error) {
    result.reason = typeof error.code === 'string' && /^skill-[a-z-]{1,64}$/.test(error.code) ? error.code : 'skill-fetch-unavailable';
    return saveCheck(tmp, result, null);
  }
  result.candidate = content.digest;
  result.status = result.accepted === result.candidate ? 'unchanged' : 'changed';
  result.coverage = content.coverage;
  result.comparison = compareRetained(source.entries, content.entries, content.coverage.acquisition === 'complete-within-boundary');
  // Full per-file locations live in the candidate manifest, under its existing
  // 4 MiB acquisition bound; the summary does not duplicate that entire graph.
  result.candidateSource = { ...content.source, capturedAt: checkedAt };
  if (content.coverage.acquisition === 'partial') { result.status = 'unavailable'; result.reason = 'skill-capture-incomplete'; }
  return saveCheck(tmp, result, content);
}

// Apply a reviewed candidate through the existing learning proposal (#312).
// The staged check bytes are review data only: the source is fetched again and
// must match the reviewed digest exactly, so nothing a soul could edit in its
// temporary state becomes provenance. The soul revision policy stays the gate.
export async function proposeSoulSkillCandidate(libraryId, agentId, staging, outcome, { candidate, now = () => new Date(), ...options } = {}) {
  if (typeof candidate !== 'string' || !/^sha256:[a-f0-9]{64}$/.test(candidate)) refuse('skill-candidate-invalid', 'select the reviewed candidate digest from a portable check');
  if (outcome?.source?.selection !== 'accepted' || outcome.source.digest !== candidate) refuse('skill-candidate-invalid', 'record the candidate as source {selection: "accepted", digest: CANDIDATE}');
  return proposeSkillLearning(libraryId, agentId, staging, outcome, { ...options, now, async material() {
    const source = readLearnedSkillSource(libraryId, agentId, options);
    if (source.provenance?.source.kind !== 'https') refuse(source.provenance ? 'skill-local-source-not-portable' : 'skill-source-provenance-missing', 'the accepted receipt has no portable HTTPS source to fetch');
    const content = await acquireHttpsSkill(source.provenance.source.url, libraryId, { ...options, now });
    if (content.coverage.acquisition === 'partial') refuse('skill-capture-incomplete', 'instruction capture is incomplete; check again before applying');
    if (content.digest !== candidate) refuse('skill-source-changed', 'the source no longer matches the reviewed candidate; check and review it again');
    // Same shape as an accepted library snapshot, owned by the original import.
    const captureMetadata = { schemaVersion: 1, owner: libraryId, name: content.name, manifest: { files: content.files, digest: content.digest },
      source: content.source, capturedAt: now().toISOString(), dependencies: content.dependencies, coverage: content.coverage,
      excluded: content.excluded, materialized: content.materialized, locations: content.locations, hosts: content.hosts,
      ...(content.repository ? { repository: content.repository } : {}) };
    const material = { selection: 'accepted', digest: content.digest, files: content.files, entries: content.entries, dependencies: content.dependencies, captureMetadata };
    return { source: material, accepted: { ...material } };
  } });
}
