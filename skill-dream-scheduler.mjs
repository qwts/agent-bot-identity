// Dream scheduling core (#603). No CLI, owner gate, timer loop or disk store is
// installed here. The daemon adapter must authorize controls and supply one
// atomic, revision-checked state+event store before exposing this service.
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { isAgentId } from './agent-identity.mjs';

export const DREAM_TIMEOUT_MS = 10 * 60_000;
export const DREAM_REGISTRATION_LIMIT = 256;
const HOUR = 60 * 60_000;
const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const ACTIVE = ['running', 'cancelling', 'recovery-required'];
const TERMINAL = ['completed', 'failed', 'cancelled', 'timed-out'];
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
export const emptyDreamState = () => ({ schemaVersion: 1, revision: 0, registrations: [], flights: [] });
function runRecord(run, terminal) {
  keys(run, ['runId', 'agentId', 'soulDir', 'generation', 'daemonGeneration', 'trigger', 'startedAt', 'endedAt', 'status', 'timeoutMs', 'cancelRequestedAt', 'cancelReason']);
  if (!id(run.runId) || !isAgentId(run.agentId) || !root(run.soulDir) || !id(run.generation) || !id(run.daemonGeneration)
    || !['due', 'manual'].includes(run.trigger) || !date(run.startedAt) || !(terminal ? date(run.endedAt) : run.endedAt === null)
    || !(terminal ? TERMINAL : ACTIVE).includes(run.status) || !Number.isSafeInteger(run.timeoutMs) || run.timeoutMs < 1 || run.timeoutMs > DREAM_TIMEOUT_MS
    || !(run.cancelRequestedAt === null && run.cancelReason === null || date(run.cancelRequestedAt) && ['owner', 'timeout'].includes(run.cancelReason))) invalid();
  if (run.status === 'cancelling' && run.cancelReason === null || run.status === 'cancelled' && run.cancelReason !== 'owner'
    || run.status === 'timed-out' && run.cancelReason !== 'timeout'
    || ['running', 'completed', 'failed'].includes(run.status) && run.cancelReason !== null) invalid();
}
export function validateDreamState(state) {
  keys(state, ['schemaVersion', 'revision', 'registrations', 'flights']);
  if (state.schemaVersion !== 1 || !Number.isSafeInteger(state.revision) || state.revision < 0
    || !Array.isArray(state.registrations) || state.registrations.length > DREAM_REGISTRATION_LIMIT
    || !Array.isArray(state.flights) || state.flights.length > DREAM_REGISTRATION_LIMIT) invalid();
  const agents = new Set(), generations = new Set(), flying = new Set(), runs = new Set();
  for (const row of state.registrations) {
    keys(row, ['agentId', 'soulDir', 'generation', 'intervalHours', 'paused', 'nextDueAt', 'createdAt', 'updatedAt', 'lastRun']);
    if (!isAgentId(row.agentId) || agents.has(row.agentId) || !root(row.soulDir) || !id(row.generation) || generations.has(row.generation)
      || !Number.isSafeInteger(row.intervalHours) || row.intervalHours < 1 || row.intervalHours > 720
      || typeof row.paused !== 'boolean' || !(row.paused ? row.nextDueAt === null : date(row.nextDueAt))
      || !date(row.createdAt) || !date(row.updatedAt)) invalid();
    if (row.lastRun !== null) { runRecord(row.lastRun, true); if (row.lastRun.agentId !== row.agentId || row.lastRun.soulDir !== row.soulDir) invalid(); }
    agents.add(row.agentId); generations.add(row.generation);
  }
  for (const run of state.flights) {
    runRecord(run, false);
    if (flying.has(run.agentId) || runs.has(run.runId)) invalid();
    flying.add(run.agentId); runs.add(run.runId);
  }
  return state;
}

// Shared with durable adapters so persisted events cannot acquire fields that
// the scheduling core would never emit (especially prompts or executor output).
export function validateDreamEvents(events) {
  if (!Array.isArray(events) || events.length < 1 || events.length > DREAM_REGISTRATION_LIMIT) invalid();
  for (const event of events) {
    const registrationEvent = ['registered', 'paused', 'unscheduled'].includes(event?.kind);
    keys(event, ['kind', 'at', registrationEvent ? 'registration' : 'run']);
    if (!date(event.at)) invalid();
    if (registrationEvent) {
      validateDreamState({ ...emptyDreamState(), registrations: [event.registration] });
      if (event.kind === 'registered' && event.registration.paused || event.kind === 'paused' && !event.registration.paused) invalid();
    } else {
      const statuses = { started: ['running'], 'cancellation-requested': ['cancelling'], ended: TERMINAL, 'recovery-required': ['recovery-required'] };
      if (!Object.hasOwn(statuses, event.kind) || !statuses[event.kind].includes(event.run?.status)) invalid();
      runRecord(event.run, event.kind === 'ended');
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
 */
export function createDreamScheduler({ store, execute, soulDirectory, isPaused = () => false, isBusy = () => false,
  now = () => new Date(), idFactory = randomUUID, daemonGeneration = randomUUID(), maxConcurrent = 1,
  turnTimeoutMs = DREAM_TIMEOUT_MS, setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
  if (typeof store?.read !== 'function' || typeof store?.commit !== 'function' || typeof execute !== 'function' || typeof soulDirectory !== 'function'
    || !id(daemonGeneration) || !Number.isSafeInteger(maxConcurrent) || maxConcurrent < 1 || maxConcurrent > 16
    || !Number.isSafeInteger(turnTimeoutMs) || turnTimeoutMs < 1 || turnTimeoutMs > DREAM_TIMEOUT_MS) {
    fail('dream-configuration-invalid', 'dream scheduling requires atomic storage, execution and canonical soul-directory ports with bounded concurrency and timeout');
  }
  const live = new Map();
  let fault = null;
  const read = () => {
    const observed = synchronous(store.read());
    return structuredClone(validateDreamState(observed === null ? emptyDreamState() : observed));
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
    validateDreamState(state);
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
    persist(state, [{ kind: 'registered', at, registration: row }]);
    return structuredClone(row);
  }
  function pause(agentId) {
    healthy();
    const state = read(), row = registration(state, agentId);
    if (row.paused) return structuredClone(row);
    const at = time();
    Object.assign(row, { generation: newId(state), paused: true, nextDueAt: null, updatedAt: at });
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
    if (old) return defer(live.has(old.runId) ? 'already-running' : 'recovery-required');
    if (live.size >= maxConcurrent || state.flights.length >= DREAM_REGISTRATION_LIMIT) return defer('capacity');
    if (isBusy(agentId)) return defer('busy');
    try { if (canonical(agentId) !== row.soulDir) return defer('binding-changed'); }
    catch { return defer('binding-unavailable'); }
    const at = time();
    if (trigger === 'due' && Date.parse(row.nextDueAt) > Date.parse(at)) return defer('not-due');
    const run = { runId: newId(state), agentId, soulDir: row.soulDir, generation: row.generation, daemonGeneration,
      trigger, startedAt: at, endedAt: null, status: 'running', timeoutMs: turnTimeoutMs, cancelRequestedAt: null, cancelReason: null };
    state.flights.push(run);
    persist(state, [{ kind: 'started', at, run }]); // must precede any executor call
    const entry = { controller: new AbortController(), timer: null, reason: null, done: null };
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
        const endedAt = time(), status = entry.controller.signal.aborted ? entry.reason === 'timeout' ? 'timed-out' : 'cancelled' : failed ? 'failed' : 'completed';
        const result = { ...lease, status, endedAt };
        current.flights = current.flights.filter(item => item.runId !== run.runId);
        const owner = current.registrations.find(item => item.agentId === agentId && item.generation === run.generation);
        if (owner) { owner.lastRun = result; if (!owner.paused) owner.nextDueAt = later(endedAt, owner.intervalHours); }
        persist(current, [{ kind: 'ended', at: endedAt, run: result }]);
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
      return execute({ run: structuredClone(run), signal: entry.controller.signal, timeoutMs: turnTimeoutMs });
    }).then(() => finish(false), () => finish(true));
    return { agentId, runId: run.runId, status: 'started', done: entry.done };
  }
  function recover() {
    healthy();
    const state = read(), events = [], at = time();
    for (const run of state.flights) {
      if (live.has(run.runId) || run.status === 'recovery-required') continue;
      run.status = 'recovery-required';
      events.push({ kind: 'recovery-required', at, run });
    }
    if (events.length) persist(state, events);
    return { quarantined: events.length };
  }
  return {
    register, pause, unschedule, recover,
    cancel: runId => cancel(runId),
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
