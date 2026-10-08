// A soul's memory, its Agent Space, as the census records it (#583 slice 5,
// ADR-0583 decision 8): where it is, and the one-soul-at-a-time move of a
// linked space under ~/.agent-space into `<soul>/.soul-state/space`.
//
// The move is journaled in `.soul-state/migration.json` as the
// `space-into-soul` step and resumable: copy into a staging directory
// beside the link, verify every path, size and digest against the source,
// switch the link for the directory, point the census at it, and only then
// retire the source by renaming it (never deleting; `soul env clean` in
// slice 6 deletes). A crash leaves either a verifiable staging to reuse or
// a partial one to drop and copy again; the link stays until the switch.
import { createHash, randomUUID } from 'node:crypto';
import { closeSync, constants, copyFileSync, chmodSync, fstatSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, readlinkSync, renameSync, rmSync, symlinkSync, utimesSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { validateAgentId, withLock } from './agent-identity.mjs';
import { populationFile, setSoulSpacePath, showSoul } from './agent-population.mjs';
import { initAgentSpace, inspectAgentSpace, showAgentSpace, spacePath } from './agent-space.mjs';
import { readMigrationStep, recordMigrationStep } from './soul-migration-journal.mjs';

export const SPACE_STEP_ID = 'space-into-soul';
export const SPACE_MIGRATION_PHASES = Object.freeze(['pending', 'copying', 'verifying', 'switching', 'done']);
const STATE = '.soul-state';
const DIGEST_CHUNK = 64 * 1024;

function fail(code, message, { action = null } = {}) {
  throw Object.assign(new Error(message), { code, action });
}

function lstat(file) {
  try { return lstatSync(file); }
  catch (error) { if (error.code === 'ENOENT' || error.code === 'ENOTDIR' || error.code === 'EACCES') return null; throw error; }
}

function inside(root, candidate) {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

/** The migrate command that contains a linked space, for readiness actions and docs. */
export const spaceMigrateCommand = (id) => `agent-bot soul env migrate ${id} --space-into-soul`;

/**
 * Where a soul's Agent Space is: the census `spacePath` when the census
 * knows the soul (authoritative, decision 8), else the spaces root path
 * `initAgentSpace` would use. Never creates anything.
 */
export function soulSpacePath(agentId, { env = process.env, home = env.HOME ?? homedir(), ...rest } = {}) {
  const id = validateAgentId(agentId);
  const file = rest.file ?? populationFile({ env, home });
  try {
    const recorded = showSoul(id, { file }).spacePath;
    if (typeof recorded === 'string' && path.isAbsolute(recorded)) return recorded;
  } catch { /* unknown to the census: the default root */ }
  return spacePath(id, { env, home, ...rest });
}

/**
 * The soul's Agent Space, made only when the census has none: the census
 * path when it carries the soul's marker (inside the soul or under the
 * spaces root alike, `created: false`); `initAgentSpace` under the spaces
 * root when nothing is at the census path yet. Something else there (a
 * file, an unmarked directory, another soul's space) is refused rather
 * than replaced or quietly abandoned for a new root space. Every "ensure"
 * (the daemon's route, setup-worktree and join in process) goes through
 * here, so a contained soul is never handed, and re-registered to, an
 * empty space under the root.
 */
export function ensureSoulSpace(agentId, options = {}) {
  const id = validateAgentId(agentId);
  const recorded = soulSpacePath(id, options);
  const inspection = inspectAgentSpace(id, { ...options, root: recorded });
  if (inspection.status === 'ok') return { id, path: recorded, created: false, marker: showAgentSpace(id, { ...options, root: recorded }).marker };
  if (inspection.status !== 'missing' || lstat(recorded)) {
    throw new Error(`agent space path ${recorded} is not ${id}'s Agent Space (${inspection.status}); refusing to replace it`);
  }
  return initAgentSpace(id, options);
}

/** `inspectAgentSpace` at the census path: `{ status, id, path, ... }`, never through `~/.agent-space` alone. */
export function inspectSoulSpace(agentId, options = {}) {
  return inspectAgentSpace(agentId, { ...options, root: soulSpacePath(agentId, options) });
}

// A digest of one regular file, read in chunks without following links.
function digest(file) {
  const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile()) throw Object.assign(new Error('not a regular file'), { code: 'EISDIR' });
    const hash = createHash('sha256');
    hash.update(readFileSync(fd));
    return { size: stat.size, sha256: hash.digest('hex') };
  } finally { closeSync(fd); }
}

// Every entry under `root` by relative path, by lstat kind, sorted. Special
// files (sockets, fifos, devices) are listed as `other` and never copied.
function walk(root) {
  const entries = new Map();
  const visit = (dir, prefix) => {
    for (const name of readdirSync(dir).sort()) {
      const file = path.join(dir, name);
      const relative = prefix ? `${prefix}/${name}` : name;
      const stat = lstatSync(file);
      const kind = stat.isSymbolicLink() ? 'link' : stat.isDirectory() ? 'dir' : stat.isFile() ? 'file' : 'other';
      entries.set(relative, { kind, stat, file });
      if (kind === 'dir') visit(file, relative);
    }
  };
  visit(root, '');
  return entries;
}

/**
 * Copies a space tree into `dest` (which must not exist): regular files
 * byte for byte with their modes and mtimes, directories with theirs,
 * symlinks as symlinks (listed in `links`, never followed), anything else
 * skipped and listed. Returns `{ files, bytes, links[], skipped[] }`.
 */
export function copySpaceTree(source, dest) {
  const entries = walk(source);
  const result = { files: 0, bytes: 0, links: [], skipped: [] };
  const sourceStat = lstatSync(source);
  mkdirSync(dest, { mode: 0o700 });
  const directories = [[dest, sourceStat]];
  for (const [relative, entry] of entries) {
    const target = path.join(dest, relative);
    if (entry.kind === 'dir') {
      mkdirSync(target, { mode: 0o700 });
      directories.push([target, entry.stat]);
    } else if (entry.kind === 'file') {
      copyFileSync(entry.file, target, constants.COPYFILE_EXCL);
      chmodSync(target, entry.stat.mode & 0o7777);
      utimesSync(target, entry.stat.atime, entry.stat.mtime);
      result.files += 1;
      result.bytes += entry.stat.size;
    } else if (entry.kind === 'link') {
      symlinkSync(readlinkSync(entry.file), target);
      result.links.push(relative);
    } else result.skipped.push(relative);
  }
  // Directory modes and times last, after their contents are in place.
  for (const [dir, stat] of directories.reverse()) {
    chmodSync(dir, (stat.mode & 0o7777) | 0o700);
    utimesSync(dir, stat.atime, stat.mtime);
  }
  return result;
}

/**
 * Walks both trees: the same relative paths of the same kinds, every
 * regular file with the same size and SHA-256, every symlink with the same
 * target. `{ ok: true, files, links[] }` or `{ ok: false, reason }`; the
 * reason names a path, never contents.
 */
export function verifySpaceTree(source, copy) {
  const left = walk(source), right = walk(copy);
  const expected = [...left].filter(([, entry]) => entry.kind !== 'other');
  const found = [...right].filter(([, entry]) => entry.kind !== 'other');
  if (expected.length !== found.length) return { ok: false, reason: `the copy has ${found.length} entries, the source ${expected.length}` };
  let files = 0;
  const links = [];
  for (const [relative, entry] of expected) {
    const other = right.get(relative);
    if (!other || other.kind !== entry.kind) return { ok: false, reason: `${relative} is ${other ? other.kind : 'missing'} in the copy, ${entry.kind} in the source` };
    if (entry.kind === 'file') {
      const a = digest(entry.file), b = digest(other.file);
      if (a.size !== b.size || a.sha256 !== b.sha256) return { ok: false, reason: `${relative} differs between the source and the copy` };
      files += 1;
    } else if (entry.kind === 'link') {
      if (readlinkSync(entry.file) !== readlinkSync(other.file)) return { ok: false, reason: `${relative} links elsewhere in the copy` };
      links.push(relative);
    }
  }
  return { ok: true, files, links };
}

const stamp = (date) => date.toISOString().slice(0, 10);

/**
 * Moves one soul's Agent Space into its folder: `{ id: 'space-into-soul',
 * status, from, to, at, note, source, staging, aside, retired, copied }`,
 * the record the journal holds. `skipped` when the space is already a
 * directory inside; `done` after the copy was verified, the link replaced,
 * the census pointed at the directory and the source renamed
 * `<source>.retired-<date>`. Coded failures: `space-migrate-source-missing`
 * (no link and no marked space at the census path), `space-migrate-verify-
 * failed` (the staging is removed and the link left as it was). A rerun
 * after a crash resumes from the journal: a staging that verifies is used,
 * one that does not is dropped and copied again, a directory already
 * switched in has the census and the retirement finished.
 */
export function migrateSpaceIntoSoul(soulDir, { agentId, file = populationFile(), now = () => new Date() } = {}) {
  const id = validateAgentId(agentId);
  const state = path.join(soulDir, STATE);
  const target = path.join(state, 'space');
  if (!lstat(state)?.isDirectory()) fail('soul-state-missing', `${soulDir} has no .soul-state yet; spawn or launch the soul first`);
  const previous = readMigrationStep(soulDir, SPACE_STEP_ID);
  let step = { id: SPACE_STEP_ID, status: 'pending', from: previous?.source ?? null, to: target, at: now().toISOString(), note: null,
    source: previous?.source ?? null, staging: null, aside: null, retired: previous?.retired ?? null, copied: previous?.copied ?? null };
  const record = (fields) => { step = { ...step, ...fields, at: now().toISOString() }; recordMigrationStep(soulDir, step); return step; };
  const soul = showSoul(id, { file });

  return withLock(path.join(state, '.space-migrate.lock'), `Agent Space migration ${id}`, () => {
    const current = lstat(target);
    const finish = () => {
      // The directory is in place: the census first (authoritative), then the
      // source retired, never deleted. A missing source was retired already.
      if (previous?.aside && lstat(previous.aside)?.isSymbolicLink()) rmSync(previous.aside, { force: true });
      setSoulSpacePath(id, target, { file });
      let retired = step.retired;
      if (step.source && lstat(step.source)?.isDirectory() && !inside(soulDir, step.source)) {
        retired = `${step.source}.retired-${stamp(now())}`;
        if (lstat(retired)) retired += `-${randomUUID().slice(0, 8)}`;
        renameSync(step.source, retired);
      }
      const copied = step.copied ?? { files: 0, bytes: 0, links: [], skipped: [] };
      return record({ status: 'done', staging: null, aside: null, retired,
        note: `copied ${copied.files} file(s), ${copied.links.length} link(s)${copied.skipped.length ? `, skipped ${copied.skipped.length} special file(s)` : ''}; source retired to ${retired ?? 'nowhere (already gone)'}` });
    };
    if (current?.isDirectory()) {
      if (previous?.status === 'switching' && previous.source) return finish();
      // Already inside; the census follows the directory the soul uses.
      if (soul.spacePath !== target) setSoulSpacePath(id, target, { file });
      return record({ status: 'skipped', from: soul.spacePath, source: null, note: 'already inside' });
    }
    if (current && !current.isSymbolicLink()) {
      fail('space-migrate-source-missing', `${target} is neither a link to an Agent Space nor a directory; move it aside and run the migration again`);
    }
    const source = current ? path.resolve(state, readlinkSync(target)) : step.source ?? soul.spacePath;
    if (!source || inside(soulDir, source)) {
      fail('space-migrate-source-missing', `${target} does not point outside the soul (${source ?? 'no census path'}); nothing to move`);
    }
    const inspection = inspectAgentSpace(id, { root: source });
    if (inspection.status !== 'ok') {
      fail('space-migrate-source-missing', `${source} is not ${id}'s marked Agent Space (${inspection.status}); nothing was moved`);
    }
    step.from = source;
    step.source = source;
    // A link moved aside by a run that stopped before the switch finished.
    if (previous?.aside && lstat(previous.aside)?.isSymbolicLink()) rmSync(previous.aside, { force: true });

    // The same lock initAgentSpace holds for a space under the spaces root,
    // so nothing re-creates or restores the source while it moves.
    return withLock(path.join(path.dirname(source), `.${id}.lock`), `Agent Space ${id}`, () => {
      let staging = previous?.staging && inside(state, previous.staging) && lstat(previous.staging)?.isDirectory() ? previous.staging : null;
      let note = null;
      if (staging) {
        const check = verifySpaceTree(source, staging);
        if (check.ok) {
          record({ status: 'verifying', staging, note: 'resumed with the staging of an earlier run',
            copied: { files: check.files, bytes: previous.copied?.bytes ?? null, links: check.links, skipped: previous.copied?.skipped ?? [] } });
        } else { rmSync(staging, { recursive: true, force: true }); staging = null; note = `an earlier staging did not verify (${check.reason}); copied again`; }
      }
      if (!staging) {
        staging = path.join(state, `space.migrating-${randomUUID()}`);
        record({ status: 'copying', staging, copied: null, note });
        let copied;
        try { copied = copySpaceTree(source, staging); }
        catch (error) {
          rmSync(staging, { recursive: true, force: true });
          record({ status: 'failed', staging: null, note: `copy failed: ${error.code ?? error.message}` });
          fail('space-migrate-verify-failed', `${source} could not be copied into the soul (${error.code ?? error.message}); the link is unchanged`);
        }
        record({ status: 'verifying', copied });
        const check = verifySpaceTree(source, staging);
        if (!check.ok) {
          rmSync(staging, { recursive: true, force: true });
          record({ status: 'failed', staging: null, note: `verification failed: ${check.reason}` });
          fail('space-migrate-verify-failed', `the copy of ${source} did not verify (${check.reason}); the staging was removed and the link is unchanged`);
        }
      }
      // Switch: the link aside, the verified directory in, the link gone.
      record({ status: 'switching', staging });
      if (lstat(target)?.isSymbolicLink()) {
        const aside = path.join(state, `space.link-${randomUUID()}`);
        renameSync(target, aside);
        record({ aside });
      }
      renameSync(staging, target);
      if (step.aside) rmSync(step.aside, { force: true });
      record({ status: 'switching', staging: null, aside: null });
      return finish();
    });
  });
}
