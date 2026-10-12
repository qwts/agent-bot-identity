// The disabled owner-decision effect writers (agent-comms#77, C2): completion
// (slot 10, entered -> completed) and the final pre-effect refusal (slot 7).
// Each test builds a request in scratch state with the typed fixture records,
// enters it through one store instance, then drives the writers. Completion
// takes that instance's live entry handle.
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
import { REFUSAL_OUTCOMES, challengeFor, enteredRecordFor } from '../identity/owner-decision-evidence.mjs';
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
  // What a revision completion reports; the linked event's bytes come from the reader.
  const revision = { at: AT, journalSeq: byId('approve-completed').record.detail.journalSeq, working: null };
  return {
    requestId, action, acceptance: Buffer.from(canonicalJson(acceptance)), preparation, preparationDigest, receiptDigest, linked, revision,
    slots: { preparation: preparationBytes, 'prepared-challenge': challengeFor(preparation, action), presence: Buffer.from('p1.payload.signature'), receipt,
      'successful-check': check },
  };
}

function journal(t, operation = 'revision.approve', { upTo = 'successful-check', enter = true, coldId, fault } = {}) {
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
  // The instance that enters, and its one-shot entry handle.
  const store = open({ fault });
  const entry = upTo === 'successful-check' && enter ? store.enterEffect(tx.requestId, () => ({ at: AT })).entry : null;
  const recover = () => open().recover(tx.requestId);
  const defaults = operation === 'cold-wake.set' ? { at: AT } : tx.revision;
  // The revision-journal reader stands in for the host port: the exact linked-event bytes.
  const reader = { readLinkedEvent: () => tx.linked };
  const complete = (result = defaults, handle = entry) => store.completeEffect(handle, result, reader);
  const refuse = (refusal = { code: 'expected-state-changed', at: AT }, options) => open(options).refusePreEffect(tx.requestId, refusal);
  return { tx, root, write, read, recover, complete, refuse, store, entry, open, defaults, reader };
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

// A revision completion reads its linked event through the reader, publishes
// it to slot 13, then slot 10: the request is applied.
test('a revision completion publishes its linked event, then completed, and is applied', darwin, async (t) => {
  await t.test('applied, with the exact bytes and digests', (tt) => {
    const j = journal(tt);
    const done = j.complete();
    assert.equal(done.state, 'applied');
    const expected = { v: 1, kind: 'effect', requestId: j.tx.requestId, payloadDigest: j.tx.preparation.payloadDigest, preparationDigest: j.tx.preparationDigest,
      receiptDigest: j.tx.receiptDigest, effectId: j.tx.preparation.effectId, phase: 'completed', at: AT,
      detail: { ...byId('approve-completed').record.detail, journalRecordDigest: sha256(j.tx.linked) } };
    assert.equal(done.completedDigest, sha256(canonicalJson(expected)));
    assert.deepEqual(j.read('linked-authoritative-event'),
      encodeDaemonJournalFrame(j.tx.linked, { namespaceDigest, requestId: j.tx.requestId, slot: 'linked-authoritative-event' }));
    assert.deepEqual(j.recover().outcome, { code: 'applied', effectDigest: done.completedDigest });
  });
  await t.test('a linked event already present refuses', (tt) => {
    const j = journal(tt);
    j.write('linked-authoritative-event', j.tx.linked);
    unchanged(j, () => j.complete(), { reason: 'owner-journal-transition-refused' });
  });
});

// Completion needs the live handle from this instance's own entry: nothing
// else, including recovery or a reopened store, can complete an entered effect.
test('completion requires the live one-shot entry handle from the instance that entered', darwin, async (t) => {
  const required = { reason: 'owner-journal-entry-required', code: 'storage-failed' };
  await t.test('no handle', (tt) => {
    const j = journal(tt, 'cold-wake.set');
    for (const handle of [undefined, null, j.tx.requestId, 7]) unchanged(j, () => j.store.completeEffect(handle, j.defaults), required);
    assert.equal(j.complete().state, 'applied');
  });
  await t.test('a forged lookalike', (tt) => {
    const j = journal(tt, 'cold-wake.set');
    for (const handle of [Object.freeze(Object.create(null)), {}, Object.freeze({ ...j.entry }), Object.create(j.entry)]) {
      unchanged(j, () => j.store.completeEffect(handle, j.defaults), required);
    }
    assert.equal(j.complete().state, 'applied');
  });
  await t.test('a handle used on a second instance over the same journal', (tt) => {
    const j = journal(tt, 'cold-wake.set');
    unchanged(j, () => j.open().completeEffect(j.entry, j.defaults), required);
    assert.equal(j.complete().state, 'applied');
  });
  await t.test('after a crash and reopen the entered request stays effect-uncertain', (tt) => {
    // The entering instance fails a later write and is poisoned; a reopened
    // instance has no live entry, so the request can never be completed.
    let flushes = 0;
    const j = journal(tt, 'cold-wake.set', { fault: (at) => { if (at === 'recovery:directories-flushed' && ++flushes === 2) throw new Error('crash'); } });
    assert.throws(() => j.complete());
    assert.throws(() => j.complete(), { reason: 'owner-journal-reopen-required' });
    unchanged(j, () => j.open().completeEffect(j.entry, j.defaults), required);
    assert.deepEqual(j.recover().outcome, { code: 'effect-uncertain', effectDigest: null });
  });
  await t.test('a handle is used once', (tt) => {
    const j = journal(tt);
    assert.equal(j.complete().state, 'applied');
    unchanged(j, () => j.complete(), required);
  });
  await t.test('a handle for one request never completes another', (tt) => {
    const j = journal(tt, 'cold-wake.set'), k = journal(tt, 'cold-wake.set');
    unchanged(k, () => j.store.completeEffect(k.entry, k.defaults), required);
  });
});

// The store-wide rule: an unknown entry in requests/ stays for inspection and
// refuses every write. The refusal is a storage failure, so it poisons the
// instance: the handle is not consumed, but the instance that holds it refuses
// until reopened, and a reopened instance has no handle. The request stays
// effect-uncertain even once the entry is gone.
test('an unknown request entry refuses completion with a live handle, and the entry stays uncertain', darwin, (t) => {
  const j = journal(t, 'cold-wake.set');
  const unknown = path.join(j.root, 'requests', 'not-a-request');
  fs.mkdirSync(unknown);
  unchanged(j, () => j.complete(), { reason: 'owner-journal-corrupt', code: 'storage-failed' });
  fs.rmdirSync(unknown);
  unchanged(j, () => j.complete(), { reason: 'owner-journal-reopen-required' });
  unchanged(j, () => j.open().completeEffect(j.entry, j.defaults), { reason: 'owner-journal-entry-required' });
  assert.deepEqual(j.recover().outcome, { code: 'effect-uncertain', effectDigest: null });
});

test('completion is legal only while the entered record is the one the handle entered', darwin, async (t) => {
  await t.test('a damaged entered record', (tt) => {
    const j = journal(tt);
    j.write('entered', Buffer.from('{"not":"an effect"}'));
    unchanged(j, () => j.complete(), { reason: 'owner-journal-transition-refused', code: 'storage-failed' });
  });
  await t.test('another valid entered record', (tt) => {
    // Rewritten behind this instance with a later time: valid, but not the entry it holds.
    const j = journal(tt);
    j.write('entered', Buffer.from(canonicalJson(enteredRecordFor({ preparation: j.tx.preparation, preparationDigest: j.tx.preparationDigest,
      receiptDigest: j.tx.receiptDigest, action: JSON.parse(j.tx.action), at: AT + 1 }))));
    assert.equal(j.recover().state, 'indeterminate');
    unchanged(j, () => j.complete(), { reason: 'owner-journal-transition-refused' });
  });
  await t.test('a cold-wake request carrying a linked event', (tt) => {
    const j = journal(tt, 'cold-wake.set');
    j.write('linked-authoritative-event', j.tx.linked);
    unchanged(j, () => j.complete(), { reason: 'owner-journal-transition-refused' });
  });
  await t.test('a completed slot already holding anything', (tt) => {
    const j = journal(tt, 'cold-wake.set');
    j.write('completed', Buffer.from('{}'));
    unchanged(j, () => j.complete(), { reason: 'owner-journal-conflict', code: 'conflict' });
  });
});

test('a completion that does not repeat the entered transition refuses and writes nothing', darwin, async (t) => {
  const bad = {
    'missing journal sequence': { at: AT, working: null },
    'a caller-supplied record digest': { at: AT, journalSeq: 1, journalRecordDigest: 'b'.repeat(64), working: null },
    'working tree on a record-only entry': { at: AT, journalSeq: 1, working: { rootDigest: 'c'.repeat(64), inventoryDigest: 'd'.repeat(64) } },
    'negative time': { at: -1, journalSeq: 1, working: null },
    'a time before entry': { at: AT - 1, journalSeq: 1, working: null },
  };
  for (const [name, result] of Object.entries(bad)) {
    await t.test(name, (tt) => {
      const j = journal(tt);
      unchanged(j, () => j.complete(result), { reason: 'invalid-owner-journal-record', code: 'bad-request' });
      assert.equal(j.complete().state, 'applied');
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
      // The saved receipt is bound whenever one is saved (authorizing on).
      const record = { v: 1, kind: 'effect', requestId: j.tx.requestId, payloadDigest: j.tx.preparation.payloadDigest, preparationDigest: j.tx.preparationDigest,
        receiptDigest: ['authorizing', 'released'].includes(state) ? j.tx.receiptDigest : null, effectId: j.tx.preparation.effectId, phase: 'refused', at: AT, detail: { code: 'trust-unavailable' } };
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
  // A second completion has no live handle (it was consumed), so it refuses
  // before reading anything; a completed slot behind a live handle is a conflict.
  await t.test('double completion', (tt) => {
    const j = journal(tt, 'cold-wake.set'); j.complete();
    unchanged(j, () => j.complete(), { reason: 'owner-journal-entry-required' });
  });
  await t.test('double refusal', (tt) => {
    const j = journal(tt, 'revision.approve', { enter: false }); j.refuse();
    unchanged(j, () => j.refuse({ code: 'expired', at: AT }), conflict);
  });
  await t.test('completion after refusal', (tt) => {
    // A refused request can never be entered, so no handle can exist for it.
    const j = journal(tt, 'revision.approve', { enter: false }); j.refuse();
    assert.throws(() => j.store.enterEffect(j.tx.requestId, () => ({ at: AT })), { reason: 'owner-journal-consumed' });
    unchanged(j, () => j.complete(), { reason: 'owner-journal-entry-required' });
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
    const j = journal(tt, 'cold-wake.set', crashAt('completed:body-written'));
    assert.throws(() => j.complete());
    assert.deepEqual(j.recover().outcome, { code: 'effect-uncertain', effectDigest: null });
    assert.throws(() => j.open().completeEffect(j.entry, j.defaults), { reason: 'owner-journal-entry-required' });
  });
  await t.test('completion trailer written but not flushed is applied', (tt) => {
    const j = journal(tt, 'cold-wake.set', crashAt('completed:trailer-written'));
    assert.throws(() => j.complete());
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
  const live = journal(t, 'cold-wake.set'), j = journal(t, 'revision.approve', { enter: false });
  for (const root of [live.root, j.root]) {
    const held = acquireDaemonJournalLock(root);
    try {
      for (const run of [() => live.complete(null), () => live.complete([]), () => j.refuse(null), () => j.refuse('expired')]) {
        assert.throws(run, { reason: 'invalid-owner-journal-record' });
      }
      assert.throws(() => j.store.completeEffect(null, {}), { reason: 'owner-journal-entry-required' });
    } finally { fs.closeSync(held); }
  }
  assert.equal(live.complete().state, 'applied');
  // A refused phase transition does not poison the instance that refused it.
  const admitted = journal(t, 'revision.approve', { upTo: null });
  assert.throws(() => admitted.store.refusePreEffect(admitted.tx.requestId, { code: 'expired', at: AT }), { reason: 'owner-journal-transition-refused' });
  assert.equal(admitted.store.recover(admitted.tx.requestId).state, 'admitted');
  // Refused writes leave this instance usable, its live entry included.
  const store = createDaemonJournalStore({ root: j.root, namespaceDigest });
  assert.throws(() => store.completeEffect(null, j.tx.revision), { reason: 'owner-journal-entry-required' });
  const { entry } = store.enterEffect(j.tx.requestId, () => ({ at: AT }));
  assert.throws(() => store.refusePreEffect(j.tx.requestId, { code: 'expired', at: AT }), { reason: 'owner-journal-conflict' });
  // A refused completion does not consume the handle: it completes once fixed.
  assert.throws(() => store.completeEffect(entry, { ...j.tx.revision, at: AT - 1 }, j.reader), { reason: 'invalid-owner-journal-record' });
  assert.equal(store.completeEffect(entry, j.tx.revision, j.reader).state, 'applied');
});

test('each writer flushes the request it read before writing, and refuses an unknown request', darwin, async (t) => {
  for (const [name, operation, options, slot, run] of [
    ['completion', 'cold-wake.set', {}, 'completed', (j) => j.complete()],
    ['refusal', 'revision.approve', { enter: false }, 'pre-effect-refused', (j, o) => j.refuse(undefined, o)],
  ]) {
    await t.test(name, (tt) => {
      const seen = [], j = journal(tt, operation, { ...options, fault: (at) => seen.push(at) });
      seen.length = 0;
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

// A refusal binds the saved receipt whenever one is saved: a refused record
// that nulls it beside a saved receipt is not this request's refusal.
test('a refused record must bind the saved receipt whenever one is saved', darwin, (t) => {
  const j = journal(t, 'revision.approve', { upTo: 'receipt', enter: false });
  const record = { v: 1, kind: 'effect', requestId: j.tx.requestId, payloadDigest: j.tx.preparation.payloadDigest, preparationDigest: j.tx.preparationDigest,
    receiptDigest: null, effectId: j.tx.preparation.effectId, phase: 'refused', at: AT, detail: { code: 'expired' } };
  j.write('pre-effect-refused', Buffer.from(canonicalJson(record)));
  assert.throws(() => j.recover(), { reason: 'owner-journal-corrupt' });
  j.write('pre-effect-refused', Buffer.from(canonicalJson({ ...record, receiptDigest: j.tx.receiptDigest })));
  assert.equal(j.recover().state, 'refused');
});

// The composed revision completion (slot 13, then slot 10): the linked event
// comes only from the reader, verified as this request's; a refusal before
// the first write keeps the handle; a failure in either publication consumes
// it and leaves the request effect-uncertain.
test('a revision completion verifies the linked event it reads, and refuses anything else', darwin, async (t) => {
  const refusedLinked = { reason: 'owner-journal-linked-event-refused' };
  const event = (j, change) => Buffer.from(`${JSON.stringify({ ...JSON.parse(j.tx.linked), ...change })}\n`);
  const cases = {
    'no reader': () => undefined,
    'a reader that throws': () => ({ readLinkedEvent: () => { throw new Error('unavailable'); } }),
    'not bytes': () => ({ readLinkedEvent: () => '{}' }),
    'the right event as a string, not bytes': (j) => ({ readLinkedEvent: () => j.tx.linked.toString() }),
    'another request\'s linkage': (j) => ({ readLinkedEvent: () => event(j, { ownerDecision: { ...JSON.parse(j.tx.linked).ownerDecision, requestId: '33333333-3333-4333-8333-333333333333' } }) }),
    'another proposal': (j) => ({ readLinkedEvent: () => event(j, { proposalId: '33333333-3333-4333-8333-333333333333' }) }),
    'another revision': (j) => ({ readLinkedEvent: () => event(j, { revision: `sha256:${'e'.repeat(64)}` }) }),
    'a decision for an approve': (j) => ({ readLinkedEvent: () => event(j, { kind: 'decision' }) }),
    'not the writer\'s own serialization': (j) => ({ readLinkedEvent: () => Buffer.from(`${JSON.stringify(JSON.parse(j.tx.linked), null, 1)}\n`) }),
  };
  for (const [name, reader] of Object.entries(cases)) {
    await t.test(name, (tt) => {
      const j = journal(tt);
      const expected = name === 'no reader' ? { reason: 'invalid-owner-journal-record' } : refusedLinked;
      unchanged(j, () => j.store.completeEffect(j.entry, j.tx.revision, reader(j)), expected);
      // Nothing was written and the handle is kept for an explicit retry.
      assert.equal(j.complete().state, 'applied');
    });
  }
});

test('a crash in or between the two publications is effect-uncertain, never retried', darwin, async (t) => {
  const crashAt = (point) => (at) => { if (at === point) throw new Error('crash'); };
  for (const point of ['linked-authoritative-event:body-written', 'linked-authoritative-event:trailer-flushed', 'completed:body-written']) {
    await t.test(point, (tt) => {
      const j = journal(tt, 'revision.approve', { fault: crashAt(point) });
      assert.throws(() => j.complete());
      assert.deepEqual(j.recover().outcome, { code: 'effect-uncertain', effectDigest: null });
      // The handle was consumed before the first write: no retry, from any instance.
      assert.throws(() => j.open().completeEffect(j.entry, j.tx.revision, j.reader), { reason: 'owner-journal-entry-required' });
    });
  }
});
