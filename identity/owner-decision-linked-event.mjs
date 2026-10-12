// Disabled owner-decision linkage to the authoritative soul revision journal
// (#1007, agent-comms#77): slot 13 `linked-authoritative-event`. Pure checks
// only. The local revision writer emits the `ownerDecision` field when an
// owner-decision operation passes it (soul-revisions.mjs); nothing passes it
// yet.
//
// The slot retains the exact source-event bytes the revision journal wrote
// (`JSON.stringify(record) + '\n'`), at most 16384 bytes. A cold-wake change
// has no authoritative journal event, so its slot stays empty.
import { createHash } from 'node:crypto';
import { DAEMON_JOURNAL_SLOTS } from './owner-decision-journal-frame.mjs';
import { exactBytes, intrinsicByteLength } from './owner-decision-bytes.mjs';

export const LINKED_EVENT_CAP = DAEMON_JOURNAL_SLOTS.find(({ slot }) => slot === 'linked-authoritative-event').cap;
// The writer stamps `at` with Date#toISOString, up to 27 characters for
// extended years; bound with that worst case, never the current clock.
const WORST_AT = '+275760-09-13T00:00:00.000Z';
const LINKED_OPERATIONS = Object.freeze({
  'revision.approve': 'revision', 'revision.reject': 'decision', 'revision.adopt': 'revision', 'revision.edit': 'revision',
});

const UUID4 = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const DIGEST = /^[a-f0-9]{64}$/;
const REVISION = /^sha256:[a-f0-9]{64}$/;
const matches = (pattern, value) => typeof value === 'string' && pattern.exec(value)?.[0] === value;
const plain = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const refuse = (reason) => { throw Object.assign(new Error('owner decision linked event refused'), { code: 'bad-request', reason }); };
const LINKAGE_KEYS = ['requestId', 'payloadDigest', 'receiptDigest', 'effectId', 'preparationDigest'];

// The request linkage the event must carry: exactly these five fields.
function linkage(value) {
  if (!plain(value) || Object.keys(value).length !== LINKAGE_KEYS.length || !LINKAGE_KEYS.every((key) => Object.hasOwn(value, key))
    || !matches(UUID4, value.requestId) || !matches(UUID4, value.effectId) || !matches(DIGEST, value.payloadDigest)
    || !matches(DIGEST, value.receiptDigest) || !matches(DIGEST, value.preparationDigest)) refuse('owner-decision-linkage-invalid');
  return value;
}

function kindFor(operation) {
  if (operation === 'cold-wake.set') refuse('owner-decision-cold-has-no-linked-event');
  return LINKED_OPERATIONS[operation] ?? refuse('owner-decision-operation-invalid');
}

// Before entering: the complete event the adapter would append, including
// copied legacy text such as approve's unbounded proposal reason, must fit
// the slot once written. Otherwise refuse, so the existing local ceremony
// stays the path for that change; never truncate or rewrite legacy input.
export function assertLinkedEventFits(operation, event) {
  const kind = kindFor(operation);
  if (!plain(event) || event.kind !== kind || Object.hasOwn(event, 'schemaVersion') || Object.hasOwn(event, 'at')) {
    refuse('owner-decision-linked-event-invalid');
  }
  linkage(event.ownerDecision);
  const bytes = Buffer.byteLength(`${JSON.stringify({ schemaVersion: 1, ...event, at: WORST_AT })}\n`);
  if (bytes > LINKED_EVENT_CAP) refuse('owner-decision-linked-event-too-large');
  return bytes;
}

// After completion: the slot payload must be exactly the authoritative
// journal record (same bytes as the journal file the caller read under the
// revision lock, whose digest `completed` records), written by the existing
// writer, of the operation's kind and carrying exactly this request linkage.
// A coincidentally matching unlinked legacy event proves nothing.
export function verifyLinkedEvent(payloadBytes, { operation, journalBytes, journalRecordDigest, linkage: expected, proposalId }) {
  const kind = kindFor(operation);
  linkage(expected);
  // Intrinsic lengths checked before any copy, then private copies of both
  // inputs' intrinsic bytes; never their own (overridable) lengths.
  const length = intrinsicByteLength(payloadBytes), journalLength = intrinsicByteLength(journalBytes);
  if (length === null || journalLength === null) refuse('owner-decision-linked-event-invalid');
  if (length < 1 || length > LINKED_EVENT_CAP || journalLength !== length) refuse('owner-decision-linked-event-mismatch');
  const bytes = exactBytes(payloadBytes, { max: LINKED_EVENT_CAP }), journal = exactBytes(journalBytes, { max: LINKED_EVENT_CAP });
  if (!bytes.equals(journal)
    || !matches(DIGEST, journalRecordDigest) || createHash('sha256').update(bytes).digest('hex') !== journalRecordDigest) {
    refuse('owner-decision-linked-event-mismatch');
  }
  let event;
  try {
    const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
    event = JSON.parse(text);
    // Exactly the writer's own serialization, so no alternate spelling passes.
    if (!plain(event) || `${JSON.stringify(event)}\n` !== text) throw new Error();
  } catch { refuse('owner-decision-linked-event-invalid'); }
  if (event.schemaVersion !== 1 || event.kind !== kind || typeof event.at !== 'string'
    || Number.isNaN(Date.parse(event.at)) || new Date(event.at).toISOString() !== event.at) refuse('owner-decision-linked-event-invalid');
  const linked = event.ownerDecision;
  if (!plain(linked) || Object.keys(linked).length !== LINKAGE_KEYS.length
    || !LINKAGE_KEYS.every((key) => Object.hasOwn(linked, key) && linked[key] === expected[key])) refuse('owner-decision-linkage-mismatch');
  if (operation === 'revision.approve' || operation === 'revision.reject') {
    if (!matches(UUID4, proposalId) || event.proposalId !== proposalId) refuse('owner-decision-linkage-mismatch');
  }
  if (kind === 'revision' && !matches(REVISION, event.revision)) refuse('owner-decision-linked-event-invalid');
  return event;
}

// The slot's required state for an operation: cold-wake changes keep it
// all-zero; linked revision operations require it once completed.
export function linkedEventRequired(operation) {
  if (operation === 'cold-wake.set') return false;
  kindFor(operation);
  return true;
}
