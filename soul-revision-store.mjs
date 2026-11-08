// The RevisionStore port (HQ plan §2.4, C3; #1388): the read side of a soul's
// revision journal. It says where the journal is, lists its revision records
// and returns a stored revision's package, checked against its hash. It
// writes nothing. Readers that need only stored revisions, such as
// skill-manifest.mjs, read them here rather than through soul-revisions.mjs,
// which holds the writers and re-exports these names. Today it reads the
// local journal under the state directory; HQ storage can back it later.

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { validateSoulPackage } from './soul-package.mjs';
import { stateDirectory } from './state-paths.mjs';
import { validateAgentId } from './identity-format.mjs';

const json = (file) => JSON.parse(readFileSync(file, 'utf8'));
function rootFor(id, options) {
  return join(options.stateDir ?? stateDirectory(), 'soul-revisions', validateAgentId(id));
}
function events(root) {
  if (!existsSync(root)) return [];
  return readdirSync(root).filter((name) => /^\d{10}\.json$/.test(name)).sort().map((name) => json(join(root, name)));
}
function objectPath(root, revision) {
  if (!/^sha256:[a-f0-9]{64}$/.test(revision)) throw new Error('invalid revision');
  return join(root, 'objects', revision.slice(7) + '.soul');
}
function storedPackage(root, revision) {
  const file = objectPath(root, revision);
  if (validateSoulPackage(file).revision !== revision) throw new Error('stored revision hash mismatch');
  return file;
}

// The journal directory, for bounded read-only verifiers that must not use
// the unbounded readers here (skill-dream-evidence.mjs).
export function revisionJournalRoot(id, options = {}) {
  return rootFor(id, options);
}
export function revisionHistory(id, options = {}) {
  return events(rootFor(id, options)).filter((event) => event.kind === 'revision');
}
export function revisionPackagePath(id, revision, options = {}) {
  return storedPackage(rootFor(id, options), revision);
}

// The journal internals soul-revisions.mjs's writers share. soul-revisions.mjs
// does not re-export these.
export { events, objectPath, rootFor, storedPackage };
