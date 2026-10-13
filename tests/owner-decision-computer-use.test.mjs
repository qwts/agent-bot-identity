// `soul.computer-use.set` (agent-comms#250, first phase): the disabled action,
// codec and evidence slice. No route, wire adoption or gate adapter.
//
// tests/fixtures/owner-decisions/computer-use-candidate-v1.json is the
// agent-comms candidate fixture as merged in agent-comms
// 9158689935083269f879ad9d93604ca8caa1f2d0 (PR #263, tree 6932c2d5), copied
// byte for byte and pinned below. Its shapes are still candidates, not wire
// adoption: nothing routes to them. Of the 46 rejections its checker
// (tools/acceptance/owner-decision-computer-use-candidate-vectors.mjs)
// asserts, 45 are exercised below against this repository's own codecs, each
// asserting the codec's own error code; #23 (a duplicated wrapper field) has
// no codec here, since the broker owns the prepared wrapper, and is checked
// structurally instead.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { canonicalJson } from '../canonical-json.mjs';
import { decodeOwnerDecisionAction, ownerDecisionCanonical } from '../identity/owner-decision-action.mjs';
import {
  COMPUTER_USE_BEHAVIOR, bindEffect, bindPreparation, bindPreparedChallenge, bindReconciliationPair, challengeFor, completedRecordFor, computerUsePlan,
  decodeEffect, decodePreparation, effectOutcome, effectPlanDigest, enteredRecordFor, reconciliationFinding, refusedRecordFor,
} from '../identity/owner-decision-evidence.mjs';
import {
  DAEMON_JOURNAL_SLOTS, PAIR_LIMITS, decodeReconciliationPair, encodeDaemonJournalFrame, encodeReconciliationPair, requestDirectoryName,
} from '../identity/owner-decision-journal-frame.mjs';
import { DAEMON_RESERVATION_BYTES, createDaemonJournalStore, initializeDaemonJournal } from '../identity/owner-decision-journal-store.mjs';
import { composeOwnerDecisionPrepared, PREPARED_WRAPPER_CAP } from '../identity/owner-decision-prepared.mjs';
import { verifyOwnerDecisionReceipt } from '../identity/owner-decision-receipt.mjs';
import { linkedEventRequired, verifyLinkedEvent } from '../identity/owner-decision-linked-event.mjs';

const FIXTURE_URL = new URL('./fixtures/owner-decisions/computer-use-candidate-v1.json', import.meta.url);
const FIXTURE_SHA256 = 'ef0a77234e6d4cc57a044a7939e19518a5831c0fffae1bbb792cbba3b7b8941e';
// The vendored legacy fixtures this slice must leave untouched.
const LEGACY_FIXTURES = {
  'v1.json': '70706e7327b90f8649b0b1f8baa7b59d2e4e8f6f1f33b674dc8472cb7eb951ac',
  'issuer-v1.json': 'da8d10b7994edd275c18042a5c418eb634c1bccabc8c47a0f80d9a58bcdb7028',
  'effect-evidence-v1.json': '4363adad57e232231d2893c4e20b37b4b28048d307893d6ebf97fb01042de4b4',
};
const OP = 'soul.computer-use.set';
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const utf8 = (text) => Buffer.from(text, 'utf8');
const clone = (value) => JSON.parse(JSON.stringify(value));
const fixture = JSON.parse(fs.readFileSync(FIXTURE_URL, 'utf8'));
const budget = JSON.parse(fs.readFileSync(new URL('./fixtures/owner-decisions/journal-budget-v1.json', import.meta.url), 'utf8'));
const cap = (slot) => DAEMON_JOURNAL_SLOTS.find((entry) => entry.slot === slot).cap;
const darwin = { skip: process.platform !== 'darwin' && 'the journal lock is Darwin-only' };
const NAMES = ['disable', 'enable', 'noop-disabled'];

// One fixture vector, read through our own codecs.
function vector(name) {
  const x = fixture.vectors.find((entry) => entry.id === name);
  const actionBytes = utf8(x.action.canonicalUtf8);
  const action = JSON.parse(x.action.canonicalUtf8);
  const preparationBytes = utf8(x.preparation.canonicalUtf8);
  const preparation = decodePreparation(preparationBytes);
  const preparationDigest = sha256(preparationBytes);
  const receiptDigest = x.entered.object.receiptDigest;
  // The acceptance the preparation binds to: exactly its shared fields.
  const acceptance = Object.fromEntries(['requestId', 'principal', 'account', 'soul', 'operation', 'payloadDigest', 'acceptedAt', 'daemonKey', 'daemonEpoch', 'watchId']
    .map((key) => [key, preparation[key]]));
  return { x, actionBytes, action, preparation, preparationBytes, preparationDigest, receiptDigest, acceptance,
    expectedEnabled: preparation.expected.enabled, desiredEnabled: action.parameters.enabled };
}

// --- A. the candidate vectors, reproduced by our own derivations ---

test('the candidate fixture is pinned and labelled proposed, and the legacy fixtures are untouched', () => {
  assert.equal(sha256(fs.readFileSync(FIXTURE_URL)), FIXTURE_SHA256);
  assert.equal(fixture.schemaVersion, 1);
  assert.match(fixture.status, /^Proposed candidate vectors only/);
  for (const [file, digest] of Object.entries(LEGACY_FIXTURES)) {
    assert.equal(sha256(fs.readFileSync(new URL(`./fixtures/owner-decisions/${file}`, import.meta.url))), digest, file);
  }
  assert.deepEqual(fixture.vectors.map((entry) => entry.id), NAMES);
});

test('actions decode strictly, with the fixed summaries, exact display text and both digests', () => {
  for (const name of NAMES) {
    const { x, actionBytes } = vector(name);
    const decoded = decodeOwnerDecisionAction(actionBytes);
    assert.equal(ownerDecisionCanonical(x.action.object), x.action.canonicalUtf8, name);
    assert.equal(actionBytes.length, x.action.bytes, name);
    assert.equal(decoded.payloadDigest, x.action.payloadDigest, name);
    assert.equal(decoded.summary, x.action.displaySummary, name);
    assert.equal(decoded.actionText, x.action.actionText, name);
    assert.equal(decoded.actionDigest, x.action.actionDigest, name);
    assert.equal([...decoded.actionText].length, x.action.actionTextScalars, name);
    assert.equal(Buffer.byteLength(decoded.actionText), x.action.actionTextUtf8Bytes, name);
    // p1 binds the display digest and the challenge nonce.
    assert.equal(x.p1Binding.action, decoded.actionDigest, name);
    assert.equal(x.p1Binding.nonce, x.challenge.object.nonce, name);
  }
});

test('the preparation decodes, binds with a verified display digest, and carries no plan digest of its own', () => {
  for (const name of NAMES) {
    const { x, preparation, preparationBytes, preparationDigest, acceptance, action } = vector(name);
    assert.equal(preparationDigest, x.preparation.preparationDigest, name);
    assert.equal(preparationBytes.length, x.preparation.bytes, name);
    assert.equal(Object.hasOwn(preparation, 'effectPlanDigest'), false, name);
    assert.equal(bindPreparation(preparation, { acceptance, action }), preparation, name);
  }
});

test('the plan and challenge are derived from the preparation and action alone, and match byte for byte', () => {
  for (const name of NAMES) {
    const { x, preparation, action, actionBytes } = vector(name);
    const plan = computerUsePlan(preparation, action);
    assert.equal(ownerDecisionCanonical(plan), x.plan.canonicalUtf8, name);
    assert.equal(effectPlanDigest(plan), x.plan.effectPlanDigest, name);
    assert.deepEqual(plan.behavior, { ...COMPUTER_USE_BEHAVIOR }, name);
    const challenge = challengeFor(preparation, actionBytes);
    assert.equal(challenge.toString('utf8'), x.challenge.canonicalUtf8, name);
    assert.equal(sha256(challenge), x.challenge.challengeDigest, name);
    assert.equal(JSON.parse(challenge).effectPlanDigest, x.plan.effectPlanDigest, name);
    // The wrapper embeds the challenge verbatim, with no duplicate plan field.
    assert.equal(canonicalJson({ challenge: JSON.parse(challenge), stage: null, v: 1 }), x.preparedWrapper.canonicalUtf8, name);
    assert.deepEqual([...x.preparedWrapper.keys].sort(), ['challenge', 'stage', 'v'], name);
    // d1 is unchanged: it binds the challenge by its existing fields and nonce.
    const d1 = x.d1Payload.object;
    assert.equal(Object.hasOwn(d1, 'effectPlanDigest'), false, name);
    for (const key of ['requestId', 'principal', 'account', 'soul', 'operation', 'payloadDigest', 'nonce']) assert.equal(d1[key], JSON.parse(challenge)[key], `${name} ${key}`);
  }
});

const NAMESPACE = 'a'.repeat(64);
function acceptanceFor(p, operation, payloadDigest) {
  return utf8(canonicalJson({ v: 1, kind: 'acceptance', requestId: p.requestId, principal: p.principal, account: p.account, soul: p.soul, operation,
    payloadDigest, namespaceDigest: NAMESPACE, acceptedAt: p.acceptedAt, daemonKey: p.daemonKey, daemonEpoch: p.daemonEpoch, watchId: p.watchId,
    reservationBytes: DAEMON_RESERVATION_BYTES }));
}

test('the composed prepared response builds the identical challenge, only with the captured expected boolean', () => {
  for (const name of NAMES) {
    const { x, preparation, actionBytes } = vector(name);
    const compose = (extra) => composeOwnerDecisionPrepared({ actionBytes, acceptanceBytes: acceptanceFor(preparation, OP, preparation.payloadDigest),
      namespaceDigest: NAMESPACE, nonce: preparation.nonce, preparedAt: preparation.preparedAt, now: preparation.preparedAt, ...extra });
    const prepared = compose({ expected: preparation.expected });
    assert.equal(prepared.challengeBytes.toString('utf8'), x.challenge.canonicalUtf8, name);
    assert.deepEqual(Object.keys({ challenge: prepared.challenge, stage: prepared.stage, v: 1 }).sort(), ['challenge', 'stage', 'v']);
    for (const expected of [null, undefined, { kind: 'computer-use' }, { kind: 'computer-use', enabled: 'true' }, { kind: 'cold-wake', enabled: true },
      { kind: 'computer-use', enabled: true, extra: 1 }]) {
      assert.throws(() => compose({ expected }), (error) => error.reason === 'owner-prepare-expected', `${name} ${JSON.stringify(expected)}`);
    }
  }
  // Every other operation takes no expected state, and its challenge gains no plan digest.
  const { preparation } = vector('disable');
  const coldAction = utf8(ownerDecisionCanonical({ v: 1, requestId: preparation.requestId, principal: preparation.principal, account: preparation.account,
    soul: preparation.soul, operation: 'cold-wake.set', parameters: { mode: 'on' } }));
  const composeCold = (expected) => composeOwnerDecisionPrepared({ actionBytes: coldAction, acceptanceBytes: acceptanceFor(preparation, 'cold-wake.set', sha256(coldAction)),
    namespaceDigest: NAMESPACE, nonce: preparation.nonce, preparedAt: preparation.preparedAt, now: preparation.preparedAt, expected });
  assert.equal(Object.hasOwn(composeCold(null).challenge, 'effectPlanDigest'), false);
  assert.throws(() => composeCold({ kind: 'computer-use', enabled: true }), (error) => error.reason === 'owner-prepare-expected');
});

test('entered and completed derive exactly the candidate records, and completed is applied with its exact digest', () => {
  for (const name of NAMES) {
    const { x, preparation, preparationDigest, receiptDigest, action, expectedEnabled, desiredEnabled } = vector(name);
    const entered = enteredRecordFor({ preparation, preparationDigest, receiptDigest, action, at: x.entered.object.at });
    assert.equal(canonicalJson(entered), x.entered.canonicalUtf8, name);
    assert.equal(sha256(utf8(x.entered.canonicalUtf8)), x.entered.digest, name);
    assert.deepEqual(entered.detail, { kind: 'computer-use', beforeEnabled: expectedEnabled, afterEnabled: desiredEnabled }, name);
    bindEffect(decodeEffect(utf8(x.entered.canonicalUtf8)), { phase: 'entered', preparation, preparationDigest, receiptDigest, action });
    const completed = completedRecordFor({ entered, action, at: x.completed.object.at });
    assert.equal(canonicalJson(completed), x.completed.canonicalUtf8, name);
    bindEffect(decodeEffect(utf8(x.completed.canonicalUtf8)), { phase: 'completed', preparation, preparationDigest, receiptDigest, action, entered });
    assert.deepEqual(effectOutcome(utf8(x.completed.canonicalUtf8)), { state: 'applied', outcome: { code: 'applied', effectDigest: x.completed.effectDigest } }, name);
    // A no-op still enters and completes, with equal before and after.
    if (name === 'noop-disabled') assert.equal(completed.detail.beforeEnabled, completed.detail.afterEnabled);
  }
});

test('pre-effect refusals use the existing reason vocabulary and map to the candidate outcomes', () => {
  for (const name of NAMES) {
    const { x, preparation, preparationDigest } = vector(name);
    for (const refusal of x.refusals) {
      const record = refusedRecordFor({ preparation, preparationDigest, receiptDigest: refusal.record.receiptDigest, code: refusal.record.detail.code, at: refusal.record.at });
      assert.equal(canonicalJson(record), refusal.canonicalUtf8, `${name} ${refusal.domain}`);
      bindEffect(decodeEffect(utf8(refusal.canonicalUtf8)), { phase: 'refused', preparation, preparationDigest, receiptDigest: refusal.record.receiptDigest });
      assert.deepEqual(effectOutcome(utf8(refusal.canonicalUtf8)).outcome, { code: refusal.publicOutcome, effectDigest: refusal.effectDigest }, `${name} ${refusal.domain}`);
    }
    assert.deepEqual(x.refusals.map((r) => [r.domain, r.record.detail.code]), [['stale-expected-state', 'expected-state-changed'],
      ['soul-not-found', 'target-unavailable'], ['invalid-request', 'validation-failed'], ['pre-effect-io-durable-refusal', 'storage-unavailable']]);
  }
});

// The binding context of one vector's reconciliation pairs.
function recContext(v, finding) {
  const basis = finding === 'applied' ? utf8(v.x.completed.canonicalUtf8)
    : finding === 'refused' ? utf8(v.x.refusals.find((r) => r.effectDigest === v.x.reconciliation.refusedPairWithRetainedRefusal.basisDigest).canonicalUtf8) : null;
  return { finding, acceptance: v.acceptance, action: v.action, preparation: v.preparation, basisBytes: basis,
    preparationDigest: v.preparationDigest, receiptDigest: v.receiptDigest };
}

test('reconciliation: indeterminate observations, and applied or refused only from the exact retained record', () => {
  for (const name of NAMES) {
    const v = vector(name), r = v.x.reconciliation;
    for (const [key, slot, finding] of [['indeterminatePair', 'observation-pair', 'indeterminate'], ['appliedPairWithRetainedCompletion', 'terminal-pair', 'applied'],
      ['refusedPairWithRetainedRefusal', 'terminal-pair', 'refused']]) {
      const pair = decodeReconciliationPair(utf8(r[key].canonicalUtf8), { slot, requestId: v.preparation.requestId });
      bindReconciliationPair(pair, recContext(v, finding));
      assert.equal(pair.record.observedDigest, sha256(utf8(canonicalJson(pair.preimage))), `${name} ${key}`);
      if (finding !== 'indeterminate') assert.equal(pair.record.basisDigest, r[key].basisDigest, `${name} ${key}`);
    }
  }
  // Applied needs the retained completion and an observation of its result; a
  // matching current boolean alone, or no completion, is never applied.
  const base = { operation: OP, ownerCeremony: true, entered: true, durablePreEffectRefusal: false, linkedEvent: false };
  assert.equal(reconciliationFinding({ ...base, completed: true, matchingState: true }), 'applied');
  assert.equal(reconciliationFinding({ ...base, completed: false, matchingState: true }), 'indeterminate');
  assert.equal(reconciliationFinding({ ...base, completed: true, matchingState: false }), 'indeterminate');
  assert.equal(reconciliationFinding({ ...base, completed: true, ownerCeremony: false, matchingState: true }), 'indeterminate');
  assert.equal(reconciliationFinding({ ...base, entered: false, completed: false, durablePreEffectRefusal: true, matchingState: false }), 'refused');
});

test('computer use has no linked event', () => {
  assert.equal(linkedEventRequired(OP), false);
  assert.throws(() => verifyLinkedEvent(Buffer.from('{}'), { operation: OP, journalBytes: Buffer.from('{}'), linkage: {} }));
});

// --- B. the candidate checker's 46 rejections, against our own codecs ---

// Each case must be refused by the named codec with its own error code (and
// reason, where the codec gives a specific one); any other throw fails it.
const ACTION = { code: 'invalid-owner-decision' };
const EVIDENCE = { code: 'invalid-owner-decision-evidence' };
const BINDING = { code: 'invalid-owner-decision-evidence', reason: 'owner-evidence-binding' };
const FRAME = { code: 'invalid-owner-journal-frame' };
const RECEIPT = { code: 'receipt-invalid' };
let rejections = 0;
const rejects = (run, label, expected) => {
  assert.throws(run, (error) => {
    assert.equal(error?.code, expected.code, `${label}: refused by the wrong code (${error?.code ?? error?.name}: ${error?.message})`);
    if (expected.reason) assert.equal(error.reason, expected.reason, `${label}: reason`);
    return true;
  }, label);
  rejections += 1;
};

test('checker rejections 1-11: action mutations refuse in the strict action decoder', () => {
  const valid = vector('disable').x.action.object;
  for (const [label, mutate] of [
    ['parameters absent', (a) => { delete a.parameters; }],
    ['enabled absent', (a) => { delete a.parameters.enabled; }],
    ['enabled null', (a) => { a.parameters.enabled = null; }],
    ['enabled string', (a) => { a.parameters.enabled = 'false'; }],
    ['enabled number', (a) => { a.parameters.enabled = 0; }],
    ['extra action parameter', (a) => { a.parameters.extra = false; }],
    ['operation cold-wake with an enabled parameter', (a) => { a.operation = 'cold-wake.set'; }],
    ['extra envelope field with a changed soul', (a) => { a.soul = 'agent_00000000-0000-4000-8000-000000000002'; a.payloadDigest = '0'.repeat(64); }],
    ['malformed principal', (a) => { a.principal = 'principal_0000000-0000-4000-8000-000000000002'; }],
    ['request ID not version 4', (a) => { a.requestId = '00000000-0000-1000-8000-000000000001'; }],
    ['soul ID version out of range', (a) => { a.soul = 'agent_00000000-0000-9000-8000-000000000002'; }],
  ]) {
    const bad = clone(valid); mutate(bad);
    rejects(() => decodeOwnerDecisionAction(utf8(ownerDecisionCanonical(bad))), label, ACTION);
  }
});

// The journal holds slot 3 only if it equals what challengeFor recomputes from
// slots 6 and 2: bindPreparedChallenge is that codec, the same check the
// store makes on every read (the store tests below drive the store itself).
const slot3 = (challengeBytes, { preparation, actionBytes }) => bindPreparedChallenge(challengeBytes, preparation, actionBytes);

test('checker rejections 12-15: challenge mutations never match the derived challenge', () => {
  const v = vector('disable'), valid = v.x.challenge.object;
  slot3(utf8(canonicalJson(valid)), v);
  for (const [label, mutate] of [
    ['conditional effectPlanDigest absent', (c) => { delete c.effectPlanDigest; }],
    ['conditional effectPlanDigest malformed', (c) => { c.effectPlanDigest = 'F'.repeat(64); }],
    ['extra challenge field', (c) => { c.extra = 'reject'; }],
    ['conditional effectPlanDigest on a legacy operation', (c) => { c.operation = 'cold-wake.set'; }],
  ]) {
    const bad = clone(valid); mutate(bad);
    rejects(() => slot3(utf8(canonicalJson(bad)), v), label, BINDING);
  }
});

test('checker rejections 16-18: a changed target with retained digests, a tampered payload digest, and changed display text refuse', () => {
  const v = vector('disable');
  // 16: the target changed, the preparation's digests kept.
  const changedTarget = { ...v.action, soul: 'agent_00000000-0000-4000-8000-000000000009' };
  rejects(() => bindPreparation(v.preparation, { acceptance: v.acceptance, action: changedTarget }), 'changed target with retained digests', BINDING);
  // 17: a challenge with a tampered payload digest.
  rejects(() => slot3(utf8(canonicalJson({ ...v.x.challenge.object, payloadDigest: 'g'.repeat(64) })), v), 'tampered payloadDigest', BINDING);
  // 18: display text changed while the preparation keeps a digest of it.
  const badText = v.x.action.actionText.replace('enabled=false', 'enabled=true');
  rejects(() => bindPreparation({ ...v.preparation, actionDigest: sha256(utf8(badText)) }, { acceptance: v.acceptance, action: v.action }), 'changed display text', BINDING);
});

test('checker rejections 19-22: non-canonical encodings refuse in every decoder', () => {
  for (const [label, bytes] of [['duplicate key', utf8('{"a":1,"a":1}')], ['whitespace', utf8('{ "a":1}')], ['invalid UTF-8', Uint8Array.from([0xff, 0xfe])],
    ['oversized', Buffer.alloc(32769, 0x20)]]) {
    rejects(() => decodeOwnerDecisionAction(bytes), label, { ...ACTION, reason: 'owner-action-encoding' });
    // The same bytes refuse in the preparation and effect decoders too.
    assert.throws(() => decodePreparation(bytes), (error) => error.code === EVIDENCE.code, `preparation ${label}`);
    assert.throws(() => decodeEffect(bytes), (error) => error.code === EVIDENCE.code, `effect ${label}`);
  }
});

// #23 is structural, not counted among the coded rejections: the broker owns
// the prepared wrapper and this repository has no codec for it, so it checks
// that the composed wrapper is exactly {challenge, stage, v} and that one with a
// duplicated plan digest is not it.
test('checker case 23: a plan digest duplicated at the prepared-wrapper top level is never the composed wrapper', () => {
  const v = vector('disable');
  const prepared = composeOwnerDecisionPrepared({ actionBytes: v.actionBytes, acceptanceBytes: acceptanceFor(v.preparation, OP, v.preparation.payloadDigest),
    namespaceDigest: NAMESPACE, nonce: v.preparation.nonce, preparedAt: v.preparation.preparedAt, now: v.preparation.preparedAt, expected: v.preparation.expected });
  const wrapper = canonicalJson({ challenge: prepared.challenge, stage: prepared.stage, v: 1 });
  assert.equal(wrapper, v.x.preparedWrapper.canonicalUtf8);
  assert.deepEqual(Object.keys(JSON.parse(wrapper)).sort(), ['challenge', 'stage', 'v']);
  const duplicate = canonicalJson({ ...JSON.parse(wrapper), effectPlanDigest: prepared.challenge.effectPlanDigest });
  assert.notEqual(duplicate, wrapper);
});

// A d1 receipt over the candidate payload, signed with test-only keys made
// here, so verifyOwnerDecisionReceipt can run against the computer-use challenge.
function d1Harness() {
  const v = vector('disable');
  const pin = (publicKey) => {
    const der = publicKey.export({ type: 'spki', format: 'der' });
    return { alg: 'ed25519', publicKey: der.subarray(12).toString('base64url'), keyId: sha256(der) };
  };
  const broker = generateKeyPairSync('ed25519'), presence = generateKeyPairSync('ed25519');
  const trust = { receiptKey: pin(broker.publicKey), presenceKey: pin(presence.publicKey) };
  const challenge = JSON.parse(v.x.challenge.canonicalUtf8);
  const iat = challenge.preparedAt, exp = iat + 60;
  const presenceToken = `p1.${utf8(JSON.stringify({ exp: exp + 60 })).toString('base64url')}.signature`;
  const token = (payload) => {
    const segment = (typeof payload === 'string' ? utf8(payload) : utf8(canonicalJson(payload))).toString('base64url');
    return `d1.${segment}.${sign(null, Buffer.from(segment, 'ascii'), broker.privateKey).toString('base64url')}`;
  };
  const payload = { ...v.x.d1Payload.object, brokerKey: trust.receiptKey.keyId, presenceKey: trust.presenceKey.keyId,
    presenceDigest: sha256(Buffer.from(presenceToken, 'ascii')), iat, exp, daemonKey: undefined };
  delete payload.daemonKey;
  const verify = (receiptToken) => verifyOwnerDecisionReceipt(receiptToken, { trust, daemonKey: challenge.daemonKey,
    challengeBytes: utf8(v.x.challenge.canonicalUtf8), presenceToken, nowMilliseconds: iat * 1000 });
  return { v, payload, token, verify };
}

test('checker rejection 24: a d1 whose nonce differs from the computer-use challenge refuses', () => {
  const h = d1Harness();
  assert.equal(h.verify(h.token(h.payload)).payload.nonce, h.v.x.challenge.object.nonce, 'the candidate d1 binds the challenge');
  // The checker's exact mutation: 'B'×43 isn't canonical unpadded base64url
  // (its trailing bits aren't zero), so the receipt decoder refuses it as
  // malformed before any binding.
  rejects(() => h.verify(h.token({ ...h.payload, nonce: 'B'.repeat(43) })), 'changed nonce in d1 payload', { ...RECEIPT, reason: 'owner-receipt-invalid' });
  // A well-formed but different nonce reaches the binding and refuses there.
  assert.throws(() => h.verify(h.token({ ...h.payload, nonce: Buffer.alloc(32, 1).toString('base64url') })),
    (error) => error.code === RECEIPT.code && error.reason === 'owner-receipt-binding');
});

test('checker rejection 25: an applied pair with no retained completion (the current boolean as proof) refuses', () => {
  const v = vector('disable');
  const pair = clone(v.x.reconciliation.indeterminatePair.object);
  pair.record.finding = 'applied'; pair.record.basisDigest = null;
  rejects(() => {
    const bytes = encodeReconciliationPair(pair, { slot: 'terminal-pair', requestId: pair.record.requestId });
    bindReconciliationPair(decodeReconciliationPair(bytes, { slot: 'terminal-pair', requestId: pair.record.requestId }), { ...recContext(v, 'applied'), basisBytes: null });
  }, 'applied without retained completed proof', FRAME);
});

test('checker rejections 26-30: a foreign completed proof, with a recomputed basis digest, refuses', () => {
  const v = vector('disable'), applied = v.x.reconciliation.appliedPairWithRetainedCompletion.object, completed = v.x.completed.object;
  bindReconciliationPair(clone(applied), recContext(v, 'applied'));
  for (const [field, value] of [['requestId', '00000000-0000-4000-8000-000000000999'], ['preparationDigest', '0'.repeat(64)], ['receiptDigest', '0'.repeat(64)],
    ['effectId', '00000000-0000-4000-8000-000000000999'], ['phase', 'entered']]) {
    const foreign = utf8(canonicalJson({ ...completed, [field]: value }));
    const pair = clone(applied); pair.record.basisDigest = sha256(foreign);
    rejects(() => bindReconciliationPair(pair, { ...recContext(v, 'applied'), basisBytes: foreign }), `foreign proof ${field}`, BINDING);
  }
});

test('checker rejections 31-45: retained bytes that are not canonical, absent or null refuse in each decoder', () => {
  const v = vector('disable'), h = d1Harness();
  const applied = v.x.reconciliation.appliedPairWithRetainedCompletion;
  // Retained bytes are given as text; absent and null go to the decoder raw,
  // so the decoder itself must refuse them.
  const raw = (text) => (text === undefined || text === null ? text : utf8(text));
  const decoders = {
    d1: [(text) => h.verify(text === undefined || text === null ? text : h.token(text)), RECEIPT],
    preparation: [(text) => decodePreparation(raw(text)), EVIDENCE],
    entered: [(text) => decodeEffect(raw(text)), EVIDENCE],
    completed: [(text) => decodeEffect(raw(text)), EVIDENCE],
    reconciliation: [(text) => decodeReconciliationPair(raw(text), { slot: 'terminal-pair', requestId: applied.object.record.requestId }), FRAME],
  };
  // Each decoder accepts its retained canonical bytes.
  decoders.d1[0](canonicalJson(h.payload));
  decoders.preparation[0](v.x.preparation.canonicalUtf8);
  decoders.entered[0](v.x.entered.canonicalUtf8);
  decoders.completed[0](v.x.completed.canonicalUtf8);
  decoders.reconciliation[0](applied.canonicalUtf8);
  for (const [name, [decode, expected]] of Object.entries(decoders)) {
    rejects(() => decode('not canonical bytes'), `${name} not canonical`, expected);
    rejects(() => decode(undefined), `${name} absent`, expected);
    rejects(() => decode(null), `${name} null`, expected);
  }
});

test('checker rejection 46: a completed proof in the wrong state refuses, even when self-consistent', () => {
  const v = vector('disable'), applied = v.x.reconciliation.appliedPairWithRetainedCompletion.object;
  const wrongCompleted = utf8(canonicalJson({ ...v.x.completed.object, detail: { ...v.x.completed.object.detail, beforeEnabled: false } }));
  const pair = clone(applied); pair.record.basisDigest = sha256(wrongCompleted);
  rejects(() => bindReconciliationPair(pair, { ...recContext(v, 'applied'), basisBytes: wrongCompleted }), 'wrong-state completed proof', BINDING);
});

test('all 45 coded checker rejections ran (the 46th, #23, is structural)', () => {
  assert.equal(rejections, 45);
});

// Rejections beyond the checker's: the expected union, the effect detail and
// the reconciliation preimage refuse every other shape.
test('the expected variant, the preparation union and the effect detail refuse every other shape', () => {
  const { x, preparation, preparationDigest, receiptDigest, acceptance, action } = vector('disable');
  const encode = (value) => utf8(canonicalJson(value));
  for (const expected of [{ kind: 'computer-use' }, { kind: 'computer-use', enabled: 'true' }, { kind: 'computer-use', enabled: null },
    { kind: 'computer-use', enabled: true, extra: 1 }, { kind: 'cold-wake', enabled: true }, { enabled: true }]) {
    assert.throws(() => decodePreparation(encode({ ...preparation, expected })), undefined, JSON.stringify(expected));
  }
  assert.throws(() => decodePreparation(encode({ ...preparation, effectPlanDigest: x.plan.effectPlanDigest })));
  assert.throws(() => bindPreparation({ ...preparation, actionDigest: sha256(utf8(x.action.canonicalUtf8)) }, { acceptance, action }), undefined,
    'a display digest of the canonical bytes');
  assert.throws(() => bindPreparation({ ...preparation, stage: { stagingId: '00000000-0000-4000-8000-000000000001', kind: 'package', contentDigest: 'a'.repeat(64), expiresAt: 1 } },
    { acceptance, action }));
  const e = x.entered.object;
  for (const detail of [{ ...e.detail, extra: 1 }, { ...e.detail, beforeEnabled: 'true' }, { kind: 'computer-use', beforeEnabled: true }, { ...e.detail, kind: 'cold-wake' }]) {
    assert.throws(() => decodeEffect(encode({ ...e, detail })), undefined, JSON.stringify(detail));
  }
  for (const detail of [{ ...e.detail, beforeEnabled: !e.detail.beforeEnabled }, { ...e.detail, afterEnabled: !e.detail.afterEnabled }]) {
    assert.throws(() => bindEffect(decodeEffect(encode({ ...e, detail })), { phase: 'entered', preparation, preparationDigest, receiptDigest, action }),
      (error) => error.reason === 'owner-evidence-binding');
  }
  // An applied pair whose observation isn't the completed result refuses.
  const v = vector('disable'), pair = clone(v.x.reconciliation.appliedPairWithRetainedCompletion.object);
  pair.preimage.enabled = !pair.preimage.enabled; pair.record.observedDigest = sha256(encode(pair.preimage));
  assert.throws(() => bindReconciliationPair(pair, recContext(v, 'applied')), (error) => error.reason === 'owner-evidence-binding');
  // Preimages are typed by operation.
  const indeterminate = v.x.reconciliation.indeterminatePair.object;
  assert.throws(() => bindReconciliationPair(indeterminate, { ...recContext(v, 'indeterminate'), acceptance: { ...v.acceptance, operation: 'cold-wake.set' } }));
  for (const preimage of [{ v: 1, kind: 'computer-use' }, { v: 1, kind: 'computer-use', enabled: 'false' }, { v: 2, kind: 'computer-use', enabled: false },
    { v: 1, kind: 'computer-use', enabled: false, extra: 1 }]) {
    const bad = { ...indeterminate, preimage, record: { ...indeterminate.record, observedDigest: sha256(encode(preimage)) } };
    assert.throws(() => encodeReconciliationPair(bad, { slot: 'observation-pair', requestId: indeterminate.record.requestId }), undefined, JSON.stringify(preimage));
  }
});

test('legacy operations: challenges stay byte-identical and never gain effectPlanDigest', () => {
  const v1 = JSON.parse(fs.readFileSync(new URL('./fixtures/owner-decisions/effect-evidence-v1.json', import.meta.url), 'utf8'));
  let checked = 0;
  for (const entry of v1.records.filter((record) => record.id.endsWith('-preparation'))) {
    const p = entry.record;
    const action = utf8(canonicalJson({ v: 1, requestId: p.requestId, principal: p.principal, account: p.account, soul: p.soul, operation: p.operation, parameters: {} }));
    const legacy = utf8(canonicalJson({ requestId: p.requestId, principal: p.principal, account: p.account, soul: p.soul, operation: p.operation,
      payloadDigest: p.payloadDigest, action: action.toString('base64url'), nonce: p.nonce, acceptedAt: p.acceptedAt, preparedAt: p.preparedAt,
      exp: p.exp, daemonKey: p.daemonKey, daemonEpoch: p.daemonEpoch, watchId: p.watchId }));
    const now = challengeFor(p, action);
    assert.equal(now.equals(legacy), true, entry.id);
    assert.equal(Object.hasOwn(JSON.parse(now), 'effectPlanDigest'), false, entry.id);
    checked += 1;
  }
  assert.ok(checked >= 5, 'every legacy operation family is covered');
});

// --- C. the store: the plan recomputed and byte-compared at every boundary ---

const PRE_ENTRY = ['preparation', 'prepared-challenge', 'presence', 'receipt', 'successful-check'];

function journal(t, name, { challenge, preparationBytes, upTo = 'successful-check' } = {}) {
  const v = vector(name), p = v.preparation;
  const receipt = utf8('d1.payload.signature'), receiptDigest = sha256(receipt);
  const slots = {
    preparation: preparationBytes ?? v.preparationBytes,
    'prepared-challenge': challenge ?? challengeFor(p, v.actionBytes),
    presence: utf8('p1.payload.signature'), receipt,
    'successful-check': utf8(canonicalJson({ requestId: p.requestId, payloadDigest: p.payloadDigest, receiptDigest, daemonKey: p.daemonKey,
      daemonEpoch: p.daemonEpoch, watchId: p.watchId, state: 'released', mayApply: true, exp: p.acceptedAt + 60 })),
  };
  const base = fs.realpathSync(fs.mkdtempSync(path.join(tmpdir(), 'owner-computer-use-')));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const root = path.join(base, 'journal');
  initializeDaemonJournal(root);
  const open = () => createDaemonJournalStore({ root, namespaceDigest: NAMESPACE });
  open().admit(v.actionBytes, acceptanceFor(p, OP, p.payloadDigest));
  const dir = path.join(root, 'requests', requestDirectoryName({ namespaceDigest: NAMESPACE, requestId: p.requestId }));
  const write = (slot, payload) => fs.writeFileSync(path.join(dir, `${slot}.record`), encodeDaemonJournalFrame(payload, { namespaceDigest: NAMESPACE, requestId: p.requestId, slot }));
  for (const slot of PRE_ENTRY.slice(0, PRE_ENTRY.indexOf(upTo) + 1)) write(slot, slots[slot]);
  return { v, open, write, receiptDigest, requestId: p.requestId };
}

// The challenge variants a writer could produce, none of them the derived one.
function challengeVariants(challengeBytes) {
  const c = JSON.parse(challengeBytes);
  const { effectPlanDigest: digest, ...without } = c;
  return {
    absent: without, extra: { ...c, extra: 1 }, short: { ...c, effectPlanDigest: digest.slice(1) }, upper: { ...c, effectPlanDigest: digest.toUpperCase() },
    other: { ...c, effectPlanDigest: 'f'.repeat(64) }, legacyOperation: { ...c, operation: 'cold-wake.set' }, payload: { ...c, payloadDigest: 'e'.repeat(64) },
  };
}

test('store: a computer-use request enters, completes record-only with no linked event, and recovers as applied with its digest', darwin, (t) => {
  for (const name of NAMES) {
    const j = journal(t, name);
    const store = j.open();
    const entered = store.enterEffect(j.requestId, () => ({ at: 1_900_000_001 }));
    assert.equal(entered.state, 'entered', name);
    assert.equal(j.open().recover(j.requestId).state, 'indeterminate', `${name}: entered alone is uncertain`);
    const done = store.completeEffect(entered.entry, { at: 1_900_000_002 });
    assert.equal(done.state, 'applied', name);
    const expected = completedRecordFor({ entered: enteredRecordFor({ preparation: j.v.preparation, preparationDigest: j.v.preparationDigest, receiptDigest: j.receiptDigest,
      action: j.v.action, at: 1_900_000_001 }), action: j.v.action, at: 1_900_000_002 });
    assert.equal(done.completedDigest, sha256(utf8(canonicalJson(expected))), name);
    assert.deepEqual(j.open().recover(j.requestId).outcome, { code: 'applied', effectDigest: done.completedDigest }, name);
    j.write('linked-authoritative-event', utf8('{"schemaVersion":1}\n'));
    assert.equal(j.open().recover(j.requestId).state, 'indeterminate', `${name}: a linked event makes it uncertain`);
  }
});

test('store: a challenge whose plan diverges refuses at every boundary before entry, and makes an entered request uncertain', darwin, (t) => {
  const { preparation, actionBytes } = vector('disable');
  const variants = challengeVariants(challengeFor(preparation, actionBytes));
  for (const upTo of ['prepared-challenge', 'receipt', 'successful-check']) {
    for (const [label, variant] of Object.entries(variants)) {
      const j = journal(t, 'disable', { challenge: utf8(canonicalJson(variant)), upTo });
      assert.throws(() => j.open().recover(j.requestId), undefined, `${upTo} ${label}`);
      if (upTo === 'successful-check') assert.throws(() => j.open().enterEffect(j.requestId, () => ({ at: 1_900_000_001 })), undefined, `entry ${label}`);
    }
  }
  for (const [label, variant] of Object.entries(variants)) {
    const j = journal(t, 'disable');
    const store = j.open();
    const entered = store.enterEffect(j.requestId, () => ({ at: 1_900_000_001 }));
    j.write('prepared-challenge', utf8(canonicalJson(variant)));
    assert.throws(() => store.completeEffect(entered.entry, { at: 1_900_000_002 }), undefined, `completion ${label}`);
    assert.equal(j.open().recover(j.requestId).state, 'indeterminate', label);
  }
});

test('store: a preparation whose expected boolean or display digest differs from what the plan sealed refuses', darwin, (t) => {
  const { preparation, actionBytes } = vector('disable');
  const sealed = challengeFor(preparation, actionBytes);
  for (const changed of [{ ...preparation, expected: { kind: 'computer-use', enabled: !preparation.expected.enabled } },
    { ...preparation, actionDigest: sha256(actionBytes) }]) {
    const j = journal(t, 'disable', { challenge: sealed, preparationBytes: utf8(canonicalJson(changed)) });
    assert.throws(() => j.open().recover(j.requestId));
    assert.throws(() => j.open().enterEffect(j.requestId, () => ({ at: 1_900_000_001 })));
  }
});

// --- D. maximum width: the candidate's enumeration, through our derivations ---

test('every new record at maximum width matches the candidate maxima and fits its slot, with no reservation change', () => {
  const MAX = Number.MAX_SAFE_INTEGER, D = 'f'.repeat(64), U = 'ffffffff-ffff-4fff-bfff-ffffffffffff';
  const ids = { requestId: U, principal: 'principal_ffffffff-ffff-ffff-ffff-ffffffffffff', account: 'A'.repeat(64), soul: 'agent_ffffffff-ffff-4fff-bfff-ffffffffffff' };
  const codes = fixture.limits.maximumWidthCoverage.refusalCodes, findings = fixture.limits.maximumWidthCoverage.findings;
  const max = {};
  const grow = (key, bytes) => { max[key] = Math.max(max[key] ?? 0, bytes); };
  let combinations = 0, refusalCases = 0, pairCases = 0;
  for (const desiredEnabled of [false, true]) {
    for (const expectedEnabled of [false, true]) {
      const actionBytes = utf8(ownerDecisionCanonical({ v: 1, ...ids, operation: OP, parameters: { enabled: desiredEnabled } }));
      const decoded = decodeOwnerDecisionAction(actionBytes);
      const preparation = { v: 2, kind: 'preparation', ...ids, operation: OP, payloadDigest: decoded.payloadDigest, effectId: U, actionDigest: decoded.actionDigest,
        nonce: 'A'.repeat(43), acceptedAt: MAX - 180, preparedAt: MAX - 180, exp: MAX, daemonKey: D, daemonEpoch: MAX, watchId: U, stage: null,
        expected: { kind: 'computer-use', enabled: expectedEnabled }, trustVersion: 1023 };
      const preparationBytes = utf8(canonicalJson(preparation));
      assert.deepEqual(decodePreparation(preparationBytes), preparation);
      const preparationDigest = sha256(preparationBytes), action = JSON.parse(actionBytes);
      const challenge = challengeFor(preparation, actionBytes);
      const { effectPlanDigest: ignored, ...legacy } = JSON.parse(challenge);
      grow('action', actionBytes.length);
      grow('displayTextBytes', Buffer.byteLength(decoded.actionText));
      grow('displayTextScalars', [...decoded.actionText].length);
      grow('preparation', preparationBytes.length);
      grow('challenge', challenge.length);
      grow('challengeWithoutPlanDigest', Buffer.byteLength(canonicalJson(legacy)));
      grow('preparedWrapper', Buffer.byteLength(canonicalJson({ challenge: JSON.parse(challenge), stage: null, v: 1 })));
      const entered = enteredRecordFor({ preparation, preparationDigest, receiptDigest: D, action, at: MAX });
      const completed = completedRecordFor({ entered, action, at: MAX });
      for (const [key, record] of [['entered', entered], ['completed', completed]]) {
        const bytes = utf8(canonicalJson(record));
        decodeEffect(bytes);
        encodeDaemonJournalFrame(bytes, { namespaceDigest: NAMESPACE, requestId: U, slot: key });
        grow(key, bytes.length);
      }
      const completedDigest = sha256(utf8(canonicalJson(completed)));
      const refusedDigests = {};
      for (const code of codes) {
        const bytes = utf8(canonicalJson(refusedRecordFor({ preparation, preparationDigest, receiptDigest: D, code, at: MAX })));
        decodeEffect(bytes);
        encodeDaemonJournalFrame(bytes, { namespaceDigest: NAMESPACE, requestId: U, slot: 'pre-effect-refused' });
        refusedDigests[code] = sha256(bytes);
        grow('refused', bytes.length);
        refusalCases += 1;
      }
      for (const observed of [false, true]) {
        for (const finding of findings) {
          const preimage = { v: 1, kind: 'computer-use', enabled: observed };
          const record = { v: 1, kind: 'reconciliation', requestId: U, payloadDigest: decoded.payloadDigest, effectId: U, auditId: U, originalDaemonKey: D,
            originalDaemonEpoch: MAX, reportingDaemonKey: D, reportingDaemonEpoch: MAX, at: MAX, finding,
            basisDigest: finding === 'applied' ? completedDigest : finding === 'refused' ? refusedDigests['expected-state-changed'] : null,
            observedDigest: sha256(utf8(canonicalJson(preimage))) };
          const bytes = encodeReconciliationPair({ v: 1, preimage, record }, { slot: finding === 'indeterminate' ? 'observation-pair' : 'terminal-pair', requestId: U });
          grow('reconciliationRecord', Buffer.byteLength(canonicalJson(record)));
          grow('reconciliationPreimage', Buffer.byteLength(canonicalJson(preimage)));
          grow('reconciliationPair', bytes.length);
          pairCases += 1;
        }
      }
      combinations += 1;
    }
  }
  assert.deepEqual({ combinations, refusalCases, pairCases }, { combinations: 4, refusalCases: 32, pairCases: 24 });
  assert.deepEqual(fixture.limits.maximumWidthCoverage, { booleanCombinations: 4, refusalRecords: 32, reconciliationPairs: 24, refusalCodes: codes, findings });
  // Our derivations produce exactly the candidate's maxima.
  assert.deepEqual(max, fixture.limits.maximumWidth);
  assert.deepEqual([max.preparation, max.entered, max.completed, max.preparedWrapper, max.reconciliationPair], [900, 493, 495, 1208, 799]);
  // Each fits the existing named slot.
  const daemon = Object.fromEntries(budget.stores.daemon.slots.map((slot) => [slot.name, slot.payloadCap]));
  const broker = Object.fromEntries(budget.stores.broker.slots.map((slot) => [slot.name, slot.payloadCap]));
  assert.ok(max.action <= daemon['original-action'] && max.action <= broker['original-action']);
  assert.ok(max.challenge <= daemon['prepared-challenge'] && max.challenge <= cap('prepared-challenge'));
  assert.ok(max.preparedWrapper <= broker['prepared-challenge'] && max.preparedWrapper <= PREPARED_WRAPPER_CAP);
  assert.ok(max.preparation <= daemon.preparation && max.preparation <= cap('preparation'));
  assert.ok(max.refused <= daemon['pre-effect-refused'] && max.entered <= daemon.entered && max.completed <= daemon.completed);
  assert.ok(max.reconciliationRecord <= PAIR_LIMITS.record && max.reconciliationPreimage <= PAIR_LIMITS.preimage);
  assert.ok(max.reconciliationPair <= daemon['observation-pair'] && max.reconciliationPair <= daemon['terminal-pair'] && max.reconciliationPair <= PAIR_LIMITS.pair);
  assert.ok(max.displayTextScalars <= 400 && max.displayTextBytes <= 500);
  // No new slot, and the daemon's reservation is the budget's, unchanged.
  assert.equal(DAEMON_JOURNAL_SLOTS.length, budget.stores.daemon.slots.length);
  assert.equal(DAEMON_RESERVATION_BYTES, budget.stores.daemon.reservationBytes);
  assert.deepEqual([fixture.limits.reservationDeltas.newSlots, fixture.limits.reservationDeltas.daemonDeltaBytes, fixture.limits.reservationDeltas.brokerDeltaBytes], [0, 0, 0]);
  assert.equal(fixture.limits.reservationDeltas.daemonReservedBytes, DAEMON_RESERVATION_BYTES);
});
