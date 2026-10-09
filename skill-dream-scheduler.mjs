// Dream scheduling core (#603). No CLI, owner gate, timer loop or disk store is
// installed here. The daemon adapter must authorize controls and supply one
// atomic, revision-checked state+event store before exposing this service.
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { isAgentId } from './agent-identity.mjs';
import { dreamInputMetadataDigest, validateDreamInputMetadata } from './skill-dream-inputs.mjs';
import { dreamOutcomeDigest, validateDreamOutcome } from './skill-dream-outcomes.mjs';
import { validProcessOwnership } from './process-ownership.mjs';
import { acknowledgeDreamNotice, applyDreamNoticeRecovery, applyDreamNoticeRun, emptyDreamNoticeLedger, validateDreamNoticeLedger, DREAM_NOTICE_LIMITS } from './skill-dream-notices.mjs';

export const DREAM_TIMEOUT_MS = 10 * 60_000;
export const DREAM_REGISTRATION_LIMIT = 256;
const HOUR = 60 * 60_000;
const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const ACTIVE = ['running', 'cancelling', 'recovery-required'];
const TERMINAL = ['completed', 'failed', 'cancelled', 'timed-out'];
// Version 7 run records carry process ownership and may settle as interrupted.
const terminal = version => version >= 7 ? [...TERMINAL, 'interrupted'] : TERMINAL;
const fail = (code, message) => { throw Object.assign(new Error(message), { code }); };
const invalid = () => fail('dream-state-invalid', 'dream scheduler state is invalid; no dispatch occurred');
const id = value => typeof value === 'string' && UUID.test(value);
const root = value => typeof value === 'string' && value.length <= 4096 && !value.includes('\0') && path.isAbsolute(value) && path.resolve(value) === value;
const date = value => typeof value === 'string' && value.length === 24 && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
function synchronous(value) {
  if (value && typeof value.then === 'function') {
    // Reject a miswired async port without leaving its rejection unobserved.
    // Its outcome is still uncertain, so no execution may follow that commit.
    Promise.resolve(value).catch(() => {});
    fail('dream-configuration-invalid', 'dream storage ports must be synchronous');
  }
  return value;
}
function keys(value, expected) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== expected.length
    || expected.some(key => !Object.hasOwn(value, key))) invalid();
}
export function parseDreamSchedule(value) {
  if (typeof value !== 'string' || !/^PT[1-9]\d{0,2}H$/.test(value)) fail('dream-schedule-invalid', 'dream schedule must be PT<N>H with an integer from 1 to 720');
  const hours = Number(value.slice(2, -1));
  if (hours > 720) fail('dream-schedule-invalid', 'dream schedule must be PT<N>H with an integer from 1 to 720');
  return hours;
}
const emptyAt = schemaVersion => ({ schemaVersion, revision: 0, registrations: [], flights: [],
  ...(schemaVersion >= 2 ? { inputReceipts: [] } : {}), ...(schemaVersion >= 3 ? { outcomeReceipts: [] } : {}),
  ...(schemaVersion >= 4 ? { selectionCheckpoints: [] } : {}), ...(schemaVersion >= 5 ? { noticeLedgers: [] } : {}) });
export const emptyDreamState = () => emptyAt(7);
function inputReceipt(value) {
  keys(value, ['runId', 'journalRevision', 'startingRevision', 'digest']);
  const hash = value => typeof value === 'string' && value.length === 71 && /^sha256:[a-f0-9]{64}$/.test(value);
  if (!id(value.runId) || !Number.isSafeInteger(value.journalRevision) || value.journalRevision < 1
    || !hash(value.startingRevision) || !hash(value.digest)) invalid();
}
// Selection rotates bounded input pages; it never certifies processing or
// excludes an item from future cycles. A null cursor wraps to the first page.
function selectionCheckpoint(value) {
  keys(value, ['schemaVersion', 'agentId', 'generation', 'runId', 'journalRevision', 'sourceRevision', 'inputReceipt', 'nextCursor', 'coverage', 'processingCoverage']);
  const hash = value => typeof value === 'string' && value.length === 71 && /^sha256:[a-f0-9]{64}$/.test(value);
  if (value.schemaVersion !== 1 || !isAgentId(value.agentId) || !id(value.generation) || !id(value.runId)
    || !Number.isSafeInteger(value.journalRevision) || value.journalRevision < 1 || !hash(value.sourceRevision)
    || value.coverage !== 'selection-only' || value.processingCoverage !== 'unverified') invalid();
  inputReceipt(value.inputReceipt);
  if (value.inputReceipt.runId !== value.runId || value.inputReceipt.startingRevision !== value.sourceRevision
    || value.inputReceipt.journalRevision >= value.journalRevision) invalid();
  if (value.nextCursor !== null) {
    keys(value.nextCursor, ['revision', 'path']);
    // Reuse the actual reader's path eligibility through metadata validation.
    validateDreamInputMetadata({ schemaVersion: 1, revision: value.sourceRevision, sources: [],
      coverage: { definition: 'supported', memory: 'unsupported', conversations: 'unsupported', eligible: 1,
        selected: 0, suppliedBytes: 0, skippedBinary: 0, remaining: 1 }, nextCursor: value.nextCursor });
  }
}
function rebindSelection(state, registration) {
  const checkpoint = state.selectionCheckpoints.find(item => item.agentId === registration.agentId);
  if (checkpoint) checkpoint.generation = registration.generation;
}
// From version 7 `ownership` is null until the daemon records the agent's
// process group, before its first prompt, as `{ pgid, leaderStartedAt }`.
function runRecord(run, settled, version) {
  keys(run, ['runId', 'agentId', 'soulDir', 'generation', 'daemonGeneration', 'trigger', 'startedAt', 'endedAt', 'status', 'timeoutMs', 'cancelRequestedAt', 'cancelReason',
    ...(version >= 7 ? ['ownership'] : [])]);
  if (!id(run.runId) || !isAgentId(run.agentId) || !root(run.soulDir) || !id(run.generation) || !id(run.daemonGeneration)
    || !['due', 'manual'].includes(run.trigger) || !date(run.startedAt) || !(settled ? date(run.endedAt) : run.endedAt === null)
    || !(settled ? terminal(version) : ACTIVE).includes(run.status) || !Number.isSafeInteger(run.timeoutMs) || run.timeoutMs < 1 || run.timeoutMs > DREAM_TIMEOUT_MS
    || !(run.cancelRequestedAt === null && run.cancelReason === null || date(run.cancelRequestedAt) && ['owner', 'timeout', 'shutdown'].includes(run.cancelReason))) invalid();
  if (run.status === 'cancelling' && run.cancelReason === null || run.status === 'cancelled' && !['owner', 'shutdown'].includes(run.cancelReason)
    || run.status === 'timed-out' && run.cancelReason !== 'timeout'
    || ['running', 'failed'].includes(run.status) && run.cancelReason !== null
    || version >= 7 && run.ownership !== null && !validProcessOwnership(run.ownership)) invalid();
}
export function validateDreamState(state) {
  keys(state, ['schemaVersion', 'revision', 'registrations', 'flights', ...(state?.schemaVersion >= 2 ? ['inputReceipts'] : []), ...(state?.schemaVersion >= 3 ? ['outcomeReceipts'] : []), ...(state?.schemaVersion >= 4 ? ['selectionCheckpoints'] : []), ...(state?.schemaVersion >= 5 ? ['noticeLedgers'] : [])]);
  if (![1, 2, 3, 4, 5, 6, 7].includes(state.schemaVersion) || !Number.isSafeInteger(state.revision) || state.revision < 0
    || !Array.isArray(state.registrations) || state.registrations.length > DREAM_REGISTRATION_LIMIT
    || !Array.isArray(state.flights) || state.flights.length > DREAM_REGISTRATION_LIMIT) invalid();
  const agents = new Set(), generations = new Set(), flying = new Set(), runs = new Set();
  const directoryOwners = new Map();
  const ownsDirectory = (agentId, soulDir) => {
    if (directoryOwners.has(soulDir) && directoryOwners.get(soulDir) !== agentId) invalid();
    directoryOwners.set(soulDir, agentId);
  };
  for (const row of state.registrations) {
    keys(row, ['agentId', 'soulDir', 'generation', 'intervalHours', 'paused', 'nextDueAt', 'createdAt', 'updatedAt', 'lastRun']);
    if (!isAgentId(row.agentId) || agents.has(row.agentId) || !root(row.soulDir) || !id(row.generation) || generations.has(row.generation)
      || !Number.isSafeInteger(row.intervalHours) || row.intervalHours < 1 || row.intervalHours > 720
      || typeof row.paused !== 'boolean' || !(row.paused ? row.nextDueAt === null : date(row.nextDueAt))
      || !date(row.createdAt) || !date(row.updatedAt)) invalid();
    if (row.lastRun !== null) { runRecord(row.lastRun, true, state.schemaVersion); if (row.lastRun.agentId !== row.agentId || row.lastRun.soulDir !== row.soulDir) invalid(); }
    ownsDirectory(row.agentId, row.soulDir);
    agents.add(row.agentId); generations.add(row.generation);
  }
  for (const run of state.flights) {
    runRecord(run, false, state.schemaVersion);
    ownsDirectory(run.agentId, run.soulDir);
    if (flying.has(run.agentId) || runs.has(run.runId)) invalid();
    flying.add(run.agentId); runs.add(run.runId);
  }
  if (state.schemaVersion >= 2) {
    if (!Array.isArray(state.inputReceipts) || state.inputReceipts.length > 2 * DREAM_REGISTRATION_LIMIT) invalid();
    const retained = new Set([...runs, ...state.registrations.flatMap(row => row.lastRun ? [row.lastRun.runId] : [])]), seen = new Set();
    for (const receipt of state.inputReceipts) {
      inputReceipt(receipt);
      if (!retained.has(receipt.runId) || seen.has(receipt.runId) || receipt.journalRevision > state.revision) invalid();
      seen.add(receipt.runId);
    }
  }
  if (state.schemaVersion >= 3) {
    if (!Array.isArray(state.outcomeReceipts) || state.outcomeReceipts.length > DREAM_REGISTRATION_LIMIT) invalid();
    const retained = new Set(state.registrations.flatMap(row => row.lastRun ? [row.lastRun.runId] : [])), seen = new Set();
    for (const receipt of state.outcomeReceipts) {
      inputReceipt(receipt);
      if (!retained.has(receipt.runId) || seen.has(receipt.runId) || receipt.journalRevision > state.revision) invalid();
      seen.add(receipt.runId);
    }
  }
  if (state.schemaVersion >= 4) {
    if (!Array.isArray(state.selectionCheckpoints) || state.selectionCheckpoints.length > DREAM_REGISTRATION_LIMIT) invalid();
    const seen = new Set();
    for (const checkpoint of state.selectionCheckpoints) {
      selectionCheckpoint(checkpoint);
      if (seen.has(checkpoint.agentId) || checkpoint.journalRevision > state.revision
        || !state.registrations.some(row => row.agentId === checkpoint.agentId && row.generation === checkpoint.generation)) invalid();
      seen.add(checkpoint.agentId);
    }
  }
  if (state.schemaVersion >= 5) {
    // Live notices only, each soul's set byte-bounded by the notice module:
    // every transaction copies this state. From version 6 a soul's ledger also
    // outlives its registration while a quarantined flight survives, and may
    // carry the `recovery` kind that version 5 readers do not know.
    if (!Array.isArray(state.noticeLedgers) || state.noticeLedgers.length > DREAM_REGISTRATION_LIMIT) invalid();
    const seen = new Set();
    for (const ledger of state.noticeLedgers) {
      try { validateDreamNoticeLedger(ledger); } catch { invalid(); }
      if (seen.has(ledger.agentId) || !agents.has(ledger.agentId) && !(state.schemaVersion >= 6 && flying.has(ledger.agentId))
        || !ledger.notices.length && !ledger.suppressed
        || state.schemaVersion === 5 && ledger.notices.some(notice => notice.kind === 'recovery')) invalid();
      seen.add(ledger.agentId);
    }
  }
  return state;
}

function noticeRecords(agentId, notices, cleared = false) {
  if (!Array.isArray(notices) || notices.length > DREAM_NOTICE_LIMITS.perSoul) invalid();
  const records = notices.map(notice => {
    if (!cleared) return notice;
    if (!notice || typeof notice !== 'object' || !date(notice.clearedAt)) invalid();
    const { clearedAt: _clearedAt, ...rest } = notice;
    return rest;
  });
  try { validateDreamNoticeLedger({ schemaVersion: 1, agentId, lastRunId: null, suppressed: 0, notices: records }); } catch { invalid(); }
}

// Shared with durable adapters so persisted events cannot acquire fields that
// the scheduling core would never emit. Only the typed outcome event may carry
// a bounded, explicitly unverified report preview; it never carries a prompt.
export function validateDreamEvents(events, { state = null } = {}) {
  if (!Array.isArray(events) || events.length < 1 || events.length > DREAM_REGISTRATION_LIMIT) invalid();
  // A stateless check reads a run's version from its shape; with state, the
  // transaction's own version decides.
  const version = run => state?.schemaVersion ?? (run && typeof run === 'object' && Object.hasOwn(run, 'ownership') ? 7 : 6);
  for (const event of events) {
    if (event?.kind === 'notices-updated') {
      // Created and cleared notice records are the append-only history; state
      // keeps only live ones. Must accompany the same run's terminal facts, or
      // its quarantine, which only creates or renews the recovery notice.
      keys(event, ['kind', 'at', 'run', 'created', 'renewed', 'cleared', 'suppressed']);
      if (!date(event.at)) invalid();
      const recovery = event.run?.status === 'recovery-required';
      runRecord(event.run, !recovery, version(event.run));
      noticeRecords(event.run.agentId, event.created); noticeRecords(event.run.agentId, event.cleared, true);
      if (!Array.isArray(event.renewed) || event.renewed.length > DREAM_NOTICE_LIMITS.perSoul
        || event.renewed.some(value => typeof value !== 'string' || !/^ntc_[a-f0-9]{24}$/.test(value))
        || !Number.isSafeInteger(event.suppressed) || event.suppressed < 0
        || !event.created.length && !event.renewed.length && !event.cleared.length && !event.suppressed
        || !events.some(row => row.kind === (recovery ? 'recovery-required' : 'ended') && isDeepStrictEqual(row.run, event.run))
        || recovery && (event.cleared.length || event.suppressed || event.created.length + event.renewed.length !== 1
          || event.created.some(notice => notice.kind !== 'recovery'))) invalid();
      if (state) {
        const ledger = state.schemaVersion >= 5 ? state.noticeLedgers.find(row => row.agentId === event.run.agentId) : undefined;
        // A recovery notice does not advance the terminal-run cursor; it names the run itself.
        const named = noticeId => recovery ? ledger?.notices.some(row => row.id === noticeId && row.kind === 'recovery' && row.lastRunId === event.run.runId)
          : ledger?.lastRunId === event.run.runId;
        if (state.schemaVersion < (recovery ? 6 : 5)
          || [...event.created.map(notice => notice.id), ...event.renewed].some(noticeId => !named(noticeId))
          || event.created.some(notice => !ledger.notices.some(row => row.id === notice.id))
          || event.renewed.some(noticeId => !ledger.notices.some(row => row.id === noticeId))
          || event.cleared.some(notice => ledger?.notices.some(row => row.id === notice.id))) invalid();
      }
      continue;
    }
    if (event?.kind === 'notice-acknowledged') {
      keys(event, ['kind', 'at', 'agentId', 'noticeId']);
      if (!date(event.at) || !isAgentId(event.agentId) || typeof event.noticeId !== 'string' || !/^ntc_[a-f0-9]{24}$/.test(event.noticeId)) invalid();
      if (state && (state.schemaVersion < 5 || !state.noticeLedgers.some(row => row.agentId === event.agentId
        && row.notices.some(notice => notice.id === event.noticeId && notice.acknowledgedAt === event.at)))) invalid();
      continue;
    }
    if (event?.kind === 'selection-advanced') {
      keys(event, ['kind', 'at', 'run', 'checkpoint']);
      if (!date(event.at)) invalid();
      runRecord(event.run, true, version(event.run)); selectionCheckpoint(event.checkpoint);
      if (event.run.status !== 'completed' || event.run.cancelRequestedAt !== null
        || event.checkpoint.agentId !== event.run.agentId || event.checkpoint.generation !== event.run.generation
        || event.checkpoint.runId !== event.run.runId
        || !events.some(row => row.kind === 'outcome-recorded' && isDeepStrictEqual(row.run, event.run)
          && row.outcome?.report?.status === 'structured' && row.outcome.startingRevision === event.checkpoint.sourceRevision)
        || !events.some(row => row.kind === 'ended' && isDeepStrictEqual(row.run, event.run))) invalid();
      if (state && (state.schemaVersion < 4 || event.checkpoint.journalRevision !== state.revision
        || !state.selectionCheckpoints.some(row => isDeepStrictEqual(row, event.checkpoint)))) invalid();
      continue;
    }
    if (event?.kind === 'outcome-recorded') {
      keys(event, ['kind', 'at', 'run', 'receipt', 'outcome']);
      if (!date(event.at)) invalid();
      runRecord(event.run, true, version(event.run)); inputReceipt(event.receipt); validateDreamOutcome(event.outcome, { runId: event.run.runId });
      if (event.receipt.runId !== event.run.runId || event.receipt.startingRevision !== event.outcome.startingRevision
        || event.receipt.digest !== dreamOutcomeDigest(event.outcome)) invalid();
      if (state && (state.schemaVersion < 3 || event.receipt.journalRevision !== state.revision
        || state.registrations.some(row => row.lastRun?.runId === event.run.runId)
        && !state.outcomeReceipts.some(receipt => isDeepStrictEqual(receipt, event.receipt)))) invalid();
      if (!events.some(ended => ended.kind === 'ended' && isDeepStrictEqual(ended.run, event.run))) invalid();
      continue;
    }
    if (event?.kind === 'inputs-prepared') {
      keys(event, ['kind', 'at', 'run', 'receipt', 'inputs']);
      if (!date(event.at) || event.run?.status !== 'running') invalid();
      runRecord(event.run, false, version(event.run)); inputReceipt(event.receipt); validateDreamInputMetadata(event.inputs);
      if (event.receipt.runId !== event.run.runId || event.receipt.startingRevision !== event.inputs.revision
        || event.receipt.digest !== dreamInputMetadataDigest(event.inputs)) invalid();
      if (state && (state.schemaVersion < 2 || event.receipt.journalRevision !== state.revision
        || !state.inputReceipts.some(receipt => isDeepStrictEqual(receipt, event.receipt))
        || !state.flights.some(run => isDeepStrictEqual(run, event.run)))) invalid();
      continue;
    }
    const registrationEvent = ['registered', 'paused', 'unscheduled'].includes(event?.kind);
    keys(event, ['kind', 'at', registrationEvent ? 'registration' : 'run']);
    if (!date(event.at)) invalid();
    if (registrationEvent) {
      validateDreamState({ ...emptyAt(version(event.registration?.lastRun)), registrations: [event.registration] });
      if (event.kind === 'registered' && event.registration.paused || event.kind === 'paused' && !event.registration.paused) invalid();
    } else {
      const statuses = { started: ['running'], 'cancellation-requested': ['cancelling'], ended: terminal(7), 'recovery-required': ['recovery-required'],
        'ownership-recorded': ['running', 'cancelling'] };
      if (!Object.hasOwn(statuses, event.kind) || !statuses[event.kind].includes(event.run?.status)) invalid();
      runRecord(event.run, event.kind === 'ended', version(event.run));
      if (event.kind === 'ownership-recorded' && (version(event.run) < 7 || event.run.ownership === null
        || state && !state.flights.some(run => isDeepStrictEqual(run, event.run)))) invalid();
    }
  }
  return events;
}

/**
 * `store.read()` returns the current state or null. Synchronous
 * `store.commit({ expectedRevision, state, events })` MUST atomically compare
 * the revision, retain the bounded events in durable history, and replace the
 * state; return true only after success. A false/throwing/ambiguous commit
 * freezes this instance. There is deliberately no unsafe in-memory default.
 *
 * `soulDirectory(agentId)` is the population's canonical, verified real root,
 * not a caller-controlled path. Execution is the daemon's configured turn
 * port. This core never interprets an agent reply as maintenance evidence.
 * Its execute port may prepare inputs durably, then stage one typed outcome.
 * Staging acknowledges no persistence: the outcome and terminal run facts
 * publish in the same final transaction, or the lease remains uncertain.
 *
 * `processOwnership` is the process-group evidence port (process-ownership.mjs).
 * Its synchronous `record(pid)` runs before the agent's first prompt and its
 * synchronous `inspect` and async `terminate` serve restart recovery. The
 * default reports `unsupported`, so every interrupted run is quarantined.
 */
const UNSUPPORTED_OWNERSHIP = Object.freeze({ record: () => null, inspect: () => 'unsupported', terminate: async () => false });
export function createDreamScheduler({ store, execute, soulDirectory, isPaused = () => false, isBusy = () => false,
  now = () => new Date(), idFactory = randomUUID, daemonGeneration = randomUUID(), maxConcurrent = 1,
  turnTimeoutMs = DREAM_TIMEOUT_MS, setTimer = setTimeout, clearTimer = clearTimeout, processOwnership = UNSUPPORTED_OWNERSHIP } = {}) {
  if (typeof store?.read !== 'function' || typeof store?.commit !== 'function' || typeof execute !== 'function' || typeof soulDirectory !== 'function'
    || ['record', 'inspect', 'terminate'].some(name => typeof processOwnership?.[name] !== 'function')
    || !id(daemonGeneration) || !Number.isSafeInteger(maxConcurrent) || maxConcurrent < 1 || maxConcurrent > 16
    || !Number.isSafeInteger(turnTimeoutMs) || turnTimeoutMs < 1 || turnTimeoutMs > DREAM_TIMEOUT_MS) {
    fail('dream-configuration-invalid', 'dream scheduling requires atomic storage, execution and canonical soul-directory ports with bounded concurrency and timeout');
  }
  // `reaping` holds this daemon's recovery terminations of earlier orphans.
  const live = new Map(), reaping = new Map();
  let fault = null;
  const read = () => {
    const observed = synchronous(store.read());
    const state = structuredClone(validateDreamState(observed === null ? emptyDreamState() : observed));
    if (state.schemaVersion >= 7) return state;
    // Upgrade only the next transaction, leaving historical v1 bytes intact.
    // An older run recorded no ownership, so its interruption stays ambiguous.
    const unowned = run => run === null ? null : { ...run, ownership: null };
    return { ...state, schemaVersion: 7, inputReceipts: state.inputReceipts ?? [],
      outcomeReceipts: state.outcomeReceipts ?? [], selectionCheckpoints: state.selectionCheckpoints ?? [], noticeLedgers: state.noticeLedgers ?? [],
      registrations: state.registrations.map(row => ({ ...row, lastRun: unowned(row.lastRun) })), flights: state.flights.map(unowned) };
  };
  const healthy = () => { if (fault) fail(fault, 'dream scheduler state is uncertain; restart recovery is required'); };
  const time = () => { const value = now().toISOString(); if (!date(value)) invalid(); return value; };
  const later = (at, hours) => { const value = new Date(Date.parse(at) + hours * HOUR).toISOString(); if (!date(value)) invalid(); return value; };
  const newId = state => {
    const value = idFactory();
    if (!id(value) || state.registrations.some(row => row.generation === value) || state.flights.some(run => run.runId === value)) invalid();
    return value;
  };
  function persist(state, events) {
    healthy();
    const expectedRevision = state.revision;
    state.revision++;
    const retained = new Set([...state.flights.map(run => run.runId), ...state.registrations.flatMap(row => row.lastRun ? [row.lastRun.runId] : [])]);
    state.inputReceipts = state.inputReceipts.filter(receipt => retained.has(receipt.runId));
    const latest = new Set(state.registrations.flatMap(row => row.lastRun ? [row.lastRun.runId] : []));
    state.outcomeReceipts = state.outcomeReceipts.filter(receipt => latest.has(receipt.runId));
    state.selectionCheckpoints = state.selectionCheckpoints.filter(checkpoint => state.registrations.some(row => row.agentId === checkpoint.agentId));
    // Unscheduling cannot clear a quarantine, so its notice outlives the registration too.
    state.noticeLedgers = state.noticeLedgers.filter(ledger => state.registrations.some(row => row.agentId === ledger.agentId)
      || state.flights.some(run => run.agentId === ledger.agentId));
    validateDreamState(state);
    validateDreamEvents(events, { state });
    try {
      if (synchronous(store.commit({ expectedRevision, state: structuredClone(state), events: structuredClone(events) })) !== true) {
        fault = 'dream-store-conflict';
        fail(fault, 'dream state changed or was not durably committed');
      }
      if (!isDeepStrictEqual(read(), state)) {
        fault = 'dream-store-conflict';
        fail(fault, 'acknowledged dream state did not read back unchanged');
      }
    } catch {
      fault ??= 'dream-store-failed';
      fail(fault, 'dream scheduler could not confirm durable state; no further dispatch is allowed');
    }
  }
  function canonical(agentId) {
    if (!isAgentId(agentId)) fail('dream-soul-invalid', 'select a valid soul ID');
    const dir = soulDirectory(agentId);
    if (!root(dir)) fail('dream-binding-unavailable', 'the soul has no verified canonical directory');
    return dir;
  }
  const registration = (state, agentId) => {
    const row = state.registrations.find(item => item.agentId === agentId);
    if (!row) fail('dream-unregistered', 'the soul has no dream registration on this host');
    return row;
  };
  function register(agentId, schedule) {
    healthy();
    const intervalHours = parseDreamSchedule(schedule), soulDir = canonical(agentId), state = read();
    let row = state.registrations.find(item => item.agentId === agentId);
    if (row && row.soulDir !== soulDir) fail('dream-binding-changed', 'unschedule the old directory before registering this soul at its new location');
    if (row && !row.paused && row.intervalHours === intervalHours) return structuredClone(row);
    if (!row && state.registrations.length >= DREAM_REGISTRATION_LIMIT) fail('dream-capacity', 'dream registration limit reached');
    const at = time(), generation = newId(state);
    if (!row) { row = { agentId, soulDir, createdAt: at, lastRun: null }; state.registrations.push(row); }
    Object.assign(row, { generation, intervalHours, paused: false, nextDueAt: later(at, intervalHours), updatedAt: at });
    rebindSelection(state, row);
    persist(state, [{ kind: 'registered', at, registration: row }]);
    return structuredClone(row);
  }
  function pause(agentId) {
    healthy();
    const state = read(), row = registration(state, agentId);
    if (row.paused) return structuredClone(row);
    const at = time();
    Object.assign(row, { generation: newId(state), paused: true, nextDueAt: null, updatedAt: at });
    rebindSelection(state, row);
    persist(state, [{ kind: 'paused', at, registration: row }]);
    return structuredClone(row);
  }
  function unschedule(agentId) {
    healthy();
    const state = read(), row = state.registrations.find(item => item.agentId === agentId);
    if (!row) return { removed: false };
    state.registrations = state.registrations.filter(item => item !== row);
    // The independent flight survives even when its registration disappears.
    persist(state, [{ kind: 'unscheduled', at: time(), registration: row }]);
    return { removed: true };
  }
  function cancel(runId, reason = 'owner') {
    const entry = live.get(runId);
    if (!entry) return { requested: false, reason: 'not-owned-by-this-daemon' };
    if (entry.controller.signal.aborted) return { requested: true, settled: false };
    entry.reason = reason;
    entry.controller.abort(new DOMException(reason === 'timeout' ? 'dream deadline reached' : 'dream cancellation requested', 'AbortError'));
    try {
      healthy();
      const state = read(), run = state.flights.find(item => item.runId === runId);
      if (!run) invalid();
      Object.assign(run, { status: 'cancelling', cancelRequestedAt: time(), cancelReason: reason });
      persist(state, [{ kind: 'cancellation-requested', at: run.cancelRequestedAt, run }]);
    } catch (error) { fault ??= 'dream-store-failed'; throw error; }
    return { requested: true, settled: false };
  }
  function start(agentId, trigger) {
    healthy();
    const state = read(), row = registration(state, agentId);
    const defer = reason => ({ agentId, status: 'deferred', reason });
    if (row.paused || isPaused(agentId)) return defer('paused');
    const old = state.flights.find(run => run.agentId === agentId);
    if (old) return defer(live.has(old.runId) ? 'already-running' : reaping.has(old.runId) ? 'recovering' : 'recovery-required');
    if (live.size >= maxConcurrent || state.flights.length >= DREAM_REGISTRATION_LIMIT) return defer('capacity');
    if (isBusy(agentId)) return defer('busy');
    try { if (canonical(agentId) !== row.soulDir) return defer('binding-changed'); }
    catch { return defer('binding-unavailable'); }
    const at = time();
    if (trigger === 'due' && Date.parse(row.nextDueAt) > Date.parse(at)) return defer('not-due');
    const run = { runId: newId(state), agentId, soulDir: row.soulDir, generation: row.generation, daemonGeneration,
      trigger, startedAt: at, endedAt: null, status: 'running', timeoutMs: turnTimeoutMs, cancelRequestedAt: null, cancelReason: null, ownership: null };
    state.flights.push(run);
    persist(state, [{ kind: 'started', at, run }]); // must precede any executor call
    const entry = { controller: new AbortController(), timer: null, reason: null, done: null, inputs: null, outcome: null };
    live.set(run.runId, entry);
    try {
      entry.timer = setTimer(() => { try { cancel(run.runId, 'timeout'); } catch { /* fault retained; lease cannot be released */ } }, turnTimeoutMs);
    } catch {
      fault = 'dream-timer-failed';
      live.delete(run.runId);
      fail(fault, 'dream deadline could not be installed; recovery is required');
    }
    const finish = failed => {
      try {
        clearTimer(entry.timer);
        healthy();
        const current = read(), lease = current.flights.find(item => item.runId === run.runId);
        if (!lease) invalid();
        // A requested abort is not evidence that successful execution stopped.
        // Keep the request on the receipt, but report the executor's settlement.
        const endedAt = time(), status = !failed ? 'completed'
          : entry.controller.signal.aborted ? entry.reason === 'timeout' ? 'timed-out' : 'cancelled' : 'failed';
        const result = { ...lease, status, endedAt };
        current.flights = current.flights.filter(item => item.runId !== run.runId);
        const owner = current.registrations.find(item => item.agentId === agentId && item.generation === run.generation);
        if (owner) { owner.lastRun = result; if (!owner.paused) owner.nextDueAt = later(endedAt, owner.intervalHours); }
        const events = [{ kind: 'ended', at: endedAt, run: result }];
        if (entry.outcome !== null) {
          const receipt = { runId: run.runId, journalRevision: current.revision + 1, startingRevision: entry.outcome.startingRevision, digest: dreamOutcomeDigest(entry.outcome) };
          current.outcomeReceipts.push(receipt);
          events.push({ kind: 'outcome-recorded', at: endedAt, run: result, receipt, outcome: entry.outcome });
        }
        if (owner && status === 'completed' && result.cancelRequestedAt === null && entry.inputs !== null
          && entry.outcome?.report.status === 'structured') {
          const checkpoint = { schemaVersion: 1, agentId, generation: owner.generation, runId: run.runId,
            journalRevision: current.revision + 1, sourceRevision: entry.inputs.revision,
            inputReceipt: structuredClone(current.inputReceipts.find(receipt => receipt.runId === run.runId)),
            nextCursor: structuredClone(entry.inputs.nextCursor), coverage: 'selection-only', processingCoverage: 'unverified' };
          current.selectionCheckpoints = current.selectionCheckpoints.filter(item => item.agentId !== agentId);
          current.selectionCheckpoints.push(checkpoint);
          events.push({ kind: 'selection-advanced', at: endedAt, run: result, checkpoint });
        }
        noticeRun(current, events, result, entry);
        persist(current, events);
        live.delete(run.runId);
        return structuredClone(result);
      } catch {
        fault ??= 'dream-store-failed';
        // Keep the slot and durable flight. Losing a completion receipt is
        // uncertainty, never permission to rerun an already executed turn.
        return { runId: run.runId, status: 'persistence-failed', reason: fault };
      }
    };
    entry.done = Promise.resolve().then(() => {
      entry.controller.signal.throwIfAborted();
      const prepareInputs = inputs => {
        healthy(); entry.controller.signal.throwIfAborted();
        const current = read(), lease = current.flights.find(item => item.runId === run.runId);
        if (live.get(run.runId) !== entry || lease?.status !== 'running' || current.inputReceipts.some(receipt => receipt.runId === run.runId)) {
          fail('dream-input-preparation-refused', 'Input preparation requires a live run without a previous input receipt.');
        }
        const metadata = structuredClone(validateDreamInputMetadata(inputs));
        const receipt = { runId: run.runId, journalRevision: current.revision + 1, startingRevision: metadata.revision, digest: dreamInputMetadataDigest(metadata) };
        current.inputReceipts.push(receipt);
        persist(current, [{ kind: 'inputs-prepared', at: time(), run: lease, receipt, inputs: metadata }]);
        entry.inputs = metadata;
        return structuredClone(receipt);
      };
      // The agent's group is durable before its first prompt, or that prompt
      // is never sent. A crash before this commit leaves no ownership, so the
      // interrupted run stays recovery-required.
      const recordProcess = ({ pid } = {}) => {
        healthy();
        const current = read(), lease = current.flights.find(item => item.runId === run.runId);
        if (live.get(run.runId) !== entry || !['running', 'cancelling'].includes(lease?.status) || lease.ownership !== null) {
          fail('dream-ownership-refused', 'Process ownership requires a live run without recorded ownership.');
        }
        const ownership = synchronous(processOwnership.record(pid));
        if (ownership === null) return null; // unsupported platform
        if (!validProcessOwnership(ownership) || ownership.pgid !== pid) fail('dream-ownership-unavailable', 'Process ownership evidence is incomplete.');
        lease.ownership = { pgid: ownership.pgid, leaderStartedAt: ownership.leaderStartedAt };
        persist(current, [{ kind: 'ownership-recorded', at: time(), run: lease }]);
        return structuredClone(lease.ownership);
      };
      const stageOutcome = outcome => {
        healthy();
        if (live.get(run.runId) !== entry || entry.inputs === null || entry.outcome !== null) {
          fail('dream-outcome-refused', 'An outcome requires a live prepared run without a previous outcome.');
        }
        entry.outcome = structuredClone(validateDreamOutcome(outcome, { runId: run.runId, inputs: entry.inputs }));
      };
      return execute({ run: structuredClone(run), selectionCheckpoint: structuredClone(state.selectionCheckpoints.find(item => item.agentId === agentId) ?? null), signal: entry.controller.signal, timeoutMs: turnTimeoutMs, prepareInputs, recordProcess, stageOutcome });
    }).then(() => finish(false), () => finish(true));
    return { agentId, runId: run.runId, status: 'started', done: entry.done };
  }
  // Notices publish with the terminal run facts they derive from. A soul
  // without a registration keeps no notices (unscheduling removes them), and
  // an empty ledger is not retained, so quiet souls add nothing to state.
  function noticeRun(current, events, run, entry) {
    if (!current.registrations.some(row => row.agentId === run.agentId)) return;
    const before = current.noticeLedgers.find(row => row.agentId === run.agentId) ?? emptyDreamNoticeLedger(run.agentId);
    let applied;
    // The core accepts any staged outcome before settlement; the notice module
    // treats only a completed attempt's report as evidence. An inconsistent pair
    // still yields the terminal-fact notices rather than blocking publication.
    try { applied = applyDreamNoticeRun(before, { run, outcome: entry.outcome, inputs: entry.outcome === null ? null : entry.inputs }); }
    catch {
      try { applied = applyDreamNoticeRun(before, { run }); } catch { return; }
    }
    current.noticeLedgers = current.noticeLedgers.filter(row => row.agentId !== run.agentId);
    if (applied.ledger.notices.length || applied.ledger.suppressed) current.noticeLedgers.push(applied.ledger);
    if (applied.created.length || applied.renewed.length || applied.cleared.length || applied.suppressed) {
      events.push({ kind: 'notices-updated', at: run.endedAt, run,
        created: applied.ledger.notices.filter(notice => applied.created.includes(notice.id)),
        renewed: applied.renewed, cleared: applied.cleared, suppressed: applied.suppressed });
    }
  }
  // An owner-authorized host read. Acknowledging an already acknowledged
  // notice writes nothing; a cleared or unknown notice is not found.
  function acknowledgeNotice(agentId, noticeId) {
    healthy();
    const state = read(), ledger = state.noticeLedgers.find(row => row.agentId === agentId);
    const found = ledger?.notices.find(notice => notice.id === noticeId);
    if (!found) fail('dream-notice-not-found', 'No live dream notice with that ID belongs to this soul.');
    if (found.acknowledgedAt !== null) return { agentId, notice: structuredClone(found) };
    const at = time(), next = acknowledgeDreamNotice(ledger, { noticeId, at });
    state.noticeLedgers = state.noticeLedgers.map(row => row === ledger ? next : row);
    persist(state, [{ kind: 'notice-acknowledged', at, agentId, noticeId }]);
    return { agentId, notice: structuredClone(next.notices.find(notice => notice.id === noticeId)) };
  }
  // Recording the quarantine never depends on its notice: a notice fault leaves
  // the soul's ledger as it was, and the quarantine is still journaled.
  function recoveryNotice(state, events, run, at) {
    let applied;
    try {
      const ledger = state.noticeLedgers.find(row => row.agentId === run.agentId) ?? emptyDreamNoticeLedger(run.agentId);
      applied = applyDreamNoticeRecovery(ledger, { run, at });
    } catch { return; }
    if (!applied.created.length && !applied.renewed.length) return;
    state.noticeLedgers = [...state.noticeLedgers.filter(row => row.agentId !== run.agentId), applied.ledger];
    events.push({ kind: 'notices-updated', at, run: structuredClone(run),
      created: applied.ledger.notices.filter(notice => applied.created.includes(notice.id)),
      renewed: applied.renewed, cleared: [], suppressed: 0 });
  }
  const quarantine = (state, events, run, at) => {
    run.status = 'recovery-required';
    events.push({ kind: 'recovery-required', at, run });
    recoveryNotice(state, events, run, at);
  };
  // Verified group absence settles the lease as interrupted, never successful.
  // The notice vocabulary has no interrupted condition, so none is published.
  function settle(state, events, run, at) {
    const result = { ...run, status: 'interrupted', endedAt: at };
    state.flights = state.flights.filter(item => item.runId !== run.runId);
    const owner = state.registrations.find(item => item.agentId === run.agentId && item.generation === run.generation);
    if (owner) { owner.lastRun = result; if (!owner.paused) owner.nextDueAt = later(at, owner.intervalHours); }
    events.push({ kind: 'ended', at, run: result });
  }
  // Only ownership an earlier daemon recorded can be inspected. Any port
  // failure or unknown answer is ambiguous, and an ambiguous run is never signalled.
  function verdict(run) {
    if (run.ownership === null || run.daemonGeneration === daemonGeneration) return 'ambiguous';
    try {
      const found = synchronous(processOwnership.inspect(structuredClone(run.ownership)));
      return ['absent', 'owned'].includes(found) ? found : 'ambiguous';
    } catch { return 'ambiguous'; }
  }
  async function reap(run) {
    try { await processOwnership.terminate(structuredClone(run.ownership)); } catch { /* the probe below decides */ }
    try {
      healthy();
      const state = read(), current = state.flights.find(item => item.runId === run.runId), events = [], at = time();
      if (!current || current.status === 'recovery-required') return;
      if (verdict(current) === 'absent') settle(state, events, current, at); else quarantine(state, events, current, at);
      persist(state, events);
    } catch { fault ??= 'dream-store-failed'; }
    finally { reaping.delete(run.runId); }
  }
  // Absent groups settle and ambiguous ones are quarantined in one
  // transaction. An owned live group keeps its lease while the termination
  // ladder runs; it settles only if the group is then absent.
  function recover() {
    healthy();
    const state = read(), events = [], at = time(), owned = [];
    let quarantined = 0, settled = 0;
    for (const run of [...state.flights]) {
      if (live.has(run.runId) || reaping.has(run.runId) || run.status === 'recovery-required') continue;
      const found = verdict(run);
      if (found === 'absent') { settle(state, events, run, at); settled++; }
      else if (found === 'owned') owned.push(structuredClone(run));
      else { quarantine(state, events, run, at); quarantined++; }
    }
    if (events.length) persist(state, events);
    for (const run of owned) reaping.set(run.runId, Promise.resolve().then(() => reap(run)));
    return { quarantined, settled, terminating: owned.length };
  }
  return {
    register, pause, unschedule, recover, acknowledgeNotice,
    recovering: () => Promise.allSettled([...reaping.values()]).then(() => undefined),
    cancel: (runId, reason = 'owner') => {
      if (!['owner', 'shutdown'].includes(reason)) fail('dream-cancellation-invalid', 'Cancellation must identify an owner request or daemon shutdown.');
      return cancel(runId, reason);
    },
    runNow: agentId => start(agentId, 'manual'),
    tick() {
      healthy();
      const at = Date.parse(time());
      return read().registrations.filter(row => !row.paused && Date.parse(row.nextDueAt) <= at)
        .sort((a, b) => a.nextDueAt.localeCompare(b.nextDueAt) || a.agentId.localeCompare(b.agentId)).map(row => start(row.agentId, 'due'));
    },
    status() { return { ...read(), fault }; },
  };
}
