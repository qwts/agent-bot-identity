// Disabled typed effect evidence (agent-comms#77, C1). The fixture is
// agent-comms tests/fixtures/owner-decisions/effect-evidence-v1.json at
// f42c05b (last changed in d803a98), copied byte for byte.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { canonicalJson } from '../canonical-json.mjs';
import { encodeDaemonJournalFrame, requestDirectoryName } from '../identity/owner-decision-journal-frame.mjs';
import { createDaemonJournalStore, initializeDaemonJournal } from '../identity/owner-decision-journal-store.mjs';
import {
  REFUSAL_OUTCOMES, bindEffect, bindPreparation, challengeFor, coldStateDigest, decodeEffect, decodePreparation, effectOutcome, reconciliationFinding,
} from '../identity/owner-decision-evidence.mjs';

const FIXTURE_URL = new URL('./fixtures/owner-decisions/effect-evidence-v1.json', import.meta.url);
const FIXTURE_SHA256 = '4363adad57e232231d2893c4e20b37b4b28048d307893d6ebf97fb01042de4b4';
const fixture = JSON.parse(fs.readFileSync(FIXTURE_URL, 'utf8'));
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const darwin = { skip: process.platform !== 'darwin' && 'the journal lock is Darwin-only' };
const invalid = (reason = 'owner-evidence-invalid') => ({ code: 'invalid-owner-decision-evidence', reason });
const byId = (id) => fixture.records.find((record) => record.id === id);
const bytesOf = (vector) => Buffer.from(vector.canonicalJson);

// The signed action each fixture transaction implies (the fixture carries
// preparations, not actions): the operation's parameters as the daemon would
// have validated them.
function actionFor(id, p) {
  const e = p.expected, reason = 'r';
  let parameters;
  if (['revision.approve', 'revision.reject'].includes(p.operation)) parameters = { proposalId: e.proposal.proposalId, expectedRevision: e.head.revision, reason };
  else if (p.operation === 'revision.adopt') parameters = { stagingId: p.stage.stagingId, packageDigest: p.stage.contentDigest, expectedRevision: null, reason };
  else if (p.operation === 'revision.edit') {
    parameters = { stagingId: p.stage.stagingId, packageDigest: p.stage.contentDigest, expectedRevision: e.head.revision, reason, apply: e.destination !== null };
  } else {
    const mode = id.replace(/^wake-/, '').replace(/-preparation$/, '');
    parameters = mode.startsWith('resume') ? { mode: 'resume', policy: mode.replace('resume-', '') }
      : mode === 'webhook' ? { mode, stagingId: p.stage.stagingId, configurationDigest: p.stage.contentDigest, host: 'example.com' } : { mode };
  }
  return { v: 1, requestId: p.requestId, principal: p.principal, account: p.account, soul: p.soul, operation: p.operation, parameters };
}

test('the vendored effect evidence is the pinned copy and every record decodes to its exact bytes', () => {
  assert.equal(sha256(fs.readFileSync(FIXTURE_URL)), FIXTURE_SHA256);
  let decoded = 0;
  for (const vector of [...fixture.records, ...fixture.maximalRecords]) {
    if (vector.record.kind === 'reconciliation') continue; // paired reconciliation is the frame codec's
    const value = (vector.record.kind === 'preparation' ? decodePreparation : decodeEffect)(bytesOf(vector));
    assert.deepEqual(value, vector.record, vector.id);
    assert.equal(canonicalJson(value), vector.canonicalJson); assert.equal(sha256(bytesOf(vector)), vector.sha256);
    assert(vector.utf8Bytes <= vector.cap);
    decoded++;
  }
  assert.equal(decoded, 68);
});

test('every fixture transaction binds: entered and completed to their preparation, refusal before entry', () => {
  const preparations = fixture.records.filter(({ record }) => record.kind === 'preparation');
  assert.equal(preparations.length, 11);
  for (const vector of preparations) {
    const preparation = decodePreparation(bytesOf(vector));
    const effects = fixture.records.filter(({ record }) => record.kind === 'effect' && record.requestId === preparation.requestId);
    const enteredVector = effects.find(({ record }) => record.phase === 'entered');
    const receiptDigest = enteredVector.record.receiptDigest, action = actionFor(vector.id, preparation);
    bindPreparation(preparation, { acceptance: preparation, action });
    const entered = bindEffect(decodeEffect(bytesOf(enteredVector)), { phase: 'entered', preparation, preparationDigest: vector.sha256, receiptDigest, action });
    bindEffect(decodeEffect(bytesOf(effects.find(({ record }) => record.phase === 'completed'))),
      { phase: 'completed', preparation, preparationDigest: vector.sha256, receiptDigest, action, entered });
    const refused = effects.find(({ record }) => record.phase === 'refused');
    if (refused) bindEffect(decodeEffect(bytesOf(refused)), { phase: 'refused', preparation, preparationDigest: vector.sha256, receiptDigest, action });
    if (preparation.operation === 'cold-wake.set') assert.equal(entered.detail.beforeDigest, coldStateDigest(preparation.expected));
  }
});

// agent-comms tests/fixtures/owner-decisions/effect-outcomes-v1.json at
// 77bb19c (merged #212), copied byte for byte: the agreed public outcome for
// every evidence record, all eight final-refusal reasons included.
const OUTCOMES_URL = new URL('./fixtures/owner-decisions/effect-outcomes-v1.json', import.meta.url);
test('every agreed outcome mapping is exactly what this producer reports', () => {
  assert.equal(sha256(fs.readFileSync(OUTCOMES_URL)), '3c88bd10694cbe27347da6062e71773efc62575b80b85f738287bc945a60898e');
  const outcomes = JSON.parse(fs.readFileSync(OUTCOMES_URL, 'utf8'));
  assert.equal(outcomes.sourceSha256, FIXTURE_SHA256);
  assert.equal(outcomes.results.length, 34); assert.equal(outcomes.refusalRecords.length, 7);
  const records = new Map([...fixture.records, ...outcomes.refusalRecords].map((vector) => [vector.id, vector]));
  for (const vector of outcomes.refusalRecords) {
    assert.deepEqual(decodeEffect(bytesOf(vector)), vector.record, vector.id);
    assert.equal(sha256(bytesOf(vector)), vector.sha256, vector.id);
  }
  for (const result of outcomes.results) {
    if (result.evidenceRecord === null) {
      // Early refusal and absent proof: no record, so never a digest.
      assert.equal(result.outcome.effectDigest, null, result.id);
      continue;
    }
    assert.deepEqual(effectOutcome(bytesOf(records.get(result.evidenceRecord))), { state: result.state, outcome: result.outcome }, result.id);
  }
  const reasons = [...records.values()].filter(({ record }) => record.phase === 'refused').map(({ record }) => record.detail.code);
  assert.deepEqual(new Set(reasons), new Set(Object.keys(REFUSAL_OUTCOMES)));
  assert.equal(Object.keys(REFUSAL_OUTCOMES).length, 8);
});

test('the recovery classification reproduces all nine agent-comms cases', () => {
  assert.equal(fixture.recoveryCases.length, 9);
  for (const scenario of fixture.recoveryCases) assert.equal(reconciliationFinding(scenario), scenario.expected, scenario.id);
});

test('records outside the exact typed shapes refuse', () => {
  const prep = byId('approve-preparation').record, entered = byId('approve-entered').record, refused = byId('final-refusal').record;
  const edits = [
    [prep, (r) => { r.extra = 1; }], [prep, (r) => { r.v = 2; }], [prep, (r) => { r.nonce = `${r.nonce}=`; }],
    [prep, (r) => { r.daemonEpoch = 0; }], [prep, (r) => { r.expected.proposal = null; }],
    [prep, (r) => { r.expected.destination = { rootDigest: 'd'.repeat(64), beforeInventoryDigest: 'e'.repeat(64) }; }],
    [prep, (r) => { r.expected.proposal.parentRevision = `sha256:${'f'.repeat(64)}`; }], [prep, (r) => { r.operation = 'revision.adopt'; }],
    [prep, (r) => { r.stage = { stagingId: r.requestId, kind: 'archive', contentDigest: 'a'.repeat(64), expiresAt: 1 }; }],
    [entered, (r) => { r.receiptDigest = null; }], [entered, (r) => { r.phase = 'started'; }], [entered, (r) => { delete r.detail.apply; }],
    [entered, (r) => { r.detail.afterRevision = null; }], [refused, (r) => { r.detail.code = 'oops'; }], [refused, (r) => { r.detail.extra = 1; }],
  ];
  for (const [base, edit] of edits) {
    const record = structuredClone(base); edit(record);
    const decode = record.kind === 'preparation' ? decodePreparation : decodeEffect;
    assert.throws(() => decode(Buffer.from(canonicalJson(record))), invalid(), JSON.stringify(record).slice(0, 80));
  }
  // Exact bytes only: whitespace, a trailing newline or oversize refuse.
  assert.throws(() => decodePreparation(Buffer.from(` ${byId('approve-preparation').canonicalJson}`)), invalid());
  assert.throws(() => decodeEffect(Buffer.from(`${byId('approve-entered').canonicalJson}\n`)), invalid());
  assert.throws(() => decodeEffect(Buffer.alloc(4097, 0x20)), invalid());
});

test('effect records bind to exactly their preparation, receipt and entered transition', () => {
  const pv = byId('approve-preparation'), preparation = decodePreparation(bytesOf(pv));
  const ev = byId('approve-entered'), receiptDigest = ev.record.receiptDigest, action = actionFor(pv.id, preparation);
  const base = { phase: 'entered', preparation, preparationDigest: pv.sha256, receiptDigest, action };
  const entered = bindEffect(decodeEffect(bytesOf(ev)), base);
  const binding = invalid('owner-evidence-binding');
  for (const options of [{ preparationDigest: 'f'.repeat(64) }, { receiptDigest: 'f'.repeat(64) }, { phase: 'completed', entered },
    { action: { ...action, parameters: { ...action.parameters, proposalId: '44444444-4444-4444-8444-444444444444' } } },
    { action: { ...action, parameters: { ...action.parameters, expectedRevision: `sha256:${'f'.repeat(64)}` } } }, { action: undefined }]) {
    assert.throws(() => bindEffect(decodeEffect(bytesOf(ev)), { ...base, ...options }), binding, JSON.stringify(Object.keys(options)));
  }
  for (const edit of [(r) => { r.effectId = '33333333-3333-4333-8333-333333333333'; }, (r) => { r.detail.afterRevision = r.detail.beforeRevision; },
    (r) => { r.detail.proposalId = null; }, (r) => { r.detail.beforeRevision = `sha256:${'f'.repeat(64)}`; }]) {
    const record = structuredClone(ev.record); edit(record);
    assert.throws(() => bindEffect(record, base), binding);
  }
  const completed = structuredClone(byId('approve-completed').record);
  completed.detail.working = { rootDigest: 'd'.repeat(64), inventoryDigest: 'e'.repeat(64) };
  assert.throws(() => bindEffect(completed, { ...base, phase: 'completed', entered }), binding);
  // A cold entry must start from the prepared typed state.
  const cp = byId('wake-on-preparation'), cold = decodePreparation(bytesOf(cp)), ce = structuredClone(byId('wake-on-entered').record);
  const coldAction = actionFor(cp.id, cold), coldBase = { phase: 'entered', preparation: cold, preparationDigest: cp.sha256, receiptDigest: ce.receiptDigest };
  bindEffect(ce, { ...coldBase, action: coldAction });
  // The after state is what the action asks for: a different mode does not bind.
  assert.throws(() => bindEffect(ce, { ...coldBase, action: { ...coldAction, parameters: { mode: 'off' } } }), binding);
  ce.detail.beforeDigest = 'f'.repeat(64);
  assert.throws(() => bindEffect(ce, { ...coldBase, action: coldAction }), binding);
  // A completed cold record must name the requested setting and webhook.
  const wv = byId('wake-webhook-preparation'), webhook = decodePreparation(bytesOf(wv)), wAction = actionFor(wv.id, webhook);
  const wEntered = byId('wake-webhook-entered').record, wCompleted = structuredClone(byId('wake-webhook-completed').record);
  const wBase = { preparation: webhook, preparationDigest: wv.sha256, receiptDigest: wEntered.receiptDigest, action: wAction };
  bindEffect(wCompleted, { ...wBase, phase: 'completed', entered: wEntered });
  for (const edit of [(r) => { r.detail.webhookDigest = null; }, (r) => { r.detail.settingsDigest = 'f'.repeat(64); }]) {
    const record = structuredClone(wCompleted); edit(record);
    assert.throws(() => bindEffect(record, { ...wBase, phase: 'completed', entered: wEntered }), binding);
  }
  // Adopt and edit must land exactly the staged package.
  for (const id of ['adopt', 'edit-apply', 'edit-record']) {
    const v = byId(`${id}-preparation`), p = decodePreparation(bytesOf(v)), a = actionFor(v.id, p);
    const en = byId(`${id}-entered`).record, opts = { phase: 'entered', preparation: p, preparationDigest: v.sha256, receiptDigest: en.receiptDigest };
    bindEffect(en, { ...opts, action: a });
    assert.throws(() => bindEffect(en, { ...opts, action: { ...a, parameters: { ...a.parameters, packageDigest: 'e'.repeat(64) } } }), binding, id);
    if (id.startsWith('edit')) assert.throws(() => bindEffect(en, { ...opts, action: { ...a, parameters: { ...a.parameters, apply: !a.parameters.apply } } }), binding, id);
  }
});

// --- the store's typed graph, end to end on disk ---

const namespaceDigest = 'a'.repeat(64);
const template = byId('approve-preparation').record;

function transaction({ operation = 'revision.approve', requestId = '11111111-1111-4111-8111-111111111111' } = {}) {
  const cold = operation === 'cold-wake.set';
  const parameters = cold ? { mode: 'on' }
    : { proposalId: template.expected.proposal.proposalId, expectedRevision: template.expected.head.revision, reason: 'Ship it' };
  const action = Buffer.from(canonicalJson({ v: 1, requestId, principal: template.principal, account: template.account, soul: template.soul, operation, parameters }));
  const acceptance = { v: 1, kind: 'acceptance', requestId, principal: template.principal, account: template.account, soul: template.soul, operation,
    payloadDigest: sha256(action), namespaceDigest, acceptedAt: 2_000_000_000, daemonKey: template.daemonKey, daemonEpoch: 1,
    watchId: template.watchId, reservationBytes: 524288 };
  const expected = cold ? byId('wake-on-preparation').record.expected : template.expected;
  const preparation = { ...template, requestId, operation, payloadDigest: acceptance.payloadDigest, expected,
    acceptedAt: 2_000_000_000, preparedAt: 2_000_000_000, exp: 2_000_000_180 };
  const preparationBytes = Buffer.from(canonicalJson(preparation)), preparationDigest = sha256(preparationBytes);
  const receipt = Buffer.from('d1.payload.signature'), presence = Buffer.from('p1.payload.signature'), receiptDigest = sha256(receipt);
  const check = Buffer.from(canonicalJson({ requestId, payloadDigest: acceptance.payloadDigest, receiptDigest, daemonKey: acceptance.daemonKey,
    daemonEpoch: 1, watchId: acceptance.watchId, state: 'released', mayApply: true, exp: 2_000_000_060 }));
  const effect = (phase, detail) => Buffer.from(canonicalJson({ v: 1, kind: 'effect', requestId, payloadDigest: acceptance.payloadDigest,
    preparationDigest, receiptDigest, effectId: preparation.effectId, phase, at: 2_000_000_010, detail }));
  const enteredDetail = cold ? byId('wake-on-entered').record.detail : byId('approve-entered').record.detail;
  const linked = Buffer.from(`${JSON.stringify({ schemaVersion: 1, kind: 'revision', revision: enteredDetail.afterRevision ?? null,
    parentRevision: enteredDetail.beforeRevision ?? null, author: 'soul', reason: 'Ship it', proposalId: parameters.proposalId,
    approval: 'user', approvedBy: 'user', approvalReason: 'ok',
    ownerDecision: { requestId, payloadDigest: acceptance.payloadDigest, receiptDigest, effectId: preparation.effectId, preparationDigest },
    at: new Date(2_000_000_010_000).toISOString() })}\n`);
  const completedDetail = cold ? byId('wake-on-completed').record.detail : { ...byId('approve-completed').record.detail, journalRecordDigest: sha256(linked) };
  return {
    requestId, action, acceptance: Buffer.from(canonicalJson(acceptance)),
    slots: {
      preparation: preparationBytes, 'prepared-challenge': challengeFor(preparation, action), presence, receipt, 'successful-check': check,
      'pre-effect-refused': effect('refused', { code: 'expected-state-changed' }), entered: effect('entered', enteredDetail),
      completed: effect('completed', completedDetail), 'linked-authoritative-event': linked,
    },
  };
}

function journal(t, tx) {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(tmpdir(), 'owner-evidence-')));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const root = path.join(base, 'journal');
  initializeDaemonJournal(root);
  createDaemonJournalStore({ root, namespaceDigest }).admit(tx.action, tx.acceptance);
  const dir = path.join(root, 'requests', requestDirectoryName({ namespaceDigest, requestId: tx.requestId }));
  const write = (slot, payload = tx.slots[slot]) => fs.writeFileSync(path.join(dir, `${slot}.record`),
    encodeDaemonJournalFrame(payload, { namespaceDigest, requestId: tx.requestId, slot }));
  const recover = () => createDaemonJournalStore({ root, namespaceDigest }).recover(tx.requestId);
  return { write, recover };
}

test('the store walks a revision request through every phase to applied', darwin, (t) => {
  const tx = transaction(), j = journal(t, tx);
  assert.equal(j.recover().state, 'admitted');
  j.write('preparation'); assert.equal(j.recover().state, 'preparing');
  j.write('prepared-challenge'); assert.equal(j.recover().state, 'prepared');
  j.write('presence'); j.write('receipt'); assert.equal(j.recover().state, 'authorizing');
  j.write('successful-check'); assert.equal(j.recover().state, 'released');
  j.write('entered');
  assert.deepEqual(j.recover().outcome, { code: 'effect-uncertain', effectDigest: null });
  j.write('completed');
  // Completed without its linked authoritative event is not proof.
  assert.equal(j.recover().state, 'indeterminate');
  j.write('linked-authoritative-event');
  const applied = j.recover();
  assert.equal(applied.state, 'applied');
  assert.deepEqual(applied.outcome, { code: 'applied', effectDigest: sha256(tx.slots.completed) });
});

test('a cold-wake request is applied from its completed record alone, never with a linked event', darwin, (t) => {
  const tx = transaction({ operation: 'cold-wake.set' }), j = journal(t, tx);
  for (const slot of ['preparation', 'prepared-challenge', 'presence', 'receipt', 'successful-check', 'entered', 'completed']) j.write(slot);
  assert.equal(j.recover().state, 'applied');
  j.write('linked-authoritative-event');
  assert.equal(j.recover().state, 'indeterminate');
});

test('a proven pre-effect refusal is refused with its effect digest', darwin, (t) => {
  const tx = transaction(), j = journal(t, tx);
  for (const slot of ['preparation', 'prepared-challenge', 'presence', 'receipt', 'successful-check', 'pre-effect-refused']) j.write(slot);
  const refused = j.recover();
  assert.equal(refused.state, 'refused'); assert.equal(refused.refusalReason, 'expected-state-changed');
  assert.deepEqual(refused.outcome, { code: 'validation-refused', effectDigest: sha256(tx.slots['pre-effect-refused']) });
});

test('before entry an inconsistent graph refuses; after entry it is only ever indeterminate', darwin, async (t) => {
  const before = [
    ['a challenge that is not the preparation\'s', (tx, j) => { j.write('preparation'); j.write('prepared-challenge', Buffer.from('{}')); }],
    ['a check without its receipt', (tx, j) => { j.write('preparation'); j.write('prepared-challenge'); j.write('presence'); j.write('successful-check'); }],
    ['completed without entered', (tx, j) => { j.write('preparation'); j.write('completed'); }],
    ['a preparation naming another proposal', (tx, j) => {
      const p = JSON.parse(tx.slots.preparation); p.expected.proposal.proposalId = '44444444-4444-4444-8444-444444444444';
      j.write('preparation', Buffer.from(canonicalJson(p)));
    }],
    ['a preparation for another request time', (tx, j) => {
      const p = JSON.parse(tx.slots.preparation); p.acceptedAt += 1; j.write('preparation', Buffer.from(canonicalJson(p)));
    }],
  ];
  for (const [name, damage] of before) {
    await t.test(name, (tt) => {
      const tx = transaction(), j = journal(tt, tx);
      damage(tx, j);
      assert.throws(() => j.recover(), { code: 'storage-failed' }, name);
    });
  }
  const after = [
    ['a completed record for another transition', (tx, j) => {
      const c = JSON.parse(tx.slots.completed); c.detail.journalRecordDigest = 'f'.repeat(64); j.write('completed', Buffer.from(canonicalJson(c)));
      j.write('linked-authoritative-event');
    }],
    ['entered with a pre-effect refusal beside it', (tx, j) => { j.write('pre-effect-refused'); j.write('completed'); j.write('linked-authoritative-event'); }],
    ['entered without the check', (tx, j) => { j.write('completed'); j.write('linked-authoritative-event'); }, ['successful-check']],
  ];
  after.push(['a linked event recording another revision', (tx, j) => {
    const event = JSON.parse(tx.slots['linked-authoritative-event']); event.revision = `sha256:${'e'.repeat(64)}`;
    const bytes = Buffer.from(`${JSON.stringify(event)}\n`);
    const c = JSON.parse(tx.slots.completed); c.detail.journalRecordDigest = sha256(bytes);
    j.write('completed', Buffer.from(canonicalJson(c))); j.write('linked-authoritative-event', bytes);
  }]);
  for (const [name, damage, skip = []] of after) {
    await t.test(name, (tt) => {
      const tx = transaction(), j = journal(tt, tx);
      for (const slot of ['preparation', 'prepared-challenge', 'presence', 'receipt', 'successful-check', 'entered']) if (!skip.includes(slot)) j.write(slot);
      damage(tx, j);
      const result = j.recover();
      assert.equal(result.state, 'indeterminate', name);
      assert.deepEqual(result.outcome, { code: 'effect-uncertain', effectDigest: null });
    });
  }
});

test('a preparation must name exactly what the signed action names, for every variant', () => {
  const binding = invalid('owner-evidence-binding');
  const cases = {
    'approve-preparation': [(a) => { a.parameters.proposalId = '44444444-4444-4444-8444-444444444444'; }, (a) => { a.parameters.expectedRevision = `sha256:${'f'.repeat(64)}`; }],
    'reject-preparation': [(a) => { a.parameters.proposalId = '44444444-4444-4444-8444-444444444444'; }],
    'adopt-preparation': [(a) => { a.parameters.expectedRevision = `sha256:${'a'.repeat(64)}`; }],
    'edit-apply-preparation': [(a) => { a.parameters.expectedRevision = `sha256:${'f'.repeat(64)}`; }, (a) => { a.parameters.apply = false; }],
    'wake-on-preparation': [(a) => { a.parameters = { mode: 'resume', policy: 'workspace' }; }, (a) => { a.parameters = { mode: 'sideways' }; }],
    'wake-resume-workspace-preparation': [(a) => { a.parameters = { mode: 'on' }; }],
    'wake-webhook-preparation': [(a) => { a.parameters.stagingId = '44444444-4444-4444-8444-444444444444'; }, (a) => { a.parameters.configurationDigest = 'e'.repeat(64); }],
  };
  for (const [id, edits] of Object.entries(cases)) {
    const p = decodePreparation(bytesOf(byId(id)));
    bindPreparation(p, { acceptance: p, action: actionFor(id, p) });
    for (const edit of edits) {
      const action = structuredClone(actionFor(id, p)); edit(action);
      assert.throws(() => bindPreparation(p, { acceptance: p, action }), binding, `${id} ${JSON.stringify(action.parameters)}`);
    }
  }
});

test('bindPreparation pins the acceptance binding, stage and exact deadline', () => {
  const tx = transaction();
  const acceptance = JSON.parse(tx.acceptance), action = JSON.parse(tx.action), preparation = decodePreparation(tx.slots.preparation);
  assert.equal(bindPreparation(preparation, { acceptance, action }), preparation);
  for (const edit of [(p) => { p.exp += 1; }, (p) => { p.watchId = '22222222-2222-4222-8222-222222222222'; }, (p) => { p.daemonEpoch = 2; },
    (p) => { p.stage = { stagingId: p.requestId, kind: 'package', contentDigest: 'a'.repeat(64), expiresAt: 2_000_000_100 }; }]) {
    const p = structuredClone(preparation); edit(p);
    assert.throws(() => bindPreparation(p, { acceptance, action }), invalid('owner-evidence-binding'));
  }
});
