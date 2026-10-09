import test from 'node:test';
import assert from 'node:assert/strict';
import { projectSkillSourceProvenance, validateSkillSourceProvenance } from '../skill-source-provenance.mjs';

const digest = `sha256:${'a'.repeat(64)}`;
const origin = 'https://github.com/example/skills/tree/main/demo';
const snapshot = () => ({ capturedAt: '2026-10-09T00:00:00.000Z', source: { kind: 'https', url: origin, private: 'SECRET_CANARY' },
  manifest: { digest, files: { 'SKILL.md': { sha256: digest, mode: '100644' }, 'guide.md': { sha256: digest, mode: '100755' } } },
  locations: ['SKILL.md', 'guide.md'].map(path => ({ path, url: `https://raw.githubusercontent.com/example/skills/main/demo/${path}`,
    resolvedUrl: `https://raw.githubusercontent.com/example/skills/${'b'.repeat(40)}/demo/${path}`, gitBlob: 'c'.repeat(40), private: 'SECRET_CANARY' })),
  repository: { provider: 'github', owner: 'example', repo: 'skills', ref: 'main', path: 'demo', commit: 'b'.repeat(40), tree: 'd'.repeat(40), private: 'SECRET_CANARY' } });

test('projection whitelists repository and location metadata and retains only selected accepted paths', () => {
  const value = projectSkillSourceProvenance(snapshot(), ['guide.md', 'new-local-file.md']);
  assert.equal(value.locations.length, 1);
  assert.equal(value.locations[0].path, 'guide.md');
  assert.equal(value.locations[0].mode, '100755');
  assert.equal(value.repository.commit, 'b'.repeat(40));
  assert.doesNotMatch(JSON.stringify(value), /SECRET_CANARY|private/);
  const local = projectSkillSourceProvenance({ ...snapshot(), source: { kind: 'local', path: '/PRIVATE_HOST_PATH' }, repository: null }, ['SKILL.md']);
  assert.deepEqual(local.source, { kind: 'local' });
  assert.deepEqual(local.locations, []);
  assert.doesNotMatch(JSON.stringify(local), /PRIVATE_HOST_PATH/);
});

test('portable provenance refuses credentials, unbounded metadata, duplicate paths and mismatched repository selectors', () => {
  const base = projectSkillSourceProvenance(snapshot(), ['SKILL.md']);
  const mutations = [
    value => { value.source.url = 'https://user:secret@example.com/SKILL.md'; },
    value => { value.source.url = 'https://example.com/SKILL.md?token=secret'; },
    value => { value.locations[0].resolvedUrl = 'file:///etc/passwd'; },
    value => { value.locations[0].path = '../outside'; },
    value => { value.locations.push({ ...value.locations[0] }); },
    value => { value.locations[0].sha256 = 'unknown'; },
    value => { value.repository.ref = 'different'; },
    value => { value.repository.path = 'different'; },
    value => { value.repository.private = 'SECRET_CANARY'; },
    value => { value.capturedAt = 'yesterday'; },
    value => { value.schemaVersion = 2; },
    value => { value.locations = Array.from({ length: 1002 }, (_, i) => ({ ...value.locations[0], path: `file-${i}` })); },
    value => { value.locations = Array.from({ length: 300 }, (_, i) => ({ ...value.locations[0], path: `file-${i}-${'x'.repeat(900)}` })); },
  ];
  for (const mutate of mutations) {
    const value = structuredClone(base); mutate(value);
    assert.throws(() => validateSkillSourceProvenance(value), { code: 'skill-provenance-invalid' });
  }
});
