// Disabled owner-decision action decoding and native p1 verification
// (agent-comms#77, C2), against agent-comms tests/fixtures/owner-decisions/v1.json
// (vendored, SHA-256 70706e73..., shipped in agent-comms 0.5.2 at 9edd21b).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { decodeOwnerDecisionAction, ownerDecisionCanonical, verifyOwnerDecisionPresence } from '../identity/owner-decision-action.mjs';

const FIXTURE_URL = new URL('./fixtures/owner-decisions/v1.json', import.meta.url);
const vectors = JSON.parse(readFileSync(FIXTURE_URL, 'utf8'));
const sha256 = (value) => createHash('sha256').update(value).digest('hex');
const pinOf = (spkiDer) => ({ alg: 'ed25519', publicKey: spkiDer.subarray(12).toString('base64url'), keyId: sha256(spkiDer) });
const trust = { presenceKey: pinOf(Buffer.from(vectors.keys.presenceSpkiBase64, 'base64')) };
const refused = { code: 'invalid-owner-decision' };
const bytesOf = (vector) => Buffer.from(vector.actionBase64url, 'base64url');

test('the shared fixture is the pinned copy and its presence key is the pin', () => {
  assert.equal(sha256(readFileSync(FIXTURE_URL)), '70706e7327b90f8649b0b1f8baa7b59d2e4e8f6f1f33b674dc8472cb7eb951ac');
  assert.equal(trust.presenceKey.keyId, vectors.keys.presenceKey);
});

test('all 11 positive actions decode to their exact summary, text, counts and digests, and their p1 verifies', () => {
  assert.equal(vectors.positive.length, 11);
  for (const v of vectors.positive) {
    const bytes = bytesOf(v);
    assert.equal(bytes.toString('utf8'), v.actionJson, v.id);
    const decoded = decodeOwnerDecisionAction(bytes);
    assert.equal(decoded.payloadDigest, v.payloadDigest, v.id); assert.equal(decoded.summary, v.summary);
    assert.equal(decoded.actionText, v.actionText);
    assert.equal([...decoded.actionText].length, v.actionScalars); assert.equal(Buffer.byteLength(decoded.actionText), v.actionUtf8Bytes);
    assert.equal(decoded.actionDigest, v.presencePayload.action);
    const result = verifyOwnerDecisionPresence(v.presenceToken, { actionBytes: bytes, nonce: v.presencePayload.nonce, trust,
      nowMilliseconds: v.presencePayload.iat * 1000 });
    assert.deepEqual(result.payload, v.presencePayload, v.id);
    assert.equal(result.presenceDigest, v.receiptPayload.presenceDigest);
  }
});

test('the 400/401-scalar and 500/501-byte display boundaries accept or refuse exactly', () => {
  assert.equal(vectors.displayBoundaries.length, 5);
  for (const v of vectors.displayBoundaries) {
    const bytes = bytesOf(v);
    if (v.expectedPreparation === 'accept') {
      const decoded = decodeOwnerDecisionAction(bytes);
      assert.equal(decoded.actionText, v.actionText, v.id);
      assert.equal(verifyOwnerDecisionPresence(v.presenceToken, { actionBytes: bytes, nonce: v.presencePayload.nonce, trust,
        nowMilliseconds: v.presencePayload.iat * 1000 }).payload.action, v.presencePayload.action);
    } else {
      assert.throws(() => decodeOwnerDecisionAction(bytes), { ...refused, reason: 'owner-action-display' }, v.id);
      assert.throws(() => verifyOwnerDecisionPresence(v.presenceToken, { actionBytes: bytes, nonce: v.presencePayload.nonce, trust,
        nowMilliseconds: v.presencePayload.iat * 1000 }), refused, v.id);
    }
  }
});

test('all 15 negative action encodings refuse', () => {
  assert.equal(vectors.negativeActionBytes.length, 15);
  for (const v of vectors.negativeActionBytes) {
    assert.equal(v.expected, 'refuse');
    assert.throws(() => decodeOwnerDecisionAction(Buffer.from(v.bytesBase64url, 'base64url')), refused, v.id);
  }
});

test('the canonical encoding reproduces both serialization vectors byte for byte', () => {
  for (const v of vectors.serialization) {
    const text = ownerDecisionCanonical(v.value);
    assert.equal(text, v.canonicalJson, v.id);
    assert.equal(Buffer.from(text).toString('hex'), v.utf8Hex); assert.equal(sha256(Buffer.from(text)), v.sha256);
  }
});

test('all 19 primitive cases are accepted or refused exactly, inside otherwise valid actions', () => {
  const base = JSON.parse(vectors.positive[0].actionJson);
  const webhook = JSON.parse(vectors.positive.find(({ actionJson }) => actionJson.includes('"mode":"webhook"')).actionJson);
  assert.equal(vectors.primitiveCases.length, 19);
  for (const c of vectors.primitiveCases) {
    const action = c.field === 'host' ? { ...webhook, parameters: { ...webhook.parameters, host: c.value } } : { ...base, [c.field]: c.value };
    let bytes;
    try { bytes = Buffer.from(ownerDecisionCanonical(action)); } catch { assert.equal(c.expected, false, c.id); continue; }
    if (c.expected) decodeOwnerDecisionAction(bytes);
    else assert.throws(() => decodeOwnerDecisionAction(bytes), refused, c.id);
  }
});

// A test-local native signer, for clock and refusal cases beyond the fixture.
const signer = generateKeyPairSync('ed25519');
const signerTrust = { presenceKey: pinOf(signer.publicKey.export({ type: 'spki', format: 'der' })) };
function p1(payload, key = signer.privateKey) {
  const segment = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `p1.${segment}.${sign(null, Buffer.from(segment), key).toString('base64url')}`;
}

test('the native presence clock follows both shared grace cases', () => {
  const v = vectors.positive[0], bytes = bytesOf(v);
  for (const c of vectors.nativePresenceClockCases) {
    const token = p1({ ...v.presencePayload, iat: c.iat, exp: c.exp });
    const run = () => verifyOwnerDecisionPresence(token, { actionBytes: bytes, nonce: v.presencePayload.nonce, trust: signerTrust, nowMilliseconds: c.now * 1000 });
    if (c.expected) run(); else assert.throws(run, refused, c.id);
  }
});

test('a p1 for another key, action, nonce, audience or kind, or out of time, refuses', () => {
  const v = vectors.positive[0], bytes = bytesOf(v), nonce = v.presencePayload.nonce, now = v.presencePayload.iat * 1000;
  const ok = p1(v.presencePayload);
  assert.equal(verifyOwnerDecisionPresence(ok, { actionBytes: bytes, nonce, trust: signerTrust, nowMilliseconds: now }).payload.action, v.presencePayload.action);
  const run = (token, options = {}) => () => verifyOwnerDecisionPresence(token, { actionBytes: bytes, nonce, trust: signerTrust, nowMilliseconds: now, ...options });
  for (const [name, attempt] of [
    ['signed by another key', run(p1(v.presencePayload, generateKeyPairSync('ed25519').privateKey))],
    ['the fixture pin for a test-signed p1', run(ok, { trust })],
    ['another action', run(ok, { actionBytes: bytesOf(vectors.positive[1]) })],
    ['another nonce', run(ok, { nonce: 'AgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgI' })],
    ['another audience', run(p1({ ...v.presencePayload, aud: 'agent-comms-owner-decision' }))],
    ['another kind', run(p1({ ...v.presencePayload, kind: 'statement' }))],
    ['a lifetime over 120 seconds', run(p1({ ...v.presencePayload, exp: v.presencePayload.iat + 121 }))],
    ['expired past the grace', run(ok, { nowMilliseconds: (v.presencePayload.exp + 31) * 1000 })],
    ['no clock', run(ok, { nowMilliseconds: undefined })],
    ['not a p1', run(v.receiptToken)],
    ['a pin whose keyId is not its key', run(ok, { trust: { presenceKey: { ...signerTrust.presenceKey, keyId: trust.presenceKey.keyId } } })],
  ]) assert.throws(attempt, refused, name);
});

test('the challenge nonce is required, canonical and exactly 32 bytes', () => {
  const v = vectors.positive[0], bytes = bytesOf(v), now = v.presencePayload.iat * 1000;
  const { nonce: _omit, ...withoutNonce } = v.presencePayload;
  const noNonce = p1(withoutNonce);
  const nonceRefused = { ...refused, reason: 'owner-presence-nonce' };
  // Missing on both sides: undefined never matches undefined.
  assert.throws(() => verifyOwnerDecisionPresence(noNonce, { actionBytes: bytes, trust: signerTrust, nowMilliseconds: now }), nonceRefused);
  const raw = Buffer.from(v.presencePayload.nonce, 'base64url');
  const last = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'.split('')
    .map((ch) => `${v.presencePayload.nonce.slice(0, 42)}${ch}`).find((x) => x !== v.presencePayload.nonce && Buffer.from(x, 'base64url').equals(raw));
  assert(last, 'a non-canonical spelling of the same 32 bytes exists');
  for (const [name, nonce] of [['non-canonical trailing bits', last], ['padded', `${v.presencePayload.nonce}=`],
    ['standard base64', raw.toString('base64')], ['31 bytes', raw.subarray(0, 31).toString('base64url')],
    ['33 bytes', Buffer.concat([raw, Buffer.from([1])]).toString('base64url')], ['empty', ''], ['not a string', 42]]) {
    // Even a p1 carrying exactly that value refuses.
    assert.throws(() => verifyOwnerDecisionPresence(p1({ ...v.presencePayload, nonce }), { actionBytes: bytes, nonce, trust: signerTrust, nowMilliseconds: now }),
      nonceRefused, name);
  }
});

test('an iat beyond the 30-second future skew refuses; at the skew it verifies', () => {
  const v = vectors.positive[0], bytes = bytesOf(v), nowSeconds = v.presencePayload.iat;
  const at = (iat) => p1({ ...v.presencePayload, iat, exp: iat + 60 });
  const check = (token) => verifyOwnerDecisionPresence(token, { actionBytes: bytes, nonce: v.presencePayload.nonce, trust: signerTrust, nowMilliseconds: nowSeconds * 1000 });
  assert.equal(check(at(nowSeconds + 30)).payload.iat, nowSeconds + 30);
  assert.throws(() => check(at(nowSeconds + 31)), refused);
});
