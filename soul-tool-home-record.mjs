// A soul's tool-homes record (#617): `.soul-state/tool-homes.json`, one
// entry per harness saying whether its config, sign-in and sessions live in
// the soul's own tool home (`soul`) or in the host's global install and
// store (`global`). The shape and the decision it feeds are pure, in
// soul-tool-homes.mjs; this module only reads and writes the file.
//
// A soul born managed is stamped once, when its `.soul-state` is created
// (spawn, fork, a package launch), so a soul that existed before keeps no
// record and its current setup. Nothing here moves or copies harness state.
import { closeSync, constants, fstatSync, linkSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { TOOL_HOME_CHOICES, TOOL_HOMES_SCHEMA_VERSION, newSoulToolHomeRecord, normalizeToolHomeRecord, toolHomeFor } from './soul-tool-homes.mjs';

export const TOOL_HOME_RECORD = 'tool-homes.json';
const RECORD_MAX_BYTES = 16 * 1024;

export const toolHomeRecordPath = (soulDir) => path.join(soulDir, '.soul-state', TOOL_HOME_RECORD);

const invalid = (why) => Object.assign(new Error(`the soul's tool-homes record is invalid: ${why}; fix or remove .soul-state/${TOOL_HOME_RECORD}`), { code: 'tool-home-record-invalid' });

/**
 * The soul's record, checked, or null when it has none (a soul that
 * existed before #617). Read without following a link and bounded; a
 * record that is there but unusable is `tool-home-record-invalid`, never
 * read as absent.
 */
export function readToolHomeRecord(soulDir) {
  let fd;
  try { fd = openSync(toolHomeRecordPath(soulDir), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
  catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return null;
    throw invalid(error.code === 'ELOOP' ? 'it is a link' : `it cannot be opened (${error.code ?? error.message})`);
  }
  let raw;
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile()) throw invalid('not a regular file');
    if (stat.size > RECORD_MAX_BYTES) throw invalid(`larger than ${RECORD_MAX_BYTES} bytes`);
    raw = readFileSync(fd, 'utf8');
  } finally { closeSync(fd); }
  let value;
  try { value = JSON.parse(raw); } catch { throw invalid('not JSON'); }
  return normalizeToolHomeRecord(value);
}

/** The recorded choice for one harness, `soul | global`, or null when none is recorded. */
export function toolHomeChoice(soulDir, harness) {
  return readToolHomeRecord(soulDir)?.harnesses[harness] ?? null;
}

const serialize = (record) => `${JSON.stringify(normalizeToolHomeRecord(record), null, 2)}\n`;

/**
 * Records one harness's choice (`soul | global`), or clears it with null,
 * replacing the file atomically with a private mode. Clearing the last
 * entry of a soul that had no record before leaves an empty record, which
 * decides nothing. Returns the record written. Not locked: the only
 * writers today are a soul's birth (write-once, `stampNewSoulToolHomes`)
 * and this function, which no command calls yet; the owner command that
 * will must serialize its writes.
 */
export function setToolHomeChoice(soulDir, harness, choice) {
  const row = toolHomeFor(harness);
  if (!row.routable) throw Object.assign(new Error(`${row.harness} has no tool home to choose: ${row.reason}`), { code: 'tool-home-unsupported' });
  if (choice !== null && !TOOL_HOME_CHOICES.includes(choice)) throw Object.assign(new Error(`choice must be one of ${TOOL_HOME_CHOICES.join(', ')}, or null to clear it`), { code: 'tool-home-record-invalid' });
  const current = readToolHomeRecord(soulDir) ?? { schemaVersion: TOOL_HOMES_SCHEMA_VERSION, harnesses: {} };
  const harnesses = { ...current.harnesses };
  if (choice === null) delete harnesses[row.harness];
  else harnesses[row.harness] = choice;
  const record = { schemaVersion: TOOL_HOMES_SCHEMA_VERSION, harnesses };
  const file = toolHomeRecordPath(soulDir);
  const pending = `${file}.${process.pid}.${randomUUID()}`;
  writeFileSync(pending, serialize(record), { flag: 'wx', mode: 0o600 });
  try { renameSync(pending, file); } catch (error) { rmSync(pending, { force: true }); throw error; }
  return normalizeToolHomeRecord(record);
}

/**
 * Stamps a soul born managed with the default record (its own tool home
 * for each default harness), once: an existing record, even one a later
 * choice changed, is never replaced. Returns true when this call wrote it.
 */
export function stampNewSoulToolHomes(soulDir) {
  const file = toolHomeRecordPath(soulDir);
  const pending = `${file}.${process.pid}.${randomUUID()}`;
  writeFileSync(pending, serialize(newSoulToolHomeRecord()), { flag: 'wx', mode: 0o600 });
  try { linkSync(pending, file); return true; }
  catch (error) { if (error.code === 'EEXIST') return false; throw error; }
  finally { rmSync(pending, { force: true }); }
}
