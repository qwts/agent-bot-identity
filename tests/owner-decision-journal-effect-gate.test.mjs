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

function p1(signer, { actionText, nonce, iat = 2_000_000_000, exp = 2_000_000_060 }) {
  const segment = Buffer.from(JSON.stringify({ v: 1, aud: 'agent-bot-owner', kind: 'presence', action: sha256(Buffer.from(actionText, 'utf8')), nonce, iat, exp })).toString('base64url');
  return `p1.${segment}.${sign(null, Buffer.from(segment), signer.privateKey).toString('base64url')}`;
}

// A complete released request. `storedP1Nonce` lets a test store a p1 signed
// for another request's nonce.
function released(t, { requestId = '11111111-1111-4111-8111-111111111111', nonce = nonceOf(1), storedP1Nonce = nonce, upTo = 'successful-check' } = {}) {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(tmpdir(), 'owner-gate-')));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const env = { XDG_STATE_HOME: path.join(base, 'xdg') }, home = base;
  loadOrCreateVouchKey(vouchStateDir({ env }));
  const signer = generateKeyPairSync('ed25519'), broker = generateKeyPairSync('ed25519');
  const trustRoot = path.join(base, 'trust');
  const trustWriter = (now) => createOwnerDecisionTrustWriter({ root: trustRoot, env, home, now: () => now, legacyPresenceKey: null });
  trustWriter(1_999_999_000).enrollNamespace({ namespaceDigest });
  trustWriter(1_999_999_000).enrollKeys({ receiptKey: rawKey(broker), presenceKey: rawKey(signer), brokerUid: process.getuid() + 1 });

  const { principal, account, soul } = template;
  const action = Buffer.from(canonicalJson({ v: 1, requestId, principal, account, soul, operation: 'revision.approve',
    parameters: { proposalId: template.expected.proposal.proposalId, expectedRevision: template.expected.head.revision, reason: 'Ship it' } }));
  const acceptance = { v: 1, kind: 'acceptance', requestId, principal, account, soul, operation: 'revision.approve', payloadDigest: sha256(action),
    namespaceDigest, acceptedAt: 2_000_000_000, daemonKey: template.daemonKey, daemonEpoch: 1, watchId: template.watchId, reservationBytes: 524288 };
  const journalRoot = path.join(base, 'journal');
  initializeDaemonJournal(journalRoot);
  createDaemonJournalStore({ root: journalRoot, namespaceDigest }).admit(action, Buffer.from(canonicalJson(acceptance)));
  const preparation = { ...template, requestId, payloadDigest: acceptance.payloadDigest, nonce, acceptedAt: 2_000_000_000, preparedAt: 2_000_000_000, exp: 2_000_000_180 };
  const { actionText } = decodeOwnerDecisionAction(action);
  const presence = p1(signer, { actionText, nonce: storedP1Nonce });
  const receipt = Buffer.from('d1.receipt.signature'), receiptDigest = sha256(receipt);
  const check = { requestId, payloadDigest: acceptance.payloadDigest, receiptDigest, daemonKey: acceptance.daemonKey, daemonEpoch: 1,
    watchId: acceptance.watchId, state: 'released', mayApply: true, exp: 2_000_000_060 };
  const dir = path.join(journalRoot, 'requests', requestDirectoryName({ namespaceDigest, requestId }));
  const write = (slot, payload) => fs.writeFileSync(path.join(dir, `${slot}.record`), encodeDaemonJournalFrame(payload, { namespaceDigest, requestId, slot }));
  const order = [['preparation', Buffer.from(canonicalJson(preparation))], ['prepared-challenge', challengeFor(preparation, action)],
    ['presence', Buffer.from(presence, 'ascii')], ['receipt', receipt], ['successful-check', Buffer.from(canonicalJson(check))]];
  for (const [slot, payload] of order) { write(slot, payload); if (slot === upTo) break; }

  const stateDir = path.join(base, 'identity'), censusFile = path.join(base, 'population.json');
  fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  mintAgentIdentity({ useGithub: false, gate: () => false, appSlug: null, harness: 'codex', transcript: { provider: 'codex', id: 't' },
    stateDir, idFactory: () => soul, now: () => new Date('2026-10-12T00:00:00.000Z') });
  upsertSoul({ id: soul, appSlug: null, parentId: null, status: 'active', spacePath: `/spaces/${soul}`, worktree: null, worktrees: [],
    transcriptLocator: null, lastSeen: '2026-10-12T00:00:00.000Z' }, { file: censusFile });
  const options = { journalRoot, namespaceDigest, trustRoot, env, home, daemonAccount: account, censusFile,
    identityPort: createOwnerDecisionIdentityPort({ stateDir }), nowMilliseconds: NOW };
  const recover = () => createDaemonJournalStore({ root: journalRoot, namespaceDigest }).recover(requestId);
  const enter = (overrides = {}, token = presence) => enterOwnerDecisionEffect({ requestId, presenceToken: token }, { ...options, ...overrides });
  return { requestId, presence, signer, broker, trustWriter, trustRoot, censusFile, journalRoot, stateDir, enter, recover, actionText };
}

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

// Every refusal below writes nothing: the request stays released.
function refusedWithoutWrite(r, result, reason) {
  assert.deepEqual(result, { state: 'refused', reason, code: 'storage-failed' });
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
