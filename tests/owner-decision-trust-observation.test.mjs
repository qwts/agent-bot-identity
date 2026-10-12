// The daemon trust observation, v1 (agent-comms#77, owner decision Q1): the
// frozen schema's vectors, and the producer over real trust stores in
// scratch state. The vectors file is the frozen draft's
// daemon-trust-observation-v1.json, copied byte for byte.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync } from 'node:crypto';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { canonicalJson } from '../canonical-json.mjs';
import {
  TRUST_LIMITS, TRUST_OBSERVATION_MAX_BYTES, createOwnerDecisionTrustWriter, ed25519KeyPin, observationForGraph, observeOwnerDecisionTrust,
  ownerDecisionTrustRoot, readOwnerDecisionTrustObservation, validateOwnerDecisionTrustObservation,
} from '../identity/owner-decision-trust.mjs';
import { loadOrCreateVouchKey, vouchDaemonKey, vouchDaemonKeyPin, vouchKeyPath, vouchStateDir } from '../identity/vouch.mjs';
import * as host from '../identity-host.mjs';

const VECTORS_URL = new URL('./fixtures/owner-decisions/daemon-trust-observation-v1.json', import.meta.url);
const VECTORS_SHA256 = '08c78eca8779c0eda2ff5092093170f03fd641e6d4d82c6bb6b4fb27c4aad689';
const vectors = JSON.parse(fs.readFileSync(VECTORS_URL, 'utf8'));
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const darwin = { skip: process.platform !== 'darwin' && 'the trust lock is Darwin-only' };
const namespaceDigest = 'a'.repeat(64);
const brokerUid = process.getuid() + 1;
const rawKey = (pair = generateKeyPairSync('ed25519')) => pair.publicKey.export({ format: 'jwk' }).x;
const refused = (reason, code) => (error) => error.reason === reason && (code === undefined || error.code === code);

test('the vendored vectors are the frozen copy and the validator reproduces every expectation', () => {
  assert.equal(sha256(fs.readFileSync(VECTORS_URL)), VECTORS_SHA256);
  assert.equal(vectors.schema, 'owner-decision-daemon-trust-observation-v1');
  assert.equal(vectors.maxBytes, TRUST_OBSERVATION_MAX_BYTES);
  assert.equal(vectors.maximalValidBytes, 999);
  assert.equal(vectors.vectors.length, 16);
  for (const vector of vectors.vectors) {
    const bytes = Buffer.from(vector.canonicalJson);
    assert.equal(bytes.length, vector.utf8Bytes, vector.id); assert.equal(sha256(bytes), vector.sha256, vector.id);
    assert.equal(validateOwnerDecisionTrustObservation(bytes), vector.expected, vector.id);
  }
  // Outside the vectors: size, encoding and type.
  assert.equal(validateOwnerDecisionTrustObservation(Buffer.alloc(0)), 'oversize');
  assert.equal(validateOwnerDecisionTrustObservation(Buffer.alloc(1025, 0x20)), 'oversize');
  assert.equal(validateOwnerDecisionTrustObservation('{}'), 'oversize');
  assert.equal(validateOwnerDecisionTrustObservation(Buffer.from([0xff])), 'not-json');
  // Exact keys and kind, from the valid `none` vector.
  const none = JSON.parse(vectors.vectors.find(({ id }) => id === 'none').canonicalJson);
  const as = (value) => validateOwnerDecisionTrustObservation(Buffer.from(canonicalJson(value)));
  assert.equal(as(none), 'valid');
  assert.equal(as({ ...none, extra: 1 }), 'keys');
  const { daemonKey, ...missing } = none;
  assert.equal(as(missing), 'keys'); void daemonKey;
  assert.equal(as({ ...none, v: 2 }), 'kind');
  assert.equal(as({ ...none, kind: 'owner-decision-trust-observation' }), 'kind');
  // none must have no pair and the namespace record as its head; any other
  // state never has the namespace record as its head.
  assert.equal(as({ ...none, headRecordDigest: 'f'.repeat(64) }), 'none');
  const revoked = JSON.parse(vectors.vectors.find(({ id }) => id === 'revoked').canonicalJson);
  assert.equal(as({ ...revoked, headRecordDigest: revoked.namespaceRecordDigest }), 'head');
  for (const field of ['namespaceDigest', 'namespaceRecordDigest', 'headRecordDigest']) assert.equal(as({ ...none, [field]: 'A'.repeat(64) }), 'digest');
  for (const change of [{ chainVersion: -1 }, { chainVersion: 1025 }, { chainVersion: 1.5 }, { state: 'pending' }]) assert.equal(as({ ...none, ...change }), 'range');
  // The active pair: complete KeyPins with the right key IDs, and a Darwin service.
  const active = JSON.parse(vectors.vectors.find(({ id }) => id === 'active').canonicalJson);
  assert.equal(as(active), 'valid');
  const pair = (change) => as({ ...active, active: { ...active.active, ...change } });
  assert.equal(pair({ receiptKey: { ...active.active.receiptKey, keyId: 'f'.repeat(64) } }), 'active');
  assert.equal(pair({ presenceKey: { ...active.active.presenceKey, alg: 'ed448' } }), 'active');
  assert.equal(pair({ service: { platform: 'linux', brokerUid: 600 } }), 'active');
  assert.equal(pair({ service: { platform: 'darwin', brokerUid: 2 ** 32 } }), 'active');
  assert.equal(pair({ extra: 1 }), 'active');
});

// A scratch daemon: its own vouch key, home and trust root.
function daemon(t) {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(tmpdir(), 'owner-observation-')));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const env = { XDG_STATE_HOME: path.join(base, 'state') }, home = base;
  loadOrCreateVouchKey(vouchStateDir({ env }));
  const root = ownerDecisionTrustRoot({ env, home });
  const writer = (options = {}) => createOwnerDecisionTrustWriter({ root, env, home, legacyPresenceKey: null, ...options });
  const observe = (options = {}) => observeOwnerDecisionTrust({ root, env, home, ...options });
  const file = (...parts) => path.join(root, ...parts);
  return { base, env, home, root, writer, observe, file, daemonKey: vouchDaemonKeyPin({ env, home }) };
}
function snapshot(root) {
  const out = {};
  const walk = (dir) => { for (const name of fs.readdirSync(dir)) { const f = path.join(dir, name); if (fs.lstatSync(f).isDirectory()) walk(f); else out[path.relative(root, f)] = sha256(fs.readFileSync(f)); } };
  walk(root);
  return out;
}
const keyRecord = (d, version) => fs.readFileSync(d.file('keys', `${String(version).padStart(10, '0')}.json`));
const headOf = (d, version) => sha256(version === 0 ? fs.readFileSync(d.file('namespace.json')) : keyRecord(d, version));

// The observation the store must produce, built independently from its files.
function expected(d, version, active) {
  const state = version === 0 ? 'none' : version % 2 === 1 ? 'active' : 'revoked';
  return { v: 1, kind: 'owner-decision-daemon-trust-observation', namespaceDigest, namespaceRecordDigest: headOf(d, 0), chainVersion: version,
    headRecordDigest: headOf(d, version), state, daemonKey: d.daemonKey,
    active: active ? { enrollmentDigest: headOf(d, version), receiptKey: ed25519KeyPin(active.receiptKey), presenceKey: ed25519KeyPin(active.presenceKey),
      service: { platform: 'darwin', brokerUid } } : null };
}
function check(d, version, active) {
  const before = snapshot(d.root);
  const result = d.observe();
  assert(Object.isFrozen(result));
  assert.deepEqual(result.observation, expected(d, version, active));
  assert(Buffer.isBuffer(result.observationBytes));
  assert.equal(result.observationBytes.toString(), canonicalJson(result.observation));
  assert.equal(result.observationDigest, sha256(result.observationBytes));
  assert.equal(validateOwnerDecisionTrustObservation(result.observationBytes), 'valid');
  // Nothing but the exact schema: no paths, and the store is unchanged.
  assert(!result.observationBytes.toString().includes(d.base));
  assert.deepEqual(snapshot(d.root), before);
  return result;
}

test('the producer reports none, active and revoked exactly as the store proves them', darwin, (t) => {
  const d = daemon(t);
  d.writer().enrollNamespace({ namespaceDigest });
  const none = check(d, 0, null);
  const first = { receiptKey: rawKey(), presenceKey: rawKey() };
  d.writer().enrollKeys({ ...first, brokerUid });
  const active = check(d, 1, first);
  d.writer().revokeKeys({ revokes: headOf(d, 1), reason: 'rotated' });
  const revoked = check(d, 2, null);
  const second = { receiptKey: rawKey(), presenceKey: rawKey() };
  d.writer().enrollKeys({ ...second, brokerUid });
  const again = check(d, 3, second);
  // Every step is a distinct observation.
  assert.equal(new Set([none, active, revoked, again].map((r) => r.observationDigest)).size, 4);
});

test('the terminal state and every impossible graph come from the state machine, never a projection', () => {
  const pin = (byte) => ed25519KeyPin(Buffer.alloc(32, byte).toString('base64url'));
  const daemonKey = ed25519KeyPin(rawKey());
  const records = (n) => Array.from({ length: n + 1 }, (_, i) => ({ digest: sha256(`record ${i}`) }));
  const enrollment = (digest, receiptKey, presenceKey) => ({ digest, value: { receiptKey, presenceKey, service: { platform: 'darwin', brokerUid } } });
  const terminal = observationForGraph({ namespaceDigest, records: records(TRUST_LIMITS.versions), active: null }, daemonKey);
  assert.equal(terminal.state, 'revoked-terminal'); assert.equal(terminal.chainVersion, 1024); assert.equal(terminal.active, null);
  assert.equal(validateOwnerDecisionTrustObservation(Buffer.from(canonicalJson(terminal))), 'valid');
  const r = records(1023), receipt = ed25519KeyPin(rawKey()), presence = ed25519KeyPin(rawKey());
  const at1023 = observationForGraph({ namespaceDigest, records: r, active: enrollment(r.at(-1).digest, receipt, presence) }, daemonKey);
  assert.equal(at1023.state, 'active');
  assert.equal(validateOwnerDecisionTrustObservation(Buffer.from(canonicalJson(at1023))), 'valid');
  const corrupt = refused('owner-trust-corrupt', 'storage-failed');
  // Active at an even version, none active at an odd one, an active pair that is not the head.
  assert.throws(() => observationForGraph({ namespaceDigest, records: records(2), active: enrollment(sha256('record 2'), receipt, presence) }, daemonKey), corrupt);
  assert.throws(() => observationForGraph({ namespaceDigest, records: records(1), active: null }, daemonKey), corrupt);
  assert.throws(() => observationForGraph({ namespaceDigest, records: records(3), active: enrollment(sha256('record 1'), receipt, presence) }, daemonKey), corrupt);
  // A role alias among receipt, presence and daemon keys.
  const role = refused('owner-trust-role', 'owner-decision-unsupported');
  assert.throws(() => observationForGraph({ namespaceDigest, records: records(1), active: enrollment(sha256('record 1'), daemonKey, presence) }, daemonKey), role);
  assert.throws(() => observationForGraph({ namespaceDigest, records: records(1), active: enrollment(sha256('record 1'), receipt, daemonKey) }, daemonKey), role);
  assert.throws(() => observationForGraph({ namespaceDigest, records: records(1), active: enrollment(sha256('record 1'), pin(5), pin(5)) }, daemonKey), role);
});

test('the producer refuses rather than observe anything it cannot fully validate, and writes nothing', darwin, async (t) => {
  const enrolled = (tt) => {
    const d = daemon(tt);
    d.writer().enrollNamespace({ namespaceDigest });
    d.writer().enrollKeys({ receiptKey: rawKey(), presenceKey: rawKey(), brokerUid });
    return d;
  };
  const kept = (d, reason, code, change) => {
    change(d);
    const before = snapshot(d.root);
    assert.throws(() => d.observe(), refused(reason, code));
    assert.deepEqual(snapshot(d.root), before);
  };
  await t.test('no store', (tt) => { const d = daemon(tt); assert.throws(() => d.observe(), refused('owner-trust-missing', 'owner-decision-unsupported')); });
  await t.test('no vouch key', (tt) => {
    const d = enrolled(tt);
    kept(d, 'owner-trust-no-vouch-key', 'owner-decision-unsupported', () => fs.rmSync(vouchKeyPath(vouchStateDir({ env: d.env }))));
  });
  await t.test('a busy lock', (tt) => {
    const d = enrolled(tt);
    const held = fs.openSync(d.file('.trust-lock'), fs.constants.O_RDWR | 0x20);
    try { assert.throws(() => d.observe(), refused('owner-trust-busy', 'storage-failed')); } finally { fs.closeSync(held); }
    assert.equal(d.observe().observation.state, 'active');
  });
  await t.test('a namespace confirmation gap', (tt) => kept(enrolled(tt), 'owner-trust-audit-pending', 'storage-failed',
    (d) => fs.rmSync(d.file('namespace.confirm.json'))));
  await t.test('a key confirmation gap', (tt) => kept(enrolled(tt), 'owner-trust-audit-pending', 'storage-failed',
    (d) => fs.rmSync(d.file('keys', '0000000001.confirm.json'))));
  await t.test('a missing audit line', (tt) => kept(enrolled(tt), 'owner-trust-corrupt', 'storage-failed', (d) => {
    const lines = fs.readFileSync(d.file('audit.jsonl'), 'utf8').split('\n');
    fs.writeFileSync(d.file('audit.jsonl'), `${lines[0]}\n`);
  }));
  await t.test('a pending publication', (tt) => kept(enrolled(tt), 'owner-trust-pending', 'storage-failed',
    (d) => fs.writeFileSync(d.file('keys', '.pending.json'), '{}', { mode: 0o600 })));
  await t.test('a corrupt earlier record with an unchanged tail', (tt) => kept(enrolled(tt), 'owner-trust-corrupt', 'storage-failed', (d) => {
    d.writer().revokeKeys({ revokes: headOf(d, 1), reason: 'rotated' });
    const record = d.file('keys', '0000000001.json'), bytes = fs.readFileSync(record);
    fs.chmodSync(record, 0o600);
    fs.writeFileSync(record, bytes.toString().replace('"darwin"', '"Darwin"'));
  }));
  await t.test('the vouch key became an enrolled pin (role alias)', (tt) => {
    const d = daemon(tt), pair = generateKeyPairSync('ed25519');
    d.writer().enrollNamespace({ namespaceDigest });
    d.writer().enrollKeys({ receiptKey: rawKey(pair), presenceKey: rawKey(), brokerUid });
    kept(d, 'owner-trust-role', 'owner-decision-unsupported', () => {
      const file = vouchKeyPath(vouchStateDir({ env: d.env }));
      fs.rmSync(file);
      fs.writeFileSync(file, pair.privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
    });
  });
});

test('the published producer takes no root, env or home: only the daemon\'s own launch environment', darwin, (t) => {
  const d = daemon(t), other = daemon(t);
  d.writer().enrollNamespace({ namespaceDigest });
  other.writer().enrollNamespace({ namespaceDigest: 'b'.repeat(64) });
  // The daemon pin is this daemon's vouch key as a full KeyPin.
  assert.deepEqual(ed25519KeyPin(d.daemonKey.publicKey), d.daemonKey);
  assert.equal(d.daemonKey.keyId, vouchDaemonKey({ env: d.env, home: d.home }));
  assert.equal(readOwnerDecisionTrustObservation.length, 0);
  assert.equal(host.readOwnerDecisionTrustObservation, readOwnerDecisionTrustObservation);
  const saved = { XDG_STATE_HOME: process.env.XDG_STATE_HOME };
  process.env.XDG_STATE_HOME = d.env.XDG_STATE_HOME;
  try {
    // Arguments naming another store are ignored.
    const result = readOwnerDecisionTrustObservation({ root: other.root, env: other.env, home: other.home });
    assert.equal(result.observation.namespaceDigest, namespaceDigest);
    assert.deepEqual(result.observation.daemonKey, d.daemonKey);
  } finally {
    if (saved.XDG_STATE_HOME === undefined) delete process.env.XDG_STATE_HOME; else process.env.XDG_STATE_HOME = saved.XDG_STATE_HOME;
  }
});
