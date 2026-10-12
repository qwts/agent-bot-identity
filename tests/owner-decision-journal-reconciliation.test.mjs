// The disabled owner-decision reconciliation pairs (agent-comms#77, C2):
// slot 11, the indeterminate observation pair, and slot 12, the immutable
// terminal pair. The pair vectors are agent-comms journal-budget-v1.json at
// d071a9b (reconciliationPairs, added by 543b576), vendored byte for byte;
// each test rebinds one to a request built in scratch state.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { canonicalJson } from '../canonical-json.mjs';
import { decodeDaemonJournalFrame, encodeDaemonJournalFrame, requestDirectoryName } from '../identity/owner-decision-journal-frame.mjs';
import { acquireDaemonJournalLock, createDaemonJournalStore, initializeDaemonJournal } from '../identity/owner-decision-journal-store.mjs';
import { challengeFor } from '../identity/owner-decision-evidence.mjs';

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
  const complete = (result = defaults, handle = entry) => store.completeEffect(handle, result);
  const refuse = (refusal = { code: 'expected-state-changed', at: AT }, options) => open(options).refusePreEffect(tx.requestId, refusal);
  // The exact payload a committed slot holds.
  const payload = (slot) => decodeDaemonJournalFrame(read(slot), { namespaceDigest, requestId: tx.requestId, slot }).payload;
  return { tx, root, write, read, recover, complete, refuse, store, entry, open, defaults, payload };
}


const budget = JSON.parse(fs.readFileSync(new URL('./fixtures/owner-decisions/journal-budget-v1.json', import.meta.url), 'utf8'));
const SLOTS = ['observation-pair', 'terminal-pair', 'entered', 'completed', 'pre-effect-refused'];
const snapshot = (j) => SLOTS.map((slot) => sha256(j.read(slot)));
function unchanged(j, run, expected) {
  const before = snapshot(j);
  assert.throws(run, expected);
  assert.deepEqual(snapshot(j), before);
}
const invalid = { reason: 'invalid-owner-journal-record', code: 'bad-request' };
const conflict = { reason: 'owner-journal-conflict', code: 'conflict' };
const transition = { reason: 'owner-journal-transition-refused', code: 'storage-failed' };

// A vendored pair rebound to this request: its acceptance, preparation and
// (for a terminal finding) basis; the preimage kept unless replaced, with
// observedDigest recomputed from it.
function pairFor(j, id, { basis = null, record = {}, preimage } = {}) {
  const vector = structuredClone(budget.reconciliationPairs.find((entry) => entry.id === id).record);
  const acceptance = JSON.parse(j.tx.acceptance);
  const p = preimage ?? vector.preimage;
  if (Object.hasOwn(p, 'working')) p.working = null;
  vector.preimage = p;
  vector.record = { ...vector.record, requestId: acceptance.requestId, payloadDigest: acceptance.payloadDigest, originalDaemonKey: acceptance.daemonKey,
    originalDaemonEpoch: acceptance.daemonEpoch, effectId: j.tx.preparation.effectId, basisDigest: basis && sha256(basis),
    observedDigest: sha256(canonicalJson(p)), ...record };
  return vector;
}
const observe = (j, pair, store = j.open()) => store.recordObservationPair(j.tx.requestId, pair);
const terminate = (j, pair, store = j.open()) => store.recordTerminalPair(j.tx.requestId, pair);
const committed = (j, slot, pair) => assert.deepEqual(j.read(slot),
  encodeDaemonJournalFrame(Buffer.from(canonicalJson(pair)), { namespaceDigest, requestId: j.tx.requestId, slot }));

test('the vendored pairs are agent-comms d071a9b, six typed pairs', () => {
  assert.equal(sha256(fs.readFileSync(new URL('./fixtures/owner-decisions/journal-budget-v1.json', import.meta.url))),
    'ea2d8f4c52c49d89dd2d7f8919b978d74ebc518b951e428911125a643b1eb932');
  assert.deepEqual(budget.reconciliationPairs.map(({ id, slot }) => `${id}:${slot}`), ['revision-indeterminate-pair:observation-pair',
    'revision-applied-pair:terminal-pair', 'revision-refused-pair:terminal-pair', 'cold-indeterminate-pair:observation-pair',
    'cold-applied-pair:terminal-pair', 'cold-refused-pair:terminal-pair']);
});

test('an indeterminate request takes one observation pair; the same bytes again are a duplicate, anything else conflicts', darwin, async (t) => {
  for (const [operation, id] of [['revision.approve', 'revision-indeterminate-pair'], ['cold-wake.set', 'cold-indeterminate-pair']]) {
    await t.test(operation, (tt) => {
      const j = journal(tt, operation), pair = pairFor(j, id);
      const recorded = observe(j, pair);
      assert.equal(recorded.state, 'indeterminate');
      assert.deepEqual(recorded.outcome, { code: 'effect-uncertain', effectDigest: null });
      committed(j, 'observation-pair', pair);
      assert.equal(j.recover().state, 'indeterminate');
      const again = observe(j, pair);
      assert.equal(again.duplicate, true);
      committed(j, 'observation-pair', pair);
      unchanged(j, () => observe(j, pairFor(j, id, { record: { auditId: '33333333-3333-4333-8333-333333333333' } })), conflict);
    });
  }
});

test('an observation pair binds to this request, its preparation and no basis', darwin, async (t) => {
  const cases = {
    'another payload': { record: { payloadDigest: 'e'.repeat(64) } },
    'another original daemon key': { record: { originalDaemonKey: 'e'.repeat(64) } },
    'another original epoch': { record: { originalDaemonEpoch: 2 } },
    'another effect': { record: { effectId: '33333333-3333-4333-8333-333333333333' } },
    'no effect despite a preparation': { record: { effectId: null } },
    'a basis': { record: { basisDigest: 'e'.repeat(64) } },
    'a cold preimage for a revision': { preimage: structuredClone(budget.reconciliationPairs.find(({ id }) => id === 'cold-indeterminate-pair').record.preimage) },
    'another observed digest': { record: { observedDigest: 'e'.repeat(64) } },
  };
  for (const [name, change] of Object.entries(cases)) {
    await t.test(name, (tt) => {
      const j = journal(tt);
      unchanged(j, () => observe(j, pairFor(j, 'revision-indeterminate-pair', change)), invalid);
    });
  }
  await t.test('working digests on a record-only request', (tt) => {
    const j = journal(tt), pair = pairFor(j, 'revision-indeterminate-pair');
    pair.preimage.working = { rootDigest: 'f'.repeat(64), inventoryDigest: 'f'.repeat(64) };
    pair.record.observedDigest = sha256(canonicalJson(pair.preimage));
    unchanged(j, () => observe(j, pair), invalid);
  });
  await t.test('another request', (tt) => {
    const j = journal(tt);
    unchanged(j, () => observe(j, pairFor(j, 'revision-indeterminate-pair', { record: { requestId: '33333333-3333-4333-8333-333333333333' } })), invalid);
  });
  await t.test('a terminal finding', (tt) => {
    const j = journal(tt);
    unchanged(j, () => observe(j, pairFor(j, 'revision-applied-pair', { basis: Buffer.from('x') })), invalid);
  });
});

test('an observation pair is legal only after entry, while indeterminate', darwin, async (t) => {
  for (const [upTo, state] of [[null, 'admitted'], ['successful-check', 'released']]) {
    await t.test(state, (tt) => {
      const j = journal(tt, 'revision.approve', { upTo, enter: false });
      unchanged(j, () => observe(j, pairFor(j, 'revision-indeterminate-pair')), transition);
    });
  }
  await t.test('applied', (tt) => {
    const j = journal(tt, 'cold-wake.set'); j.complete();
    unchanged(j, () => observe(j, pairFor(j, 'cold-indeterminate-pair')), conflict);
  });
  await t.test('refused', (tt) => {
    const j = journal(tt, 'revision.approve', { enter: false }); j.refuse();
    unchanged(j, () => observe(j, pairFor(j, 'revision-indeterminate-pair')), conflict);
  });
  await t.test('a damaged preparation leaves nothing to observe against', (tt) => {
    const j = journal(tt);
    j.write('preparation', Buffer.from('{}'));
    unchanged(j, () => observe(j, pairFor(j, 'revision-indeterminate-pair')), transition);
  });
});

test('the terminal pair: applied on its completed record, refused on its proven refusal, once', darwin, async (t) => {
  await t.test('applied', (tt) => {
    const j = journal(tt, 'cold-wake.set'); j.complete();
    const pair = pairFor(j, 'cold-applied-pair', { basis: j.payload('completed') });
    const recorded = terminate(j, pair);
    assert.equal(recorded.state, 'applied');
    committed(j, 'terminal-pair', pair);
    assert.equal(j.recover().state, 'applied');
    assert.equal(terminate(j, pair).duplicate, true);
    unchanged(j, () => terminate(j, pairFor(j, 'cold-applied-pair', { basis: j.payload('completed'), record: { at: 7 } })), conflict);
  });
  await t.test('refused', (tt) => {
    const j = journal(tt, 'revision.approve', { enter: false }); j.refuse();
    const pair = pairFor(j, 'revision-refused-pair', { basis: j.payload('pre-effect-refused') });
    const recorded = terminate(j, pair);
    assert.equal(recorded.state, 'refused'); assert.equal(recorded.refusalReason, 'expected-state-changed');
    assert.equal(j.recover().outcome.code, 'validation-refused');
    assert.equal(terminate(j, pair).duplicate, true);
  });
  await t.test('refused, before the successful check (no receipt bound)', (tt) => {
    const j = journal(tt, 'revision.approve', { upTo: 'prepared-challenge', enter: false }); j.refuse();
    assert.equal(terminate(j, pairFor(j, 'revision-refused-pair', { basis: j.payload('pre-effect-refused') })).state, 'refused');
  });
});

test('a terminal pair needs exactly its proof', darwin, async (t) => {
  await t.test('entered without completion never justifies refused', (tt) => {
    const j = journal(tt);
    unchanged(j, () => terminate(j, pairFor(j, 'revision-refused-pair', { basis: j.payload('entered') })), transition);
  });
  for (const [upTo, state] of [[null, 'admitted'], ['successful-check', 'released']]) {
    await t.test(state, (tt) => {
      const j = journal(tt, 'revision.approve', { upTo, enter: false });
      unchanged(j, () => terminate(j, pairFor(j, 'revision-refused-pair', { basis: Buffer.from('x') })), transition);
    });
  }
  await t.test('the wrong finding or basis', (tt) => {
    const j = journal(tt, 'cold-wake.set'); j.complete();
    unchanged(j, () => terminate(j, pairFor(j, 'cold-refused-pair', { basis: j.payload('completed') })), invalid);
    unchanged(j, () => terminate(j, pairFor(j, 'cold-applied-pair', { basis: j.payload('entered') })), invalid);
    unchanged(j, () => terminate(j, pairFor(j, 'cold-applied-pair', { basis: j.payload('completed'), record: { effectId: '33333333-3333-4333-8333-333333333333' } })), invalid);
    unchanged(j, () => terminate(j, pairFor(j, 'revision-applied-pair', { basis: j.payload('completed') })), invalid);
  });
  await t.test('an observation finding', (tt) => {
    const j = journal(tt, 'cold-wake.set'); j.complete();
    unchanged(j, () => terminate(j, pairFor(j, 'cold-indeterminate-pair')), invalid);
  });
});

test('the reader validates a terminal pair against its proof, and refuses one where none can exist', darwin, async (t) => {
  await t.test('beside a refusal, a mismatched pair refuses the request as corrupt', (tt) => {
    const j = journal(tt, 'revision.approve', { enter: false }); j.refuse();
    j.write('terminal-pair', Buffer.from(canonicalJson(pairFor(j, 'revision-refused-pair', { basis: Buffer.from('x') }))));
    assert.throws(() => j.recover(), { reason: 'owner-journal-corrupt', code: 'storage-failed' });
  });
  await t.test('beside an applied effect, a mismatched pair is only indeterminate', (tt) => {
    const j = journal(tt, 'cold-wake.set'); j.complete();
    j.write('terminal-pair', Buffer.from(canonicalJson(pairFor(j, 'cold-applied-pair', { basis: Buffer.from('x') }))));
    assert.deepEqual(j.recover().outcome, { code: 'effect-uncertain', effectDigest: null });
  });
  await t.test('before entry with no refusal', (tt) => {
    const j = journal(tt, 'revision.approve', { enter: false });
    j.write('terminal-pair', Buffer.from(canonicalJson(pairFor(j, 'revision-refused-pair', { basis: Buffer.from('x') }))));
    assert.throws(() => j.recover(), { reason: 'owner-journal-unsupported-phase' });
  });
  await t.test('a terminal pair beside an observation refuses the observation write', (tt) => {
    const j = journal(tt);
    j.write('terminal-pair', Buffer.from('{}'));
    unchanged(j, () => observe(j, pairFor(j, 'revision-indeterminate-pair')), conflict);
  });
});

test('pair writers scan first, flush before writing, refuse busy, and refuse malformed input before the lock', darwin, async (t) => {
  await t.test('an unknown entry refuses and poisons', (tt) => {
    const j = journal(tt), store = j.open(), unknown = path.join(j.root, 'requests', 'not-a-request');
    fs.mkdirSync(unknown);
    unchanged(j, () => observe(j, pairFor(j, 'revision-indeterminate-pair'), store), { reason: 'owner-journal-corrupt' });
    fs.rmdirSync(unknown);
    unchanged(j, () => observe(j, pairFor(j, 'revision-indeterminate-pair'), store), { reason: 'owner-journal-reopen-required' });
    assert.equal(observe(j, pairFor(j, 'revision-indeterminate-pair')).state, 'indeterminate');
  });
  await t.test('an unknown request', (tt) => {
    const j = journal(tt);
    assert.throws(() => j.open().recordObservationPair('33333333-3333-4333-8333-333333333333', pairFor(j, 'revision-indeterminate-pair')), transition);
  });
  await t.test('the recovery flush comes first', (tt) => {
    const j = journal(tt), seen = [];
    observe(j, pairFor(j, 'revision-indeterminate-pair'), j.open({ fault: (at) => seen.push(at) }));
    const flushed = seen.indexOf('recovery:directories-flushed');
    assert(flushed >= 0 && flushed < seen.indexOf('observation-pair:body-written'), seen.join(' '));
  });
  await t.test('busy', (tt) => {
    const j = journal(tt), held = acquireDaemonJournalLock(j.root);
    try { unchanged(j, () => observe(j, pairFor(j, 'revision-indeterminate-pair')), { reason: 'owner-journal-busy' }); } finally { fs.closeSync(held); }
  });
  await t.test('malformed input', (tt) => {
    const j = journal(tt), held = acquireDaemonJournalLock(j.root);
    try {
      for (const run of [() => observe(j, null), () => terminate(j, []), () => j.open().recordObservationPair('nope', {})]) assert.throws(run, invalid);
    } finally { fs.closeSync(held); }
  });
  await t.test('a refusal leaves the instance usable', (tt) => {
    const j = journal(tt), store = j.open();
    assert.throws(() => observe(j, pairFor(j, 'revision-indeterminate-pair', { record: { effectId: null } }), store), invalid);
    assert.throws(() => terminate(j, pairFor(j, 'revision-refused-pair', { basis: Buffer.from('x') }), store), transition);
    assert.equal(observe(j, pairFor(j, 'revision-indeterminate-pair'), store).state, 'indeterminate');
    assert.throws(() => observe(j, pairFor(j, 'revision-indeterminate-pair', { record: { at: 7 } }), store), conflict);
  });
  await t.test('a torn observation stays indeterminate and conflicts', (tt) => {
    const j = journal(tt);
    assert.throws(() => observe(j, pairFor(j, 'revision-indeterminate-pair'), j.open({ fault: (at) => { if (at === 'observation-pair:body-written') throw new Error('crash'); } })));
    assert.equal(j.recover().state, 'indeterminate');
    assert.throws(() => observe(j, pairFor(j, 'revision-indeterminate-pair')), conflict);
  });
});
