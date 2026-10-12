// Disabled owner-decision linkage to the revision journal (#1007).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import {
  LINKED_EVENT_CAP, assertLinkedEventFits, linkedEventRequired, verifyLinkedEvent,
} from '../identity/owner-decision-linked-event.mjs';

const proposalId = '0e1f2a3b-4c5d-4e6f-8a9b-0c1d2e3f4a5b';
const linkage = {
  requestId: '11111111-1111-4111-8111-111111111111', payloadDigest: 'a'.repeat(64), receiptDigest: 'b'.repeat(64),
  effectId: '22222222-2222-4222-8222-222222222222', preparationDigest: 'c'.repeat(64),
};
const approve = (reason = 'Proposed change', approvalReason = 'Looks right') => ({
  kind: 'revision', revision: `sha256:${'d'.repeat(64)}`, parentRevision: `sha256:${'e'.repeat(64)}`, author: 'soul', reason,
  proposalId, approval: 'user', approvedBy: 'user', approvalReason, ownerDecision: { ...linkage },
});
// Exactly what soul-revisions' append() writes for an event.
const written = (event, at = new Date(1_800_000_000_000)) => Buffer.from(`${JSON.stringify({ schemaVersion: 1, ...event, at: at.toISOString() })}\n`);
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
const refused = (reason) => ({ code: 'bad-request', reason });
const verify = (bytes, overrides = {}) => verifyLinkedEvent(bytes, {
  operation: 'revision.approve', journalBytes: bytes, journalRecordDigest: digest(bytes), linkage, proposalId, ...overrides,
});

test('the linked event slot is the 16384-byte contract cap and the writer format it assumes is unchanged', () => {
  assert.equal(LINKED_EVENT_CAP, 16384);
  // Tripwire: if the revision writer's serialization or clock stamp changes,
  // this linkage must be reviewed with it.
  const writer = readFileSync(new URL('../soul-revisions.mjs', import.meta.url), 'utf8');
  assert(writer.includes("const record = { schemaVersion: 1, ...event, at: (options.now ?? (() => new Date()))().toISOString() };"));
  assert(writer.includes("writeFileSync(fd, JSON.stringify(record) + '\\n')"));
});

test('cold-wake changes have no linked event; revision operations require one', () => {
  assert.equal(linkedEventRequired('cold-wake.set'), false);
  for (const operation of ['revision.approve', 'revision.reject', 'revision.adopt', 'revision.edit']) assert.equal(linkedEventRequired(operation), true);
  assert.throws(() => linkedEventRequired('revision.merge'), refused('owner-decision-operation-invalid'));
  assert.throws(() => assertLinkedEventFits('cold-wake.set', approve()), refused('owner-decision-cold-has-no-linked-event'));
  const bytes = written(approve());
  assert.throws(() => verify(bytes, { operation: 'cold-wake.set' }), refused('owner-decision-cold-has-no-linked-event'));
});

test('an approve whose copied legacy reason would overflow the slot refuses before entering, at the exact boundary', () => {
  assert(assertLinkedEventFits('revision.approve', approve()) < LINKED_EVENT_CAP);
  const overhead = assertLinkedEventFits('revision.approve', approve(''));
  const fits = 'r'.repeat(LINKED_EVENT_CAP - overhead);
  assert.equal(assertLinkedEventFits('revision.approve', approve(fits)), LINKED_EVENT_CAP);
  assert.throws(() => assertLinkedEventFits('revision.approve', approve(`${fits}r`)), refused('owner-decision-linked-event-too-large'));
  // Escapes count as written, not as decoded characters.
  assert.throws(() => assertLinkedEventFits('revision.approve', approve('"'.repeat(LINKED_EVENT_CAP / 2))), refused('owner-decision-linked-event-too-large'));
  // The worst-case clock stamp, not today's, is what is bounded.
  const worst = written(approve(fits), new Date(8.64e15));
  assert.equal(worst.length, LINKED_EVENT_CAP);
  assert.throws(() => assertLinkedEventFits('revision.approve', { ...approve(), ownerDecision: undefined }), refused('owner-decision-linkage-invalid'));
  assert.throws(() => assertLinkedEventFits('revision.approve', { ...approve(), at: 'now' }), refused('owner-decision-linked-event-invalid'));
  assert.throws(() => assertLinkedEventFits('revision.reject', approve()), refused('owner-decision-linked-event-invalid'));
});

test('a retained event verifies only as the exact journal bytes carrying exactly this request linkage', () => {
  const bytes = written(approve());
  assert.deepEqual(verify(bytes).ownerDecision, linkage);
  const reject = { kind: 'decision', proposalId, author: 'user', reason: 'No', ownerDecision: { ...linkage } };
  assert.equal(verify(written(reject), { operation: 'revision.reject' }).kind, 'decision');
  const cases = [
    ['different journal bytes', bytes, { journalBytes: written(approve('other')) }, 'owner-decision-linked-event-mismatch'],
    ['wrong record digest', bytes, { journalRecordDigest: 'f'.repeat(64) }, 'owner-decision-linked-event-mismatch'],
    ['an unlinked legacy event', written({ ...approve(), ownerDecision: undefined }), {}, 'owner-decision-linkage-mismatch'],
    ['another request', written({ ...approve(), ownerDecision: { ...linkage, requestId: '33333333-3333-4333-8333-333333333333' } }), {}, 'owner-decision-linkage-mismatch'],
    ['an extra linkage field', written({ ...approve(), ownerDecision: { ...linkage, extra: 1 } }), {}, 'owner-decision-linkage-mismatch'],
    ['another proposal', bytes, { proposalId: '44444444-4444-4444-8444-444444444444' }, 'owner-decision-linkage-mismatch'],
    ['the wrong kind', written(reject), {}, 'owner-decision-linked-event-invalid'],
    ['a non-writer spelling', Buffer.from(bytes.toString().replace('{"schemaVersion":1', '{ "schemaVersion":1')), {}, 'owner-decision-linked-event-invalid'],
    ['no trailing newline', bytes.subarray(0, bytes.length - 1), {}, 'owner-decision-linked-event-invalid'],
    ['a bad timestamp', written({ ...approve() }).toString().replace(/"at":"[^"]+"/u, '"at":"yesterday"'), {}, 'owner-decision-linked-event-invalid'],
    ['an oversized event', written(approve('r'.repeat(LINKED_EVENT_CAP))), {}, 'owner-decision-linked-event-mismatch'],
    ['invalid UTF-8', Buffer.concat([bytes.subarray(0, 20), Buffer.from([0xff]), bytes.subarray(20)]), {}, 'owner-decision-linked-event-invalid'],
  ];
  for (const [name, payload, overrides, reason] of cases) {
    const raw = typeof payload === 'string' ? Buffer.from(payload) : payload;
    assert.throws(() => verify(raw, { journalBytes: raw, journalRecordDigest: digest(raw), ...overrides }), refused(reason), name);
  }
  assert.throws(() => verify(bytes, { linkage: { ...linkage, effectId: 'x' } }), refused('owner-decision-linkage-invalid'));
  assert.throws(() => verifyLinkedEvent('not bytes', { operation: 'revision.approve', journalBytes: bytes, journalRecordDigest: digest(bytes), linkage, proposalId }),
    refused('owner-decision-linked-event-invalid'));
});
