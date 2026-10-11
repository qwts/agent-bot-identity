// Directory locks with stale-lock reclaim, shared by every module that guards
// a state file (#645, owner decision D1). Moved unchanged from
// agent-identity.mjs; it reads no credential and imports only node built-ins.
import { randomUUID } from 'node:crypto';
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
    if (keepLiveOwners) {
      const pid = Number(/^(\d+)\./.exec(ownerToken(lock) ?? '')?.[1]);
      if (Number.isSafeInteger(pid) && pid > 0) {
        try {
          process.kill(pid, 0);
          return;
        } catch (error) {
          if (error.code !== 'ESRCH') return;
        }
      }
    }

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
  const token = `${process.pid}.${randomUUID()}`;
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
