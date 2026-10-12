// The pinned broker namespace against agent-comms' published derivation
// vectors (#1007): tests/fixtures/owner-decisions/broker-namespace-v1.json
// copied byte for byte from agent-comms 11767ad (merged PR #203). The IDs are
// public synthetic values, not enrolled identities. The daemon only ever pins
// the digest; the derivation is recomputed here solely to check the vectors.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { canonicalJson } from '../canonical-json.mjs';
import { createOwnerDecisionTrustWriter, isNamespaceDigest, readOwnerDecisionTrust } from '../identity/owner-decision-trust.mjs';
import { loadOrCreateVouchKey, vouchStateDir } from '../identity/vouch.mjs';

// A scratch vouch key for readiness checks, never the real one.
const vouchState = fs.realpathSync(fs.mkdtempSync(path.join(tmpdir(), 'owner-namespace-vouch-')));
process.on('exit', () => fs.rmSync(vouchState, { recursive: true, force: true }));
const vouchEnv = { XDG_STATE_HOME: vouchState };
loadOrCreateVouchKey(vouchStateDir({ env: vouchEnv }));

const VECTORS_URL = new URL('./fixtures/owner-decisions/broker-namespace-v1.json', import.meta.url);
const VECTORS_SHA256 = '559aff92b9dfe47a252d684a019a6b3928bc397c9e911607540289ad1ecac179';
const vectors = JSON.parse(fs.readFileSync(VECTORS_URL, 'utf8'));
const darwin = { skip: process.platform !== 'darwin' && 'the trust lock is Darwin-only' };
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

// For each vector: the published digest, and spellings of the same value
// that are not the pinned form.
const forms = () => vectors.vectors.map((vector) => ({
  vector,
  rejected: [vector.namespaceDigest.toUpperCase(), Buffer.from(vector.namespaceDigest, 'hex').toString('base64url'),
    Buffer.from(vector.namespaceDigest, 'hex').toString('base64'), vector.namespaceIdBase64url, `${vector.namespaceDigest}\n`],
}));

test('the vendored namespace vectors are the pinned agent-comms copy and their digests reproduce', () => {
  assert.equal(sha256(fs.readFileSync(VECTORS_URL)), VECTORS_SHA256);
  assert.equal(vectors.domainAscii, 'agent-comms-owner-broker-namespace-v1\n');
  assert.equal(vectors.vectors.length, 3);
  for (const { namespaceIdHex, namespaceIdBase64url, namespaceDigest } of vectors.vectors) {
    const id = Buffer.from(namespaceIdHex, 'hex');
    assert.equal(id.length, 32); assert(Buffer.from(namespaceIdBase64url, 'base64url').equals(id));
    assert.equal(sha256(Buffer.concat([Buffer.from(vectors.domainAscii, 'ascii'), id])), namespaceDigest);
  }
  assert.equal(vectors.vectors[0].namespaceDigest, 'cae42435cda19e86d783f8825996490e04d69416eaf31acfe5e04fb5b2825f9c');
});

test('only the lowercase 64-hex digest is a namespace pin', () => {
  for (const { vector, rejected } of forms()) {
    assert.equal(isNamespaceDigest(vector.namespaceDigest), true, vector.id);
    // A raw ID written as hex is also lowercase 64-hex, so no format check can
    // tell it from a digest. Only the owner ceremony's published digest is
    // ever pinned; the format check rejects every other spelling below.
    for (const value of rejected) assert.equal(isNamespaceDigest(value), false, `${vector.id}: ${value}`);
  }
});

test('namespace.json accepts each published digest and refuses every other spelling', darwin, async (t) => {
  for (const { vector, rejected } of forms()) {
    await t.test(vector.id, (tt) => {
      const base = fs.realpathSync(fs.mkdtempSync(path.join(tmpdir(), 'owner-namespace-')));
      tt.after(() => fs.rmSync(base, { recursive: true, force: true }));
      const root = path.join(base, 'trust'), writer = createOwnerDecisionTrustWriter({ root });
      for (const value of rejected) {
        assert.throws(() => writer.enrollNamespace({ namespaceDigest: value }), { code: 'bad-request', reason: 'owner-trust-invalid-input' });
      }
      assert.equal(writer.enrollNamespace({ namespaceDigest: vector.namespaceDigest }).state, 'enrolled');
      assert.throws(() => readOwnerDecisionTrust({ root, namespaceDigest: vector.namespaceDigest, env: vouchEnv }), { reason: 'owner-trust-no-active-key' });
      // A stored record carrying any other spelling is refused as damage, and kept.
      const file = path.join(root, 'namespace.json');
      const stored = JSON.parse(fs.readFileSync(file, 'utf8'));
      for (const value of rejected.filter((candidate) => !candidate.endsWith('\n'))) {
        fs.writeFileSync(file, canonicalJson({ ...stored, namespaceDigest: value }), { mode: 0o600 });
        const before = fs.readFileSync(file);
        assert.throws(() => readOwnerDecisionTrust({ root, env: vouchEnv }), { code: 'storage-failed' });
        assert(fs.readFileSync(file).equals(before));
      }
    });
  }
});
