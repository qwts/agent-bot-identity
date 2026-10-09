// Per-skill manifests (#312, requirement 1): for every skill in a soul
// package, the package-relative paths of its files and a SHA-256 digest over
// each file's exact bytes, plus a digest of the manifest itself. Two
// manifests diff to the files a skill gained, lost or changed, and two
// packages (or two stored revisions) diff to the skills that came, went or
// changed. Nothing here writes: a manifest is a pure function of a package,
// so every stored revision already has one, addressable by its revision.
//
// A digest describes bytes, not trust: identical bytes give identical
// digests, a one-byte edit (or a line-ending change) gives a new one, and an
// execute-bit change counts as a modification because the harness runs the
// file differently. The manifest never hashes itself: it covers only the
// files under `skills/<name>/`, read through the package inventory, so
// working state and ignored paths never enter it.
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { canonicalJson, readSoulPackageEntries } from './soul-package.mjs';
import { revisionHistory, revisionPackagePath } from './soul-revisions.mjs';

const SKILL_PATH = /^skills\/([^/]+)(?:\/(.+))?$/;

function sha256(bytes) {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

function sortedObject(object) {
  return Object.fromEntries(Object.keys(object).sort().map((key) => [key, object[key]]));
}

/**
 * The manifests of every skill in `packagePath`: `{ [name]: { files, digest } }`,
 * where `files` maps each package-relative path under `skills/<name>/` to
 * `{ mode, sha256 }` and `digest` is the SHA-256 of the canonical JSON of
 * `files`. A skill directory with no files beyond `SKILL.md` still lists it;
 * nested directories contribute their files, not themselves.
 */
export function skillManifests(packagePath) {
  const skills = {};
  for (const { path, mode, bytes } of readSoulPackageEntries(packagePath).entries) {
    const match = path.match(SKILL_PATH);
    if (!match) continue;
    const [, name, inside] = match;
    const skill = (skills[name] ??= { files: {} });
    if (!inside || mode === '040000') continue;
    skill.files[path] = { mode, sha256: sha256(bytes) };
  }
  for (const name of Object.keys(skills)) {
    skills[name].files = sortedObject(skills[name].files);
    skills[name].digest = sha256(Buffer.from(canonicalJson(skills[name].files)));
  }
  return sortedObject(skills);
}

/**
 * The files one skill gained, lost or changed between two of its manifests
 * (either may be absent): `{ added, modified, removed }`, each a sorted list
 * of package-relative paths. A mode change alone is a modification.
 */
export function diffSkillManifest(before, after) {
  const left = before?.files ?? {}, right = after?.files ?? {};
  const added = [], modified = [], removed = [];
  for (const path of new Set([...Object.keys(left), ...Object.keys(right)])) {
    if (!Object.hasOwn(left, path)) added.push(path);
    else if (!Object.hasOwn(right, path)) removed.push(path);
    else if (left[path].sha256 !== right[path].sha256 || left[path].mode !== right[path].mode) modified.push(path);
  }
  return { added: added.sort(), modified: modified.sort(), removed: removed.sort() };
}

/**
 * The skills that came, went or changed between two sets of manifests:
 * `{ added, removed, changed, unchanged }`, the first two and the last sorted
 * lists of skill names, `changed` a map from skill name to its file diff.
 */
export function diffSkillManifests(before, after) {
  const result = { added: [], removed: [], changed: {}, unchanged: [] };
  for (const name of [...new Set([...Object.keys(before), ...Object.keys(after)])].sort()) {
    if (!(name in before)) result.added.push(name);
    else if (!(name in after)) result.removed.push(name);
    else if (before[name].digest !== after[name].digest) result.changed[name] = diffSkillManifest(before[name], after[name]);
    else result.unchanged.push(name);
  }
  return result;
}

/** The skill diff between two packages on disk. */
export function diffPackageSkills(beforePath, afterPath) {
  return diffSkillManifests(skillManifests(beforePath), skillManifests(afterPath));
}

/** Whether a skill diff reports anything. */
export function skillsChanged(diff) {
  return diff.added.length > 0 || diff.removed.length > 0 || Object.keys(diff.changed).length > 0;
}

/** The manifests of a soul's stored revision (its head when `revision` is omitted). */
export function skillManifestsAt(id, revision, options = {}) {
  const history = revisionHistory(id, options);
  if (history.length === 0) throw new Error('adopt a starting package before reading skill manifests');
  const target = revision ?? history.at(-1).revision;
  if (!history.some((record) => record.revision === target)) throw new Error(`unknown revision ${target}`);
  return { revision: target, skills: skillManifests(revisionPackagePath(id, target, options)) };
}

/**
 * A soul's skill manifests at `revision` (default: the head) and what changed
 * since `since` (default: that revision's parent; nothing for the first
 * revision). Both revisions must be in the soul's history.
 */
export function skillChanges(id, { revision, since } = {}, options = {}) {
  const at = skillManifestsAt(id, revision, options);
  const record = revisionHistory(id, options).find((item) => item.revision === at.revision);
  const base = since ?? record.parentRevision;
  if (base === null) return { ...at, since: null, changes: diffSkillManifests({}, at.skills) };
  const from = skillManifestsAt(id, base, options);
  return { ...at, since: from.revision, changes: diffSkillManifests(from.skills, at.skills) };
}

export function skillsCommand(args, options = {}) {
  const [id, revision, since, ...extra] = args.filter((arg) => arg !== '--json');
  if (!id || extra.length > 0) throw new Error('usage: soul revision skills ID [REVISION [SINCE]] [--json]');
  return skillChanges(id, { revision, since }, options);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  Promise.resolve().then(() => skillsCommand(process.argv.slice(2)))
    .then((result) => process.stdout.write(JSON.stringify(result) + '\n'))
    .catch((error) => { process.stderr.write(`agent-bot soul revision skills: ${error.message}\n`); process.exitCode = 1; });
}
