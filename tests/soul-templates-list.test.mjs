import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { locateSoulDir } from '../agent-population.mjs';
import { computePackageRevision, PACKAGE_IGNORE_LIST } from '../soul-package.mjs';
import { bundledSouls, bundledStarter, listSoulTemplates, templateListCommand } from '../soul-templates.mjs';

function fixture(t) {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'soul-template-list-')));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const root = join(home, 'souls');
  const env = { HOME: home, AGENT_BOT_CONFIG: join(home, 'config.json'), AGENT_BOT_SOULS_HOME: root };
  const configure = (config) => writeFileSync(env.AGENT_BOT_CONFIG, JSON.stringify(config));
  function pkg(directory, fields = {}) {
    mkdirSync(directory, { recursive: true });
    const manifest = { formatVersion: 2, ignore: PACKAGE_IGNORE_LIST,
      name: 'Engineer', description: 'Engineering template', displaySeed: 'engineer',
      preferredHarnesses: ['codex', 'claude'], template: true,
      revision: `sha256:${'0'.repeat(64)}`, parentRevision: null, ...fields };
    const save = () => writeFileSync(join(directory, 'soul.json'), JSON.stringify(manifest));
    save();
    writeFileSync(join(directory, 'AGENTS.md'), 'Package instructions are data.\n');
    manifest.revision = computePackageRevision(directory);
    save();
    return directory;
  }
  return { home, root, env, configure, pkg, options: { home, env } };
}

test('lists only direct, marked, unlaunched root templates, sorted with locate metadata', (t) => {
  const f = fixture(t);
  const z = f.pkg(join(f.root, 'z.soul'), { name: 'Zebra' });
  const a = f.pkg(join(f.root, 'a.soul'), { name: 'Alpha', preferredHarnesses: [] });
  f.pkg(join(f.root, 'ordinary.soul'), { template: false });
  f.pkg(join(f.root, 'string-flag.soul'), { template: 'true' });
  f.pkg(join(f.root, 'unmarked.soul'), { template: undefined });
  f.pkg(join(f.root, 'no-suffix'));
  f.pkg(join(f.root, 'nested', 'hidden.soul'));
  writeFileSync(join(f.root, 'file.soul'), 'not a directory');
  symlinkSync(a, join(f.root, 'linked.soul'));
  for (const marker of ['empty', 'malformed', 'dangling']) {
    const launched = f.pkg(join(f.root, `${marker}.soul`));
    mkdirSync(join(launched, '.soul-state'));
    const path = join(launched, '.soul-state', 'agent-id');
    if (marker === 'dangling') symlinkSync(join(f.home, 'absent'), path);
    else writeFileSync(path, marker === 'empty' ? '' : 'not an Agent ID');
  }
  const result = listSoulTemplates(f.options);
  assert.deepEqual(result, { templates: [a, z].map((directory) => {
    const located = locateSoulDir(directory, f.options);
    return { name: located.name, description: located.description,
      preferredHarnesses: located.preferredHarnesses ?? [], defaultHarness: located.preferredHarnesses?.[0] ?? null,
      package: resolve(directory), revision: located.revision ?? null, source: 'souls-root' };
  }), soulsRoot: f.root, errors: [] });
  assert.equal(existsSync(join(f.home, '.local')), false);
});

test('config and bundled packages need no template flag; canonical paths deduplicate in source order', (t) => {
  const f = fixture(t);
  const configured = f.pkg(join(f.root, 'configured.soul'), { name: 'Configured', template: false });
  const bundled = f.pkg(join(f.root, 'bundled.soul'), { name: 'Bundled', template: undefined });
  f.pkg(join(f.root, 'root.soul'), { name: 'Root' });
  symlinkSync(f.root, join(f.home, 'alias'));
  f.configure({ teams: { template: join(f.home, 'alias', 'configured.soul') } });
  f.env.AGENT_BOT_STARTER_TEMPLATE = configured;
  assert.deepEqual(listSoulTemplates(f.options).templates.map(({ package: pkg, source }) => [pkg, source]),
    [[configured, 'config'], [join(f.root, 'root.soul'), 'souls-root']]);
  f.env.AGENT_BOT_STARTER_TEMPLATE = bundled;
  const listed = listSoulTemplates(f.options);
  assert.deepEqual(listed.templates.map(({ source }) => source), ['bundled', 'config', 'souls-root']);
  assert.deepEqual(listed.errors, []);
});

test('invalid packages are reported without hiding valid templates', (t) => {
  const f = fixture(t);
  const badHash = f.pkg(join(f.root, 'bad-hash.soul'));
  writeFileSync(join(badHash, 'AGENTS.md'), 'changed without a revision');
  const badJson = join(f.root, 'bad-json.soul');
  mkdirSync(badJson);
  writeFileSync(join(badJson, 'soul.json'), '{');
  const missing = join(f.home, 'missing.soul');
  f.configure({ teams: { template: missing } });
  const linked = f.pkg(join(f.home, 'linked.soul'));
  rmSync(join(linked, 'soul.json'));
  symlinkSync(join(f.home, 'absent'), join(linked, 'soul.json'));
  f.env.AGENT_BOT_STARTER_TEMPLATE = linked;
  const valid = f.pkg(join(f.root, 'valid.soul'));
  const result = listSoulTemplates(f.options);
  assert.deepEqual(result.templates.map((row) => row.package), [valid]);
  assert.deepEqual(result.errors.map((error) => error.package), [missing, linked, badHash, badJson]);
  assert.ok(result.errors.every((error) => typeof error.message === 'string' && error.message.length > 0));
  assert.match(result.errors[2].message, /revision mismatch/);
});

test('display metadata uses the same caps and filtering as soul locate', (t) => {
  const f = fixture(t);
  const directory = f.pkg(join(f.root, 'capped.soul'), { name: 'n'.repeat(129), description: 'd'.repeat(513),
    preferredHarnesses: ['x'.repeat(65), 'codex', ...Array.from({ length: 8 }, (_, i) => `h${i}`)] });
  const before = readFileSync(join(directory, 'soul.json'));
  const [row] = listSoulTemplates(f.options).templates;
  assert.equal(row.name, '');
  assert.equal(row.description, '');
  assert.deepEqual(row.preferredHarnesses, ['codex', 'h0', 'h1', 'h2', 'h3', 'h4', 'h5']);
  assert.equal(row.defaultHarness, 'codex');
  assert.deepEqual(readFileSync(join(directory, 'soul.json')), before);
});

test('empty installs do not create a root; root settings and environment precedence match soulsHome', (t) => {
  const f = fixture(t);
  delete f.env.AGENT_BOT_SOULS_HOME;
  const empty = listSoulTemplates(f.options);
  assert.deepEqual(empty, { templates: [], soulsRoot: join(f.home, '.agent-bot', 'souls'), errors: [] });
  assert.equal(existsSync(empty.soulsRoot), false);
  f.configure({ settings: { soulsRoot: f.root } });
  assert.equal(listSoulTemplates(f.options).soulsRoot, f.root);
  f.env.AGENT_BOT_SOULS_HOME = join(f.home, 'override');
  assert.equal(listSoulTemplates(f.options).soulsRoot, f.env.AGENT_BOT_SOULS_HOME);
});

test('bundled Starter lookup uses the shipped layout and honors the explicit override', (t) => {
  const f = fixture(t);
  const root = join(f.home, 'Resources', 'components', 'agent-bot');
  assert.equal(bundledStarter({ env: {}, root }), null);
  const starter = f.pkg(join(f.home, 'Resources', 'souls', 'starter.soul'));
  assert.equal(bundledStarter({ env: {}, root }), starter);
  assert.equal(bundledStarter({ env: { AGENT_BOT_STARTER_TEMPLATE: f.root }, root }), f.root);
});

test('every bundled template is listed as bundled, Starter first, and only packages marked template', (t) => {
  const f = fixture(t);
  const root = join(f.home, 'Resources', 'components', 'agent-bot');
  assert.deepEqual(bundledSouls({ env: {}, root }), []);
  const starter = f.pkg(join(f.home, 'Resources', 'souls', 'starter.soul'), { name: 'Starter', template: undefined });
  const lead = f.pkg(join(f.home, 'Resources', 'souls', 'geniusbar.soul'), { name: 'GeniusBar', template: true });
  f.pkg(join(f.home, 'Resources', 'souls', 'aside.soul'), { name: 'Aside', template: false });
  mkdirSync(join(f.home, 'Resources', 'souls', 'notes'), { recursive: true });
  assert.deepEqual(bundledSouls({ env: {}, root }), [starter, lead]);
  // An explicit Starter override replaces the bundle lookup entirely.
  assert.deepEqual(bundledSouls({ env: { AGENT_BOT_STARTER_TEMPLATE: f.root }, root }), [f.root]);
  f.env.AGENT_BOT_STARTER_TEMPLATE = starter;
  const listed = listSoulTemplates(f.options);
  assert.deepEqual(listed.templates.map(({ name, source }) => [name, source]), [['Starter', 'bundled']]);
});

test('CLI emits the JSON contract and one plain line per template; rejects all extra arguments', (t) => {
  const f = fixture(t);
  f.pkg(join(f.root, 'Engineer.soul'));
  const cli = (...args) => spawnSync(process.execPath, [join(import.meta.dirname, '..', 'agent-bot.mjs'), 'soul', 'templates', ...args],
    { env: f.env, encoding: 'utf8', timeout: 10_000 });
  const json = cli('--json');
  assert.equal(json.status, 0, json.stderr);
  assert.deepEqual(JSON.parse(json.stdout), listSoulTemplates(f.options));
  assert.equal(json.stderr, '');
  const plain = cli();
  assert.equal(plain.status, 0, plain.stderr);
  assert.equal(plain.stdout, 'Engineer — Engineering template (codex, souls-root)\n');
  for (const args of [['extra'], ['--help'], ['--json', '--json'], ['--json', 'extra'], ['--unknown']]) {
    const bad = cli(...args);
    assert.equal(bad.status, 1);
    assert.equal(bad.stdout, '');
    assert.match(bad.stderr, /usage: agent-bot soul templates \[--json\]/);
    assert.throws(() => templateListCommand(args, f.options), /usage:/);
  }
  const spawn = spawnSync(process.execPath,
    [join(import.meta.dirname, '..', 'agent-bot.mjs'), 'soul', 'spawn', '--list', '--json'],
    { env: f.env, encoding: 'utf8', timeout: 10_000 });
  assert.equal(spawn.status, 1);
  assert.match(spawn.stderr, /usage: agent-bot soul spawn/);
});
