// The v2 owner-decision preparation (agent-comms#77, owner decision Q3): the
// v1 fields plus `trustVersion`, the active trust enrollment's chain version.
// The vectors are agent-comms tests/fixtures/owner-decisions/effect-evidence-v2.json
// at bf0b705 (merged #235), copied byte for byte. Downstream effect records
// stay v1, re-bound to the v2 preparation digests.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync } from 'node:crypto';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { canonicalJson } from '../canonical-json.mjs';
import { decodeDaemonJournalFrame, encodeDaemonJournalFrame, requestDirectoryName } from '../identity/owner-decision-journal-frame.mjs';
import { acquireDaemonJournalLock, createDaemonJournalStore, initializeDaemonJournal } from '../identity/owner-decision-journal-store.mjs';
import { bindEffect, bindPreparation, challengeFor, decodeEffect, decodePreparation } from '../identity/owner-decision-evidence.mjs';
import { createOwnerDecisionTrustWriter, ownerDecisionTrustRoot, readOwnerDecisionTrust } from '../identity/owner-decision-trust.mjs';
import { loadOrCreateVouchKey, vouchStateDir } from '../identity/vouch.mjs';
import { withCurrentObservation } from './helpers/owner-decision-trust-v1.mjs';
import { asDaemon } from './helpers/owner-decision-daemon-env.mjs';
import { rawEd25519 } from './helpers/ed25519-raw.mjs';

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
const brokerUid = process.getuid() + 1;
const rawKey = () => rawEd25519(generateKeyPairSync('ed25519').publicKey);

// An admitted request, and a scratch daemon trust store for its namespace
// (vouch key, namespace and, unless `enrolled` is false, one key pair).
function admitted(t, { enrolled = true, trustNamespace = namespaceDigest } = {}) {
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
  const env = { XDG_STATE_HOME: path.join(base, 'state') }, home = base;
  loadOrCreateVouchKey(vouchStateDir({ env }));
  // The daemon's own trust store, where its launch env and home resolve it.
  const trust = { root: ownerDecisionTrustRoot({ env, home }), env, home };
  const trustWriter = (now = 1_999_999_000) => withCurrentObservation(
    createOwnerDecisionTrustWriter({ root: trust.root, env, home, now: () => now, legacyPresenceKey: null }), trust);
  trustWriter().enrollNamespace({ namespaceDigest: trustNamespace });
  const pair = { receiptKey: rawKey(), presenceKey: rawKey(), brokerUid };
  if (enrolled) trustWriter().enrollKeys(pair);
  const liveVersion = () => readOwnerDecisionTrust({ ...trust, namespaceDigest: trustNamespace, legacyPresenceKey: null }).version;
  // Every preparation field except v, kind and trustVersion, which the store adds.
  const { v, kind, trustVersion, ...fields } = template; void v; void kind; void trustVersion;
  const preparation = { ...fields, requestId, payloadDigest: acceptance.payloadDigest };
  const dir = path.join(root, 'requests', requestDirectoryName({ namespaceDigest, requestId }));
  const read = (slot) => fs.readFileSync(path.join(dir, `${slot}.record`));
  const payload = (slot) => decodeDaemonJournalFrame(read(slot), { namespaceDigest, requestId, slot }).payload;
  const prepare = (input = {}, store = open()) => asDaemon(trust, () => store.recordPreparation(requestId, { preparation, ...input }));
  const recover = () => open().recover(requestId);
  return { root, requestId, action, preparation, trust, trustWriter, pair, liveVersion, open, read, payload, prepare, recover };
}
const snapshot = (j) => ['preparation', 'prepared-challenge'].map((slot) => sha256(j.read(slot)));
function unchanged(j, run, expected) {
  const before = snapshot(j);
  assert.throws(run, expected);
  assert.deepEqual(snapshot(j), before);
}
const badRequest = { reason: 'invalid-owner-journal-record', code: 'bad-request' };
const conflict = { reason: 'owner-journal-conflict', code: 'conflict' };
const untrusted = (refusal) => ({ reason: 'owner-journal-trust-unavailable', code: 'storage-failed', ...(refusal ? { refusal } : {}) });
const revokeAndEnroll = (j, { revokeAt, enrollAt, pair = j.pair }) => {
  const head = fs.readdirSync(path.join(j.trust.root, 'keys')).filter((n) => /^\d{10}\.json$/.test(n)).sort().at(-1);
  j.trustWriter(revokeAt).revokeKeys({ revokes: sha256(fs.readFileSync(path.join(j.trust.root, 'keys', head))), reason: 'compromised' });
  if (enrollAt !== undefined) j.trustWriter(enrollAt).enrollKeys(pair);
};

test('the writer records the live trust chain version, then the exact challenge', darwin, (t) => {
  const j = admitted(t);
  assert.equal(j.prepare().state, 'prepared');
  const record = JSON.parse(j.payload('preparation'));
  assert.equal(record.trustVersion, j.liveVersion()); assert.equal(record.trustVersion, 1);
  assert.deepEqual(record, { ...j.preparation, v: 2, kind: 'preparation', trustVersion: 1 });
  assert(j.payload('prepared-challenge').equals(challengeFor(record, j.action)));
  assert(!j.payload('prepared-challenge').toString().includes('trustVersion'));
  assert.equal(j.prepare().duplicate, true);
  unchanged(j, () => j.prepare({ preparation: { ...j.preparation, effectId: '33333333-3333-4333-8333-333333333333' } }), conflict);
});

test('after a re-enrollment the writer records the new live version', darwin, (t) => {
  const j = admitted(t);
  revokeAndEnroll(j, { revokeAt: 1_999_999_100, enrollAt: 1_999_999_200 });
  assert.equal(j.liveVersion(), 3);
  j.prepare();
  assert.equal(JSON.parse(j.payload('preparation')).trustVersion, 3);
});

test('the caller can never choose the version', darwin, async (t) => {
  for (const input of [{ trustVersion: 3 }, { trustVersion: 1 }, { preparation: { trustVersion: 3 } }]) {
    await t.test(JSON.stringify(input), (tt) => {
      const j = admitted(tt);
      const call = input.preparation ? { preparation: { ...j.preparation, ...input.preparation } } : input;
      unchanged(j, () => j.prepare(call), badRequest);
      assert.equal(j.recover().state, 'admitted');
    });
  }
});

test('no ready live trust refuses preparation and writes nothing', darwin, async (t) => {
  await t.test('no active pair', (tt) => {
    const j = admitted(tt, { enrolled: false });
    unchanged(j, () => j.prepare(), untrusted('owner-trust-no-active-key'));
  });
  await t.test('revoked', (tt) => {
    const j = admitted(tt);
    revokeAndEnroll(j, { revokeAt: 1_999_999_100 });
    unchanged(j, () => j.prepare(), untrusted('owner-trust-no-active-key'));
  });
  await t.test('no trust store', (tt) => {
    const j = admitted(tt);
    fs.rmSync(j.trust.root, { recursive: true });
    unchanged(j, () => j.prepare(), untrusted('owner-trust-missing'));
  });
  await t.test('trust enrolled for another namespace', (tt) => {
    const j = admitted(tt, { trustNamespace: 'b'.repeat(64) });
    unchanged(j, () => j.prepare(), untrusted('owner-trust-corrupt'));
  });
  await t.test('a busy trust lock refuses rather than waits', (tt) => {
    const j = admitted(tt);
    const held = fs.openSync(path.join(j.trust.root, '.trust-lock'), fs.constants.O_RDWR | 0x20);
    try { unchanged(j, () => j.prepare(), untrusted('owner-trust-busy')); } finally { fs.closeSync(held); }
    assert.equal(j.prepare().state, 'prepared');
  });
});

test('malformed input refuses before the lock; a refusal leaves the instance usable', darwin, async (t) => {
  await t.test('malformed', (tt) => {
    const j = admitted(tt), held = acquireDaemonJournalLock(j.root);
    try {
      assert.throws(() => j.prepare({ preparation: null }), badRequest);
      assert.throws(() => j.prepare({ trust: j.trust }), badRequest);
      assert.throws(() => j.open().recordPreparation('nope', { preparation: j.preparation }), badRequest);
    } finally { fs.closeSync(held); }
  });
  await t.test('bad bindings', (tt) => {
    const j = admitted(tt);
    unchanged(j, () => j.prepare({ preparation: { ...j.preparation, payloadDigest: 'e'.repeat(64) } }), badRequest);
    unchanged(j, () => j.prepare({ preparation: { ...j.preparation, extra: 1 } }), badRequest);
  });
  await t.test('usable after refusals', (tt) => {
    const j = admitted(tt), store = j.open();
    assert.throws(() => j.prepare({ trustVersion: 3 }, store), badRequest);
    const lock = fs.openSync(path.join(j.trust.root, '.trust-lock'), fs.constants.O_RDWR | 0x20);
    try { assert.throws(() => j.prepare({}, store), untrusted('owner-trust-busy')); } finally { fs.closeSync(lock); }
    assert.equal(j.prepare({}, store).state, 'prepared');
  });
});

test('a crash between the preparation and its challenge is finished by the same preparation, never another', darwin, (t) => {
  const j = admitted(t);
  assert.throws(() => j.prepare({}, j.open({ fault: (at) => { if (at === 'preparation:trailer-flushed') throw new Error('crash'); } })));
  assert.equal(j.recover().state, 'preparing');
  // Trust moved since: the same fields now carry another version, so it conflicts.
  const k = admitted(t);
  assert.throws(() => k.prepare({}, k.open({ fault: (at) => { if (at === 'preparation:trailer-flushed') throw new Error('crash'); } })));
  revokeAndEnroll(k, { revokeAt: 1_999_999_100, enrollAt: 1_999_999_200 });
  unchanged(k, () => k.prepare(), conflict);
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
    assert.throws(() => j.open().recordPreparation('33333333-3333-4333-8333-333333333333', { preparation: j.preparation }),
      { reason: 'owner-journal-transition-refused' });
  });
  await t.test('flush before the first write', (tt) => {
    const j = admitted(tt), seen = [];
    j.prepare({}, j.open({ fault: (at) => seen.push(at) }));
    const flushed = seen.indexOf('recovery:directories-flushed');
    assert(flushed >= 0 && flushed < seen.indexOf('preparation:body-written'), seen.join(' '));
  });
  await t.test('busy journal', (tt) => {
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
});
