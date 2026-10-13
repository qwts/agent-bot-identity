// `soul.computer-use.set` (agent-comms#250, first phase): the disabled action,
// codec and evidence slice. No route, wire adoption or gate adapter.
//
// DRAFT FIXTURE: tests/fixtures/owner-decisions/computer-use-v1-draft.json is
// the coordinator's scratch joint-conformance profile, copied byte-for-byte
// and pinned below. It is NOT adopted: every new shape in it is a proposal
// under bot/Comms joint review. Replace it with the agent-comms published
// vectors when they land, and re-pin.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { canonicalJson } from '../canonical-json.mjs';
import { decodeOwnerDecisionAction, ownerDecisionCanonical } from '../identity/owner-decision-action.mjs';
import {
  COMPUTER_USE_BEHAVIOR, EVIDENCE_CAP, bindEffect, bindPreparation, bindReconciliationPair, challengeFor, completedRecordFor, computerUsePlan,
  decodeEffect, decodePreparation, effectOutcome, effectPlanDigest, enteredRecordFor, reconciliationFinding, refusedRecordFor,
} from '../identity/owner-decision-evidence.mjs';
import {
  DAEMON_JOURNAL_SLOTS, PAIR_LIMITS, decodeReconciliationPair, encodeDaemonJournalFrame, encodeReconciliationPair, requestDirectoryName,
} from '../identity/owner-decision-journal-frame.mjs';
import { createDaemonJournalStore, initializeDaemonJournal } from '../identity/owner-decision-journal-store.mjs';
import { composeOwnerDecisionPrepared, PREPARED_WRAPPER_CAP } from '../identity/owner-decision-prepared.mjs';
import { linkedEventRequired, verifyLinkedEvent } from '../identity/owner-decision-linked-event.mjs';

const FIXTURE_URL = new URL('./fixtures/owner-decisions/computer-use-v1-draft.json', import.meta.url);
const FIXTURE_SHA256 = 'e5478342c7ec2acacc6ee0599e0ede010566aa785743ed06e169ea3fbfbccfbc';
const OP = 'soul.computer-use.set';
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const utf8 = (text) => Buffer.from(text, 'utf8');
const fixture = JSON.parse(fs.readFileSync(FIXTURE_URL, 'utf8'));
const cap = (slot) => DAEMON_JOURNAL_SLOTS.find((entry) => entry.slot === slot).cap;
const darwin = { skip: process.platform !== 'darwin' && 'the journal lock is Darwin-only' };

// One fixture vector, decoded through our own codecs.
function vector(name) {
  const x = fixture.vectors.find((entry) => entry.name === name);
  const actionBytes = utf8(x.action.canonicalUtf8);
  const action = JSON.parse(x.action.canonicalUtf8);
  const preparation = decodePreparation(utf8(x.preparationCandidate.canonicalUtf8));
  const preparationDigest = sha256(utf8(x.preparationCandidate.canonicalUtf8));
  // The acceptance the preparation binds to: exactly its shared fields.
  const acceptance = Object.fromEntries(['requestId', 'principal', 'account', 'soul', 'operation', 'payloadDigest', 'acceptedAt', 'daemonKey', 'daemonEpoch', 'watchId']
    .map((key) => [key, preparation[key]]));
  return { x, actionBytes, action, preparation, preparationDigest, acceptance };
}
const NAMES = ['disable', 'enable', 'noop-disabled'];

// --- A. the draft profile, reproduced by our own derivations ---

test('the draft fixture is pinned, labelled scratch, and the legacy fixtures it fingerprints are ours byte for byte', () => {
  assert.equal(sha256(fs.readFileSync(FIXTURE_URL)), FIXTURE_SHA256);
  assert.match(fixture.status, /^scratch joint-conformance profile/);
  for (const [file, digest] of Object.entries(fixture.existingFixtureSha256)) {
    assert.equal(sha256(fs.readFileSync(new URL(`./${file.replace(/^tests\//, '')}`, import.meta.url))), digest, file);
  }
  assert.deepEqual(fixture.vectors.map((entry) => entry.name), NAMES);
});

test('actions decode strictly, with the fixed summaries, exact display text and both digests', () => {
  for (const name of NAMES) {
    const { x, actionBytes } = vector(name);
    const decoded = decodeOwnerDecisionAction(actionBytes);
    assert.equal(ownerDecisionCanonical(x.action.object), x.action.canonicalUtf8, name);
    assert.equal(decoded.payloadDigest, x.action.payloadDigest, name);
    assert.equal(decoded.summary, x.action.displaySummary, name);
    assert.equal(decoded.actionText, x.action.actionText, name);
    assert.equal(decoded.actionDigest, x.action.actionDigest, name);
    assert.equal([...decoded.actionText].length, x.action.actionTextScalars, name);
    assert.equal(Buffer.byteLength(decoded.actionText), x.action.actionTextUtf8Bytes, name);
    // p1 binds the display digest and the challenge nonce.
    assert.equal(x.p1BindingCandidate.action, decoded.actionDigest, name);
    assert.equal(x.p1BindingCandidate.nonce, x.challengeCandidate.object.nonce, name);
  }
});

test('the preparation decodes, binds with a verified display digest, and carries no plan digest of its own', () => {
  for (const name of NAMES) {
    const { x, preparation, preparationDigest, acceptance, action } = vector(name);
    assert.equal(preparationDigest, x.preparationCandidate.preparationDigest, name);
    assert.deepEqual(preparation.expected, { kind: 'computer-use', enabled: x.expectedEnabled }, name);
    assert.equal(Object.hasOwn(preparation, 'effectPlanDigest'), false, name);
    assert.equal(bindPreparation(preparation, { acceptance, action }), preparation, name);
  }
});

test('the plan and challenge are derived from the preparation and action alone, and match the profile byte for byte', () => {
  for (const name of NAMES) {
    const { x, preparation, action, actionBytes } = vector(name);
    const plan = computerUsePlan(preparation, action);
    assert.equal(ownerDecisionCanonical(plan), x.plan.canonicalUtf8, name);
    assert.equal(effectPlanDigest(plan), x.plan.effectPlanDigest, name);
    assert.deepEqual(plan.behavior, { ...COMPUTER_USE_BEHAVIOR }, name);
    const challenge = challengeFor(preparation, actionBytes);
    assert.equal(challenge.toString('utf8'), x.challengeCandidate.canonicalUtf8, name);
    assert.equal(JSON.parse(challenge).effectPlanDigest, x.plan.effectPlanDigest, name);
    // The wrapper embeds the challenge verbatim, with no duplicate plan field.
    assert.equal(canonicalJson({ challenge: JSON.parse(challenge), stage: null, v: 1 }), x.preparedWrapperCandidate.canonicalUtf8, name);
    assert.deepEqual(Object.keys(x.preparedWrapperCandidate.object).sort(), ['challenge', 'stage', 'v'], name);
    // d1 is unchanged: it binds the challenge by its existing fields and nonce.
    const d1 = x.d1PayloadCandidate.object;
    assert.equal(Object.hasOwn(d1, 'effectPlanDigest'), false, name);
    for (const key of ['requestId', 'principal', 'account', 'soul', 'operation', 'payloadDigest', 'nonce']) assert.equal(d1[key], JSON.parse(challenge)[key], `${name} ${key}`);
  }
});

test('the composed prepared response builds the identical challenge, and only with the captured expected boolean', () => {
  const namespaceDigest = 'a'.repeat(64);
  for (const name of NAMES) {
    const { x, preparation, actionBytes } = vector(name);
    const acceptanceBytes = utf8(canonicalJson({ v: 1, kind: 'acceptance', requestId: preparation.requestId, principal: preparation.principal,
      account: preparation.account, soul: preparation.soul, operation: OP, payloadDigest: preparation.payloadDigest, namespaceDigest,
      acceptedAt: preparation.acceptedAt, daemonKey: preparation.daemonKey, daemonEpoch: preparation.daemonEpoch, watchId: preparation.watchId,
      reservationBytes: 524288 }));
    const compose = (extra) => composeOwnerDecisionPrepared({ actionBytes, acceptanceBytes, namespaceDigest, nonce: preparation.nonce,
      preparedAt: preparation.preparedAt, now: preparation.preparedAt, ...extra });
    const prepared = compose({ expected: preparation.expected });
    assert.equal(prepared.challengeBytes.toString('utf8'), x.challengeCandidate.canonicalUtf8, name);
    for (const expected of [null, undefined, { kind: 'computer-use' }, { kind: 'computer-use', enabled: 'true' }, { kind: 'cold-wake', enabled: true },
      { kind: 'computer-use', enabled: true, extra: 1 }]) {
      assert.throws(() => compose({ expected }), (error) => error.reason === 'owner-prepare-expected', `${name} ${JSON.stringify(expected)}`);
    }
  }
  // Every other operation takes no expected state, and its challenge gains no plan digest.
  const { preparation } = vector('disable');
  const coldAction = utf8(ownerDecisionCanonical({ v: 1, requestId: preparation.requestId, principal: preparation.principal, account: preparation.account,
    soul: preparation.soul, operation: 'cold-wake.set', parameters: { mode: 'on' } }));
  const coldAcceptance = utf8(canonicalJson({ v: 1, kind: 'acceptance', requestId: preparation.requestId, principal: preparation.principal,
    account: preparation.account, soul: preparation.soul, operation: 'cold-wake.set', payloadDigest: sha256(coldAction), namespaceDigest,
    acceptedAt: preparation.acceptedAt, daemonKey: preparation.daemonKey, daemonEpoch: preparation.daemonEpoch, watchId: preparation.watchId,
    reservationBytes: 524288 }));
  const composeCold = (expected) => composeOwnerDecisionPrepared({ actionBytes: coldAction, acceptanceBytes: coldAcceptance, namespaceDigest,
    nonce: preparation.nonce, preparedAt: preparation.preparedAt, now: preparation.preparedAt, expected });
  assert.equal(Object.hasOwn(composeCold(null).challenge, 'effectPlanDigest'), false);
  assert.throws(() => composeCold({ kind: 'computer-use', enabled: true }), (error) => error.reason === 'owner-prepare-expected');
});

test('entered and completed derive exactly the profile records, and completed is applied with its exact digest', () => {
  for (const name of NAMES) {
    const { x, preparation, preparationDigest, action } = vector(name);
    const { entered: e, completed: c } = x.effectCandidates;
    const entered = enteredRecordFor({ preparation, preparationDigest, receiptDigest: e.object.receiptDigest, action, at: e.object.at });
    assert.equal(canonicalJson(entered), e.canonicalUtf8, name);
    assert.deepEqual(entered.detail, { kind: 'computer-use', beforeEnabled: x.expectedEnabled, afterEnabled: x.desiredEnabled }, name);
    bindEffect(decodeEffect(utf8(e.canonicalUtf8)), { phase: 'entered', preparation, preparationDigest, receiptDigest: e.object.receiptDigest, action });
    const completed = completedRecordFor({ entered, action, at: c.object.at });
    assert.equal(canonicalJson(completed), c.canonicalUtf8, name);
    bindEffect(decodeEffect(utf8(c.canonicalUtf8)), { phase: 'completed', preparation, preparationDigest, receiptDigest: e.object.receiptDigest, action, entered });
    assert.deepEqual(effectOutcome(utf8(c.canonicalUtf8)), { state: 'applied', outcome: { code: 'applied', effectDigest: c.effectDigest } }, name);
    // A no-op still enters and completes, with equal before and after.
    if (name === 'noop-disabled') assert.equal(completed.detail.beforeEnabled, completed.detail.afterEnabled);
  }
});

test('pre-effect refusals use the existing reason vocabulary and map to the profile outcomes', () => {
  for (const name of NAMES) {
    const { x, preparation, preparationDigest } = vector(name);
    for (const refusal of x.refusalCandidates) {
      const record = refusedRecordFor({ preparation, preparationDigest, receiptDigest: refusal.record.receiptDigest, code: refusal.record.detail.code, at: refusal.record.at });
      assert.equal(canonicalJson(record), refusal.canonicalUtf8, `${name} ${refusal.domain}`);
      bindEffect(decodeEffect(utf8(refusal.canonicalUtf8)), { phase: 'refused', preparation, preparationDigest, receiptDigest: refusal.record.receiptDigest });
      assert.deepEqual(effectOutcome(utf8(refusal.canonicalUtf8)).outcome, { code: refusal.publicOutcome, effectDigest: refusal.effectDigest }, `${name} ${refusal.domain}`);
    }
    assert.deepEqual(x.refusalCandidates.map((r) => [r.domain, r.record.detail.code]), [['stale-expected-state', 'expected-state-changed'],
      ['soul-not-found', 'target-unavailable'], ['invalid-request', 'validation-failed'], ['pre-effect-io-durable-refusal', 'storage-unavailable']]);
  }
});

test('reconciliation: an observation is indeterminate; applied only from the exact retained completed record', () => {
  for (const name of NAMES) {
    const { x, preparation, acceptance, action } = vector(name);
    const r = x.reconciliationCandidates, completedBytes = utf8(x.effectCandidates.completed.canonicalUtf8);
    const indeterminate = decodeReconciliationPair(utf8(r.indeterminatePair.canonicalUtf8), { slot: 'observation-pair', requestId: preparation.requestId });
    bindReconciliationPair(indeterminate, { finding: 'indeterminate', acceptance: { ...acceptance, operation: OP }, action, preparation, basisBytes: null });
    assert.equal(indeterminate.record.basisDigest, null);
    assert.equal(indeterminate.record.observedDigest, r.observation.digest);
    const applied = decodeReconciliationPair(utf8(r.appliedPairWithRetainedCompletion.canonicalUtf8), { slot: 'terminal-pair', requestId: preparation.requestId });
    bindReconciliationPair(applied, { finding: 'applied', acceptance: { ...acceptance, operation: OP }, action, preparation, basisBytes: completedBytes });
    assert.equal(applied.record.basisDigest, sha256(completedBytes));
    // Any other basis (the entered record, or no retained completion) refuses.
    assert.throws(() => bindReconciliationPair(applied, { finding: 'applied', acceptance: { ...acceptance, operation: OP }, action, preparation,
      basisBytes: utf8(x.effectCandidates.entered.canonicalUtf8) }));
    assert.throws(() => bindReconciliationPair(applied, { finding: 'applied', acceptance: { ...acceptance, operation: OP }, action, preparation, basisBytes: null }));
  }
  // The current boolean never proves an outcome: no completion is never applied,
  // and a matching or mismatching current state doesn't change a completion.
  const base = { operation: OP, ownerCeremony: true, entered: true, durablePreEffectRefusal: false, linkedEvent: false };
  assert.equal(reconciliationFinding({ ...base, completed: false, matchingState: true }), 'indeterminate');
  assert.equal(reconciliationFinding({ ...base, completed: true, matchingState: false }), 'applied');
  assert.equal(reconciliationFinding({ ...base, completed: true, ownerCeremony: false, matchingState: true }), 'indeterminate');
  assert.equal(reconciliationFinding({ ...base, entered: false, completed: false, durablePreEffectRefusal: true, matchingState: true }), 'refused');
});

test('computer use has no linked event', () => {
  assert.equal(linkedEventRequired(OP), false);
  assert.throws(() => verifyLinkedEvent(Buffer.from('{}'), { operation: OP, journalBytes: Buffer.from('{}'), linkage: {} }));
});

// --- B. strict rejection of every descriptive negative ---

const canonicalAction = (base, overrides) => utf8(ownerDecisionCanonical({ ...base, ...overrides }));

test('NEG 0: enabled absent, null, string, number, or an extra key refuses; so does a cold-wake mode under this operation', () => {
  const base = vector('disable').action;
  for (const parameters of [{}, { enabled: null }, { enabled: 'false' }, { enabled: 0 }, { enabled: 1 }, { enabled: false, extra: true },
    { enabled: [false] }, { mode: 'on' }, { mode: 'off' }, { mode: 'resume', policy: 'read-only' }, { enabled: false, mode: 'off' }]) {
    assert.throws(() => decodeOwnerDecisionAction(canonicalAction(base, { parameters })), (error) => error.code === 'invalid-owner-decision', JSON.stringify(parameters));
  }
  // And the reverse: computer use's parameter under cold-wake refuses.
  assert.throws(() => decodeOwnerDecisionAction(canonicalAction(base, { operation: 'cold-wake.set', parameters: { enabled: true } })));
  // An unknown operation still refuses.
  assert.throws(() => decodeOwnerDecisionAction(canonicalAction(base, { operation: 'soul.computer-use.toggle' })));
});

// The challenge the journal holds must equal what challengeFor recomputes, so
// any variant of it refuses. These are the variants a writer could produce.
function challengeVariants(challengeBytes) {
  const c = JSON.parse(challengeBytes);
  const { effectPlanDigest: digest, ...without } = c;
  return {
    absent: without, extra: { ...c, extra: 1 }, short: { ...c, effectPlanDigest: digest.slice(1) }, long: { ...c, effectPlanDigest: `${digest}0` },
    upper: { ...c, effectPlanDigest: digest.toUpperCase() }, other: { ...c, effectPlanDigest: 'f'.repeat(64) },
  };
}

test('NEG 1: a computer-use challenge with effectPlanDigest absent, extra, wrong-length, wrong-case or other is never the derived one', () => {
  const { preparation, actionBytes } = vector('disable');
  const derived = challengeFor(preparation, actionBytes);
  for (const [label, variant] of Object.entries(challengeVariants(derived))) {
    assert.equal(utf8(canonicalJson(variant)).equals(derived), false, label);
  }
});

test('NEG 2 and NEG 12: existing operations never gain effectPlanDigest, and their challenges are byte-identical to before', () => {
  const v1 = JSON.parse(fs.readFileSync(new URL('./fixtures/owner-decisions/effect-evidence-v1.json', import.meta.url), 'utf8'));
  let checked = 0;
  for (const entry of v1.records.filter((record) => record.id.endsWith('-preparation'))) {
    const p = entry.record;
    // The legacy challenge exactly as challengeFor wrote it before this change.
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

test('NEG 3: a changed target, account, principal, request or parameter with unchanged digests refuses to bind', () => {
  const { preparation, acceptance, action } = vector('disable');
  for (const [key, value] of [['soul', 'agent_00000000-0000-4000-8000-0000000000ff'], ['account', 'other'], ['principal', 'principal_00000000-0000-4000-8000-0000000000ff'],
    ['requestId', '00000000-0000-4000-8000-0000000000ff']]) {
    assert.throws(() => bindPreparation(preparation, { acceptance: { ...acceptance, [key]: value }, action }), (error) => error.reason === 'owner-evidence-binding', key);
    assert.throws(() => bindPreparation({ ...preparation, [key]: value }, { acceptance, action }), undefined, `preparation ${key}`);
  }
  // The action names a different value than the preparation was made for.
  assert.throws(() => bindPreparation(preparation, { acceptance, action: { ...action, parameters: { enabled: !action.parameters.enabled } } }),
    (error) => error.reason === 'owner-evidence-binding');
});

test('NEG 4, 5 and 6: tampered payload, display or plan digests, a display digest of the canonical bytes, or a changed summary refuse', () => {
  const { x, preparation, acceptance, action, actionBytes } = vector('disable');
  // The payload digest bound by the acceptance.
  assert.throws(() => bindPreparation({ ...preparation, payloadDigest: 'e'.repeat(64) }, { acceptance, action }));
  // The display digest must be of the exact display text, not anything else.
  for (const wrong of ['e'.repeat(64), sha256(actionBytes), sha256(utf8(`${x.action.actionText} `)),
    sha256(utf8(x.action.actionText.replace('current turn and authorized/running tool calls continue', 'current turn continues')))]) {
    assert.throws(() => bindPreparation({ ...preparation, actionDigest: wrong }, { acceptance, action }), (error) => error.reason === 'owner-evidence-binding', wrong);
  }
  // A plan changed in any input changes the digest the challenge carries.
  const derived = JSON.parse(challengeFor(preparation, actionBytes)).effectPlanDigest;
  for (const changed of [{ ...preparation, expected: { kind: 'computer-use', enabled: !preparation.expected.enabled } }, { ...preparation, actionDigest: 'e'.repeat(64) },
    { ...preparation, payloadDigest: 'e'.repeat(64) }]) {
    assert.notEqual(JSON.parse(challengeFor(changed, actionBytes)).effectPlanDigest, derived);
  }
});

test('the expected variant, the preparation union and the effect detail refuse every other shape', () => {
  const { x, preparation, preparationDigest, acceptance, action } = vector('disable');
  const encode = (value) => utf8(canonicalJson(value));
  for (const expected of [{ kind: 'computer-use' }, { kind: 'computer-use', enabled: 'true' }, { kind: 'computer-use', enabled: null },
    { kind: 'computer-use', enabled: true, extra: 1 }, { kind: 'cold-wake', enabled: true }, { enabled: true }]) {
    assert.throws(() => decodePreparation(encode({ ...preparation, expected })), undefined, JSON.stringify(expected));
  }
  // No top-level plan digest in a preparation, and no stage for this operation.
  assert.throws(() => decodePreparation(encode({ ...preparation, effectPlanDigest: x.plan.effectPlanDigest })));
  assert.throws(() => bindPreparation({ ...preparation, stage: { stagingId: '00000000-0000-4000-8000-000000000001', kind: 'package', contentDigest: 'a'.repeat(64), expiresAt: 1 } },
    { acceptance, action }));
  const e = JSON.parse(x.effectCandidates.entered.canonicalUtf8);
  for (const detail of [{ ...e.detail, extra: 1 }, { ...e.detail, beforeEnabled: 'true' }, { kind: 'computer-use', beforeEnabled: true },
    { ...e.detail, kind: 'cold-wake' }]) {
    assert.throws(() => decodeEffect(encode({ ...e, detail })), undefined, JSON.stringify(detail));
  }
  // Well formed, but not this transition.
  for (const detail of [{ ...e.detail, beforeEnabled: !e.detail.beforeEnabled }, { ...e.detail, afterEnabled: !e.detail.afterEnabled }]) {
    assert.throws(() => bindEffect(decodeEffect(encode({ ...e, detail })), { phase: 'entered', preparation, preparationDigest, receiptDigest: e.receiptDigest, action }),
      (error) => error.reason === 'owner-evidence-binding');
  }
  // A computer-use detail is never a cold-wake or revision effect, and the reverse.
  assert.throws(() => bindEffect(decodeEffect(encode(e)), { phase: 'entered', preparation: { ...preparation, operation: 'cold-wake.set' },
    preparationDigest, receiptDigest: e.receiptDigest, action: { ...action, operation: 'cold-wake.set' } }));
});

test('reconciliation preimages are typed by operation: a computer-use boolean only for computer use', () => {
  const { x, preparation, acceptance, action } = vector('disable');
  const pair = JSON.parse(x.reconciliationCandidates.indeterminatePair.canonicalUtf8);
  // Under a cold-wake request, a computer-use preimage refuses to bind.
  assert.throws(() => bindReconciliationPair(pair, { finding: 'indeterminate', acceptance: { ...acceptance, operation: 'cold-wake.set' }, action, preparation, basisBytes: null }));
  // Under computer use, a cold or revision preimage refuses.
  for (const preimage of [{ v: 1, setting: { mode: 'off' }, webhookDigest: null, resume: null }, { v: 1, head: null, proposal: null, working: null }]) {
    const other = { ...pair, preimage, record: { ...pair.record, observedDigest: sha256(utf8(canonicalJson(preimage))) } };
    assert.throws(() => bindReconciliationPair(other, { finding: 'indeterminate', acceptance: { ...acceptance, operation: OP }, action, preparation, basisBytes: null }));
  }
  // Malformed computer-use preimages refuse at decode.
  for (const preimage of [{ v: 1, kind: 'computer-use' }, { v: 1, kind: 'computer-use', enabled: 'false' }, { v: 2, kind: 'computer-use', enabled: false },
    { v: 1, kind: 'computer-use', enabled: false, extra: 1 }]) {
    const bad = { ...pair, preimage, record: { ...pair.record, observedDigest: sha256(utf8(canonicalJson(preimage))) } };
    assert.throws(() => encodeReconciliationPair(bad, { slot: 'observation-pair', requestId: pair.record.requestId }), undefined, JSON.stringify(preimage));
  }
});

// --- C. the store: the plan recomputed and byte-compared at every boundary ---

const PRE_ENTRY = ['preparation', 'prepared-challenge', 'presence', 'receipt', 'successful-check'];

function journal(t, name, { challenge, preparationBytes, upTo = 'successful-check' } = {}) {
  const v = vector(name), namespaceDigest = 'a'.repeat(64), p = v.preparation;
  const acceptance = utf8(canonicalJson({ v: 1, kind: 'acceptance', requestId: p.requestId, principal: p.principal, account: p.account, soul: p.soul,
    operation: OP, payloadDigest: p.payloadDigest, namespaceDigest, acceptedAt: p.acceptedAt, daemonKey: p.daemonKey, daemonEpoch: p.daemonEpoch,
    watchId: p.watchId, reservationBytes: 524288 }));
  const receipt = utf8('d1.payload.signature'), receiptDigest = sha256(receipt);
  const slots = {
    preparation: preparationBytes ?? utf8(v.x.preparationCandidate.canonicalUtf8),
    'prepared-challenge': challenge ?? challengeFor(p, v.actionBytes),
    presence: utf8('p1.payload.signature'), receipt,
    'successful-check': utf8(canonicalJson({ requestId: p.requestId, payloadDigest: p.payloadDigest, receiptDigest, daemonKey: p.daemonKey,
      daemonEpoch: p.daemonEpoch, watchId: p.watchId, state: 'released', mayApply: true, exp: p.acceptedAt + 60 })),
  };
  const base = fs.realpathSync(fs.mkdtempSync(path.join(tmpdir(), 'owner-computer-use-')));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const root = path.join(base, 'journal');
  initializeDaemonJournal(root);
  const open = () => createDaemonJournalStore({ root, namespaceDigest });
  open().admit(v.actionBytes, acceptance);
  const dir = path.join(root, 'requests', requestDirectoryName({ namespaceDigest, requestId: p.requestId }));
  const write = (slot, payload) => fs.writeFileSync(path.join(dir, `${slot}.record`), encodeDaemonJournalFrame(payload, { namespaceDigest, requestId: p.requestId, slot }));
  for (const slot of PRE_ENTRY.slice(0, PRE_ENTRY.indexOf(upTo) + 1)) write(slot, slots[slot]);
  return { v, open, write, receiptDigest, requestId: p.requestId };
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
    // A planted linked event is never part of a computer-use completion.
    j.write('linked-authoritative-event', utf8('{"schemaVersion":1}\n'));
    assert.equal(j.open().recover(j.requestId).state, 'indeterminate', `${name}: a linked event makes it uncertain`);
  }
});

test('store: a challenge whose plan diverges refuses at every boundary before entry, and makes an entered request uncertain', darwin, (t) => {
  const { preparation, actionBytes } = vector('disable');
  const variants = challengeVariants(challengeFor(preparation, actionBytes));
  // The prepared, presence/receipt and released (checked) boundaries.
  for (const upTo of ['prepared-challenge', 'receipt', 'successful-check']) {
    for (const [label, variant] of Object.entries(variants)) {
      const j = journal(t, 'disable', { challenge: utf8(canonicalJson(variant)), upTo });
      assert.throws(() => j.open().recover(j.requestId), undefined, `${upTo} ${label}`);
      if (upTo === 'successful-check') assert.throws(() => j.open().enterEffect(j.requestId, () => ({ at: 1_900_000_001 })), undefined, `entry ${label}`);
    }
  }
  // After entry: the completion boundary refuses, and recovery is uncertain.
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
  const { x, preparation, actionBytes } = vector('disable');
  const sealed = challengeFor(preparation, actionBytes);
  for (const changed of [{ ...preparation, expected: { kind: 'computer-use', enabled: !preparation.expected.enabled } },
    { ...preparation, actionDigest: sha256(actionBytes) }]) {
    const j = journal(t, 'disable', { challenge: sealed, preparationBytes: utf8(canonicalJson(changed)) });
    assert.throws(() => j.open().recover(j.requestId));
    assert.throws(() => j.open().enterEffect(j.requestId, () => ({ at: 1_900_000_001 })));
  }
  assert.equal(x.preparationCandidate.object.operation, OP);
});

// --- D. budget at maximum width, not just the samples ---

test('every new record fits its slot at maximum width', () => {
  const MAX = Number.MAX_SAFE_INTEGER;
  const account = `A${'a'.repeat(63)}`;
  const ids = { requestId: 'ffffffff-ffff-4fff-bfff-ffffffffffff', principal: 'principal_ffffffff-ffff-ffff-ffff-ffffffffffff',
    soul: 'agent_ffffffff-ffff-4fff-bfff-ffffffffffff' };
  const actionBytes = utf8(ownerDecisionCanonical({ v: 1, ...ids, account, operation: OP, parameters: { enabled: false } }));
  const decoded = decodeOwnerDecisionAction(actionBytes);
  assert.ok([...decoded.actionText].length <= 400 && Buffer.byteLength(decoded.actionText) <= 500, 'display text fits at a 64-character account');
  assert.equal([...decoded.actionText].length, 389);
  assert.ok(actionBytes.length <= cap('original-action'));
  // Every timestamp and epoch at its maximum, so every number is widest.
  const preparation = { v: 2, kind: 'preparation', ...ids, account, operation: OP, payloadDigest: decoded.payloadDigest,
    effectId: 'ffffffff-ffff-4fff-bfff-ffffffffffff', actionDigest: decoded.actionDigest, nonce: Buffer.alloc(32, 0xff).toString('base64url'),
    acceptedAt: MAX - 180, preparedAt: MAX - 180, exp: MAX, daemonKey: 'f'.repeat(64), daemonEpoch: MAX, watchId: 'ffffffff-ffff-4fff-bfff-ffffffffffff',
    stage: null, expected: { kind: 'computer-use', enabled: false }, trustVersion: 1023 };
  const preparationBytes = utf8(canonicalJson(preparation));
  assert.equal(decodePreparation(preparationBytes).expected.enabled, false);
  assert.ok(preparationBytes.length <= cap('preparation') && preparationBytes.length <= EVIDENCE_CAP, `preparation ${preparationBytes.length}`);
  const challenge = challengeFor(preparation, actionBytes);
  assert.ok(challenge.length <= cap('prepared-challenge'), `challenge ${challenge.length}`);
  assert.ok(Buffer.byteLength(canonicalJson({ challenge: JSON.parse(challenge), stage: null, v: 1 })) <= PREPARED_WRAPPER_CAP);
  const action = JSON.parse(actionBytes);
  const effect = enteredRecordFor({ preparation, preparationDigest: 'f'.repeat(64), receiptDigest: 'f'.repeat(64), action, at: MAX });
  for (const [slot, record] of [['entered', effect], ['completed', completedRecordFor({ entered: effect, action, at: MAX })],
    ['pre-effect-refused', refusedRecordFor({ preparation, preparationDigest: 'f'.repeat(64), receiptDigest: 'f'.repeat(64), code: 'expected-state-changed', at: MAX })]]) {
    const bytes = utf8(canonicalJson(record));
    decodeEffect(bytes);
    assert.ok(bytes.length <= cap(slot) && bytes.length <= EVIDENCE_CAP, `${slot} ${bytes.length}`);
    // And it frames within the slot.
    encodeDaemonJournalFrame(bytes, { namespaceDigest: 'a'.repeat(64), requestId: ids.requestId, slot });
  }
  // The widest pair: applied, every key and epoch at maximum width.
  const preimage = { v: 1, kind: 'computer-use', enabled: false };
  const pair = { v: 1, preimage, record: { v: 1, kind: 'reconciliation', requestId: ids.requestId, payloadDigest: 'f'.repeat(64),
    effectId: 'ffffffff-ffff-4fff-bfff-ffffffffffff', auditId: 'ffffffff-ffff-4fff-bfff-ffffffffffff', originalDaemonKey: 'f'.repeat(64),
    originalDaemonEpoch: MAX, reportingDaemonKey: 'f'.repeat(64), reportingDaemonEpoch: MAX, at: MAX, finding: 'applied', basisDigest: 'f'.repeat(64),
    observedDigest: sha256(utf8(canonicalJson(preimage))) } };
  const pairBytes = encodeReconciliationPair(pair, { slot: 'terminal-pair', requestId: ids.requestId });
  assert.ok(pairBytes.length <= PAIR_LIMITS.pair, `pair ${pairBytes.length}`);
});
