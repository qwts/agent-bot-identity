// Bounded, read-only evidence that a soul revision or proposal changed sources
// a maintenance run was delivered (#603). It checks the journal record and both
// content-addressed packages; it never proves that a model read, understood or
// reviewed anything, so attribution stays `not-established`. Unbounded journal
// readers in soul-revisions.mjs are deliberately not used here.
import { createHash } from 'node:crypto';
import { closeSync, constants, fstatSync, lstatSync, opendirSync, openSync, readSync } from 'node:fs';
import { join } from 'node:path';
import { canonicalJson, computePackageRevisionFromEntries, readSoulPackageEntries } from './soul-package.mjs';
import { DREAM_PACKAGE_LIMITS } from './skill-dream-inputs.mjs';
import { revisionJournalRoot } from './soul-revisions.mjs';

export const DREAM_EVIDENCE_LIMITS = Object.freeze({
  events: 256, eventBytes: 64 * 1024, journalBytes: 2 * 1024 * 1024, inventoryEntries: 512, delivered: 100, changedPaths: 256, pathBytes: 4096,
});
const REVISION = /^sha256:[a-f0-9]{64}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const CHANGES = ['added', 'removed', 'modified'];
const fail = (code, message) => { throw Object.assign(new Error(message), { code }); };
const digest = bytes => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value)
  && [Object.prototype, null].includes(Object.getPrototypeOf(value)) && Object.getOwnPropertySymbols(value).length === 0;
const exact = (value, names) => plain(value) && Object.keys(value).length === names.length && names.every(name => Object.hasOwn(value, name));
const date = value => typeof value === 'string' && value.length === 24 && !Number.isNaN(Date.parse(value)) && new Date(value).toISOString() === value;
const eventName = index => `${String(index).padStart(10, '0')}.json`;

function inputs({ agentId, startingRevision, delivered, reference, runWindow = null, stateDir }) {
  const invalid = () => fail('dream-evidence-invalid', 'Invalid revision evidence request.');
  if (typeof startingRevision !== 'string' || !REVISION.test(startingRevision)) invalid();
  if (stateDir !== undefined && (typeof stateDir !== 'string' || !stateDir)) invalid();
  if (!Array.isArray(delivered) || delivered.length > DREAM_EVIDENCE_LIMITS.delivered) invalid();
  const sources = new Map();
  for (const row of delivered) {
    if (!exact(row, ['path', 'digest', 'truncated']) || typeof row.path !== 'string' || !row.path
      || Buffer.byteLength(row.path) > DREAM_EVIDENCE_LIMITS.pathBytes || sources.has(row.path)
      || typeof row.digest !== 'string' || !REVISION.test(row.digest) || typeof row.truncated !== 'boolean') invalid();
    sources.set(row.path, { digest: row.digest, truncated: row.truncated });
  }
  if (runWindow !== null && (!exact(runWindow, ['startedAt', 'endedAt']) || !date(runWindow.startedAt) || !date(runWindow.endedAt)
    || runWindow.startedAt > runWindow.endedAt)) invalid();
  let ref;
  if (exact(reference, ['proposalId']) && typeof reference.proposalId === 'string' && UUID.test(reference.proposalId)) ref = { proposalId: reference.proposalId };
  else if (exact(reference, ['revision']) && typeof reference.revision === 'string' && REVISION.test(reference.revision)) ref = { revision: reference.revision };
  else fail('dream-evidence-reference', 'A reference names exactly one proposalId or revision.');
  let root;
  try { root = revisionJournalRoot(agentId, stateDir === undefined ? {} : { stateDir }); } catch { invalid(); }
  return { root, startingRevision, sources, reference: ref, runWindow };
}

// One journal record: no links, a regular single-link file within the per-event
// bound, unchanged across the read, and strict UTF-8 JSON. null when absent;
// 'unreadable' for anything else, which ends the scan without proving absence.
function readEvent(root, index, budget) {
  let fd;
  try { fd = openSync(join(root, eventName(index)), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
  catch (error) { return error.code === 'ENOENT' ? null : 'unreadable'; }
  try {
    const opened = fstatSync(fd);
    if (!opened.isFile() || opened.nlink !== 1 || opened.size > DREAM_EVIDENCE_LIMITS.eventBytes || opened.size > budget.remaining) return 'unreadable';
    const buffer = Buffer.alloc(opened.size + 1);
    let size = 0, count;
    while (size < buffer.length && (count = readSync(fd, buffer, size, buffer.length - size, null))) size += count;
    const after = fstatSync(fd);
    if (size !== opened.size || after.size !== opened.size || after.nlink !== 1 || after.mtimeMs !== opened.mtimeMs
      || after.ctimeMs !== opened.ctimeMs || after.ino !== opened.ino) return 'unreadable';
    budget.remaining -= size;
    const value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, size)));
    return plain(value) ? value : 'unreadable';
  } catch { return 'unreadable'; }
  finally { closeSync(fd); }
}

function present(root, index) {
  try { lstatSync(join(root, eventName(index))); return true; }
  catch (error) { if (error.code === 'ENOENT') return false; fail('dream-evidence-unavailable', 'Revision journal cannot be safely read.'); }
}
// The journal's extent is proven only by a bounded inventory of a small
// journal whose record names are exactly 0..N. A larger journal, or one with a
// gap, is unproven: probing still finds a newest index, but absence, and a
// proposal that is still pending, can no longer be claimed from what is read.
function journalExtent(root) {
  let dir;
  try { dir = opendirSync(root, { bufferSize: 32 }); }
  catch { fail('dream-evidence-unavailable', 'Revision journal cannot be safely read.'); }
  const indices = [];
  try {
    let entry, entries = 0;
    while ((entry = dir.readSync())) {
      if (++entries > DREAM_EVIDENCE_LIMITS.inventoryEntries) return { proven: false, newest: newestIndex(root) };
      if (/^\d{10}\.json$/.test(entry.name)) indices.push(Number(entry.name.slice(0, 10)));
    }
  } catch (error) {
    if (error.code === 'dream-evidence-unavailable') throw error;
    fail('dream-evidence-unavailable', 'Revision journal cannot be safely read.');
  } finally { dir.closeSync(); }
  indices.sort((a, b) => a - b);
  const contiguous = indices.every((value, index) => value === index);
  return contiguous ? { proven: true, newest: indices.length - 1 } : { proven: false, newest: newestIndex(root) };
}
// The journal appends contiguous indices from zero. Probe exponentially then
// binary-search a newest index instead of listing a large directory.
function newestIndex(root) {
  if (!present(root, 0)) return -1;
  let low = 0, high = 1;
  while (present(root, high)) { low = high; high *= 2; if (high > 9999999999) fail('dream-evidence-limit', 'Revision journal index exceeds its format.'); }
  while (high - low > 1) { const middle = Math.floor((low + high) / 2); if (present(root, middle)) low = middle; else high = middle; }
  return low;
}

// A newer record naming the proposal decides it only when it is a well-formed
// approval (the proposal's own revision and parent) or rejection made after it.
// Any other matching record or more than one decision is `uncertain`, never a
// fabricated outcome. Current status needs a proven extent: an unproven journal
// may hide a newer matching record, so every status there is `uncertain`.
function proposalStatus(event, newer, proven) {
  if (!proven) return 'uncertain';
  if (event.status === 'rejected') return 'rejected';
  const matching = newer.filter(row => Object.hasOwn(row, 'proposalId') && row.proposalId === event.proposalId);
  if (matching.length === 0) return 'pending';
  if (matching.length > 1) return 'uncertain';
  const [row] = matching;
  if (row.schemaVersion !== 1 || !date(row.at) || row.at < event.at) return 'uncertain';
  if (row.kind === 'revision' && row.author === 'soul' && ['auto', 'user'].includes(row.approval)
    && row.revision === event.revision && row.parentRevision === event.parentRevision) return 'approved';
  if (row.kind === 'decision' && row.author === 'user') return 'rejected';
  return 'uncertain';
}
// Validate only the fields reported or relied on; journal reasons, approval
// text and skill reports are never copied into the result.
function eventSummary(event, index, newer, proven) {
  const common = event.schemaVersion === 1 && date(event.at) && typeof event.revision === 'string' && REVISION.test(event.revision)
    && (event.parentRevision === null || typeof event.parentRevision === 'string' && REVISION.test(event.parentRevision));
  if (!common) return null;
  if (event.kind === 'proposal') {
    if (typeof event.proposalId !== 'string' || !UUID.test(event.proposalId) || event.author !== 'soul' || event.parentRevision === null
      || !['pending', 'rejected'].includes(event.status) || !Array.isArray(event.diff) || event.diff.length > DREAM_PACKAGE_LIMITS.maxEntries
      || !event.diff.every(row => exact(row, ['path', 'change']) && typeof row.path === 'string' && CHANGES.includes(row.change))) return null;
    return { index, kind: 'proposal', proposalId: event.proposalId, revision: event.revision, parentRevision: event.parentRevision,
      author: 'soul', at: event.at, status: proposalStatus(event, newer, proven) };
  }
  if (event.kind === 'revision') {
    if (!['user', 'soul'].includes(event.author) || event.proposalId !== undefined && (typeof event.proposalId !== 'string' || !UUID.test(event.proposalId))) return null;
    return { index, kind: 'revision', proposalId: event.proposalId ?? null, revision: event.revision, parentRevision: event.parentRevision,
      author: event.author, at: event.at, status: null };
  }
  return null;
}

// Newest-first, at most DREAM_EVIDENCE_LIMITS.events records and journalBytes.
// `complete` is true only when the journal's extent is proven and every record
// back to index zero was read.
function findReference(root, reference) {
  const { proven, newest } = journalExtent(root), newer = [], budget = { remaining: DREAM_EVIDENCE_LIMITS.journalBytes };
  const oldest = Math.max(0, newest - DREAM_EVIDENCE_LIMITS.events + 1);
  for (let index = newest; index >= oldest; index--) {
    const event = readEvent(root, index, budget);
    if (event === null || event === 'unreadable') return { complete: false };
    const matches = reference.proposalId ? event.kind === 'proposal' && event.proposalId === reference.proposalId
      : event.kind === 'revision' && event.revision === reference.revision;
    if (matches) return { complete: true, proven, event, summary: eventSummary(event, index, newer, proven) };
    newer.push(event);
  }
  return { complete: proven && oldest === 0 };
}

// Same comparison as soul-revisions diffSoulPackages: directories by presence,
// files by mode and bytes, soul.json canonical without its revision fields.
function inventory(read) {
  const result = new Map();
  for (const { path, mode, bytes } of read.entries) {
    if (mode === '040000') { result.set(path, 'directory'); continue; }
    let content = bytes;
    if (path === 'soul.json') {
      const { revision, parentRevision, ...rest } = JSON.parse(bytes);
      content = Buffer.from(canonicalJson(rest));
    }
    result.set(path, `${mode}:${content.toString('base64')}`);
  }
  return result;
}

function storedObject(root, revision) {
  if (revision === null) return { state: 'missing' };
  try {
    const objects = lstatSync(join(root, 'objects'));
    if (!objects.isDirectory()) return { state: 'mismatch' };
    lstatSync(join(root, 'objects', `${revision.slice(7)}.soul`));
  } catch (error) { if (error.code === 'ENOENT') return { state: 'missing' }; return { state: 'mismatch' }; }
  let read;
  try { read = readSoulPackageEntries(join(root, 'objects', `${revision.slice(7)}.soul`), { limits: DREAM_PACKAGE_LIMITS, requiredFormatVersion: 2 }); }
  catch (error) {
    if (error.code === 'soul-package-read-limit') fail('dream-evidence-limit', 'A stored soul package exceeds the bounded verification limits.');
    return { state: 'mismatch' };
  }
  return read.manifest.revision === revision && computePackageRevisionFromEntries(read) === revision ? { state: 'verified', read } : { state: 'mismatch' };
}

const sameDiff = (recorded, computed) => recorded.length === computed.length
  && [...recorded].sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0)
    .every((row, index) => row.path === computed[index].path && row.change === computed[index].change);

export function verifyDreamRevisionEvidence(request = {}) {
  const { root, startingRevision, sources, reference, runWindow } = inputs(request);
  try { if (!lstatSync(root).isDirectory()) throw new Error('not a directory'); }
  catch { fail('dream-evidence-unavailable', 'Revision journal cannot be safely read.'); }
  const result = { schemaVersion: 1, reference, checked: null, verdict: 'not-verified', reasons: [], attribution: 'not-established' };
  const found = findReference(root, reference);
  if (!found.event) { result.reasons.push(found.complete ? 'reference-not-found' : 'search-incomplete'); return result; }
  if (!found.summary) { result.reasons.push('event-invalid'); return result; }
  const event = found.summary, reasons = result.reasons;
  const parent = storedObject(root, event.parentRevision), candidate = storedObject(root, event.revision);
  const checked = result.checked = {
    event, journalExtent: found.proven ? 'proven' : 'unproven', parentIsStart: event.parentRevision === startingRevision,
    objects: { parent: parent.state, candidate: candidate.state },
    changedPaths: null, changedCount: null, journalDiffMatches: null, outsideDelivered: null,
    deliveredMatchParent: null, truncatedChanged: null,
    withinRunWindow: runWindow === null ? null : runWindow.startedAt <= event.at && event.at <= runWindow.endedAt,
  };
  if (event.author !== 'soul') reasons.push('author-not-soul');
  if (!checked.parentIsStart) reasons.push('parent-not-start');
  if (checked.withinRunWindow === false) reasons.push('outside-run-window');
  if (parent.state !== 'verified') reasons.push(`parent-object-${parent.state}`);
  if (candidate.state !== 'verified') reasons.push(`candidate-object-${candidate.state}`);
  if (parent.state === 'verified') {
    const files = new Map(parent.read.entries.filter(entry => entry.mode !== '040000').map(entry => [entry.path, entry.bytes]));
    const matched = [], mismatched = [], missing = [];
    for (const [path, row] of sources) {
      if (!files.has(path)) missing.push(path);
      else (digest(files.get(path)) === row.digest ? matched : mismatched).push(path);
    }
    checked.deliveredMatchParent = { matched: matched.sort(), mismatched: mismatched.sort(), missing: missing.sort() };
  }
  if (parent.state === 'verified' && candidate.state === 'verified') {
    const left = inventory(parent.read), right = inventory(candidate.read);
    const changes = [...new Set([...left.keys(), ...right.keys()])].sort().filter(path => left.get(path) !== right.get(path))
      .map(path => ({ path, change: !left.has(path) ? 'added' : !right.has(path) ? 'removed' : 'modified' }));
    checked.changedCount = changes.length;
    checked.changedPaths = changes.slice(0, DREAM_EVIDENCE_LIMITS.changedPaths);
    if (event.kind === 'proposal') checked.journalDiffMatches = sameDiff(found.event.diff, changes);
    const outside = changes.filter(row => !sources.has(row.path)).map(row => row.path);
    checked.outsideDelivered = outside.slice(0, DREAM_EVIDENCE_LIMITS.delivered);
    // Reported, never blocking: a changed source the run saw only in part.
    checked.truncatedChanged = changes.filter(row => sources.get(row.path)?.truncated).map(row => row.path);
    if (checked.journalDiffMatches === false) reasons.push('journal-diff-mismatch');
    if (changes.length === 0) reasons.push('no-change');
    if (changes.length > DREAM_EVIDENCE_LIMITS.changedPaths) reasons.push('change-too-large');
    if (outside.length) reasons.push('change-outside-delivered');
    const mismatchedChange = changes.some(row => sources.has(row.path) && !checked.deliveredMatchParent.matched.includes(row.path));
    if (mismatchedChange) reasons.push('delivered-digest-mismatch');
  }
  if (reasons.length === 0) result.verdict = 'verified-change';
  return result;
}
