import test from 'node:test';
import assert from 'node:assert/strict';
import fs, { mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { lockOwnerAlive, lockOwnerToken, parseLockOwner, withLock } from '../file-lock.mjs';
import { populationFile, setSoulComputerUse, upsertSoul } from '../agent-population.mjs';

const UUID = '00000000-0000-4000-8000-000000000000';
const BOOT = '0123456789abcdef0123456789abcdef';
const OTHER_BOOT = 'fedcba9876543210fedcba9876543210';

// --- the decision itself, on synthetic tokens and probes ---

test('tokens carry pid, start and boot; old pid.uuid tokens still read as pid only', () => {
  assert.deepEqual(parseLockOwner(`123.456.${BOOT}.${UUID}`), { pid: 123, start: '456', boot: BOOT });
  assert.deepEqual(parseLockOwner(`123.-.-.${UUID}`), { pid: 123, start: null, boot: null });
  assert.deepEqual(parseLockOwner(`123.${UUID}`), { pid: 123, start: null, boot: null }, 'a token from before #1115');
  for (const junk of ['', 'abc', '0.1.-.x', null, undefined, 42]) assert.equal(parseLockOwner(junk), null, String(junk));
  // Our own token, in the current format, with the pid first.
  const own = parseLockOwner(lockOwnerToken());
  assert.equal(own.pid, process.pid);
  assert.match(lockOwnerToken(), /^\d+\.(\d+|-)\.([0-9a-f]{32}|-)\.[0-9a-f-]{36}$/);
});

test('a live owner with the same boot and start keeps its lock', () => {
  for (const platform of ['linux', 'darwin']) {
    const probe = { platform, boot: BOOT, alive: () => true, startOf: () => '1000' };
    assert.equal(lockOwnerAlive({ pid: 7, start: '1000', boot: BOOT }, probe), true, platform);
  }
});

// macOS fails closed: with no kernel-sourced start, a live pid on the same (or
// an unknown) boot keeps its lock whatever start time is recorded or seen.
test('macOS never reclaims a live pid on a start time: clock rollback, a future start, reuse or a delayed exec', () => {
  const darwin = (recorded, seen) => lockOwnerAlive({ pid: 7, start: recorded, boot: null }, { platform: 'darwin', boot: null, alive: () => true, startOf: () => seen });
  assert.equal(darwin('1000', 400), true, 'a wall-clock rollback after fork: the token looks later than the real start');
  assert.equal(darwin('1000', 4600), true, 'the token looks earlier than the real start (rollback before load, or pid reuse)');
  assert.equal(darwin('9999999999', 1000), true, 'a start recorded in the future');
  assert.equal(darwin('1000', 997), true, 'forked before node started (sleep, then exec node)');
  assert.equal(darwin(null, 1000), true, 'a macOS token records no start');
  // A start reader is never consulted on macOS.
  assert.equal(lockOwnerAlive({ pid: 7, start: '1000', boot: null }, { platform: 'darwin', boot: null, alive: () => true,
    startOf: () => assert.fail('macOS reads no start time') }), true);
  // Only a gone pid, or a known different boot, frees it.
  assert.equal(lockOwnerAlive({ pid: 7, start: null, boot: null }, { platform: 'darwin', boot: null, alive: () => false }), false);
  assert.equal(lockOwnerAlive({ pid: 7, start: null, boot: BOOT }, { platform: 'darwin', boot: OTHER_BOOT, alive: () => true }), false);
});

test('an owner from another boot is gone, even if its pid is alive again', () => {
  assert.equal(lockOwnerAlive({ pid: 7, start: '1000', boot: BOOT }, { platform: 'linux', boot: OTHER_BOOT, alive: () => true, startOf: () => '1000' }), false);
});

test('an owner whose pid now has another start time is gone (pid reuse)', () => {
  assert.equal(lockOwnerAlive({ pid: 7, start: '1000', boot: BOOT }, { platform: 'linux', boot: BOOT, alive: () => true, startOf: () => '2000' }), false);
  // Linux start ticks come from the kernel, so a clock rollback can't move
  // them: an earlier or later recorded start both mean another process.
  assert.equal(lockOwnerAlive({ pid: 7, start: '1000', boot: BOOT }, { platform: 'linux', boot: BOOT, alive: () => true, startOf: () => '999' }), false);
});

test('an owner whose pid is gone is gone; an unreadable pid is gone, as before', () => {
  assert.equal(lockOwnerAlive({ pid: 7, start: '1000', boot: BOOT }, { platform: 'linux', boot: BOOT, alive: () => false, startOf: () => '1000' }), false);
  assert.equal(lockOwnerAlive(null), false);
});

test('anything that can\'t be read falls back to the pid check alone', () => {
  const alive = () => true;
  // Start unreadable now, or never recorded, or a pre-#1115 token.
  assert.equal(lockOwnerAlive({ pid: 7, start: '1000', boot: BOOT }, { platform: 'linux', boot: BOOT, alive, startOf: () => null }), true);
  assert.equal(lockOwnerAlive({ pid: 7, start: null, boot: null }, { platform: 'linux', boot: BOOT, alive, startOf: () => '9' }), true);
  // Boot unknown on either side never decides.
  assert.equal(lockOwnerAlive({ pid: 7, start: '1000', boot: null }, { platform: 'linux', boot: BOOT, alive, startOf: () => '1000' }), true);
  assert.equal(lockOwnerAlive({ pid: 7, start: '1000', boot: BOOT }, { platform: 'linux', boot: null, alive, startOf: () => '1000' }), true);
  // Windows keeps the pid-only check.
  assert.equal(lockOwnerAlive({ pid: 7, start: '1000', boot: BOOT }, { platform: 'win32', boot: OTHER_BOOT, alive, startOf: () => '2000' }), true);
  assert.equal(lockOwnerAlive({ pid: 7, start: '1000', boot: null }, { platform: 'win32', boot: null, alive: () => false }), false);
});

// --- the real lock, with real process data on this platform ---

function staleLock(lock, token) {
  mkdirSync(lock);
  writeFileSync(path.join(lock, 'owner'), token);
  const then = (Date.now() - 31_000) / 1000;
  utimesSync(lock, then, then);
}

test('a stale lock held by this live process, in the current format, is kept', { skip: process.platform === 'win32' }, (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'file-lock-owner-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const lock = path.join(dir, 'state.lock');
  staleLock(lock, lockOwnerToken());
  assert.throws(() => withLock(lock, 'test store', () => assert.fail('must not run'), { keepLiveOwners: true }), /timed out waiting for test store/);
  assert.ok(fs.existsSync(lock));
});

test('a stale lock whose live pid has a different start time is reclaimed', { skip: process.platform === 'win32' }, (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'file-lock-owner-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const lock = path.join(dir, 'state.lock');
  // This process's pid is alive, but the token says its owner started
  // earlier than this process did: the owner died and its pid was reused.
  const own = parseLockOwner(lockOwnerToken());
  if (own.start === null) return t.skip('this platform records no start time');
  const earlier = Number(own.start) - 1;
  staleLock(lock, `${process.pid}.${earlier}.${own.boot ?? '-'}.${UUID}`);
  let ran = false;
  withLock(lock, 'test store', () => { ran = true; }, { keepLiveOwners: true });
  assert.equal(ran, true);
});

test('a stale lock in the old pid.uuid format, held by a live pid, is still kept', { skip: process.platform === 'win32' }, (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'file-lock-owner-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const lock = path.join(dir, 'state.lock');
  staleLock(lock, `${process.pid}.${UUID}`);
  assert.throws(() => withLock(lock, 'test store', () => {}, { keepLiveOwners: true }), /timed out/);
});

test('a stale lock whose owner exited is reclaimed', (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'file-lock-owner-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const lock = path.join(dir, 'state.lock');
  const gone = Number(spawnSync(process.execPath, ['-e', 'console.log(process.pid)'], { encoding: 'utf8' }).stdout.trim());
  staleLock(lock, `${gone}.1.-.${UUID}`);
  let ran = false;
  withLock(lock, 'test store', () => { ran = true; }, { keepLiveOwners: true });
  assert.equal(ran, true);
});

// --- writeDocument: an error after the rename is not a rollback ---

test('a directory fsync failure after the rename throws, but the new census is already in place', { skip: process.platform === 'win32' }, (t) => {
  const home = mkdtempSync(path.join(tmpdir(), 'population-post-rename-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const file = populationFile({ env: { AGENT_BOT_POPULATION_PATH: path.join(home, 'population.json') }, home });
  const ID = 'agent_11111111-1111-4111-8111-111111111111';
  upsertSoul({ id: ID, name: 'bill', displayName: 'Bill', status: 'active', spacePath: home }, { file });
  // The first fsync is the temporary file's; the second is the directory's.
  const original = fs.fsyncSync;
  let calls = 0;
  fs.fsyncSync = (fd) => { calls += 1; if (calls === 2) throw Object.assign(new Error('EIO'), { code: 'EIO' }); return original(fd); };
  syncBuiltinESMExports();
  try {
    assert.throws(() => setSoulComputerUse(ID, false, { file }), /EIO/);
  } finally {
    fs.fsyncSync = original;
    syncBuiltinESMExports();
  }
  assert.equal(calls, 2);
  // The caller saw a failure, yet the census already holds the new value.
  assert.equal(JSON.parse(readFileSync(file, 'utf8')).souls[ID].computerUse, false);
});

test('acquiring, releasing and reclaiming a lock never spawns', async (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'file-lock-owner-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const childProcess = (await import('node:child_process')).default;
  const original = childProcess.spawnSync;
  let spawns = 0;
  childProcess.spawnSync = (...args) => { spawns += 1; return original(...args); };
  syncBuiltinESMExports();
  try {
    for (let i = 0; i < 20; i += 1) withLock(path.join(dir, 'state.lock'), 'test store', () => {}, { keepLiveOwners: true });
    lockOwnerToken();
    // The reclaim path too: a stale lock held by a live pid with a recorded
    // start (kept), and one held by a pid that is gone (reclaimed).
    staleLock(path.join(dir, 'live.lock'), `${process.pid}.1000.-.${UUID}`);
    assert.throws(() => withLock(path.join(dir, 'live.lock'), 'test store', () => {}, { keepLiveOwners: true }), /timed out/);
    staleLock(path.join(dir, 'gone.lock'), `${2 ** 22 + 12345}.1000.-.${UUID}`);
    withLock(path.join(dir, 'gone.lock'), 'test store', () => {}, { keepLiveOwners: true });
  } finally {
    childProcess.spawnSync = original;
    syncBuiltinESMExports();
  }
  assert.equal(spawns, 0);
});

// A holder whose node starts well after its process was forked: a shell runs
// first, then execs node (as Claude's worktree-create hook command does). It
// must stay live; reclaiming it would break the lock it holds.
test('a live holder started through a delayed exec is never reclaimed', { skip: process.platform === 'win32' }, async (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'file-lock-owner-'));
  const lock = path.join(dir, 'state.lock');
  const lockModule = new URL('../file-lock.mjs', import.meta.url).href;
  const holder = path.join(dir, 'holder.mjs');
  writeFileSync(holder, `import { mkdirSync, writeFileSync, utimesSync } from 'node:fs';
import path from 'node:path';
const { lockOwnerToken } = await import(${JSON.stringify(lockModule)});
const lock = process.argv[2];
mkdirSync(lock); writeFileSync(path.join(lock, 'owner'), lockOwnerToken());
const then = (Date.now() - 31_000) / 1000; utimesSync(lock, then, then);
console.log('ready');
setTimeout(() => {}, 30_000);
`);
  const { spawn } = await import('node:child_process');
  const child = spawn('/bin/sh', ['-c', `sleep 2.5; exec "${process.execPath}" "${holder}" "${lock}"`], { stdio: ['ignore', 'pipe', 'ignore'] });
  t.after(() => { child.kill(); rmSync(dir, { recursive: true, force: true }); });
  await new Promise((resolve, reject) => {
    child.stdout.on('data', (chunk) => { if (String(chunk).includes('ready')) resolve(); });
    child.on('exit', () => reject(new Error('holder exited early')));
  });
  assert.equal(child.exitCode, null, 'the holder is alive');
  assert.throws(() => withLock(lock, 'test store', () => assert.fail('a live holder was reclaimed'), { keepLiveOwners: true }), /timed out waiting for test store/);
  assert.ok(fs.existsSync(lock));
});
