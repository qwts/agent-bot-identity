import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { createDreamScheduler, emptyDreamState, parseDreamSchedule, validateDreamEvents, validateDreamState, DREAM_TIMEOUT_MS } from '../skill-dream-scheduler.mjs';
import { interpretDreamReport } from '../skill-dream-outcomes.mjs';

const A = 'agent_12345678-1234-4234-8234-123456789abc';
const B = 'agent_22345678-1234-4234-8234-123456789abc';
const HOUR = 3_600_000;
const copy = value => JSON.parse(JSON.stringify(value));
const metadata = () => ({ schemaVersion: 1, revision: `sha256:${'a'.repeat(64)}`,
  sources: [{ path: 'AGENTS.md', kind: 'context', digest: `sha256:${'b'.repeat(64)}`, size: 12, excerptBytes: 12, truncated: false }],
  coverage: { definition: 'supported', memory: 'unsupported', conversations: 'unsupported', eligible: 1, selected: 1, suppliedBytes: 12, skippedBinary: 0, remaining: 0 }, nextCursor: null });
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
  const execute = ({ run, selectionCheckpoint, signal, timeoutMs, prepareInputs, recordProcess, stageOutcome }) => {
    assert.equal(state.flights.find(item => item.runId === run.runId)?.status, 'running', 'the durable lease precedes the executor');
    assert.ok(events.some(event => event.kind === 'started' && event.run.runId === run.runId));
    return new Promise((resolve, reject) => calls.push({ run, selectionCursor: selectionCheckpoint?.nextCursor ?? null, selectionCheckpoint, signal, timeoutMs, prepareInputs, recordProcess, stageOutcome, resolve, reject }));
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

test('input receipts persist once, survive recovery and retain history after current references expire', async () => {
  const f = fixture(); f.scheduler.register(A, 'PT1H');
  const run = f.scheduler.runNow(A); await Promise.resolve();
  const captured = metadata(), receipt = f.calls[0].prepareInputs(captured);
  captured.sources[0].digest = `sha256:${'c'.repeat(64)}`;
  assert.equal(receipt.journalRevision, 3);
  assert.deepEqual(f.state().inputReceipts, [receipt]);
  assert.equal(f.events.at(-1).inputs.sources[0].digest, metadata().sources[0].digest);
  assert.throws(() => f.calls[0].prepareInputs(metadata()), { code: 'dream-input-preparation-refused' });
  const restored = createDreamScheduler(f.ports);
  restored.recover();
  assert.deepEqual(restored.status().inputReceipts, [receipt]);
  assert.equal(restored.runNow(A).reason, 'recovery-required');
  // The original executor settles; its recorded input reference remains with
  // lastRun, even when the run failed. Preparation is not delivery evidence.
  f.calls[0].reject(new Error('provider unavailable'));
  assert.equal((await run.done).status, 'failed');
  assert.deepEqual(f.state().inputReceipts, [receipt]);
  assert.throws(() => f.calls[0].prepareInputs(metadata()), { code: 'dream-input-preparation-refused' });
  f.scheduler.unschedule(A);
  assert.deepEqual(f.state().inputReceipts, []);
  assert.equal(f.events.filter(event => event.kind === 'inputs-prepared').length, 1);
});

test('an unconfirmed input commit freezes dispatch and retains the unfinished lease', async () => {
  let entered = false;
  const f = fixture({ execute: ({ prepareInputs }) => { prepareInputs(metadata()); entered = true; } });
  f.scheduler.register(A, 'PT1H');
  f.fail(change => change.events.some(event => event.kind === 'inputs-prepared'));
  const result = await f.scheduler.runNow(A).done;
  assert.equal(entered, false); assert.equal(result.status, 'persistence-failed');
  assert.equal(f.state().flights.length, 1);
  assert.deepEqual(f.state().inputReceipts, []);
  assert.throws(() => f.scheduler.runNow(A), { code: 'dream-store-failed' });
});

test('outcomes are run-bound, publish only at settlement and survive unscheduling in history', async () => {
  const f = fixture(); f.scheduler.register(A, 'PT1H');
  const started = f.scheduler.runNow(A); await Promise.resolve();
  const call = f.calls[0], outcome = interpretDreamReport({ run: call.run, inputs: metadata(), reply: 'Unstructured report' });
  assert.throws(() => call.stageOutcome(outcome), { code: 'dream-outcome-refused' });
  call.prepareInputs(metadata());
  assert.throws(() => call.stageOutcome({ ...outcome, runId: '00000000-0000-4000-8000-000000000000' }), { code: 'dream-outcome-invalid' });
  call.stageOutcome(outcome);
  assert.throws(() => call.stageOutcome(outcome), { code: 'dream-outcome-refused' });
  assert.deepEqual(f.state().outcomeReceipts, []);
  assert.equal(f.events.some(event => event.kind === 'outcome-recorded'), false);
  f.scheduler.unschedule(A); call.resolve(); await started.done;
  assert.deepEqual(f.state().outcomeReceipts, []);
  assert.equal(f.events.at(-1).kind, 'outcome-recorded');
  assert.equal(f.events.at(-1).outcome.runId, started.runId);
  assert.throws(() => call.stageOutcome(outcome), { code: 'dream-outcome-refused' });
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
  assert.deepEqual(restarted.recover(), { quarantined: 1, settled: 0, terminating: 0 });
  const revision = f.state().revision;
  assert.deepEqual(restarted.recover(), { quarantined: 0, settled: 0, terminating: 0 }); assert.equal(f.state().revision, revision);
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
    value => { value.schemaVersion = 999; }, value => { value.extra = 'CANARY'; },
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

test('selection checkpoints rotate only validated settled attempts, retain retries and survive restart', async () => {
  const f = fixture(); f.scheduler.register(A, 'PT1H');
  const page = { ...metadata(), nextCursor: { revision: metadata().revision, path: 'AGENTS.md' },
    coverage: { ...metadata().coverage, eligible: 2, remaining: 1 } };
  const complete = async ({ report = 'structured', reject = false, cancel = false, mutate = null, inputs = page } = {}) => {
    const started = f.scheduler.runNow(A);
    assert.equal(f.scheduler.runNow(A).reason, 'already-running');
    assert.ok(f.scheduler.tick().every(result => result.status !== 'started'), 'manual and due dispatch cannot race checkpoint ownership');
    await Promise.resolve();
    const call = f.calls.at(-1); call.prepareInputs(inputs);
    // Empty items deliberately leaves every selected source unreported. Rotation
    // must not promote any item to processed or remove it from later cycles.
    const reply = report === 'structured'
      ? JSON.stringify({ schemaVersion: 1, runId: call.run.runId, startingRevision: inputs.revision, items: [] }) : 'not structured';
    call.stageOutcome(interpretDreamReport({ run: call.run, inputs, reply }));
    if (cancel) f.scheduler.cancel(started.runId);
    if (mutate) mutate();
    if (reject) call.reject(new Error('failure')); else call.resolve();
    await started.done;
    return call;
  };
  assert.equal((await complete()).selectionCursor, null);
  const checkpoint = f.state().selectionCheckpoints[0];
  assert.equal(checkpoint.coverage, 'selection-only'); assert.equal(checkpoint.processingCoverage, 'unverified');
  assert.deepEqual(checkpoint.nextCursor, page.nextCursor);
  for (const options of [{ report: 'unstructured' }, { reject: true }, { cancel: true }, { cancel: true, reject: true }]) {
    assert.deepEqual((await complete(options)).selectionCursor, page.nextCursor);
    assert.deepEqual(f.state().selectionCheckpoints, [checkpoint], 'uncertain/failed/cancelled attempts do not advance selection');
  }
  const restored = createDreamScheduler(f.ports);
  assert.deepEqual(restored.status().selectionCheckpoints, [checkpoint]);
  f.scheduler.pause(A);
  assert.equal(f.state().selectionCheckpoints[0].generation, f.state().registrations[0].generation);
  f.scheduler.register(A, 'PT2H');
  assert.deepEqual((await complete({ inputs: metadata() })).selectionCursor, page.nextCursor);
  assert.equal(f.state().selectionCheckpoints[0].nextCursor, null, 'end of inventory wraps; unreported items stay eligible');
  assert.equal((await complete()).selectionCursor, null);
  const before = f.state().selectionCheckpoints[0];
  await complete({ mutate: () => f.scheduler.pause(A) });
  assert.equal(f.state().selectionCheckpoints[0].runId, before.runId, 'old-generation completion cannot advance selection');
  f.scheduler.unschedule(A);
  assert.deepEqual(f.state().selectionCheckpoints, []);
  assert.ok(f.events.some(event => event.kind === 'selection-advanced'), 'unscheduling preserves history');
});

test('selection checkpoint validation refuses foreign generations, duplicates and processing claims', async () => {
  const f = fixture(); f.scheduler.register(A, 'PT1H');
  const run = f.scheduler.runNow(A); await Promise.resolve();
  const call = f.calls[0], inputs = metadata(); call.prepareInputs(inputs);
  call.stageOutcome(interpretDreamReport({ run: call.run, inputs,
    reply: JSON.stringify({ schemaVersion: 1, runId: call.run.runId, startingRevision: inputs.revision, items: [] }) }));
  call.resolve(); await run.done;
  for (const mutate of [
    state => { state.selectionCheckpoints[0].generation = '00000000-0000-4000-8000-000000000000'; },
    state => { state.selectionCheckpoints[0].processingCoverage = 'verified'; },
    state => { state.selectionCheckpoints.push(structuredClone(state.selectionCheckpoints[0])); },
    state => { state.selectionCheckpoints[0].nextCursor = { revision: inputs.revision, path: '../secret' }; },
  ]) {
    const state = f.state(); mutate(state); assert.throws(() => validateDreamState(state));
  }
});

test('notices publish with terminal run facts, deduplicate across runs and are acknowledged by the owner', async () => {
  const f = fixture(); f.scheduler.register(A, 'PT1H');
  const settle = async ({ reply = null, reject = false } = {}) => {
    const started = f.scheduler.runNow(A); await Promise.resolve();
    const call = f.calls.at(-1), inputs = metadata(); call.prepareInputs(inputs);
    if (reply !== null) call.stageOutcome(interpretDreamReport({ run: call.run, inputs, reply: reply(call.run), executionFailed: reject }));
    const before = f.events.length;
    if (reject) call.reject(new Error('failure')); else call.resolve();
    await started.done;
    return f.events.slice(before);
  };
  const report = items => run => JSON.stringify({ schemaVersion: 1, runId: run.runId, startingRevision: metadata().revision, items });
  const blocked = { path: 'AGENTS.md', digest: metadata().sources[0].digest, outcome: 'blocked', reason: 'missing-tool', evidence: null };
  // A quiet run writes no notice state and no notice event.
  assert.ok(!(await settle({ reply: report([]) })).some(event => event.kind === 'notices-updated'));
  assert.deepEqual(f.state().noticeLedgers, []);
  let tail = await settle({ reject: true, reply: () => '' });
  const update = tail.find(event => event.kind === 'notices-updated');
  assert.equal(update.created.length, 1); assert.equal(update.created[0].kind, 'execution');
  assert.ok(tail.some(event => event.kind === 'ended' && event.run.runId === update.run.runId), 'notices publish in the terminal transaction');
  const execution = update.created[0].id;
  tail = await settle({ reject: true, reply: () => '' });
  assert.deepEqual(tail.find(event => event.kind === 'notices-updated').renewed, [execution], 'a repeated failure renews, never renotifies');
  // Owner acknowledgement persists once; repeating it writes nothing.
  const revision = f.state().revision;
  const acked = f.scheduler.acknowledgeNotice(A, execution);
  assert.equal(acked.notice.state, 'acknowledged');
  assert.deepEqual(f.events.at(-1), { kind: 'notice-acknowledged', at: acked.notice.acknowledgedAt, agentId: A, noticeId: execution });
  assert.equal(f.state().revision, revision + 1);
  assert.deepEqual(f.scheduler.acknowledgeNotice(A, execution), acked); assert.equal(f.state().revision, revision + 1);
  assert.throws(() => f.scheduler.acknowledgeNotice(B, execution), { code: 'dream-notice-not-found' });
  // Recovery clears the live notice into the append-only journal and out of state.
  tail = await settle({ reply: report([blocked]) });
  const recovered = tail.find(event => event.kind === 'notices-updated');
  assert.deepEqual(recovered.cleared.map(notice => [notice.id, notice.acknowledgedAt !== null, typeof notice.clearedAt]), [[execution, true, 'string']]);
  assert.deepEqual(f.state().noticeLedgers[0].notices.map(notice => notice.kind), ['item-blocked']);
  assert.throws(() => f.scheduler.acknowledgeNotice(A, execution), { code: 'dream-notice-not-found' });
  const state = f.state();
  // Unscheduling removes current notices; their history stays in events.
  f.scheduler.unschedule(A);
  assert.deepEqual(f.state().noticeLedgers, []);
  assert.ok(f.events.some(event => event.kind === 'notices-updated' && event.created.some(notice => notice.kind === 'item-blocked')));
  for (const mutate of [
    value => { value.noticeLedgers[0].agentId = B; },
    value => { value.noticeLedgers[0].notices = []; },
    value => { value.noticeLedgers.push(copy(value.noticeLedgers[0])); },
    value => { value.noticeLedgers[0].notices[0].delivery = 'delivered'; },
    value => { value.schemaVersion = 4; },
  ]) {
    const broken = copy(state); mutate(broken);
    assert.throws(() => validateDreamState(broken), { code: 'dream-state-invalid' });
  }
});

test('a failed attempt with a staged structured report still publishes its terminal facts and notices', async () => {
  const f = fixture(); f.scheduler.register(A, 'PT1H');
  const started = f.scheduler.runNow(A); await Promise.resolve();
  const call = f.calls[0], inputs = metadata(); call.prepareInputs(inputs);
  call.stageOutcome(interpretDreamReport({ run: call.run, inputs,
    reply: JSON.stringify({ schemaVersion: 1, runId: call.run.runId, startingRevision: inputs.revision, items: [] }) }));
  call.reject(new Error('failure'));
  assert.equal((await started.done).status, 'failed');
  assert.equal(f.scheduler.status().fault, null);
  assert.deepEqual(f.state().noticeLedgers[0].notices.map(notice => notice.detail), ['execution-failed']);
});

test('a run that clears every live notice drops the ledger and still journals the cleared records', async () => {
  const f = fixture(); f.scheduler.register(A, 'PT1H');
  const settle = async reject => {
    const started = f.scheduler.runNow(A); await Promise.resolve();
    const call = f.calls.at(-1), inputs = metadata(); call.prepareInputs(inputs);
    call.stageOutcome(interpretDreamReport({ run: call.run, inputs, executionFailed: reject,
      reply: reject ? '' : JSON.stringify({ schemaVersion: 1, runId: call.run.runId, startingRevision: inputs.revision, items: [] }) }));
    const before = f.events.length;
    if (reject) call.reject(new Error('failure')); else call.resolve();
    await started.done;
    return f.events.slice(before);
  };
  const [notice] = (await settle(true)).find(event => event.kind === 'notices-updated').created;
  const events = await settle(false);
  assert.deepEqual(events.map(event => event.kind), ['ended', 'outcome-recorded', 'selection-advanced', 'notices-updated']);
  const update = events.at(-1);
  assert.deepEqual([update.created, update.renewed, update.suppressed, update.cleared.map(row => row.id)], [[], [], 0, [notice.id]]);
  assert.deepEqual(f.state().noticeLedgers, [], 'an empty ledger is not retained');
  assert.equal(createDreamScheduler(f.ports).status().fault, null, 'the persisted transaction reopens cleanly');
  // A forged renewal of a notice absent from state is refused.
  const forged = copy(update); forged.renewed = [notice.id]; forged.cleared = [];
  assert.throws(() => validateDreamEvents([events[0], forged], { state: f.state() }), { code: 'dream-state-invalid' });
});

test('a restart quarantine publishes one owner-visible recovery notice that survives unscheduling', async () => {
  const f = fixture(); f.scheduler.register(A, 'PT1H');
  const run = f.scheduler.runNow(A); await Promise.resolve();
  const restarted = createDreamScheduler(f.ports), before = f.events.length;
  assert.deepEqual(restarted.recover(), { quarantined: 1, settled: 0, terminating: 0 });
  const tail = f.events.slice(before);
  assert.deepEqual(tail.map(event => event.kind), ['recovery-required', 'notices-updated'], 'the notice publishes in the quarantine transaction');
  const [notice] = tail[1].created;
  assert.deepEqual({ kind: notice.kind, subject: notice.subject, detail: notice.detail, claim: notice.claim, delivery: notice.delivery,
    firstRunId: notice.firstRunId }, { kind: 'recovery', subject: {}, detail: 'recovery-required', claim: 'host-observed',
    delivery: 'pending-host-read', firstRunId: run.runId });
  assert.equal(f.state().noticeLedgers[0].lastRunId, null, 'a quarantine is not a terminal run');
  // Recovery is idempotent: a second pass writes nothing.
  const revision = f.state().revision;
  assert.deepEqual(restarted.recover(), { quarantined: 0, settled: 0, terminating: 0 }); assert.equal(f.state().revision, revision);
  // Unscheduling cannot clear the quarantine, so it cannot hide its notice either.
  restarted.unschedule(A);
  assert.deepEqual(f.state().noticeLedgers.map(ledger => ledger.notices.map(row => row.id)), [[notice.id]]);
  const acked = restarted.acknowledgeNotice(A, notice.id);
  assert.equal(acked.notice.state, 'acknowledged');
  restarted.register(A, 'PT24H');
  assert.equal(restarted.runNow(A).reason, 'recovery-required');
  assert.equal(f.state().noticeLedgers[0].notices[0].state, 'acknowledged', 're-registering neither clears nor renotifies');
  // A recovery notice must name its own quarantine, never a terminal run's.
  const state = f.state(), update = copy(tail[1]), quarantine = copy(tail[0]);
  assert.deepEqual(validateDreamEvents([quarantine, update]), [quarantine, update]);
  for (const events of [
    [update],
    [quarantine, { ...update, created: [], renewed: [] }],
    [quarantine, { ...update, cleared: [{ ...notice, clearedAt: update.at }] }],
    [quarantine, { ...update, suppressed: 1 }],
  ]) assert.throws(() => validateDreamEvents(events), { code: 'dream-state-invalid' });
  const old = { ...copy(state), schemaVersion: 5 };
  assert.throws(() => validateDreamState(old), { code: 'dream-state-invalid' }, 'version 5 readers never see the recovery kind');
  f.calls[0].resolve(); await run.done;
});

// Restart recovery with process-ownership evidence (#603). The fake port
// scripts each inspect answer; process-ownership.test.mjs maps real probes.
const STARTED = 'Fri Oct 9 18:56:30 2026';
function ownershipPort({ inspect = [], record = pid => ({ pgid: pid, leaderStartedAt: STARTED }), terminate = async () => true } = {}) {
  const calls = [];
  return { calls, port: {
    record: pid => { calls.push('record'); return record(pid); },
    inspect: ownership => {
      calls.push('inspect');
      assert.deepEqual(Object.keys(ownership).sort(), ['leaderStartedAt', 'pgid']);
      const next = inspect.shift();
      if (next instanceof Error) throw next;
      return next;
    },
    terminate: async ownership => { calls.push('terminate'); return terminate(ownership); },
  } };
}
async function orphaned(script, { record = true } = {}) {
  const owner = ownershipPort(script), f = fixture({ processOwnership: owner.port });
  f.scheduler.register(A, 'PT1H');
  const run = f.scheduler.runNow(A); await Promise.resolve();
  const ownership = record ? f.calls[0].recordProcess({ pid: 4242 }) : null;
  owner.calls.length = 0;
  const restarted = createDreamScheduler(f.ports), before = f.events.length;
  // Only the fixture's original promise is left; release it after the restart.
  const release = async () => { f.calls[0].resolve(); await run.done; };
  return { f, run, ownership, owner, restarted, before, release };
}

test('ownership is recorded once per live run, before the first prompt, as a v7 run field', async () => {
  const { f, ownership, owner, release } = await orphaned({});
  assert.deepEqual(ownership, { pgid: 4242, leaderStartedAt: STARTED });
  const event = f.events.at(-1);
  assert.deepEqual([event.kind, event.run.status, event.run.ownership], ['ownership-recorded', 'running', ownership]);
  assert.deepEqual(f.state().flights[0].ownership, ownership);
  assert.throws(() => f.calls[0].recordProcess({ pid: 4242 }), { code: 'dream-ownership-refused' });
  assert.deepEqual(owner.calls, [], 'a refused second record never reaches the port');
  assert.deepEqual(validateDreamEvents([event], { state: f.state() }), [event]);
  for (const forged of [{ ...event, run: { ...event.run, ownership: null } }, { ...event, run: { ...event.run, ownership: { pgid: 1, leaderStartedAt: STARTED } } }]) {
    assert.throws(() => validateDreamEvents([forged]), { code: 'dream-state-invalid' });
  }
  const v6 = { ...f.state(), schemaVersion: 6 };
  assert.throws(() => validateDreamState(v6), { code: 'dream-state-invalid' }, 'version 6 runs carry no ownership field');
  await release();
});

test('a verified-absent group settles as interrupted, never successful, and allows dispatch', async () => {
  const { f, restarted, owner, before, release } = await orphaned({ inspect: ['absent'] });
  assert.deepEqual(restarted.recover(), { quarantined: 0, settled: 1, terminating: 0 });
  assert.deepEqual(owner.calls, ['inspect'], 'an absent group is never signalled');
  const state = f.state(), lastRun = state.registrations[0].lastRun;
  assert.deepEqual(state.flights, []);
  assert.deepEqual([lastRun.status, lastRun.ownership.pgid], ['interrupted', 4242]);
  assert.equal(state.registrations[0].nextDueAt, new Date(Date.parse(lastRun.endedAt) + HOUR).toISOString());
  assert.deepEqual(f.events.slice(before).map(event => event.kind), ['ended']);
  assert.deepEqual(state.noticeLedgers, []);
  assert.throws(() => validateDreamState({ ...state, schemaVersion: 6 }), { code: 'dream-state-invalid' }, 'version 6 has no interrupted status');
  assert.equal(restarted.runNow(A).status, 'started');
  await release();
});

test('an owned live group walks the termination ladder and settles only on verified absence', async () => {
  let finish;
  const { f, restarted, owner, release } = await orphaned({ inspect: ['owned', 'absent'], terminate: () => new Promise(resolve => { finish = resolve; }) });
  assert.deepEqual(restarted.recover(), { quarantined: 0, settled: 0, terminating: 1 });
  assert.equal(restarted.runNow(A).reason, 'recovering', 'no dispatch while the earlier group may still run');
  await new Promise(setImmediate);
  assert.deepEqual(owner.calls, ['inspect', 'terminate']);
  assert.equal(f.state().flights[0].status, 'running', 'the lease is held during termination');
  finish(true); await restarted.recovering();
  assert.deepEqual(owner.calls, ['inspect', 'terminate', 'inspect'], 'absence is re-verified after the ladder');
  assert.deepEqual([f.state().flights, f.state().registrations[0].lastRun.status], [[], 'interrupted']);
  await release();
});

test('a group still live after the ladder stays recovery-required with its notice', async () => {
  const { f, restarted, before, release } = await orphaned({ inspect: ['owned', 'owned'], terminate: async () => false });
  restarted.recover(); await restarted.recovering();
  assert.equal(f.state().flights[0].status, 'recovery-required');
  assert.deepEqual(f.events.slice(before).map(event => event.kind), ['recovery-required', 'notices-updated']);
  assert.equal(restarted.runNow(A).reason, 'recovery-required');
  await release();
});

for (const [name, script, options] of [
  ['a reused PID (start-time mismatch)', { inspect: ['ambiguous'] }, {}],
  ['a permission error', { inspect: [Object.assign(new Error('EPERM'), { code: 'EPERM' })] }, {}],
  ['an unknown port answer', { inspect: ['maybe'] }, {}],
  ['an unsupported platform', { inspect: ['unsupported'] }, {}],
  ['missing ownership metadata', {}, { record: false }],
  ['an unsupported platform at record time', { record: () => null }, {}],
]) test(`${name} quarantines exactly as before and sends no signal`, async () => {
  const { f, restarted, owner, ownership, before, release } = await orphaned(script, options);
  if (script.record) assert.equal(ownership, null);
  assert.deepEqual(restarted.recover(), { quarantined: 1, settled: 0, terminating: 0 });
  assert.equal(owner.calls.includes('terminate'), false);
  assert.deepEqual(f.events.slice(before).map(event => event.kind), ['recovery-required', 'notices-updated']);
  assert.equal(restarted.runNow(A).reason, 'recovery-required');
  await release();
});

test('a crash between spawning and recording the child leaves the run recovery-required', async () => {
  const owner = ownershipPort({ inspect: ['absent'] }), f = fixture({ processOwnership: owner.port });
  f.scheduler.register(A, 'PT1H');
  const run = f.scheduler.runNow(A); await Promise.resolve();
  f.fail(change => change.events.some(event => event.kind === 'ownership-recorded'));
  assert.throws(() => f.calls[0].recordProcess({ pid: 4242 }), { code: 'dream-store-failed' });
  assert.equal(f.state().flights[0].ownership, null);
  f.fail(null);
  const restarted = createDreamScheduler(f.ports);
  assert.deepEqual(restarted.recover(), { quarantined: 1, settled: 0, terminating: 0 });
  assert.deepEqual(owner.calls, ['record'], 'without durable ownership the group is never inspected');
  f.calls[0].resolve(); await run.done;
});

test('ownership recorded by this same daemon generation is never treated as an earlier orphan', async () => {
  const { f, owner, release } = await orphaned({ inspect: ['absent'] });
  const same = createDreamScheduler({ ...f.ports, daemonGeneration: f.state().flights[0].daemonGeneration });
  assert.deepEqual(same.recover(), { quarantined: 1, settled: 0, terminating: 0 });
  assert.deepEqual(owner.calls, []);
  await release();
});

test('v6 state upgrades its runs with null ownership, and stateless v6 events still validate', async () => {
  const f = fixture(); f.scheduler.register(A, 'PT1H');
  const run = f.scheduler.runNow(A); await Promise.resolve();
  const legacy = f.state();
  delete legacy.flights[0].ownership; legacy.schemaVersion = 6;
  assert.deepEqual(validateDreamState(legacy), legacy);
  f.replace(legacy);
  const upgraded = createDreamScheduler(f.ports).status();
  assert.deepEqual([upgraded.schemaVersion, upgraded.flights[0].ownership], [7, null]);
  const started = copy(f.events.find(event => event.kind === 'started'));
  delete started.run.ownership;
  assert.deepEqual(validateDreamEvents([started]), [started]);
  assert.throws(() => validateDreamEvents([{ ...started, kind: 'ended', run: { ...started.run, status: 'interrupted', endedAt: started.at } }]),
    { code: 'dream-state-invalid' }, 'a v6-shaped run cannot settle as interrupted');
  f.calls[0].resolve(); await run.done;
});
