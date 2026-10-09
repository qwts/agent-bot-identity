// Dream notices (#603): deduplicated conditions a host reads and acknowledges.
// Derived only from a run's terminal facts and its validated bounded outcome.
// This module keeps no state, has no clock and delivers nothing: without a
// configured delivery adapter a notice is pending host read, never delivered.
import { createHash } from 'node:crypto';
import { canonicalJson } from './soul-package.mjs';
import { validateDreamOutcome } from './skill-dream-outcomes.mjs';

export const DREAM_NOTICE_LIMITS = Object.freeze({ perSoul: 64, conditionsPerRun: 32 });
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
const HOST = new Set(['execution', 'report', 'evidence']);

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
  const ids = new Set(), active = new Set();
  for (const notice of ledger.notices) {
    if (!exact(notice, ['id', 'fingerprint', 'kind', 'subject', 'detail', 'claim', 'state', 'delivery', 'firstRunId', 'lastRunId',
      'firstSeenAt', 'lastSeenAt', 'occurrences', 'acknowledgedAt', 'clearedAt'])
      || typeof notice.id !== 'string' || !NOTICE_ID.test(notice.id) || ids.has(notice.id)
      || !Object.hasOwn(KINDS, notice.kind) || !subjectValid(notice.kind, notice.subject) || !code(notice.detail)
      || notice.claim !== KINDS[notice.kind].claim
      || notice.fingerprint !== dreamNoticeFingerprint(ledger.agentId, notice.kind, notice.subject)
      || notice.id !== noticeId(notice.fingerprint, notice.firstRunId)
      || !['open', 'acknowledged', 'cleared'].includes(notice.state)
      || notice.delivery !== (notice.acknowledgedAt === null ? 'pending-host-read' : 'host-acknowledged')
      || !uuid(notice.firstRunId) || !uuid(notice.lastRunId) || !date(notice.firstSeenAt) || !date(notice.lastSeenAt)
      || !Number.isSafeInteger(notice.occurrences) || notice.occurrences < 1
      || !(notice.acknowledgedAt === null || date(notice.acknowledgedAt)) || !(notice.clearedAt === null || date(notice.clearedAt))
      || (notice.state === 'open') !== (notice.acknowledgedAt === null && notice.clearedAt === null)
      || notice.state === 'acknowledged' && (notice.acknowledgedAt === null || notice.clearedAt !== null)
      || notice.state === 'cleared' && notice.clearedAt === null) invalid();
    ids.add(notice.id);
    if (notice.state !== 'cleared') {
      // At most one live notice per condition: deduplication is this invariant.
      if (active.has(notice.fingerprint)) invalid();
      active.add(notice.fingerprint);
    }
  }
  return ledger;
}

const noticeId = (fingerprint, runId) => `ntc_${sha(`${fingerprint}\n${runId}`).slice(0, 24)}`;

// Applies one terminal run. Run ID and timestamps never enter a fingerprint,
// so a persisting condition renews its live notice instead of notifying every
// interval; a recurrence after an observed clear creates a new notice. Runs
// must be applied in journal order: only the latest run ID is idempotent.
export function applyDreamNoticeRun(ledger, { run, outcome = null, inputs = null }) {
  validateDreamNoticeLedger(ledger);
  if (run?.agentId !== ledger.agentId || !date(run.endedAt)) invalid();
  if (ledger.lastRunId === run.runId) return { ledger, created: [], renewed: [], cleared: [], suppressed: 0 };
  const { conditions, observes } = dreamNoticeConditions({ run, outcome, inputs });
  const at = run.endedAt, next = structuredClone(ledger), seen = new Map();
  let suppressed = 0;
  for (const condition of conditions) {
    const fingerprint = dreamNoticeFingerprint(ledger.agentId, condition.kind, condition.subject);
    if (seen.has(fingerprint)) continue;
    if (seen.size >= DREAM_NOTICE_LIMITS.conditionsPerRun) { suppressed++; continue; }
    seen.set(fingerprint, condition);
  }
  const created = [], renewed = [], cleared = [];
  for (const notice of next.notices) {
    if (notice.state === 'cleared' || seen.has(notice.fingerprint) || !observed(notice, observes)) continue;
    Object.assign(notice, { state: 'cleared', clearedAt: at });
    cleared.push(notice.id);
  }
  for (const [fingerprint, condition] of seen) {
    const live = next.notices.find(notice => notice.fingerprint === fingerprint && notice.state !== 'cleared');
    if (live) {
      Object.assign(live, { detail: condition.detail, lastRunId: run.runId, lastSeenAt: at, occurrences: live.occurrences + 1 });
      renewed.push(live.id);
      continue;
    }
    const notice = { id: noticeId(fingerprint, run.runId), fingerprint, kind: condition.kind, subject: condition.subject,
      detail: condition.detail, claim: KINDS[condition.kind].claim, state: 'open', delivery: 'pending-host-read',
      firstRunId: run.runId, lastRunId: run.runId, firstSeenAt: at, lastSeenAt: at, occurrences: 1, acknowledgedAt: null, clearedAt: null };
    next.notices.push(notice);
    created.push(notice.id);
  }
  // Retention: only cleared notices are dropped, oldest first, so a live
  // (even acknowledged) condition is never re-notified by eviction. Beyond
  // that, a new host-observed failure displaces an agent-reported blocked
  // item, so agent claims cannot starve it; any live notice dropped is
  // counted as suppressed rather than silently lost.
  const oldest = list => list.sort((a, b) => (a.clearedAt ?? a.lastSeenAt).localeCompare(b.clearedAt ?? b.lastSeenAt))[0];
  while (next.notices.length > DREAM_NOTICE_LIMITS.perSoul) {
    const fresh = next.notices.filter(notice => created.includes(notice.id));
    const host = fresh.find(notice => HOST.has(notice.kind));
    let victim = oldest(next.notices.filter(notice => notice.state === 'cleared'));
    if (!victim && host) {
      // Prefer a claim the host already read: it may renotify once, while an
      // unread one would be lost (and is then counted as suppressed).
      const claims = next.notices.filter(notice => notice.kind === 'item-blocked' && !created.includes(notice.id));
      victim = oldest(claims.filter(notice => notice.state === 'acknowledged')) ?? oldest(claims);
    }
    victim ??= fresh.findLast(notice => !HOST.has(notice.kind)) ?? fresh.at(-1);
    if (created.includes(victim.id)) created.splice(created.indexOf(victim.id), 1);
    if (victim.state !== 'cleared') suppressed++;
    next.notices.splice(next.notices.indexOf(victim), 1);
  }
  next.lastRunId = run.runId;
  next.suppressed += suppressed;
  return { ledger: validateDreamNoticeLedger(next), created, renewed, cleared, suppressed };
}

// An authorized host read. Idempotent; acknowledging does not clear the
// condition, so a persisting problem stays deduplicated rather than renotifying.
export function acknowledgeDreamNotice(ledger, { noticeId: id, at }) {
  validateDreamNoticeLedger(ledger);
  if (!date(at)) invalid();
  const next = structuredClone(ledger), notice = next.notices.find(item => item.id === id);
  if (!notice) throw Object.assign(new Error('No dream notice with that ID belongs to this soul.'), { code: 'dream-notice-not-found' });
  if (notice.acknowledgedAt === null) {
    Object.assign(notice, { acknowledgedAt: at, delivery: 'host-acknowledged', ...(notice.state === 'open' ? { state: 'acknowledged' } : {}) });
  }
  return validateDreamNoticeLedger(next);
}
