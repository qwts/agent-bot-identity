// The per-soul history mirror, `<soul>/.soul-state/runs/` (#583 slice 5,
// ADR-0583 decision 9). The daemon keeps its own journals under the state
// directory (wake sessions, launch requests, task turns, the revision
// journal) and recovery reads those; this mirror is a second, append-only
// copy inside the soul so an export carries the soul's life. Facts only:
// ids, kinds, times, harness, outcome, a revision's reason. Never a prompt,
// an output, a session's contents or a secret.
//
// Best effort by design: a mirror that cannot be written is reported to
// the given `log` and never fails the turn or the revision it mirrors.
import { closeSync, constants, existsSync, fchmodSync, fstatSync, lstatSync, mkdirSync, openSync, readSync, writeSync } from 'node:fs';
import path from 'node:path';
import { populationFile, showSoul } from './agent-population.mjs';

export const RUNS_DIRECTORY = '.soul-state/runs';
export const TURNS_FILE = 'turns.jsonl';
export const REVISIONS_FILE = 'revisions.jsonl';
export const TURN_KINDS = Object.freeze(['turn', 'wake', 'task', 'launch', 'session']);
export const TURN_OUTCOMES = Object.freeze(['ok', 'failed', 'cancelled']);
// `soul env history` lists at most this many records per file by default
// and never more than the maximum: a host pages, it does not slurp a life.
export const HISTORY_LIMIT_DEFAULT = 50;
export const HISTORY_LIMIT_MAX = 500;
// A read parses at most the last 16 MiB of a mirror file; the mirror only
// grows, so the newest records are always in the window.
export const HISTORY_READ_MAX_BYTES = 16 * 1024 * 1024;
// Counting lines past this is a scan this engine will not do for a read.
const LINE_COUNT_MAX_BYTES = 256 * 1024 * 1024;
const STATE = '.soul-state';
const text = (value) => (typeof value === 'string' && value.trim() ? value : null);
const strip = (value, max = 200) => (text(value) ? String(value).replace(/[\u0000-\u001f\u007f-\u009f]+/g, ' ').trim().slice(0, max) : null);

/** The mirror directory of a soul root. */
export const runsDirectory = (soulDir) => path.join(soulDir, STATE, 'runs');

// One line, appended to a 0600 file under a 0700 directory. The write is a
// single `write` of the whole line, so concurrent appends never interleave.
function appendLine(soulDir, name, record) {
  const dir = runsDirectory(soulDir);
  if (!existsSync(path.join(soulDir, STATE))) return false; // not a provisioned soul folder
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const fd = openSync(path.join(dir, name), 'a', 0o600);
  try { fchmodSync(fd, 0o600); writeSync(fd, `${JSON.stringify(record)}\n`); }
  finally { closeSync(fd); }
  return true;
}

/**
 * A turn record as the mirror keeps it: `{ id, kind, startedAt, endedAt,
 * harness, outcome }`, every key present, nothing else. Unknown kinds and
 * outcomes are kept as `turn` and `null` rather than refused: a record is
 * facts about a turn that already happened.
 */
export function turnRecord({ id = null, kind = 'turn', startedAt = null, endedAt = null, harness = null, outcome = null } = {}) {
  return { id: strip(id, 128), kind: TURN_KINDS.includes(kind) ? kind : 'turn', startedAt: text(startedAt), endedAt: text(endedAt),
    harness: strip(harness, 64), outcome: TURN_OUTCOMES.includes(outcome) ? outcome : null };
}

/** A revision record: `{ id, parent, reason, at }` from a revision journal entry. */
export function revisionRecord({ revision = null, parentRevision = null, reason = null, at = null } = {}) {
  return { id: text(revision), parent: text(parentRevision), reason: strip(reason, 500), at: text(at) };
}

/** Appends one turn line under `soulDir`; true when written. Throws on an unwritable mirror. */
export function appendSoulTurn(soulDir, record) {
  return appendLine(soulDir, TURNS_FILE, turnRecord(record));
}

/** Appends one revision line under `soulDir`; true when written. Throws on an unwritable mirror. */
export function appendSoulRevision(soulDir, record) {
  return appendLine(soulDir, REVISIONS_FILE, revisionRecord(record));
}

// One mirror file, bounded and never through a link: `{ total, lines,
// skipped, truncated }`. `total` counts every line of the file (null past
// the count bound or when unreadable; 0 when absent); `lines` are the
// non-empty lines of the read window, newest first. A file past the window
// yields its tail, the first partial line dropped and `truncated` set.
function readMirrorFile(file) {
  const empty = (total) => ({ total, lines: [], skipped: 0, truncated: false });
  let fd;
  try { fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
  catch (error) { return empty(error.code === 'ENOENT' ? 0 : null); }
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile()) return empty(null);
    const truncated = stat.size > HISTORY_READ_MAX_BYTES;
    const start = truncated ? stat.size - HISTORY_READ_MAX_BYTES : 0;
    const window = Buffer.alloc(stat.size - start);
    let filled = 0;
    while (filled < window.length) {
      const read = readSync(fd, window, filled, window.length - filled, start + filled);
      if (read === 0) break;
      filled += read;
    }
    let total = null;
    if (!truncated) {
      // Whole file in hand: count it there.
      total = 0;
      for (let i = 0; i < filled; i += 1) if (window[i] === 10) total += 1;
      if (filled > 0 && window[filled - 1] !== 10) total += 1;
    } else if (stat.size <= LINE_COUNT_MAX_BYTES) {
      // Scanned in chunks before the window, then the window itself.
      total = 0;
      const chunk = Buffer.alloc(64 * 1024);
      let position = 0;
      while (position < start) {
        const read = readSync(fd, chunk, 0, Math.min(chunk.length, start - position), position);
        if (read === 0) break;
        for (let i = 0; i < read; i += 1) if (chunk[i] === 10) total += 1;
        position += read;
      }
      for (let i = 0; i < filled; i += 1) if (window[i] === 10) total += 1;
      if (filled > 0 && window[filled - 1] !== 10) total += 1;
    }
    let text = window.toString('utf8', 0, filled);
    // The window starts mid-line more often than not: that fragment is not a record.
    if (truncated) text = text.slice(text.indexOf('\n') + 1);
    const lines = text.split('\n').filter((line) => line.trim()).reverse();
    return { total, lines, skipped: 0, truncated };
  } catch { return empty(null); }
  finally { closeSync(fd); }
}

// The records of one mirror file, newest first, each through `shape` so a
// listed record is exactly the documented one whatever the line holds;
// a line that is not a JSON object is skipped and counted.
function readMirrorRecords(file, limit, shape) {
  const { total, lines, truncated } = readMirrorFile(file);
  const records = [];
  let skipped = 0;
  for (const line of lines) {
    let parsed;
    try { parsed = JSON.parse(line); } catch { skipped += 1; continue; }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) { skipped += 1; continue; }
    if (records.length < limit) records.push(shape(parsed));
  }
  return { total, listed: records.length, limit, skipped, truncated, records };
}

/**
 * The mirror of `soulDir` as a read, newest first (#583 follow-up 9, the
 * host's Memory tab): `{ mirror, mirrored, turns, revisions }` with each
 * group `{ total, listed, limit, skipped, truncated, records[] }`. Facts
 * only, since the mirror holds nothing else; never a byte of any other
 * file. A soul without the directory is `mirrored: false` with empty
 * groups and null totals. `limit` is clamped to 1..HISTORY_LIMIT_MAX.
 */
export function readSoulHistory(soulDir, { limit = HISTORY_LIMIT_DEFAULT } = {}) {
  const size = Number.isSafeInteger(limit) && limit > 0 ? Math.min(limit, HISTORY_LIMIT_MAX) : HISTORY_LIMIT_DEFAULT;
  const dir = runsDirectory(soulDir);
  let mirrored = false;
  try { mirrored = lstatSync(dir).isDirectory(); } catch { mirrored = false; }
  const absent = { total: null, listed: 0, limit: size, skipped: 0, truncated: false, records: [] };
  return {
    mirror: dir,
    mirrored,
    turns: mirrored ? readMirrorRecords(path.join(dir, TURNS_FILE), size, (line) => turnRecord(line)) : { ...absent },
    // A mirror line is already `{ id, parent, reason, at }`; the shaper takes the journal's names.
    revisions: mirrored ? readMirrorRecords(path.join(dir, REVISIONS_FILE), size, (line) => revisionRecord({ revision: line.id, parentRevision: line.parent, reason: line.reason, at: line.at })) : { ...absent },
  };
}

// The registered folder of a soul, read-only, or null when the census does
// not know it or names no folder. Resolving must never provision.
export function registeredSoulDir(agentId, { file, env = process.env, home } = {}) {
  try {
    const soul = showSoul(agentId, { file: file ?? populationFile({ env, home }) });
    return typeof soul.soulDir === 'string' && path.isAbsolute(soul.soulDir) ? soul.soulDir : null;
  } catch { return null; }
}

/**
 * The daemon's mirror port: `{ turn(agentId, record), revision(agentId,
 * record) }`, each resolving the soul's folder through `soulDirFor` (the
 * census by default) and appending best-effort. A failure is one `log`
 * line naming the soul and the error code, never a throw.
 */
export function createSoulHistory({ soulDirFor = (agentId, options) => registeredSoulDir(agentId, options), log = () => {}, env = process.env, home, file } = {}) {
  const resolve = (agentId) => { try { return soulDirFor(agentId, { env, home, file }); } catch { return null; } };
  const write = (what, agentId, append) => {
    const soulDir = resolve(agentId);
    if (!soulDir) return false;
    try { return append(soulDir); }
    catch (error) { log(`history mirror: ${what} for ${agentId} not written (${error.code ?? error.message})`); return false; }
  };
  return {
    turn: (agentId, record) => write('turn', agentId, (soulDir) => appendSoulTurn(soulDir, record)),
    revision: (agentId, record) => write('revision', agentId, (soulDir) => appendSoulRevision(soulDir, record)),
  };
}
