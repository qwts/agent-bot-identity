// Disabled d1 receipt verification (agent-comms#77, C2). Fixtures are agent-comms
// tests/fixtures/owner-decisions/issuer-v1.json at c7f7ea0 (merged #213) and
// its source v1.json (the p1 tokens and presence key), copied byte for byte.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { canonicalJson } from '../canonical-json.mjs';
import { receiptClockValid, verifyOwnerDecisionReceipt } from '../identity/owner-decision-receipt.mjs';

const ISSUER_URL = new URL('./fixtures/owner-decisions/issuer-v1.json', import.meta.url);
const SOURCE_URL = new URL('./fixtures/owner-decisions/v1.json', import.meta.url);
const sha256 = (value) => createHash('sha256').update(value).digest('hex');
const issuer = JSON.parse(readFileSync(ISSUER_URL, 'utf8'));
const source = JSON.parse(readFileSync(SOURCE_URL, 'utf8'));
const pinOf = (spkiBase64) => {
  const der = Buffer.from(spkiBase64, 'base64');
  return { alg: 'ed25519', publicKey: der.subarray(12).toString('base64url'), keyId: sha256(der) };
};
const trust = { receiptKey: pinOf(issuer.brokerSpkiBase64), presenceKey: pinOf(source.keys.presenceSpkiBase64) };
const refused = (reason) => ({ code: 'receipt-invalid', reason });

function caseInputs(c) {
  const challenge = JSON.parse(c.preparedJson).challenge;
  return { trust, daemonKey: challenge.daemonKey, challengeBytes: Buffer.from(canonicalJson(challenge)),
    presenceToken: source.positive[c.sourceIndex].presenceToken, nowMilliseconds: c.nowMilliseconds };
}

test('the vendored issuer and source fixtures are the pinned agent-comms copies', () => {
  assert.equal(sha256(readFileSync(ISSUER_URL)), 'da8d10b7994edd275c18042a5c418eb634c1bccabc8c47a0f80d9a58bcdb7028');
  assert.equal(sha256(readFileSync(SOURCE_URL)), '70706e7327b90f8649b0b1f8baa7b59d2e4e8f6f1f33b674dc8472cb7eb951ac');
  assert.equal(issuer.sourceSha256, sha256(readFileSync(SOURCE_URL)));
});

test('all 11 issued receipts verify byte for byte against the pinned keys and their saved challenge and p1', () => {
  assert.equal(issuer.cases.length, 11);
  for (const c of issuer.cases) {
    const result = verifyOwnerDecisionReceipt(c.receiptToken, caseInputs(c));
    assert.deepEqual(result.payload, c.payload, `case ${c.sourceIndex}`);
    assert.equal(result.receiptDigest, c.receiptDigest);
    assert.equal(sha256(Buffer.from(canonicalJson(result.payload))), sha256(Buffer.from(c.receiptToken.split('.')[1], 'base64url')));
  }
});

test('the receipt clock follows all eight shared clock cases', () => {
  assert.equal(source.receiptClockCases.length, 8);
  for (const c of source.receiptClockCases) assert.equal(receiptClockValid(c), c.expected, c.id);
});

test('a receipt never outlives its saved challenge or its p1, and is bound to both exactly', () => {
  const c = issuer.cases[0], inputs = caseInputs(c), challenge = JSON.parse(c.preparedJson).challenge;
  const withChallenge = (edit) => ({ ...inputs, challengeBytes: Buffer.from(canonicalJson({ ...challenge, ...edit })) });
  for (const edit of [{ exp: c.payload.exp - 1 }, { nonce: 'AgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgI' }, { requestId: '22222222-2222-4222-8222-222222222222' },
    { payloadDigest: 'f'.repeat(64) }, { soul: 'agent_22222222-2222-4222-8222-222222222222' }, { daemonKey: 'b'.repeat(64) }]) {
    assert.throws(() => verifyOwnerDecisionReceipt(c.receiptToken, withChallenge(edit)), refused('owner-receipt-binding'), JSON.stringify(edit));
  }
  // Another p1 than the one the receipt names.
  assert.throws(() => verifyOwnerDecisionReceipt(c.receiptToken, { ...inputs, presenceToken: source.positive[1].presenceToken }), refused('owner-receipt-binding'));
});

test('keys: only the active pins verify, and no receipt, presence or vouch key alias is accepted', () => {
  const c = issuer.cases[0], inputs = caseInputs(c);
  const other = pinOf(generateKeyPairSync('ed25519').publicKey.export({ type: 'spki', format: 'der' }).toString('base64'));
  assert.throws(() => verifyOwnerDecisionReceipt(c.receiptToken, { ...inputs, trust: { ...trust, receiptKey: other } }), refused('owner-receipt-trust'));
  assert.throws(() => verifyOwnerDecisionReceipt(c.receiptToken, { ...inputs, trust: { ...trust, presenceKey: other } }), refused('owner-receipt-trust'));
  for (const aliased of [{ trust: { ...trust, presenceKey: trust.receiptKey } }, { daemonKey: trust.receiptKey.keyId }, { daemonKey: trust.presenceKey.keyId }]) {
    assert.throws(() => verifyOwnerDecisionReceipt(c.receiptToken, { ...inputs, ...aliased }), refused('owner-receipt-alias'));
  }
  // A pin whose keyId does not match its own key: the keyId is recomputed from the key.
  assert.throws(() => verifyOwnerDecisionReceipt(c.receiptToken, { ...inputs, trust: { ...trust, receiptKey: { ...trust.receiptKey, keyId: other.keyId } } }),
    refused('owner-receipt-trust'));
});

// A test-local issuer: signs exact payloads with its own key, so each rule is
// exercised on a receipt that is otherwise valid.
const broker = generateKeyPairSync('ed25519');
const brokerPin = pinOf(broker.publicKey.export({ type: 'spki', format: 'der' }).toString('base64'));
function issue(payload, { segment = Buffer.from(canonicalJson(payload)).toString('base64url'), key = broker.privateKey } = {}) {
  return `d1.${segment}.${sign(null, Buffer.from(segment, 'ascii'), key).toString('base64url')}`;
}

test('every malformed, foreign or out-of-time receipt refuses', () => {
  const c = issuer.cases[0], inputs = { ...caseInputs(c), trust: { ...trust, receiptKey: brokerPin } };
  const base = { ...c.payload, brokerKey: brokerPin.keyId };
  assert.equal(verifyOwnerDecisionReceipt(issue(base), inputs).payload.brokerKey, brokerPin.keyId);
  const bad = [
    ['wrong audience', issue({ ...base, aud: 'agent-comms' })], ['extra field', issue({ ...base, extra: 1 })],
    ['missing field', issue((({ presenceKey, ...rest }) => rest)(base))], ['version 2', issue({ ...base, v: 2 })],
    ['uppercase digest', issue({ ...base, payloadDigest: base.payloadDigest.toUpperCase() })],
    ['short nonce', issue({ ...base, nonce: 'AQEB' })], ['another broker key named', issue({ ...base, brokerKey: trust.receiptKey.keyId })],
    ['not canonical JSON', issue(base, { segment: Buffer.from(JSON.stringify(base, null, 1)).toString('base64url') })],
    ['signed by another key', issue(base, { key: generateKeyPairSync('ed25519').privateKey })],
    ['wrong prefix', issue(base).replace(/^d1/, 'd2')], ['padded segment', issue(base).replace(/^d1\.([^.]+)/, 'd1.$1=')],
    ['oversize', `d1.${'A'.repeat(5000)}.x`], ['not a string', 42],
    ['expired', issue({ ...base, iat: 1999999900, exp: 1999999960 })], ['lifetime 61', issue({ ...base, exp: base.iat + 61 })],
  ];
  for (const [name, token] of bad) assert.throws(() => verifyOwnerDecisionReceipt(token, inputs), { code: 'receipt-invalid' }, name);
  // The p1's own stated expiry bounds the receipt.
  const p1 = source.positive[c.sourceIndex].presenceToken, p1Exp = JSON.parse(Buffer.from(p1.split('.')[1], 'base64url')).exp;
  const late = issue({ ...base, iat: p1Exp - 30, exp: p1Exp + 1 });
  assert.throws(() => verifyOwnerDecisionReceipt(late, { ...inputs, nowMilliseconds: (p1Exp - 30) * 1000 }), refused('owner-receipt-binding'));
});

// The pin's keyId is recomputed from its public key: a receipt that names X
// as brokerKey, correctly signed by the real key, still refuses when the pin
// claims keyId X for that real key.
test('a pin whose keyId is not its own key\'s refuses even when the receipt names that keyId', () => {
  const c = issuer.cases[0];
  const claimed = pinOf(generateKeyPairSync('ed25519').publicKey.export({ type: 'spki', format: 'der' }).toString('base64')).keyId;
  const inputs = { ...caseInputs(c), trust: { ...trust, receiptKey: { alg: 'ed25519', publicKey: brokerPin.publicKey, keyId: claimed } } };
  const token = issue({ ...c.payload, brokerKey: claimed });
  assert.throws(() => verifyOwnerDecisionReceipt(token, inputs), refused('owner-receipt-trust'));
  // With the honest pin, the same shape verifies.
  assert.equal(verifyOwnerDecisionReceipt(issue({ ...c.payload, brokerKey: brokerPin.keyId }), { ...inputs, trust: { ...trust, receiptKey: brokerPin } }).payload.brokerKey, brokerPin.keyId);
});
