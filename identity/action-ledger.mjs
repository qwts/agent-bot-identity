// The action ledger for external effects the daemon asks the identity
// service for (Soul Agent Platform 0.4 §7, T06). Each operation is recorded
// durably before it is sent, so an outcome that went missing (a dropped
// connection, a timeout, an `outcome_unknown` answer) is reconciled by
// looking the operation up, never by sending it again blind.
//
// States: prepared -> submitted -> succeeded | rejected | unknown.
// A record holds identifiers and states only, never a credential.

import { mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync, chmodSync } from 'node:fs';
import { REDACTION_PATTERNS } from './redaction-patterns.mjs';
import path from 'node:path';

export const ACTION_STATES = Object.freeze(['prepared', 'submitted', 'succeeded', 'rejected', 'unknown']);
export const MAX_SETTLED_ACTIONS = 200;
const COMPACT_TRIGGER = 250;
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

export function actionsDir(stateDir) {
  return path.join(stateDir, 'actions');
}

export function actionsArchiveDir(stateDir) {
  return path.join(stateDir, 'actions-archive');
}

function fileFor(stateDir, operationId) {
  if (!ID.test(operationId)) throw new Error('operation_id must be 1-128 characters of [A-Za-z0-9._:-]');
  return path.join(actionsDir(stateDir), `${operationId}.json`);
}

function archiveFileFor(stateDir, operationId) {
  if (!ID.test(operationId)) throw new Error('operation_id must be 1-128 characters of [A-Za-z0-9._:-]');
  return path.join(actionsArchiveDir(stateDir), `${operationId}.json`);
}

function readJsonFile(file) {
  try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return null; }
}

export function readAction(stateDir, operationId) {
  try {
    return readJsonFile(fileFor(stateDir, operationId)) ?? readJsonFile(archiveFileFor(stateDir, operationId));
  } catch {
    return null;
  }
}

// Terminal states settle an operation for good; nothing moves past them.
const TERMINAL = new Set(['succeeded', 'rejected']);
const COMPACT_INTERVAL = 50;

function compareCreatedAt(a, b) {
  const left = String(a?.created_at ?? '');
  const right = String(b?.created_at ?? '');
  return left < right ? -1 : left > right ? 1 : 0;
}

const writesSinceCompact = new Map();
const uncompactableFloor = new Map();

/**
 * Compacts settled (`succeeded` / `rejected`) records in `actionsDir(stateDir)`
 * into `actionsArchiveDir(stateDir)` once the active directory exceeds
 * `COMPACT_TRIGGER`, retaining:
 *   - all non-terminal (`prepared`, `submitted`, `unknown`) records,
 *   - the latest record per `harness` (so `last_mint_outcomes` is unchanged),
 *   - the most recent `MAX_SETTLED_ACTIONS` terminal records.
 * Archived records remain readable via `readAction(stateDir, operationId)`.
 */
export function compactActions(stateDir) {
  try {
    const dir = actionsDir(stateDir);
    let names = [];
    try { names = readdirSync(dir).filter((name) => name.endsWith('.json')); } catch { return 0; }
    if (names.length <= COMPACT_TRIGGER) {
      uncompactableFloor.delete(stateDir);
      return 0;
    }
    const floor = uncompactableFloor.get(stateDir) ?? COMPACT_TRIGGER;
    if (names.length <= floor) return 0;
    const records = names
      .map((name) => {
        const opId = name.slice(0, -5);
        const data = ID.test(opId) ? readJsonFile(path.join(dir, name)) : null;
        return data && typeof data === 'object' && !Array.isArray(data) ? { name, opId, data } : null;
      })
      .filter(Boolean)
      .sort((a, b) => compareCreatedAt(a.data, b.data));

    const keep = new Set();
    const latestByHarness = new Map();
    const terminal = [];
    for (const entry of records) {
      if (typeof entry.data.harness === 'string' && entry.data.harness) {
        latestByHarness.set(entry.data.harness, entry.name);
      }
      if (!TERMINAL.has(entry.data.state)) {
        keep.add(entry.name);
      } else {
        terminal.push(entry);
      }
    }
    for (const name of latestByHarness.values()) keep.add(name);
    for (const entry of terminal.slice(-MAX_SETTLED_ACTIONS)) keep.add(entry.name);

    const archiveDir = actionsArchiveDir(stateDir);
    let moved = 0;
    let archiveCreated = false;
    for (const entry of terminal) {
      if (keep.has(entry.name)) continue;
      try {
        if (!archiveCreated) {
          mkdirSync(archiveDir, { recursive: true, mode: 0o700 });
          try { chmodSync(archiveDir, 0o700); } catch { /* windows */ }
          archiveCreated = true;
        }
        renameSync(path.join(dir, entry.name), path.join(archiveDir, entry.name));
        moved += 1;
      } catch { /* best-effort compaction */ }
    }
    const remaining = names.length - moved;
    if (remaining > COMPACT_TRIGGER) {
      uncompactableFloor.set(stateDir, remaining + COMPACT_INTERVAL);
    } else {
      uncompactableFloor.delete(stateDir);
    }
    return moved;
  } catch {
    return 0;
  }
}

// A record holds identifiers and states only — an allowlist, never a
// denylist: the fields every caller writes, no more, and scalar values only.
const LEDGER_FIELDS = new Set([
  'operation_id', 'task_id', 'kind', 'harness', 'repo', 'session_id',
  'state', 'reason', 'issuance_id', 'replayed', 'reconciled',
  'created_at', 'updated_at',
]);
// And a credential-shaped value is refused under an innocent key too —
// the shared redaction registry decides what counts as a credential shape.
// Compiled on the first write: a record is refused rather than written when
// the registry cannot be read (fail closed), and commands that never touch
// the ledger never pay for it.
let secretPatterns = null;
function ledgerSecretPatterns() {
  if (secretPatterns === null) {
    try { secretPatterns = REDACTION_PATTERNS.map((pattern) => new RegExp(pattern.regex)); }
    catch { secretPatterns = false; }
  }
  if (secretPatterns === false) throw new Error('the credential-shape registry could not be read; refusing the write');
  return secretPatterns;
}

/** Writes the record atomically (0600 in a 0700 directory) and returns it. */
export function writeAction(stateDir, record) {
  if (!ACTION_STATES.includes(record.state)) throw new Error(`unknown action state ${record.state}`);
  for (const [field, value] of Object.entries(record)) {
    if (!LEDGER_FIELDS.has(field)) throw new Error(`a ledger record carries only identifiers and states (field ${field})`);
    if (value !== null && !['string', 'number', 'boolean'].includes(typeof value)) {
      throw new Error(`a ledger field holds scalars only (field ${field})`);
    }
    if (typeof value === 'string' && ledgerSecretPatterns().some((regex) => regex.test(value))) {
      throw new Error(`a ledger field holds a credential-shaped value (field ${field})`);
    }
  }
  const file = fileFor(stateDir, record.operation_id);
  const current = readAction(stateDir, record.operation_id);
  if (current && TERMINAL.has(current.state) && record.state !== current.state) {
    throw new Error(`a ${current.state} operation cannot become ${record.state}`);
  }
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  try { chmodSync(path.dirname(file), 0o700); } catch { /* windows */ }
  const next = { ...record, updated_at: new Date().toISOString() };
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, file);
  if (TERMINAL.has(next.state)) {
    if (current && !TERMINAL.has(current.state) && uncompactableFloor.has(stateDir)) {
      uncompactableFloor.set(stateDir, Math.max(COMPACT_TRIGGER, uncompactableFloor.get(stateDir) - 1));
    }
    const count = (writesSinceCompact.get(stateDir) ?? COMPACT_INTERVAL) + 1;
    if (count >= COMPACT_INTERVAL) {
      writesSinceCompact.set(stateDir, 0);
      compactActions(stateDir);
    } else {
      writesSinceCompact.set(stateDir, count);
    }
  }
  return next;
}

export function transition(stateDir, operationId, state, fields = {}) {
  const current = readAction(stateDir, operationId);
  if (!current) throw new Error(`no action recorded for ${operationId}`);
  return writeAction(stateDir, { ...current, ...fields, state });
}

/** Every recorded active action, oldest first; `state` filters. */
export function listActions(stateDir, { state = null } = {}) {
  const dir = actionsDir(stateDir);
  let names = [];
  try { names = readdirSync(dir).filter((name) => name.endsWith('.json')); } catch { return []; }
  const trigger = Math.max(COMPACT_TRIGGER, uncompactableFloor.get(stateDir) ?? 0);
  if (names.length > trigger && compactActions(stateDir) > 0) {
    try { names = readdirSync(dir).filter((name) => name.endsWith('.json')); } catch { return []; }
  }
  return names
    .map((name) => {
      const opId = name.slice(0, -5);
      return ID.test(opId) ? readJsonFile(path.join(dir, opId + '.json')) : null;
    })
    .filter(Boolean)
    .filter((record) => state === null || record.state === state)
    .sort(compareCreatedAt);
}
