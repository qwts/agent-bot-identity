// Session records are authority state (ADR-1257: a soul outlives its
// sessions). They live in the identity registry's stateDir — never under the
// soul dir — one `<session_id>.json` per record, with a uniqueness index by
// transcript so a provider conversation can belong to exactly one soul.

import { createHash, randomUUID } from 'node:crypto';
import {
  chmodSync, linkSync, mkdirSync, readFileSync, readdirSync,
  renameSync, rmSync, writeFileSync,
} from 'node:fs';
import path from 'node:path';
import process from 'node:process';

import { withLock } from '../file-lock.mjs';
import { stateDirectory } from '../state-paths.mjs';
import { validateAgentId } from './identity-format.mjs';

const SESSION_ID = /^ses_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function ensureSessionsDirectory(root) {
  mkdirSync(root, { recursive: true, mode: 0o700 });
  try {
    chmodSync(root, 0o700);
  } catch {
    /* another platform may not expose POSIX modes */
  }
}

function sessionsDir(stateDir) {
  return path.join(stateDir, 'sessions');
}

function indexDir(stateDir) {
  return path.join(sessionsDir(stateDir), 'by-transcript');
}

function sessionPath(stateDir, id) {
  if (typeof id !== 'string' || !SESSION_ID.test(id)) throw new Error('invalid session id');
  return path.join(sessionsDir(stateDir), `${id}.json`);
}

function transcriptKey(transcript) {
  return createHash('sha256')
    .update(`${transcript.provider}\n${transcript.id}`)
    .digest('hex');
}

function indexPath(stateDir, transcript) {
  return path.join(indexDir(stateDir), transcriptKey(transcript));
}

function normalizeSessionTranscript(transcript) {
  if (!transcript || typeof transcript !== 'object' || Array.isArray(transcript)
    || typeof transcript.id !== 'string' || transcript.id === '') {
    throw new Error('a session needs a transcript locator ({provider, id})');
  }
  const provider = typeof transcript.provider === 'string' && transcript.provider !== '' ? transcript.provider : 'custom';
  return { provider, id: transcript.id };
}

function writeAtomic(file, value) {
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: 'utf8',
    flag: 'wx',
    mode: 0o600,
  });
  renameSync(temporary, file);
}

function readSessionFile(stateDir, id) {
  const record = JSON.parse(readFileSync(sessionPath(stateDir, id), 'utf8'));
  if (record.session_id !== id) throw new Error(`session record ${id} is inconsistent`);
  return record;
}

function transcriptBoundError(soulId) {
  return Object.assign(
    new Error(`this transcript is already a session of soul ${soulId}; a conversation belongs to one soul (ADR-1257)`),
    { statusCode: 409, code: 'transcript-bound-elsewhere' },
  );
}

/**
 * Opens (or refreshes) the session that binds a provider conversation to a
 * soul. Idempotent for the same soul; refuses when the transcript is already
 * a session of another soul. Nothing else mints.
 */
export function openSession({
  soulId,
  transcript,
  harness,
  appSlug = null,
  deviceId = null,
  stateDir = stateDirectory(),
  now = () => new Date(),
} = {}) {
  const soul = validateAgentId(soulId);
  const locator = normalizeSessionTranscript(transcript);
  const root = sessionsDir(stateDir);
  const indexRoot = indexDir(stateDir);
  const indexFile = indexPath(stateDir, locator);
  ensureSessionsDirectory(stateDir);
  return withLock(path.join(stateDir, '.allocation.lock'), 'session allocation', () => {
    let existingId = null;
    try {
      existingId = readFileSync(indexFile, 'utf8').trim();
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    if (existingId !== null) {
      let existing;
      try {
        existing = readSessionFile(stateDir, existingId);
      } catch {
        // A stale index entry must not brick future sessions: drop it and
        // fall through to create.
        rmSync(indexFile, { force: true });
        existing = null;
      }
      if (existing) {
        if (existing.soul_id !== soul) throw transcriptBoundError(existing.soul_id);
        existing.last_seen = now().toISOString();
        writeAtomic(sessionPath(stateDir, existing.session_id), existing);
        return existing;
      }
    }
    const record = {
      session_id: `ses_${randomUUID()}`,
      soul_id: soul,
      transcript: locator,
      harness,
      app_slug: appSlug,
      app_profile: null,
      device_id: deviceId,
      status: 'live',
      started_at: now().toISOString(),
      last_seen: now().toISOString(),
      ended_at: null,
    };
    ensureSessionsDirectory(indexRoot);
    const target = sessionPath(stateDir, record.session_id);
    const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
    writeFileSync(temporary, `${JSON.stringify(record, null, 2)}\n`, {
      encoding: 'utf8',
      flag: 'wx',
      mode: 0o600,
    });
    // The index entry is the uniqueness claim: an exclusive link, so EEXIST
    // (a concurrent open for the same transcript) resolves to the winner.
    const indexTemporary = `${indexFile}.${process.pid}.${randomUUID()}.tmp`;
    writeFileSync(indexTemporary, `${record.session_id}\n`, {
      encoding: 'utf8',
      flag: 'wx',
      mode: 0o600,
    });
    try {
      linkSync(indexTemporary, indexFile);
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const winner = readFileSync(indexFile, 'utf8').trim();
      rmSync(temporary, { force: true });
      const existing = readSessionFile(stateDir, winner);
      if (existing.soul_id !== soul) throw transcriptBoundError(existing.soul_id);
      existing.last_seen = now().toISOString();
      writeAtomic(sessionPath(stateDir, existing.session_id), existing);
      return existing;
    } finally {
      rmSync(indexTemporary, { force: true });
    }
    linkSync(temporary, target);
    rmSync(temporary, { force: true });
    return record;
  });
}


/**
 * The live session a transcript already belongs to, or null. Used to refuse
 * a cross-soul bind before its single-use token is spent; openSession remains
 * the enforcing check after consumption.
 */
export function findSessionByTranscript(transcript, { stateDir = stateDirectory() } = {}) {
  let locator;
  try {
    locator = normalizeSessionTranscript(transcript);
  } catch {
    return null;
  }
  let existingId = null;
  try {
    existingId = readFileSync(indexPath(stateDir, locator), 'utf8').trim();
  } catch {
    return null;
  }
  try {
    return readSessionFile(stateDir, existingId);
  } catch {
    return null;
  }
}

export function readSession(id, { stateDir = stateDirectory() } = {}) {
  try {
    return readSessionFile(stateDir, id);
  } catch (error) {
    throw new Error(`could not read session ${id}: ${error.message}`);
  }
}

export function listSessions(soulId, { stateDir = stateDirectory() } = {}) {
  const root = sessionsDir(stateDir);
  let names;
  try {
    names = readdirSync(root);
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
  const records = [];
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    const id = name.slice(0, -5);
    if (!SESSION_ID.test(id)) continue;
    try {
      const record = readSessionFile(stateDir, id);
      if (record.soul_id === soulId) records.push(record);
    } catch {
      // A crash artifact or partial write is audit data, not a gate.
      console.warn(`agent-sessions: ignoring unreadable session record ${id}`);
    }
  }
  return records;
}

export function endSession(id, {
  stateDir = stateDirectory(),
  now = () => new Date(),
} = {}) {
  const record = readSession(id, { stateDir });
  if (record.status === 'ended') return record;
  record.status = 'ended';
  record.ended_at = now().toISOString();
  record.last_seen = record.ended_at;
  writeAtomic(sessionPath(stateDir, record.session_id), record);
  return record;
}
