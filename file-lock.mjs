// Directory locks with stale-lock reclaim, shared by every module that guards
// a state file (#645, owner decision D1). Moved unchanged from
// agent-identity.mjs; it reads no credential and imports only node built-ins
// (since #1115 that includes child_process, for `/bin/ps` on the macOS
// reclaim path only).
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';

function sleep(milliseconds) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

const STALE_LOCK_MS = 30_000;
// The takeover mutex only ever spans a stat, a rename and an rmdir, so an old
// one means a process died mid-swap rather than a slow neighbour.
const STALE_TAKEOVER_MS = 5_000;

// A directory rename is NOT a compare-and-swap: `renameSync(lock, …)` moves
// whatever occupies the path when it runs, not the directory the caller judged
// stale a moment earlier. Checking an inode afterwards does not fix that — by
// then a third waiter can already be inside its critical section, and the
// rollback can fail with ENOTEMPTY once that waiter stamps its own owner file.
// Verifying after acting is always too late.
//
// So the mutual exclusion rests on one invariant instead:
//
//   `lock` is removed or renamed ONLY while holding `<lock>.takeover`.
//
// Acquisition does not need the mutex, because `mkdirSync` only succeeds when
// the path is free, and the path can only become free through a release or a
// reclaim — both of which hold it. That makes a reclaimer's stat→rename window
// safe: while it holds the mutex nothing can release the lock, so nothing can
// replace it, so what it renames is what it inspected. See issue #15.
// --- who holds a lock (#1115) ---
//
// A live-owner lock (keepLiveOwners) is reclaimed only from an owner that is
// gone. `process.kill(pid, 0)` alone can't tell a crashed owner from an
// unrelated process that reuses its pid later, notably after a reboot, which
// would keep the lock held until someone removed it by hand. So the owner
// token records `pid.start.boot.uuid`:
// - `start`: the owner's process start. On Linux the start time in clock ticks
//   since boot (/proc/<pid>/stat field 22), compared exactly. On macOS whole
//   wall-clock seconds, compared within START_TOLERANCE_SECONDS.
// - `boot`: on Linux the kernel boot ID (/proc/sys/kernel/random/boot_id,
//   hyphens removed). macOS has no in-process boot ID, so it records `-`; a
//   pid reused after a reboot has a later start time anyway.
// Either is `-` where it can't be read, and on Windows both are, so liveness
// falls back to the pid check alone, as before. A token from before this
// change (`pid.uuid`) is read the same way. The pid stays first, so an older
// binary still reads it.
//
// Our own values are read once, in-process, at load: acquiring a lock never
// spawns. Only the reclaim path, and only on macOS, runs a bounded `ps` for
// another process's start time, which can't prompt.
const START_TOLERANCE_SECONDS = 2;
const PS_TIMEOUT_MS = 1000;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function readLinuxBootId() {
  try {
    const id = readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim().replaceAll('-', '').toLowerCase();
    return /^[0-9a-f]{32}$/.test(id) ? id : null;
  } catch { return null; }
}

// Field 22 of /proc/<pid>/stat, counted after the command name, which may
// itself hold spaces or parentheses.
function readLinuxStart(pid) {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
    const start = fields[19];
    return /^\d+$/.test(start ?? '') ? start : null;
  } catch { return null; }
}

// Another process's start in whole UTC seconds, from `ps` in the C locale and
// UTC, bounded by a short timeout; null if it can't be read.
function readDarwinStart(pid) {
  try {
    const run = spawnSync('/bin/ps', ['-o', 'lstart=', '-p', String(pid)], {
      env: { PATH: '/bin:/usr/bin', TZ: 'UTC0', LC_ALL: 'C' }, encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'], timeout: PS_TIMEOUT_MS,
    });
    if (run.status !== 0 || run.error) return null;
    const match = /^[A-Z][a-z]{2} ([A-Z][a-z]{2}) +(\d{1,2}) (\d{2}):(\d{2}):(\d{2}) (\d{4})$/.exec(run.stdout.trim());
    const month = match ? MONTHS.indexOf(match[1]) : -1;
    if (month < 0) return null;
    return Date.UTC(Number(match[6]), month, Number(match[2]), Number(match[3]), Number(match[4]), Number(match[5])) / 1000;
  } catch { return null; }
}

// This process's own `start` and `boot`, read once at load.
const OWN = (() => {
  if (process.platform === 'linux') return { start: readLinuxStart(process.pid), boot: readLinuxBootId() };
  if (process.platform === 'darwin') return { start: String(Math.round(Date.now() / 1000 - process.uptime())), boot: null };
  return { start: null, boot: null };
})();

export function lockOwnerToken() {
  return `${process.pid}.${OWN.start ?? '-'}.${OWN.boot ?? '-'}.${randomUUID()}`;
}

// A recorded owner, or null when even the pid can't be read.
export function parseLockOwner(token) {
  if (typeof token !== 'string') return null;
  const current = /^(\d+)\.(\d+|-)\.([0-9a-f]{32}|-)\.[0-9a-f-]{36}$/.exec(token);
  if (current) {
    return { pid: Number(current[1]), start: current[2] === '-' ? null : current[2], boot: current[3] === '-' ? null : current[3] };
  }
  const pid = Number(/^(\d+)\./.exec(token)?.[1]);
  return Number.isSafeInteger(pid) && pid > 0 ? { pid, start: null, boot: null } : null;
}

// Whether the recorded owner may still be running. `probe` is for tests:
// `{ alive(pid), startOf(pid), boot, platform }`, each defaulting to the real
// source. Unknown answers keep the owner live, as the pid check did.
export function lockOwnerAlive(owner, probe = {}) {
  const platform = probe.platform ?? process.platform;
  const boot = Object.hasOwn(probe, 'boot') ? probe.boot : OWN.boot;
  const alive = probe.alive ?? ((pid) => {
    try { process.kill(pid, 0); return true; } catch (error) { return error.code !== 'ESRCH'; }
  });
  const startOf = probe.startOf ?? ((pid) => (platform === 'linux' ? readLinuxStart(pid) : platform === 'darwin' ? readDarwinStart(pid) : null));
  if (!owner || !Number.isSafeInteger(owner.pid) || owner.pid <= 0) return false;
  // Windows keeps the pid check alone, unchanged.
  if (platform === 'win32') return alive(owner.pid);
  // Another boot: whatever runs under that pid now is not the owner.
  if (owner.boot !== null && boot !== null && owner.boot !== boot) return false;
  if (!alive(owner.pid)) return false;
  if (owner.start === null) return true;
  const start = startOf(owner.pid);
  if (start === null || start === undefined) return true;
  if (platform === 'darwin') return Math.abs(Number(start) - Number(owner.start)) <= START_TOLERANCE_SECONDS;
  return String(start) === owner.start;
}

function ownerToken(lock) {
  try {
    return readFileSync(path.join(lock, 'owner'), 'utf8');
  } catch {
    return null;
  }
}

// Runs `mutate` while holding the takeover mutex, or returns false without
// running it. Callers must treat false as "try again later" — never as
// permission to proceed unguarded.
function withTakeover(lock, mutate) {
  const takeover = `${lock}.takeover`;
  for (let attempt = 0; attempt < 200; attempt++) {
    try {
      mkdirSync(takeover, { mode: 0o700 });
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      try {
        // A mutex this old belongs to a process that died holding it. Its
        // critical section touches only the lock path, so collecting it plainly
        // is bounded: the worst case is two reclaimers, which is the situation
        // that existed everywhere before this change.
        if (Date.now() - statSync(takeover).mtimeMs > STALE_TAKEOVER_MS) {
          rmSync(takeover, { recursive: true, force: true });
          continue;
        }
      } catch (staleError) {
        if (staleError.code !== 'ENOENT') throw staleError;
      }
      sleep(5);
      continue;
    }
    try {
      mutate();
      return true;
    } finally {
      rmSync(takeover, { recursive: true, force: true });
    }
  }
  return false;
}

export function reclaimStaleLock(lock, observed, { keepLiveOwners = false } = {}) {
  return withTakeover(lock, () => {
    // Re-read under the mutex. Nothing can remove or replace `lock` from here
    // until the mutex is dropped, so this reading stays true for the rename.
    let current;
    try {
      current = statSync(lock);
    } catch (error) {
      if (error.code === 'ENOENT') return;
      throw error;
    }
    if (current.ino !== observed.ino) return;
    if (Date.now() - current.mtimeMs <= STALE_LOCK_MS) return;
    // A live owner keeps its lock; one that is gone, or whose pid now
    // belongs to another process or another boot, does not (#1115).
    if (keepLiveOwners && lockOwnerAlive(parseLockOwner(ownerToken(lock)))) return;

    const stale = `${lock}.stale.${process.pid}.${randomUUID()}`;
    renameSync(lock, stale);
    let moved;
    try {
      moved = statSync(stale);
    } catch {
      return;
    }
    if (moved.ino !== observed.ino) {
      // Unreachable while the invariant holds; kept because getting this wrong
      // costs a live holder its lock. Restoring is best-effort: if a waiter has
      // already taken the free path, leave both alone rather than throwing.
      try {
        renameSync(stale, lock);
      } catch (restoreError) {
        if (!['EEXIST', 'ENOTEMPTY'].includes(restoreError.code)) throw restoreError;
      }
      return;
    }
    rmSync(stale, { recursive: true, force: true });
  });
}

export function withLock(lock, label, operation, { keepLiveOwners = false } = {}) {
  const token = lockOwnerToken();
  let acquired = false;
  for (let attempt = 0; attempt < 200; attempt++) {
    try {
      mkdirSync(lock, { mode: 0o700 });
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      try {
        const observed = statSync(lock);
        if (Date.now() - observed.mtimeMs > STALE_LOCK_MS) {
          reclaimStaleLock(lock, observed, { keepLiveOwners });
          if (!keepLiveOwners) continue;
        }
      } catch (lockError) {
        if (lockError.code !== 'ENOENT') throw lockError;
        /* another writer released or took over the observed lock */
      }
      sleep(10);
      continue;
    }
    try {
      // Stamped after the exclusive mkdir, so it can only ever describe the
      // holder. If stamping fails the directory must not be left behind: an
      // unstamped lock is owned by nobody and would block every writer until
      // the staleness window expired.
      writeFileSync(path.join(lock, 'owner'), token, { encoding: 'utf8', mode: 0o600 });
    } catch (error) {
      rmSync(lock, { recursive: true, force: true });
      throw error;
    }
    acquired = true;
    break;
  }
  if (!acquired) throw new Error(`timed out waiting for ${label}`);
  try {
    return operation();
  } finally {
    // Under the mutex, so the directory whose token we read is the one we
    // remove. Reading the token and then removing the path as two separate
    // steps would delete a successor's lock whenever ours had been reclaimed
    // mid-operation — one stolen lock becoming a cascade.
    withTakeover(lock, () => {
      if (ownerToken(lock) === token) rmSync(lock, { recursive: true, force: true });
    });
  }
}
