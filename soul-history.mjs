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
import { closeSync, existsSync, fchmodSync, mkdirSync, openSync, writeSync } from 'node:fs';
import path from 'node:path';
import { populationFile, showSoul } from './agent-population.mjs';

export const RUNS_DIRECTORY = '.soul-state/runs';
export const TURNS_FILE = 'turns.jsonl';
export const REVISIONS_FILE = 'revisions.jsonl';
export const TURN_KINDS = Object.freeze(['turn', 'wake', 'task', 'launch', 'session']);
export const TURN_OUTCOMES = Object.freeze(['ok', 'failed', 'cancelled']);
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
