// The disabled owner-decision effect-entry gate (agent-comms#77, C2). Each
// test builds a complete released request in scratch state: a scratch vouch
// key, trust records with a test native presence signer, the request journal
// at `released`, and a census and identity record for its soul.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import fs from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { canonicalJson } from '../canonical-json.mjs';
import { enterOwnerDecisionEffect } from '../owner-decision-effect-gate.mjs';
import { createOwnerDecisionIdentityPort } from '../owner-decision-identity-port.mjs';
import { upsertSoul } from '../agent-population.mjs';
import { mintAgentIdentity } from '../identity/agent-identity.mjs';
import { loadOrCreateVouchKey, vouchStateDir } from '../identity/vouch.mjs';
import { createOwnerDecisionTrustWriter } from '../identity/owner-decision-trust.mjs';
import { withCurrentObservation } from './helpers/owner-decision-trust-v1.mjs';
import { acquireDaemonJournalLock, createDaemonJournalStore, initializeDaemonJournal } from '../identity/owner-decision-journal-store.mjs';
import { encodeDaemonJournalFrame, requestDirectoryName } from '../identity/owner-decision-journal-frame.mjs';
import { challengeFor } from '../identity/owner-decision-evidence.mjs';
import { decodeOwnerDecisionAction } from '../identity/owner-decision-action.mjs';

const darwin = { skip: process.platform !== 'darwin' && 'the journal and trust locks are Darwin-only' };
const evidence = JSON.parse(fs.readFileSync(new URL('./fixtures/owner-decisions/effect-evidence-v1.json', import.meta.url), 'utf8'));
const template = evidence.records.find(({ id }) => id === 'approve-preparation').record;
const sha256 = (value) => createHash('sha256').update(value).digest('hex');
const namespaceDigest = 'a'.repeat(64);
const NOW = 2_000_000_010_000;
const nonceOf = (byte) => Buffer.alloc(32, byte).toString('base64url');
const rawKey = (keyPair) => keyPair.publicKey.export({ format: 'jwk' }).x;
const keyIdOf = (keyPair) => sha256(keyPair.publicKey.export({ type: 'spki', format: 'der' }));

function p1(signer, { actionText, nonce, iat = 2_000_000_000, exp = 2_000_000_060 }) {
  const segment = Buffer.from(JSON.stringify({ v: 1, aud: 'agent-bot-owner', kind: 'presence', action: sha256(Buffer.from(actionText, 'utf8')), nonce, iat, exp })).toString('base64url');
  return `p1.${segment}.${sign(null, Buffer.from(segment), signer.privateKey).toString('base64url')}`;
}

// A d1-shaped receipt naming the given broker and presence key IDs.
function d1(broker, payload) {
  const segment = Buffer.from(canonicalJson(payload)).toString('base64url');
  return `d1.${segment}.${sign(null, Buffer.from(segment), broker.privateKey).toString('base64url')}`;
}

// A complete released request. `storedP1Nonce` lets a test store a p1 signed
// for another request's nonce; `receiptKeys(broker, signer)` overrides the
// key IDs the stored receipt names, and `receiptToken(token)` rewrites the whole token.
// `shared` (an earlier released request) puts this one in the same journal,
// trust, identity and census. `p1Key` and `d1Key` sign the tokens instead of
// the enrolled presence signer and broker (a forger's keys).
function released(t, { requestId = '11111111-1111-4111-8111-111111111111', nonce = nonceOf(1), storedP1Nonce = nonce, upTo = 'successful-check',
  receiptKeys = (broker, signer) => ({ brokerKey: keyIdOf(broker), presenceKey: keyIdOf(signer) }), receiptToken = (token) => token, shared,
  p1Key, d1Key, d1Fields = {} } = {}) {
  const base = shared?.base ?? fs.realpathSync(fs.mkdtempSync(path.join(tmpdir(), 'owner-gate-')));
  if (!shared) t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const env = { XDG_STATE_HOME: path.join(base, 'xdg') }, home = base;
  const signer = shared?.signer ?? generateKeyPairSync('ed25519'), broker = shared?.broker ?? generateKeyPairSync('ed25519');
  const trustRoot = path.join(base, 'trust');
  const trustWriter = (now) => withCurrentObservation(createOwnerDecisionTrustWriter({ root: trustRoot, env, home, now: () => now, legacyPresenceKey: null }),
    { root: trustRoot, env, home });
  if (!shared) {
    loadOrCreateVouchKey(vouchStateDir({ env }));
    trustWriter(1_999_999_000).enrollNamespace({ namespaceDigest });
    trustWriter(1_999_999_000).enrollKeys({ receiptKey: rawKey(broker), presenceKey: rawKey(signer), brokerUid: process.getuid() + 1 });
  }

  const { principal, account, soul } = template;
  const action = Buffer.from(canonicalJson({ v: 1, requestId, principal, account, soul, operation: 'revision.approve',
    parameters: { proposalId: template.expected.proposal.proposalId, expectedRevision: template.expected.head.revision, reason: 'Ship it' } }));
  const acceptance = { v: 1, kind: 'acceptance', requestId, principal, account, soul, operation: 'revision.approve', payloadDigest: sha256(action),
    namespaceDigest, acceptedAt: 2_000_000_000, daemonKey: template.daemonKey, daemonEpoch: 1, watchId: template.watchId, reservationBytes: 524288 };
  const journalRoot = path.join(base, 'journal');
  if (!shared) initializeDaemonJournal(journalRoot);
  createDaemonJournalStore({ root: journalRoot, namespaceDigest }).admit(action, Buffer.from(canonicalJson(acceptance)));
  const preparation = { ...template, requestId, payloadDigest: acceptance.payloadDigest, nonce, acceptedAt: 2_000_000_000, preparedAt: 2_000_000_000, exp: 2_000_000_180 };
  const { actionText } = decodeOwnerDecisionAction(action);
  const presence = p1(p1Key ?? signer, { actionText, nonce: storedP1Nonce });
  const receipt = Buffer.from(receiptToken(d1(d1Key ?? broker, { v: 1, aud: 'agent-comms-owner-decision', ...receiptKeys(broker, signer), requestId,
    principal, account, soul, operation: 'revision.approve', payloadDigest: acceptance.payloadDigest, nonce,
    presenceDigest: sha256(Buffer.from(presence, 'ascii')), iat: 2_000_000_001, exp: 2_000_000_060, ...d1Fields })), 'ascii');
  const receiptDigest = sha256(receipt);
  const check = { requestId, payloadDigest: acceptance.payloadDigest, receiptDigest, daemonKey: acceptance.daemonKey, daemonEpoch: 1,
    watchId: acceptance.watchId, state: 'released', mayApply: true, exp: 2_000_000_060 };
  const dir = path.join(journalRoot, 'requests', requestDirectoryName({ namespaceDigest, requestId }));
  const write = (slot, payload) => fs.writeFileSync(path.join(dir, `${slot}.record`), encodeDaemonJournalFrame(payload, { namespaceDigest, requestId, slot }));
  const order = [['preparation', Buffer.from(canonicalJson(preparation))], ['prepared-challenge', challengeFor(preparation, action)],
    ['presence', Buffer.from(presence, 'ascii')], ['receipt', receipt], ['successful-check', Buffer.from(canonicalJson(check))]];
  for (const [slot, payload] of order) { write(slot, payload); if (slot === upTo) break; }

  const stateDir = path.join(base, 'identity'), censusFile = path.join(base, 'population.json');
  if (!shared) {
    fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
    mintAgentIdentity({ useGithub: false, gate: () => false, appSlug: null, harness: 'codex', transcript: { provider: 'codex', id: 't' },
      stateDir, idFactory: () => soul, now: () => new Date('2026-10-12T00:00:00.000Z') });
    upsertSoul({ id: soul, appSlug: null, parentId: null, status: 'active', spacePath: `/spaces/${soul}`, worktree: null, worktrees: [],
      transcriptLocator: null, lastSeen: '2026-10-12T00:00:00.000Z' }, { file: censusFile });
  }
  const options = { journalRoot, namespaceDigest, trustRoot, env, home, daemonAccount: account, censusFile,
    identityPort: createOwnerDecisionIdentityPort({ stateDir }), nowMilliseconds: NOW };
  const recover = () => createDaemonJournalStore({ root: journalRoot, namespaceDigest }).recover(requestId);
  const enter = (overrides = {}, token = presence) => enterOwnerDecisionEffect({ requestId, presenceToken: token }, { ...options, ...overrides });
  return { base, requestId, presence, signer, broker, trustWriter, trustRoot, censusFile, journalRoot, stateDir, enter, recover, actionText,
    receiptToken: receipt.toString('ascii'), check };
}

// What the effect reports for this approve: its revision-journal sequence and
// record digest, and no working tree (record-only).
const reported = { at: 2_000_000_011, journalSeq: 7, journalRecordDigest: 'b'.repeat(64), working: null };

test('the gate returns a bound completer that completes this request once', darwin, (t) => {
  const r = released(t);
  const entered = r.enter();
  assert(Object.isFrozen(entered));
  assert.deepEqual(Object.keys(entered).sort(), ['complete', 'effectId', 'enteredDigest', 'physicalFlushGuaranteed', 'requestId', 'state']);
  assert.strictEqual(entered.physicalFlushGuaranteed, false);
  const done = entered.complete(reported);
  // A revision is complete but stays indeterminate until its linked event.
  assert.equal(done.state, 'indeterminate'); assert.equal(done.requestId, r.requestId); assert.match(done.completedDigest, /^[a-f0-9]{64}$/);
  assert.throws(() => entered.complete(reported), { reason: 'owner-journal-entry-required' });
  assert.equal(r.recover().state, 'indeterminate');
});

test('the completer is for its own request only', darwin, (t) => {
  const a = released(t), b = released(t, { shared: a, requestId: '22222222-2222-4222-8222-222222222222', nonce: nonceOf(2) });
  const enteredA = a.enter(), enteredB = b.enter();
  // A request ID in the result is not an input: A's completer completes A.
  assert.equal(enteredA.complete({ ...reported, requestId: b.requestId }).requestId, a.requestId);
  assert.throws(() => enteredA.complete(reported), { reason: 'owner-journal-entry-required' });
  const read = (r) => fs.readFileSync(path.join(r.journalRoot, 'requests', requestDirectoryName({ namespaceDigest, requestId: r.requestId }), 'completed.record'));
  assert(read(b).every((byte) => byte === 0));
  assert.equal(enteredB.complete(reported).requestId, b.requestId);
});

test('after a crash or reopen nothing completes the entered request', darwin, async (t) => {
  await t.test('the completer is dropped (a crash) and the gate is called again', (tt) => {
    const r = released(tt);
    r.enter();
    const again = r.enter();
    assert.deepEqual(again, { state: 'refused', reason: 'owner-journal-consumed', code: 'conflict' });
    assert.equal('complete' in again, false);
    assert.deepEqual(r.recover().outcome, { code: 'effect-uncertain', effectDigest: null });
  });
  await t.test('a storage failure poisons the completer\'s instance', (tt) => {
    const r = released(tt);
    const entered = r.enter(), unknown = path.join(r.journalRoot, 'requests', 'not-a-request');
    fs.mkdirSync(unknown);
    assert.throws(() => entered.complete(reported), { reason: 'owner-journal-corrupt' });
    fs.rmdirSync(unknown);
    assert.throws(() => entered.complete(reported), { reason: 'owner-journal-reopen-required' });
    assert.deepEqual(r.recover().outcome, { code: 'effect-uncertain', effectDigest: null });
  });
});

test('a released request enters once; replay is consumed and a crash after entry is effect-uncertain', darwin, (t) => {
  const r = released(t);
  const entered = r.enter();
  assert.equal(entered.state, 'entered'); assert.equal(entered.requestId, r.requestId);
  // The same request and nonce again, even with the same token, is consumed.
  assert.deepEqual(r.enter(), { state: 'refused', reason: 'owner-journal-consumed', code: 'conflict' });
  // Durable entered with no effect (a crash right after it) is effect-uncertain.
  const recovered = r.recover();
  assert.equal(recovered.state, 'indeterminate');
  assert.deepEqual(recovered.outcome, { code: 'effect-uncertain', effectDigest: null });
});

// Every refusal below writes nothing, returns no completer, and leaves the
// request released.
function refusedWithoutWrite(r, result, reason) {
  assert.deepEqual(result, { state: 'refused', reason, code: 'storage-failed' });
  assert(Object.isFrozen(result) && !('complete' in result));
  assert.equal(r.recover().state, 'released');
}

test('an aliased p1 with the same nonce (flipped trailing signature bits) refuses, then the stored p1 enters', darwin, (t) => {
  const r = released(t);
  const [head, payload, signature] = r.presence.split('.');
  const alias = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'.split('')
    .map((c) => `${signature.slice(0, -1)}${c}`).find((s) => s !== signature && Buffer.from(s, 'base64url').equals(Buffer.from(signature, 'base64url')));
  assert(alias, 'a second spelling of the same signature exists');
  refusedWithoutWrite(r, r.enter({}, `${head}.${payload}.${alias}`), 'validation-failed');
  assert.equal(r.enter().state, 'entered');
  // And after entry the alias is consumed too.
  assert.equal(r.enter({}, `${head}.${payload}.${alias}`).reason, 'owner-journal-consumed');
});

test('a p1 carrying another request\'s valid nonce refuses for this request', darwin, (t) => {
  const r = released(t, { nonce: nonceOf(1), storedP1Nonce: nonceOf(2) });
  refusedWithoutWrite(r, r.enter(), 'validation-failed');
});

test('an expired p1 refuses', darwin, (t) => {
  const r = released(t);
  refusedWithoutWrite(r, r.enter({ nowMilliseconds: (2_000_000_060 + 31) * 1000 }), 'validation-failed');
});

test('trust revoked, rotated or re-enrolled since preparation refuses', darwin, async (t) => {
  const revoke = (r) => {
    const keys = path.join(r.trustRoot, 'keys');
    const head = fs.readdirSync(keys).filter((n) => /^\d{10}\.json$/.test(n)).sort().at(-1);
    r.trustWriter(2_000_000_005).revokeKeys({ revokes: sha256(fs.readFileSync(path.join(keys, head))), reason: 'rotated' });
  };
  await t.test('revoked', (tt) => { const r = released(tt); revoke(r); refusedWithoutWrite(r, r.enter(), 'trust-unavailable'); });
  await t.test('rotated to a new pair', (tt) => {
    const r = released(tt); revoke(r);
    r.trustWriter(2_000_000_006).enrollKeys({ receiptKey: rawKey(generateKeyPairSync('ed25519')), presenceKey: rawKey(generateKeyPairSync('ed25519')), brokerUid: process.getuid() + 1 });
    refusedWithoutWrite(r, r.enter(), 'trust-unavailable');
  });
  await t.test('re-enrolled with the same pair after preparation', (tt) => {
    const r = released(tt); revoke(r);
    r.trustWriter(2_000_000_006).enrollKeys({ receiptKey: rawKey(r.broker), presenceKey: rawKey(r.signer), brokerUid: process.getuid() + 1 });
    refusedWithoutWrite(r, r.enter(), 'trust-unavailable');
  });
});

// The receipt's key binding: any change of either key refuses in any second,
// including across a clock rollback; the timestamp layer refuses a same-pair
// re-enroll in the preparation's own second. preparedAt is 2_000_000_000.
test('a broker-only rotation, or a same-pair re-enroll in the preparation\'s second, refuses', darwin, async (t) => {
  const revokeAt = (r, at) => {
    const keys = path.join(r.trustRoot, 'keys');
    const head = fs.readdirSync(keys).filter((n) => /^\d{10}\.json$/.test(n)).sort().at(-1);
    r.trustWriter(at).revokeKeys({ revokes: sha256(fs.readFileSync(path.join(keys, head))), reason: 'rotated' });
  };
  const enrollAt = (r, at, broker) => r.trustWriter(at).enrollKeys({ receiptKey: rawKey(broker), presenceKey: rawKey(r.signer), brokerUid: process.getuid() + 1 });
  await t.test('broker-only rotation in the same second', (tt) => {
    const r = released(tt); revokeAt(r, 2_000_000_000); enrollAt(r, 2_000_000_000, generateKeyPairSync('ed25519'));
    refusedWithoutWrite(r, r.enter(), 'trust-unavailable');
  });
  await t.test('broker-only rotation after a clock rollback', (tt) => {
    // The new enrollment is stamped before preparedAt, so only the key binding catches it.
    const r = released(tt); revokeAt(r, 2_000_000_005); enrollAt(r, 1_999_999_500, generateKeyPairSync('ed25519'));
    refusedWithoutWrite(r, r.enter(), 'trust-unavailable');
  });
  await t.test('same-pair re-enroll in the same second', (tt) => {
    const r = released(tt); revokeAt(r, 2_000_000_000); enrollAt(r, 2_000_000_000, r.broker);
    refusedWithoutWrite(r, r.enter(), 'trust-unavailable');
  });
});

test('a stored receipt naming other keys, or none readable, refuses', darwin, async (t) => {
  const other = generateKeyPairSync('ed25519');
  await t.test('another broker key', (tt) => {
    const r = released(tt, { receiptKeys: (broker, signer) => ({ brokerKey: keyIdOf(other), presenceKey: keyIdOf(signer) }) });
    refusedWithoutWrite(r, r.enter(), 'trust-unavailable');
  });
  await t.test('another presence key', (tt) => {
    const r = released(tt, { receiptKeys: (broker) => ({ brokerKey: keyIdOf(broker), presenceKey: keyIdOf(other) }) });
    refusedWithoutWrite(r, r.enter(), 'trust-unavailable');
  });
  await t.test('an unreadable receipt', (tt) => {
    const r = released(tt, { receiptToken: () => 'd1.receipt.signature' });
    refusedWithoutWrite(r, r.enter(), 'trust-unavailable');
  });
  await t.test('a token that is not a d1', (tt) => {
    const r = released(tt, { receiptToken: (token) => token.replace(/^d1\./, 'x1.') });
    refusedWithoutWrite(r, r.enter(), 'trust-unavailable');
  });
});

test('a target that is no longer live refuses', darwin, (t) => {
  const r = released(t);
  fs.writeFileSync(r.censusFile, '{not json');
  refusedWithoutWrite(r, r.enter(), 'target-unavailable');
});

test('a held journal lock refuses instead of waiting', darwin, (t) => {
  const r = released(t);
  const held = acquireDaemonJournalLock(r.journalRoot);
  try { assert.deepEqual(r.enter(), { state: 'refused', reason: 'owner-journal-busy', code: 'storage-failed' }); } finally { fs.closeSync(held); }
  assert.equal(r.recover().state, 'released');
  assert.equal(r.enter().state, 'entered');
});

test('a request that is not released, or a missing clock, refuses', darwin, (t) => {
  const r = released(t);
  refusedWithoutWrite(r, r.enter({ nowMilliseconds: undefined }), 'validation-failed');
  assert.equal(r.enter({}, null).reason, 'validation-failed');
  assert.equal(enterOwnerDecisionEffect({ requestId: '22222222-2222-4222-8222-222222222222', presenceToken: r.presence },
    { journalRoot: r.journalRoot, namespaceDigest, nowMilliseconds: NOW }).reason, 'owner-journal-entry-refused');
});

test('the journal never consults the gate for a request that is not exactly released', darwin, async (t) => {
  for (const [upTo, state] of [['prepared-challenge', 'prepared'], ['receipt', 'authorizing']]) {
    await t.test(state, (tt) => {
      const r = released(tt, { upTo });
      assert.equal(r.recover().state, state);
      let consulted = false;
      const store = createDaemonJournalStore({ root: r.journalRoot, namespaceDigest });
      assert.throws(() => store.enterEffect(r.requestId, () => { consulted = true; return { at: 1 }; }), { reason: 'owner-journal-entry-refused' });
      assert.equal(consulted, false);
      assert.equal(r.recover().state, state);
    });
  }
});

// End to end through intake: the journal's check intake trusts the pins its
// caller passes, so wiring must pass current trust. Forged pins (a forger's
// key under the real key ID) never get past intake, and the request never
// enters. Stale pins after a rotation do get through intake, and the gate,
// reading real trust, then refuses with trust-unavailable and never enters.
const pinOf = (keyPair, keyId = keyIdOf(keyPair)) => ({ alg: 'ed25519', publicKey: rawKey(keyPair), keyId });

test('intake under forged pins refuses, and the request never enters', darwin, async (t) => {
  const forger = generateKeyPairSync('ed25519');
  for (const [name, forged, pins, refusal] of [
    ['a forged presence pin', { p1Key: forger }, (r) => ({ receiptKey: pinOf(r.broker), presenceKey: pinOf(forger, keyIdOf(r.signer)) }), 'owner-presence-trust'],
    ['a forged receipt pin', { d1Key: forger }, (r) => ({ receiptKey: pinOf(forger, keyIdOf(r.broker)), presenceKey: pinOf(r.signer) }), 'owner-receipt-trust'],
  ]) {
    await t.test(name, (tt) => {
      const r = released(tt, { upTo: 'prepared-challenge', ...forged });
      const store = createDaemonJournalStore({ root: r.journalRoot, namespaceDigest });
      assert.throws(() => store.recordDecision(r.requestId, { presenceToken: r.presence, receiptToken: r.receiptToken, trust: pins(r), nowMilliseconds: NOW }),
        { reason: 'owner-journal-intake-refused', refusal });
      assert.throws(() => store.recordSuccessfulCheck(r.requestId, { check: r.check, nowMilliseconds: NOW }), { reason: 'owner-journal-transition-refused' });
      assert.equal(r.recover().state, 'prepared');
      // The gate, with real trust, never enters a request that never released.
      assert.deepEqual(r.enter(), { state: 'refused', reason: 'owner-journal-entry-refused', code: 'storage-failed' });
      assert.equal(r.recover().state, 'prepared');
    });
  }
});

test('intake under stale pins after a rotation releases, but the gate with real trust refuses and never enters', darwin, async (t) => {
  const rotate = (r, at) => {
    const keys = path.join(r.trustRoot, 'keys');
    const head = fs.readdirSync(keys).filter((n) => /^\d{10}\.json$/.test(n)).sort().at(-1);
    r.trustWriter(at).revokeKeys({ revokes: sha256(fs.readFileSync(path.join(keys, head))), reason: 'rotated' });
    r.trustWriter(at).enrollKeys({ receiptKey: rawKey(generateKeyPairSync('ed25519')), presenceKey: rawKey(r.signer), brokerUid: process.getuid() + 1 });
  };
  // Stamped after preparation, and (by clock rollback) before it: the receipt
  // key binding refuses either way.
  for (const at of [2_000_000_005, 1_999_999_500]) {
    await t.test(`rotated at ${at}`, (tt) => {
      const r = released(tt, { upTo: 'prepared-challenge' });
      rotate(r, at);
      const store = createDaemonJournalStore({ root: r.journalRoot, namespaceDigest });
      const stale = { receiptKey: pinOf(r.broker), presenceKey: pinOf(r.signer) };
      assert.equal(store.recordDecision(r.requestId, { presenceToken: r.presence, receiptToken: r.receiptToken, trust: stale, nowMilliseconds: NOW }).state,
        'authorizing');
      assert.equal(store.recordSuccessfulCheck(r.requestId, { check: r.check, nowMilliseconds: NOW }).state, 'released');
      const refusal = r.enter();
      assert.deepEqual(refusal, { state: 'refused', reason: 'trust-unavailable', code: 'storage-failed' });
      assert.equal('complete' in refusal, false);
      assert.equal(r.recover().state, 'released');
    });
  }
});

// The gate re-verifies the stored d1 itself, not only the key IDs it names: a
// receipt planted straight into the journal (never through intake) refuses.
test('a planted d1 that names the real key IDs refuses at entry and writes nothing', darwin, async (t) => {
  const garbage = (token) => `${token.split('.').slice(0, 2).join('.')}.${Buffer.alloc(64, 7).toString('base64url')}`;
  const cases = [
    ['a garbage signature', { receiptToken: garbage }],
    ['a forger\'s signature', { d1Key: generateKeyPairSync('ed25519') }],
    ['another challenge (nonce)', { d1Fields: { nonce: nonceOf(9) } }],
    ['another request', { d1Fields: { requestId: '33333333-3333-4333-8333-333333333333' } }],
    ['another p1', { d1Fields: { presenceDigest: 'e'.repeat(64) } }],
    ['outliving its challenge', { d1Fields: { exp: 2_000_000_200, iat: 2_000_000_150 } }],
  ];
  for (const [name, options] of cases) {
    await t.test(name, (tt) => {
      const r = released(tt, options);
      const refused = r.enter();
      assert.deepEqual(refused, { state: 'refused', reason: 'validation-failed', code: 'storage-failed' });
      assert.equal(r.recover().state, 'released');
    });
  }
});

// The d1 is checked as issued (its own iat as the verifier's clock), so entry
// stays bounded only by the p1 on the daemon clock: past the receipt's exp but
// inside the p1's freshness, a valid flow still enters.
test('re-verifying the d1 does not tighten entry beyond the p1', darwin, async (t) => {
  await t.test('after the receipt expired, within the p1 skew', (tt) => {
    const r = released(tt);
    assert.equal(r.enter({ nowMilliseconds: (2_000_000_060 + 20) * 1000 }).state, 'entered');
  });
  await t.test('a receipt expiring before its p1', (tt) => {
    const r = released(tt, { d1Fields: { exp: 2_000_000_030 } });
    assert.equal(r.enter({ nowMilliseconds: 2_000_000_045_000 }).state, 'entered');
  });
  await t.test('the p1 still bounds entry', (tt) => {
    const r = released(tt);
    assert.equal(r.enter({ nowMilliseconds: (2_000_000_060 + 31) * 1000 }).reason, 'validation-failed');
  });
});
