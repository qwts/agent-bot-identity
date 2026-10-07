import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { canonicalJson, canonicalPackageBytes, computePackageRevision, expectedGeneratedFiles, readSoulPackageEntries, GENERATED_HARNESS_MARKER, GENERATED_HARNESS_PATHS, PACKAGE_IGNORE_LIST, skillField, validateSoulPackage, PRIOR_PACKAGE_IGNORE_LISTS, isSupportedIgnoreList } from '../soul-package.mjs';

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

test('appearance is optional, accepts boundary hues, and participates in the revision', (t) => {
  const root = fixture(t);
  const initial = validateSoulPackage(root).revision;
  const revisions = new Set([initial]);
  for (const hue of [0, 180, 359]) {
    manifest(root, (m) => { m.appearance = { hue }; });
    const revision = seal(root);
    assert.equal(validateSoulPackage(root).revision, revision);
    assert.ok(!revisions.has(revision));
    revisions.add(revision);
  }
  manifest(root, (m) => { delete m.appearance; });
  assert.equal(seal(root), initial);
});

test('appearance rejects invalid shapes, unknown keys, and invalid hues with their paths', (t) => {
  const root = fixture(t);
  const cases = [
    ...[null, [], 'blue', 10, true].map((appearance) => [appearance, 'soul.json appearance must be an object']),
    [{ hue: 120, saturation: 50 }, 'soul.json appearance.saturation is an unknown appearance setting'],
    ...[undefined, null, '120', true, [], {}, -1, 360, 1.5, 1e100].map((hue) =>
      [{ hue }, 'soul.json appearance.hue must be an integer from 0 to 359']),
  ];
  for (const [appearance, message] of cases) {
    manifest(root, (m) => { m.appearance = appearance; });
    const before = snapshot(root);
    assert.throws(() => validateSoulPackage(root), { message });
    assert.deepEqual(snapshot(root), before);
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
  for (const description of ['Useful skill', '"Useful skill"', "'Useful skill'", '|\n  Useful skill', '>\n  Useful\n  skill', '"Useful skill" # note', "'Useful skill' # note", '|- # note\n  Useful\n\n  skill', '>2\n  Useful', `>\n${'    word\n'.repeat(204)}`]) {
    writeFileSync(join(skill, 'SKILL.md'), `---\nname: example\ndescription: ${description}\nmetadata:\n  future: yes\n---\nInstructions\n`);
    seal(root); validateSoulPackage(root);
  }
  mkdirSync(join(skill, 'scripts')); writeFileSync(join(skill, 'scripts', 'run'), 'opaque');
  writeFileSync(join(root, 'skills', 'extension.bin'), Buffer.from([255]));
  for (const file of ['tools.json', 'mcp.json', 'policy.json']) writeFileSync(join(root, file), 'opaque future configuration');
  seal(root); const before = snapshot(root); validateSoulPackage(root); assert.deepEqual(snapshot(root), before);
});

test('block scalars decode before the length check: literal keeps lines, folded joins them', () => {
  const decode = (header, lines) => skillField(`description: ${header}\n${lines.map((line) => `    ${line}`).join('\n')}\n`, 'description');
  assert.equal(decode('|', ['one', 'two']), 'one\ntwo\n');
  assert.equal(decode('|-', ['one', 'two']), 'one\ntwo');
  assert.equal(decode('>', ['one', 'two', '', 'three']), 'one two\nthree\n');
  assert.equal(decode('>-', ['one', '  indented', 'two']), 'one\n  indented\ntwo');
});

test('malformed skill metadata and missing SKILL.md fail', (t) => {
  const root = fixture(t); const skill = join(root, 'skills', 'example'); mkdirSync(skill, { recursive: true });
  assert.throws(() => validateSoulPackage(root), /SKILL.md/);
  for (const front of ['', 'name: other\ndescription: text', 'name: example', 'name: example\ndescription: []', 'name: example\ndescription: ""', 'name: example\nname: example\ndescription: text', `name: example\ndescription: ${'x'.repeat(1025)}`, 'name: example\ndescription: "Useful" skill', "name: example\ndescription: 'Useful' skill", 'name: example\ndescription: |\n', `name: example\ndescription: |\n${'  word\n'.repeat(206)}`]) {
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

// Captured from main's unchanged implementation before issue #341 edits.
test('format 1 retains the pre-341 revision hash', (t) => {
  const root = fixture(t);
  assert.equal(computePackageRevision(root),
    'sha256:142f0d39da1abd4b1539e808c8ee2c3b1132b11905c56029226be4c3748ce3bc');
  const old = computePackageRevision(root);
  mkdirSync(join(root, 'worktrees'));
  assert.notEqual(computePackageRevision(root), old, 'v1 still covers all unknown entries');
});

function version2(t) {
  const root = fixture(t);
  manifest(root, (m) => { m.formatVersion = 2; m.ignore = PACKAGE_IGNORE_LIST; });
  seal(root);
  return root;
}

test('format 2 records the fixed ignore contract and uses a new hash domain', (t) => {
  const root = version2(t);
  assert.ok(canonicalPackageBytes(root).subarray(0, 26).equals(Buffer.from('agent-bot-soul-package-v2\0')));
  assert.ok(canonicalPackageBytes(root).includes(Buffer.from(canonicalJson(PACKAGE_IGNORE_LIST))));
  assert.equal(validateSoulPackage(root).formatVersion, 2);
  for (const ignore of [undefined, {}, { ...PACKAGE_IGNORE_LIST, directories: ['bin/'] },
    { ...PACKAGE_IGNORE_LIST, generatedMarker: 'anything' }]) {
    manifest(root, (m) => { m.ignore = ignore; });
    assert.throws(() => computePackageRevision(root), /ignore list/);
  }
});

test('a format 2 soul written by an earlier release still validates, an unknown list does not', (t) => {
  const root = version2(t), current = computePackageRevision(root);
  for (const prior of PRIOR_PACKAGE_IGNORE_LISTS) {
    manifest(root, (m) => { m.ignore = prior; });
    assert.ok(isSupportedIgnoreList(prior));
    const sealed = seal(root);
    assert.notEqual(sealed, current, 'the manifest bytes are still revision content');
    assert.equal(validateSoulPackage(root).formatVersion, 2);
    assert.equal(validateSoulPackage(root).revision, sealed);
  }
  assert.ok(!isSupportedIgnoreList({ ...PACKAGE_IGNORE_LIST, generatedPaths: [...PACKAGE_IGNORE_LIST.generatedPaths, 'NEWER.md'] }));
  manifest(root, (m) => { m.ignore = { ...PACKAGE_IGNORE_LIST, generatedPaths: [...PACKAGE_IGNORE_LIST.generatedPaths, 'NEWER.md'] }; });
  assert.throws(() => computePackageRevision(root), /ignore list/);
});

test('only root working state is ignored before symlink and special-file validation', (t) => {
  const root = version2(t), revision = computePackageRevision(root);
  for (const directory of ['worktrees', '.soul-state']) {
    mkdirSync(join(root, directory));
    symlinkSync('missing', join(root, directory, 'checkout'));
    writeFileSync(join(root, directory, 'cache'), 'working state');
    assert.equal(spawnSync('mkfifo', [join(root, directory, 'pipe')]).status, 0);
    assert.equal(computePackageRevision(root), revision);
    writeFileSync(join(root, directory, 'cache'), 'different state');
    assert.equal(validateSoulPackage(root).revision, revision);
    rmSync(join(root, directory), { recursive: true });
    symlinkSync('missing', join(root, directory));
    assert.equal(validateSoulPackage(root).revision, revision);
  }
  mkdirSync(join(root, 'nested', 'worktrees'), { recursive: true });
  mkdirSync(join(root, 'nested', '.soul-state'));
  const nestedRevision = computePackageRevision(root);
  assert.notEqual(nestedRevision, revision);
  writeFileSync(join(root, 'nested', '.soul-state', 'cache'), 'covered');
  assert.notEqual(computePackageRevision(root), nestedRevision);
  symlinkSync('missing', join(root, 'nested', 'worktrees', 'checkout'));
  assert.throws(() => computePackageRevision(root), /unsupported package entry/);
});

test('arbitrary marked harness files remain package content', (t) => {
  assert.deepEqual(expectedGeneratedFiles([]), new Map());
  for (const candidate of GENERATED_HARNESS_PATHS) {
    const root = version2(t), revision = computePackageRevision(root);
    const file = candidate.endsWith('/') ? candidate + 'nested/generated.md' : candidate;
    mkdirSync(dirname(join(root, file)), { recursive: true });
    const bytes = Buffer.from(`${GENERATED_HARNESS_MARKER}\r\ngenerated\n`);
    writeFileSync(join(root, file), bytes);
    const markedRevision = computePackageRevision(root);
    assert.notEqual(markedRevision, revision, file);
    assert.ok(readSoulPackageEntries(root).entries.find((entry) => entry.path === file).bytes.equals(bytes));
    writeFileSync(join(root, file), `generated changed\n${GENERATED_HARNESS_MARKER}\n`);
    assert.notEqual(computePackageRevision(root), markedRevision, 'marked changes participate');
    rmSync(join(root, file)); symlinkSync('missing', join(root, file));
    assert.throws(() => computePackageRevision(root), /unsupported package entry/);
  }
});

test('only exact expected build bytes at generated paths are ignored', (t) => {
  for (const candidate of GENERATED_HARNESS_PATHS) {
    const root = version2(t), revision = computePackageRevision(root);
    const file = candidate.endsWith('/') ? candidate + 'nested/generated.md' : candidate;
    const bytes = Buffer.from(`${GENERATED_HARNESS_MARKER}\noutput\n`);
    const options = { expectedGeneratedFiles: (entries) => {
      assert.ok(entries.some((entry) => entry.path === 'AGENTS.md'));
      assert.ok(entries.some((entry) => entry.path === 'soul.json'));
      assert.ok(entries.every((entry) => !GENERATED_HARNESS_PATHS.some((path) =>
        path.endsWith('/') ? entry.path === path.slice(0, -1) || entry.path.startsWith(path) : entry.path === path)));
      return new Map([[file, bytes]]);
    } };
    mkdirSync(dirname(join(root, file)), { recursive: true });
    writeFileSync(join(root, file), bytes);
    assert.equal(computePackageRevision(root, options), revision, file);
    assert.equal(readSoulPackageEntries(root, options).entries.some((entry) => entry.path === file), false);
    const changed = Buffer.from(bytes); changed[changed.length - 2] ^= 1;
    writeFileSync(join(root, file), changed);
    assert.notEqual(computePackageRevision(root, options), revision, 'one-byte difference participates');
    assert.ok(readSoulPackageEntries(root, options).entries.find((entry) => entry.path === file).bytes.equals(changed));
  }
  const root = version2(t);
  mkdirSync(join(root, '.codex'));
  writeFileSync(join(root, '.codex/authored.md'), 'authored');
  const authored = computePackageRevision(root);
  const bytes = Buffer.from('output without a marker');
  writeFileSync(join(root, '.codex/generated.md'), bytes);
  const options = { expectedGeneratedFiles: () => new Map([
    ['.codex/generated.md', bytes], ['other.md', bytes],
  ]) };
  assert.equal(computePackageRevision(root, options), authored, 'mixed containers retain authored files');
  writeFileSync(join(root, 'other.md'), bytes);
  assert.notEqual(computePackageRevision(root, options), authored, 'expected bytes outside generated paths are content');
});

for (const file of ['bin/run', 'workflows/review.md', 'sop/rules.md', 'agent-sop.toml']) {
  test(`format 2 covers ${file}`, (t) => {
    const root = version2(t), revision = computePackageRevision(root);
    mkdirSync(dirname(join(root, file)), { recursive: true });
    writeFileSync(join(root, file), 'initial');
    const added = computePackageRevision(root);
    assert.notEqual(added, revision);
    writeFileSync(join(root, file), 'changed');
    const changed = computePackageRevision(root);
    assert.notEqual(changed, added);
    chmodSync(join(root, file), 0o755);
    assert.notEqual(computePackageRevision(root), changed);
  });
}
