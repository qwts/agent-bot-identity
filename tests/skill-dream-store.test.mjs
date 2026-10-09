import test from 'node:test';
import assert from 'node:assert/strict';
import fs, { chmodSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { spawn, spawnSync } from 'node:child_process';
import { createDreamFileStore, DREAM_STORE_LIMITS } from '../skill-dream-store.mjs';
import { createDreamScheduler, validateDreamEvents } from '../skill-dream-scheduler.mjs';
import { interpretDreamReport } from '../skill-dream-outcomes.mjs';
import { dreamStoreConformance } from './helpers/dream-store-conformance.mjs';

const A = 'agent_12345678-1234-4234-8234-123456789abc';
const posix = { skip: process.platform === 'win32' };
const moduleURL = new URL('../skill-dream-store.mjs', import.meta.url).href;
const name = revision => `${String(revision).padStart(16, '0')}.json`;
const emptyInputs = () => ({ schemaVersion: 1, revision: `sha256:${'a'.repeat(64)}`, sources: [],
  coverage: { definition: 'supported', memory: 'unsupported', conversations: 'unsupported', eligible: 0, selected: 0, suppliedBytes: 0, skippedBinary: 0, remaining: 0 }, nextCursor: null });
function changes(directory) {
  let state = null;
  const result = [];
  const scheduler = createDreamScheduler({
    store: { read: () => state, commit(change) { state = structuredClone(change.state); result.push(structuredClone(change)); return true; } },
    execute: () => {}, soulDirectory: () => directory,
    now: () => new Date('2026-10-09T00:00:00.000Z'),
  });
  scheduler.register(A, 'PT24H'); scheduler.pause(A);
  return { first: result[0], second: result[1] };
}
function fixture(t, options = {}) {
  const directory = realpathSync(mkdtempSync(path.join(tmpdir(), 'dream-journal-')));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const reopen = () => createDreamFileStore({ directory, ...options });
  return { directory, store: reopen(), reopen, ...changes(directory),
    crash(change, boundary) {
      const source = `import { createDreamFileStore } from ${JSON.stringify(moduleURL)};
        const change = JSON.parse(process.argv[1]);
        const store = createDreamFileStore({ directory: process.argv[2], checkpoint: point => {
          if (point === process.argv[3]) process.kill(process.pid, 'SIGKILL');
        }});
        store.commit(change);`;
      const result = spawnSync(process.execPath, ['--input-type=module', '-e', source, JSON.stringify(change), directory, boundary], { encoding: 'utf8', timeout: 10_000 });
      assert.equal(result.signal, 'SIGKILL', result.stderr);
    },
  };
}
dreamStoreConformance('POSIX dream journal', fixture, posix);

test('v1 journal state upgrades on the next transaction without rewriting history', posix, t => {
  const f = fixture(t), legacy = structuredClone(f.first);
  legacy.state.schemaVersion = 1; delete legacy.state.inputReceipts; delete legacy.state.outcomeReceipts; delete legacy.state.selectionCheckpoints; delete legacy.state.noticeLedgers;
  assert.equal(f.store.commit(legacy), true);
  const bytes = readFileSync(path.join(f.directory, name(1)));
  const store = f.reopen(), scheduler = createDreamScheduler({ store, execute: () => {}, soulDirectory: () => f.directory });
  assert.equal(scheduler.status().schemaVersion, 7);
  assert.deepEqual(scheduler.status().inputReceipts, []);
  assert.equal(store.read().schemaVersion, 1, 'read-only inspection does not migrate disk');
  scheduler.pause(A);
  assert.equal(store.read().schemaVersion, 7);
  assert.deepEqual(readFileSync(path.join(f.directory, name(1))), bytes);
  assert.equal(store.history().records.length, 2);
});

// Version 7 added run ownership; an older journal's runs never carried it.
function withoutOwnership(change) {
  const strip = run => { if (run && typeof run === 'object') delete run.ownership; };
  change.state.flights.forEach(strip); change.state.registrations.forEach(row => strip(row.lastRun));
  for (const event of change.events) { strip(event.run); strip(event.registration?.lastRun); }
  return change;
}

for (const version of [2, 3, 4, 5, 6]) test(`v${version} prepared runs retain their input references during v7 restart quarantine`, posix, async t => {
  const f = fixture(t), captured = [], metadata = emptyInputs();
  let state = null;
  const old = createDreamScheduler({ soulDirectory: () => f.directory, setTimer: () => 1, clearTimer() {},
    store: { read: () => state, commit(change) { state = structuredClone(change.state); captured.push(structuredClone(change)); return true; } },
    execute: ({ prepareInputs }) => { prepareInputs(metadata); return new Promise(() => {}); },
  });
  old.register(A, 'PT1H'); old.runNow(A); await Promise.resolve();
  for (const change of captured) {
    withoutOwnership(change);
    change.state.schemaVersion = version; if (version < 5) delete change.state.noticeLedgers;
    if (version < 4) delete change.state.selectionCheckpoints;
    if (version === 2) delete change.state.outcomeReceipts;
    assert.equal(f.store.commit(change), true);
  }
  const reference = f.store.read().inputReceipts[0], bytes = readFileSync(path.join(f.directory, name(3)));
  const scheduler = createDreamScheduler({ store: f.reopen(), execute() {}, soulDirectory: () => f.directory });
  assert.equal(f.reopen().read().schemaVersion, version);
  assert.equal(scheduler.recover().quarantined, 1);
  assert.equal(f.reopen().read().schemaVersion, 7);
  assert.deepEqual(scheduler.status().inputReceipts, [reference]);
  assert.deepEqual(scheduler.status().noticeLedgers.map(ledger => ledger.notices.map(notice => notice.kind)), [['recovery']],
    'the migrating quarantine transaction carries its recovery notice');
  assert.deepEqual(readFileSync(path.join(f.directory, name(3))), bytes);
  assert.equal(scheduler.runNow(A).reason, 'recovery-required');
});

test('uncertain terminal writes recover either the live lease or the complete outcome transaction', posix, async t => {
  for (const boundary of ['before-create', 'after-publish']) await t.test(boundary, async t => {
    const f = fixture(t), metadata = emptyInputs(); let completing = false;
    const store = createDreamFileStore({ directory: f.directory, checkpoint(point) {
      if (completing && point === boundary) throw new Error('interrupted terminal publication');
    } });
    const scheduler = createDreamScheduler({ store, soulDirectory: () => f.directory, execute: ({ run, prepareInputs, stageOutcome }) => {
      prepareInputs(metadata);
      stageOutcome(interpretDreamReport({ run, inputs: metadata,
        reply: JSON.stringify({ schemaVersion: 1, runId: run.runId, startingRevision: metadata.revision, items: [] }) }));
      completing = true;
    } });
    scheduler.register(A, 'PT1H');
    assert.equal((await scheduler.runNow(A).done).status, 'persistence-failed');
    const reopened = f.reopen(), state = reopened.read(), events = reopened.history().records.at(-1).events;
    if (boundary === 'before-create') {
      assert.equal(state.flights.length, 1); assert.deepEqual(state.outcomeReceipts, []);
      assert.deepEqual(state.selectionCheckpoints, []);
      assert.deepEqual(events.map(event => event.kind), ['inputs-prepared']);
      const recovered = createDreamScheduler({ store: reopened, execute() {}, soulDirectory: () => f.directory });
      assert.equal(recovered.recover().quarantined, 1);
    } else {
      assert.equal(state.flights.length, 0); assert.equal(state.registrations[0].lastRun.status, 'completed');
      assert.deepEqual(events.map(event => event.kind), ['ended', 'outcome-recorded', 'selection-advanced']);
      assert.deepEqual(state.outcomeReceipts, [events[1].receipt]);
      assert.deepEqual(state.selectionCheckpoints, [events[2].checkpoint]);
      assert.equal(events[1].outcome.processingCoverage, 'unverified');
    }
  });
});

test('competing writers publish exactly one transaction at the same revision', posix, async t => {
  const f = fixture(t);
  const source = `import { createDreamFileStore } from ${JSON.stringify(moduleURL)};
    import { readSync } from 'node:fs';
    const store = createDreamFileStore({directory: process.argv[1], checkpoint: point => {
      if(point === 'after-file-fsync') {
        process.stdout.write('ready\\n');
        const until = Date.now() + 5000, wait = new Int32Array(new SharedArrayBuffer(4));
        for (;;) {
          try { if (readSync(0, Buffer.alloc(1), 0, 1, null) !== 1) throw new Error('barrier closed'); break; }
          catch (error) { if (error.code !== 'EAGAIN' || Date.now() >= until) throw error; Atomics.wait(wait, 0, 0, 5); }
        }
      }
    }});
    process.stdout.write(JSON.stringify({won: store.commit(JSON.parse(process.argv[2]))})+'\\n');`;
  function writer(change) {
    const child = spawn(process.execPath, ['--input-type=module', '-e', source, f.directory, JSON.stringify(change)], { stdio: ['pipe', 'pipe', 'pipe'] });
    let output = '', errors = '';
    let readyResolve, readyReject;
    const ready = new Promise((resolve, reject) => { readyResolve = resolve; readyReject = reject; });
    const done = new Promise((resolve, reject) => {
      child.stdout.on('data', bytes => { output += bytes; if (output.includes('ready\n')) readyResolve(); });
      child.stderr.on('data', bytes => { errors += bytes; });
      child.on('error', error => { readyReject(error); reject(error); });
      child.on('exit', (code, signal) => {
        if (code !== 0) { const error = new Error(`writer failed ${code}/${signal}: ${errors}`); readyReject(error); reject(error); }
        else resolve(JSON.parse(output.trim().split('\n').at(-1)));
      });
    });
    const timeout = setTimeout(() => child.kill('SIGKILL'), 10_000);
    t.after(() => { clearTimeout(timeout); if (child.exitCode === null) child.kill('SIGKILL'); });
    return { child, ready, done };
  }
  const alternative = structuredClone(f.first);
  alternative.state.registrations[0].intervalHours = 12;
  alternative.events[0].registration.intervalHours = 12;
  const a = writer(f.first), b = writer(alternative);
  await Promise.all([a.ready, b.ready]);
  a.child.stdin.end('x'); b.child.stdin.end('x');
  const results = await Promise.all([a.done, b.done]);
  assert.equal(results.filter(result => result.won).length, 1);
  const expected = results[0].won ? f.first : alternative;
  const reopened = f.reopen();
  assert.deepEqual(reopened.read(), expected.state);
  assert.deepEqual(reopened.history().records, [{ revision: 1, events: expected.events }]);
});

test('a live handle refuses a foreign writer and reopening observes its whole commit', posix, t => {
  const f = fixture(t), other = f.reopen();
  assert.equal(other.read(), null);
  assert.equal(f.store.commit(f.first), true);
  assert.throws(() => other.read(), { code: 'dream-journal-foreign-writer' });
  assert.equal(other.commit(f.first), false);
  assert.deepEqual(f.reopen().read(), f.first.state);
});

test('scheduler executes only after state and started history are present on disk', posix, async t => {
  const f = fixture(t);
  let called = 0;
  const scheduler = createDreamScheduler({ store: f.store, soulDirectory: () => f.directory,
    execute: ({ run }) => {
      const reopened = f.reopen();
      assert.equal(reopened.read().flights[0].runId, run.runId);
      assert.ok(reopened.history().records.some(row => row.events.some(event => event.kind === 'started' && event.run.runId === run.runId)));
      called++;
    },
  });
  scheduler.register(A, 'PT1H');
  assert.equal((await scheduler.runNow(A).done).status, 'completed');
  assert.equal(called, 1);
  assert.equal(f.reopen().read().flights.length, 0);
  scheduler.unschedule(A);
  assert.equal(f.reopen().history().records.at(-1).events[0].kind, 'unscheduled');
  assert.equal(f.reopen().read().registrations.length, 0);
});

test('a published start with a lost acknowledgment freezes execution and survives restart as an unsettled lease', posix, t => {
  const f = fixture(t); f.store.commit(f.first);
  let called = false;
  const uncertain = createDreamFileStore({ directory: f.directory, checkpoint(point) { if (point === 'after-publish') throw new Error('injected failure'); } });
  const scheduler = createDreamScheduler({ store: uncertain, soulDirectory: () => f.directory, execute: () => { called = true; } });
  assert.throws(() => scheduler.runNow(A), { code: 'dream-store-failed' });
  assert.equal(called, false);
  const resumed = createDreamScheduler({ store: f.reopen(), soulDirectory: () => f.directory, execute: () => { called = true; } });
  assert.equal(resumed.runNow(A).reason, 'recovery-required');
  assert.deepEqual(resumed.recover(), { quarantined: 1, settled: 0, terminating: 0 });
  assert.equal(resumed.status().flights[0].status, 'recovery-required');
});

test('invalid, oversized, gapped and symlink records refuse rather than rolling back to an older revision', posix, async t => {
  for (const corruption of ['json', 'digest', 'gap', 'symlink', 'oversized', 'public']) await t.test(corruption, t => {
    const f = fixture(t); f.store.commit(f.first); f.store.commit(f.second);
    const target = path.join(f.directory, name(2));
    if (corruption === 'json') writeFileSync(target, '{CANARY malformed');
    if (corruption === 'digest') { const row = JSON.parse(readFileSync(target)); row.events[0].registration.intervalHours = 2; writeFileSync(target, JSON.stringify(row)); }
    if (corruption === 'gap') renameSync(target, path.join(f.directory, name(3)));
    if (corruption === 'symlink') { rmSync(target); symlinkSync(path.join(f.directory, name(1)), target); }
    if (corruption === 'oversized') writeFileSync(target, Buffer.alloc(DREAM_STORE_LIMITS.recordBytes + 1));
    if (corruption === 'public') chmodSync(target, 0o644);
    assert.throws(() => f.reopen().read(), { code: 'dream-journal-invalid' });
  });
});

test('private canonical directory, transaction capacity, orphan reporting and history pages are explicit', posix, t => {
  const f = fixture(t, { capacity: 1 }); f.store.commit(f.first);
  assert.equal(f.store.status().full, true);
  assert.throws(() => f.store.commit(f.second), { code: 'dream-journal-full' });
  assert.equal(f.store.status().automaticPruning, false);
  const temp = path.join(f.directory, '.11111111-1111-4111-8111-111111111111.tmp');
  writeFileSync(temp, 'incomplete', { mode: 0o600 });
  assert.equal(f.reopen().status().temporaryFiles, 1);
  assert.equal(readFileSync(temp, 'utf8'), 'incomplete', 'read never deletes a crash orphan');
  assert.throws(() => f.store.history({ limit: 17 }), { code: 'dream-history-query' });
  assert.throws(() => f.store.history({ afterRevision: -1 }), { code: 'dream-history-query' });
  chmodSync(f.directory, 0o755);
  assert.throws(() => f.reopen().read(), { code: 'dream-store-directory' });
});

test('history schema rejects arbitrary content and wrong event states before any file is written', posix, t => {
  const f = fixture(t);
  for (const event of [
    { ...f.first.events[0], prompt: 'CANARY' },
    { ...f.first.events[0], kind: 'paused' },
    { kind: 'unknown', at: f.first.events[0].at, run: {} },
  ]) assert.throws(() => validateDreamEvents([event]), { code: 'dream-state-invalid' });
  const invalid = structuredClone(f.first); invalid.events[0].content = 'CANARY';
  assert.throws(() => f.store.commit(invalid), { code: 'dream-state-invalid' });
  assert.deepEqual(readdirSync(f.directory), []);
});

test('file fsync precedes publication and directory fsync precedes acknowledgment', posix, t => {
  const f = fixture(t), order = [];
  const originalSync = fs.fsyncSync, originalLink = fs.linkSync;
  try {
    fs.fsyncSync = fd => { order.push(fs.fstatSync(fd).isDirectory() ? 'directory-sync' : 'file-sync'); return originalSync(fd); };
    fs.linkSync = (...args) => { order.push('publish'); return originalLink(...args); };
    syncBuiltinESMExports();
    assert.equal(f.store.commit(f.first), true); order.push('ack');
  } finally {
    fs.fsyncSync = originalSync; fs.linkSync = originalLink; syncBuiltinESMExports();
  }
  assert.deepEqual(order, ['file-sync', 'publish', 'directory-sync', 'ack']);
});

test('real fsync errors never acknowledge a transaction, including a published but uncertain record', posix, async t => {
  for (const failedSync of ['file', 'directory']) await t.test(failedSync, t => {
    const f = fixture(t), original = fs.fsyncSync;
    try {
      fs.fsyncSync = fd => {
        if ((fs.fstatSync(fd).isDirectory() ? 'directory' : 'file') === failedSync) throw Object.assign(new Error('injected fsync failure'), { code: 'EIO' });
        return original(fd);
      };
      syncBuiltinESMExports();
      assert.throws(() => f.store.commit(f.first), { code: 'EIO' });
    } finally { fs.fsyncSync = original; syncBuiltinESMExports(); }
    const reopened = f.reopen();
    if (failedSync === 'file') { assert.equal(reopened.read(), null); assert.equal(reopened.history().records.length, 0); }
    else { assert.deepEqual(reopened.read(), f.first.state); assert.deepEqual(reopened.history().records[0].events, f.first.events); }
  });
});
