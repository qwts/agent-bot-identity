// Soul skill install/uninstall (#603). Install copies one library skill into
// the soul's own `skills/<name>/` with a hash record; uninstall archives it
// inside the soul. Both only stage a candidate package: the caller records it
// through the existing revision path (an owner edit, or a soul proposal), so
// no new authority is introduced here. Global harness targets are not written.
import { lstatSync, mkdirSync, renameSync, rmSync, writeFileSync, chmodSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { listSkills, readSkillMaterial } from './skill-library.mjs';
import { projectSkillSourceProvenance } from './skill-source-provenance.mjs';
import { validateAgentId } from './agent-identity.mjs';
import { soulDirectory } from './agent-population.mjs';
import { discardRevisionStaging, prepareRevisionEdit } from './soul-revisions.mjs';

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const fail = (code, message) => { throw Object.assign(new Error(message), { code }); };
const exists = file => { try { return lstatSync(file); } catch (error) { if (error.code === 'ENOENT') return null; throw error; } };
const validName = name => typeof name === 'string' && name.length <= 64 && NAME.test(name);
// Package-relative locations. The record sits outside `skills/` so the skill
// directory holds only the skill's own bytes; archives sit outside `skills/`
// so soul build never renders an archived skill for a harness.
export const installRecordPath = name => `provenance/skill-installs/${name}.json`;
export const archiveRoot = name => `archive/skills/${name}`;
const stamp = now => now().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');

function resolveLibrarySkill(skill, options) {
  if (UUID.test(skill ?? '')) return skill;
  if (!validName(skill)) fail('skill-id-invalid', 'select a skill import UUID or a library skill name');
  const matches = listSkills(options).filter(item => item.name === skill);
  if (!matches.length) fail('skill-not-found', `no library skill is named ${skill}; import it first`);
  if (matches.length > 1) fail('skill-ambiguous', `${matches.length} library imports are named ${skill}; select one by UUID`);
  return matches[0].id;
}
function put(root, relative, bytes, mode) {
  const file = path.join(root, relative);
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  writeFileSync(file, bytes, { flag: 'wx', mode: mode === '100755' ? 0o755 : 0o644 });
  chmodSync(file, mode === '100755' ? 0o755 : 0o644);
}
// Stage on a fresh `soul revision prepare` copy; a failure discards it.
function staged(agentId, options, build) {
  validateAgentId(agentId);
  const prepared = prepareRevisionEdit(agentId, options);
  try { return { ...build(prepared.staging), agentId, staging: prepared.staging, parentRevision: prepared.revision }; }
  catch (error) { discardRevisionStaging(prepared.staging); throw error; }
}

/**
 * Stages `skills/<name>/` from the library's editable copy of `skill` (an
 * import UUID, or a name only one import has) plus its install record. The
 * record keeps the file manifest the library records for an import (path ->
 * mode, size, sha256, with the canonical digest), so drift of an installed
 * skill is checkable from the soul alone. Host paths are not recorded.
 */
export function stageSkillInstall(skill, agentId, { now = () => new Date(), ...options } = {}) {
  const id = resolveLibrarySkill(skill, options);
  const material = readSkillMaterial(id, { ...options, selection: 'local' });
  const name = material.record.name, destination = `skills/${name}`;
  return staged(agentId, options, staging => {
    if (exists(path.join(staging, destination))) fail('skill-install-exists', `${destination} already exists in this soul; uninstall it first`);
    if (exists(path.join(staging, installRecordPath(name)))) fail('skill-install-exists', `${installRecordPath(name)} already exists in this soul`);
    for (const entry of material.entries) put(staging, `${destination}/${entry.path}`, entry.bytes, entry.mode);
    const record = { schemaVersion: 1, name, libraryId: id, destination, selection: 'local',
      files: material.files, digest: material.digest, acceptedDigest: material.record.accepted,
      sourceProvenance: projectSkillSourceProvenance(material.captureMetadata, []),
      excluded: material.excluded, installedAt: now().toISOString() };
    put(staging, installRecordPath(name), Buffer.from(`${JSON.stringify(record, null, 2)}\n`), '100644');
    return { name, libraryId: id, destination, record: installRecordPath(name), digest: material.digest };
  });
}

/**
 * Stages the removal of `skills/<name>/`. By default the skill and its install
 * record move to `archive/skills/<name>/<UTC stamp>/` inside the soul, so
 * nothing is deleted. With `trash`, the candidate simply lacks them: the
 * caller must move the live folder to the OS trash (owner only) before the
 * edit is applied, so the bytes leave through the trash, not a deletion.
 */
export function stageSkillUninstall(name, agentId, { trash = false, now = () => new Date(), ...options } = {}) {
  if (!validName(name)) fail('skill-name-invalid', 'select an installed skill by its name');
  return staged(agentId, options, staging => {
    const source = path.join(staging, 'skills', name), stat = exists(source);
    if (!stat) fail('skill-not-installed', `skills/${name} is not in this soul`);
    if (!stat.isDirectory() || stat.isSymbolicLink()) fail('skill-path-unsafe', `skills/${name} is not a real directory`);
    const record = path.join(staging, installRecordPath(name)), hasRecord = Boolean(exists(record));
    if (trash) {
      rmSync(source, { recursive: true });
      if (hasRecord) rmSync(record);
      return { name, removed: `skills/${name}`, trash: true };
    }
    const archive = `${archiveRoot(name)}/${stamp(now)}`;
    if (exists(path.join(staging, archive))) fail('skill-archive-exists', `${archive} already exists; retry`);
    mkdirSync(path.join(staging, archive), { recursive: true, mode: 0o700 });
    renameSync(source, path.join(staging, archive, 'skill'));
    if (hasRecord) renameSync(record, path.join(staging, archive, 'install.json'));
    return { name, removed: `skills/${name}`, archive, trash: false };
  });
}

/**
 * The live `skills/<name>/` folder of a soul, for the trash move. Refuses a
 * link or a non-directory so the move cannot reach outside the soul.
 */
export function liveSkillDirectory(name, agentId, options = {}) {
  if (!validName(name)) fail('skill-name-invalid', 'select an installed skill by its name');
  const directory = path.join(soulDirectory(agentId, { ...options, readOnly: true }), 'skills', name), stat = exists(directory);
  if (!stat) fail('skill-not-installed', `skills/${name} is not in this soul`);
  if (!stat.isDirectory() || stat.isSymbolicLink()) fail('skill-path-unsafe', `skills/${name} is not a real directory`);
  return directory;
}

/**
 * Moves `file` to the user's trash: `~/.Trash` on macOS, the freedesktop.org
 * trash (`$XDG_DATA_HOME/Trash`) elsewhere on POSIX. It never deletes; a move
 * across volumes (EXDEV) or an unsupported platform refuses instead.
 */
export function moveToTrash(file, { platform = process.platform, env = process.env, home = env.HOME ?? homedir(), now = () => new Date() } = {}) {
  if (platform === 'win32') fail('skill-trash-unsupported', 'moving to the Recycle Bin is not supported yet; archive the skill instead');
  const base = path.basename(file), when = stamp(now);
  const unique = (directory, suffix = '') => {
    for (let i = 0; i < 100; i++) {
      const name = `${base} ${when}${i ? ` ${i}` : ''}`;
      if (!exists(path.join(directory, name)) && !exists(path.join(directory, `${name}${suffix}`))) return name;
    }
    fail('skill-trash-failed', 'no free name in the trash');
  };
  try {
    if (platform === 'darwin') {
      const trash = path.join(home, '.Trash');
      mkdirSync(trash, { recursive: true, mode: 0o700 });
      const target = path.join(trash, unique(trash));
      renameSync(file, target);
      return target;
    }
    const trash = path.join(env.XDG_DATA_HOME && path.isAbsolute(env.XDG_DATA_HOME) ? env.XDG_DATA_HOME : path.join(home, '.local', 'share'), 'Trash');
    mkdirSync(path.join(trash, 'files'), { recursive: true, mode: 0o700 });
    mkdirSync(path.join(trash, 'info'), { recursive: true, mode: 0o700 });
    const name = unique(path.join(trash, 'files')), info = path.join(trash, 'info', `${name}.trashinfo`);
    const date = now().toISOString().replace(/\.\d{3}Z$/, '');
    writeFileSync(info, `[Trash Info]\nPath=${encodeURI(path.resolve(file))}\nDeletionDate=${date}\n`, { flag: 'wx', mode: 0o600 });
    try { renameSync(file, path.join(trash, 'files', name)); }
    catch (error) { rmSync(info, { force: true }); throw error; }
    return path.join(trash, 'files', name);
  } catch (error) {
    if (error.code?.startsWith?.('skill-')) throw error;
    fail('skill-trash-failed', `could not move ${base} to the trash (${error.code ?? 'error'}); nothing was removed`);
  }
}

