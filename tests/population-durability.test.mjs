import test from 'node:test';
import assert from 'node:assert/strict';
import fs, { mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { populationFile, setSoulComputerUse, showSoul, soulComputerUse, upsertSoul } from '../agent-population.mjs';

const ID = 'agent_11111111-1111-4111-8111-111111111111';

function fixture(t) {
  const home = mkdtempSync(path.join(tmpdir(), 'population-durability-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const env = { HOME: home, XDG_STATE_HOME: path.join(home, 'state'), AGENT_BOT_POPULATION_PATH: path.join(home, 'population.json') };
  const file = populationFile({ env, home });
  upsertSoul({ id: ID, name: 'bill', displayName: 'Bill', status: 'active', spacePath: home }, { file });
  return { home, file };
}

// Replaces one node:fs function for the duration of `run`, for this module's
// named imports too.
function patched(name, replacement, run) {
  const original = fs[name];
  fs[name] = replacement(original);
  syncBuiltinESMExports();
  try { return run(); } finally { fs[name] = original; syncBuiltinESMExports(); }
}

test('a population write fsyncs the file and its directory and reads back exactly what it wrote', (t) => {
  const f = fixture(t);
  const synced = [];
  patched('fsyncSync', (original) => (fd) => { synced.push(fd); return original(fd); }, () => setSoulComputerUse(ID, false, f));
  // The temporary file before the rename, then the directory after it.
  assert.equal(synced.length, process.platform === 'win32' ? 1 : 2);
  assert.equal(soulComputerUse(ID, f), false);
  assert.deepEqual(readFileSync(f.file, 'utf8').endsWith('\n'), true);
});

test('a read-back that differs from the write fails the write', (t) => {
  const f = fixture(t);
  const read = (original) => (target, ...rest) => {
    const value = original(target, ...rest);
    // Simulate a store that lost the write: the read-back is the old document.
    return target === f.file && typeof value === 'string' ? value.replace('"computerUse": false', '"computerUse": true') : value;
  };
  assert.throws(() => patched('readFileSync', read, () => setSoulComputerUse(ID, false, f)),
    (error) => error.code === 'population-readback-failed' && /differs/.test(error.message));
});

test('an unreadable or unparsable read-back fails the write, and an fsync failure fails it too', (t) => {
  const f = fixture(t);
  assert.throws(() => patched('readFileSync', (original) => (target, ...rest) => (target === f.file ? '{not json' : original(target, ...rest)),
    () => setSoulComputerUse(ID, false, f)), (error) => error.code === 'population-readback-failed');
  assert.throws(() => patched('fsyncSync', () => () => { throw Object.assign(new Error('EIO'), { code: 'EIO' }); },
    () => setSoulComputerUse(ID, true, f)), /EIO/);
  // No temporary file is left behind by a failed write.
  assert.deepEqual(fs.readdirSync(path.dirname(f.file)).filter((name) => name.endsWith('.tmp')), []);
});

// A lock directory last touched 31 s ago, owned by `pid`: past the 30 s stale
// window file-lock.mjs uses.
function staleLock(file, pid) {
  const lock = `${file}.lock`;
  mkdirSync(lock);
  writeFileSync(path.join(lock, 'owner'), `${pid}.00000000-0000-4000-8000-000000000000`);
  const then = (Date.now() - 31_000) / 1000;
  utimesSync(lock, then, then);
  return lock;
}

test('a live holder past the stale window is never reclaimed: the waiter refuses', (t) => {
  const f = fixture(t);
  // This test process is alive, so it stands in for a live holder.
  const lock = staleLock(f.file, process.pid);
  const before = readFileSync(f.file, 'utf8');
  assert.throws(() => setSoulComputerUse(ID, false, f), /timed out waiting for population store/);
  assert.equal(readFileSync(f.file, 'utf8'), before, 'nothing was written');
  assert.ok(fs.existsSync(lock), 'the live holder still holds its lock');
});

test('a stale lock whose owner process is gone is still reclaimed', (t) => {
  const f = fixture(t);
  // A pid that existed and has exited.
  const gone = spawnSync(process.execPath, ['-e', 'console.log(process.pid)'], { encoding: 'utf8' });
  const pid = Number(gone.stdout.trim());
  assert.ok(Number.isSafeInteger(pid) && pid > 0);
  staleLock(f.file, pid);
  setSoulComputerUse(ID, false, f);
  assert.equal(showSoul(ID, f).computerUse, false);
});
