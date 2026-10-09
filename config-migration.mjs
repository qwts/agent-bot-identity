// One-time carry-over of add-on behavior for a config written before the
// feature gates existed (#361).
//
// Before 0.9 there were no gates: GitHub App identity and persona accounts
// were simply on. A config from then has no `features` object, so after an
// upgrade both read as off, and a machine whose souls already carry GitHub
// App identities silently loses them (the gh shim passes through, tokens are
// refused, commits go unsigned). When a config has no `features` object and
// at least one identity record already carries a `github` field, that
// install was running with both add-ons on; this records that once.
//
// Any `features` object, even an empty one, is a choice and is never
// touched, and an install with no App-bearing identity (every install made
// since 0.9) is left at the defaults.

import process from 'node:process';
import { closeSync, fchmodSync, fsyncSync, openSync, readdirSync, readFileSync, renameSync, statSync, writeSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { FEATURE_GATES } from './config.mjs';
import { stateDirectory } from './state-paths.mjs';

export const PRE_GATE_FEATURES = Object.freeze(Object.fromEntries(FEATURE_GATES.map((name) => [name, true])));

function configPath({ env, home }) {
  return env.AGENT_BOT_CONFIG ?? join(home, '.config', 'agent-bot', 'config.json');
}

function hasAppIdentity(dir) {
  let names;
  try {
    names = readdirSync(dir);
  } catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
  return names.filter((name) => name.endsWith('.json')).some((name) => {
    try {
      const record = JSON.parse(readFileSync(join(dir, name), 'utf8'));
      return record?.github != null && typeof record.github === 'object';
    } catch {
      return false; // an unreadable record is someone else's problem, not evidence
    }
  });
}

/**
 * Whether this config predates the gates while its souls use GitHub Apps.
 * Read-only: `{ needed, reason, path }`.
 */
export function preGateConfigStatus({ env = process.env, home = homedir() } = {}) {
  const path = configPath({ env, home });
  let raw;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') return { needed: false, reason: 'no-config', path };
    throw error;
  }
  let config;
  try {
    config = JSON.parse(raw.replace(/^﻿/, ''));
  } catch {
    return { needed: false, reason: 'invalid-config', path };
  }
  if (!config || typeof config !== 'object' || Array.isArray(config)) return { needed: false, reason: 'invalid-config', path };
  if (Object.hasOwn(config, 'features')) return { needed: false, reason: 'has-features', path };
  if (!hasAppIdentity(stateDirectory({ env, home }))) return { needed: false, reason: 'no-app-identities', path };
  return { needed: true, reason: 'pre-gate-config', path, config };
}

/**
 * Records `features` with both add-ons on when `preGateConfigStatus` says the
 * config predates the gates. Writes atomically and keeps the file's mode.
 * Returns `{ migrated, reason, path }`.
 */
export function migratePreGateConfig({ env = process.env, home = homedir() } = {}) {
  const status = preGateConfigStatus({ env, home });
  if (!status.needed) return { migrated: false, reason: status.reason, path: status.path };
  const { path, config } = status;
  const mode = statSync(path).mode & 0o777;
  const next = { ...config, features: { ...PRE_GATE_FEATURES } };
  const tmp = join(dirname(path), `.config.json.${process.pid}.tmp`);
  const fd = openSync(tmp, 'w', mode);
  try {
    fchmodSync(fd, mode);
    writeSync(fd, `${JSON.stringify(next, null, 2)}\n`);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, path);
  return { migrated: true, reason: 'pre-gate-config', path, features: next.features };
}
