// Disabled owner-decision trust records (#1007, agent-comms#77, ADR-0077 §4–5):
// the daemon's pinned broker namespace and its versioned receipt/presence key
// pins. Nothing routes here and no ceremony is wired: the writer below is for
// the future local owner installation ceremony only, and a record that merely
// parses grants nothing. Comms pairing (comms-daemon.json) and the vouch key
// are separate and untouched.
//
// Honest limits:
// - Flushes are node's logical fsync. On Darwin it may silently fall back from
//   F_FULLFSYNC, so nothing here claims a physical durability guarantee.
// - The hash chain detects gaps, forks and edits inside one snapshot. It cannot
//   detect a restore of a complete older snapshot, nor deletion of a complete
//   suffix (truncation back to an earlier valid chain, its confirmations and
//   audit lines). Either could bring back a revoked key, so the broker's
//   online revocation check before application stays mandatory.
import * as fs from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { createHash, createPublicKey, randomUUID } from 'node:crypto';
import { canonicalJson } from '../canonical-json.mjs';
import { vouchDaemonKey } from './vouch.mjs';
import { presencePinPath } from './owner-presence.mjs';

export const TRUST_LIMITS = Object.freeze({ versions: 1024, record: 1024, confirmation: 512, auditLine: 512 });
// One namespace line plus one line per key version; reconcile appends only
// when no matching line exists, so there is never more than one per record.
const AUDIT_LINES = 1 + TRUST_LIMITS.versions;
const AUDIT_BYTES = AUDIT_LINES * TRUST_LIMITS.auditLine;
const LOCK = '.trust-lock';
const NAMESPACE = 'namespace.json';
const NAMESPACE_CONFIRMATION = 'namespace.confirm.json';
const AUDIT = 'audit.jsonl';
const KEYS = 'keys';
const PENDING = '.pending.json';
const ROOT_NAMES = new Set([LOCK, NAMESPACE, NAMESPACE_CONFIRMATION, AUDIT, KEYS]);
const O_EXLOCK = 0x20; // Apple xnu-8792.61.2 bsd/sys/fcntl.h (macOS 13 era), flock semantics.
const { O_RDONLY, O_WRONLY, O_RDWR, O_CREAT, O_EXCL, O_APPEND, O_NOFOLLOW, O_NONBLOCK } = fs.constants;
const O_DIRECTORY = fs.constants.O_DIRECTORY ?? 0;
const O_CLOEXEC = fs.constants.O_CLOEXEC ?? 0;
// Ed25519 SubjectPublicKeyInfo DER is this fixed prefix and the raw key; key
// IDs are SHA-256 of that DER, exactly as agent-comms derives them.
const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

const UUID4 = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const DIGEST = /^[a-f0-9]{64}$/;
const KEY = /^[A-Za-z0-9_-]{43}$/;
const KEY_FILE = /^(\d{10})(\.confirm)?\.json$/;
const REASONS = new Set(['rotated', 'compromised', 'decommissioned']);
const matches = (pattern, value) => typeof value === 'string' && pattern.exec(value)?.[0] === value;
const plain = (value) => value !== null && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
const exact = (value, keys) => plain(value) && Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
const seconds = (value) => Number.isSafeInteger(value) && value >= 0;
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const keyFile = (version, confirmation = false) => `${String(version).padStart(10, '0')}${confirmation ? '.confirm' : ''}.json`;

const PUBLIC = Object.freeze({
  'owner-trust-missing': 'owner-decision-unsupported',
  'owner-trust-no-active-key': 'owner-decision-unsupported',
  'owner-trust-platform-unsupported': 'owner-decision-unsupported',
  'owner-trust-invalid-input': 'bad-request',
  'owner-trust-conflict': 'conflict',
  'owner-trust-role': 'owner-decision-unsupported',
  'owner-trust-no-vouch-key': 'owner-decision-unsupported',
  'owner-trust-daemon-key-mismatch': 'bad-request',
});
export function trustError(reason) {
  return Object.assign(new Error('owner decision trust refused'), { code: PUBLIC[reason] ?? 'storage-failed', reason });
}
const fail = (reason = 'owner-trust-corrupt') => { throw trustError(reason); };

// Resolved from the same env/home as the vouch key (vouch.mjs vouchStateDir).
export function ownerDecisionTrustRoot({ env = process.env, home = homedir() } = {}) {
  const stateHome = env.XDG_STATE_HOME ? path.resolve(env.XDG_STATE_HOME) : path.join(home, '.local', 'state');
  return path.join(stateHome, 'agent-bot', 'owner-decision-trust');
}

// --- exact keys ---

// The canonical form of one Ed25519 public key: unpadded base64url of exactly
// 32 bytes that is a valid point, and its agent-comms key ID.
export function ed25519KeyPin(publicKey) {
  if (!matches(KEY, publicKey)) fail('owner-trust-invalid-input');
  const raw = Buffer.from(publicKey, 'base64url');
  if (raw.length !== 32 || raw.toString('base64url') !== publicKey) fail('owner-trust-invalid-input');
  try { createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: publicKey }, format: 'jwk' }); } catch { fail('owner-trust-invalid-input'); }
  return { alg: 'ed25519', publicKey, keyId: sha256(Buffer.concat([ED25519_SPKI_PREFIX, raw])) };
}

function validPin(pin) {
  if (!exact(pin, ['alg', 'publicKey', 'keyId']) || pin.alg !== 'ed25519') return false;
  try { return ed25519KeyPin(pin.publicKey).keyId === pin.keyId; } catch { return false; }
}

// --- exact records ---

// The pinned namespace is the broker's digest exactly as published: lowercase
// 64-hex. We never hold or derive from the raw installation ID.
export function isNamespaceDigest(value) {
  return matches(DIGEST, value);
}

function namespaceRecord(value) {
  return exact(value, ['v', 'kind', 'namespaceDigest', 'enrolledAt', 'auditId']) && value.v === 1
    && value.kind === 'owner-decision-broker-namespace' && isNamespaceDigest(value.namespaceDigest)
    && seconds(value.enrolledAt) && matches(UUID4, value.auditId);
}

function chainFields(value, namespaceDigest) {
  return value.v === 1 && value.namespaceDigest === namespaceDigest && Number.isSafeInteger(value.version)
    && value.version >= 1 && value.version <= TRUST_LIMITS.versions && matches(DIGEST, value.previousDigest)
    && seconds(value.at) && matches(UUID4, value.auditId);
}

// This daemon's own key ID, always derived from its existing vouch key (the
// key the broker approved at pairing). A caller may pass the value it holds,
// but only as a check: anything else refuses. Without a vouch key there is
// no owner-decision trust at all.
function ownDaemonKey(supplied, { env, home }) {
  let derived;
  try { derived = vouchDaemonKey({ env, home }); } catch { fail('owner-trust-no-vouch-key'); }
  if (derived === null) fail('owner-trust-no-vouch-key');
  if (supplied !== undefined && supplied !== derived) fail('owner-trust-daemon-key-mismatch');
  return derived;
}

// keyd's legacy presence key (raw 32 bytes), which the native p1 presenceKey
// must never be. A test or caller may inject it (base64 or base64url, or null
// for none); by default it is read from keyd's cached pin, presence.pub, as a
// plain file read. The code-signed re-derivation (pinnedPresenceKey) is not
// run here: it executes codesign and keyd, may touch keyd's Keychain item,
// and writes the cache and audit receipts. The cache is a deny-list only: a
// wrong or missing cache can add refusals or miss one, never grant trust.
function legacyPresenceRaw(injected, { env, home }) {
  const decode = (text) => {
    if (typeof text !== 'string' || !/^[A-Za-z0-9+/_-]{43}=?$/.test(text)) return null;
    const raw = Buffer.from(text.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
    return raw.length === 32 ? raw : null;
  };
  if (injected !== undefined) return injected === null ? null : decode(injected);
  try { return decode(fs.readFileSync(presencePinPath({ env, home }), 'utf8').trim()); } catch { return null; }
}
const isLegacyPresence = (pin, legacy) => legacy !== null && Buffer.from(pin.publicKey, 'base64url').equals(legacy);

// The broker runs in its own service account: never root, never the owner.
function validBrokerUid(uid) {
  return Number.isSafeInteger(uid) && uid > 0 && uid <= 0xffffffff && uid !== process.getuid();
}

function enrollmentRecord(value, namespaceDigest) {
  return exact(value, ['v', 'kind', 'namespaceDigest', 'version', 'previousDigest', 'receiptKey', 'presenceKey', 'service', 'at', 'auditId'])
    && value.kind === 'owner-decision-key-enrollment' && chainFields(value, namespaceDigest)
    && validPin(value.receiptKey) && validPin(value.presenceKey)
    && value.receiptKey.publicKey !== value.presenceKey.publicKey && value.receiptKey.keyId !== value.presenceKey.keyId
    && exact(value.service, ['platform', 'brokerUid']) && value.service.platform === 'darwin'
    && validBrokerUid(value.service.brokerUid);
}

function revocationRecord(value, namespaceDigest) {
  return exact(value, ['v', 'kind', 'namespaceDigest', 'version', 'previousDigest', 'revokes', 'reason', 'at', 'auditId'])
    && value.kind === 'owner-decision-key-revocation' && chainFields(value, namespaceDigest)
    && matches(DIGEST, value.revokes) && REASONS.has(value.reason);
}

// A confirmation names its subject by a fixed discriminator and version only.
function confirmationRecord(value) {
  return exact(value, ['v', 'kind', 'subject', 'version', 'recordDigest', 'namespaceDigest', 'auditId', 'auditLineDigest'])
    && value.v === 1 && value.kind === 'owner-decision-trust-confirmation'
    && ((value.subject === 'namespace' && value.version === 0)
      || (value.subject === 'key' && Number.isSafeInteger(value.version) && value.version >= 1 && value.version <= TRUST_LIMITS.versions))
    && matches(DIGEST, value.recordDigest) && matches(DIGEST, value.namespaceDigest) && matches(UUID4, value.auditId)
    && matches(DIGEST, value.auditLineDigest);
}

function auditEntry(value) {
  return exact(value, ['v', 'kind', 'seq', 'subject', 'version', 'recordDigest', 'namespaceDigest', 'auditId', 'at', 'reconciled'])
    && value.v === 1 && value.kind === 'owner-decision-trust-audit' && Number.isSafeInteger(value.seq)
    && value.seq >= 1 && value.seq <= AUDIT_LINES
    && ((value.subject === 'namespace' && value.version === 0)
      || (value.subject === 'key' && Number.isSafeInteger(value.version) && value.version >= 1 && value.version <= TRUST_LIMITS.versions))
    && matches(DIGEST, value.recordDigest) && matches(DIGEST, value.namespaceDigest) && matches(UUID4, value.auditId)
    && seconds(value.at) && typeof value.reconciled === 'boolean';
}

function encode(value, cap) {
  const bytes = Buffer.from(canonicalJson(value));
  if (bytes.length > cap) fail('owner-trust-invalid-input');
  return bytes;
}

// Strict canonical JSON: exact bytes that re-serialize identically.
function decode(bytes) {
  try {
    const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
    const value = JSON.parse(text);
    if (canonicalJson(value) !== text) throw new Error();
    return value;
  } catch { return fail(); }
}

// --- custody ---

// Every ancestor must be a real directory owned by us or root and not
// writable by others unless sticky, so no other account can swap a parent.
function assertAncestors(io, dir) {
  const uid = process.getuid();
  for (let current = path.dirname(dir); ; current = path.dirname(current)) {
    const info = io.lstatSync(current);
    if (!info.isDirectory() || (info.uid !== uid && info.uid !== 0)
      || ((info.mode & 0o022) !== 0 && (info.mode & 0o1000) === 0)) fail('owner-trust-custody');
    if (path.dirname(current) === current) return;
  }
}

function ownedDirectory(io, dir) {
  const fd = io.openSync(dir, O_RDONLY | O_DIRECTORY | O_NOFOLLOW);
  try {
    const held = io.fstatSync(fd), named = io.lstatSync(dir);
    if (!held.isDirectory() || held.uid !== process.getuid() || (held.mode & 0o7777) !== 0o700
      || held.dev !== named.dev || held.ino !== named.ino) fail('owner-trust-custody');
  } finally { io.closeSync(fd); }
}

function flushDirectory(io, dir) {
  const fd = io.openSync(dir, O_RDONLY | O_DIRECTORY | O_NOFOLLOW);
  try { io.fsyncSync(fd); } catch { fail('owner-trust-flush'); } finally { io.closeSync(fd); }
}

// Never holds more than `max` names: refuses at entry max+1.
function listBounded(io, dir, max) {
  const names = [];
  const handle = io.opendirSync(dir);
  try {
    for (let entry = handle.readSync(); entry !== null; entry = handle.readSync()) {
      if (names.length === max) fail('owner-trust-bounds');
      names.push(entry.name);
    }
  } finally { handle.closeSync(); }
  return names;
}

// Opens one of our private single-link regular files, reads it whole up to
// `max` bytes and flushes it (the explicit recovery flush), then requires the
// bytes to be unchanged. Reads never create.
function readFlushed(io, file, max) {
  const fd = io.openSync(file, O_RDONLY | O_NOFOLLOW);
  try {
    const held = io.fstatSync(fd), named = io.lstatSync(file);
    if (!held.isFile() || held.uid !== process.getuid() || (held.mode & 0o7777) !== 0o600 || held.nlink !== 1
      || held.dev !== named.dev || held.ino !== named.ino || held.size < 1 || held.size > max) fail('owner-trust-custody');
    const bytes = Buffer.alloc(held.size);
    if (io.readSync(fd, bytes, 0, bytes.length, 0) !== bytes.length) fail('owner-trust-io');
    try { io.fsyncSync(fd); } catch { fail('owner-trust-flush'); }
    const again = Buffer.alloc(bytes.length);
    if (io.readSync(fd, again, 0, again.length, 0) !== again.length || !again.equals(bytes) || io.fstatSync(fd).size !== bytes.length) fail();
    return bytes;
  } finally { io.closeSync(fd); }
}

// Reads one file through a no-follow descriptor whose fstat must be ours, a
// private regular file with an allowed link count, the same object as its
// name, and within `max` bytes. Used by reconcile, where a pending name may
// legitimately have a second link.
function readHeld(io, file, max, links) {
  const fd = io.openSync(file, O_RDONLY | O_NOFOLLOW);
  try {
    const held = io.fstatSync(fd), named = io.lstatSync(file);
    if (!held.isFile() || held.uid !== process.getuid() || (held.mode & 0o7777) !== 0o600 || !links.includes(held.nlink)
      || held.dev !== named.dev || held.ino !== named.ino || held.size < 1 || held.size > max) fail('owner-trust-pending');
    const bytes = Buffer.alloc(held.size);
    if (io.readSync(fd, bytes, 0, bytes.length, 0) !== bytes.length) fail('owner-trust-io');
    return { bytes, held };
  } finally { io.closeSync(fd); }
}

function acquireLock(io, root) {
  let fd;
  try {
    fd = io.openSync(path.join(root, LOCK), O_RDWR | O_NOFOLLOW | O_NONBLOCK | O_CLOEXEC | O_EXLOCK);
    const held = io.fstatSync(fd), named = io.lstatSync(path.join(root, LOCK));
    if (!held.isFile() || held.uid !== process.getuid() || (held.mode & 0o7777) !== 0o600 || held.size !== 0
      || held.nlink !== 1 || held.dev !== named.dev || held.ino !== named.ino) fail('owner-trust-custody');
    return fd;
  } catch (error) {
    if (fd !== undefined) { try { io.closeSync(fd); } catch { /* the refusal below stands */ } }
    if (error?.code === 'ENOENT') fail('owner-trust-missing');
    fail(['EAGAIN', 'EWOULDBLOCK'].includes(error?.code) ? 'owner-trust-busy' : (error?.reason ?? 'owner-trust-io'));
  }
}

// --- the trust graph ---

// Reads the complete trust state under the lock. It repairs and mutates
// nothing apart from the explicit recovery flush of every file and directory.
// Every record must have its confirmation and exactly one matching audit
// line; a missing confirmation anywhere, including on a revocation, leaves no
// authority at all rather than an earlier key.
// `allowPending` is only for explicit reconciliation, which must look at the
// graph around an interrupted publication; readiness never sets it.
// The namespace part every reader shares: custody of the root and its
// ancestors, the bounded top-level listing, and the flushed, validated
// namespace record with its confirmation bytes (null when absent). It never
// touches keys/.
function readNamespacePart(io, root, { allowPending = false } = {}) {
  assertAncestors(io, root); ownedDirectory(io, root);
  const top = listBounded(io, root, ROOT_NAMES.size + 1).filter((name) => {
    if (name !== PENDING) return true;
    if (!allowPending) fail('owner-trust-pending');
    return false;
  });
  if (!top.every((name) => ROOT_NAMES.has(name))) fail();
  if (!top.includes(NAMESPACE)) {
    if (allowPending) fail('owner-trust-pending');
    if (top.length !== 1) fail();
    fail('owner-trust-missing');
  }
  const bytes = readFlushed(io, path.join(root, NAMESPACE), TRUST_LIMITS.record);
  const value = decode(bytes);
  if (!namespaceRecord(value)) fail();
  const confirmation = top.includes(NAMESPACE_CONFIRMATION)
    ? readFlushed(io, path.join(root, NAMESPACE_CONFIRMATION), TRUST_LIMITS.confirmation) : null;
  return { top, record: { subject: 'namespace', version: 0, bytes, value, digest: sha256(bytes) }, confirmation };
}

// One record's confirmation must bind it exactly to its single audit line.
function confirmed(record, confirmationBytes, lines, namespaceDigest) {
  const value = decode(confirmationBytes);
  if (!confirmationRecord(value) || value.subject !== record.subject || value.version !== record.version
    || value.recordDigest !== record.digest || value.namespaceDigest !== namespaceDigest || value.auditId !== record.value.auditId
    || lines.length !== 1 || lines[0].value.recordDigest !== record.digest || lines[0].value.auditId !== record.value.auditId
    || lines[0].value.namespaceDigest !== namespaceDigest || value.auditLineDigest !== sha256(lines[0].bytes)) fail();
}

function readGraph(io, root, { allowPending = false } = {}) {
  const { top, record: namespaceRecordEntry, confirmation: namespaceConfirmation } = readNamespacePart(io, root, { allowPending });
  const namespaceDigest = namespaceRecordEntry.value.namespaceDigest;
  const records = [namespaceRecordEntry];
  const confirmations = new Map();
  let active = null;
  if (namespaceConfirmation) confirmations.set('namespace:0', namespaceConfirmation);

  if (top.includes(KEYS)) {
    const keys = path.join(root, KEYS);
    ownedDirectory(io, keys);
    const names = listBounded(io, keys, 2 * TRUST_LIMITS.versions + 1).filter((name) => {
      if (name !== PENDING) return true;
      if (!allowPending) fail('owner-trust-pending');
      return false;
    });
    if (names.length > 2 * TRUST_LIMITS.versions) fail('owner-trust-bounds');
    const versions = new Set();
    for (const name of names) {
      const [, digits, confirmation] = KEY_FILE.exec(name) ?? fail();
      const version = Number(digits);
      if (version < 1 || version > TRUST_LIMITS.versions || keyFile(version, Boolean(confirmation)) !== name) fail();
      if (confirmation) confirmations.set(`key:${version}`, readFlushed(io, path.join(keys, name), TRUST_LIMITS.confirmation));
      else versions.add(version);
    }
    // Contiguous 1..n, each hash-linked to its predecessor (version 1 to the
    // namespace record), replayed through the one-active-key state machine.
    let previous = records[0].digest;
    for (let version = 1; version <= versions.size; version++) {
      if (!versions.has(version)) fail();
      const bytes = readFlushed(io, path.join(keys, keyFile(version)), TRUST_LIMITS.record), value = decode(bytes);
      if (value.version !== version || value.previousDigest !== previous) fail();
      const digest = sha256(bytes);
      if (enrollmentRecord(value, namespaceDigest)) {
        // An enrollment in the reserved last slot could never be revoked.
        if (active !== null || version >= TRUST_LIMITS.versions) fail();
        active = { digest, value };
      } else if (revocationRecord(value, namespaceDigest)) {
        if (active === null || value.revokes !== active.digest) fail();
        active = null;
      } else fail();
      records.push({ subject: 'key', version, bytes, value, digest });
      previous = digest;
    }
    flushDirectory(io, keys);
  }
  for (const key of confirmations.keys()) if (!records.some(({ subject, version }) => `${subject}:${version}` === key)) fail();

  const audit = top.includes(AUDIT) ? readAudit(io, root) : [];
  flushDirectory(io, root);
  for (const line of audit) {
    if (line.value.namespaceDigest !== namespaceDigest) fail();
    const record = records.find(({ subject, version }) => subject === line.value.subject && version === line.value.version);
    // An audit line for a record that does not exist is a deleted record.
    if (!record || line.value.recordDigest !== record.digest || line.value.auditId !== record.value.auditId) fail();
  }
  const pending = [];
  for (const record of records) {
    const lines = audit.filter(({ value }) => value.subject === record.subject && value.version === record.version);
    if (lines.length > 1) fail();
    const confirmation = confirmations.get(`${record.subject}:${record.version}`);
    if (!confirmation) { pending.push(record); continue; }
    confirmed(record, confirmation, lines, namespaceDigest);
  }
  return { namespaceDigest, records, active, audit, pending };
}

// The dedicated trust audit file: canonical lines, each newline-terminated
// and at most 512 bytes, sequence-numbered 1..n, read incrementally within
// a fixed total budget. A torn tail refuses and is kept as evidence.
function readAudit(io, root) {
  const bytes = readFlushed(io, path.join(root, AUDIT), AUDIT_BYTES);
  const lines = [];
  let start = 0;
  while (start < bytes.length) {
    const end = bytes.indexOf(0x0a, start);
    if (end === -1 || end - start + 1 > TRUST_LIMITS.auditLine || lines.length === AUDIT_LINES) fail();
    const line = bytes.subarray(start, end + 1), value = decode(line.subarray(0, line.length - 1));
    if (!auditEntry(value) || value.seq !== lines.length + 1) fail();
    lines.push({ bytes: Buffer.from(line), value });
    start = end + 1;
  }
  return lines;
}

function ready(graph, expectedNamespaceDigest, daemonKey, legacyPresence = null) {
  if (expectedNamespaceDigest !== undefined && graph.namespaceDigest !== expectedNamespaceDigest) fail();
  if (graph.pending.length > 0) fail('owner-trust-audit-pending');
  if (!graph.active) fail('owner-trust-no-active-key');
  const { value } = graph.active;
  // A pin that is this daemon's own vouch key confuses roles: no authority.
  if (daemonKey !== undefined && (value.receiptKey.keyId === daemonKey || value.presenceKey.keyId === daemonKey)) fail('owner-trust-role');
  // The presence pin is the native p1 signer, never keyd's legacy seed.
  if (isLegacyPresence(value.presenceKey, legacyPresence)) fail('owner-trust-role');
  return {
    state: 'ready', namespaceDigest: graph.namespaceDigest, version: value.version, enrolledAt: value.at,
    receiptKey: value.receiptKey, presenceKey: value.presenceKey, service: value.service,
    authorizationSupported: false, physicalFlushGuaranteed: false,
  };
}

function platformCheck() {
  if (process.platform !== 'darwin') fail('owner-trust-platform-unsupported');
}

// Readiness for one use: the pinned namespace and the single active,
// completely audited key enrollment. Missing trust is unsupported; anything
// unsettled, damaged or foreign is storage-failed and kept as found.
// The daemonKey (SHA-256 of this daemon's vouch SPKI DER) is derived from the
// vouch key under `env`/`home`; a supplied `daemonKey` must equal it. A pin
// equal to it is always refused.
export function readOwnerDecisionTrust({ root, namespaceDigest, daemonKey, legacyPresenceKey, env = process.env, home = homedir(), io = fs } = {}) {
  platformCheck();
  if (typeof root !== 'string' || !path.isAbsolute(root)) fail('owner-trust-invalid-input');
  const ownKey = ownDaemonKey(daemonKey, { env, home });
  try { io.lstatSync(root); } catch (error) { if (error?.code === 'ENOENT') fail('owner-trust-missing'); fail('owner-trust-io'); }
  const lock = acquireLock(io, root);
  try { return ready(readGraph(io, root), namespaceDigest, ownKey, legacyPresenceRaw(legacyPresenceKey, { env, home })); }
  catch (error) { throw error?.reason ? error : trustError('owner-trust-io'); }
  finally { io.closeSync(lock); }
}

// The pinned namespace alone, for a host's first key enrollment: it must not
// depend on the key chain it is about to start, so it works before any keys
// exist and between a revocation and the next enrollment. Under the same
// exclusive lock and with the same custody, flush and validation as the full
// reader applies to the namespace part, it requires namespace.json, its
// confirmation and exactly one matching line in the dedicated audit file.
// It returns only {namespaceDigest}: never readiness, pins or authority. The
// full readOwnerDecisionTrust stays mandatory for capability and for every
// trust check. A busy lock, a pending audit or a pending publication refuses
// with storage-failed for an explicit retry; nothing is repaired, replayed
// or written.
export function readOwnerDecisionNamespace({ root, io = fs } = {}) {
  platformCheck();
  if (typeof root !== 'string' || !path.isAbsolute(root)) fail('owner-trust-invalid-input');
  try { io.lstatSync(root); } catch (error) { if (error?.code === 'ENOENT') fail('owner-trust-missing'); fail('owner-trust-io'); }
  const lock = acquireLock(io, root);
  try {
    const { top, record, confirmation } = readNamespacePart(io, root);
    if (!confirmation) fail('owner-trust-audit-pending');
    const lines = top.includes(AUDIT) ? readAudit(io, root).filter(({ value }) => value.subject === 'namespace' && value.version === 0) : [];
    flushDirectory(io, root);
    confirmed(record, confirmation, lines, record.value.namespaceDigest);
    return { namespaceDigest: record.value.namespaceDigest };
  } catch (error) { throw error?.reason ? error : trustError('owner-trust-io'); }
  finally { io.closeSync(lock); }
}

// --- the ceremony-only writer (not wired to any command or route) ---

// `maxVersions` may only lower the fixed capacity (tests use it to reach the
// limit); the reader always enforces TRUST_LIMITS.versions.
export function createOwnerDecisionTrustWriter({ root, io = fs, fault = () => {}, now = () => Math.floor(Date.now() / 1000),
  maxVersions = TRUST_LIMITS.versions, env = process.env, home = homedir(), legacyPresenceKey } = {}) {
  platformCheck();
  if (typeof root !== 'string' || !path.isAbsolute(root)) fail('owner-trust-invalid-input');
  const capacity = Math.min(TRUST_LIMITS.versions, maxVersions);

  function locked(operation) {
    const lock = acquireLock(io, root);
    try { return operation(); }
    catch (error) { throw error?.reason ? error : trustError('owner-trust-io'); }
    finally { io.closeSync(lock); }
  }

  // Exclusive publication with no partial final file: a fixed pending name
  // written and flushed, linked to the final name, the directory flushed, the
  // pending name unlinked and the directory flushed again.
  function publish(dir, name, bytes, step) {
    const pending = path.join(dir, PENDING);
    const fd = io.openSync(pending, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW, 0o600);
    try {
      if (io.writeSync(fd, bytes, 0, bytes.length, 0) !== bytes.length) fail('owner-trust-io');
      fault(`${step}:pending-written`);
      try { io.fsyncSync(fd); } catch { fail('owner-trust-flush'); }
    } finally { io.closeSync(fd); }
    fault(`${step}:pending-flushed`);
    io.linkSync(pending, path.join(dir, name)); fault(`${step}:linked`);
    flushDirectory(io, dir); fault(`${step}:directory-flushed`);
    io.unlinkSync(pending); fault(`${step}:pending-removed`);
    flushDirectory(io, dir); fault(`${step}:published`);
  }

  function appendAudit(entry, step) {
    const file = path.join(root, AUDIT);
    const line = Buffer.concat([encode(entry, TRUST_LIMITS.auditLine - 1), Buffer.from('\n')]);
    let created = false;
    try { io.lstatSync(file); } catch (error) { if (error?.code !== 'ENOENT') throw error; created = true; }
    const fd = io.openSync(file, O_WRONLY | O_APPEND | O_NOFOLLOW | (created ? O_CREAT | O_EXCL : 0), 0o600);
    try {
      if (io.writeSync(fd, line) !== line.length) fail('owner-trust-io');
      fault(`${step}:audit-written`);
      try { io.fsyncSync(fd); } catch { fail('owner-trust-flush'); }
    } finally { io.closeSync(fd); }
    if (created) flushDirectory(io, root);
    fault(`${step}:audit-flushed`);
    return line;
  }

  function confirmationBytes(graph, record, line) {
    return encode({
      v: 1, kind: 'owner-decision-trust-confirmation', subject: record.subject, version: record.version,
      recordDigest: record.digest, namespaceDigest: graph.namespaceDigest, auditId: record.value.auditId, auditLineDigest: sha256(line),
    }, TRUST_LIMITS.confirmation);
  }
  const confirmationPlace = (record) => (record.subject === 'namespace'
    ? { dir: root, name: NAMESPACE_CONFIRMATION } : { dir: path.join(root, KEYS), name: keyFile(record.version, true) });

  // Audit then confirm one published record. The audit append is not atomic
  // with the record; the confirmation is what makes the record usable.
  function confirm(graph, record, { reconciled, step }) {
    const existing = graph.audit.filter(({ value }) => value.subject === record.subject && value.version === record.version);
    let line;
    if (existing.length === 1) line = existing[0].bytes;
    else {
      if (graph.audit.length >= AUDIT_LINES) fail('owner-trust-bounds');
      line = appendAudit({
        v: 1, kind: 'owner-decision-trust-audit', seq: graph.audit.length + 1, subject: record.subject, version: record.version,
        recordDigest: record.digest, namespaceDigest: graph.namespaceDigest, auditId: record.value.auditId, at: now(), reconciled,
      }, step);
    }
    const { dir, name } = confirmationPlace(record);
    publish(dir, name, confirmationBytes(graph, record, line), `${step}:confirmation`);
  }

  // Growth needs a fully confirmed graph: at most one record is ever unconfirmed.
  function settledGraph() {
    const graph = readGraph(io, root);
    if (graph.pending.length > 0) fail('owner-trust-audit-pending');
    return graph;
  }

  function appendKeyRecord(build) {
    return locked(() => {
      const graph = settledGraph();
      const version = graph.records.length;
      // The last version is reserved for a terminal revocation, so an
      // enrollment can always be revoked; at capacity growth just stops.
      if (version >= capacity) fail('owner-trust-bounds');
      const previous = graph.records.at(-1);
      const value = build(graph, { version, previousDigest: previous.digest, namespaceDigest: graph.namespaceDigest });
      const bytes = encode(value, TRUST_LIMITS.record);
      const keys = path.join(root, KEYS);
      try { io.lstatSync(keys); } catch (error) {
        if (error?.code !== 'ENOENT') throw error;
        io.mkdirSync(keys, { mode: 0o700 }); flushDirectory(io, root); fault('keys:created');
      }
      publish(keys, keyFile(version), bytes, `key-${version}`);
      const record = { subject: 'key', version, bytes, value, digest: sha256(bytes) };
      confirm({ ...graph, records: [...graph.records, record] }, record, { reconciled: false, step: `key-${version}` });
      return ready(readGraph(io, root));
    });
  }

  return {
    // Creates the store and its one immutable namespace record. A
    // byte-identical repeat changes nothing; anything else conflicts. Nothing
    // ever mints, resets or replaces it.
    enrollNamespace({ namespaceDigest, enrolledAt = now(), auditId = randomUUID() } = {}) {
      const value = { v: 1, kind: 'owner-decision-broker-namespace', namespaceDigest, enrolledAt, auditId };
      if (!namespaceRecord(value)) fail('owner-trust-invalid-input');
      const bytes = encode(value, TRUST_LIMITS.record);
      let exists = true;
      try { io.lstatSync(root); } catch (error) { if (error?.code !== 'ENOENT') throw error; exists = false; }
      if (!exists) {
        assertAncestors(io, root);
        io.mkdirSync(root, { mode: 0o700 }); fault('root:created');
      }
      // Creating the lock is part of creating the store: only in an empty,
      // owned root, exclusively, never replacing a lock that went missing.
      assertAncestors(io, root); ownedDirectory(io, root);
      if (listBounded(io, root, ROOT_NAMES.size + 1).length === 0) {
        io.closeSync(io.openSync(path.join(root, LOCK), O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW, 0o600));
        flushDirectory(io, root); flushDirectory(io, path.dirname(root)); fault('lock:created');
      }
      return locked(() => {
        let present = true;
        try { io.lstatSync(path.join(root, NAMESPACE)); } catch (error) { if (error?.code !== 'ENOENT') throw error; present = false; }
        if (present) {
          const graph = readGraph(io, root);
          if (graph.namespaceDigest !== namespaceDigest) fail('owner-trust-conflict');
          return { state: graph.pending.length > 0 ? 'audit-pending' : 'enrolled', namespaceDigest };
        }
        assertAncestors(io, root); ownedDirectory(io, root);
        if (listBounded(io, root, ROOT_NAMES.size).some((name) => name !== LOCK)) fail();
        publish(root, NAMESPACE, bytes, 'namespace');
        const record = { subject: 'namespace', version: 0, bytes, value, digest: sha256(bytes) };
        confirm({ namespaceDigest, records: [record], audit: [] }, record, { reconciled: false, step: 'namespace' });
        readGraph(io, root);
        return { state: 'enrolled', namespaceDigest };
      });
    },

    // A new enrollment is legal only with no active one: rotation is a
    // confirmed revocation first. Keys come only from the owner ceremony.
    // Neither pin may be this daemon's own vouch key (derived; a supplied
    // `daemonKey` must equal it).
    enrollKeys({ receiptKey, presenceKey, brokerUid, daemonKey, at = now(), auditId = randomUUID() } = {}) {
      const receipt = ed25519KeyPin(receiptKey), presence = ed25519KeyPin(presenceKey);
      const ownKey = ownDaemonKey(daemonKey, { env, home });
      if (receipt.keyId === presence.keyId || receipt.keyId === ownKey || presence.keyId === ownKey
        || isLegacyPresence(presence, legacyPresenceRaw(legacyPresenceKey, { env, home }))) fail('owner-trust-invalid-input');
      if (!validBrokerUid(brokerUid) || !seconds(at) || !matches(UUID4, auditId)) fail('owner-trust-invalid-input');
      return appendKeyRecord((graph, chain) => {
        if (graph.active) fail('owner-trust-conflict');
        return { v: 1, kind: 'owner-decision-key-enrollment', ...chain, receiptKey: receipt, presenceKey: presence,
          service: { platform: 'darwin', brokerUid }, at, auditId };
      });
    },

    // Revokes exactly the active enrollment, named by its record digest.
    revokeKeys({ revokes, reason, at = now(), auditId = randomUUID() } = {}) {
      if (!matches(DIGEST, revokes) || !REASONS.has(reason) || !seconds(at) || !matches(UUID4, auditId)) fail('owner-trust-invalid-input');
      return locked(() => {
        const graph = settledGraph();
        if (!graph.active || graph.active.digest !== revokes) fail('owner-trust-conflict');
        const version = graph.records.length;
        if (version > capacity) fail('owner-trust-bounds');
        const value = { v: 1, kind: 'owner-decision-key-revocation', namespaceDigest: graph.namespaceDigest, version,
          previousDigest: graph.records.at(-1).digest, revokes, reason, at, auditId };
        const bytes = encode(value, TRUST_LIMITS.record);
        publish(path.join(root, KEYS), keyFile(version), bytes, `key-${version}`);
        const record = { subject: 'key', version, bytes, value, digest: sha256(bytes) };
        confirm({ ...graph, records: [...graph.records, record] }, record, { reconciled: false, step: `key-${version}` });
        const after = readGraph(io, root);
        if (after.active || after.pending.length > 0) fail();
        return { state: 'revoked', version };
      });
    },

    // Explicit owner reconciliation after an interruption. The only repairs:
    // - a pending name that is a second link to an already published final
    //   file (same inode, same bytes) is unlinked;
    // - a lone pending file whose bytes are exactly the confirmation this
    //   graph's one unconfirmed record needs is linked into place;
    // - an unconfirmed record gets its audit line (marked reconciled when it
    //   was never written) and then its confirmation.
    // Any other pending bytes, unknown file or torn audit line is kept as
    // evidence and refuses; nothing is deleted because it failed to parse.
    reconcile() {
      return locked(() => {
        // Custody of the root and keys/ comes before touching any name in them,
        // so a swapped or symlinked directory can never redirect an unlink.
        const keys = path.join(root, KEYS);
        assertAncestors(io, root); ownedDirectory(io, root);
        const dirs = [root];
        try { io.lstatSync(keys); dirs.push(keys); } catch (error) { if (error?.code !== 'ENOENT') throw error; }
        if (dirs.includes(keys)) {
          try { ownedDirectory(io, keys); } catch (error) { if (error?.reason) throw error; fail('owner-trust-custody'); }
        }
        for (const dir of dirs) {
          const pending = path.join(dir, PENDING);
          try { io.lstatSync(pending); } catch (error) { if (error?.code === 'ENOENT') continue; throw error; }
          const { bytes, held } = readHeld(io, pending, TRUST_LIMITS.record, [1, 2]);
          if (held.nlink === 2) {
            const twin = listBounded(io, dir, dir === root ? ROOT_NAMES.size + 1 : 2 * TRUST_LIMITS.versions + 1)
              .filter((name) => name !== PENDING).find((name) => {
                const info = io.lstatSync(path.join(dir, name));
                return info.isFile() && info.dev === held.dev && info.ino === held.ino;
              });
            if (!twin) fail('owner-trust-pending');
            const other = readHeld(io, path.join(dir, twin), TRUST_LIMITS.record, [2]);
            if (other.held.dev !== held.dev || other.held.ino !== held.ino || !other.bytes.equals(bytes)) fail('owner-trust-pending');
            io.unlinkSync(pending); flushDirectory(io, dir); fault('reconcile:twin-removed');
            continue;
          }
          const graph = readGraph(io, root, { allowPending: true });
          const [record] = graph.pending;
          const lines = record ? graph.audit.filter(({ value }) => value.subject === record.subject && value.version === record.version) : [];
          const place = record && confirmationPlace(record);
          if (graph.pending.length !== 1 || lines.length !== 1 || place.dir !== dir
            || !confirmationBytes(graph, record, lines[0].bytes).equals(bytes)) fail('owner-trust-pending');
          io.linkSync(pending, path.join(dir, place.name)); flushDirectory(io, dir);
          io.unlinkSync(pending); flushDirectory(io, dir); fault('reconcile:confirmation-linked');
        }
        const graph = readGraph(io, root);
        if (graph.pending.length > 1) fail();
        for (const record of graph.pending) confirm(graph, record, { reconciled: true, step: 'reconcile' });
        const after = readGraph(io, root);
        if (after.pending.length > 0) fail();
        return { state: 'reconciled', confirmed: graph.pending.map(({ subject, version }) => ({ subject, version })) };
      });
    },
  };
}
