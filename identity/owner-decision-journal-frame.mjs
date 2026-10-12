// Disabled daemon owner-decision journal codec (#1007, agent-comms#77). Pure
// bytes only: no files, locks, routes or authority. The contract is agent-comms
// docs/owner-decision-journal-{records,fixed-slots}.md at 6b90f82 (merged #199); this is the
// daemon's own implementation and never imports the broker codec. The producer
// role is the literal 'daemon' below, never an option, so a frame bound to any
// other role (or none) fails its context digest even with valid checksums.
import { createHash } from 'node:crypto';
import { canonicalJson } from '../canonical-json.mjs';
import { exactBytes } from './owner-decision-bytes.mjs';

// Exact daemon u16 IDs, names and payload caps from the producer slot table.
export const DAEMON_JOURNAL_SLOTS = Object.freeze([
  ['acceptance-context', 4096], ['original-action', 32768], ['prepared-challenge', 32768],
  ['presence', 4096], ['receipt', 4096], ['preparation', 4096], ['successful-check', 4096],
  ['pre-effect-refused', 4096], ['entered', 4096], ['completed', 4096],
  ['observation-pair', 4352], ['terminal-pair', 4352],
  ['linked-authoritative-event', 16384], ['local-lifecycle-outcome', 4096],
].map(([slot, cap], index) => Object.freeze({ slot, cap, id: index + 1 })));
export const FRAME_OVERHEAD = 256;
// The one scratch inode per request: the largest cap plus its framing.
export const SCRATCH_BYTES = 32768 + FRAME_OVERHEAD;
// Fourteen `<slot>.record` names plus scratch; nothing else is a journal file.
export const DAEMON_JOURNAL_FILES = Object.freeze([...DAEMON_JOURNAL_SLOTS.map(({ slot }) => `${slot}.record`), 'scratch.record']);
export const PAIR_LIMITS = Object.freeze({ record: 2048, preimage: 2048, wrapper: 256, pair: 4352 });

const ROLE = 'daemon';
const HEADER_MAGIC = Buffer.from('ODJSLOT1', 'ascii');
const TRAILER_MAGIC = Buffer.from('ODJCOM01', 'ascii');
const FRAME_DOMAIN = Buffer.from('owner-journal-frame-v1\n', 'ascii');

const hash = (bytes) => createHash('sha256').update(bytes).digest();
const invalid = () => Object.assign(new Error('invalid-owner-journal-frame'), { code: 'invalid-owner-journal-frame' });
const fail = () => { throw invalid(); };
// `pattern.exec(value)[0] === value` refuses a trailing newline `$` would allow.
const matches = (pattern, value) => typeof value === 'string' && pattern.exec(value)?.[0] === value;
const UUID4 = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const DIGEST = /^[a-f0-9]{64}$/;
const REVISION = /^sha256:[a-f0-9]{64}$/;
const zeros = (bytes) => bytes.every((byte) => byte === 0);

// A private copy of the input's intrinsic bytes (owner-decision-bytes.mjs).
function snapshot(bytes, max) {
  return exactBytes(bytes, { max }) ?? fail();
}

function slotDescriptor(slot) {
  return DAEMON_JOURNAL_SLOTS.find((entry) => entry.slot === slot) ?? fail();
}

function binding(options) {
  const { slot, requestId, namespaceDigest } = options;
  const descriptor = slotDescriptor(slot);
  if (!matches(UUID4, requestId) || !matches(DIGEST, namespaceDigest)) fail();
  return { ...descriptor, context: hash(Buffer.from(canonicalJson({ namespaceDigest, requestId, role: ROLE, slot, v: 1 }))) };
}

function frameHash(header, body) {
  return hash(Buffer.concat([FRAME_DOMAIN, header, body]));
}

// The daemon request directory name: one fixed 64-hex name per enrolled
// namespace/request tuple. It is a hash, never parsed back into a request ID.
export function requestDirectoryName({ namespaceDigest, requestId }) {
  if (!matches(UUID4, requestId) || !matches(DIGEST, namespaceDigest)) fail();
  return hash(Buffer.from(canonicalJson({ namespaceDigest, requestId, v: 1 }))).toString('hex');
}

// A complete committed frame: 128-byte header, payload padded to the slot's
// fixed cap, 128-byte commit trailer. Every slot is immutable (sequence 1)
// except observation replacement, which a later reviewed recovery API owns.
export function encodeDaemonJournalFrame(payloadBytes, options) {
  try {
    const b = binding(options);
    const payload = snapshot(payloadBytes, b.cap);
    const bytes = Buffer.alloc(b.cap + FRAME_OVERHEAD);
    const header = bytes.subarray(0, 128), body = bytes.subarray(128, 128 + b.cap), trailer = bytes.subarray(128 + b.cap);
    HEADER_MAGIC.copy(header, 0); header.writeUInt16BE(1, 8); header.writeUInt16BE(b.id, 10);
    header.writeUInt32BE(b.cap, 16); header.writeUInt32BE(payload.length, 20); header.writeBigUInt64BE(1n, 24);
    b.context.copy(header, 32); hash(payload).copy(header, 64); payload.copy(body);
    TRAILER_MAGIC.copy(trailer, 0); trailer.writeUInt16BE(1, 8); trailer.writeUInt16BE(b.id, 10);
    trailer.writeBigUInt64BE(1n, 16); trailer.writeUInt32BE(payload.length, 24);
    frameHash(header, body).copy(trailer, 32); b.context.copy(trailer, 64);
    return bytes;
  } catch { fail(); }
}

// `empty` is an initialized all-zero slot: no committed record, never proof
// that no effect happened. `uncommitted` is a valid body without its trailer.
// Anything else that is not an exact committed frame for this binding throws.
export function decodeDaemonJournalFrame(frameBytes, options) {
  try {
    const b = binding(options);
    const bytes = snapshot(frameBytes, b.cap + FRAME_OVERHEAD);
    if (bytes.length !== b.cap + FRAME_OVERHEAD) fail();
    if (zeros(bytes)) return { kind: 'empty', slot: b.slot };
    const header = bytes.subarray(0, 128), body = bytes.subarray(128, 128 + b.cap), trailer = bytes.subarray(128 + b.cap);
    const length = header.readUInt32BE(20);
    if (!header.subarray(0, 8).equals(HEADER_MAGIC) || header.readUInt16BE(8) !== 1
      || header.readUInt16BE(10) !== b.id || header.readUInt32BE(12) !== 0
      || header.readUInt32BE(16) !== b.cap || length < 1 || length > b.cap
      || header.readBigUInt64BE(24) !== 1n || !header.subarray(32, 64).equals(b.context)
      || !zeros(header.subarray(96)) || !zeros(body.subarray(length))
      || !header.subarray(64, 96).equals(hash(body.subarray(0, length)))) fail();
    if (zeros(trailer)) return { kind: 'uncommitted', slot: b.slot };
    if (!trailer.subarray(0, 8).equals(TRAILER_MAGIC) || trailer.readUInt16BE(8) !== 1
      || trailer.readUInt16BE(10) !== b.id || trailer.readUInt32BE(12) !== 0
      || trailer.readBigUInt64BE(16) !== 1n || trailer.readUInt32BE(24) !== length
      || trailer.readUInt32BE(28) !== 0 || !zeros(trailer.subarray(96))
      || !trailer.subarray(64, 96).equals(b.context)
      || !trailer.subarray(32, 64).equals(frameHash(header, body))) fail();
    return { kind: 'committed', slot: b.slot, payload: Buffer.from(body.subarray(0, length)), sha256: hash(bytes).toString('hex') };
  } catch { fail(); }
}

// Phase one of reading acceptance-context, whose request ID is not known from
// its hashed directory: integrity only, without the context binding. Header
// and trailer contexts must agree with each other, but nothing proves they
// are ours, so the payload is untrusted. The caller must validate its schema,
// recompute the directory name from its trusted enrolled namespace, and then
// decode the frame again with the full binding before using anything.
export function peekAcceptanceContextFrame(frameBytes) {
  try {
    const { id, cap } = slotDescriptor('acceptance-context');
    const bytes = snapshot(frameBytes, cap + FRAME_OVERHEAD);
    if (bytes.length !== cap + FRAME_OVERHEAD || zeros(bytes)) fail();
    const header = bytes.subarray(0, 128), body = bytes.subarray(128, 128 + cap), trailer = bytes.subarray(128 + cap);
    const length = header.readUInt32BE(20);
    if (!header.subarray(0, 8).equals(HEADER_MAGIC) || header.readUInt16BE(8) !== 1 || header.readUInt16BE(10) !== id
      || header.readUInt32BE(12) !== 0 || header.readUInt32BE(16) !== cap || length < 1 || length > cap
      || header.readBigUInt64BE(24) !== 1n || !zeros(header.subarray(96)) || !zeros(body.subarray(length))
      || !header.subarray(64, 96).equals(hash(body.subarray(0, length)))) fail();
    if (!trailer.subarray(0, 8).equals(TRAILER_MAGIC) || trailer.readUInt16BE(8) !== 1 || trailer.readUInt16BE(10) !== id
      || trailer.readUInt32BE(12) !== 0 || trailer.readBigUInt64BE(16) !== 1n || trailer.readUInt32BE(24) !== length
      || trailer.readUInt32BE(28) !== 0 || !zeros(trailer.subarray(96))
      || !trailer.subarray(64, 96).equals(header.subarray(32, 64))
      || !trailer.subarray(32, 64).equals(frameHash(header, body))) fail();
    return { untrustedPayload: Buffer.from(body.subarray(0, length)) };
  } catch { fail(); }
}

// --- Paired reconciliation payloads (observation-pair, terminal-pair) ---

const exactKeys = (value, keys) => value !== null && typeof value === 'object' && !Array.isArray(value)
  && Object.getPrototypeOf(value) === Object.prototype
  && canonicalJson(Object.keys(value).sort()) === canonicalJson([...keys].sort());
const safeSeconds = (value) => Number.isSafeInteger(value) && value >= 0;
const epoch = (value) => Number.isSafeInteger(value) && value > 0;
const seq = (value) => Number.isInteger(value) && value >= 0 && value <= 9_999_999_999;
const nullOr = (value, check) => value === null || check(value);
const digest = (value) => matches(DIGEST, value);
const revision = (value) => matches(REVISION, value);
const RESUME_HARNESSES = ['codex', 'opencode', 'devin', 'grok'];

function reconciliation(record, finding) {
  return exactKeys(record, ['v', 'kind', 'requestId', 'payloadDigest', 'effectId', 'auditId', 'originalDaemonKey',
    'originalDaemonEpoch', 'reportingDaemonKey', 'reportingDaemonEpoch', 'at', 'finding', 'basisDigest', 'observedDigest'])
    && record.v === 1 && record.kind === 'reconciliation' && matches(UUID4, record.requestId)
    && digest(record.payloadDigest) && matches(UUID4, record.auditId)
    && digest(record.originalDaemonKey) && epoch(record.originalDaemonEpoch)
    && digest(record.reportingDaemonKey) && epoch(record.reportingDaemonEpoch)
    && safeSeconds(record.at) && digest(record.observedDigest) && finding(record.finding)
    // effectId/basisDigest may be null only while the finding is indeterminate.
    && (record.finding === 'indeterminate'
      ? nullOr(record.effectId, (id) => matches(UUID4, id)) && nullOr(record.basisDigest, digest)
      : matches(UUID4, record.effectId) && digest(record.basisDigest));
}

function revisionObservation(value) {
  return exactKeys(value, ['v', 'head', 'proposal', 'working']) && value.v === 1
    && nullOr(value.head, (head) => exactKeys(head, ['seq', 'revision']) && seq(head.seq) && revision(head.revision))
    && nullOr(value.proposal, (proposal) => exactKeys(proposal, ['proposalId', 'seq', 'revision', 'parentRevision'])
      && matches(UUID4, proposal.proposalId) && seq(proposal.seq) && revision(proposal.revision) && revision(proposal.parentRevision))
    && nullOr(value.working, (working) => exactKeys(working, ['rootDigest', 'inventoryDigest'])
      && digest(working.rootDigest) && digest(working.inventoryDigest));
}

function coldSetting(setting) {
  if (exactKeys(setting, ['mode'])) return ['off', 'on', 'webhook'].includes(setting.mode);
  return exactKeys(setting, ['mode', 'policy']) && setting.mode === 'resume' && ['read-only', 'workspace'].includes(setting.policy);
}

function coldObservation(value) {
  return exactKeys(value, ['v', 'setting', 'webhookDigest', 'resume']) && value.v === 1
    && coldSetting(value.setting) && nullOr(value.webhookDigest, digest)
    && nullOr(value.resume, (resume) => exactKeys(resume, ['harness', 'sessionDigest', 'toolHomeDigest', 'destinationDigest'])
      && RESUME_HARNESSES.includes(resume.harness) && nullOr(resume.sessionDigest, digest)
      && digest(resume.toolHomeDigest) && digest(resume.destinationDigest));
}

const FINDINGS = Object.freeze({
  'observation-pair': (finding) => finding === 'indeterminate',
  'terminal-pair': (finding) => finding === 'applied' || finding === 'refused',
});

// Strict canonical JSON: exact UTF-8 bytes that re-serialize identically, so
// duplicate keys, whitespace, escapes and number spellings all refuse.
// Returns the parsed value with its own byte snapshot.
export function decodeCanonicalPayload(payloadBytes, max) {
  try { const bytes = snapshot(payloadBytes, max); return { value: parseCanonical(bytes), bytes }; } catch { fail(); }
}

function parseCanonical(bytes) {
  const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  const value = JSON.parse(text);
  if (canonicalJson(value) !== text) fail();
  return value;
}

function checkPair(pair, slot, requestId) {
  const finding = FINDINGS[slot] ?? fail();
  if (!exactKeys(pair, ['v', 'record', 'preimage']) || pair.v !== 1) fail();
  const record = Buffer.from(canonicalJson(pair.record)), preimage = Buffer.from(canonicalJson(pair.preimage));
  const bytes = Buffer.from(canonicalJson(pair));
  if (record.length > PAIR_LIMITS.record || preimage.length > PAIR_LIMITS.preimage
    || bytes.length > PAIR_LIMITS.pair || bytes.length - record.length - preimage.length > PAIR_LIMITS.wrapper) fail();
  if (!reconciliation(pair.record, finding) || !(revisionObservation(pair.preimage) || coldObservation(pair.preimage))) fail();
  if (pair.record.observedDigest !== hash(preimage).toString('hex')) fail();
  if (requestId !== undefined && pair.record.requestId !== requestId) fail();
  return bytes;
}

// The exact canonical `{preimage,record,v:1}` payload bytes for a pair slot.
// `requestId`, when given, must be the request the frame is bound to.
export function encodeReconciliationPair(pair, { slot, requestId } = {}) {
  try { return checkPair(pair, slot, requestId); } catch { fail(); }
}

export function decodeReconciliationPair(payloadBytes, { slot, requestId } = {}) {
  try {
    const bytes = snapshot(payloadBytes, PAIR_LIMITS.pair);
    const pair = parseCanonical(bytes);
    if (!checkPair(pair, slot, requestId).equals(bytes)) fail();
    return pair;
  } catch { fail(); }
}
