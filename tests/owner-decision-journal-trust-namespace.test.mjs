// The namespace-only trust reader (agent-comms#77): {namespaceDigest} for a
// host's first enrollment, without depending on the key chain, and never
// readiness or authority.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync } from 'node:crypto';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { createOwnerDecisionTrustWriter, readOwnerDecisionNamespace, readOwnerDecisionTrust } from '../identity/owner-decision-trust.mjs';
import { withCurrentObservation } from './helpers/owner-decision-trust-v1.mjs';
import { loadOrCreateVouchKey, vouchStateDir } from '../identity/vouch.mjs';
import { rawEd25519 } from './helpers/ed25519-raw.mjs';

// Scratch state and home for every writer and reader here, with a generated
// scratch vouch key: never the real vouch-key.pem or keyd presence cache.
const scratch = fs.realpathSync(fs.mkdtempSync(path.join(tmpdir(), 'owner-namespace-reader-state-')));
process.on('exit', () => fs.rmSync(scratch, { recursive: true, force: true }));
const scope = { env: { XDG_STATE_HOME: scratch }, home: scratch };
loadOrCreateVouchKey(vouchStateDir(scope));
const writer = (root, options = {}) => withCurrentObservation(createOwnerDecisionTrustWriter({ root, ...scope, ...options }), { root, ...scope });

const darwin = { skip: process.platform !== 'darwin' && 'the trust lock is Darwin-only' };
const namespaceDigest = 'a'.repeat(64);
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const refused = (reason, code = 'storage-failed') => (error) => error.reason === reason && error.code === code;
const rawKey = () => rawEd25519(generateKeyPairSync('ed25519').publicKey);

function freshRoot(t) {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(tmpdir(), 'owner-namespace-reader-')));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  return path.join(base, 'trust');
}
function snapshot(root) {
  const out = {};
  const walk = (dir) => { for (const name of fs.readdirSync(dir)) { const file = path.join(dir, name); if (fs.lstatSync(file).isDirectory()) walk(file); else out[path.relative(root, file)] = fs.readFileSync(file); } };
  walk(root);
  return out;
}
// The daemonKey is derived from the scratch vouch key; generated pins never equal it.
const enrollKeys = (w) => w.enrollKeys({ receiptKey: rawKey(), presenceKey: rawKey(), brokerUid: process.getuid() + 1 });

test('before any keys, the namespace reads while full trust is still unsupported', darwin, (t) => {
  const root = freshRoot(t);
  assert.throws(() => readOwnerDecisionNamespace({ root }), refused('owner-trust-missing', 'owner-decision-unsupported'));
  writer(root).enrollNamespace({ namespaceDigest });
  const before = snapshot(root);
  assert.deepEqual(readOwnerDecisionNamespace({ root }), { namespaceDigest });
  assert.deepEqual(snapshot(root), before);
  assert.throws(() => readOwnerDecisionTrust({ root, ...scope }), refused('owner-trust-no-active-key', 'owner-decision-unsupported'));
});

test('between a revocation and the next enrollment the namespace still reads, and nothing more', darwin, (t) => {
  const root = freshRoot(t), w = writer(root);
  w.enrollNamespace({ namespaceDigest });
  enrollKeys(w);
  w.revokeKeys({ revokes: sha256(fs.readFileSync(path.join(root, 'keys', '0000000001.json'))), reason: 'rotated' });
  const result = readOwnerDecisionNamespace({ root });
  assert.deepEqual(result, { namespaceDigest });
  assert.deepEqual(Object.keys(result), ['namespaceDigest']);
  // It does not depend on the chain at all: even a damaged chain leaves it readable.
  fs.writeFileSync(path.join(root, 'keys', '0000000002.json'), 'not a record');
  assert.deepEqual(readOwnerDecisionNamespace({ root }), { namespaceDigest });
});

test('a pending namespace audit or publication refuses for an explicit retry and is left as found', darwin, async (t) => {
  for (const point of ['namespace:published', 'namespace:audit-flushed', 'namespace:confirmation:pending-flushed']) {
    await t.test(point, (tt) => {
      const root = freshRoot(tt);
      assert.throws(() => writer(root, { fault: (at) => { if (at === point) throw new Error('crash'); } })
        .enrollNamespace({ namespaceDigest }));
      const before = snapshot(root);
      const reason = point.includes('confirmation:pending') ? 'owner-trust-pending' : 'owner-trust-audit-pending';
      assert.throws(() => readOwnerDecisionNamespace({ root }), refused(reason));
      assert.deepEqual(snapshot(root), before);
    });
  }
});

test('a held lock refuses instead of waiting', darwin, (t) => {
  const root = freshRoot(t);
  writer(root).enrollNamespace({ namespaceDigest });
  const held = fs.openSync(path.join(root, '.trust-lock'), fs.constants.O_RDWR | fs.constants.O_NONBLOCK | 0x20);
  try { assert.throws(() => readOwnerDecisionNamespace({ root }), refused('owner-trust-busy')); } finally { fs.closeSync(held); }
  assert.deepEqual(readOwnerDecisionNamespace({ root }), { namespaceDigest });
});

test('custody failures and damage refuse, kept as found', darwin, async (t) => {
  const cases = [
    ['a group-writable ancestor', (root) => fs.chmodSync(path.dirname(root), 0o775)],
    ['a widened namespace mode', (root) => fs.chmodSync(path.join(root, 'namespace.json'), 0o644)],
    ['a hard-linked namespace', (root) => fs.linkSync(path.join(root, 'namespace.json'), `${root}.link`)],
    ['a symlinked namespace', (root) => { fs.renameSync(path.join(root, 'namespace.json'), `${root}.moved`); fs.symlinkSync(`${root}.moved`, path.join(root, 'namespace.json')); }],
    ['a widened root mode', (root) => fs.chmodSync(root, 0o755)],
    ['an edited namespace', (root) => fs.writeFileSync(path.join(root, 'namespace.json'), fs.readFileSync(path.join(root, 'namespace.json'), 'utf8').replace('aaaa', 'bbbb'))],
    ['a missing audit line', (root) => fs.writeFileSync(path.join(root, 'audit.jsonl'), '')],
    ['a stray file', (root) => fs.writeFileSync(path.join(root, 'notes'), 'x')],
  ];
  for (const [name, damage] of cases) {
    await t.test(name, (tt) => {
      const root = freshRoot(tt);
      writer(root).enrollNamespace({ namespaceDigest });
      damage(root);
      const before = snapshot(root);
      assert.throws(() => readOwnerDecisionNamespace({ root }), (error) => error.code === 'storage-failed', name);
      assert.deepEqual(snapshot(root), before);
      fs.chmodSync(path.dirname(root), 0o700);
    });
  }
});
