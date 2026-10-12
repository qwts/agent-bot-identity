// Disabled owner-decision trust records (#1007): the pinned broker namespace
// and the versioned key pins. Storage cases run only on Darwin, where the
// journal-style O_EXLOCK lock exists; key and schema cases run everywhere.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, createPublicKey, generateKeyPairSync } from 'node:crypto';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { canonicalJson } from '../canonical-json.mjs';
import {
  TRUST_LIMITS, createOwnerDecisionTrustWriter, ed25519KeyPin, ownerDecisionTrustRoot, readOwnerDecisionTrust, trustError,
} from '../identity/owner-decision-trust.mjs';

const darwin = { skip: process.platform !== 'darwin' && 'the trust lock is Darwin-only' };
const namespaceDigest = 'a'.repeat(64);
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const refused = (reason, code) => (error) => error.reason === reason && (code === undefined || error.code === code);
const rawKey = () => generateKeyPairSync('ed25519').publicKey.export({ format: 'jwk' }).x;
// This daemon's own vouch key ID, and a broker service uid that is neither
// root nor the owner running the tests.
const daemonKey = sha256(generateKeyPairSync('ed25519').publicKey.export({ type: 'spki', format: 'der' }));
const brokerUid = process.getuid() + 1;
const keys = () => ({ receiptKey: rawKey(), presenceKey: rawKey(), brokerUid, daemonKey });

function freshRoot(t) {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(tmpdir(), 'owner-trust-')));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  return path.join(base, 'trust');
}
const read = (root, options = {}) => readOwnerDecisionTrust({ root, daemonKey, ...options });
const writer = (root, options = {}) => createOwnerDecisionTrustWriter({ root, ...options });
// Every file under the root, for "kept as found" checks.
function snapshot(root) {
  const out = {};
  const walk = (dir) => { for (const name of fs.readdirSync(dir)) { const file = path.join(dir, name); if (fs.lstatSync(file).isDirectory()) walk(file); else out[path.relative(root, file)] = fs.readFileSync(file); } };
  walk(root);
  return out;
}

test('key pins are canonical 32-byte Ed25519 base64url with the agent-comms SPKI key ID', () => {
  const { publicKey } = generateKeyPairSync('ed25519');
  const x = publicKey.export({ format: 'jwk' }).x;
  const pin = ed25519KeyPin(x);
  assert.deepEqual(pin, { alg: 'ed25519', publicKey: x, keyId: sha256(publicKey.export({ type: 'spki', format: 'der' })) });
  assert.equal(pin.keyId, sha256(createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x }, format: 'jwk' }).export({ type: 'spki', format: 'der' })));
  const raw = Buffer.from(x, 'base64url');
  // A 43-character string whose last character carries nonzero padding bits
  // decodes to the same 32 bytes but is not the canonical spelling.
  const last = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'.split('')
    .map((c) => `${x.slice(0, 42)}${c}`).find((v) => v !== x && Buffer.from(v, 'base64url').equals(raw));
  assert(last, 'a non-canonical twin exists');
  for (const bad of [`${x}=`, raw.toString('base64'), raw.subarray(0, 31).toString('base64url'),
    Buffer.concat([raw, Buffer.from([0])]).toString('base64url'), last, '', null, 42]) {
    if (bad === raw.toString('base64') && bad.replace(/=+$/, '') === x) continue;
    assert.throws(() => ed25519KeyPin(bad), refused('owner-trust-invalid-input', 'bad-request'), String(bad));
  }
});

test('trust reasons map only to public codes, and the default root is our state directory', () => {
  assert.equal(trustError('owner-trust-missing').code, 'owner-decision-unsupported');
  assert.equal(trustError('owner-trust-no-active-key').code, 'owner-decision-unsupported');
  assert.equal(trustError('owner-trust-conflict').code, 'conflict');
  for (const reason of ['owner-trust-audit-pending', 'owner-trust-pending', 'owner-trust-corrupt', 'owner-trust-busy',
    'owner-trust-custody', 'owner-trust-bounds', 'owner-trust-flush', 'owner-trust-io']) assert.equal(trustError(reason).code, 'storage-failed');
  assert.equal(ownerDecisionTrustRoot({ env: { XDG_STATE_HOME: '/state' } }), '/state/agent-bot/owner-decision-trust');
  assert.deepEqual(TRUST_LIMITS, { versions: 1024, record: 1024, confirmation: 512, auditLine: 512 });
});

test('one active enrollment: enroll, revoke exactly it, enroll again; never two, never a stale revocation', darwin, (t) => {
  const root = freshRoot(t);
  assert.throws(() => read(root), refused('owner-trust-missing', 'owner-decision-unsupported'));
  const w = writer(root);
  assert.equal(w.enrollNamespace({ namespaceDigest }).state, 'enrolled');
  assert.throws(() => read(root), refused('owner-trust-no-active-key', 'owner-decision-unsupported'));
  // Re-enrolling the same namespace changes nothing; another namespace conflicts.
  const before = snapshot(root);
  assert.equal(writer(root).enrollNamespace({ namespaceDigest }).state, 'enrolled');
  assert.deepEqual(snapshot(root), before);
  assert.throws(() => writer(root).enrollNamespace({ namespaceDigest: 'b'.repeat(64) }), refused('owner-trust-conflict', 'conflict'));

  const first = keys(), active = w.enrollKeys(first);
  assert.equal(active.state, 'ready'); assert.equal(active.version, 1);
  assert.deepEqual(active.receiptKey, ed25519KeyPin(first.receiptKey));
  assert.deepEqual(read(root, { namespaceDigest }), active);
  assert.throws(() => read(root, { namespaceDigest: 'b'.repeat(64) }), refused('owner-trust-corrupt', 'storage-failed'));
  assert.throws(() => w.enrollKeys(keys()), refused('owner-trust-conflict'));
  const same = rawKey();
  assert.throws(() => w.enrollKeys({ receiptKey: same, presenceKey: same, brokerUid, daemonKey }), refused('owner-trust-invalid-input'));

  const v1 = sha256(fs.readFileSync(path.join(root, 'keys', '0000000001.json')));
  assert.throws(() => w.revokeKeys({ revokes: 'f'.repeat(64), reason: 'rotated' }), refused('owner-trust-conflict'));
  assert.equal(w.revokeKeys({ revokes: v1, reason: 'rotated' }).state, 'revoked');
  assert.throws(() => read(root), refused('owner-trust-no-active-key'));
  assert.throws(() => w.revokeKeys({ revokes: v1, reason: 'rotated' }), refused('owner-trust-conflict'));
  const second = keys(), rotated = w.enrollKeys({ ...second, brokerUid: brokerUid + 1 });
  assert.equal(rotated.version, 3); assert.deepEqual(rotated.presenceKey, ed25519KeyPin(second.presenceKey));
  assert.equal(rotated.service.brokerUid, brokerUid + 1); assert.equal(rotated.namespaceDigest, namespaceDigest);
  assert.equal(fs.statSync(path.join(root, 'namespace.json')).mode & 0o7777, 0o600);
});

test('capacity refuses growth and keeps every record', darwin, (t) => {
  const root = freshRoot(t), w = writer(root, { maxVersions: 2 });
  w.enrollNamespace({ namespaceDigest });
  w.enrollKeys(keys());
  w.revokeKeys({ revokes: sha256(fs.readFileSync(path.join(root, 'keys', '0000000001.json'))), reason: 'decommissioned' });
  const before = snapshot(root);
  assert.throws(() => w.enrollKeys(keys()), refused('owner-trust-bounds'));
  assert.deepEqual(snapshot(root), before);
});

// The writer's steps for one record, in order.
const RECORD_STEPS = ['pending-written', 'pending-flushed', 'linked', 'directory-flushed', 'pending-removed', 'published',
  'audit-written', 'audit-flushed', 'confirmation:pending-written', 'confirmation:pending-flushed', 'confirmation:linked',
  'confirmation:directory-flushed', 'confirmation:pending-removed', 'confirmation:published'];

test('a crash at every step of an enrollment and a revocation never yields unaudited or earlier pins', darwin, async (t) => {
  for (const [operation, step] of [['key-1', 'enroll'], ['key-2', 'revoke']]) for (const point of RECORD_STEPS) {
    await t.test(`${step} crash at ${point}`, (tt) => {
      const root = freshRoot(tt), first = keys();
      writer(root).enrollNamespace({ namespaceDigest });
      if (step === 'revoke') writer(root).enrollKeys(first);
      const crash = writer(root, { fault: (at) => { if (at === `${operation}:${point}`) throw new Error('crash'); } });
      const run = () => (step === 'enroll' ? crash.enrollKeys(first)
        : crash.revokeKeys({ revokes: sha256(fs.readFileSync(path.join(root, 'keys', '0000000001.json'))), reason: 'compromised' }));
      assert.throws(run, refused('owner-trust-io'));
      const unsettled = ['pending-written', 'pending-flushed', 'linked', 'directory-flushed', 'confirmation:pending-written',
        'confirmation:pending-flushed', 'confirmation:linked', 'confirmation:directory-flushed'].includes(point);
      if (['confirmation:pending-removed', 'confirmation:published'].includes(point)) {
        // The confirmation is linked: settled, after readiness's own flush.
        if (step === 'enroll') assert.equal(read(root).version, 1); else assert.throws(() => read(root), refused('owner-trust-no-active-key'));
        return;
      }
      // Never ready from a record without its confirmation, and a revocation
      // in flight never falls back to the key it revokes.
      assert.throws(() => read(root), (error) => error.code === 'storage-failed'
        && (unsettled ? ['owner-trust-pending', 'owner-trust-custody'] : ['owner-trust-audit-pending']).includes(error.reason));
      const before = snapshot(root);
      if (['pending-written', 'pending-flushed'].includes(point)) {
        // A lone unpublished record is the owner's evidence: kept, and refused.
        assert.throws(() => writer(root).reconcile(), refused('owner-trust-pending'));
        assert.deepEqual(snapshot(root), before);
        return;
      }
      const result = writer(root).reconcile();
      assert.equal(result.state, 'reconciled');
      if (step === 'enroll') assert.equal(read(root).version, 1); else assert.throws(() => read(root), refused('owner-trust-no-active-key'));
      // The audit line is the writer's own when it was written, else marked reconciled.
      const lines = fs.readFileSync(path.join(root, 'audit.jsonl'), 'utf8').trim().split('\n').map((line) => JSON.parse(line));
      const last = lines.at(-1);
      assert.equal(last.reconciled, !['audit-written', 'audit-flushed'].includes(point) && !point.startsWith('confirmation:'));
    });
  }
});

test('a crash while creating the store or the namespace record is unsupported or kept, never regenerated', darwin, async (t) => {
  for (const point of ['root:created', 'lock:created', ...RECORD_STEPS.map((step) => `namespace:${step}`)]) {
    await t.test(point, (tt) => {
      const root = freshRoot(tt);
      assert.throws(() => writer(root, { fault: (at) => { if (at === point) throw new Error('crash'); } }).enrollNamespace({ namespaceDigest }));
      if (['namespace:confirmation:pending-removed', 'namespace:confirmation:published'].includes(point)) {
        assert.throws(() => read(root), refused('owner-trust-no-active-key'));
        return;
      }
      assert.throws(() => read(root), (error) => ['owner-trust-missing', 'owner-trust-pending', 'owner-trust-custody', 'owner-trust-audit-pending'].includes(error.reason));
      if (['namespace:pending-written', 'namespace:pending-flushed'].includes(point)) {
        assert.throws(() => writer(root).reconcile(), refused('owner-trust-pending'));
        return;
      }
      if (['root:created', 'lock:created'].includes(point)) {
        // The interrupted creation completes on the next explicit enrollment.
        assert.equal(writer(root).enrollNamespace({ namespaceDigest }).state, 'enrolled');
      } else writer(root).reconcile();
      assert.throws(() => read(root), refused('owner-trust-no-active-key'));
    });
  }
});

// Appends a key record exactly as the writer would: record, audit line and
// confirmation, all well formed and bound to each other.
function forgeConfirmed(root, value) {
  const bytes = Buffer.from(canonicalJson(value)), name = String(value.version).padStart(10, '0');
  fs.writeFileSync(path.join(root, 'keys', `${name}.json`), bytes, { mode: 0o600 });
  const audit = path.join(root, 'audit.jsonl'), seq = fs.readFileSync(audit, 'utf8').trim().split('\n').length + 1;
  const line = `${canonicalJson({ v: 1, kind: 'owner-decision-trust-audit', seq, subject: 'key', version: value.version,
    recordDigest: sha256(bytes), namespaceDigest, auditId: value.auditId, at: 1, reconciled: false })}\n`;
  fs.appendFileSync(audit, line);
  fs.writeFileSync(path.join(root, 'keys', `${name}.confirm.json`), canonicalJson({ v: 1, kind: 'owner-decision-trust-confirmation',
    subject: 'key', version: value.version, recordDigest: sha256(bytes), namespaceDigest, auditId: value.auditId, auditLineDigest: sha256(line) }), { mode: 0o600 });
}

function enrolled(t) {
  const root = freshRoot(t), w = writer(root);
  w.enrollNamespace({ namespaceDigest });
  w.enrollKeys(keys());
  w.revokeKeys({ revokes: sha256(fs.readFileSync(path.join(root, 'keys', '0000000001.json'))), reason: 'rotated' });
  w.enrollKeys(keys());
  assert.equal(read(root).version, 3);
  return root;
}

test('damaged, foreign or inconsistent trust state refuses and is kept as found', darwin, async (t) => {
  // A forgery helper that really is accepted when the transition is legal.
  {
    const root = enrolled(t);
    const v3 = fs.readFileSync(path.join(root, 'keys', '0000000003.json'));
    forgeConfirmed(root, { v: 1, kind: 'owner-decision-key-revocation', namespaceDigest, version: 4, previousDigest: sha256(v3),
      revokes: sha256(v3), reason: 'rotated', at: 1, auditId: '77777777-7777-4777-8777-777777777777' });
    assert.throws(() => read(root), refused('owner-trust-no-active-key'));
  }
  const edit = (file, change) => fs.writeFileSync(file, change(fs.readFileSync(file)));
  const cases = [
    ['an edited record', (root) => edit(path.join(root, 'keys', '0000000002.json'), (b) => Buffer.from(b.toString().replace('rotated', 'compromised')))],
    ['a missing middle version', (root) => fs.rmSync(path.join(root, 'keys', '0000000002.json'))],
    ['a missing confirmation on a revocation', (root) => fs.rmSync(path.join(root, 'keys', '0000000002.confirm.json'))],
    ['a deleted audit line', (root) => edit(path.join(root, 'audit.jsonl'), (b) => Buffer.from(b.toString().split('\n').filter((_, i) => i !== 1).join('\n')))],
    ['a torn audit tail', (root) => fs.appendFileSync(path.join(root, 'audit.jsonl'), '{"v":1')],
    ['an audit line for a record that does not exist', (root) => {
      const lines = fs.readFileSync(path.join(root, 'audit.jsonl'), 'utf8').trim().split('\n');
      const extra = { ...JSON.parse(lines.at(-1)), seq: lines.length + 1, version: 9 };
      fs.appendFileSync(path.join(root, 'audit.jsonl'), `${canonicalJson(extra)}\n`);
    }],
    ['non-canonical bytes', (root) => edit(path.join(root, 'namespace.json'), (b) => Buffer.from(` ${b}`))],
    ['a stray file', (root) => fs.writeFileSync(path.join(root, 'keys', 'notes.txt'), 'x')],
    ['a pending file', (root) => fs.writeFileSync(path.join(root, 'keys', '.pending.json'), 'x', { mode: 0o600 })],
    ['a symlinked record', (root) => { const file = path.join(root, 'keys', '0000000003.json'); fs.renameSync(file, `${root}.moved`); fs.symlinkSync(`${root}.moved`, file); }],
    ['a hard-linked record', (root) => fs.linkSync(path.join(root, 'keys', '0000000001.json'), `${root}.link`)],
    ['a widened mode', (root) => fs.chmodSync(path.join(root, 'keys', '0000000003.json'), 0o644)],
    ['a group-writable ancestor', (root) => fs.chmodSync(path.dirname(root), 0o775)],
    // Fully audited and confirmed forgeries: only the state machine refuses them.
    ['a second enrollment without revocation', (root) => {
      const v3 = fs.readFileSync(path.join(root, 'keys', '0000000003.json'));
      forgeConfirmed(root, { ...JSON.parse(v3), version: 4, previousDigest: sha256(v3), auditId: '44444444-4444-4444-8444-444444444444' });
    }],
    ['a stale revocation of an earlier key', (root) => {
      // Version 2 revoked version 1; repeating that while version 3 is active is illegal.
      const v2 = JSON.parse(fs.readFileSync(path.join(root, 'keys', '0000000002.json')));
      const v3 = fs.readFileSync(path.join(root, 'keys', '0000000003.json'));
      forgeConfirmed(root, { ...v2, version: 4, previousDigest: sha256(v3), auditId: '55555555-5555-4555-8555-555555555555' });
    }],
  ];
  for (const [name, damage] of cases) {
    await t.test(name, (tt) => {
      const root = enrolled(tt);
      damage(root);
      const before = snapshot(root);
      assert.throws(() => read(root), (error) => error.code === 'storage-failed', name);
      if (name.startsWith('a second') || name.startsWith('a stale')) assert.throws(() => read(root), refused('owner-trust-corrupt'));
      assert.deepEqual(snapshot(root), before, `${name}: kept as found`);
    });
  }
});

test('enumeration is bounded before anything is allocated', darwin, (t) => {
  const root = enrolled(t);
  for (let index = 0; index < 3000; index++) fs.writeFileSync(path.join(root, 'keys', `x${index}`), '');
  let reads = 0;
  const io = { ...fs, readdirSync: () => assert.fail('never read whole'),
    opendirSync: (dir) => { const handle = fs.opendirSync(dir); return { readSync: () => { reads++; return handle.readSync(); }, closeSync: () => handle.closeSync() }; } };
  assert.throws(() => read(root, { io }), (error) => error.code === 'storage-failed');
  assert(reads <= 6 + 2 * 1024 + 2, `read ${reads} entries`);
});

test('a held trust lock refuses instead of waiting', darwin, (t) => {
  const root = enrolled(t);
  const held = fs.openSync(path.join(root, '.trust-lock'), fs.constants.O_RDWR | fs.constants.O_NONBLOCK | 0x20);
  try { assert.throws(() => read(root), refused('owner-trust-busy', 'storage-failed')); } finally { fs.closeSync(held); }
  assert.equal(read(root).version, 3);
});

// Documented limit, not a guarantee: deleting a complete suffix (records,
// confirmations and their audit lines) leaves an earlier valid chain, which
// the local chain cannot tell apart. Online broker revocation stays required.
test('the documented rollback limit: a removed complete suffix reads as the earlier chain', darwin, (t) => {
  const root = enrolled(t);
  for (const name of ['0000000003.json', '0000000003.confirm.json']) fs.rmSync(path.join(root, 'keys', name));
  const lines = fs.readFileSync(path.join(root, 'audit.jsonl'), 'utf8').trim().split('\n');
  fs.writeFileSync(path.join(root, 'audit.jsonl'), `${lines.slice(0, -1).join('\n')}\n`);
  assert.throws(() => read(root), refused('owner-trust-no-active-key'));
});

test('reconcile checks custody first and keeps any pending bytes it cannot match exactly', darwin, async (t) => {
  // An enrollment interrupted right after its link: keys/.pending.json and
  // keys/0000000001.json are two names for one inode.
  const interrupted = (tt) => {
    const root = freshRoot(tt);
    writer(root).enrollNamespace({ namespaceDigest });
    assert.throws(() => writer(root, { fault: (at) => { if (at === 'key-1:linked') throw new Error('crash'); } }).enrollKeys(keys()));
    return root;
  };

  await t.test('a symlinked keys directory refuses and nothing is unlinked', (tt) => {
    const root = interrupted(tt), moved = `${root}-keys-elsewhere`;
    fs.renameSync(path.join(root, 'keys'), moved);
    fs.symlinkSync(moved, path.join(root, 'keys'));
    tt.after(() => fs.rmSync(moved, { recursive: true, force: true }));
    const before = fs.readdirSync(moved).sort();
    assert.throws(() => writer(root).reconcile(), refused('owner-trust-custody', 'storage-failed'));
    assert.deepEqual(fs.readdirSync(moved).sort(), before);
    assert(before.includes('.pending.json'));
  });

  await t.test('a pending name whose second link is outside the store is kept and refused', (tt) => {
    const root = interrupted(tt), keysDir = path.join(root, 'keys');
    // Replace the in-store twin with an outside link to the same bytes.
    fs.linkSync(path.join(keysDir, '.pending.json'), `${root}-outside`);
    tt.after(() => fs.rmSync(`${root}-outside`, { force: true }));
    fs.rmSync(path.join(keysDir, '0000000001.json'));
    const before = snapshot(root);
    assert.throws(() => writer(root).reconcile(), refused('owner-trust-pending'));
    assert.deepEqual(snapshot(root), before);
  });

  await t.test('a lone pending file whose bytes differ from the needed confirmation is kept and refused', (tt) => {
    const root = freshRoot(tt);
    writer(root).enrollNamespace({ namespaceDigest });
    assert.throws(() => writer(root, { fault: (at) => { if (at === 'key-1:confirmation:pending-flushed') throw new Error('crash'); } }).enrollKeys(keys()));
    const pending = path.join(root, 'keys', '.pending.json');
    fs.writeFileSync(pending, Buffer.from(fs.readFileSync(pending).toString().replace('"v":1', '"v":2')));
    const before = snapshot(root);
    assert.throws(() => writer(root).reconcile(), refused('owner-trust-pending'));
    assert.deepEqual(snapshot(root), before);
  });

  await t.test('a symlinked pending name is refused without being followed', (tt) => {
    const root = interrupted(tt), keysDir = path.join(root, 'keys');
    fs.rmSync(path.join(keysDir, '.pending.json'));
    fs.writeFileSync(`${root}-target`, 'outside', { mode: 0o600 });
    tt.after(() => fs.rmSync(`${root}-target`, { force: true }));
    fs.symlinkSync(`${root}-target`, path.join(keysDir, '.pending.json'));
    assert.throws(() => writer(root).reconcile(), (error) => error.code === 'storage-failed');
    assert.equal(fs.readFileSync(`${root}-target`, 'utf8'), 'outside');
    assert(fs.lstatSync(path.join(keysDir, '.pending.json')).isSymbolicLink());
  });
});

test('the broker service uid is never root or the owner, and no pin may be this daemon\'s own key', darwin, (t) => {
  const root = freshRoot(t), w = writer(root);
  w.enrollNamespace({ namespaceDigest });
  const invalidInput = refused('owner-trust-invalid-input', 'bad-request');
  for (const uid of [0, process.getuid(), -1, 2 ** 32, 1.5, '600']) {
    assert.throws(() => w.enrollKeys({ ...keys(), brokerUid: uid }), invalidInput, String(uid));
  }
  // A pin equal to our daemonKey, or no daemonKey to compare with, refuses at enrollment.
  const own = generateKeyPairSync('ed25519').publicKey, ownKey = own.export({ format: 'jwk' }).x;
  const ownId = sha256(own.export({ type: 'spki', format: 'der' }));
  assert.throws(() => w.enrollKeys({ ...keys(), receiptKey: ownKey, daemonKey: ownId }), invalidInput);
  assert.throws(() => w.enrollKeys({ ...keys(), presenceKey: ownKey, daemonKey: ownId }), invalidInput);
  assert.throws(() => w.enrollKeys({ ...keys(), daemonKey: undefined }), invalidInput);
  assert.equal(fs.existsSync(path.join(root, 'keys')), false);

  // Readiness requires our daemonKey and refuses an active pin equal to it.
  const enrolled = keys(), pin = ed25519KeyPin(enrolled.receiptKey);
  w.enrollKeys(enrolled);
  assert.equal(read(root).state, 'ready');
  assert.throws(() => readOwnerDecisionTrust({ root }), invalidInput);
  assert.throws(() => read(root, { daemonKey: pin.keyId }), refused('owner-trust-role', 'owner-decision-unsupported'));
  assert.throws(() => read(root, { daemonKey: ed25519KeyPin(enrolled.presenceKey).keyId }), refused('owner-trust-role'));
});

test('a stored enrollment naming root or the owner as the broker is refused as damage', darwin, async (t) => {
  for (const uid of [0, process.getuid()]) {
    await t.test(String(uid), (tt) => {
      const root = freshRoot(tt), w = writer(root);
      w.enrollNamespace({ namespaceDigest });
      w.enrollKeys(keys());
      // Rewrite version 1 with the forbidden uid, re-binding its audit line
      // and confirmation, so only the uid rule can refuse it.
      const file = path.join(root, 'keys', '0000000001.json');
      const value = { ...JSON.parse(fs.readFileSync(file, 'utf8')) };
      value.service = { ...value.service, brokerUid: uid };
      const bytes = Buffer.from(canonicalJson(value));
      fs.writeFileSync(file, bytes);
      const audit = path.join(root, 'audit.jsonl'), lines = fs.readFileSync(audit, 'utf8').trim().split('\n');
      const last = { ...JSON.parse(lines.at(-1)), recordDigest: sha256(bytes) }, line = `${canonicalJson(last)}\n`;
      fs.writeFileSync(audit, `${[...lines.slice(0, -1), canonicalJson(last)].join('\n')}\n`);
      const confirm = path.join(root, 'keys', '0000000001.confirm.json');
      fs.writeFileSync(confirm, canonicalJson({ ...JSON.parse(fs.readFileSync(confirm, 'utf8')), recordDigest: sha256(bytes), auditLineDigest: sha256(line) }));
      assert.throws(() => read(root), refused('owner-trust-corrupt', 'storage-failed'));
    });
  }
});
