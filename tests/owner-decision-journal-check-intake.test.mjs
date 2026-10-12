// The disabled owner-decision check intake (agent-comms#77, C2): the owner's
// p1 and the broker's d1 (slots 4 and 5) for a prepared request, then the one
// successful check (slot 6). Each test builds a prepared request in scratch
// state with real test-signed tokens and drives the writers.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { canonicalJson } from '../canonical-json.mjs';
import { encodeDaemonJournalFrame, requestDirectoryName } from '../identity/owner-decision-journal-frame.mjs';
import { acquireDaemonJournalLock, createDaemonJournalStore, initializeDaemonJournal } from '../identity/owner-decision-journal-store.mjs';
import { challengeFor } from '../identity/owner-decision-evidence.mjs';
import { decodeOwnerDecisionAction } from '../identity/owner-decision-action.mjs';

const fixture = JSON.parse(fs.readFileSync(new URL('./fixtures/owner-decisions/effect-evidence-v1.json', import.meta.url), 'utf8'));
const template = fixture.records.find(({ id }) => id === 'approve-preparation').record;
const sha256 = (value) => createHash('sha256').update(value).digest('hex');
const darwin = { skip: process.platform !== 'darwin' && 'the journal lock is Darwin-only' };
const namespaceDigest = 'a'.repeat(64);
const NOW = 2_000_000_010_000;
const requestId = '11111111-1111-4111-8111-111111111111';
const nonce = Buffer.alloc(32, 1).toString('base64url');
const SLOTS = ['presence', 'receipt', 'successful-check', 'pre-effect-refused', 'entered'];

const pin = (keyPair) => ({ alg: 'ed25519', publicKey: keyPair.publicKey.export({ format: 'jwk' }).x,
  keyId: sha256(keyPair.publicKey.export({ type: 'spki', format: 'der' })) });
const signed = (prefix, payload, key) => {
  const segment = Buffer.from(typeof payload === 'string' ? payload : canonicalJson(payload)).toString('base64url');
  return `${prefix}.${segment}.${sign(null, Buffer.from(segment), key.privateKey).toString('base64url')}`;
};

// A prepared request (preparation and its exact challenge) in a scratch
// journal, the active trust pins, and valid p1 and d1 for it.
function prepared(t, { upTo = 'prepared-challenge' } = {}) {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(tmpdir(), 'owner-intake-')));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const root = path.join(base, 'journal');
  initializeDaemonJournal(root);
  const { principal, account, soul } = template;
  const action = Buffer.from(canonicalJson({ v: 1, requestId, principal, account, soul, operation: 'revision.approve',
    parameters: { proposalId: template.expected.proposal.proposalId, expectedRevision: template.expected.head.revision, reason: 'Ship it' } }));
  const acceptance = { v: 1, kind: 'acceptance', requestId, principal, account, soul, operation: 'revision.approve', payloadDigest: sha256(action),
    namespaceDigest, acceptedAt: 2_000_000_000, daemonKey: template.daemonKey, daemonEpoch: 1, watchId: template.watchId, reservationBytes: 524288 };
  const open = (options = {}) => createDaemonJournalStore({ root, namespaceDigest, ...options });
  open().admit(action, Buffer.from(canonicalJson(acceptance)));
  const preparation = { ...template, requestId, payloadDigest: acceptance.payloadDigest, nonce, acceptedAt: 2_000_000_000, preparedAt: 2_000_000_000, exp: 2_000_000_180 };
  const dir = path.join(root, 'requests', requestDirectoryName({ namespaceDigest, requestId }));
  const write = (slot, payload) => fs.writeFileSync(path.join(dir, `${slot}.record`), encodeDaemonJournalFrame(payload, { namespaceDigest, requestId, slot }));
  const read = (slot) => fs.readFileSync(path.join(dir, `${slot}.record`));
  if (upTo) write('preparation', Buffer.from(canonicalJson(preparation)));
  if (upTo === 'prepared-challenge') write('prepared-challenge', challengeFor(preparation, action));

  const signer = generateKeyPairSync('ed25519'), broker = generateKeyPairSync('ed25519');
  const trust = { receiptKey: pin(broker), presenceKey: pin(signer) };
  const { actionText } = decodeOwnerDecisionAction(action);
  const p1 = (overrides = {}, key = signer) => signed('p1', JSON.stringify({ v: 1, aud: 'agent-bot-owner', kind: 'presence',
    action: sha256(Buffer.from(actionText, 'utf8')), nonce, iat: 2_000_000_000, exp: 2_000_000_060, ...overrides }), key);
  const presenceToken = p1();
  const d1 = (presence = presenceToken, overrides = {}, key = broker) => signed('d1', { v: 1, aud: 'agent-comms-owner-decision',
    brokerKey: trust.receiptKey.keyId, requestId, principal, account, soul, operation: 'revision.approve', payloadDigest: acceptance.payloadDigest,
    nonce, presenceKey: trust.presenceKey.keyId, presenceDigest: sha256(Buffer.from(presence, 'ascii')), iat: 2_000_000_001, exp: 2_000_000_060, ...overrides }, key);
  const receiptToken = d1();
  const check = { requestId, payloadDigest: acceptance.payloadDigest, receiptDigest: sha256(Buffer.from(receiptToken, 'ascii')),
    daemonKey: acceptance.daemonKey, daemonEpoch: 1, watchId: acceptance.watchId, state: 'released', mayApply: true, exp: 2_000_000_060 };
  const decide = (overrides = {}, store = open()) => store.recordDecision(requestId, { presenceToken, receiptToken, trust, nowMilliseconds: NOW, ...overrides });
  const record = (overrides = {}, store = open()) => store.recordSuccessfulCheck(requestId, { check, nowMilliseconds: NOW, ...overrides });
  const recover = () => open().recover(requestId);
  return { root, open, write, read, trust, signer, broker, p1, d1, presenceToken, receiptToken, check, decide, record, recover, acceptance };
}

const snapshot = (j) => SLOTS.map((slot) => sha256(j.read(slot)));
function unchanged(j, run, expected) {
  const before = snapshot(j);
  assert.throws(run, expected);
  assert.deepEqual(snapshot(j), before);
}
const refused = (refusal) => ({ reason: 'owner-journal-intake-refused', code: 'storage-failed', ...(refusal ? { refusal } : {}) });

test('prepared -> authorizing -> released through intake, with the exact saved bytes', darwin, (t) => {
  const j = prepared(t);
  assert.equal(j.recover().state, 'prepared');
  const authorizing = j.decide(), released = j.record();
  assert.equal(authorizing.state, 'authorizing'); assert.equal(released.state, 'released');
  // No physical flush is ever claimed: node's fsync is logical only.
  assert.strictEqual(authorizing.physicalFlushGuaranteed, false); assert.strictEqual(released.physicalFlushGuaranteed, false);
  assert.equal(j.recover().state, 'released');
  // The saved frames hold exactly the tokens and the canonical check.
  const committed = (slot, bytes) => assert.deepEqual(j.read(slot), encodeDaemonJournalFrame(bytes, { namespaceDigest, requestId, slot }));
  committed('presence', Buffer.from(j.presenceToken, 'ascii'));
  committed('receipt', Buffer.from(j.receiptToken, 'ascii'));
  committed('successful-check', Buffer.from(canonicalJson(j.check)));
});

test('decision intake refuses tokens the existing verifiers refuse, and writes nothing', darwin, async (t) => {
  const other = generateKeyPairSync('ed25519');
  const cases = {
    'p1 signed by another key': (j) => { const p = j.p1({}, other); return { presenceToken: p, receiptToken: j.d1(p) }; },
    'p1 for another nonce': (j) => { const p = j.p1({ nonce: Buffer.alloc(32, 2).toString('base64url') }); return { presenceToken: p, receiptToken: j.d1(p) }; },
    'p1 for another action': (j) => { const p = j.p1({ action: 'f'.repeat(64) }); return { presenceToken: p, receiptToken: j.d1(p) }; },
    'd1 signed by another key': (j) => ({ receiptToken: j.d1(j.presenceToken, {}, other) }),
    'd1 for another p1': (j) => ({ receiptToken: j.d1(j.p1({ iat: 2_000_000_002 })) }),
    'd1 naming another nonce': (j) => ({ receiptToken: j.d1(j.presenceToken, { nonce: Buffer.alloc(32, 2).toString('base64url') }) }),
    'd1 expired': (j) => ({ nowMilliseconds: 2_000_000_060_000 }),
    'trust missing': () => ({ trust: undefined }),
    'trust naming other keys': (j) => ({ trust: { receiptKey: pin(other), presenceKey: j.trust.presenceKey } }),
    'not tokens': () => ({ presenceToken: 7, receiptToken: null }),
  };
  for (const [name, overrides] of Object.entries(cases)) {
    await t.test(name, (tt) => {
      const j = prepared(tt);
      unchanged(j, () => j.decide(overrides(j)), refused());
      assert.equal(j.recover().state, 'prepared');
      assert.equal(j.decide().state, 'authorizing');
    });
  }
  await t.test('the refusal carries the verifier reason', (tt) => {
    const j = prepared(tt);
    assert.throws(() => j.decide({ trust: undefined }), refused('owner-presence-trust'));
  });
});

test('decision intake is legal only from prepared; again is a conflict', darwin, async (t) => {
  const conflict = { reason: 'owner-journal-conflict', code: 'conflict' };
  for (const [upTo, state] of [[null, 'admitted'], ['preparation', 'preparing']]) {
    await t.test(state, (tt) => {
      const j = prepared(tt, { upTo });
      unchanged(j, () => j.decide(), { reason: 'owner-journal-transition-refused', code: 'storage-failed' });
      assert.equal(j.recover().state, state);
    });
  }
  await t.test('double intake', (tt) => {
    const j = prepared(tt); j.decide();
    unchanged(j, () => j.decide(), conflict);
  });
  await t.test('a presence already present (a crash between the two writes)', (tt) => {
    const j = prepared(tt);
    j.write('presence', Buffer.from(j.presenceToken, 'ascii'));
    assert.equal(j.recover().state, 'authorizing');
    unchanged(j, () => j.decide(), conflict);
  });
  await t.test('released', (tt) => {
    const j = prepared(tt); j.decide(); j.record();
    unchanged(j, () => j.decide(), conflict);
  });
  await t.test('refused', (tt) => {
    const j = prepared(tt); j.open().refusePreEffect(requestId, { code: 'expired', at: 2_000_000_200 });
    unchanged(j, () => j.decide(), conflict);
  });
  await t.test('entered', (tt) => {
    const j = prepared(tt); j.decide(); j.record(); j.open().enterEffect(requestId, () => ({ at: 2_000_000_011 }));
    unchanged(j, () => j.decide(), conflict);
    unchanged(j, () => j.record(), conflict);
  });
});

test('the successful check is legal only after both tokens, once, and only as the saved binding names it', darwin, async (t) => {
  const conflict = { reason: 'owner-journal-conflict', code: 'conflict' };
  await t.test('before intake', (tt) => {
    const j = prepared(tt);
    unchanged(j, () => j.record(), { reason: 'owner-journal-transition-refused' });
  });
  await t.test('with only the presence (a crash between the two writes)', (tt) => {
    const j = prepared(tt);
    j.write('presence', Buffer.from(j.presenceToken, 'ascii'));
    unchanged(j, () => j.record(), { reason: 'owner-journal-transition-refused' });
  });
  await t.test('a second check', (tt) => {
    const j = prepared(tt); j.decide(); j.record();
    unchanged(j, () => j.record(), conflict);
  });
  await t.test('a refused request', (tt) => {
    const j = prepared(tt); j.decide(); j.open().refusePreEffect(requestId, { code: 'expired', at: 2_000_000_200 });
    unchanged(j, () => j.record(), conflict);
  });
  const bad = {
    'another receipt digest': { receiptDigest: 'b'.repeat(64) },
    'another watch': { watchId: '22222222-2222-4222-8222-222222222222' },
    'not released': { state: 'awaiting' },
    'mayApply false': { mayApply: false },
    'an extra field': { extra: 1 },
  };
  for (const [name, changes] of Object.entries(bad)) {
    await t.test(name, (tt) => {
      const j = prepared(tt); j.decide();
      unchanged(j, () => j.record({ check: { ...j.check, ...changes } }), { reason: 'invalid-owner-journal-record', code: 'bad-request' });
      assert.equal(j.record().state, 'released');
    });
  }
  await t.test('expired now', (tt) => {
    const j = prepared(tt); j.decide();
    unchanged(j, () => j.record({ nowMilliseconds: 2_000_000_060_000 }), refused('check-expired'));
    assert.equal(j.record({ nowMilliseconds: 2_000_000_059_999 }).state, 'released');
  });
  await t.test('malformed input refuses before the lock', (tt) => {
    const j = prepared(tt); j.decide();
    const held = acquireDaemonJournalLock(j.root);
    try {
      for (const overrides of [{ check: null }, { check: [] }, { nowMilliseconds: undefined }, { nowMilliseconds: -1 }, { nowMilliseconds: 1.5 }]) {
        assert.throws(() => j.record(overrides), { reason: 'invalid-owner-journal-record' });
      }
      assert.throws(() => j.open().recordDecision(requestId, null), { reason: 'invalid-owner-journal-record' });
      assert.throws(() => j.open().recordDecision('nope', {}), { reason: 'invalid-owner-journal-record' });
      assert.throws(() => j.open().recordSuccessfulCheck('nope', { check: j.check, nowMilliseconds: NOW }), { reason: 'invalid-owner-journal-record' });
    } finally { fs.closeSync(held); }
  });
});

// agent-comms 52477: the broker sets the check's exp to the receipt's, and
// its lifecycle validator requires them equal. The check's exp must be
// exactly the saved receipt's and no later than the preparation's.
test('the check expires exactly with the saved receipt, and never after the preparation', darwin, async (t) => {
  const bad = { reason: 'invalid-owner-journal-record', code: 'bad-request' };
  await t.test('equal to the receipt\'s', (tt) => {
    const j = prepared(tt); j.decide();
    assert.equal(j.check.exp, 2_000_000_060);
    assert.equal(j.record().state, 'released');
  });
  for (const [name, exp] of [['later than the receipt\'s', 2_000_000_061], ['earlier than the receipt\'s', 2_000_000_059]]) {
    await t.test(name, (tt) => {
      const j = prepared(tt); j.decide();
      unchanged(j, () => j.record({ check: { ...j.check, exp } }), bad);
      assert.equal(j.record().state, 'released');
    });
  }
  // A receipt written around decision intake (which would refuse it: a
  // verified receipt never outlives its challenge) whose exp is past the
  // preparation's: a check naming that exp still refuses.
  await t.test('later than the preparation\'s', (tt) => {
    const j = prepared(tt);
    const exp = 2_000_000_181, presence = j.p1({ exp }), receipt = j.d1(presence, { exp });
    j.write('presence', Buffer.from(presence, 'ascii'));
    j.write('receipt', Buffer.from(receipt, 'ascii'));
    const check = { ...j.check, exp, receiptDigest: sha256(Buffer.from(receipt, 'ascii')) };
    unchanged(j, () => j.record({ check }), bad);
    assert.equal(j.recover().state, 'authorizing');
  });
  await t.test('a saved receipt with no readable exp', (tt) => {
    const j = prepared(tt);
    const receipt = j.d1(j.presenceToken, { exp: 'soon' });
    j.write('presence', Buffer.from(j.presenceToken, 'ascii'));
    j.write('receipt', Buffer.from(receipt, 'ascii'));
    unchanged(j, () => j.record({ check: { ...j.check, receiptDigest: sha256(Buffer.from(receipt, 'ascii')) } }), bad);
  });
});

test('every intake writer scans first: an unknown entry refuses and poisons, an unknown request refuses', darwin, async (t) => {
  for (const [name, setup, run] of [
    ['decision', () => {}, (j, store) => j.decide({}, store)],
    ['check', (j) => j.decide(), (j, store) => j.record({}, store)],
  ]) {
    await t.test(name, (tt) => {
      const j = prepared(tt); setup(j);
      const store = j.open(), unknown = path.join(j.root, 'requests', 'not-a-request');
      fs.mkdirSync(unknown);
      unchanged(j, () => run(j, store), { reason: 'owner-journal-corrupt', code: 'storage-failed' });
      fs.rmdirSync(unknown);
      unchanged(j, () => run(j, store), { reason: 'owner-journal-reopen-required' });
      assert(['authorizing', 'released'].includes(run(j, j.open()).state));
    });
  }
  const j = prepared(t);
  assert.throws(() => j.open().recordDecision('22222222-2222-4222-8222-222222222222', { presenceToken: j.presenceToken, receiptToken: j.receiptToken, trust: j.trust, nowMilliseconds: NOW }),
    { reason: 'owner-journal-transition-refused' });
  assert.throws(() => j.open().recordSuccessfulCheck('22222222-2222-4222-8222-222222222222', { check: j.check, nowMilliseconds: NOW }),
    { reason: 'owner-journal-transition-refused' });
});

test('a refused intake leaves the instance usable; each writer flushes what it read first', darwin, async (t) => {
  const j = prepared(t), store = j.open();
  assert.throws(() => j.record({}, store), { reason: 'owner-journal-transition-refused' });
  assert.throws(() => j.decide({ trust: undefined }, store), refused());
  assert.equal(j.decide({}, store).state, 'authorizing');
  assert.throws(() => j.decide({}, store), { reason: 'owner-journal-conflict' });
  assert.throws(() => j.record({ check: { ...j.check, mayApply: false } }, store), { reason: 'invalid-owner-journal-record' });
  assert.throws(() => j.record({ nowMilliseconds: 2_000_000_060_000 }, store), refused('check-expired'));
  assert.equal(j.record({}, store).state, 'released');
  for (const [name, setup, run, slot] of [
    ['decision', () => {}, (k, s) => k.decide({}, s), 'presence'],
    ['check', (k) => k.decide(), (k, s) => k.record({}, s), 'successful-check'],
  ]) {
    await t.test(name, (tt) => {
      const k = prepared(tt); setup(k);
      const seen = [];
      run(k, k.open({ fault: (at) => seen.push(at) }));
      const flushed = seen.indexOf('recovery:directories-flushed');
      assert(flushed >= 0 && flushed < seen.indexOf(`${slot}:body-written`), seen.join(' '));
    });
  }
});

test('a crash between writes recovers to the existing phase', darwin, async (t) => {
  const crashAt = (point) => ({ fault: (at) => { if (at === point) throw new Error('crash'); } });
  await t.test('after presence, before receipt: authorizing, and no check can follow', (tt) => {
    const j = prepared(tt);
    assert.throws(() => j.decide({}, j.open(crashAt('receipt:body-written'))));
    assert.throws(() => j.recover(), { reason: 'owner-journal-unsupported-phase' });
  });
  await t.test('presence committed, receipt not started', (tt) => {
    const j = prepared(tt);
    assert.throws(() => j.decide({}, j.open(crashAt('presence:trailer-flushed'))));
    assert.equal(j.recover().state, 'authorizing');
    assert.throws(() => j.record(), { reason: 'owner-journal-transition-refused' });
    assert.throws(() => j.decide(), { reason: 'owner-journal-conflict' });
  });
  await t.test('check body without its trailer refuses as found', (tt) => {
    const j = prepared(tt); j.decide();
    assert.throws(() => j.record({}, j.open(crashAt('successful-check:body-written'))));
    assert.throws(() => j.recover(), { reason: 'owner-journal-unsupported-phase' });
  });
  await t.test('check trailer written but not flushed is released', (tt) => {
    const j = prepared(tt); j.decide();
    assert.throws(() => j.record({}, j.open(crashAt('successful-check:trailer-written'))));
    assert.equal(j.recover().state, 'released');
  });
});

test('a held journal lock refuses both intake writers instead of waiting', darwin, (t) => {
  const j = prepared(t);
  let held = acquireDaemonJournalLock(j.root);
  try { unchanged(j, () => j.decide(), { reason: 'owner-journal-busy', code: 'storage-failed' }); } finally { fs.closeSync(held); }
  j.decide();
  held = acquireDaemonJournalLock(j.root);
  try { unchanged(j, () => j.record(), { reason: 'owner-journal-busy' }); } finally { fs.closeSync(held); }
  assert.equal(j.record().state, 'released');
});
