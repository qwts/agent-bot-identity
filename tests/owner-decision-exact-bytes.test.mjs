// Every owner-decision decoder that takes bytes reads only the input view's
// intrinsic bytes (agent-comms#77): an own `length`, `byteLength`, `buffer`,
// `byteOffset`, `subarray` or `slice` can neither shrink an oversized input
// under its cap nor change what is decoded, and a Proxy or lookalike is not
// bytes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { exactBytes, intrinsicByteLength } from '../identity/owner-decision-bytes.mjs';
import { decodeEffect, decodePreparation } from '../identity/owner-decision-evidence.mjs';
import { validateLocalLifecycleOutcome } from '../identity/owner-decision-local-outcome.mjs';
import { validateOwnerDecisionTrustObservation } from '../identity/owner-decision-trust.mjs';
import { decodeDaemonJournalFrame, decodeReconciliationPair, encodeDaemonJournalFrame } from '../identity/owner-decision-journal-frame.mjs';
import { decodeOwnerDecisionAction } from '../identity/owner-decision-action.mjs';
import { verifyLinkedEvent } from '../identity/owner-decision-linked-event.mjs';

const fixture = (name) => JSON.parse(readFileSync(new URL(`./fixtures/owner-decisions/${name}`, import.meta.url), 'utf8'));
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const evidence = fixture('effect-evidence-v1.json'), observation = fixture('daemon-trust-observation-v1.json');
const outcome = fixture('local-lifecycle-outcome-v1-draft.json'), budget = fixture('journal-budget-v1.json');
const actions = fixture('v1.json');

// Own accessors on a genuine Buffer that would mislead (or throw) if read.
const ACCESSORS = ['length', 'byteLength', 'buffer', 'byteOffset', 'subarray', 'slice'];
function throwing(bytes) {
  const copy = Buffer.from(bytes);
  for (const name of ACCESSORS) Object.defineProperty(copy, name, { get() { throw new Error(`read ${name}`); } });
  return copy;
}
function misleading(bytes) {
  const copy = Buffer.from(bytes);
  Object.defineProperty(copy, 'length', { value: 1 });
  Object.defineProperty(copy, 'byteLength', { value: 1 });
  Object.defineProperty(copy, 'buffer', { value: new ArrayBuffer(1) });
  Object.defineProperty(copy, 'byteOffset', { value: 0 });
  Object.defineProperty(copy, 'subarray', { value: () => Buffer.from('{}') });
  Object.defineProperty(copy, 'slice', { value: () => Buffer.from('{}') });
  return copy;
}
// An input bigger than `cap`, disguised as one byte long.
const oversized = (cap) => { const big = Buffer.alloc(cap + 1, 0x20); Object.defineProperty(big, 'length', { value: 1 }); return big; };

const result = (run) => { try { return { ok: run() }; } catch (error) { return { error: error.reason ?? error.code ?? error.message }; } };

const outcomeVector = outcome.vectors.find(({ id }) => id === 'applied-applied');
const frameBinding = { namespaceDigest: 'a'.repeat(64), requestId: '11111111-1111-4111-8111-111111111111', slot: 'entered' };
const enteredBytes = Buffer.from(evidence.records.find(({ id }) => id === 'approve-entered').canonicalJson);
const linked = Buffer.from(`${JSON.stringify({ schemaVersion: 1, kind: 'decision', proposalId: '00000000-0000-4000-8000-000000000003', author: 'user', reason: 'x',
  authorization: { method: 'owner-decision' }, ownerDecision: { requestId: '11111111-1111-4111-8111-111111111111', payloadDigest: 'a'.repeat(64),
    receiptDigest: 'b'.repeat(64), effectId: '22222222-2222-4222-8222-222222222222', preparationDigest: 'c'.repeat(64) }, at: '2026-10-12T00:00:00.000Z' })}\n`);
const linkedOptions = (journalBytes) => ({ operation: 'revision.reject', journalBytes, journalRecordDigest: sha256(linked), proposalId: '00000000-0000-4000-8000-000000000003',
  linkage: JSON.parse(linked).ownerDecision });
const pair = budget.reconciliationPairs[0];

// Each decoder, its valid input, and its cap.
const decoders = {
  'preparation (evidence)': { valid: Buffer.from(evidence.records.find(({ id }) => id === 'approve-preparation').canonicalJson), cap: 4096, run: (b) => decodePreparation(b) },
  'effect (evidence)': { valid: enteredBytes, cap: 4096, run: (b) => decodeEffect(b) },
  'trust observation': { valid: Buffer.from(observation.vectors[0].canonicalJson), cap: 1024,
    run: (b) => { const r = validateOwnerDecisionTrustObservation(b); if (r !== 'valid') throw new Error(r); return r; } },
  'local outcome': { valid: Buffer.from(outcomeVector.canonicalJson), cap: 4096, run: (b) => validateLocalLifecycleOutcome(b, outcomeVector.context) },
  'frame encode': { valid: enteredBytes, cap: 4096, run: (b) => sha256(encodeDaemonJournalFrame(b, frameBinding)) },
  'frame decode': { valid: encodeDaemonJournalFrame(enteredBytes, frameBinding), cap: 4096 + 256, run: (b) => decodeDaemonJournalFrame(b, frameBinding).kind },
  'reconciliation pair': { valid: Buffer.from(pair.canonicalJson), cap: 4352, run: (b) => decodeReconciliationPair(b, { slot: pair.slot }).record.finding },
  action: { valid: Buffer.from(actions.positive[0].actionJson), cap: 32768,
    run: (b) => decodeOwnerDecisionAction(b).actionText },
  'linked event (payload)': { valid: linked, cap: 16384, run: (b) => verifyLinkedEvent(b, linkedOptions(linked)).kind },
  'linked event (journal)': { valid: linked, cap: 16384, run: (b) => verifyLinkedEvent(linked, linkedOptions(b)).kind },
};

test('each decoder reads only intrinsic bytes', async (t) => {
  for (const [name, { valid, cap, run }] of Object.entries(decoders)) {
    await t.test(name, () => {
      const expected = result(() => run(valid));
      assert(expected.ok !== undefined, `${name}: the valid input decodes (${expected.error})`);
      // Own accessors are never read: throwing ones change nothing, misleading ones neither.
      assert.deepEqual(result(() => run(throwing(valid))), expected, `${name}: throwing accessors`);
      assert.deepEqual(result(() => run(misleading(valid))), expected, `${name}: misleading accessors`);
      // A view into a larger buffer decodes only its own window.
      const host = Buffer.concat([Buffer.alloc(7, 0x41), valid, Buffer.alloc(9, 0x42)]);
      assert.deepEqual(result(() => run(host.subarray(7, 7 + valid.length))), expected, `${name}: an offset view`);
      // An oversized input disguised as small never passes the cap.
      assert(result(() => run(oversized(cap))).error, `${name}: oversized`);
      // Not bytes: a Proxy, a lookalike, another typed array.
      for (const fake of [new Proxy(Buffer.from(valid), {}), { length: valid.length, 0: valid[0] }, new Uint16Array(4), Object.create(Buffer.prototype)]) {
        assert(result(() => run(fake)).error, `${name}: not bytes`);
      }
    });
  }
});

test('the helper answers only for genuine Uint8Arrays, from intrinsic state', () => {
  const big = Buffer.alloc(10, 1);
  Object.defineProperty(big, 'length', { value: 1 });
  assert.equal(intrinsicByteLength(big), 10);
  assert.equal(exactBytes(big, { max: 9 }), null);
  assert.deepEqual(exactBytes(big, { max: 10 }), Buffer.alloc(10, 1));
  for (const value of [null, undefined, 7, 'abc', {}, [], new Proxy(Buffer.alloc(2), {}), new Uint16Array(2), new DataView(new ArrayBuffer(2))]) {
    assert.equal(intrinsicByteLength(value), null); assert.equal(exactBytes(value, { max: 10 }), null);
  }
  // The copy is private: changing the input afterwards changes nothing.
  const source = Buffer.from('abc'), copy = exactBytes(source, { max: 3 });
  source[0] = 0x7a;
  assert.equal(copy.toString(), 'abc');
  assert.equal(exactBytes(Buffer.alloc(0), { max: 3 }), null);
  assert.deepEqual(exactBytes(Buffer.alloc(0), { max: 3, min: 0 }), Buffer.alloc(0));
});

// The exported helpers that take bytes besides the decoders: the challenge a
// preparation implies (its action bytes) and the receipt verifier's saved
// challenge. Neither reads an own length.
test('challengeFor and the receipt verifier read only intrinsic bytes', async (t) => {
  const { challengeFor } = await import('../identity/owner-decision-evidence.mjs');
  const preparation = evidence.records.find(({ id }) => id === 'approve-preparation').record;
  const action = Buffer.from(actions.positive[0].actionJson);
  await t.test('challengeFor', () => {
    const expected = challengeFor(preparation, action);
    assert(challengeFor(preparation, throwing(action)).equals(expected));
    assert(challengeFor(preparation, misleading(action)).equals(expected));
    assert.throws(() => challengeFor(preparation, oversized(32768)), { code: 'invalid-owner-decision-evidence' });
    for (const fake of [new Proxy(Buffer.from(action), {}), { length: 2, 0: 1 }, undefined]) {
      assert.throws(() => challengeFor(preparation, fake), { code: 'invalid-owner-decision-evidence' });
    }
  });

});
