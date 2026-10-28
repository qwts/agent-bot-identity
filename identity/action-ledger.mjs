// The action ledger for external effects the daemon asks the identity
// service for (Soul Agent Platform 0.4 §7, T06). Each operation is recorded
// durably before it is sent, so an outcome that went missing (a dropped
// connection, a timeout, an `outcome_unknown` answer) is reconciled by
// looking the operation up, never by sending it again blind.
//
// States: prepared -> submitted -> succeeded | rejected | unknown.
// A record holds identifiers and states only, never a credential.

import { mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync, chmodSync } from 'node:fs';
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

/** Writes the record atomically (0600 in a 0700 directory) and returns it. */
export function writeAction(stateDir, record) {
  if (!ACTION_STATES.includes(record.state)) throw new Error(`unknown action state ${record.state}`);
  const file = fileFor(stateDir, record.operation_id);
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
