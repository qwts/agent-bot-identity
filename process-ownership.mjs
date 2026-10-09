// POSIX process-group ownership evidence for restart recovery (#603). A
// detached agent leads its own process group; recording that group and its
// leader's start time lets a later daemon tell its own orphan from a reused
// PID. Only ESRCH from a group probe proves absence. Every other answer, a
// missing leader or a start-time mismatch is ambiguous, and an ambiguous group
// is never signalled. Other platforms report `unsupported` rather than
// simulating POSIX evidence.
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';

// `ps -o lstart=` under LC_ALL=C and TZ=UTC, with runs of spaces collapsed.
export const LEADER_START = /^(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun) (?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) [1-9]\d? \d{2}:\d{2}:\d{2} \d{4}$/;
export const OWNERSHIP_PLATFORMS = Object.freeze(['darwin', 'linux']);
// Same timing as a finished ACP turn: SIGTERM, then SIGKILL after the grace,
// then a bounded wait for the kernel to reap the group.
export const GROUP_EXIT_GRACE_MS = 2_000;
export const GROUP_REAP_MS = 2_000;
const PS = ['/bin/ps', '/usr/bin/ps'];

const fail = (code, message) => { throw Object.assign(new Error(message), { code }); };

export const validProcessOwnership = value => !!value && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).length === 2 && Number.isSafeInteger(value.pgid) && value.pgid > 1 && value.pgid <= 0x7fffffff
  && typeof value.leaderStartedAt === 'string' && LEADER_START.test(value.leaderStartedAt);

// Resolves true once `alive()` turns false, false when `ms` elapses first.
export async function waitForGroupExit(alive, ms) {
  const deadline = Date.now() + ms;
  while (alive()) {
    if (Date.now() >= deadline) return false;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  return true;
}

// The termination ladder shared by ACP turns and restart recovery. `signal`
// returning false stops the ladder without sending that signal.
export async function terminationLadder({ alive, signal, graceMs, reapMs }) {
  if (signal('SIGTERM') === false) return !alive();
  if (await waitForGroupExit(alive, graceMs)) return true;
  if (signal('SIGKILL') === false) return !alive();
  return waitForGroupExit(alive, reapMs);
}

// One `ps` row for `pid`: its process group and fixed-format start time, or
// null when no such process exists. Anything unparseable throws.
export function readProcessLeader(pid) {
  const command = PS.find(file => existsSync(file));
  if (!command) fail('dream-ownership-unavailable', 'ps is not available to read process start time');
  let output;
  try {
    output = execFileSync(command, ['-o', 'pgid=,lstart=', '-p', String(pid)], {
      env: { LC_ALL: 'C', TZ: 'UTC' }, encoding: 'utf8', timeout: 5_000, maxBuffer: 4096, stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch (error) {
    if (error?.status === 1 && error.stdout === '') return null;
    throw error;
  }
  const match = /^ *([0-9]+) +(\S[^\n]*?) *\n?$/.exec(output);
  const startedAt = match?.[2].replace(/ +/g, ' ');
  if (!match || !LEADER_START.test(startedAt)) fail('dream-ownership-unavailable', 'ps returned an unrecognized start time');
  return { pgid: Number(match[1]), startedAt };
}

/**
 * `record(pid)` returns `{ pgid, leaderStartedAt }` for a just-spawned group
 * leader, or null on an unsupported platform; it throws when POSIX evidence
 * cannot be read. `inspect(ownership)` is synchronous and answers `absent`,
 * `owned`, `ambiguous` or `unsupported`. `terminate(ownership)` walks the
 * ladder, re-establishing ownership before each signal.
 */
export function createProcessOwnershipPort({ platform = process.platform, kill = (pid, signal) => process.kill(pid, signal),
  leader = readProcessLeader, graceMs = GROUP_EXIT_GRACE_MS, reapMs = GROUP_REAP_MS } = {}) {
  const supported = OWNERSHIP_PLATFORMS.includes(platform);
  const probe = pgid => {
    try { kill(-pgid, 0); return 'present'; }
    catch (error) { return error?.code === 'ESRCH' ? 'absent' : 'ambiguous'; }
  };
  function inspect(ownership) {
    if (!supported) return 'unsupported';
    if (!validProcessOwnership(ownership)) return 'ambiguous';
    const seen = probe(ownership.pgid);
    if (seen !== 'present') return seen;
    let found;
    try { found = leader(ownership.pgid); } catch { return 'ambiguous'; }
    return found?.pgid === ownership.pgid && found.startedAt === ownership.leaderStartedAt ? 'owned' : 'ambiguous';
  }
  return {
    record(pid) {
      if (!supported) return null;
      if (!Number.isSafeInteger(pid) || pid < 2) fail('dream-ownership-unavailable', 'the agent process has no usable PID');
      const found = leader(pid);
      const ownership = { pgid: pid, leaderStartedAt: found?.startedAt };
      if (found?.pgid !== pid || !validProcessOwnership(ownership)) fail('dream-ownership-unavailable', 'the agent process does not lead its own process group');
      return ownership;
    },
    inspect,
    async terminate(ownership) {
      if (inspect(ownership) !== 'owned') return false;
      return terminationLadder({
        alive: () => probe(ownership.pgid) !== 'absent',
        signal: name => {
          if (inspect(ownership) !== 'owned') return false;
          try { kill(-ownership.pgid, name); } catch { /* the probe decides */ }
          return true;
        },
        graceMs, reapMs,
      });
    },
  };
}
