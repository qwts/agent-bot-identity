// The soul's migration journal, `.soul-state/migration.json` (#583):
// one record per step id, written whole and privately through a rename.
// `soul env migrate` records here and `soul env` reads it; a step that
// runs in phases (the Agent Space move, decision 8) keeps its phase here
// so a crash resumes where it stopped. Shared by soul-env-migrate.mjs and
// soul-memory.mjs so neither imports the other.
import { closeSync, constants, fstatSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

export const MIGRATION_SCHEMA_VERSION = 1;
export const MIGRATION_JOURNAL = '.soul-state/migration.json';
// `copying`, `verifying` and `switching` are the phases of a step still
// under way; the descriptor counts them as pending.
export const STEP_STATUSES = Object.freeze(['pending', 'copying', 'verifying', 'switching', 'done', 'skipped', 'failed']);
export const STEP_FINAL_STATUSES = Object.freeze(['done', 'skipped', 'failed']);
const JOURNAL_MAX_BYTES = 256 * 1024;
const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const text = (value) => (typeof value === 'string' && value.trim() ? value : null);

const journalFile = (soulDir) => path.join(soulDir, MIGRATION_JOURNAL);

function readJournal(soulDir) {
  let fd;
  try { fd = openSync(journalFile(soulDir), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
  catch { return { schemaVersion: MIGRATION_SCHEMA_VERSION, steps: [] }; }
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > JOURNAL_MAX_BYTES) return { schemaVersion: MIGRATION_SCHEMA_VERSION, steps: [] };
    const parsed = JSON.parse(readFileSync(fd, 'utf8'));
    return object(parsed) && Array.isArray(parsed.steps) ? parsed : { schemaVersion: MIGRATION_SCHEMA_VERSION, steps: [] };
  } catch { return { schemaVersion: MIGRATION_SCHEMA_VERSION, steps: [] }; }
  finally { closeSync(fd); }
}

/**
 * The recorded steps of `.soul-state/migration.json`, each reduced to the
 * keys the descriptor publishes: `{ id, status, from, to, at, note }`. A
 * missing or malformed journal is an empty list.
 */
export function readMigrationJournal(soulDir) {
  return readJournal(soulDir).steps
    .filter((step) => object(step) && typeof step.id === 'string' && STEP_STATUSES.includes(step.status))
    .map((step) => ({ id: step.id, status: step.status, from: text(step.from), to: text(step.to), at: text(step.at), note: text(step.note) }));
}

/** One step's full record (every field it was recorded with), or null. */
export function readMigrationStep(soulDir, id) {
  return readJournal(soulDir).steps.find((step) => object(step) && step.id === id && STEP_STATUSES.includes(step.status)) ?? null;
}

/**
 * Records one step: a rerun replaces its record rather than growing the
 * journal. Written whole, privately, through a rename.
 */
export function recordMigrationStep(soulDir, step) {
  const journal = readJournal(soulDir);
  journal.schemaVersion = MIGRATION_SCHEMA_VERSION;
  journal.steps = [...journal.steps.filter((entry) => !object(entry) || entry.id !== step.id), step];
  const file = journalFile(soulDir);
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
  try { writeFileSync(temporary, `${JSON.stringify(journal)}\n`, { flag: 'wx', mode: 0o600 }); renameSync(temporary, file); }
  finally { rmSync(temporary, { force: true }); }
  return step;
}
