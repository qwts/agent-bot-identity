import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mintAgentIdentity } from '../agent-identity.mjs';
import { computePackageRevision } from '../soul-package.mjs';
import { adoptSoulPackage, decideSoulProposal, editSoulRevision, proposeSoulRevision, revisionCommand } from '../soul-revisions.mjs';
import { diffPackageSkills, diffSkillManifest, diffSkillManifests, skillChanges, skillManifests, skillManifestsAt, skillsChanged } from '../skill-manifest.mjs';
import { NOT_CAPTURED } from '../skill-references.mjs';

const SHA = /^sha256:[a-f0-9]{64}$/;
const skillMd = (name, body = 'Instructions\n') => `---\nname: ${name}\ndescription: A ${name} skill\n---\n${body}`;

function pkg(t, { skills = {} } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'skill-manifest-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const packagePath = join(root, 'example.soul');
  mkdirSync(packagePath);
  writeFileSync(join(packagePath, 'AGENTS.md'), 'Instructions\n');
  for (const [name, files] of Object.entries(skills)) put(packagePath, name, files);
  seal(packagePath);
  return { root, packagePath };
}
function put(packagePath, name, files) {
  const dir = join(packagePath, 'skills', name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'SKILL.md'), skillMd(name));
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(join(dir, path, '..'), { recursive: true });
    writeFileSync(join(dir, path), content);
  }
}
function seal(packagePath, parentRevision = null) {
  const manifest = { formatVersion: 1, name: 'Test', description: 'Test soul', displaySeed: 'test',
    preferredHarnesses: [], revision: `sha256:${'0'.repeat(64)}`, parentRevision };
  writeFileSync(join(packagePath, 'soul.json'), JSON.stringify(manifest));
  manifest.revision = computePackageRevision(packagePath);
  writeFileSync(join(packagePath, 'soul.json'), JSON.stringify(manifest));
  return manifest.revision;
}

test('a manifest lists every file of each skill with a digest over its exact bytes', (t) => {
  const { packagePath } = pkg(t, { skills: { alpha: { 'reference/notes.md': 'notes\n', 'scripts/run.sh': '#!/bin/sh\n' }, beta: {} } });
  const manifests = skillManifests(packagePath);
  assert.deepEqual(Object.keys(manifests), ['alpha', 'beta']);
  assert.deepEqual(Object.keys(manifests.alpha.files), ['skills/alpha/SKILL.md', 'skills/alpha/reference/notes.md', 'skills/alpha/scripts/run.sh']);
  assert.deepEqual(Object.keys(manifests.beta.files), ['skills/beta/SKILL.md']);
  for (const skill of Object.values(manifests)) {
    assert.match(skill.digest, SHA);
    for (const file of Object.values(skill.files)) { assert.match(file.sha256, SHA); assert.equal(file.mode, '100644'); }
  }
  // Identical bytes, identical digests, wherever they sit.
  const again = pkg(t, { skills: { alpha: { 'reference/notes.md': 'notes\n', 'scripts/run.sh': '#!/bin/sh\n' } } });
  assert.equal(skillManifests(again.packagePath).alpha.digest, manifests.alpha.digest);
  assert.deepEqual(skillManifests(pkg(t).packagePath), {});
});

test('one-byte edits, line endings, mode flips, additions and removals show in the diff', (t) => {
  const before = pkg(t, { skills: { alpha: { 'reference/notes.md': 'notes\n', 'old.md': 'bye\n' }, gone: {} } });
  const after = pkg(t, { skills: { alpha: { 'reference/notes.md': 'notes\r\n', 'new.md': 'hi\n' }, fresh: {} } });
  const diff = diffPackageSkills(before.packagePath, after.packagePath);
  assert.deepEqual(diff, { added: ['fresh'], removed: ['gone'], unchanged: [],
    changed: { alpha: { added: ['skills/alpha/new.md'], modified: ['skills/alpha/reference/notes.md'], removed: ['skills/alpha/old.md'] } } });
  assert.equal(skillsChanged(diff), true);
  // A single byte.
  const edited = pkg(t, { skills: { alpha: { 'reference/notes.md': 'Notes\n', 'old.md': 'bye\n' }, gone: {} } });
  assert.deepEqual(diffPackageSkills(before.packagePath, edited.packagePath).changed.alpha.modified, ['skills/alpha/reference/notes.md']);
  // The execute bit alone.
  const exec = pkg(t, { skills: { alpha: { 'reference/notes.md': 'notes\n', 'old.md': 'bye\n' }, gone: {} } });
  chmodSync(join(exec.packagePath, 'skills/alpha/old.md'), 0o755);
  seal(exec.packagePath);
  const modeDiff = diffPackageSkills(before.packagePath, exec.packagePath);
  assert.deepEqual(modeDiff.changed.alpha, { added: [], modified: ['skills/alpha/old.md'], removed: [] });
  // Nothing changed: nothing reported.
  const same = diffPackageSkills(before.packagePath, before.packagePath);
  assert.deepEqual(same, { added: [], removed: [], changed: {}, unchanged: ['alpha', 'gone'] });
  assert.equal(skillsChanged(same), false);
  assert.deepEqual(diffSkillManifest(undefined, { files: { a: { mode: '100644', sha256: 'x' } } }), { added: ['a'], modified: [], removed: [] });
  assert.deepEqual(diffSkillManifests({}, {}), { added: [], removed: [], changed: {}, unchanged: [] });
});

test('edits and proposals report the skills they change, and every stored revision has a manifest', async (t) => {
  const { root, packagePath } = pkg(t, { skills: { alpha: { 'reference/notes.md': 'notes\n' } } });
  const options = { env: { HOME: root }, home: root, stateDir: join(root, 'state'), now: () => new Date('2026-10-07T12:00:00Z') };
  const identity = mintAgentIdentity({ ...options, appSlug: 'test-agent', packageRevision: computePackageRevision(packagePath) });
  const initial = adoptSoulPackage(identity.id, packagePath, options);
  // The first revision: everything is new.
  const first = skillChanges(identity.id, {}, options);
  assert.equal(first.revision, initial.revision);
  assert.equal(first.since, null);
  assert.deepEqual(first.changes.added, ['alpha']);
  assert.deepEqual(Object.keys(first.skills.alpha.files), ['skills/alpha/SKILL.md', 'skills/alpha/reference/notes.md']);
  // An edit that touches no skill reports none.
  writeFileSync(join(packagePath, 'AGENTS.md'), 'Changed\n');
  const plain = await editSoulRevision(identity.id, packagePath, { ...options, reason: 'Words' });
  assert.equal(plain.skills, undefined);
  // An edit that changes a skill file and adds a skill reports both.
  writeFileSync(join(packagePath, 'skills/alpha/reference/notes.md'), 'notes v2\n');
  put(packagePath, 'beta', {});
  const edited = await editSoulRevision(identity.id, packagePath, { ...options, reason: 'Skills' });
  assert.deepEqual(edited.skills, { added: ['beta'], removed: [], unchanged: [],
    changed: { alpha: { added: [], modified: ['skills/alpha/reference/notes.md'], removed: [] } } });
  // The command reads the head against its parent, or any two revisions.
  const head = await revisionCommand(['skills', identity.id, '--json'], options);
  assert.equal(head.revision, edited.revision);
  assert.equal(head.since, plain.revision);
  assert.deepEqual(head.changes, edited.skills);
  assert.equal(head.notCaptured, NOT_CAPTURED);
  const span = await revisionCommand(['skills', identity.id, edited.revision, initial.revision], options);
  assert.deepEqual(span.changes.added, ['beta']);
  assert.deepEqual(skillManifestsAt(identity.id, initial.revision, options).skills, first.skills);
  assert.throws(() => skillManifestsAt(identity.id, `sha256:${'1'.repeat(64)}`, options), /unknown revision/);
  await assert.rejects(revisionCommand(['skills', identity.id, 'a', 'b', 'c'], options), /usage/);
  // A proposal records the skill diff with it; approving appends the revision.
  rmSync(join(packagePath, 'skills/beta'), { recursive: true });
  const proposal = proposeSoulRevision(identity.id, packagePath, { ...options, reason: 'Drop beta' });
  assert.deepEqual(proposal.skills, { added: [], removed: ['beta'], changed: {}, unchanged: ['alpha'] });
  decideSoulProposal(identity.id, proposal.proposalId, 'approve', { ...options, reason: 'Fine' });
  assert.deepEqual(skillChanges(identity.id, {}, options).changes.removed, ['beta']);
});
