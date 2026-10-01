import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { canonicalJson, canonicalPackageBytes, computePackageRevision, validateSoulPackage } from '../soul-package.mjs';

const vectors = JSON.parse(readFileSync(new URL('./fixtures/soul-package/vectors.json', import.meta.url)));
const cli = fileURLToPath(new URL('../agent-bot.mjs', import.meta.url));
function fixture(t, index = 0) {
  const root = mkdtempSync(join(tmpdir(), 'soul-package-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const entry of vectors[index].entries) {
    const file = join(root, entry.path);
    mkdirSync(dirname(file), { recursive: true });
    if (entry.mode === '040000') mkdirSync(file);
    else { writeFileSync(file, Buffer.from(entry.base64, 'base64')); chmodSync(file, entry.mode === '100755' ? 0o755 : 0o644); }
  }
  return root;
}
function manifest(root, change) {
  const file = join(root, 'soul.json');
  const value = JSON.parse(readFileSync(file));
  change(value);
  writeFileSync(file, JSON.stringify(value));
}
function seal(root) { const revision = computePackageRevision(root); manifest(root, (m) => { m.revision = revision; }); return revision; }
function snapshot(root) {
  return readdirSync(root, { recursive: true }).sort().map((path) => {
    const stat = lstatSync(join(root, path));
    return [path, stat.mode, stat.mtimeMs, stat.isFile() ? readFileSync(join(root, path)).toString('base64') : null];
  });
}
for (const [index, vector] of vectors.entries()) test(`fixed canonical vector: ${vector.name}`, (t) => {
  const root = fixture(t, index);
  assert.equal(canonicalPackageBytes(root).toString('base64'), vector.canonicalBase64);
  assert.equal(computePackageRevision(root), vector.revision);
  assert.equal(validateSoulPackage(root).revision, vector.revision);
});

test('parent participates, revision field does not, and manifest formatting is canonical', (t) => {
  const root = fixture(t);
  manifest(root, (m) => { m.revision = `sha256:${'a'.repeat(64)}`; });
  assert.equal(computePackageRevision(root), vectors[0].revision);
  assert.throws(() => validateSoulPackage(root), /revision mismatch/);
  manifest(root, (m) => { m.parentRevision = vectors[0].revision; });
  assert.equal(computePackageRevision(root), vectors[1].revision);
  const file = join(root, 'soul.json');
  writeFileSync(file, JSON.stringify(Object.fromEntries(Object.entries(JSON.parse(readFileSync(file))).reverse()), null, 4));
  assert.equal(computePackageRevision(root), vectors[1].revision);
  assert.equal(canonicalJson({ z: [2, { b: 1, a: 0 }], a: 'x' }), '{"a":"x","z":[2,{"a":0,"b":1}]}');
});

test('unknown fields, binary files, dotfiles and empty directories are covered and preserved', (t) => {
  const root = fixture(t, 2);
  const before = snapshot(root);
  validateSoulPackage(root);
  assert.deepEqual(snapshot(root), before);
  for (const file of ['.future', 'run.sh']) {
    writeFileSync(join(root, file), 'changed');
    assert.throws(() => validateSoulPackage(root), /revision mismatch/);
    seal(root);
  }
  const old = computePackageRevision(root);
  mkdirSync(join(root, 'another-empty'));
  assert.notEqual(computePackageRevision(root), old);
  seal(root);
  manifest(root, (m) => { m.future.z++; });
  assert.throws(() => validateSoulPackage(root), /revision mismatch/);
  const failed = snapshot(root);
  assert.throws(() => validateSoulPackage(root));
  assert.deepEqual(snapshot(root), failed);
});

test('ordering, root location, NFC and permission normalization are deterministic', (t) => {
  const root = fixture(t);
  const second = fixture(t);
  writeFileSync(join(root, 'z'), 'z'); writeFileSync(join(root, 'a'), 'a');
  writeFileSync(join(second, 'a'), 'a'); writeFileSync(join(second, 'z'), 'z');
  assert.equal(computePackageRevision(root), computePackageRevision(second));
  chmodSync(join(root, 'a'), 0o600);
  assert.equal(computePackageRevision(root), computePackageRevision(second));
  chmodSync(join(root, 'a'), 0o700);
  assert.notEqual(computePackageRevision(root), computePackageRevision(second));
  chmodSync(join(second, 'a'), 0o744);
  assert.equal(computePackageRevision(root), computePackageRevision(second));
  writeFileSync(join(root, 'e\u0301'), 'unicode'); writeFileSync(join(second, '\u00e9'), 'unicode');
  assert.equal(computePackageRevision(root), computePackageRevision(second));
  renameSync(join(root, 'z'), join(root, 'zz'));
  assert.notEqual(computePackageRevision(root), computePackageRevision(second));
});

for (const [field, values] of Object.entries({
  formatVersion: [undefined, 2, '1'], name: [undefined, '', ' ', 1], description: [undefined, null, ''],
  displaySeed: [undefined, {}, ''], preferredHarnesses: [undefined, {}, ['x', 'x'], ['']],
  revision: [undefined, null, 'abc', `sha256:${'a'.repeat(64)}\n`, `sha256:${'A'.repeat(64)}`, [`sha256:${'a'.repeat(64)}`]],
  parentRevision: [undefined, '', {}, [`sha256:${'a'.repeat(64)}`]],
})) test(`manifest rejects malformed ${field}`, (t) => {
  const root = fixture(t);
  for (const value of values) {
    manifest(root, (m) => { m[field] = value; });
    assert.throws(() => validateSoulPackage(root), new RegExp(field));
  }
});

test('invalid JSON, manifest shape, UTF-8, nonfinite numbers and required files fail', (t) => {
  for (const text of ['{', '[]', 'null', '{"formatVersion":1}']) {
    const root = fixture(t); writeFileSync(join(root, 'soul.json'), text);
    assert.throws(() => validateSoulPackage(root));
  }
  const root = fixture(t);
  manifest(root, (m) => { m.future = 1; });
  writeFileSync(join(root, 'soul.json'), readFileSync(join(root, 'soul.json'), 'utf8').replace('"future":1', '"future":1e999'));
  assert.throws(() => validateSoulPackage(root), /finite/);
  for (const name of ['soul.json', 'AGENTS.md']) {
    const dir = fixture(t); writeFileSync(join(dir, name), Buffer.from([255]));
    assert.throws(() => validateSoulPackage(dir), /UTF-8/);
    rmSync(join(dir, name)); mkdirSync(join(dir, name));
    assert.throws(() => validateSoulPackage(dir), /missing required file/);
  }
});

test('symlinks, special files and nonportable paths fail closed', (t) => {
  const root = fixture(t);
  for (const target of ['AGENTS.md', '.', 'missing']) {
    symlinkSync(target, join(root, 'link'));
    assert.throws(() => validateSoulPackage(root), /unsupported package entry/);
    rmSync(join(root, 'link'));
  }
  const link = `${root}-link`; symlinkSync(root, link); t.after(() => rmSync(link));
  assert.throws(() => validateSoulPackage(link), /directory/);
  for (const path of ['back\\slash', 'control\nname']) {
    writeFileSync(join(root, path), ''); assert.throws(() => validateSoulPackage(root), /paths cannot/); rmSync(join(root, path));
  }
  const fifo = spawnSync('mkfifo', [join(root, 'fifo')]);
  assert.equal(fifo.status, 0);
  assert.throws(() => validateSoulPackage(root), /unsupported package entry/);
});

test('Agent Skills layout accepts required YAML strings and preserves supporting files', (t) => {
  const root = fixture(t); const skill = join(root, 'skills', 'example'); mkdirSync(skill, { recursive: true });
  for (const description of ['Useful skill', '"Useful skill"', "'Useful skill'", '|\n  Useful skill', '>\n  Useful\n  skill']) {
    writeFileSync(join(skill, 'SKILL.md'), `---\nname: example\ndescription: ${description}\nmetadata:\n  future: yes\n---\nInstructions\n`);
    seal(root); validateSoulPackage(root);
  }
  mkdirSync(join(skill, 'scripts')); writeFileSync(join(skill, 'scripts', 'run'), 'opaque');
  writeFileSync(join(root, 'skills', 'extension.bin'), Buffer.from([255]));
  for (const file of ['tools.json', 'mcp.json', 'policy.json']) writeFileSync(join(root, file), 'opaque future configuration');
  seal(root); const before = snapshot(root); validateSoulPackage(root); assert.deepEqual(snapshot(root), before);
});

test('malformed skill metadata and missing SKILL.md fail', (t) => {
  const root = fixture(t); const skill = join(root, 'skills', 'example'); mkdirSync(skill, { recursive: true });
  assert.throws(() => validateSoulPackage(root), /SKILL.md/);
  for (const front of ['', 'name: other\ndescription: text', 'name: example', 'name: example\ndescription: []', 'name: example\ndescription: ""', 'name: example\nname: example\ndescription: text', `name: example\ndescription: ${'x'.repeat(1025)}`]) {
    writeFileSync(join(skill, 'SKILL.md'), `---\n${front}\n---\n`);
    assert.throws(() => validateSoulPackage(root));
  }
  rmSync(join(root, 'skills'), { recursive: true }); writeFileSync(join(root, 'skills'), '');
  assert.throws(() => validateSoulPackage(root), /skills must be a directory/);
});

test('CLI validates with no identity, gives useful failures, and never mutates', (t) => {
  const root = fixture(t); const before = snapshot(root);
  const run = (...args) => spawnSync(process.execPath, [cli, 'soul', ...args], { encoding: 'utf8', env: { PATH: process.env.PATH, HOME: root } });
  const valid = run('pack', 'validate', root);
  assert.equal(valid.status, 0, valid.stderr);
  assert.deepEqual(JSON.parse(valid.stdout), { formatVersion: 1, revision: vectors[0].revision, parentRevision: null });
  assert.deepEqual(snapshot(root), before);
  for (const args of [['pack'], ['pack', 'validate'], ['pack', 'invalid', root], ['pack', 'validate', root, 'extra'], ['pack', 'validate', join(root, 'missing')]]) {
    const result = run(...args); assert.equal(result.status, 1); assert.equal(result.stdout, ''); assert.match(result.stderr, /agent-bot soul pack:/);
  }
  writeFileSync(join(root, 'AGENTS.md'), 'edit');
  const bad = run('pack', 'validate', root); assert.equal(bad.status, 1); assert.match(bad.stderr, /revision mismatch/);
  assert.match(run('cold-wake').stderr, /usage: agent-bot soul cold-wake/);
});
