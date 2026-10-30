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
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

export function actionsDir(stateDir) {
  return path.join(stateDir, 'actions');
}

function fileFor(stateDir, operationId) {
  if (!ID.test(operationId)) throw new Error('operation_id must be 1-128 characters of [A-Za-z0-9._:-]');
  return path.join(actionsDir(stateDir), `${operationId}.json`);
}

export function readAction(stateDir, operationId) {
  try { return JSON.parse(readFileSync(fileFor(stateDir, operationId), 'utf8')); } catch { return null; }
}

// Terminal states settle an operation for good; nothing moves past them.
const TERMINAL = new Set(['succeeded', 'rejected']);

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
  return next;
}

export function transition(stateDir, operationId, state, fields = {}) {
  const current = readAction(stateDir, operationId);
  if (!current) throw new Error(`no action recorded for ${operationId}`);
  return writeAction(stateDir, { ...current, ...fields, state });
}

/** Every recorded action, oldest first; `state` filters. */
export function listActions(stateDir, { state = null } = {}) {
  let names = [];
  try { names = readdirSync(actionsDir(stateDir)).filter((name) => name.endsWith('.json')); } catch { return []; }
  return names.map((name) => readAction(stateDir, name.slice(0, -5))).filter(Boolean)
    .filter((record) => state === null || record.state === state)
    .sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)));
}
