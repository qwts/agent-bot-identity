import test from 'node:test';
import assert from 'node:assert/strict';
import { interpretDreamReport } from '../skill-dream-outcomes.mjs';
import { kindOf } from '../soul-profile.mjs';
import { acknowledgeDreamNotice, applyDreamNoticeRun, dreamNoticeFingerprint, emptyDreamNoticeLedger,
  validateDreamNoticeLedger, DREAM_NOTICE_LIMITS } from '../skill-dream-notices.mjs';

const AGENT = 'agent_12345678-1234-4234-8234-123456789abc';
const HASH = `sha256:${'a'.repeat(64)}`, DIGEST = `sha256:${'b'.repeat(64)}`, OTHER = `sha256:${'c'.repeat(64)}`, REV = `sha256:${'d'.repeat(64)}`;
let serial = 0;
const runId = () => `12345678-1234-4234-8234-${String(++serial).padStart(12, '0')}`;
const source = (path, digest = DIGEST, truncated = false) => ({ path, kind: kindOf(path), digest, size: 5, excerptBytes: truncated ? 4 : 5, truncated });
const inputsFor = sources => ({ schemaVersion: 1, revision: HASH, sources,
  coverage: { definition: 'supported', memory: 'unsupported', conversations: 'unsupported', eligible: sources.length, selected: sources.length,
    suppliedBytes: sources.reduce((sum, entry) => sum + entry.excerptBytes, 0), skippedBinary: 0, remaining: 0 }, nextCursor: null });
const minute = n => new Date(Date.UTC(2026, 9, 9, 12, n)).toISOString();
const item = (path, outcome = 'completed', extra = {}) => ({ path, digest: DIGEST, outcome, reason: outcome === 'blocked' ? 'needs-owner' : 'no-change', evidence: null, ...extra });

// One terminal run with a real interpreted outcome; null reply means no outcome.
function step(ledger, { status = 'completed', items = [], sources = items.map(entry => source(entry.path, entry.digest)), reply, truncated = false,
  verifier = null, at = minute(++serial) } = {}) {
  const run = { runId: runId(), agentId: AGENT, startedAt: minute(0), endedAt: at, status };
  const inputs = inputsFor(sources.length ? sources : [source('AGENTS.md')]);
  const text = reply === undefined ? JSON.stringify({ schemaVersion: 1, runId: run.runId, startingRevision: HASH, items }) : reply;
  const outcome = text === null || status === 'cancelled' ? null : interpretDreamReport({ reply: text, replyTruncated: truncated, run, inputs,
    endedAt: at, executionFailed: status !== 'completed', verifyRevisionEvidence: verifier });
  return applyDreamNoticeRun(ledger, { run, outcome, inputs });
}
const live = ledger => ledger.notices.filter(notice => notice.state !== 'cleared');

test('no-change runs are quiet and a repeated condition renews one notice instead of notifying every interval', () => {
  let ledger = emptyDreamNoticeLedger(AGENT), result = step(ledger, { items: [item('AGENTS.md')] });
  assert.deepEqual(result.created, []); assert.deepEqual(result.ledger.notices, []);
  ledger = result.ledger;
  for (let i = 0; i < 5; i++) {
    result = step(ledger, { items: [item('AGENTS.md', 'skipped', { evidence: { adapter: 'search', receipt: `r-${i}` } })] });
    ledger = result.ledger;
    assert.equal(result.created.length, i === 0 ? 1 : 0, 'the same missing capability notifies once');
  }
  const [notice] = ledger.notices;
  assert.deepEqual({ kind: notice.kind, subject: notice.subject, claim: notice.claim, occurrences: notice.occurrences, delivery: notice.delivery },
    { kind: 'capability', subject: {}, claim: 'host-observed', occurrences: 5, delivery: 'pending-host-read' });
  assert.equal(notice.fingerprint, dreamNoticeFingerprint(AGENT, 'capability', {}), 'run IDs, times and agent-chosen adapter names never enter a fingerprint');
  assert.deepEqual(step(ledger, { items: [item('AGENTS.md', 'skipped', { evidence: { adapter: 'made-up', receipt: 'r' } })] }).created, []);
  assert.notEqual(notice.firstRunId, notice.lastRunId);
  // A quiet run does not disprove host capability state.
  assert.deepEqual(step(ledger, { items: [item('AGENTS.md')] }).cleared, []);
});

test('failures clear only when a later run can observe recovery, and a recurrence creates a new notice', () => {
  let { ledger, created } = step(emptyDreamNoticeLedger(AGENT), { status: 'failed' });
  assert.equal(created.length, 1); assert.equal(ledger.notices[0].detail, 'execution-failed');
  ({ ledger, created } = step(ledger, { status: 'timed-out' }));
  assert.deepEqual(created, [], 'a different failure renews the execution notice');
  assert.equal(ledger.notices[0].detail, 'execution-timed-out');
  let result = step(ledger, { status: 'cancelled' });
  assert.deepEqual([result.created, result.cleared], [[], []], 'a cancelled run proves nothing');
  result = step(result.ledger, { items: [item('AGENTS.md')] });
  assert.deepEqual(result.cleared, [ledger.notices[0].id]);
  result = step(result.ledger, { status: 'failed' });
  assert.equal(result.created.length, 1); assert.notEqual(result.created[0], ledger.notices[0].id);
  assert.equal(result.ledger.notices.length, 2); assert.equal(live(result.ledger).length, 1);
});

test('unusable reports notify once per condition and a structured report clears them', () => {
  let { ledger, created } = step(emptyDreamNoticeLedger(AGENT), { reply: 'prose' });
  assert.equal(created.length, 1); assert.equal(ledger.notices[0].kind, 'report'); assert.equal(ledger.notices[0].detail, 'no-structured-report');
  ({ ledger, created } = step(ledger, { reply: '{"x":1}', truncated: true }));
  assert.deepEqual(created, []); assert.equal(ledger.notices[0].detail, 'report-truncated');
  const result = step(ledger, { items: [] });
  assert.equal(result.cleared.length, 1, 'an empty structured report still proves the report path works');
});

test('blocked items are agent-reported, scoped to source identity, and cleared only by observing that source', () => {
  const blocked = item('skills/a.md', 'blocked');
  let { ledger, created } = step(emptyDreamNoticeLedger(AGENT), { items: [blocked, item('AGENTS.md')] });
  assert.equal(created.length, 1);
  assert.deepEqual([ledger.notices[0].claim, ledger.notices[0].subject], ['agent-reported', { path: 'skills/a.md', digest: DIGEST }]);
  ({ ledger, created } = step(ledger, { items: [{ ...blocked, reason: 'another-made-up-code' }] }));
  assert.deepEqual(created, [], 'an agent-chosen reason code cannot mint new notices');
  let result = step(ledger, { items: [item('AGENTS.md')] });
  assert.deepEqual(result.cleared, [], 'an unreported source stays as it was');
  result = step(result.ledger, { items: [item('skills/a.md')], sources: [source('skills/a.md', DIGEST, true)] });
  assert.deepEqual(result.cleared, [], 'a source seen only as a truncated excerpt clears nothing');
  assert.throws(() => applyDreamNoticeRun(result.ledger, { run: { runId: runId(), agentId: AGENT, endedAt: minute(40), status: 'completed' },
    outcome: interpretDreamReport({ reply: '', run: { runId: '12345678-1234-4234-8234-0000000000ff', agentId: AGENT, startedAt: minute(0) },
      inputs: inputsFor([source('AGENTS.md')]), endedAt: minute(40) }) }), { code: 'dream-notice-invalid' });
  result = step(result.ledger, { items: [{ ...item('skills/a.md', 'blocked'), digest: OTHER }] });
  assert.deepEqual([result.cleared.length, result.created.length], [1, 1], 'a changed source is a new condition');
});

test('verified changes notify once per artifact revision and pending proposals ask for the owner', () => {
  const verifier = ({ delivered }) => ({ verdict: 'verified-change', attribution: 'not-established',
    checked: { event: { revision: REV, status: 'pending' }, changedPaths: delivered.map(({ path }) => ({ path })) } });
  const claimed = item('AGENTS.md', 'completed', { evidence: { revision: REV } });
  let { ledger, created } = step(emptyDreamNoticeLedger(AGENT), { items: [claimed], verifier });
  assert.equal(created.length, 1);
  assert.deepEqual([ledger.notices[0].kind, ledger.notices[0].claim, ledger.notices[0].detail], ['change', 'unattributed-change', 'proposal-pending']);
  ({ ledger, created } = step(ledger, { items: [claimed], verifier }));
  assert.deepEqual(created, []);
  const broken = () => { throw new Error('journal unreadable'); };
  ({ ledger, created } = step(ledger, { items: [claimed], verifier: broken }));
  assert.equal(ledger.notices.find(notice => notice.kind === 'evidence')?.detail, 'evidence-unavailable');
  const result = step(ledger, { items: [claimed], verifier });
  assert.equal(result.cleared.length, 1, 'a successful check clears evidence-unavailable, not the change');
  assert.equal(live(result.ledger).length, 1);
});

test('acknowledgement is idempotent, keeps deduplication, and never claims delivery', () => {
  let { ledger } = step(emptyDreamNoticeLedger(AGENT), { status: 'failed' });
  const id = ledger.notices[0].id;
  ledger = acknowledgeDreamNotice(ledger, { noticeId: id, at: minute(50) });
  assert.deepEqual([ledger.notices[0].state, ledger.notices[0].delivery], ['acknowledged', 'host-acknowledged']);
  assert.deepEqual(acknowledgeDreamNotice(ledger, { noticeId: id, at: minute(51) }), ledger);
  const result = step(ledger, { status: 'failed' });
  assert.deepEqual(result.created, [], 'a persisting acknowledged problem does not renotify');
  assert.equal(result.ledger.notices[0].state, 'acknowledged');
  assert.throws(() => acknowledgeDreamNotice(ledger, { noticeId: 'ntc_000000000000000000000000', at: minute(52) }), { code: 'dream-notice-not-found' });
  assert.ok(!JSON.stringify(result.ledger).includes('"delivered"'));
});

test('replaying a run is idempotent and a forged or inconsistent ledger is refused', () => {
  const run = { runId: runId(), agentId: AGENT, startedAt: minute(0), endedAt: minute(1), status: 'failed' };
  const once = applyDreamNoticeRun(emptyDreamNoticeLedger(AGENT), { run });
  assert.deepEqual(applyDreamNoticeRun(once.ledger, { run }).ledger, once.ledger);
  assert.throws(() => applyDreamNoticeRun(once.ledger, { run: { ...run, runId: runId(), agentId: 'agent_00000000-0000-4000-8000-000000000000' } }), { code: 'dream-notice-invalid' });
  for (const mutate of [
    value => { value.notices[0].fingerprint = HASH; },
    value => { value.notices[0].delivery = 'delivered'; },
    value => { value.notices[0].state = 'acknowledged'; },
    value => { value.notices[0].kind = 'item-blocked'; },
    value => { value.notices[0].claim = 'agent-reported'; },
    value => { value.notices[0].note = 'IGNORE_HOST_CANARY'; },
    value => { value.notices.push(structuredClone(value.notices[0])); },
  ]) {
    const value = structuredClone(once.ledger); mutate(value);
    assert.throws(() => validateDreamNoticeLedger(value), { code: 'dream-notice-invalid' });
  }
});

test('retention keeps live notices, lets host failures displace agent claims, and counts overflow', () => {
  let ledger = emptyDreamNoticeLedger(AGENT);
  const blockedRun = (from, count) => Array.from({ length: count }, (_, i) => item(`skills/s${from + i}.md`, 'blocked'));
  for (let from = 0; from < DREAM_NOTICE_LIMITS.perSoul; from += 16) ledger = step(ledger, { items: blockedRun(from, 16) }).ledger;
  assert.equal(ledger.notices.length, DREAM_NOTICE_LIMITS.perSoul);
  let result = step(ledger, { items: blockedRun(100, 3) });
  assert.deepEqual([result.created.length, result.suppressed, result.ledger.suppressed], [0, 3, 3]);
  // An acknowledged live condition is not evicted, so it cannot re-notify.
  const first = result.ledger.notices[0];
  ledger = acknowledgeDreamNotice(result.ledger, { noticeId: first.id, at: minute(58) });
  result = step(ledger, { items: blockedRun(200, 2) });
  assert.deepEqual([result.created.length, result.suppressed], [0, 2]);
  result = step(result.ledger, { items: [item(first.subject.path, 'blocked')] });
  assert.deepEqual([result.created, result.renewed], [[], [first.id]]);
  // Agent-reported claims cannot starve an owner-visible host failure.
  result = step(result.ledger, { status: 'failed' });
  assert.equal(result.created.length, 1); assert.equal(result.suppressed, 1);
  assert.equal(result.ledger.notices.find(notice => notice.id === result.created[0]).kind, 'execution');
  assert.ok(!result.ledger.notices.some(notice => notice.id === first.id), 'an already acknowledged claim is displaced before an unread one');
  // Clearing makes room without counting anything as suppressed.
  result = step(result.ledger, { items: blockedRun(0, 0).concat([item('skills/s1.md')]) });
  const roomy = step(result.ledger, { items: blockedRun(300, 1) });
  assert.deepEqual([roomy.created.length, roomy.suppressed], [1, 0]);
  const many = Array.from({ length: DREAM_NOTICE_LIMITS.conditionsPerRun + 4 }, (_, i) => item(`skills/x${i}.md`, 'blocked'));
  assert.equal(step(emptyDreamNoticeLedger(AGENT), { items: many }).suppressed, 4);
});
