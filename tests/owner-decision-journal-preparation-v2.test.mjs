// The v2 owner-decision preparation (agent-comms#77, owner decision Q3): the
// v1 fields plus `trustVersion`, the active trust enrollment's chain version.
// The vectors are agent-comms tests/fixtures/owner-decisions/effect-evidence-v2.json
// at bf0b705 (merged #235), copied byte for byte. Downstream effect records
// stay v1, re-bound to the v2 preparation digests.
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
import { bindEffect, bindPreparation, challengeFor, decodeEffect, decodePreparation } from '../identity/owner-decision-evidence.mjs';

const V2_URL = new URL('./fixtures/owner-decisions/effect-evidence-v2.json', import.meta.url);
const V2_SHA256 = 'ff7385f661bb0b0bbc2b36f94634ba1fd1ebcc359dce130149db8a21257e2410';
const V1_SHA256 = '4363adad57e232231d2893c4e20b37b4b28048d307893d6ebf97fb01042de4b4';
const v2 = JSON.parse(fs.readFileSync(V2_URL, 'utf8'));
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const bytesOf = (vector) => Buffer.from(vector.canonicalJson);
const byId = (id) => v2.records.find((record) => record.id === id);
const darwin = { skip: process.platform !== 'darwin' && 'the journal lock is Darwin-only' };
const invalid = { code: 'invalid-owner-decision-evidence' };

// The signed action each fixture transaction implies, as in the v1 evidence test.
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

test('the vendored v2 vectors are agent-comms bf0b705, built on the unchanged v1 vectors', () => {
  assert.equal(sha256(fs.readFileSync(V2_URL)), V2_SHA256);
  assert.equal(v2.version, 2); assert.equal(v2.sourceSha256, V1_SHA256);
  assert.equal(sha256(fs.readFileSync(new URL('./fixtures/owner-decisions/effect-evidence-v1.json', import.meta.url))), V1_SHA256);
  assert.equal(v2.records.length, 42);
});

test('every v2 record decodes to its exact bytes; every preparation is v2 with an odd trust version', () => {
  let preparations = 0;
  for (const vector of [...v2.records, ...v2.boundaryPreparations]) {
    if (vector.record.kind === 'reconciliation') continue; // the pair codec's, unchanged v1
    const value = (vector.record.kind === 'preparation' ? decodePreparation : decodeEffect)(bytesOf(vector));
    assert.deepEqual(value, vector.record, vector.id);
    assert.equal(sha256(bytesOf(vector)), vector.sha256, vector.id);
    if (vector.record.kind === 'preparation') {
      preparations++;
      assert.equal(value.v, 2); assert.equal(value.trustVersion % 2, 1);
    } else assert.equal(value.v, 1);
  }
  assert.equal(preparations, 12);
  assert.equal(decodePreparation(bytesOf(v2.boundaryPreparations[0])).trustVersion, 1023);
});

test('the six malformed v2 preparations refuse', () => {
  assert.deepEqual(v2.negatives.map(({ id }) => id), ['missing', 'even', 'zero', 'above-bound', 'noninteger', 'extra-key']);
  for (const vector of v2.negatives) {
    assert.equal(vector.expected, 'refused');
    assert.equal(sha256(bytesOf(vector)), vector.sha256, vector.id);
    assert.throws(() => decodePreparation(bytesOf(vector)), invalid, vector.id);
  }
  // v1 with a trust version, or v2 without one, is neither shape.
  const v2Prep = byId('approve-preparation').record;
  assert.throws(() => decodePreparation(Buffer.from(canonicalJson({ ...v2Prep, v: 1 }))), invalid);
  const { trustVersion, ...withoutVersion } = v2Prep; void trustVersion;
  assert.throws(() => decodePreparation(Buffer.from(canonicalJson(withoutVersion))), invalid);
  assert.throws(() => decodePreparation(Buffer.from(canonicalJson({ ...v2Prep, v: 3 }))), invalid);
  assert.throws(() => decodePreparation(Buffer.from(canonicalJson({ ...withoutVersion, v: 3 }))), invalid);
  assert.throws(() => decodePreparation(Buffer.from(canonicalJson({ ...v2Prep, trustVersion: -1 }))), invalid);
});

test('every v2 transaction binds downstream to its v2 preparation, and the challenge never carries the trust version', () => {
  for (const vector of v2.records.filter(({ record }) => record.kind === 'preparation')) {
    const preparation = decodePreparation(bytesOf(vector));
    const effects = v2.records.filter(({ record }) => record.kind === 'effect' && record.requestId === preparation.requestId);
    const enteredVector = effects.find(({ record }) => record.phase === 'entered');
    const receiptDigest = enteredVector.record.receiptDigest, action = actionFor(vector.id, preparation);
    bindPreparation(preparation, { acceptance: preparation, action });
    const entered = bindEffect(decodeEffect(bytesOf(enteredVector)), { phase: 'entered', preparation, preparationDigest: vector.sha256, receiptDigest, action });
    bindEffect(decodeEffect(bytesOf(effects.find(({ record }) => record.phase === 'completed'))),
      { phase: 'completed', preparation, preparationDigest: vector.sha256, receiptDigest, action, entered });
    // Downstream records bind the v2 digest, never the v1 one.
    assert.notEqual(vector.sha256, sha256(Buffer.from(canonicalJson({ ...preparation, v: 1, trustVersion: undefined }))));
    const actionBytes = Buffer.from(canonicalJson(action));
    const challenge = challengeFor(preparation, actionBytes);
    assert(!challenge.toString().includes('trustVersion'));
    const { trustVersion, ...v1Shape } = preparation; void trustVersion;
    assert(challenge.equals(challengeFor({ ...v1Shape, v: 1 }, actionBytes)));
  }
});

// --- the preparation writer ---

const namespaceDigest = 'a'.repeat(64);
const template = byId('approve-preparation').record;

function admitted(t) {
  const requestId = '11111111-1111-4111-8111-111111111111';
  const parameters = { proposalId: template.expected.proposal.proposalId, expectedRevision: template.expected.head.revision, reason: 'Ship it' };
  const action = Buffer.from(canonicalJson({ v: 1, requestId, principal: template.principal, account: template.account, soul: template.soul,
    operation: 'revision.approve', parameters }));
  const acceptance = { v: 1, kind: 'acceptance', requestId, principal: template.principal, account: template.account, soul: template.soul,
    operation: 'revision.approve', payloadDigest: sha256(action), namespaceDigest, acceptedAt: 2_000_000_000, daemonKey: template.daemonKey,
    daemonEpoch: 1, watchId: template.watchId, reservationBytes: 524288 };
  const base = fs.realpathSync(fs.mkdtempSync(path.join(tmpdir(), 'owner-preparation-')));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const root = path.join(base, 'journal');
  initializeDaemonJournal(root);
  const open = (options = {}) => createDaemonJournalStore({ root, namespaceDigest, ...options });
  open().admit(action, Buffer.from(canonicalJson(acceptance)));
  // Every preparation field except v, kind and trustVersion, which the store adds.
  const { v, kind, trustVersion, ...fields } = template; void v; void kind; void trustVersion;
  const preparation = { ...fields, requestId, payloadDigest: acceptance.payloadDigest, actionDigest: fields.actionDigest };
  const dir = path.join(root, 'requests', requestDirectoryName({ namespaceDigest, requestId }));
  const read = (slot) => fs.readFileSync(path.join(dir, `${slot}.record`));
  const payload = (slot) => decodeDaemonJournalFrame(read(slot), { namespaceDigest, requestId, slot }).payload;
  const prepare = (input = {}, store = open()) => store.recordPreparation(requestId, { preparation, trustVersion: 1, ...input });
  const recover = () => open().recover(requestId);
  return { root, requestId, action, preparation, open, read, payload, prepare, recover };
}
const snapshot = (j) => ['preparation', 'prepared-challenge'].map((slot) => sha256(j.read(slot)));
function unchanged(j, run, expected) {
  const before = snapshot(j);
  assert.throws(run, expected);
  assert.deepEqual(snapshot(j), before);
}
const badRequest = { reason: 'invalid-owner-journal-record', code: 'bad-request' };
const conflict = { reason: 'owner-journal-conflict', code: 'conflict' };

test('the writer records a v2 preparation with the trust version, then its exact challenge', darwin, (t) => {
  const j = admitted(t);
  for (const trustVersion of [1, 1023]) {
    const k = trustVersion === 1 ? j : admitted(t);
    assert.equal(k.prepare({ trustVersion }).state, 'prepared');
    const record = JSON.parse(k.payload('preparation'));
    assert.equal(record.v, 2); assert.equal(record.trustVersion, trustVersion);
    assert.deepEqual(record, { ...k.preparation, v: 2, kind: 'preparation', trustVersion });
    assert(k.payload('prepared-challenge').equals(challengeFor(record, k.action)));
    assert(!k.payload('prepared-challenge').toString().includes('trustVersion'));
  }
  // The same preparation again is an idempotent duplicate; any other conflicts.
  assert.equal(j.prepare().duplicate, true);
  unchanged(j, () => j.prepare({ trustVersion: 3 }), conflict);
  unchanged(j, () => j.prepare({ preparation: { ...j.preparation, effectId: '33333333-3333-4333-8333-333333333333' } }), conflict);
});

test('a malformed trust version or preparation refuses and writes nothing', darwin, async (t) => {
  for (const trustVersion of [undefined, 0, 2, 1024, 1025, 1.5, '1', null]) {
    await t.test(String(trustVersion), (tt) => {
      const j = admitted(tt);
      unchanged(j, () => j.prepare({ trustVersion }), badRequest);
      assert.equal(j.recover().state, 'admitted');
    });
  }
  await t.test('a trust version smuggled in the preparation', (tt) => {
    const j = admitted(tt);
    unchanged(j, () => j.prepare({ preparation: { ...j.preparation, trustVersion: 1 } }), badRequest);
  });
  await t.test('a preparation for another request or payload', (tt) => {
    const j = admitted(tt);
    unchanged(j, () => j.prepare({ preparation: { ...j.preparation, payloadDigest: 'e'.repeat(64) } }), badRequest);
    unchanged(j, () => j.prepare({ preparation: { ...j.preparation, extra: 1 } }), badRequest);
  });
  await t.test('malformed input refuses before the lock', (tt) => {
    const j = admitted(tt), held = acquireDaemonJournalLock(j.root);
    try {
      assert.throws(() => j.prepare({ preparation: null }), badRequest);
      assert.throws(() => j.open().recordPreparation('nope', { preparation: j.preparation, trustVersion: 1 }), badRequest);
    } finally { fs.closeSync(held); }
  });
});

test('a crash between the preparation and its challenge is finished by the same preparation, never another', darwin, (t) => {
  const j = admitted(t);
  assert.throws(() => j.prepare({}, j.open({ fault: (at) => { if (at === 'preparation:trailer-flushed') throw new Error('crash'); } })));
  assert.equal(j.recover().state, 'preparing');
  unchanged(j, () => j.prepare({ trustVersion: 3 }), conflict);
  assert.equal(j.prepare().state, 'prepared');
});

test('the writer scans first, flushes first, refuses busy, and conflicts in any later phase', darwin, async (t) => {
  await t.test('an unknown entry refuses and poisons', (tt) => {
    const j = admitted(tt), store = j.open(), unknown = path.join(j.root, 'requests', 'not-a-request');
    fs.mkdirSync(unknown);
    unchanged(j, () => j.prepare({}, store), { reason: 'owner-journal-corrupt' });
    fs.rmdirSync(unknown);
    unchanged(j, () => j.prepare({}, store), { reason: 'owner-journal-reopen-required' });
  });
  await t.test('an unknown request', (tt) => {
    const j = admitted(tt);
    assert.throws(() => j.open().recordPreparation('33333333-3333-4333-8333-333333333333', { preparation: j.preparation, trustVersion: 1 }),
      { reason: 'owner-journal-transition-refused' });
  });
  await t.test('flush before the first write', (tt) => {
    const j = admitted(tt), seen = [];
    j.prepare({}, j.open({ fault: (at) => seen.push(at) }));
    const flushed = seen.indexOf('recovery:directories-flushed');
    assert(flushed >= 0 && flushed < seen.indexOf('preparation:body-written'), seen.join(' '));
  });
  await t.test('busy', (tt) => {
    const j = admitted(tt), held = acquireDaemonJournalLock(j.root);
    try { unchanged(j, () => j.prepare(), { reason: 'owner-journal-busy' }); } finally { fs.closeSync(held); }
  });
  await t.test('a later phase', (tt) => {
    const j = admitted(tt);
    j.prepare();
    fs.writeFileSync(path.join(j.root, 'requests', requestDirectoryName({ namespaceDigest, requestId: j.requestId }), 'presence.record'),
      encodeDaemonJournalFrame(Buffer.from('p1.x.y'), { namespaceDigest, requestId: j.requestId, slot: 'presence' }));
    assert.equal(j.recover().state, 'authorizing');
    unchanged(j, () => j.prepare(), conflict);
  });
  await t.test('a refusal leaves the instance usable', (tt) => {
    const j = admitted(tt), store = j.open();
    assert.throws(() => j.prepare({ trustVersion: 2 }, store), badRequest);
    assert.equal(j.prepare({}, store).state, 'prepared');
    assert.throws(() => j.prepare({ trustVersion: 3 }, store), conflict);
  });
});
