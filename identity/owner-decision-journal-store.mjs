// Disabled daemon owner-decision journal storage (#1007, agent-comms#77): the
// fixed-file request layout, admission and orphan charging. No route, daemon
// call or activation reaches it. A valid stored frame is storage integrity,
// never authorization, and node's fsync is a logical flush only: on Darwin it
// may silently fall back from F_FULLFSYNC, so nothing here claims a physical
// flush or allocation guarantee. That needs a separately reviewed native helper.
import * as fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { createHash } from 'node:crypto';
import {
  DAEMON_JOURNAL_SLOTS, FRAME_OVERHEAD, SCRATCH_BYTES, decodeCanonicalPayload, decodeDaemonJournalFrame,
  encodeDaemonJournalFrame, peekAcceptanceContextFrame, requestDirectoryName,
} from './owner-decision-journal-frame.mjs';
import {
  bindEffect, bindPreparation, challengeFor, completedRecordFor, decodeEffect, decodePreparation, decodeSuccessfulCheck, effectDigest,
  effectOutcome, enteredRecordFor, refusedRecordFor,
} from './owner-decision-evidence.mjs';
import { verifyLinkedEvent } from './owner-decision-linked-event.mjs';
import { canonicalJson } from '../canonical-json.mjs';

export const DAEMON_JOURNAL_LIMIT = 4096;
export const DAEMON_RESERVATION_BYTES = 524288;
const LOCK_NAME = '.journal-lock';
const REQUESTS = 'requests';
const O_EXLOCK = 0x20; // Apple xnu-8792.61.2 bsd/sys/fcntl.h (macOS 13 era), flock semantics.
const { O_RDONLY, O_RDWR, O_WRONLY, O_CREAT, O_EXCL, O_NOFOLLOW, O_NONBLOCK } = fs.constants;
const O_CLOEXEC = fs.constants.O_CLOEXEC ?? 0; // libuv adds it anyway; ask explicitly where defined.

// Every request file, its fixed EOF and (for a slot) its frame binding.
const FILES = Object.freeze([
  ...DAEMON_JOURNAL_SLOTS.map(({ slot, cap }) => Object.freeze({ name: `${slot}.record`, slot, size: cap + FRAME_OVERHEAD })),
  Object.freeze({ name: 'scratch.record', slot: null, size: SCRATCH_BYTES }),
]);
const FILE_BY_SLOT = new Map(FILES.filter(({ slot }) => slot).map((file) => [file.slot, file]));
// The only lifecycle phase this disabled producer supports is the admission
// prefix. Any other committed or partial slot is a phase whose typed graph
// validator does not exist yet, so the whole request refuses.
const ADMISSION_SLOTS = ['original-action', 'acceptance-context'];

// Internal reasons stay in `reason`; callers see only the public code. Every
// storage failure is a non-authorizing refusal, never proof that an earlier
// effect did not enter, so retained state is preserved as found.
const PUBLIC = Object.freeze({
  'owner-journal-capacity': 'journal-capacity',
  'owner-journal-conflict': 'conflict',
  'owner-journal-consumed': 'conflict',
  'owner-journal-platform-unsupported': 'owner-decision-unsupported',
  'invalid-owner-journal-record': 'bad-request',
});
export function journalError(reason) {
  return Object.assign(new Error('owner decision journal refused'), { code: PUBLIC[reason] ?? 'storage-failed', reason });
}
const fail = (reason = 'owner-journal-corrupt') => { throw journalError(reason); };

const UUID4 = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const DIGEST = /^[a-f0-9]{64}$/;
const SOUL = /^agent_[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const PRINCIPAL = /^principal_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const ACCOUNT = /^[A-Za-z_][A-Za-z0-9_.-]{0,63}$/;
const OPERATIONS = new Set(['revision.approve', 'revision.reject', 'revision.adopt', 'revision.edit', 'cold-wake.set']);
const matches = (pattern, value) => typeof value === 'string' && pattern.exec(value)?.[0] === value;
const plain = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const exactKeys = (value, keys) => plain(value) && Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

// The daemon acceptance record (the acceptance-context payload) and its
// agreement with the exact original action bytes. Operation parameters are
// only shape-checked here; their typed validation is the operation adapter's.
export function validateDaemonAdmission(actionBytes, acceptanceBytes, namespaceDigest) {
  try {
    if (!matches(DIGEST, namespaceDigest)) fail();
    const original = decodeCanonicalPayload(actionBytes, FILE_BY_SLOT.get('original-action').size - FRAME_OVERHEAD);
    const saved = decodeCanonicalPayload(acceptanceBytes, FILE_BY_SLOT.get('acceptance-context').size - FRAME_OVERHEAD);
    const action = original.value, acceptance = saved.value;
    if (!exactKeys(action, ['v', 'requestId', 'principal', 'account', 'soul', 'operation', 'parameters'])
      || action.v !== 1 || !plain(action.parameters)) fail();
    if (!exactKeys(acceptance, ['v', 'kind', 'requestId', 'principal', 'account', 'soul', 'operation', 'payloadDigest',
      'namespaceDigest', 'acceptedAt', 'daemonKey', 'daemonEpoch', 'watchId', 'reservationBytes'])) fail();
    if (acceptance.v !== 1 || acceptance.kind !== 'acceptance' || !matches(UUID4, acceptance.requestId)
      || !matches(PRINCIPAL, acceptance.principal) || !matches(ACCOUNT, acceptance.account)
      || !matches(SOUL, acceptance.soul) || !OPERATIONS.has(acceptance.operation)
      || acceptance.namespaceDigest !== namespaceDigest || acceptance.reservationBytes !== DAEMON_RESERVATION_BYTES
      || !Number.isSafeInteger(acceptance.acceptedAt) || acceptance.acceptedAt < 0
      || !matches(DIGEST, acceptance.daemonKey) || !Number.isSafeInteger(acceptance.daemonEpoch) || acceptance.daemonEpoch < 1
      || !matches(UUID4, acceptance.watchId)) fail();
    for (const key of ['requestId', 'principal', 'account', 'soul', 'operation']) if (action[key] !== acceptance[key]) fail();
    if (acceptance.payloadDigest !== sha256(original.bytes)) fail();
    return { action: original.bytes, acceptance: saved.bytes, record: acceptance };
  } catch { fail('invalid-owner-journal-record'); }
}

function ownedDirectory(io, dir) {
  const info = io.lstatSync(dir);
  if (!info.isDirectory() || info.uid !== process.getuid() || (info.mode & 0o7777) !== 0o700) fail();
  return info;
}

function flushDirectory(io, dir) {
  const fd = io.openSync(dir, O_RDONLY | O_NOFOLLOW);
  try { io.fsyncSync(fd); } catch { fail('owner-journal-flush'); } finally { io.closeSync(fd); }
}

// A journal-specific, fixed-inode kernel lock: O_EXLOCK|O_NONBLOCK on one
// private empty file that is never reclaimed, unlinked or replaced. Process
// death closes it. Contention refuses instead of waiting or stealing.
export function acquireDaemonJournalLock(root, { io = fs } = {}) {
  if (process.platform !== 'darwin') fail('owner-journal-platform-unsupported');
  let fd;
  try {
    const file = path.join(root, LOCK_NAME);
    fd = io.openSync(file, O_RDWR | O_NOFOLLOW | O_NONBLOCK | O_CLOEXEC | O_EXLOCK);
    const held = io.fstatSync(fd), named = io.lstatSync(file);
    if (!held.isFile() || held.uid !== process.getuid() || (held.mode & 0o7777) !== 0o600 || held.size !== 0
      || held.nlink !== 1 || held.dev !== named.dev || held.ino !== named.ino) fail();
    return fd;
  } catch (error) {
    if (fd !== undefined) { try { io.closeSync(fd); } catch { /* the refusal below stands */ } }
    fail(['EAGAIN', 'EWOULDBLOCK'].includes(error?.code) ? 'owner-journal-busy' : 'owner-journal-io');
  }
}

// Creates an empty store once: the root, its lock inode and the request
// container, each exclusively and flushed. Never repairs an existing store.
export function initializeDaemonJournal(root, { io = fs } = {}) {
  if (process.platform !== 'darwin') fail('owner-journal-platform-unsupported');
  try {
    if (typeof root !== 'string' || !path.isAbsolute(root) || root.includes('\0')) fail();
    io.mkdirSync(root, { mode: 0o700 });
    ownedDirectory(io, root);
    io.closeSync(io.openSync(path.join(root, LOCK_NAME), O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW, 0o600));
    io.mkdirSync(path.join(root, REQUESTS), { mode: 0o700 });
    flushDirectory(io, root); flushDirectory(io, path.dirname(root));
  } catch (error) { fail(error?.reason ?? 'owner-journal-io'); }
}

// Lists a directory without ever holding more than `max` names: reading
// stops and refuses at entry max+1, before anything else is allocated.
function listBounded(io, dir, max) {
  const names = [];
  const handle = io.opendirSync(dir);
  try {
    for (let entry = handle.readSync(); entry !== null; entry = handle.readSync()) {
      if (names.length === max) fail();
      names.push(entry.name);
    }
  } finally { handle.closeSync(); }
  return names;
}

function readExactly(io, fd, size) {
  const bytes = Buffer.alloc(size);
  if (io.readSync(fd, bytes, 0, size, 0) !== size) fail('owner-journal-io');
  return bytes;
}

function writeExactly(io, fd, bytes, position) {
  if (io.writeSync(fd, bytes, 0, bytes.length, position) !== bytes.length) fail('owner-journal-io');
}

// Opens one established request file, refusing anything but our own private
// single-link regular file at its fixed EOF. Never creates.
function openFixed(io, file, size, flags) {
  const fd = io.openSync(file, flags | O_NOFOLLOW);
  try {
    const held = io.fstatSync(fd), named = io.lstatSync(file);
    if (!held.isFile() || held.uid !== process.getuid() || (held.mode & 0o7777) !== 0o600 || held.nlink !== 1
      || held.size !== size || held.dev !== named.dev || held.ino !== named.ino) fail();
    return fd;
  } catch (error) { io.closeSync(fd); throw error; }
}

export function createDaemonJournalStore({ root, namespaceDigest, io = fs, fault = () => {} } = {}) {
  if (process.platform !== 'darwin') fail('owner-journal-platform-unsupported');
  if (typeof root !== 'string' || !path.isAbsolute(root) || root.includes('\0') || !matches(DIGEST, namespaceDigest)) {
    fail('invalid-owner-journal-record');
  }
  const requests = path.join(root, REQUESTS);
  // After any storage failure this instance refuses until reopened, so a
  // half-known prefix is never written over by the same process.
  let poisoned = false;

  function locked(operation) {
    if (poisoned) fail('owner-journal-reopen-required');
    const fd = acquireDaemonJournalLock(root, { io });
    try {
      ownedDirectory(io, root); ownedDirectory(io, requests);
      return operation();
    } catch (error) {
      if (!['invalid-owner-journal-record', 'owner-journal-capacity', 'owner-journal-conflict', 'owner-journal-consumed', 'owner-journal-entry-refused',
        'owner-journal-transition-refused'].includes(error?.reason)) poisoned = true;
      if (error?.reason) throw error;
      throw journalError(error?.code === 'invalid-owner-journal-frame' ? 'owner-journal-corrupt' : 'owner-journal-io');
    } finally {
      try { io.closeSync(fd); } catch { poisoned = true; }
    }
  }

  // Every entry in the request container is charged, whatever it holds: an
  // orphan from interrupted admission is never fresh, refunded or reused.
  function scan() {
    const entries = listBounded(io, requests, DAEMON_JOURNAL_LIMIT);
    // An unknown or excess entry stays for inspection and refuses every write.
    if (!entries.every((entry) => matches(DIGEST, entry))) fail();
    return entries;
  }

  function publish(dir, slot, payload, binding) {
    const { size } = FILE_BY_SLOT.get(slot), file = path.join(dir, `${slot}.record`);
    const frame = encodeDaemonJournalFrame(payload, { ...binding, slot });
    const fd = openFixed(io, file, size, O_RDWR);
    try {
      if (decodeDaemonJournalFrame(readExactly(io, fd, size), { ...binding, slot }).kind !== 'empty') fail();
      writeExactly(io, fd, frame.subarray(0, size - 128), 0); fault(`${slot}:body-written`);
      try { io.fsyncSync(fd); } catch { fail('owner-journal-flush'); }
      fault(`${slot}:body-flushed`);
      writeExactly(io, fd, frame.subarray(size - 128), size - 128); fault(`${slot}:trailer-written`);
      try { io.fsyncSync(fd); } catch { fail('owner-journal-flush'); }
      fault(`${slot}:trailer-flushed`);
    } finally { io.closeSync(fd); }
    const check = openFixed(io, file, size, O_RDONLY);
    try { if (!readExactly(io, check, size).equals(frame)) fail(); } finally { io.closeSync(check); }
  }

  const zeros = (bytes) => bytes.every((byte) => byte === 0);

  // Reads one request directory as a complete graph, without creating,
  // repairing or clearing anything. Before any effect entered, every slot must
  // be empty or a committed, typed record bound to this request, in a legal
  // prefix: admitted, preparing (preparation without its challenge), prepared,
  // authorizing (presence/receipt), released (the one successful check) or
  // refused (a proven pre-effect refusal). Anything else refuses.
  //
  // Once `entered` holds anything but a clean partial write, an effect may
  // have started: the request is `applied` only when the whole graph
  // validates through a completed record (and, for a revision, its linked
  // authoritative event); every other case, including damage, is
  // `indeterminate`, never refused and never retried.
  function readGraph(name, expectedRequestId) {
    const dir = path.join(requests, name);
    ownedDirectory(io, dir);
    const present = listBounded(io, dir, FILES.length);
    if (!present.every((entry) => FILES.some((file) => file.name === entry))) fail();
    // Interrupted admission: files still missing, or acceptance-context (the
    // first file created and the last published) not committed. Charged, kept
    // and refused; never completed, cleared or forwarded.
    if (present.length !== FILES.length) fail('owner-journal-orphan');
    const readFile = ({ name: fileName, size }) => {
      const fd = openFixed(io, path.join(dir, fileName), size, O_RDONLY);
      try { return readExactly(io, fd, size); } finally { io.closeSync(fd); }
    };
    const contextFile = FILE_BY_SLOT.get('acceptance-context'), context = readFile(contextFile);
    if (zeros(context.subarray(contextFile.size - 128))) fail('owner-journal-orphan');
    const bytes = new Map(FILES.map((file) => [file.name, file === contextFile ? context : readFile(file)]));
    // The request ID comes only from acceptance-context, never from the hashed
    // directory name. Phase one reads it as untrusted bytes; nothing follows
    // from it until the directory hash under our enrolled namespace and the
    // full context-bound decode both agree.
    const contextCap = contextFile.size;
    const peeked = decodeCanonicalPayload(peekAcceptanceContextFrame(context).untrustedPayload, contextCap - FRAME_OVERHEAD).value;
    const requestId = plain(peeked) ? peeked.requestId : undefined;
    if (!matches(UUID4, requestId) || requestDirectoryName({ namespaceDigest, requestId }) !== name) fail();
    if (expectedRequestId !== undefined && requestId !== expectedRequestId) fail();
    const binding = { namespaceDigest, requestId };
    const decode = (slot) => decodeDaemonJournalFrame(bytes.get(`${slot}.record`), { ...binding, slot });
    if (!ADMISSION_SLOTS.every((slot) => decode(slot).kind === 'committed')) fail('owner-journal-orphan');
    let saved;
    try { saved = validateDaemonAdmission(decode('original-action').payload, decode('acceptance-context').payload, namespaceDigest); }
    catch { fail(); }
    const flush = [...ADMISSION_SLOTS, ...DAEMON_JOURNAL_SLOTS.map(({ slot }) => slot)
      .filter((slot) => !ADMISSION_SLOTS.includes(slot) && !zeros(bytes.get(`${slot}.record`)))];
    const graph = { dir, name, binding, saved, bytes, flush };
    // A body without its trailer is a partial entered write: the effect starts
    // only after entered is durable, so that alone is not uncertainty. Any
    // other nonzero entered bytes, committed or damaged, may be consumption.
    const entered = bytes.get('entered.record');
    let uncertain = false;
    if (!zeros(entered)) {
      try { uncertain = decode('entered').kind !== 'uncommitted'; } catch { uncertain = true; }
    }
    if (uncertain) {
      try { return { ...graph, ...effectGraph(decode, saved) }; }
      catch { return { ...graph, state: 'indeterminate', outcome: { code: 'effect-uncertain', effectDigest: null }, awaiting: awaitingCompletion(decode, saved) }; }
    }
    if (!zeros(bytes.get('scratch.record'))) fail('owner-journal-scratch-pending');
    return { ...graph, ...preEffectGraph(decode, saved) };
  }

  // The typed records of one request, read in dependency order. `committed`
  // returns a slot's payload or null when empty, and refuses a partial or
  // damaged slot.
  function evidence(decode, saved) {
    const committed = (slot) => {
      const frame = decode(slot);
      if (frame.kind === 'empty') return null;
      if (frame.kind !== 'committed') fail('owner-journal-unsupported-phase');
      return frame.payload;
    };
    const acceptance = saved.record, action = JSON.parse(saved.action.toString('utf8'));
    const slots = Object.fromEntries(DAEMON_JOURNAL_SLOTS.map(({ slot }) => [slot, committed(slot)]));
    const typed = (read) => { try { return read(); } catch (error) { if (error?.reason?.startsWith?.('owner-journal')) throw error; return fail(); } };
    const preparation = slots.preparation && typed(() => bindPreparation(decodePreparation(slots.preparation), { acceptance, action }));
    const preparationDigest = slots.preparation && effectDigest(slots.preparation);
    const receiptDigest = slots.receipt && effectDigest(slots.receipt);
    return { slots, acceptance, action, preparation, preparationDigest, receiptDigest, typed };
  }

  // The broker and presence key IDs the stored receipt names, read
  // structurally (its signature was verified at the successful check, which
  // binds this exact receipt by receiptDigest). Null when unreadable, so the
  // entry gate refuses instead of skipping its key binding; the gate compares
  // them with key IDs it recomputes, so no other shape check is needed here.
  function receiptKeyIds(bytes) {
    try {
      const parts = bytes.toString('latin1').split('.');
      if (parts.length !== 3 || parts[0] !== 'd1') return null;
      const { brokerKey, presenceKey } = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
      return Object.freeze({ brokerKey, presenceKey });
    } catch { return null; }
  }

  function preEffectGraph(decode, saved) {
    const { slots, acceptance, action, preparation, preparationDigest, receiptDigest, typed } = evidence(decode, saved);
    // Nothing after entry can exist without it; pairs and the local outcome
    // belong to later phases.
    for (const slot of ['completed', 'observation-pair', 'terminal-pair', 'linked-authoritative-event', 'local-lifecycle-outcome']) {
      if (slots[slot]) fail(slot === 'completed' || slot === 'linked-authoritative-event' ? 'owner-journal-corrupt' : 'owner-journal-unsupported-phase');
    }
    if (!preparation) {
      if (['prepared-challenge', 'presence', 'receipt', 'successful-check', 'pre-effect-refused'].some((slot) => slots[slot])) fail();
      return { state: 'admitted' };
    }
    if (slots['prepared-challenge'] && !slots['prepared-challenge'].equals(challengeFor(preparation, saved.action))) fail();
    if (!slots['prepared-challenge'] && (slots.presence || slots.receipt || slots['successful-check'])) fail();
    if (slots['successful-check']) {
      if (!slots.presence || !slots.receipt) fail();
      typed(() => decodeSuccessfulCheck(slots['successful-check'], { acceptance, receiptDigest }));
    }
    if (slots['pre-effect-refused']) {
      const refused = typed(() => bindEffect(decodeEffect(slots['pre-effect-refused']),
        { phase: 'refused', preparation, preparationDigest, receiptDigest, action }));
      return { ...effectOutcome(slots['pre-effect-refused']), refusalReason: refused.detail.code };
    }
    // What a final pre-effect refusal binds: the checked receipt, or none
    // before the successful check.
    const refusable = Object.freeze({ preparation, preparationDigest, receiptDigest: slots['successful-check'] ? receiptDigest : null });
    if (slots['successful-check']) {
      return { state: 'released', refusable, view: Object.freeze({ action, actionBytes: saved.action, acceptance, preparation, preparationDigest,
        receiptDigest, receiptKeys: receiptKeyIds(slots.receipt), presenceToken: slots.presence.toString('latin1') }) };
    }
    if (slots.presence || slots.receipt) return { state: 'authorizing', refusable };
    return { state: slots['prepared-challenge'] ? 'prepared' : 'preparing', refusable };
  }

  // The whole released prefix through a bound entered record, with no
  // refusal, pair or local outcome. Throws otherwise.
  function enteredPrefix(decode, saved) {
    const ev = evidence(decode, saved);
    const { slots, action, preparation, preparationDigest, receiptDigest, acceptance } = ev;
    if (!preparation || !slots['prepared-challenge'] || !slots['prepared-challenge'].equals(challengeFor(preparation, saved.action))
      || !slots.presence || !slots.receipt || !slots['successful-check'] || slots['pre-effect-refused'] || !slots.entered
      || slots['observation-pair'] || slots['terminal-pair'] || slots['local-lifecycle-outcome']) fail();
    decodeSuccessfulCheck(slots['successful-check'], { acceptance, receiptDigest });
    return { ...ev, entered: bindEffect(decodeEffect(slots.entered), { phase: 'entered', preparation, preparationDigest, receiptDigest, action }) };
  }

  // An indeterminate request that may be completed: a valid entered record
  // and (for cold-wake, which has none) no linked event. A revision's linked
  // event may already be present. Null otherwise. The completion writer
  // refuses a nonzero completed slot before consulting this.
  function awaitingCompletion(decode, saved) {
    try {
      const { slots, action, preparation, preparationDigest, receiptDigest, entered } = enteredPrefix(decode, saved);
      if (preparation.operation === 'cold-wake.set' && slots['linked-authoritative-event']) return null;
      return Object.freeze({ action, preparation, preparationDigest, receiptDigest, entered });
    } catch { return null; }
  }

  // Throws on anything short of a fully validated completion; the caller maps
  // every throw to indeterminate.
  function effectGraph(decode, saved) {
    const { slots, action, preparation, preparationDigest, receiptDigest, acceptance, entered } = enteredPrefix(decode, saved);
    if (!slots.completed) fail();
    const completed = bindEffect(decodeEffect(slots.completed), { phase: 'completed', preparation, preparationDigest, receiptDigest, action, entered });
    if (preparation.operation === 'cold-wake.set') {
      if (slots['linked-authoritative-event']) fail();
    } else {
      if (!slots['linked-authoritative-event']) fail();
      // Identifiers come from the signed action and acceptance, never from
      // the preparation, and a revision event must record the completed revision.
      const event = verifyLinkedEvent(slots['linked-authoritative-event'], {
        operation: action.operation, journalBytes: slots['linked-authoritative-event'],
        journalRecordDigest: completed.detail.journalRecordDigest, proposalId: action.parameters.proposalId,
        linkage: { requestId: acceptance.requestId, payloadDigest: acceptance.payloadDigest, receiptDigest, effectId: preparation.effectId, preparationDigest },
      });
      if (event.kind === 'revision' && event.revision !== completed.detail.afterRevision) fail();
    }
    return { state: 'applied', outcome: { code: 'applied', effectDigest: effectDigest(slots.completed) } };
  }

  // Visible committed frames prove nothing about their final flush. Before
  // anything is acknowledged again, flush every committed frame and both
  // directories, then require the bytes to be unchanged. A failed flush keeps
  // the prefix unsettled and refuses. This is node's logical fsync only.
  function recoveryFlush({ dir, bytes, flush }) {
    for (const slot of flush) {
      const { name: fileName, size } = FILE_BY_SLOT.get(slot);
      const fd = openFixed(io, path.join(dir, fileName), size, O_RDONLY);
      try {
        try { io.fsyncSync(fd); } catch { fail('owner-journal-flush'); }
        fault(`recovery:${slot}:flushed`);
        if (!readExactly(io, fd, size).equals(bytes.get(fileName))) fail();
      } finally { io.closeSync(fd); }
    }
    flushDirectory(io, dir); flushDirectory(io, requests); fault('recovery:directories-flushed');
  }

  const settled = (graph, extra) => ({
    state: graph.state ?? 'admitted', requestId: graph.binding.requestId, directory: graph.name,
    ...(graph.outcome ? { outcome: graph.outcome } : {}), ...(graph.refusalReason ? { refusalReason: graph.refusalReason } : {}), ...extra,
    authorizationSupported: false, physicalAllocationSupported: false, physicalFlushGuaranteed: false,
  });

  return {
    // Charged request directories, including orphans and unknown entries.
    count: () => locked(() => scan().length),

    // The effect-entry consumption point for one request (C2; disabled, no
    // route). Under the journal lock the request must be exactly `released`:
    // anything already entered, refused or applied is consumed (`conflict`),
    // and any other phase refuses. The synchronous `decide(view)` receives a
    // frozen read-only view of the saved request and either throws (nothing is
    // written) or returns { at } seconds. The store then derives the entered
    // record itself from the saved preparation and action, re-checks its
    // binding, and publishes it to slot 9 before any effect. Durable entered
    // is consumption: a crash after it is effect-uncertain, never a retry.
    enterEffect(requestId, decide) {
      if (!matches(UUID4, requestId) || typeof decide !== 'function') fail('invalid-owner-journal-record');
      const name = requestDirectoryName({ namespaceDigest, requestId });
      return locked(() => {
        if (!scan().includes(name)) fail('owner-journal-entry-refused');
        const graph = readGraph(name, requestId);
        if (['indeterminate', 'applied', 'refused'].includes(graph.state)) fail('owner-journal-consumed');
        if (graph.state !== 'released') fail('owner-journal-entry-refused');
        recoveryFlush(graph);
        const { view } = graph;
        // A refusal from decide writes nothing and does not poison the store;
        // its own reason is carried as `refusal`.
        let decision;
        try { decision = decide(view); } catch (error) {
          throw Object.assign(journalError('owner-journal-entry-refused'), { refusal: typeof error?.reason === 'string' ? error.reason : null });
        }
        if (decision === null || typeof decision !== 'object' || typeof decision.then === 'function'
          || !Number.isSafeInteger(decision.at) || decision.at < 0) fail('owner-journal-entry-refused');
        const record = enteredRecordFor({ preparation: view.preparation, preparationDigest: view.preparationDigest,
          receiptDigest: view.receiptDigest, action: view.action, at: decision.at });
        bindEffect(record, { phase: 'entered', preparation: view.preparation, preparationDigest: view.preparationDigest,
          receiptDigest: view.receiptDigest, action: view.action });
        const bytes = Buffer.from(canonicalJson(record));
        publish(graph.dir, 'entered', bytes, graph.binding);
        return { state: 'entered', requestId, effectId: view.preparation.effectId, enteredDigest: effectDigest(bytes),
          physicalFlushGuaranteed: false };
      });
    },

    // Completion of one entered effect (C2; disabled, no route): entered
    // becomes completed, under the journal lock. `result` is { at } seconds,
    // plus for a revision what the effect reports: { journalSeq,
    // journalRecordDigest, working } (working null unless entered applies).
    // The store derives the record from the saved entered record and action
    // and binds it before publishing slot 10. A cold-wake request is then
    // applied; a revision stays indeterminate until its linked authoritative
    // event is present. Already completed, applied or refused is a conflict;
    // any other phase, or a damaged entered record, refuses.
    completeEffect(requestId, result) {
      if (!matches(UUID4, requestId) || !plain(result)) fail('invalid-owner-journal-record');
      const name = requestDirectoryName({ namespaceDigest, requestId });
      return locked(() => {
        if (!scan().includes(name)) fail('owner-journal-transition-refused');
        const graph = readGraph(name, requestId);
        if (['applied', 'refused'].includes(graph.state) || !zeros(graph.bytes.get('completed.record'))) fail('owner-journal-conflict');
        if (!graph.awaiting) fail('owner-journal-transition-refused');
        recoveryFlush(graph);
        const { entered, action, preparation, preparationDigest, receiptDigest } = graph.awaiting;
        const { at, journalSeq, journalRecordDigest, working } = result;
        let bytes;
        try {
          bytes = Buffer.from(canonicalJson(completedRecordFor({ entered, action, at, journalSeq, journalRecordDigest, working })));
          bindEffect(decodeEffect(bytes), { phase: 'completed', preparation, preparationDigest, receiptDigest, action, entered });
        } catch { fail('invalid-owner-journal-record'); }
        publish(graph.dir, 'completed', bytes, graph.binding);
        return settled(readGraph(name, requestId), { effectId: preparation.effectId, completedDigest: effectDigest(bytes) });
      });
    },

    // A final pre-effect refusal (C2; disabled, no route), under the journal
    // lock. Legal only for a prepared request that has not entered: preparing,
    // prepared, authorizing or released. `refusal` is { code, at }, code one
    // of the final-refusal reasons; the store builds the record (binding the
    // checked receipt, or none before the check) and publishes slot 7. The
    // request is then refused with the mapped outcome. Entered, applied or
    // already refused is a conflict; an admitted request refuses.
    refusePreEffect(requestId, refusal) {
      if (!matches(UUID4, requestId) || !plain(refusal)) fail('invalid-owner-journal-record');
      const name = requestDirectoryName({ namespaceDigest, requestId });
      return locked(() => {
        if (!scan().includes(name)) fail('owner-journal-transition-refused');
        const graph = readGraph(name, requestId);
        if (['indeterminate', 'applied', 'refused'].includes(graph.state)) fail('owner-journal-conflict');
        if (!graph.refusable) fail('owner-journal-transition-refused');
        recoveryFlush(graph);
        const { preparation, preparationDigest, receiptDigest } = graph.refusable;
        let bytes;
        try {
          bytes = Buffer.from(canonicalJson(refusedRecordFor({ preparation, preparationDigest, receiptDigest, code: refusal.code, at: refusal.at })));
          bindEffect(decodeEffect(bytes), { phase: 'refused', preparation, preparationDigest, receiptDigest });
        } catch { fail('invalid-owner-journal-record'); }
        publish(graph.dir, 'pre-effect-refused', bytes, graph.binding);
        return settled(readGraph(name, requestId), { effectId: preparation.effectId });
      });
    },

    // Explicit recovery of one request after reopen. Absent is only "no such
    // directory"; otherwise the typed phase from readGraph, after the
    // recovery flush. An orphan, partial, corrupt or unsupported pre-entry
    // graph refuses.
    // It schedules nothing: no forward, delivery, check release or effect.
    recover(requestId) {
      if (!matches(UUID4, requestId)) fail('invalid-owner-journal-record');
      const name = requestDirectoryName({ namespaceDigest, requestId });
      return locked(() => {
        if (!scan().includes(name)) return { state: 'absent', requestId };
        const graph = readGraph(name, requestId);
        recoveryFlush(graph);
        return settled(graph, { recovered: true });
      });
    },

    // Admission. A new request reserves its directory, creates and zero-fills
    // all 15 fixed files, flushes and validates them, then publishes the
    // original action and acceptance-context in that order. An exact duplicate
    // writes nothing: it reads the saved graph and acknowledges only after the
    // recovery flush. Changed input for the same request is a conflict; an
    // orphan or any other graph refuses.
    admit(actionBytes, acceptanceBytes) {
      const saved = validateDaemonAdmission(actionBytes, acceptanceBytes, namespaceDigest);
      const binding = { namespaceDigest, requestId: saved.record.requestId };
      const name = requestDirectoryName(binding), dir = path.join(requests, name);
      return locked(() => {
        const entries = scan();
        if (entries.includes(name)) {
          const graph = readGraph(name, binding.requestId);
          if (!graph.saved.action.equals(saved.action) || !graph.saved.acceptance.equals(saved.acceptance)) fail('owner-journal-conflict');
          recoveryFlush(graph);
          return settled(graph, { duplicate: true });
        }
        if (entries.length >= DAEMON_JOURNAL_LIMIT) fail('owner-journal-capacity');
        io.mkdirSync(dir, { mode: 0o700 }); fault('request:directory-created');
        flushDirectory(io, requests); fault('request:directory-flushed');
        ownedDirectory(io, dir);
        for (const { name: fileName, size } of FILES) {
          const fd = io.openSync(path.join(dir, fileName), O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW, 0o600);
          try {
            fault(`initialize:${fileName}:created`);
            writeExactly(io, fd, Buffer.alloc(size), 0); fault(`initialize:${fileName}:zeroed`);
            try { io.fsyncSync(fd); } catch { fail('owner-journal-flush'); }
            fault(`initialize:${fileName}:flushed`);
          } finally { io.closeSync(fd); }
        }
        flushDirectory(io, dir); fault('request:files-flushed');
        const names = listBounded(io, dir, FILES.length).sort();
        if (names.join('\n') !== FILES.map((file) => file.name).sort().join('\n')) fail();
        for (const { name: fileName, size } of FILES) {
          const fd = openFixed(io, path.join(dir, fileName), size, O_RDONLY);
          try { if (!readExactly(io, fd, size).every((byte) => byte === 0)) fail(); } finally { io.closeSync(fd); }
        }
        publish(dir, 'original-action', saved.action, binding);
        publish(dir, 'acceptance-context', saved.acceptance, binding);
        return settled({ binding, name }, {});
      });
    },
  };
}
