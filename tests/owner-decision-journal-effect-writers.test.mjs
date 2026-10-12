// The disabled owner-decision effect writers (agent-comms#77, C2): completion
// (slot 10, entered -> completed) and the final pre-effect refusal (slot 7).
// Each test builds a request in scratch state with the typed fixture records,
// enters it through the store, then drives the writers.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { canonicalJson } from '../canonical-json.mjs';
import { encodeDaemonJournalFrame, requestDirectoryName } from '../identity/owner-decision-journal-frame.mjs';
import { acquireDaemonJournalLock, createDaemonJournalStore, initializeDaemonJournal } from '../identity/owner-decision-journal-store.mjs';
import { REFUSAL_OUTCOMES, challengeFor } from '../identity/owner-decision-evidence.mjs';
import * as host from '../identity-host.mjs';
import * as soul from '../identity-soul.mjs';

const fixture = JSON.parse(fs.readFileSync(new URL('./fixtures/owner-decisions/effect-evidence-v1.json', import.meta.url), 'utf8'));
const byId = (id) => fixture.records.find((record) => record.id === id);
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const darwin = { skip: process.platform !== 'darwin' && 'the journal lock is Darwin-only' };
const namespaceDigest = 'a'.repeat(64);
const template = byId('approve-preparation').record;
const AT = 2_000_000_010;
const PRE_ENTRY = ['preparation', 'prepared-challenge', 'presence', 'receipt', 'successful-check'];

// The cold-wake parameters each fixture preparation implies.
function coldParameters(id, p) {
  const mode = id.replace(/^wake-/, '').replace(/-preparation$/, '');
  return mode.startsWith('resume') ? { mode: 'resume', policy: mode.replace('resume-', '') }
    : mode === 'webhook' ? { mode, stagingId: p.stage.stagingId, configurationDigest: p.stage.contentDigest, host: 'example.com' } : { mode };
}

// One request of the given operation (a cold-wake one from the named fixture
// preparation), its slots up to the successful check, and the linked
// authoritative event a revision completion names.
function transaction(operation, coldId = 'wake-on-preparation') {
  const requestId = '11111111-1111-4111-8111-111111111111', cold = operation === 'cold-wake.set';
  const parameters = cold ? coldParameters(coldId, byId(coldId).record)
    : { proposalId: template.expected.proposal.proposalId, expectedRevision: template.expected.head.revision, reason: 'Ship it' };
  const action = Buffer.from(canonicalJson({ v: 1, requestId, principal: template.principal, account: template.account, soul: template.soul, operation, parameters }));
  const acceptance = { v: 1, kind: 'acceptance', requestId, principal: template.principal, account: template.account, soul: template.soul, operation,
    payloadDigest: sha256(action), namespaceDigest, acceptedAt: 2_000_000_000, daemonKey: template.daemonKey, daemonEpoch: 1,
    watchId: template.watchId, reservationBytes: 524288 };
  const base = cold ? byId(coldId).record : template;
  const preparation = { ...base, requestId, operation, payloadDigest: acceptance.payloadDigest, acceptedAt: 2_000_000_000, preparedAt: 2_000_000_000,
    exp: Math.min(2_000_000_180, base.stage?.expiresAt ?? Infinity) };
  const preparationBytes = Buffer.from(canonicalJson(preparation)), preparationDigest = sha256(preparationBytes);
  const receipt = Buffer.from('d1.payload.signature'), receiptDigest = sha256(receipt);
  const check = Buffer.from(canonicalJson({ requestId, payloadDigest: acceptance.payloadDigest, receiptDigest, daemonKey: acceptance.daemonKey,
    daemonEpoch: 1, watchId: acceptance.watchId, state: 'released', mayApply: true, exp: 2_000_000_060 }));
  const entered = byId('approve-entered').record.detail;
  const linked = Buffer.from(`${JSON.stringify({ schemaVersion: 1, kind: 'revision', revision: entered.afterRevision, parentRevision: entered.beforeRevision,
    author: 'soul', reason: 'Ship it', proposalId: parameters.proposalId, approval: 'user', approvedBy: 'user', approvalReason: 'ok',
    ownerDecision: { requestId, payloadDigest: acceptance.payloadDigest, receiptDigest, effectId: preparation.effectId, preparationDigest },
    at: new Date(AT * 1000).toISOString() })}\n`);
  const revision = { at: AT, journalSeq: byId('approve-completed').record.detail.journalSeq, journalRecordDigest: sha256(linked), working: null };
  return {
    requestId, action, acceptance: Buffer.from(canonicalJson(acceptance)), preparation, preparationDigest, receiptDigest, linked, revision,
    slots: { preparation: preparationBytes, 'prepared-challenge': challengeFor(preparation, action), presence: Buffer.from('p1.payload.signature'), receipt,
      'successful-check': check },
  };
}

function journal(t, operation = 'revision.approve', { upTo = 'successful-check', enter = true, coldId } = {}) {
  const tx = transaction(operation, coldId);
  const base = fs.realpathSync(fs.mkdtempSync(path.join(tmpdir(), 'owner-writers-')));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const root = path.join(base, 'journal');
  initializeDaemonJournal(root);
  const open = (options = {}) => createDaemonJournalStore({ root, namespaceDigest, ...options });
  open().admit(tx.action, tx.acceptance);
  const dir = path.join(root, 'requests', requestDirectoryName({ namespaceDigest, requestId: tx.requestId }));
  const write = (slot, payload) => fs.writeFileSync(path.join(dir, `${slot}.record`), encodeDaemonJournalFrame(payload, { namespaceDigest, requestId: tx.requestId, slot }));
  const read = (slot) => fs.readFileSync(path.join(dir, `${slot}.record`));
  for (const slot of upTo ? PRE_ENTRY.slice(0, PRE_ENTRY.indexOf(upTo) + 1) : []) write(slot, tx.slots[slot]);
  if (upTo === 'successful-check' && enter) open().enterEffect(tx.requestId, () => ({ at: AT }));
  const recover = () => open().recover(tx.requestId);
  const complete = (result = operation === 'cold-wake.set' ? { at: AT } : tx.revision, options) => open(options).completeEffect(tx.requestId, result);
  const refuse = (refusal = { code: 'expected-state-changed', at: AT }, options) => open(options).refusePreEffect(tx.requestId, refusal);
  return { tx, root, write, read, recover, complete, refuse };
}

// Nothing is written: the request's files are byte-identical.
function unchanged(j, run, expected) {
  const before = snapshot(j);
  assert.throws(run, expected);
  assert.deepEqual(snapshot(j), before);
}
const snapshot = (j) => ['completed', 'pre-effect-refused', 'entered', 'linked-authoritative-event'].map((slot) => sha256(j.read(slot)));

test('the writers are reachable only through the host contract', () => {
  assert.equal(typeof host.createDaemonJournalStore, 'function');
  assert.equal('createDaemonJournalStore' in soul, false);
});

test('a cold-wake completion derives its record from entered and the action, and is applied', darwin, async (t) => {
  for (const variant of ['on', 'off', 'resume-read-only', 'resume-workspace', 'webhook']) {
    await t.test(variant, (tt) => {
      const j = journal(tt, 'cold-wake.set', { coldId: `wake-${variant}-preparation` });
      assert.equal(j.recover().state, 'indeterminate');
      const done = j.complete();
      assert.equal(done.state, 'applied');
      assert.deepEqual(done.outcome, { code: 'applied', effectDigest: done.completedDigest });
      assert.deepEqual(j.recover().outcome, { code: 'applied', effectDigest: done.completedDigest });
      // Exactly the vendored completion detail for this transition.
      const expected = { v: 1, kind: 'effect', requestId: j.tx.requestId, payloadDigest: j.tx.preparation.payloadDigest, preparationDigest: j.tx.preparationDigest,
        receiptDigest: j.tx.receiptDigest, effectId: j.tx.preparation.effectId, phase: 'completed', at: AT, detail: byId(`wake-${variant}-completed`).record.detail };
      assert.equal(done.completedDigest, sha256(canonicalJson(expected)));
    });
  }
});

test('a revision completion is indeterminate until its linked authoritative event, then applied', darwin, async (t) => {
  await t.test('completed first', (tt) => {
    const j = journal(tt);
    const done = j.complete();
    assert.equal(done.state, 'indeterminate');
    const expected = { v: 1, kind: 'effect', requestId: j.tx.requestId, payloadDigest: j.tx.preparation.payloadDigest, preparationDigest: j.tx.preparationDigest,
      receiptDigest: j.tx.receiptDigest, effectId: j.tx.preparation.effectId, phase: 'completed', at: AT,
      detail: { ...byId('approve-completed').record.detail, journalRecordDigest: j.tx.revision.journalRecordDigest } };
    assert.equal(done.completedDigest, sha256(canonicalJson(expected)));
    j.write('linked-authoritative-event', j.tx.linked);
    assert.deepEqual(j.recover().outcome, { code: 'applied', effectDigest: done.completedDigest });
  });
  await t.test('linked event first', (tt) => {
    const j = journal(tt);
    j.write('linked-authoritative-event', j.tx.linked);
    assert.equal(j.complete().state, 'applied');
  });
});

test('completion is legal only from a valid entered record', darwin, async (t) => {
  for (const [upTo, state] of [[null, 'admitted'], ['preparation', 'preparing'], ['prepared-challenge', 'prepared'], ['receipt', 'authorizing'],
    ['successful-check', 'released']]) {
    await t.test(state, (tt) => {
      const j = journal(tt, 'revision.approve', { upTo, enter: false });
      assert.equal(j.recover().state, state);
      unchanged(j, () => j.complete(), { reason: 'owner-journal-transition-refused', code: 'storage-failed' });
      assert.equal(j.recover().state, state);
    });
  }
  await t.test('damaged entered', (tt) => {
    const j = journal(tt, 'revision.approve', { enter: false });
    j.write('entered', Buffer.from('{"not":"an effect"}'));
    assert.equal(j.recover().state, 'indeterminate');
    unchanged(j, () => j.complete(), { reason: 'owner-journal-transition-refused' });
  });
  await t.test('a cold-wake request carrying a linked event', (tt) => {
    const j = journal(tt, 'cold-wake.set');
    j.write('linked-authoritative-event', j.tx.linked);
    unchanged(j, () => j.complete(), { reason: 'owner-journal-transition-refused' });
  });
  await t.test('unknown request', (tt) => {
    const j = journal(tt);
    assert.throws(() => createDaemonJournalStore({ root: j.root, namespaceDigest }).completeEffect('22222222-2222-4222-8222-222222222222', { at: AT }),
      { reason: 'owner-journal-transition-refused' });
  });
});

test('a completion that does not repeat the entered transition refuses and writes nothing', darwin, async (t) => {
  const bad = {
    'missing journal sequence': { at: AT, journalRecordDigest: 'b'.repeat(64), working: null },
    'working tree on a record-only entry': { at: AT, journalSeq: 1, journalRecordDigest: 'b'.repeat(64), working: { rootDigest: 'c'.repeat(64), inventoryDigest: 'd'.repeat(64) } },
    'negative time': { at: -1, journalSeq: 1, journalRecordDigest: 'b'.repeat(64), working: null },
  };
  for (const [name, result] of Object.entries(bad)) {
    await t.test(name, (tt) => {
      const j = journal(tt);
      unchanged(j, () => j.complete(result), { reason: 'invalid-owner-journal-record', code: 'bad-request' });
      assert.equal(j.complete().state, 'indeterminate');
    });
  }
  await t.test('not an object', (tt) => {
    const j = journal(tt);
    unchanged(j, () => j.complete(null), { reason: 'invalid-owner-journal-record' });
  });
});

test('a final refusal is legal from every prepared phase before entry, with the mapped outcome', darwin, async (t) => {
  for (const [upTo, state] of [['preparation', 'preparing'], ['prepared-challenge', 'prepared'], ['receipt', 'authorizing'], ['successful-check', 'released']]) {
    await t.test(state, (tt) => {
      const j = journal(tt, 'revision.approve', { upTo, enter: false });
      const refused = j.refuse({ code: 'trust-unavailable', at: AT });
      // The checked receipt is bound only once the successful check exists.
      const record = { v: 1, kind: 'effect', requestId: j.tx.requestId, payloadDigest: j.tx.preparation.payloadDigest, preparationDigest: j.tx.preparationDigest,
        receiptDigest: state === 'released' ? j.tx.receiptDigest : null, effectId: j.tx.preparation.effectId, phase: 'refused', at: AT, detail: { code: 'trust-unavailable' } };
      const outcome = { code: REFUSAL_OUTCOMES['trust-unavailable'], effectDigest: sha256(canonicalJson(record)) };
      assert.equal(refused.state, 'refused'); assert.deepEqual(refused.outcome, outcome);
      assert.deepEqual(j.recover().outcome, outcome);
      assert.equal(j.recover().refusalReason, 'trust-unavailable');
    });
  }
  await t.test('admitted', (tt) => {
    const j = journal(tt, 'revision.approve', { upTo: null });
    unchanged(j, () => j.refuse(), { reason: 'owner-journal-transition-refused' });
    assert.equal(j.recover().state, 'admitted');
  });
  await t.test('an unknown reason or bad time', (tt) => {
    const j = journal(tt, 'revision.approve', { enter: false });
    unchanged(j, () => j.refuse({ code: 'because', at: AT }), { reason: 'invalid-owner-journal-record' });
    unchanged(j, () => j.refuse({ code: 'expired', at: 1.5 }), { reason: 'invalid-owner-journal-record' });
    unchanged(j, () => j.refuse(null), { reason: 'invalid-owner-journal-record' });
    assert.equal(j.recover().state, 'released');
  });
});

test('double completion, double refusal, applied after refused and refused after entered are conflicts', darwin, async (t) => {
  const conflict = { reason: 'owner-journal-conflict', code: 'conflict' };
  await t.test('double completion (applied)', (tt) => {
    const j = journal(tt, 'cold-wake.set'); j.complete();
    unchanged(j, () => j.complete(), conflict);
  });
  await t.test('double completion (awaiting its linked event)', (tt) => {
    const j = journal(tt); j.complete();
    unchanged(j, () => j.complete(), conflict);
  });
  await t.test('double refusal', (tt) => {
    const j = journal(tt, 'revision.approve', { enter: false }); j.refuse();
    unchanged(j, () => j.refuse({ code: 'expired', at: AT }), conflict);
  });
  await t.test('completion after refusal', (tt) => {
    const j = journal(tt, 'revision.approve', { enter: false }); j.refuse();
    unchanged(j, () => j.complete(), conflict);
    assert.equal(j.recover().state, 'refused');
  });
  await t.test('refusal after entry', (tt) => {
    const j = journal(tt);
    unchanged(j, () => j.refuse(), conflict);
    assert.equal(j.recover().state, 'indeterminate');
  });
  await t.test('refusal after applied', (tt) => {
    const j = journal(tt, 'cold-wake.set'); j.complete();
    unchanged(j, () => j.refuse(), conflict);
  });
  await t.test('entry after refusal', (tt) => {
    const j = journal(tt, 'revision.approve', { enter: false }); j.refuse();
    assert.throws(() => createDaemonJournalStore({ root: j.root, namespaceDigest }).enterEffect(j.tx.requestId, () => ({ at: AT })),
      { reason: 'owner-journal-consumed' });
  });
});

test('a crash between writes recovers to the existing mapped outcome', darwin, async (t) => {
  const crashAt = (point) => ({ fault: (at) => { if (at === point) throw new Error('crash'); } });
  await t.test('completion body without its trailer is effect-uncertain, never completed again', (tt) => {
    const j = journal(tt, 'cold-wake.set');
    assert.throws(() => j.complete(undefined, crashAt('completed:body-written')));
    assert.deepEqual(j.recover().outcome, { code: 'effect-uncertain', effectDigest: null });
    assert.throws(() => j.complete(), { reason: 'owner-journal-conflict' });
  });
  await t.test('completion trailer written but not flushed is applied', (tt) => {
    const j = journal(tt, 'cold-wake.set');
    assert.throws(() => j.complete(undefined, crashAt('completed:trailer-written')));
    assert.equal(j.recover().state, 'applied');
  });
  await t.test('refusal body without its trailer refuses as found, and never enters', (tt) => {
    const j = journal(tt, 'revision.approve', { enter: false });
    assert.throws(() => j.refuse(undefined, crashAt('pre-effect-refused:body-written')));
    assert.throws(() => j.recover(), { reason: 'owner-journal-unsupported-phase', code: 'storage-failed' });
    assert.throws(() => createDaemonJournalStore({ root: j.root, namespaceDigest }).enterEffect(j.tx.requestId, () => ({ at: AT })),
      { reason: 'owner-journal-unsupported-phase' });
  });
  await t.test('refusal trailer written but not flushed is refused', (tt) => {
    const j = journal(tt, 'revision.approve', { enter: false });
    assert.throws(() => j.refuse(undefined, crashAt('pre-effect-refused:trailer-written')));
    assert.equal(j.recover().outcome.code, 'validation-refused');
  });
});

test('malformed input refuses before the lock, and a refused transition leaves the store usable', darwin, (t) => {
  const j = journal(t, 'revision.approve', { enter: false });
  const held = acquireDaemonJournalLock(j.root);
  try {
    for (const run of [() => j.complete(null), () => j.refuse(null), () => j.complete([]), () => j.refuse('expired')]) {
      assert.throws(run, { reason: 'invalid-owner-journal-record' });
    }
  } finally { fs.closeSync(held); }
  // Completing a released request refuses without poisoning this instance.
  const store = createDaemonJournalStore({ root: j.root, namespaceDigest });
  assert.throws(() => store.completeEffect(j.tx.requestId, j.tx.revision), { reason: 'owner-journal-transition-refused' });
  assert.equal(store.enterEffect(j.tx.requestId, () => ({ at: AT })).state, 'entered');
  assert.throws(() => store.refusePreEffect(j.tx.requestId, { code: 'expired', at: AT }), { reason: 'owner-journal-conflict' });
  assert.equal(store.completeEffect(j.tx.requestId, j.tx.revision).state, 'indeterminate');
});

test('each writer flushes the request it read before writing, and refuses an unknown request', darwin, async (t) => {
  for (const [name, operation, options, slot, run] of [
    ['completion', 'cold-wake.set', {}, 'completed', (j, o) => j.complete(undefined, o)],
    ['refusal', 'revision.approve', { enter: false }, 'pre-effect-refused', (j, o) => j.refuse(undefined, o)],
  ]) {
    await t.test(name, (tt) => {
      const j = journal(tt, operation, options), seen = [];
      run(j, { fault: (at) => seen.push(at) });
      const flushed = seen.indexOf('recovery:directories-flushed');
      assert(flushed >= 0 && flushed < seen.indexOf(`${slot}:body-written`), seen.join(' '));
    });
  }
  const j = journal(t, 'revision.approve', { enter: false });
  assert.throws(() => createDaemonJournalStore({ root: j.root, namespaceDigest }).refusePreEffect('22222222-2222-4222-8222-222222222222', { code: 'expired', at: AT }),
    { reason: 'owner-journal-transition-refused' });
});

test('a held journal lock refuses both writers instead of waiting', darwin, (t) => {
  const done = journal(t, 'cold-wake.set'), refused = journal(t, 'revision.approve', { enter: false });
  for (const [j, run] of [[done, () => done.complete()], [refused, () => refused.refuse()]]) {
    const held = acquireDaemonJournalLock(j.root);
    try { unchanged(j, run, { reason: 'owner-journal-busy', code: 'storage-failed' }); } finally { fs.closeSync(held); }
  }
  assert.equal(done.complete().state, 'applied');
  assert.equal(refused.refuse().state, 'refused');
});
