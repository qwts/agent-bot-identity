import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, lstatSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SKILL_LIBRARY_LIMITS, importSkill, listSkills, showSkill, verifySkill, checkSkill } from '../skill-library.mjs';
import { diffSkillManifest } from '../skill-manifest.mjs';
import { main } from '../cli/soul-skill.mjs';
const ROOT = fileURLToPath(new URL('..', import.meta.url));
const put = (file, text, mode) => { mkdirSync(path.dirname(file), { recursive: true }); writeFileSync(file, text); if (mode !== undefined) chmodSync(file, mode); };
const entry = (name = 'demo') => `---\r\nname: ${name}\r\ndescription: A fixture skill\r\n---\r\n# Demo\r\n[Guide](references/guide.md)\r\n`;
function fixture(t, name = 'demo') {
  const home = mkdtempSync(path.join(tmpdir(), 'skill-library-'));
  t.after(() => {
    function thaw(dir) { chmodSync(dir, 0o700); for (const item of readdirSync(dir, { withFileTypes: true })) if (item.isDirectory()) thaw(path.join(dir, item.name)); }
    thaw(home); rmSync(home, { recursive: true, force: true });
  });
  const source = path.join(home, 'source');
  put(path.join(source, 'SKILL.md'), entry(name));
  put(path.join(source, 'references/guide.md'), '[Entry](../SKILL.md)\n');
  put(path.join(source, 'scripts/tool'), '#!/bin/sh\nexit 99\n', 0o755);
  put(path.join(source, 'assets/data'), Buffer.from([0, 255, 13, 10, 33]));
  const options = { home, env: {}, now: () => new Date('2026-10-09T00:00:00Z') };
  const library = path.join(home, '.agent-bot/skills');
  const cli = argv => { let stdout = '', stderr = ''; const status = main(argv, { ...options, stdout: { write: value => { stdout += value; } }, stderr: { write: value => { stderr += value; } } }); return { status, stdout, stderr }; };
  return { home, source, options, library, cli };
}

test('directory and SKILL.md imports preserve supporting bytes/modes with distinct UUIDs and no activation', t => {
  const f = fixture(t);
  put(path.join(f.source, '.git/config'), 'excluded');
  put(path.join(f.source, 'node_modules/pkg/index.js'), 'excluded');
  const a = importSkill(f.source, f.options), b = importSkill(path.join(f.source, 'SKILL.md'), f.options);
  assert.notEqual(a.id, b.id);
  assert.equal(a.accepted, b.accepted);
  assert.equal(a.name, 'demo');
  assert.deepEqual(readFileSync(path.join(a.path, 'SKILL.md')), Buffer.from(entry()));
  assert.deepEqual(readFileSync(path.join(a.path, 'assets/data')), Buffer.from([0, 255, 13, 10, 33]));
  assert.equal(a.localBaseline.files['scripts/tool'].mode, '100755');
  assert.deepEqual(a.excluded, ['.git', 'node_modules']);
  assert.ok(a.dependencies.some(ref => ref.target === 'references/guide.md' && ref.status === 'captured' && ref.cycle));
  assert.equal(a.coverage.universalRetrieval, false);
  assert.equal(verifySkill(a.id, f.options).verification, 'verified');
  assert.equal(listSkills(f.options).length, 2);
  assert.deepEqual(readdirSync(f.home).sort(), ['.agent-bot', 'source']);
  assert.equal(existsSync(path.join(a.path, 'manifest.json')), false);
});

test('metadata directories cannot collide with valid skill names', t => {
  for (const name of ['snapshots', 'checks', 'manifest']) {
    const f = fixture(t, name), imported = importSkill(f.source, f.options);
    assert.equal(verifySkill(imported.id, f.options).verification, 'verified');
    assert.equal(checkSkill(imported.id, f.options).status, 'unchanged');
  }
});

test('source checks retain upstream/local bytes and distinguish unchanged, changed and unavailable', t => {
  const f = fixture(t), imported = importSkill(f.source, f.options);
  assert.equal(checkSkill(imported.id, f.options).status, 'unchanged');
  put(path.join(imported.path, 'references/guide.md'), 'local adaptation\n');
  put(path.join(imported.path, 'local.md'), 'local file\n');
  chmodSync(path.join(imported.path, 'scripts/tool'), 0o644);
  const drift = verifySkill(imported.id, f.options);
  assert.equal(drift.verification, 'drifted');
  assert.deepEqual(drift.changes.added, ['local.md']);
  assert.deepEqual(drift.changes.modified, ['references/guide.md', 'scripts/tool']);
  put(path.join(f.source, 'references/guide.md'), 'upstream changed\n');
  put(path.join(f.source, 'new.md'), 'new upstream file\n');
  rmSync(path.join(f.source, 'assets/data'));
  const changed = checkSkill(imported.id, f.options);
  assert.equal(changed.status, 'changed');
  assert.notEqual(changed.accepted, changed.candidate);
  assert.deepEqual(changed.changes, { added: ['new.md'], modified: ['references/guide.md'], removed: ['assets/data'] });
  assert.ok(changed.textDiffs.find(diff => diff.path === 'references/guide.md').text.includes('+upstream changed'));
  assert.equal(readFileSync(path.join(imported.path, 'references/guide.md'), 'utf8'), 'local adaptation\n');
  assert.equal(readFileSync(path.join(imported.snapshot, 'payload/references/guide.md'), 'utf8'), '[Entry](../SKILL.md)\n');
  assert.equal(showSkill(imported.id, f.options).accepted, imported.accepted);
  assert.deepEqual(changed.localAdaptations.added, ['local.md']);
  rmSync(f.source, { recursive: true });
  assert.equal(checkSkill(imported.id, f.options).status, 'unavailable');
  assert.equal(readFileSync(path.join(imported.path, 'references/guide.md'), 'utf8'), 'local adaptation\n');
  const checks = path.join(f.library, imported.id, '.checks');
  assert.ok(readdirSync(checks).some(file => JSON.parse(readFileSync(path.join(checks, file))).status === 'unavailable'));
});

test('remote, unsafe and unsupported references are explicit and sensitive locator values are absent from provenance', t => {
  const f = fixture(t);
  put(path.join(f.source, 'references/guide.md'), '[Remote](https://example.test/guide.md)\n[Site](https://example.test/)\n[Secret](https://user:CANARY@example.test/g.md?token=CANARY)\n[Out](../../outside.md)\n[Absolute](/etc/passwd)\n');
  const imported = importSkill(f.source, f.options);
  assert.ok(imported.dependencies.some(ref => ref.reason === 'remote-capture-unsupported'));
  assert.ok(imported.dependencies.some(ref => ref.reason === 'sensitive-locator-withheld'));
  assert.ok(imported.dependencies.some(ref => ref.reason === 'unsafe-reference'));
  assert.ok(imported.coverage.unresolved >= 3);
  assert.doesNotMatch(JSON.stringify(imported), /CANARY/);
  for (const input of ['https://user:CANARY@example.test/a.md', 'https:CANARY']) assert.throws(() => importSkill(input, f.options), error => error.code === 'skill-source-unsupported' && !error.message.includes('CANARY'));
});

test('internal file links materialize; escaping/directory links, invalid entrypoints and limits publish nothing', t => {
  const good = fixture(t);
  symlinkSync('references/guide.md', path.join(good.source, 'guide-copy.md'));
  const imported = importSkill(good.source, good.options);
  assert.equal(readFileSync(path.join(imported.path, 'guide-copy.md'), 'utf8'), '[Entry](../SKILL.md)\n');
  assert.deepEqual(imported.materialized, [{ path: 'guide-copy.md', target: 'references/guide.md' }]);
  for (const kind of ['escape', 'directory', 'invalid', 'bytes', 'files', 'entries', 'entryBytes', 'depth']) {
    const f = fixture(t);
    if (kind === 'escape') { put(path.join(f.home, 'outside'), 'outside'); symlinkSync('../outside', path.join(f.source, 'bad')); }
    if (kind === 'directory') symlinkSync('.', path.join(f.source, 'loop'));
    if (kind === 'invalid') put(path.join(f.source, 'SKILL.md'), '<html>not a skill</html>');
    const options = Object.hasOwn(SKILL_LIBRARY_LIMITS, kind) ? { ...f.options, limits: { [kind]: kind === 'depth' ? 0 : 1 } } : f.options;
    assert.throws(() => importSkill(f.source, options));
    assert.equal(existsSync(f.library), false, kind);
  }
});

test('special files and stored symlink/corruption attempts are refused without writing outside the library', t => {
  const f = fixture(t);
  execFileSync('mkfifo', [path.join(f.source, 'pipe')]);
  assert.throws(() => importSkill(f.source, f.options), error => error.code === 'skill-source-unsupported');
  rmSync(path.join(f.source, 'pipe'));
  const imported = importSkill(f.source, f.options);
  const root = path.join(f.library, imported.id), outside = path.join(f.home, 'outside');
  mkdirSync(outside);
  symlinkSync(outside, path.join(root, '.checks'));
  assert.throws(() => checkSkill(imported.id, f.options), error => error.code === 'skill-path-unsafe');
  assert.deepEqual(readdirSync(outside), []);
  rmSync(path.join(root, '.checks'));
  chmodSync(path.join(imported.snapshot, 'payload/references/guide.md'), 0o644);
  put(path.join(imported.snapshot, 'payload/references/guide.md'), 'corrupted snapshot');
  assert.throws(() => showSkill(imported.id, f.options), error => error.code === 'skill-record-invalid');
  assert.throws(() => checkSkill(imported.id, f.options), error => error.code === 'skill-record-invalid');
});

test('comparison treats Object prototype names as files, including additions/removals', () => {
  const file = { mode: '100644', sha256: 'a' };
  assert.deepEqual(diffSkillManifest({ files: {} }, { files: { constructor: file } }), { added: ['constructor'], modified: [], removed: [] });
  assert.deepEqual(diffSkillManifest({ files: { constructor: file } }, { files: {} }), { added: [], modified: [], removed: ['constructor'] });
});

test('CLI returns structured deterministic results and distinct usage/drift/unavailable statuses', t => {
  const f = fixture(t);
  assert.equal(f.cli(['import', '--unexpected']).status, 2);
  const imported = f.cli(['import', f.source, '--json']);
  assert.equal(imported.status, 0, imported.stderr);
  const id = JSON.parse(imported.stdout).id;
  assert.equal(f.cli(['verify', id, '--json']).status, 0);
  put(path.join(JSON.parse(imported.stdout).path, 'extra'), 'x');
  assert.equal(f.cli(['verify', id, '--json']).status, 1);
  rmSync(f.source, { recursive: true });
  assert.equal(f.cli(['check', id, '--json']).status, 1);
  const missing = f.cli(['show', 'not-an-id', '--json']);
  assert.equal(missing.status, 1);
  assert.equal(JSON.parse(missing.stdout).error.code, 'skill-id-invalid');
  const dispatch = spawnSync(process.execPath, [path.join(ROOT, 'agent-bot.mjs'), 'soul', 'skill', 'list', '--json'], { env: { PATH: process.env.PATH, HOME: f.home }, encoding: 'utf8' });
  assert.equal(dispatch.status, 0, dispatch.stderr);
  assert.equal(JSON.parse(dispatch.stdout).skills.length, 1);
});

test('the explicit library root is isolated and snapshots publish read-only', t => {
  const f = fixture(t), custom = path.join(f.home, 'custom/library');
  const options = { ...f.options, env: { AGENT_BOT_SKILLS_HOME: custom } };
  const imported = importSkill(f.source, options);
  assert.equal(imported.path, path.join(custom, imported.id, 'demo'));
  assert.equal(existsSync(f.library), false);
  for (const file of [imported.snapshot, path.join(imported.snapshot, 'payload/SKILL.md'), path.join(custom, imported.id, 'manifest.json')]) assert.equal(lstatSync(file).mode & 0o222, 0);
  assert.equal(verifySkill(imported.id, options).verification, 'verified');
  assert.equal(checkSkill(imported.id, options).status, 'unchanged');
  for (const value of ['', 'relative', '~/skills']) assert.throws(() => listSkills({ ...options, env: { AGENT_BOT_SKILLS_HOME: value } }), error => error.code === 'skill-root-invalid');
});
