// Bounded agent assertions and independently checked artifact facts. An artifact
// change is not evidence that a model reviewed a source or that this run caused it.
import { createHash } from 'node:crypto';
import { canonicalJson } from './soul-package.mjs';
import { validateDreamInputMetadata } from './skill-dream-inputs.mjs';

export const DREAM_OUTCOME_LIMITS = Object.freeze({ bytes: 256 * 1024, textBytes: 64 * 1024, references: 4, items: 100 });
const HASH = /^sha256:[a-f0-9]{64}$/;
const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const CODE = /^[a-z][a-z0-9-]{0,63}$/;
const exact = (value, names) => value && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).length === names.length && names.every(name => Object.hasOwn(value, name));
const hash = value => typeof value === 'string' && value.length === 71 && HASH.test(value);
const uuid = value => typeof value === 'string' && value.length === 36 && UUID.test(value);
const code = value => typeof value === 'string' && CODE.test(value);
const invalid = () => { throw Object.assign(new Error('Invalid bounded dream outcome.'), { code: 'dream-outcome-invalid' }); };
const statuses = ['structured', 'unstructured', 'invalid', 'truncated', 'oversized', 'execution-failed'];
const reportCodes = { unstructured: ['no-structured-report'], invalid: ['report-invalid', 'report-limit'],
  truncated: ['report-truncated'], oversized: ['report-limit'], 'execution-failed': ['execution-failed'] };
const evidenceKinds = ['agent-reported', 'source-identity', 'verified-change', 'not-verified'];

function reference(value) {
  if (value === null) return null;
  if (exact(value, ['proposalId']) && uuid(value.proposalId)) return 'revision';
  if (exact(value, ['revision']) && hash(value.revision)) return 'revision';
  if (exact(value, ['digest']) && hash(value.digest)) return 'source';
  if (exact(value, ['adapter', 'receipt']) && code(value.adapter) && typeof value.receipt === 'string'
    && /^[A-Za-z0-9_.:-]{1,128}$/.test(value.receipt)) return 'adapter';
  invalid();
}

function claim(value, sources = null) {
  if (!exact(value, ['path', 'digest', 'outcome', 'reason', 'evidence']) || typeof value.path !== 'string'
    || value.path.length < 1 || value.path.length > 4096 || /[\\\x00-\x1f\x7f]/.test(value.path)
    || value.path.split('/').some(part => !part || part === '.' || part === '..') || !hash(value.digest)
    || !['completed', 'skipped', 'blocked'].includes(value.outcome) || !code(value.reason)) invalid();
  if (sources && sources.get(value.path)?.digest !== value.digest) invalid();
  if (reference(value.evidence) === 'source' && value.evidence.digest !== value.digest) invalid();
}

// Keep JSON-encoded text bounded too, including escaping. A truncated prefix
// is never parsed as a complete report. This text remains untrusted display data.
function textPrefix(text) {
  let low = 0, high = Math.min(text.length, DREAM_OUTCOME_LIMITS.textBytes);
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (Buffer.byteLength(JSON.stringify(text.slice(0, middle))) <= DREAM_OUTCOME_LIMITS.textBytes) low = middle;
    else high = middle - 1;
  }
  if (/[\uD800-\uDBFF]/.test(text[low - 1] ?? '') && /[\uDC00-\uDFFF]/.test(text[low] ?? '')) low--;
  return { text: text.slice(0, low), textTruncated: low < text.length };
}

// Version 2 is the journal form: report text lives in the preview store and the
// outcome keeps only its digest and size, so the text can be pruned (#603).
export function validateDreamOutcome(value, { runId = null, inputs = null } = {}) {
  if (!exact(value, ['schemaVersion', 'runId', 'startingRevision', 'report', 'items', 'unreported', 'processingCoverage'])
    || ![1, 2].includes(value.schemaVersion) || !uuid(value.runId) || !hash(value.startingRevision) || value.processingCoverage !== 'unverified'
    || runId !== null && value.runId !== runId || !Array.isArray(value.items) || value.items.length > DREAM_OUTCOME_LIMITS.items
    || !Number.isSafeInteger(value.unreported) || value.unreported < 0 || value.unreported + value.items.length > DREAM_OUTCOME_LIMITS.items) invalid();
  if (inputs) {
    validateDreamInputMetadata(inputs);
    if (value.startingRevision !== inputs.revision || value.unreported + value.items.length !== inputs.sources.length) invalid();
  }
  const report = value.report, seen = new Set(), sources = inputs ? new Map(inputs.sources.map(source => [source.path, source])) : null;
  const field = value.schemaVersion === 1 ? 'text' : 'preview';
  if (!exact(report, ['status', 'code', field, 'textTruncated']) || !statuses.includes(report.status) || typeof report.textTruncated !== 'boolean') invalid();
  if (report.status === 'structured') {
    if (report.code !== null || report[field] !== null || report.textTruncated) invalid();
  } else if (!reportCodes[report.status].includes(report.code) || value.items.length) invalid();
  else if (field === 'text' ? typeof report.text !== 'string' || Buffer.byteLength(JSON.stringify(report.text)) > DREAM_OUTCOME_LIMITS.textBytes
    : !exact(report.preview, ['digest', 'bytes']) || !hash(report.preview.digest) || !Number.isSafeInteger(report.preview.bytes)
      || report.preview.bytes < 0 || report.preview.bytes > DREAM_OUTCOME_LIMITS.textBytes) invalid();
  for (const item of value.items) {
    if (!exact(item, ['claim', 'verification']) || seen.has(item.claim?.path)) invalid();
    claim(item.claim, sources); seen.add(item.claim.path);
    const proof = item.verification;
    if (!exact(proof, ['claim', 'evidence', 'reason', 'artifactRevision', 'proposalStatus', 'attribution'])
      || proof.claim !== 'agent-reported' || !evidenceKinds.includes(proof.evidence) || !(proof.reason === null || code(proof.reason))
      || !(proof.artifactRevision === null || hash(proof.artifactRevision))
      || ![null, 'pending', 'approved', 'rejected', 'uncertain'].includes(proof.proposalStatus) || proof.attribution !== 'not-established') invalid();
    if (proof.evidence === 'verified-change' && (reference(item.claim.evidence) !== 'revision' || proof.artifactRevision === null || proof.reason !== null)) invalid();
    if (proof.evidence === 'source-identity' && reference(item.claim.evidence) !== 'source') invalid();
  }
  if (Buffer.byteLength(JSON.stringify(value)) > DREAM_OUTCOME_LIMITS.bytes) invalid();
  return value;
}

export const dreamPreviewDigest = text => `sha256:${createHash('sha256').update(text, 'utf8').digest('hex')}`;

// Split an inline outcome into its journal form and the preview text to store
// outside the journal. A structured report carries no text.
export function detachDreamPreview(value) {
  validateDreamOutcome(value);
  if (value.schemaVersion === 2) return { outcome: structuredClone(value), text: null };
  const { text, ...report } = value.report;
  const preview = text === null ? null : { digest: dreamPreviewDigest(text), bytes: Buffer.byteLength(text) };
  return { outcome: validateDreamOutcome({ ...structuredClone(value), schemaVersion: 2, report: { ...report, preview } }), text };
}

export const dreamOutcomeDigest = value => `sha256:${createHash('sha256').update(canonicalJson(validateDreamOutcome(value))).digest('hex')}`;

export function interpretDreamReport({ reply = '', replyTruncated = false, run, inputs, endedAt,
  executionFailed = false, verifyRevisionEvidence = null } = {}) {
  validateDreamInputMetadata(inputs);
  if (!uuid(run?.runId) || typeof reply !== 'string' || typeof replyTruncated !== 'boolean') invalid();
  const base = { schemaVersion: 1, runId: run.runId, startingRevision: inputs.revision, processingCoverage: 'unverified' };
  const fallback = (status, code) => validateDreamOutcome({ ...base, report: { status, code, ...textPrefix(reply) }, items: [], unreported: inputs.sources.length });
  if (executionFailed) return fallback('execution-failed', 'execution-failed');
  if (replyTruncated) return fallback('truncated', 'report-truncated');
  if (Buffer.byteLength(reply) > DREAM_OUTCOME_LIMITS.bytes) return fallback('oversized', 'report-limit');
  let report;
  try { report = JSON.parse(reply); }
  catch { return fallback('unstructured', 'no-structured-report'); }
  const sources = new Map(inputs.sources.map(source => [source.path, source])), seen = new Set();
  try {
    if (!exact(report, ['schemaVersion', 'runId', 'startingRevision', 'items']) || report.schemaVersion !== 1
      || report.runId !== run.runId || report.startingRevision !== inputs.revision
      || !Array.isArray(report.items) || report.items.length > DREAM_OUTCOME_LIMITS.items) invalid();
    for (const item of report.items) {
      claim(item, sources);
      if (seen.has(item.path)) invalid();
      seen.add(item.path);
    }
  } catch { return fallback('invalid', 'report-invalid'); }
  const checked = new Map();
  const items = report.items.map(item => {
    const verification = { claim: 'agent-reported', evidence: 'agent-reported', reason: null,
      artifactRevision: null, proposalStatus: null, attribution: 'not-established' };
    const kind = reference(item.evidence);
    if (kind === 'source') verification.evidence = 'source-identity';
    if (kind === 'adapter') verification.reason = 'adapter-unavailable';
    if (kind === 'revision') {
      const key = canonicalJson(item.evidence);
      if (!checked.has(key) && checked.size < DREAM_OUTCOME_LIMITS.references) {
        let result = null;
        try {
          if (typeof verifyRevisionEvidence === 'function') result = verifyRevisionEvidence({ agentId: run.agentId, startingRevision: inputs.revision,
            delivered: inputs.sources.map(({ path, digest, truncated }) => ({ path, digest, truncated })), reference: item.evidence,
            runWindow: { startedAt: run.startedAt, endedAt } });
          if (typeof result?.then === 'function') { Promise.resolve(result).catch(() => {}); result = null; }
        } catch { /* no raw verifier error or path enters the outcome */ }
        checked.set(key, result);
      }
      const result = checked.get(key);
      verification.evidence = 'not-verified';
      verification.reason = !checked.has(key) ? 'evidence-limit' : result === null ? 'evidence-unavailable' : 'artifact-not-verified';
      if (result?.verdict === 'verified-change' && result.attribution === 'not-established'
        && hash(result.checked?.event?.revision) && [null, 'pending', 'approved', 'rejected', 'uncertain'].includes(result.checked.event.status)
        && Array.isArray(result.checked?.changedPaths) && result.checked.changedPaths.some(change => change.path === item.path)) {
        verification.evidence = 'verified-change'; verification.reason = null;
        verification.artifactRevision = result.checked.event.revision;
        verification.proposalStatus = result.checked.event.status;
      } else if (result?.verdict === 'verified-change') {
        verification.reason = 'artifact-does-not-change-source';
      }
    }
    return { claim: item, verification };
  });
  try {
    return validateDreamOutcome({ ...base, report: { status: 'structured', code: null, text: null, textTruncated: false },
      items, unreported: inputs.sources.length - items.length }, { runId: run.runId, inputs });
  } catch { return fallback('invalid', 'report-limit'); }
}
