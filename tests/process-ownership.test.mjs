import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { LEADER_START, createProcessOwnershipPort, readProcessLeader, terminationLadder } from '../process-ownership.mjs';

const STARTED = 'Fri Oct 9 18:56:30 2026';
const OWNED = { pgid: 4242, leaderStartedAt: STARTED };
const posix = { skip: process.platform === 'win32' ? 'process groups are POSIX-only' : false };
const errno = code => Object.assign(new Error(code), { code });

// A scripted group: `alive` answers the probe, `leader` the ps row.
function fake({ platform = 'darwin', probe = () => {}, leader = () => ({ pgid: OWNED.pgid, startedAt: STARTED }) } = {}) {
  const signals = [];
  const port = createProcessOwnershipPort({ platform, graceMs: 30, reapMs: 30, leader,
    kill: (pid, signal) => { if (signal === 0) return probe(pid); signals.push([pid, signal]); } });
  return { port, signals };
}

test('only ESRCH proves absence; EPERM, other errors and unverifiable leaders are ambiguous', () => {
  assert.equal(fake({ probe: () => { throw errno('ESRCH'); } }).port.inspect(OWNED), 'absent');
  assert.equal(fake({ probe: () => { throw errno('EPERM'); } }).port.inspect(OWNED), 'ambiguous');
  assert.equal(fake({ probe: () => { throw errno('EINVAL'); } }).port.inspect(OWNED), 'ambiguous');
  assert.equal(fake().port.inspect(OWNED), 'owned');
  for (const leader of [
    () => ({ pgid: OWNED.pgid, startedAt: 'Fri Oct 9 18:56:31 2026' }), // reused PID: start time differs
    () => ({ pgid: 7, startedAt: STARTED }), // no longer the group leader
    () => null, // leader gone while its group lives on
    () => { throw new Error('ps failed'); },
  ]) assert.equal(fake({ leader }).port.inspect(OWNED), 'ambiguous');
  for (const ownership of [null, {}, { pgid: 1, leaderStartedAt: STARTED }, { pgid: 4242, leaderStartedAt: 'yesterday' },
    { ...OWNED, extra: true }]) assert.equal(fake().port.inspect(ownership), 'ambiguous');
});

test('records only a PID that leads its own group, and reports unsupported platforms', () => {
  assert.deepEqual(fake().port.record(OWNED.pgid), OWNED);
  assert.throws(() => fake({ leader: () => ({ pgid: 7, startedAt: STARTED }) }).port.record(OWNED.pgid), { code: 'dream-ownership-unavailable' });
  assert.throws(() => fake({ leader: () => null }).port.record(OWNED.pgid), { code: 'dream-ownership-unavailable' });
  assert.throws(() => fake().port.record(undefined), { code: 'dream-ownership-unavailable' });
  for (const platform of ['win32', 'freebsd']) {
    const { port } = fake({ platform });
    assert.equal(port.record(OWNED.pgid), null);
    assert.equal(port.inspect(OWNED), 'unsupported');
  }
});

test('termination re-establishes ownership before each signal and never signals an ambiguous group', async () => {
  let alive = true;
  const exits = fake({ probe: () => { if (!alive) throw errno('ESRCH'); } });
  const pending = exits.port.terminate(OWNED);
  assert.deepEqual(exits.signals, [[-OWNED.pgid, 'SIGTERM']]);
  alive = false;
  assert.equal(await pending, true);
  assert.deepEqual(exits.signals, [[-OWNED.pgid, 'SIGTERM']], 'no SIGKILL once the group is gone');

  const stubborn = fake();
  assert.equal(await stubborn.port.terminate(OWNED), false);
  assert.deepEqual(stubborn.signals.map(row => row[1]), ['SIGTERM', 'SIGKILL']);

  let reused = false;
  const lost = fake({ leader: () => ({ pgid: OWNED.pgid, startedAt: reused ? 'Sat Oct 10 00:00:00 2026' : STARTED }) });
  const stopping = lost.port.terminate(OWNED); reused = true;
  assert.equal(await stopping, false);
  assert.deepEqual(lost.signals.map(row => row[1]), ['SIGTERM'], 'ownership lost before SIGKILL sends nothing more');

  for (const options of [{ probe: () => { throw errno('EPERM'); } }, { leader: () => null }, { platform: 'win32' }]) {
    const { port, signals } = fake(options);
    assert.equal(await port.terminate(OWNED), false);
    assert.deepEqual(signals, []);
  }
  assert.equal(await terminationLadder({ alive: () => true, signal: () => false, graceMs: 0, reapMs: 0 }), false);
});

test('a real detached sleep is recorded, owned, terminated and then proven absent', posix, async t => {
  const child = spawn('sleep', ['30'], { detached: true, stdio: 'ignore' });
  t.after(() => { try { process.kill(-child.pid, 'SIGKILL'); } catch { /* already gone */ } });
  await once(child, 'spawn');
  const port = createProcessOwnershipPort({ graceMs: 1_000, reapMs: 2_000 });
  const ownership = port.record(child.pid);
  assert.equal(ownership.pgid, child.pid);
  assert.match(ownership.leaderStartedAt, LEADER_START);
  assert.equal(port.inspect(ownership), 'owned');
  assert.equal(port.inspect({ ...ownership, leaderStartedAt: 'Mon Jan 1 00:00:00 2001' }), 'ambiguous', 'a start-time mismatch is never owned');
  assert.equal(await port.terminate({ ...ownership, leaderStartedAt: 'Mon Jan 1 00:00:00 2001' }), false);
  assert.equal(port.inspect(ownership), 'owned', 'an ambiguous match sends no signal');
  assert.equal(await port.terminate(ownership), true);
  assert.equal(port.inspect(ownership), 'absent');
  assert.equal(readProcessLeader(child.pid), null);
});
