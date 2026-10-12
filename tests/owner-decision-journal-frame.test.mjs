// Daemon owner-decision journal codec (#1007). The fixture is agent-comms
// tests/fixtures/owner-decisions/journal-budget-v1.json at 6b90f82 (merged PR #199),
// copied byte for byte; the frame layout is rebuilt here independently from
// that contract's table rather than from the codec under test.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { canonicalJson } from '../canonical-json.mjs';
import {
  DAEMON_JOURNAL_FILES, DAEMON_JOURNAL_SLOTS as slots, PAIR_LIMITS, SCRATCH_BYTES, decodeDaemonJournalFrame as decode,
  decodeReconciliationPair as decodePair, encodeDaemonJournalFrame as encode, encodeReconciliationPair as encodePair,
  requestDirectoryName,
} from '../identity/owner-decision-journal-frame.mjs';

const FIXTURE_URL = new URL('./fixtures/owner-decisions/journal-budget-v1.json', import.meta.url);
const FIXTURE_SHA256 = '92c09ed9aaa0bd468a17b76c8360a35c321e21d0a8e0e7b3f0b775fc64cb3046';
const fixture = JSON.parse(readFileSync(FIXTURE_URL, 'utf8'));
const base = { namespaceDigest: 'a'.repeat(64), requestId: '11111111-1111-4111-8111-111111111111' };
const hash = (bytes) => createHash('sha256').update(bytes).digest();
const invalid = (fn) => assert.throws(fn, { code: 'invalid-owner-journal-frame', message: 'invalid-owner-journal-frame' });
const contextFor = (role, slot, { namespaceDigest, requestId } = base) => hash(Buffer.from(role === null
  ? `{"namespaceDigest":"${namespaceDigest}","requestId":"${requestId}","slot":"${slot}","v":1}`
  : `{"namespaceDigest":"${namespaceDigest}","requestId":"${requestId}","role":"${role}","slot":"${slot}","v":1}`));

// The NEXT-BACKEND frame table, written out field by field.
function referenceFrame(payload, { id, cap, context }) {
  const header = Buffer.alloc(128), body = Buffer.alloc(cap), trailer = Buffer.alloc(128);
  header.write('ODJSLOT1', 0, 'ascii'); header.writeUInt16BE(1, 8); header.writeUInt16BE(id, 10); header.writeUInt32BE(0, 12);
  header.writeUInt32BE(cap, 16); header.writeUInt32BE(payload.length, 20); header.writeBigUInt64BE(1n, 24);
  context.copy(header, 32); hash(payload).copy(header, 64); payload.copy(body);
  trailer.write('ODJCOM01', 0, 'ascii'); trailer.writeUInt16BE(1, 8); trailer.writeUInt16BE(id, 10); trailer.writeUInt32BE(0, 12);
  trailer.writeBigUInt64BE(1n, 16); trailer.writeUInt32BE(payload.length, 24); trailer.writeUInt32BE(0, 28);
  hash(Buffer.concat([Buffer.from('owner-journal-frame-v1\n'), header, body])).copy(trailer, 32); context.copy(trailer, 64);
  return Buffer.concat([header, body, trailer]);
}

test('the vendored shared fixture is the pinned contract copy and fixes the daemon slot table', () => {
  assert.equal(hash(readFileSync(FIXTURE_URL)).toString('hex'), FIXTURE_SHA256);
  const daemon = fixture.stores.daemon;
  assert.deepEqual(slots.map(({ slot, cap }) => ({ name: slot, payloadCap: cap })), daemon.slots);
  assert.deepEqual(slots.map(({ id }) => id), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14]);
  assert.equal(slots.reduce((sum, { cap }) => sum + cap, 0), daemon.expected.payloadBytes);
  assert.equal(slots.length * fixture.limits.framingBytes, daemon.expected.slotFramingBytes);
  assert.equal(SCRATCH_BYTES, daemon.expected.scratchBytes);
  assert.equal(DAEMON_JOURNAL_FILES.length, 15);
  assert.equal(new Set(DAEMON_JOURNAL_FILES).size, 15);
  assert(DAEMON_JOURNAL_FILES.every((name) => /^[a-z-]+\.record$/.test(name) && name.length <= fixture.limits.componentBytes));
  assert.deepEqual(PAIR_LIMITS, { record: 2048, preimage: 2048, wrapper: 256, pair: 4352 });
  assert(slots.filter(({ slot }) => slot.endsWith('-pair')).every(({ cap }) => cap === PAIR_LIMITS.pair));
});

test('every daemon slot reproduces the exact offsets, daemon context and hashes at both length boundaries', () => {
  for (const { slot, cap, id } of slots) for (const length of [1, cap]) {
    const payload = Buffer.alloc(length, 0x7f), options = { ...base, slot }, frame = encode(payload, options);
    const context = contextFor('daemon', slot);
    assert.equal(frame.length, cap + 256);
    assert.equal(frame.subarray(0, 8).toString(), 'ODJSLOT1');
    assert.equal(frame.readUInt16BE(8), 1); assert.equal(frame.readUInt16BE(10), id);
    assert.equal(frame.readUInt32BE(16), cap); assert.equal(frame.readUInt32BE(20), length);
    assert.equal(frame.readBigUInt64BE(24), 1n);
    assert(frame.subarray(32, 64).equals(context)); assert(frame.subarray(64, 96).equals(hash(payload)));
    assert(frame.subarray(128, 128 + length).equals(payload)); assert(frame.subarray(128 + length, cap + 128).every((x) => x === 0));
    const trailer = frame.subarray(cap + 128);
    assert.equal(trailer.subarray(0, 8).toString(), 'ODJCOM01'); assert.equal(trailer.readUInt16BE(10), id);
    assert.equal(trailer.readBigUInt64BE(16), 1n); assert.equal(trailer.readUInt32BE(24), length);
    assert(trailer.subarray(64, 96).equals(context));
    assert(frame.equals(referenceFrame(payload, { id, cap, context })));
    assert.deepEqual(decode(frame, options), { kind: 'committed', slot, payload, sha256: hash(frame).toString('hex') });
    invalid(() => encode(Buffer.alloc(cap + 1, 1), options));
  }
});

test('all six shared paired vectors encode to their exact canonical bytes, hash and component bounds', () => {
  assert.equal(fixture.reconciliationPairs.length, 6);
  for (const vector of fixture.reconciliationPairs) {
    const { record, preimage } = vector.record, requestId = record.requestId;
    const bytes = encodePair(vector.record, { slot: vector.slot, requestId });
    assert.equal(bytes.toString('utf8'), vector.canonicalJson, vector.id);
    assert.equal(hash(bytes).toString('hex'), vector.sha256);
    assert.equal(bytes.length, vector.utf8Bytes); assert.equal(vector.cap, PAIR_LIMITS.pair);
    assert.equal(Buffer.byteLength(canonicalJson(record)), vector.componentBytes.record);
    assert.equal(Buffer.byteLength(canonicalJson(preimage)), vector.componentBytes.preimage);
    assert.equal(bytes.length - vector.componentBytes.record - vector.componentBytes.preimage, vector.wrapperBytes);
    assert.equal(record.observedDigest, hash(Buffer.from(canonicalJson(preimage))).toString('hex'));
    assert.deepEqual(decodePair(bytes, { slot: vector.slot, requestId }), vector.record);

    // Framed in its own slot under the request it names, byte for byte the reference layout.
    const { id, cap } = slots.find((entry) => entry.slot === vector.slot), options = { ...base, requestId, slot: vector.slot };
    const frame = encode(bytes, options);
    assert(frame.equals(referenceFrame(bytes, { id, cap, context: contextFor('daemon', vector.slot, options) })));
    const committed = decode(frame, options);
    assert.equal(committed.kind, 'committed');
    assert.deepEqual(decodePair(committed.payload, { slot: vector.slot, requestId }), vector.record);
  }
});

test('one golden daemon frame hash pins the whole layout against silent drift', () => {
  const vector = fixture.reconciliationPairs.find(({ id }) => id === 'revision-applied-pair');
  const options = { ...base, requestId: vector.record.record.requestId, slot: 'terminal-pair' };
  const frame = encode(Buffer.from(vector.canonicalJson), options);
  assert.equal(hash(frame).toString('hex'), '0437c09c6b4cdc041ccc0a19a2102a3be60c9ca17b12b2ffa8e3f35c378d0128');
});

test('a broker-role or role-free frame is rejected in a daemon slot even with recomputed checksums', () => {
  for (const { slot, cap, id } of slots) {
    const options = { ...base, slot }, payload = Buffer.from('test');
    for (const role of ['broker', null]) invalid(() => decode(referenceFrame(payload, { id, cap, context: contextFor(role, slot) }), options));
    // No option can select another producer role.
    assert(encode(payload, { ...options, role: 'broker' }).equals(encode(payload, options)));
  }
  // The broker's acceptance slot is ID 1 at cap 4096 too; its frame still fails here.
  const brokerAcceptance = referenceFrame(Buffer.from('{}'), { id: 1, cap: 4096, context: contextFor('broker', 'acceptance') });
  invalid(() => decode(brokerAcceptance, { ...base, slot: 'acceptance-context' }));
  invalid(() => decode(brokerAcceptance, { ...base, slot: 'acceptance' }));
});

test('every bit-corrupted byte and every strict prefix refuses instead of selecting an older or empty state', () => {
  const options = { ...base, slot: 'presence' }, frame = encode(Buffer.from('p1.test'), options);
  for (let offset = 0; offset < frame.length; offset++) for (let bit = 0; bit < 8; bit++) {
    const corrupt = Buffer.from(frame); corrupt[offset] ^= 1 << bit; invalid(() => decode(corrupt, options));
  }
  for (let length = 0; length < frame.length; length++) invalid(() => decode(frame.subarray(0, length), options));
  invalid(() => decode(Buffer.concat([frame, Buffer.from([0])]), options));
});

test('initialized zeros and a complete body without trailer stay distinct noncommitted states', () => {
  for (const { slot, cap } of slots) {
    const options = { ...base, slot };
    assert.deepEqual(decode(Buffer.alloc(cap + 256), options), { kind: 'empty', slot });
    const body = encode(Buffer.from('test'), options); body.fill(0, cap + 128);
    assert.deepEqual(decode(body, options), { kind: 'uncommitted', slot });
    body[0] ^= 1; invalid(() => decode(body, options));
  }
});

test('cross request, namespace and slot bindings, suffixes and coercions fail with one fixed diagnostic', () => {
  const options = { ...base, slot: 'acceptance-context' }, frame = encode(Buffer.from('test'), options);
  for (const change of [{ requestId: '22222222-2222-4222-8222-222222222222' }, { namespaceDigest: 'b'.repeat(64) },
    { slot: 'receipt' }, { requestId: `${base.requestId}\n` }, { namespaceDigest: `${base.namespaceDigest}\n` },
    { slot: 'acceptance-context\n' }, { slot: 'scratch' }, { slot: 'unknown' }, { requestId: 'AAAAAAAA-1111-4111-8111-111111111111' },
    { requestId: '11111111-1111-1111-8111-111111111111' }]) invalid(() => decode(frame, { ...options, ...change }));
  for (const bad of [null, {}, 'secret-canary', new DataView(new ArrayBuffer(10))]) {
    invalid(() => decode(bad, options)); invalid(() => encode(bad, options));
  }
  invalid(() => decode(frame, { get slot() { throw new Error('secret-canary'); } }));
  invalid(() => encode(new Uint8Array(0), options));
});

test('inputs and results are independent snapshots without calling overridden typed-array accessors', () => {
  class Bytes extends Uint8Array { get byteLength() { throw new Error('secret-canary'); } }
  const payload = new Bytes([1, 2, 3]), options = { ...base, slot: 'receipt' }, frame = encode(payload, options);
  payload.fill(0); const result = decode(new Bytes(frame), options);
  assert.deepEqual(result.payload, Buffer.from([1, 2, 3]));
  frame.fill(0); assert.deepEqual(result.payload, Buffer.from([1, 2, 3]));
});

test('the request directory is the SHA-256 of canonical namespace/request, never a parsed request ID', () => {
  const expected = hash(Buffer.from(`{"namespaceDigest":"${base.namespaceDigest}","requestId":"${base.requestId}","v":1}`)).toString('hex');
  assert.equal(requestDirectoryName(base), expected);
  assert.notEqual(requestDirectoryName({ ...base, namespaceDigest: 'b'.repeat(64) }), expected);
  for (const bad of [{ ...base, requestId: `${base.requestId}\n` }, { ...base, namespaceDigest: 'A'.repeat(64) }, {}]) {
    invalid(() => requestDirectoryName(bad));
  }
});

const vector = (id) => structuredClone(fixture.reconciliationPairs.find((entry) => entry.id === id).record);

test('pair findings are fixed per slot and nullable proof fields are allowed only while indeterminate', () => {
  invalid(() => encodePair(vector('revision-indeterminate-pair'), { slot: 'terminal-pair' }));
  invalid(() => encodePair(vector('cold-applied-pair'), { slot: 'observation-pair' }));
  invalid(() => encodePair(vector('cold-refused-pair'), { slot: 'acceptance-context' }));
  const unprepared = vector('cold-indeterminate-pair'); unprepared.record.effectId = null;
  assert.equal(decodePair(encodePair(unprepared, { slot: 'observation-pair' }), { slot: 'observation-pair' }).record.effectId, null);
  const withBasis = vector('revision-indeterminate-pair'); withBasis.record.basisDigest = 'e'.repeat(64);
  encodePair(withBasis, { slot: 'observation-pair' });
  for (const field of ['effectId', 'basisDigest']) {
    const terminal = vector('revision-applied-pair'); terminal.record[field] = null;
    invalid(() => encodePair(terminal, { slot: 'terminal-pair' }));
  }
});

test('pairs are digest-bound, request-bound, exact-key and strictly canonical', () => {
  const slot = 'terminal-pair', good = vector('revision-refused-pair'), requestId = good.record.requestId;
  const bytes = encodePair(good, { slot, requestId });
  invalid(() => decodePair(bytes, { slot, requestId: base.requestId }));
  const drifted = vector('revision-refused-pair'); drifted.preimage.head.seq -= 1;
  invalid(() => encodePair(drifted, { slot }));
  for (const mutate of [(pair) => { pair.extra = 1; }, (pair) => { pair.v = 2; }, (pair) => { pair.record.extra = null; },
    (pair) => { delete pair.preimage.working; }, (pair) => { pair.record.originalDaemonEpoch = 0; },
    (pair) => { pair.record.kind = 'reconciliation-reference'; }, (pair) => { pair.record.payloadDigest = pair.record.payloadDigest.toUpperCase(); }]) {
    const pair = vector('revision-refused-pair'); mutate(pair); invalid(() => encodePair(pair, { slot }));
  }
  const text = bytes.toString('utf8');
  for (const variant of [` ${text}`, `${text}\n`, text.replace('{"preimage":', '{ "preimage":'),
    text.replace('"v":1}', '"v":1.0}'), text.replace(/,"v":1\}$/u, ',"v":1,"v":1}'), `\ufeff${text}`]) {
    invalid(() => decodePair(Buffer.from(variant), { slot, requestId }));
  }
  invalid(() => decodePair(Buffer.from([0xff, ...bytes]), { slot, requestId }));
  invalid(() => decodePair(Buffer.alloc(PAIR_LIMITS.pair + 1, 0x20), { slot, requestId }));
  // A cold preimage cannot borrow revision fields, and settings stay in their typed set.
  const cold = vector('cold-indeterminate-pair'); cold.preimage.setting = { mode: 'resume', policy: 'everything' };
  invalid(() => encodePair(cold, { slot: 'observation-pair' }));
});
