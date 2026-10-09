// Dream notices (#603): deduplicated conditions a host reads and acknowledges.
// Derived only from a run's terminal facts and its validated bounded outcome.
// This module keeps no state, has no clock and delivers nothing: without a
// configured delivery adapter a notice is pending host read, never delivered.
import { createHash } from 'node:crypto';
import { canonicalJson } from './soul-package.mjs';
import { validateDreamOutcome } from './skill-dream-outcomes.mjs';

// Only live notices are retained, and they live in scheduler state that every
// journal transaction copies, so each soul's set is small and byte-bounded.
export const DREAM_NOTICE_LIMITS = Object.freeze({ perSoul: 16, hostSlots: 3, bytes: 8 * 1024 });
const HASH = /^sha256:[a-f0-9]{64}$/;
const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const CODE = /^[a-z][a-z0-9-]{0,63}$/;
const NOTICE_ID = /^ntc_[a-f0-9]{24}$/;
const AGENT = /^agent_[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const exact = (value, names) => value && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).length === names.length && names.every(name => Object.hasOwn(value, name));
const hash = value => typeof value === 'string' && value.length === 71 && HASH.test(value);
const uuid = value => typeof value === 'string' && value.length === 36 && UUID.test(value);
const code = value => typeof value === 'string' && CODE.test(value);
const date = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)
  && new Date(value).toISOString() === value;
const invalid = () => { throw Object.assign(new Error('Invalid dream notice state.'), { code: 'dream-notice-invalid' }); };
const sha = value => createHash('sha256').update(value).digest('hex');

// Kind → subject fields, whose claim the notice carries. Agent-chosen text
// (reason codes, adapter names) never widens a fingerprint beyond these. No
// adapter is configurable yet, so the host fact is "no adapter", not which.
// A verified change is still not attributed to the run that reported it.
const KINDS = Object.freeze({
  execution: { subject: [], claim: 'host-observed' },
  report: { subject: [], claim: 'host-observed' },
  evidence: { subject: [], claim: 'host-observed' },
  'item-blocked': { subject: ['path', 'digest'], claim: 'agent-reported' },
  capability: { subject: [], claim: 'host-observed' },
  change: { subject: ['revision'], claim: 'unattributed-change' },
});
const CHANGE_DETAIL = { pending: 'proposal-pending', approved: 'revision-approved', rejected: 'proposal-rejected',
  uncertain: 'proposal-uncertain', null: 'revision-recorded' };
const path = value => typeof value === 'string' && value.length >= 1 && value.length <= 4096 && !/[\\\x00-\x1f\x7f]/.test(value)
  && value.split('/').every(part => part && part !== '.' && part !== '..');
const subjectValid = (kind, subject) => exact(subject, KINDS[kind].subject)
  && (kind !== 'item-blocked' || path(subject.path) && hash(subject.digest))
  && (kind !== 'change' || hash(subject.revision));
// Subject-less host kinds have at most one live notice each. Their slots and
// bytes are reserved so agent-reported conditions can never crowd them out.
const HOST = new Set(['execution', 'report', 'evidence']);
const CLAIM_SLOTS = DREAM_NOTICE_LIMITS.perSoul - DREAM_NOTICE_LIMITS.hostSlots;
// A notice is charged at its growth ceiling (longest detail, acknowledged,
// largest counter), so renewing or acknowledging it can never exceed the budget.
const ceiling = notice => Buffer.byteLength(JSON.stringify({ ...notice, detail: 'x'.repeat(64), state: 'acknowledged',
  delivery: 'host-acknowledged', occurrences: Number.MAX_SAFE_INTEGER, acknowledgedAt: '2000-01-01T00:00:00.000Z' }));
const SAMPLE_ID = '00000000-0000-4000-8000-000000000000', SAMPLE_AT = '2000-01-01T00:00:00.000Z';
const HOST_BYTES = Math.max(...[...HOST].map(kind => ceiling({ id: `ntc_${'0'.repeat(24)}`, fingerprint: `sha256:${'0'.repeat(64)}`, kind,
  subject: {}, detail: '', claim: KINDS[kind].claim, state: '', delivery: '', firstRunId: SAMPLE_ID, lastRunId: SAMPLE_ID,
  firstSeenAt: SAMPLE_AT, lastSeenAt: SAMPLE_AT, occurrences: 0, acknowledgedAt: null })));
const CLAIM_BYTES = DREAM_NOTICE_LIMITS.bytes - DREAM_NOTICE_LIMITS.hostSlots * HOST_BYTES;
const claimBytes = notices => notices.filter(notice => !HOST.has(notice.kind)).reduce((sum, notice) => sum + ceiling(notice), 0);

export const dreamNoticeFingerprint = (agentId, kind, subject) =>
  `sha256:${sha(canonicalJson({ schemaVersion: 1, agentId, kind, subject }))}`;

// Conditions present in this run, plus what this run could observe. A
// condition outside the observed scope is neither renewed nor cleared: a
// cancelled run proves nothing, and an unreported source stays as it was. An
// outcome needs the run's prepared input metadata: a source supplied only as a
// truncated excerpt was not fully seen, so a report on it clears nothing.
export function dreamNoticeConditions({ run, outcome = null, inputs = null }) {
  if (!uuid(run?.runId) || !['completed', 'failed', 'cancelled', 'timed-out'].includes(run.status)) invalid();
  if (outcome !== null && inputs === null) invalid();
  if (outcome !== null) validateDreamOutcome(outcome, { runId: run.runId, inputs });
  // Only a completed attempt's report is evidence. Any other settled attempt
  // carries no outcome or the fixed execution-failed one (the service stages
  // that when a stopped executor rejects); a cancelled attempt observes nothing.
  if (outcome !== null && (run.status === 'completed') === (outcome.report.status === 'execution-failed')) invalid();
  const partial = new Set((inputs?.sources ?? []).filter(source => source.truncated).map(source => source.path));
  const conditions = [], observes = { kinds: new Set(), paths: new Set() };
  const add = (kind, subject, detail) => conditions.push({ kind, subject, detail });
  if (run.status !== 'cancelled') observes.kinds.add('execution');
  if (['failed', 'timed-out'].includes(run.status)) add('execution', {}, `execution-${run.status}`);
  const report = outcome?.report;
  if (report && report.status !== 'execution-failed') {
    observes.kinds.add('report');
    if (report.status !== 'structured') add('report', {}, report.code);
  }
  if (report?.status === 'structured') {
    let checkedRevision = false, unavailable = false;
    for (const { claim, verification } of outcome.items) {
      if (!partial.has(claim.path)) observes.paths.add(claim.path);
      if (claim.outcome === 'blocked') add('item-blocked', { path: claim.path, digest: claim.digest }, claim.reason);
      if (verification.reason === 'adapter-unavailable') add('capability', {}, 'adapter-unavailable');
      if (verification.evidence === 'verified-change' || verification.evidence === 'not-verified' && verification.reason !== 'evidence-limit') {
        checkedRevision = true;
        if (verification.reason === 'evidence-unavailable') unavailable = true;
      }
      if (verification.evidence === 'verified-change') {
        add('change', { revision: verification.artifactRevision }, CHANGE_DETAIL[verification.proposalStatus]);
      }
    }
    if (checkedRevision) observes.kinds.add('evidence');
    if (unavailable) add('evidence', {}, 'evidence-unavailable');
  }
  return { conditions, observes };
}

function observed(notice, observes) {
  if (notice.kind === 'item-blocked') return observes.paths.has(notice.subject.path);
  // Host capability state and recorded changes are not disproved by a quiet run.
  if (notice.kind === 'capability' || notice.kind === 'change') return false;
  return observes.kinds.has(notice.kind);
}

export const emptyDreamNoticeLedger = agentId => validateDreamNoticeLedger({ schemaVersion: 1, agentId, lastRunId: null, suppressed: 0, notices: [] });

export function validateDreamNoticeLedger(ledger) {
  if (!exact(ledger, ['schemaVersion', 'agentId', 'lastRunId', 'suppressed', 'notices']) || ledger.schemaVersion !== 1
    || typeof ledger.agentId !== 'string' || !AGENT.test(ledger.agentId) || !(ledger.lastRunId === null || uuid(ledger.lastRunId))
    || !Number.isSafeInteger(ledger.suppressed) || ledger.suppressed < 0
    || !Array.isArray(ledger.notices) || ledger.notices.length > DREAM_NOTICE_LIMITS.perSoul) invalid();
  const ids = new Set(), live = new Set();
  for (const notice of ledger.notices) {
    if (!exact(notice, ['id', 'fingerprint', 'kind', 'subject', 'detail', 'claim', 'state', 'delivery', 'firstRunId', 'lastRunId',
      'firstSeenAt', 'lastSeenAt', 'occurrences', 'acknowledgedAt'])
      || typeof notice.id !== 'string' || !NOTICE_ID.test(notice.id) || ids.has(notice.id)
      || !Object.hasOwn(KINDS, notice.kind) || !subjectValid(notice.kind, notice.subject) || !code(notice.detail)
      || notice.claim !== KINDS[notice.kind].claim
      || notice.fingerprint !== dreamNoticeFingerprint(ledger.agentId, notice.kind, notice.subject)
      || notice.id !== noticeId(notice.fingerprint, notice.firstRunId)
      || notice.state !== (notice.acknowledgedAt === null ? 'open' : 'acknowledged')
      || notice.delivery !== (notice.acknowledgedAt === null ? 'pending-host-read' : 'host-acknowledged')
      || !uuid(notice.firstRunId) || !uuid(notice.lastRunId) || !date(notice.firstSeenAt) || !date(notice.lastSeenAt)
      || !Number.isSafeInteger(notice.occurrences) || notice.occurrences < 1
      || !(notice.acknowledgedAt === null || date(notice.acknowledgedAt))
      // At most one live notice per condition: deduplication is this invariant.
      || live.has(notice.fingerprint)) invalid();
    ids.add(notice.id); live.add(notice.fingerprint);
  }
  if (ledger.notices.filter(notice => !HOST.has(notice.kind)).length > CLAIM_SLOTS || claimBytes(ledger.notices) > CLAIM_BYTES) invalid();
  return ledger;
}

const noticeId = (fingerprint, runId) => `ntc_${sha(`${fingerprint}\n${runId}`).slice(0, 24)}`;

// Applies one terminal run. Run ID and timestamps never enter a fingerprint,
// so a persisting condition renews its live notice instead of notifying every
// interval. A cleared notice leaves the ledger (it is returned for the
// append-only journal), so a recurrence after an observed clear creates a new
// notice. Runs must be applied in journal order: only the latest is idempotent.
export function applyDreamNoticeRun(ledger, { run, outcome = null, inputs = null }) {
  validateDreamNoticeLedger(ledger);
  if (run?.agentId !== ledger.agentId || !date(run.endedAt)) invalid();
  if (ledger.lastRunId === run.runId) return { ledger, created: [], renewed: [], cleared: [], suppressed: 0 };
  const { conditions, observes } = dreamNoticeConditions({ run, outcome, inputs });
  const at = run.endedAt, next = structuredClone(ledger), present = new Map();
  // Presence is the full bounded condition set (an outcome has at most 100
  // items): an admission limit must never make a persisting condition look
  // recovered. Host conditions come first so they are admitted first.
  for (const condition of [...conditions.filter(item => HOST.has(item.kind)), ...conditions.filter(item => !HOST.has(item.kind))]) {
    const fingerprint = dreamNoticeFingerprint(ledger.agentId, condition.kind, condition.subject);
    if (!present.has(fingerprint)) present.set(fingerprint, condition);
  }
  const cleared = next.notices.filter(notice => !present.has(notice.fingerprint) && observed(notice, observes));
  next.notices = next.notices.filter(notice => !cleared.includes(notice));
  const created = [], renewed = [];
  let suppressed = 0;
  for (const [fingerprint, condition] of present) {
    const live = next.notices.find(notice => notice.fingerprint === fingerprint);
    if (live) {
      Object.assign(live, { detail: condition.detail, lastRunId: run.runId, lastSeenAt: at, occurrences: live.occurrences + 1 });
      renewed.push(live.id);
      continue;
    }
    const notice = { id: noticeId(fingerprint, run.runId), fingerprint, kind: condition.kind, subject: condition.subject,
      detail: condition.detail, claim: KINDS[condition.kind].claim, state: 'open', delivery: 'pending-host-read',
      firstRunId: run.runId, lastRunId: run.runId, firstSeenAt: at, lastSeenAt: at, occurrences: 1, acknowledgedAt: null };
    // A live notice, read or not, is never evicted, so eviction cannot cause a
    // renotification. A claim with no slot or bytes left is counted, not lost silently.
    const claims = next.notices.filter(item => !HOST.has(item.kind));
    if (!HOST.has(condition.kind) && (claims.length >= CLAIM_SLOTS || claimBytes(claims) + ceiling(notice) > CLAIM_BYTES)) { suppressed++; continue; }
    next.notices.push(notice);
    created.push(notice.id);
  }
  next.lastRunId = run.runId;
  next.suppressed += suppressed;
  return { ledger: validateDreamNoticeLedger(next), created, renewed,
    cleared: cleared.map(notice => ({ ...notice, clearedAt: at })), suppressed };
}

// An authorized host read. Idempotent; acknowledging does not clear the
// condition, so a persisting problem stays deduplicated rather than renotifying.
export function acknowledgeDreamNotice(ledger, { noticeId: id, at }) {
  validateDreamNoticeLedger(ledger);
  if (!date(at)) invalid();
  const next = structuredClone(ledger), notice = next.notices.find(item => item.id === id);
  if (!notice) throw Object.assign(new Error('No live dream notice with that ID belongs to this soul.'), { code: 'dream-notice-not-found' });
  if (notice.acknowledgedAt === null) Object.assign(notice, { acknowledgedAt: at, state: 'acknowledged', delivery: 'host-acknowledged' });
  return validateDreamNoticeLedger(next);
}
