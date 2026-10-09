import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { createDreamScheduler, emptyDreamState, parseDreamSchedule, validateDreamState, DREAM_TIMEOUT_MS } from '../skill-dream-scheduler.mjs';

const A = 'agent_12345678-1234-4234-8234-123456789abc';
const B = 'agent_22345678-1234-4234-8234-123456789abc';
const HOUR = 3_600_000;
const copy = value => JSON.parse(JSON.stringify(value));
function fixture(extra = {}) {
  let state = null, at = Date.parse('2026-10-09T00:00:00.000Z'), failCommit = null;
  const events = [], calls = [], timers = new Map(), dirs = new Map([[A, path.join(tmpdir(), 'dream-a')], [B, path.join(tmpdir(), 'dream-b')]]);
  const paused = new Set(), busy = new Set();
  const store = {
    read: () => copy(state),
    commit(change) {
      if (failCommit?.(change)) throw new Error('CANARY storage failure');
      if ((state?.revision ?? 0) !== change.expectedRevision) return false;
      // This fixture models the required atomic port, round-tripped through
      // JSON to exercise persisted schema. It is not a production disk store.
      state = copy(change.state); events.push(...copy(change.events)); return true;
    },
  };
  const execute = ({ run, signal, timeoutMs }) => {
    assert.equal(state.flights.find(item => item.runId === run.runId)?.status, 'running', 'the durable lease precedes the executor');
    assert.ok(events.some(event => event.kind === 'started' && event.run.runId === run.runId));
    return new Promise((resolve, reject) => calls.push({ run, signal, timeoutMs, resolve, reject }));
  };
  const ports = { store, execute, soulDirectory: id => dirs.get(id), isPaused: id => paused.has(id), isBusy: id => busy.has(id),
    now: () => new Date(at), setTimer: (fn, delay) => { const token = {}; timers.set(token, { fn, delay }); return token; }, clearTimer: token => timers.delete(token), ...extra };
  return { scheduler: createDreamScheduler(ports), ports, store, events, calls, timers, dirs, paused, busy,
    advance: ms => { at += ms; }, state: () => copy(state), replace: value => { state = copy(value); }, fail: fn => { failCommit = fn; } };
}

test('strict elapsed schedules, initial state and unavailable production ports', () => {
  for (const hours of [1, 24, 720]) assert.equal(parseDreamSchedule(`PT${hours}H`), hours);
  for (const value of [null, '', 'PT0H', 'PT01H', 'PT721H', 'P1D', 'PT1.5H', 'PT60M', '0 * * * *', 'PT24H\n']) {
    assert.throws(() => parseDreamSchedule(value), { code: 'dream-schedule-invalid' });
  }
  assert.deepEqual(validateDreamState(emptyDreamState()), emptyDreamState());
  assert.throws(() => createDreamScheduler(), { code: 'dream-configuration-invalid' });
});

test('registration is idempotent, bounded and bound to the canonical soul directory', () => {
  const f = fixture(), first = f.scheduler.register(A, 'PT24H'), revision = f.state().revision;
  assert.equal(first.nextDueAt, '2026-10-10T00:00:00.000Z');
  f.advance(HOUR);
  assert.deepEqual(f.scheduler.register(A, 'PT24H'), first);
  assert.equal(f.state().revision, revision);
  const changed = f.scheduler.register(A, 'PT2H');
  assert.notEqual(changed.generation, first.generation);
  assert.equal(changed.nextDueAt, '2026-10-09T03:00:00.000Z');
  f.dirs.set(A, path.join(tmpdir(), 'moved-soul'));
  assert.throws(() => f.scheduler.register(A, 'PT2H'), { code: 'dream-binding-changed' });
  assert.equal(f.scheduler.runNow(A).reason, 'binding-changed');
  f.scheduler.unschedule(A);
  assert.equal(f.scheduler.register(A, 'PT2H').soulDir, f.dirs.get(A));
  assert.equal(f.calls.length, 0, 'registration never launches a turn');
  assert.throws(() => f.scheduler.register(B, 'PT900H'), { code: 'dream-schedule-invalid' });
  f.dirs.set(B, '/not/../canonical');
  assert.throws(() => f.scheduler.register(B, 'PT1H'), { code: 'dream-binding-unavailable' });
});

test('registration capacity refuses additional souls without dropping existing state', () => {
  const f = fixture({ soulDirectory: agentId => path.join(tmpdir(), agentId) });
  for (let index = 0; index < 256; index++) f.scheduler.register(`agent_00000000-0000-4000-8000-${index.toString(16).padStart(12, '0')}`, 'PT24H');
  const before = f.state();
  assert.throws(() => f.scheduler.register(A, 'PT1H'), { code: 'dream-capacity' });
  assert.deepEqual(f.state(), before);
});

test('missed intervals produce one catch-up and the next due time follows settlement', async () => {
  const f = fixture(); f.scheduler.register(A, 'PT1H');
  f.advance(-HOUR); assert.deepEqual(f.scheduler.tick(), []);
  f.advance(10 * 24 * HOUR);
  const [run] = f.scheduler.tick(); assert.equal(run.status, 'started');
  assert.equal(f.scheduler.tick()[0].reason, 'already-running');
  await Promise.resolve(); assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].timeoutMs, DREAM_TIMEOUT_MS);
  f.advance(15_000); f.calls[0].resolve('CANARY unverified agent output');
  const result = await run.done;
  assert.equal(result.status, 'completed');
  assert.equal(f.scheduler.status().registrations[0].nextDueAt, new Date(Date.parse(result.endedAt) + HOUR).toISOString());
  assert.deepEqual(f.scheduler.tick(), []);
  assert.equal(f.timers.size, 0);
  assert.equal(JSON.stringify(f.events).includes('CANARY'), false, 'execution facts are not agent evidence');
});

test('pause and foreground busy defer starts; concurrency is bounded without blocking foreground work', async () => {
  const f = fixture(); f.scheduler.register(A, 'PT1H'); f.scheduler.register(B, 'PT1H');
  f.paused.add(A); assert.equal(f.scheduler.runNow(A).reason, 'paused'); f.paused.clear();
  f.busy.add(A); assert.equal(f.scheduler.runNow(A).reason, 'busy'); f.busy.clear();
  const run = f.scheduler.runNow(A);
  assert.equal(f.scheduler.runNow(B).reason, 'capacity');
  // Foreground state can change after dispatch; this scheduler owns no gate
  // preventing an interactive session from starting.
  f.busy.add(A);
  await Promise.resolve(); f.calls[0].resolve(); await run.done;
  assert.equal(f.scheduler.runNow(A).reason, 'busy');
  assert.equal(f.scheduler.status().flights.length, 0);
});

test('different souls can run independently under a configured host concurrency bound', async () => {
  const f = fixture({ maxConcurrent: 2 });
  f.scheduler.register(A, 'PT1H'); f.scheduler.register(B, 'PT1H');
  const a = f.scheduler.runNow(A), b = f.scheduler.runNow(B);
  await Promise.resolve(); assert.equal(f.calls.length, 2);
  assert.notEqual(a.runId, b.runId);
  f.calls[0].resolve(); await a.done;
  assert.equal(f.scheduler.runNow(B).reason, 'already-running');
  f.calls[1].resolve(); await b.done;
});

test('cancellation holds the lease until the executor actually settles, even after unscheduling', async () => {
  const f = fixture(); f.scheduler.register(A, 'PT1H');
  const run = f.scheduler.runNow(A); await Promise.resolve();
  assert.deepEqual(f.scheduler.cancel(run.runId), { requested: true, settled: false });
  assert.equal(f.calls[0].signal.aborted, true);
  assert.equal(f.scheduler.status().flights[0].status, 'cancelling');
  f.scheduler.unschedule(A); f.dirs.set(A, path.join(tmpdir(), 'new-soul-location'));
  const updated = f.scheduler.register(A, 'PT2H');
  assert.equal(f.scheduler.runNow(A).reason, 'already-running');
  f.calls[0].resolve();
  const result = await run.done;
  assert.equal(result.status, 'completed');
  assert.equal(result.cancelReason, 'owner', 'the cancellation request remains visible after successful execution');
  assert.deepEqual(f.scheduler.status().registrations[0], updated, 'old completion cannot change new registration');
  assert.equal(f.events.filter(event => event.kind === 'ended').length, 1, 'history remains after unschedule');
});

test('a monotonic timeout requests abort but does not free the slot; wall-clock changes do not replace the deadline', async () => {
  const f = fixture({ turnTimeoutMs: 100 }); f.scheduler.register(A, 'PT1H');
  const run = f.scheduler.runNow(A); await Promise.resolve();
  const timer = [...f.timers.values()][0]; assert.equal(timer.delay, 100);
  f.advance(-24 * HOUR); timer.fn();
  assert.equal(f.calls[0].signal.aborted, true);
  assert.equal(f.scheduler.runNow(A).reason, 'already-running');
  f.calls[0].reject(new Error('CANARY executor error'));
  assert.equal((await run.done).status, 'timed-out');
  assert.equal(JSON.stringify(f.events).includes('CANARY'), false);
});

test('cancelling before the execution microtask never starts the executor', async () => {
  const f = fixture(); f.scheduler.register(A, 'PT1H');
  const run = f.scheduler.runNow(A); f.scheduler.cancel(run.runId);
  assert.equal((await run.done).status, 'cancelled');
  assert.equal(f.calls.length, 0);
});

test('resolved execution stays completed when owner cancellation or timeout races settlement', async () => {
  for (const reason of ['owner', 'timeout']) for (const order of ['request-first', 'resolve-first']) {
    const f = fixture(); f.scheduler.register(A, 'PT1H');
    const run = f.scheduler.runNow(A); await Promise.resolve();
    if (order === 'resolve-first') f.calls[0].resolve();
    if (reason === 'owner') f.scheduler.cancel(run.runId);
    else [...f.timers.values()][0].fn();
    assert.equal(f.scheduler.status().flights[0].status, 'cancelling');
    if (order === 'request-first') f.calls[0].resolve();
    const result = await run.done;
    assert.equal(result.status, 'completed', `${reason}/${order}`);
    assert.equal(result.cancelReason, reason);
    assert.equal(result.cancelRequestedAt, '2026-10-09T00:00:00.000Z');
    assert.deepEqual(f.scheduler.status().registrations[0].lastRun, result);
    assert.deepEqual(f.events.at(-1).run, result);
    assert.equal(f.scheduler.status().flights.length, 0);
  }
  const f = fixture(); f.scheduler.register(A, 'PT1H');
  const run = f.scheduler.runNow(A); await Promise.resolve();
  f.scheduler.cancel(run.runId); f.calls[0].reject(new Error('abort'));
  assert.equal((await run.done).status, 'cancelled', 'rejection following an abort still records cancellation');
});

test('a canonical directory cannot be owned by different souls across registrations or unsettled flights', async () => {
  const f = fixture(); f.scheduler.register(A, 'PT1H');
  const original = f.dirs.get(A); f.dirs.set(B, original);
  assert.throws(() => f.scheduler.register(B, 'PT1H'), { code: 'dream-state-invalid' });
  assert.equal(f.state().registrations.length, 1);
  const run = f.scheduler.runNow(A); await Promise.resolve();
  const duplicate = f.state();
  duplicate.flights.push({ ...duplicate.flights[0], agentId: B, runId: '22345678-1234-4234-8234-123456789abc' });
  assert.throws(() => validateDreamState(duplicate), { code: 'dream-state-invalid' });
  f.scheduler.unschedule(A);
  assert.throws(() => f.scheduler.register(B, 'PT1H'), { code: 'dream-state-invalid' });
  f.dirs.set(A, path.join(tmpdir(), 'moved-dream-a'));
  f.scheduler.register(A, 'PT1H'); // same soul may retain its old-directory lease
  assert.throws(() => f.scheduler.register(B, 'PT1H'), { code: 'dream-state-invalid' });
  f.calls[0].resolve(); await run.done;
  assert.equal(f.scheduler.register(B, 'PT1H').soulDir, original, 'a settled flight no longer reserves the old directory');
});

test('a failed attempt waits one interval, and a changed or paused registration rejects stale completion', async () => {
  const f = fixture(); f.scheduler.register(A, 'PT1H');
  const failed = f.scheduler.runNow(A); await Promise.resolve(); f.calls[0].reject(new Error('failure'));
  assert.equal((await failed.done).status, 'failed'); assert.deepEqual(f.scheduler.tick(), []);
  const old = f.scheduler.runNow(A); await Promise.resolve();
  f.scheduler.pause(A); f.advance(HOUR);
  const resumed = f.scheduler.register(A, 'PT2H');
  f.calls[1].resolve(); await old.done;
  assert.deepEqual(f.scheduler.status().registrations[0], resumed);
  const again = f.scheduler.runNow(A); await Promise.resolve();
  const paused = f.scheduler.pause(A);
  assert.equal(f.scheduler.runNow(A).reason, 'paused');
  f.calls[2].resolve(); await again.done;
  assert.deepEqual(f.scheduler.status().registrations[0], paused);
});

test('restart quarantines a flight; schedule changes, unschedule and path moves cannot clear it', async () => {
  const f = fixture(); f.scheduler.register(A, 'PT1H');
  const run = f.scheduler.runNow(A); await Promise.resolve();
  const restarted = createDreamScheduler(f.ports);
  assert.equal(restarted.runNow(A).reason, 'recovery-required', 'must refuse even before recovery was journalled');
  assert.deepEqual(restarted.recover(), { quarantined: 1 });
  const revision = f.state().revision;
  assert.deepEqual(restarted.recover(), { quarantined: 0 }); assert.equal(f.state().revision, revision);
  assert.equal(restarted.status().flights[0].status, 'recovery-required');
  restarted.pause(A); restarted.unschedule(A); f.dirs.set(A, path.join(tmpdir(), 'copied-soul'));
  restarted.register(A, 'PT24H');
  assert.equal(restarted.runNow(A).reason, 'recovery-required');
  assert.equal(restarted.cancel(run.runId).requested, false, 'a new daemon cannot signal an unowned child');
  // Let the original fixture settle only to release its test promise/timer.
  f.calls[0].resolve(); await run.done;
});

test('missing state cannot be reconstructed from imported run history', () => {
  const f = fixture();
  assert.deepEqual(f.scheduler.tick(), []);
  assert.throws(() => f.scheduler.runNow(A), { code: 'dream-unregistered' });
  assert.equal(f.events.length, 0);
});

test('CAS conflicts and failed start commits prevent execution and freeze further dispatch', async () => {
  for (const mode of ['throw', 'conflict']) {
    const f = fixture(); f.scheduler.register(A, 'PT1H');
    if (mode === 'throw') f.fail(change => change.events.some(event => event.kind === 'started'));
    else f.store.commit = () => false;
    assert.throws(() => f.scheduler.runNow(A), { code: mode === 'throw' ? 'dream-store-failed' : 'dream-store-conflict' });
    await Promise.resolve(); assert.equal(f.calls.length, 0);
    assert.throws(() => f.scheduler.tick(), error => /^dream-store-/.test(error.code));
  }
});

test('async storage ports are refused without executing or leaving an unhandled rejection', async () => {
  const f = fixture(); f.scheduler.register(A, 'PT1H');
  f.store.commit = async () => { throw new Error('CANARY async write'); };
  assert.throws(() => f.scheduler.runNow(A), { code: 'dream-store-failed' });
  await Promise.resolve(); assert.equal(f.calls.length, 0);
  const g = fixture(); g.store.read = async () => { throw new Error('CANARY async read'); };
  assert.throws(() => g.scheduler.tick(), { code: 'dream-configuration-invalid' });
  await Promise.resolve(); assert.equal(g.calls.length, 0);
});

test('undefined storage reads cannot masquerade as an absent state', () => {
  const f = fixture(); f.store.read = () => undefined;
  assert.throws(() => f.scheduler.register(A, 'PT1H'), { code: 'dream-state-invalid' });
  assert.equal(f.events.length, 0);
});

test('an acknowledged state that does not read back prevents execution', async () => {
  const f = fixture(); f.scheduler.register(A, 'PT1H');
  f.store.commit = () => true; // broken adapter: acknowledges but writes nothing
  assert.throws(() => f.scheduler.runNow(A), { code: 'dream-store-conflict' });
  await Promise.resolve(); assert.equal(f.calls.length, 0);
  assert.throws(() => f.scheduler.tick(), { code: 'dream-store-conflict' });
});

test('lost completion persistence cannot release a lease or silently rerun executed work', async () => {
  const f = fixture(); f.scheduler.register(A, 'PT1H');
  const run = f.scheduler.runNow(A); await Promise.resolve();
  f.fail(change => change.events.some(event => event.kind === 'ended'));
  f.calls[0].resolve(); assert.equal((await run.done).status, 'persistence-failed');
  assert.equal(f.scheduler.status().flights.length, 1);
  assert.throws(() => f.scheduler.runNow(A), { code: 'dream-store-failed' });
  f.fail(null);
  const restarted = createDreamScheduler(f.ports); restarted.recover();
  assert.equal(restarted.runNow(A).reason, 'recovery-required');
});

test('an ambiguous committed start never executes and remains quarantined after restart', async () => {
  const f = fixture(); f.scheduler.register(A, 'PT1H');
  const commit = f.store.commit;
  f.store.commit = change => {
    const result = commit(change);
    if (change.events.some(event => event.kind === 'started')) throw new Error('acknowledgment lost after commit');
    return result;
  };
  assert.throws(() => f.scheduler.runNow(A), { code: 'dream-store-failed' });
  await Promise.resolve(); assert.equal(f.calls.length, 0);
  assert.equal(f.state().flights.length, 1);
  const restarted = createDreamScheduler(f.ports);
  restarted.recover(); assert.equal(restarted.runNow(A).reason, 'recovery-required');
});

test('timer setup failure refuses execution while retaining the committed attempt for recovery', async () => {
  const f = fixture({ setTimer() { throw new Error('timer unavailable'); } });
  f.scheduler.register(A, 'PT1H');
  assert.throws(() => f.scheduler.runNow(A), { code: 'dream-timer-failed' });
  await Promise.resolve(); assert.equal(f.calls.length, 0);
  assert.equal(f.state().flights.length, 1);
  assert.throws(() => f.scheduler.runNow(A), { code: 'dream-timer-failed' });
});

test('invalid persisted schemas, duplicate souls and excess fields fail closed before execution', () => {
  const f = fixture(); f.scheduler.register(A, 'PT1H'); const good = f.state();
  for (const mutate of [
    value => { value.schemaVersion = 2; }, value => { value.extra = 'CANARY'; },
    value => { value.registrations.push(copy(value.registrations[0])); },
    value => { value.registrations[0].nextDueAt = 'not-a-date'; },
    value => { value.registrations[0].soulDir += '/../escape'; },
    value => { value.registrations[0].paused = true; },
    value => { value.revision = -1; },
  ]) {
    const broken = copy(good); mutate(broken); f.replace(broken);
    assert.throws(() => f.scheduler.runNow(A), { code: 'dream-state-invalid' });
  }
  assert.equal(f.calls.length, 0);
});
