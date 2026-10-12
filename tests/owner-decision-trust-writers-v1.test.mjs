// The versioned owner-decision trust writers (agent-comms#77, owner decision
// Q2): enrollKeysV1/revokeKeysV1 write only against the exact current
// observation, inside one hold of the trust lock, with the vouch key checked
// before the record and before its confirmation. Every refusal class from the
// frozen spec, in scratch state.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync } from 'node:crypto';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import {
  createOwnerDecisionTrustWriter, ed25519KeyPin, observeOwnerDecisionTrust, ownerDecisionTrustRoot, readOwnerDecisionTrust,
} from '../identity/owner-decision-trust.mjs';
import { loadOrCreateVouchKey, vouchDaemonKeyPin, vouchKeyPath, vouchStateDir } from '../identity/vouch.mjs';

const darwin = { skip: process.platform !== 'darwin' && 'the trust lock is Darwin-only' };
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const namespaceDigest = 'a'.repeat(64);
const brokerUid = process.getuid() + 1;
const rawKey = (pair = generateKeyPairSync('ed25519')) => pair.publicKey.export({ format: 'jwk' }).x;
const refused = (reason, code) => (error) => error.reason === reason && (code === undefined || error.code === code);

function daemon(t) {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(tmpdir(), 'owner-writers-v1-')));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const env = { XDG_STATE_HOME: path.join(base, 'state') }, home = base;
  loadOrCreateVouchKey(vouchStateDir({ env }));
  const root = ownerDecisionTrustRoot({ env, home });
  const writer = (options = {}) => createOwnerDecisionTrustWriter({ root, env, home, legacyPresenceKey: null, ...options });
  const observe = () => observeOwnerDecisionTrust({ root, env, home });
  const digest = () => observe().observationDigest;
  const vouchFile = vouchKeyPath(vouchStateDir({ env }));
  // Replaces the vouch key file with another key (new inode, bytes and size).
  const swapVouch = () => {
    fs.rmSync(vouchFile);
    fs.writeFileSync(vouchFile, generateKeyPairSync('ed25519').privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
  };
  writer().enrollNamespace({ namespaceDigest });
  return { base, env, home, root, writer, observe, digest, swapVouch, vouchFile };
}
function snapshot(root) {
  const out = {};
  const walk = (dir) => { for (const name of fs.readdirSync(dir)) { const f = path.join(dir, name); if (fs.lstatSync(f).isDirectory()) walk(f); else out[path.relative(root, f)] = sha256(fs.readFileSync(f)); } };
  walk(root);
  return out;
}
const pair = () => ({ receiptKey: rawKey(), presenceKey: rawKey(), brokerUid });
const enroll = (d, keys = pair(), options) => d.writer(options).enrollKeysV1({ ...keys, expectedObservationDigest: d.digest() });
const enrollmentDigest = (d) => d.observe().observation.active.enrollmentDigest;
function zeroWrites(d, run, expected) {
  const before = snapshot(d.root);
  assert.throws(run, expected);
  assert.deepEqual(snapshot(d.root), before);
}

test('enroll and revoke against the exact current observation, returning the new one', darwin, (t) => {
  const d = daemon(t), keys = pair();
  const enrolled = enroll(d, keys);
  assert(Object.isFrozen(enrolled));
  assert.deepEqual(enrolled, d.observe());
  assert.equal(enrolled.observation.state, 'active'); assert.equal(enrolled.observation.chainVersion, 1);
  assert.deepEqual(enrolled.observation.active.receiptKey, ed25519KeyPin(keys.receiptKey));
  assert.equal(readOwnerDecisionTrust({ root: d.root, env: d.env, home: d.home, legacyPresenceKey: null }).version, 1);
  const revoked = d.writer().revokeKeysV1({ revokes: enrolled.observation.active.enrollmentDigest, reason: 'rotated',
    expectedObservationDigest: enrolled.observationDigest });
  assert.deepEqual(revoked, d.observe());
  assert.equal(revoked.observation.state, 'revoked');
  assert.equal(enroll(d).observation.chainVersion, 3);
});

test('the unversioned writers are retired and write nothing', darwin, (t) => {
  const d = daemon(t);
  zeroWrites(d, () => d.writer().enrollKeys(pair()), refused('owner-trust-api-version', 'bad-request'));
  enroll(d);
  zeroWrites(d, () => d.writer().revokeKeys({ revokes: enrollmentDigest(d), reason: 'rotated' }), refused('owner-trust-api-version', 'bad-request'));
});

test('a missing, malformed or stale expectation refuses with zero writes', darwin, (t) => {
  const d = daemon(t);
  const invalid = refused('owner-trust-invalid-input', 'bad-request'), stale = refused('owner-trust-stale-observation', 'conflict');
  for (const expectedObservationDigest of [undefined, null, '', 'A'.repeat(64), 'a'.repeat(63), 7]) {
    zeroWrites(d, () => d.writer().enrollKeysV1({ ...pair(), expectedObservationDigest }), invalid);
  }
  const before = d.digest();
  zeroWrites(d, () => d.writer().enrollKeysV1({ ...pair(), expectedObservationDigest: 'b'.repeat(64) }), stale);
  enroll(d);
  // The earlier observation is stale now, for either writer.
  zeroWrites(d, () => d.writer().enrollKeysV1({ ...pair(), expectedObservationDigest: before }), stale);
  zeroWrites(d, () => d.writer().revokeKeysV1({ revokes: enrollmentDigest(d), reason: 'rotated', expectedObservationDigest: before }), stale);
  for (const expectedObservationDigest of [undefined, 'x']) {
    zeroWrites(d, () => d.writer().revokeKeysV1({ revokes: enrollmentDigest(d), reason: 'rotated', expectedObservationDigest }), invalid);
  }
});

test('two writers holding the same expectation: the first writes, the second conflicts and writes nothing', darwin, (t) => {
  const d = daemon(t), expected = d.digest();
  d.writer().enrollKeysV1({ ...pair(), expectedObservationDigest: expected });
  zeroWrites(d, () => d.writer().enrollKeysV1({ ...pair(), expectedObservationDigest: expected }), refused('owner-trust-stale-observation', 'conflict'));
  const active = d.digest(), revokes = enrollmentDigest(d);
  d.writer().revokeKeysV1({ revokes, reason: 'rotated', expectedObservationDigest: active });
  zeroWrites(d, () => d.writer().revokeKeysV1({ revokes, reason: 'rotated', expectedObservationDigest: active }), refused('owner-trust-stale-observation'));
});

test('only legal transitions, pins and capacity, all before any write', darwin, (t) => {
  const d = daemon(t), conflict = refused('owner-trust-conflict', 'conflict'), invalid = refused('owner-trust-invalid-input', 'bad-request');
  // Revoke needs an active pair, and exactly the active one.
  zeroWrites(d, () => d.writer().revokeKeysV1({ revokes: 'f'.repeat(64), reason: 'rotated', expectedObservationDigest: d.digest() }), conflict);
  enroll(d);
  zeroWrites(d, () => d.writer().enrollKeysV1({ ...pair(), expectedObservationDigest: d.digest() }), conflict);
  zeroWrites(d, () => d.writer().revokeKeysV1({ revokes: 'f'.repeat(64), reason: 'rotated', expectedObservationDigest: d.digest() }), conflict);
  d.writer().revokeKeysV1({ revokes: enrollmentDigest(d), reason: 'rotated', expectedObservationDigest: d.digest() });
  // Pins: distinct, never the vouch key, never keyd's legacy presence key.
  const same = rawKey(), own = vouchDaemonKeyPin({ env: d.env, home: d.home }).publicKey, legacy = rawKey();
  zeroWrites(d, () => d.writer().enrollKeysV1({ receiptKey: same, presenceKey: same, brokerUid, expectedObservationDigest: d.digest() }), invalid);
  zeroWrites(d, () => d.writer().enrollKeysV1({ ...pair(), receiptKey: own, expectedObservationDigest: d.digest() }), invalid);
  zeroWrites(d, () => d.writer().enrollKeysV1({ ...pair(), presenceKey: own, expectedObservationDigest: d.digest() }), invalid);
  zeroWrites(d, () => d.writer({ legacyPresenceKey: legacy }).enrollKeysV1({ ...pair(), presenceKey: legacy, expectedObservationDigest: d.digest() }), invalid);
  for (const input of [{ brokerUid: 0 }, { brokerUid: process.getuid() }, { at: -1 }, { auditId: 'x' }, { receiptKey: 'x' }]) {
    zeroWrites(d, () => d.writer().enrollKeysV1({ ...pair(), ...input, expectedObservationDigest: d.digest() }), invalid);
  }
  for (const input of [{ reason: 'because' }, { revokes: 'x' }, { at: 1.5 }]) {
    zeroWrites(d, () => d.writer().revokeKeysV1({ revokes: 'f'.repeat(64), reason: 'rotated', ...input, expectedObservationDigest: d.digest() }), invalid);
  }
  // Capacity: the last version is reserved for a revocation.
  const capped = (options) => d.writer({ maxVersions: 3, ...options });
  zeroWrites(d, () => capped().enrollKeysV1({ ...pair(), expectedObservationDigest: d.digest() }), refused('owner-trust-bounds'));
  const e = daemon(t);
  e.writer({ maxVersions: 2 }).enrollKeysV1({ ...pair(), expectedObservationDigest: e.digest() });
  zeroWrites(e, () => e.writer({ maxVersions: 1 }).revokeKeysV1({ revokes: enrollmentDigest(e), reason: 'rotated', expectedObservationDigest: e.digest() }),
    refused('owner-trust-bounds'));
});

const crashAt = (point) => (at) => { if (at === point) throw new Error('crash'); };

test('class 1: a vouch key swapped at the pre-creation check writes nothing', darwin, async (t) => {
  for (const [name, run] of [
    ['enroll', (d, fault) => d.writer({ fault }).enrollKeysV1({ ...pair(), expectedObservationDigest: d.digest() })],
    ['revoke', (d, fault) => d.writer({ fault }).revokeKeysV1({ revokes: enrollmentDigest(d), reason: 'rotated', expectedObservationDigest: d.digest() })],
  ]) {
    await t.test(name, (tt) => {
      const d = daemon(tt);
      if (name === 'revoke') enroll(d);
      const step = name === 'enroll' ? 'key-1' : 'key-2';
      zeroWrites(d, () => run(d, (at) => { if (at === `${step}:pre-creation-check`) d.swapVouch(); }), refused('owner-trust-vouch-changed', 'storage-failed'));
    });
  }
  await t.test('the same bytes under a new inode', (tt) => {
    const d = daemon(tt);
    const copy = () => { const bytes = fs.readFileSync(d.vouchFile); fs.rmSync(d.vouchFile); fs.writeFileSync(d.vouchFile, bytes, { mode: 0o600 }); };
    zeroWrites(d, () => d.writer({ fault: (at) => { if (at === 'key-1:pre-creation-check') copy(); } })
      .enrollKeysV1({ ...pair(), expectedObservationDigest: d.digest() }), refused('owner-trust-vouch-changed'));
  });
  await t.test('a vouch key already gone', (tt) => {
    const d = daemon(tt), expected = d.digest();
    fs.rmSync(d.vouchFile);
    zeroWrites(d, () => d.writer().enrollKeysV1({ ...pair(), expectedObservationDigest: expected }), refused('owner-trust-no-vouch-key'));
  });
});

test('class 2: a failure after the record\'s pending file keeps it exactly, and nothing reads past it', darwin, async (t) => {
  for (const point of ['key-1:pending-written', 'key-1:pending-flushed']) {
    await t.test(point, (tt) => {
      const d = daemon(tt);
      assert.throws(() => enroll(d, pair(), { fault: crashAt(point) }));
      const pending = fs.readFileSync(path.join(d.root, 'keys', '.pending.json')), before = snapshot(d.root);
      assert.throws(() => d.observe(), refused('owner-trust-pending', 'storage-failed'));
      assert.throws(() => readOwnerDecisionTrust({ root: d.root, env: d.env, home: d.home, legacyPresenceKey: null }), refused('owner-trust-pending'));
      assert.deepEqual(snapshot(d.root), before);
      assert(fs.readFileSync(path.join(d.root, 'keys', '.pending.json')).equals(pending));
      // Reconcile keeps a lone pending record as evidence.
      assert.throws(() => d.writer().reconcile(), refused('owner-trust-pending'));
    });
  }
});

test('class 3: a record published without its confirmation grants nothing until reconcile', darwin, async (t) => {
  const cases = [
    ['vouch swapped at the pre-confirmation check', (d) => (at) => { if (at === 'key-1:pre-confirmation-check') d.swapVouch(); }, 'owner-trust-vouch-changed'],
    ['the record directory flush', () => crashAt('key-1:linked'), 'owner-trust-io'],
    ['the pending unlink', () => crashAt('key-1:directory-flushed'), 'owner-trust-io'],
    ['the audit append', () => crashAt('key-1:audit-written'), 'owner-trust-io'],
    ['the audit flush', () => crashAt('key-1:audit-flushed'), 'owner-trust-io'],
  ];
  for (const [name, fault, reason] of cases) {
    await t.test(name, (tt) => {
      const d = daemon(tt);
      assert.throws(() => enroll(d, pair(), { fault: fault(d) }), refused(reason, 'storage-failed'));
      assert(fs.existsSync(path.join(d.root, 'keys', '0000000001.json')));
      assert(!fs.existsSync(path.join(d.root, 'keys', '0000000001.confirm.json')));
      const before = snapshot(d.root);
      assert.throws(() => d.observe(), (error) => ['owner-trust-pending', 'owner-trust-audit-pending'].includes(error.reason));
      assert.throws(() => readOwnerDecisionTrust({ root: d.root, env: d.env, home: d.home, legacyPresenceKey: null }));
      assert.deepEqual(snapshot(d.root), before);
      if (reason === 'owner-trust-vouch-changed') return;
      d.writer().reconcile();
      assert.equal(d.observe().observation.state, 'active');
    });
  }
  await t.test('no write over an unconfirmed record, even with the digest it would have once reconciled', (tt) => {
    const d = daemon(tt);
    assert.throws(() => enroll(d, pair(), { fault: crashAt('key-1:audit-flushed') }));
    const twin = path.join(d.base, 'twin');
    fs.cpSync(d.root, twin, { recursive: true });
    const own = (dir) => { fs.chmodSync(dir, 0o700); for (const name of fs.readdirSync(dir)) { const f = path.join(dir, name); if (fs.lstatSync(f).isDirectory()) own(f); else fs.chmodSync(f, 0o600); } };
    own(twin);
    createOwnerDecisionTrustWriter({ root: twin, env: d.env, home: d.home, legacyPresenceKey: null }).reconcile();
    const settled = observeOwnerDecisionTrust({ root: twin, env: d.env, home: d.home });
    zeroWrites(d, () => d.writer().revokeKeysV1({ revokes: settled.observation.active.enrollmentDigest, reason: 'rotated',
      expectedObservationDigest: settled.observationDigest }), refused('owner-trust-audit-pending', 'storage-failed'));
  });
  // Reconcile re-derives the vouch identity before confirming anything,
  // whether it appends the confirmation or links a staged one.
  for (const point of ['key-1:audit-flushed', 'key-1:confirmation:pending-flushed']) {
    await t.test(`reconcile refuses a record whose pins alias the current vouch key (${point})`, (tt) => {
      const d = daemon(tt), pairKey = generateKeyPairSync('ed25519');
      assert.throws(() => enroll(d, { ...pair(), receiptKey: rawKey(pairKey) }, { fault: crashAt(point) }));
      fs.rmSync(d.vouchFile);
      fs.writeFileSync(d.vouchFile, pairKey.privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
      const before = snapshot(d.root);
      assert.throws(() => d.writer().reconcile(), refused('owner-trust-role', 'owner-decision-unsupported'));
      assert.deepEqual(snapshot(d.root), before);
    });
  }
});

test('class 4: a visible confirmation is never assumed durable; a locked read and reconcile settle it', darwin, async (t) => {
  for (const point of ['key-1:confirmation:pending-written', 'key-1:confirmation:linked', 'key-1:confirmation:directory-flushed',
    'key-1:confirmation:pending-removed', 'key-1:confirmation:published']) {
    await t.test(point, (tt) => {
      const d = daemon(tt);
      assert.throws(() => enroll(d, pair(), { fault: crashAt(point) }), refused('owner-trust-io', 'storage-failed'));
      const before = snapshot(d.root);
      // Nothing rolled back or retried: the bytes stay exactly as left.
      try { d.observe(); } catch (error) { assert.equal(error.reason, 'owner-trust-pending'); }
      assert.deepEqual(snapshot(d.root), before);
      d.writer().reconcile();
      assert.equal(d.observe().observation.state, 'active');
    });
  }
});
