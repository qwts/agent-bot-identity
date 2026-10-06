import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { soulsHome } from '../souls-root.mjs';
import { loadConfig, soulsRootSetting } from '../config.mjs';
import { archiveSoulDirs, duplicateSoulDirs, locateSoulDir, orphanSoulDirs, soulDirsOf, registerSoulDir, showSoul, soulDirectory, upsertSoul } from '../agent-population.mjs';
import { soulDirInfo } from '../soul-dir.mjs';

const id = 'agent_33333333-3333-4333-8333-333333333333';
function scratch(t) {
  const home = mkdtempSync(path.join(tmpdir(), 'souls-root-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const options = { home, env: {}, config: {}, file: path.join(home, 'population.json') };
  upsertSoul({ id, name: 'test-soul', status: 'active', spacePath: path.join(home, 'space') }, { file: options.file });
  return options;
}
function mark(dir, agentId = id) {
  mkdirSync(path.join(dir, '.soul-state'), { recursive: true });
  writeFileSync(path.join(dir, '.soul-state', 'agent-id'), `${agentId}\n`);
}

test('souls root resolves environment, setting, then home default', (t) => {
  const options = scratch(t);
  const config = { settings: { soulsRoot: path.join(options.home, 'configured') } };
  assert.deepEqual(soulsHome(options), { root: path.join(options.home, '.agent-bot', 'souls'), source: 'default' });
  assert.deepEqual(soulsHome({ ...options, config }), { root: config.settings.soulsRoot, source: 'setting' });
  assert.deepEqual(soulsHome({ ...options, config, env: { AGENT_BOT_SOULS_HOME: '/tmp/env-souls' } }), { root: '/tmp/env-souls', source: 'environment' });
  mkdirSync(path.join(options.home, '.config', 'agent-bot'), { recursive: true });
  writeFileSync(path.join(options.home, '.config', 'agent-bot', 'config.json'), JSON.stringify(config));
  assert.equal(soulsHome({ home: options.home, env: {} }).root, config.settings.soulsRoot);
});

test('soulsRoot validation mirrors spacesRoot, including config load', (t) => {
  const { home } = scratch(t);
  const file = path.join(home, 'config.json');
  for (const value of [null, '', 'relative', 42, [], '/tmp/\0bad']) {
    assert.throws(() => soulsRootSetting({ settings: { soulsRoot: value } }), /settings.soulsRoot/);
    writeFileSync(file, JSON.stringify({ settings: { soulsRoot: value } }));
    assert.throws(() => loadConfig({ home, env: { AGENT_BOT_CONFIG: file } }), /settings.soulsRoot/);
  }
  assert.equal(soulsRootSetting({}), null);
});

test('registry resolves default, registered external directory, and moved directory', (t) => {
  const options = scratch(t);
  const root = soulsHome(options).root;
  assert.equal(soulDirectory(id, options), path.join(root, 'test-soul.soul'));
  const original = path.join(options.home, 'external.soul');
  mark(original);
  registerSoulDir(id, original, options);
  assert.equal(soulDirectory(id, options), original);
  const before = readFileSync(options.file, 'utf8');
  upsertSoul({ ...showSoul(id, options), soulDir: undefined }, options);
  assert.equal(readFileSync(options.file, 'utf8'), before, 'unchanged upserts with an omitted directory are idempotent');
  assert.equal(showSoul(id, options).soulDir, original, 'upserts preserve registered place');
  mkdirSync(root, { recursive: true });
  const moved = path.join(root, 'renamed.soul');
  renameSync(original, moved);
  assert.equal(soulDirectory(id, options), moved);
  assert.equal(showSoul(id, options).soulDir, moved);
  assert.equal(readFileSync(path.join(moved, '.soul-state', 'agent-id'), 'utf8').trim(), id);
  assert.throws(() => registerSoulDir(id, 'relative', options), /absolute/);
});

test('registry does not use mismatched markers or search beyond one level', (t) => {
  const options = scratch(t);
  const registered = path.join(options.home, 'wrong.soul');
  mark(registered, 'another-id');
  registerSoulDir(id, registered, options);
  const expected = path.join(soulsHome(options).root, 'test-soul.soul');
  assert.equal(soulDirectory(id, options), expected);
  rmSync(registered, { recursive: true });
  mark(path.join(soulsHome(options).root, 'nested', 'hidden.soul'));
  assert.equal(soulDirectory(id, options), expected);
});

test('a default directory another soul marked falls back to an ID-suffixed one', (t) => {
  const options = scratch(t);
  const root = soulsHome(options).root;
  mark(path.join(root, 'test-soul.soul'), 'another-id');
  assert.equal(soulDirectory(id, options), path.join(root, `test-soul-${id.slice(-8)}.soul`));
});

test('soul dir CLI prints the shared host contract without creating a soul', (t) => {
  const options = scratch(t);
  const result = spawnSync(process.execPath, [new URL('../agent-bot.mjs', import.meta.url).pathname, 'soul', 'dir', id], {
    encoding: 'utf8', env: { PATH: process.env.PATH, HOME: options.home, AGENT_BOT_POPULATION_PATH: options.file },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), soulDirInfo(id, options));
});

test('a copied soul folder is located as a copy and reported, never as the soul (#80)', (t) => {
  const options = scratch(t);
  const root = soulsHome(options).root;
  const own = path.join(root, 'Starter - Starter.soul');
  const copy = path.join(root, 'Starter - Starter copy.soul');
  mark(own);
  registerSoulDir(id, own, options);
  assert.deepEqual(duplicateSoulDirs(options), []);
  assert.deepEqual(locateSoulDir(own, options), { path: own, agentId: id, name: 'test-soul', handle: 'test-soul', soulDir: own, copies: [], status: 'installed' });
  // A Finder Duplicate copies the marker with the folder.
  mark(copy);
  assert.deepEqual(duplicateSoulDirs(options), [{ agentId: id, soulDir: own, copies: [copy] }]);
  assert.equal(locateSoulDir(own, options).status, 'installed');
  assert.deepEqual(locateSoulDir(own, options).copies, [copy]);
  const located = locateSoulDir(copy, options);
  assert.equal(located.status, 'copy');
  assert.equal(located.soulDir, own);
  assert.match(located.message, /is a copy of soul agent_33333333/);
  assert.equal(soulDirectory(id, options), own, 'the registered folder stays the soul\'s');
  assert.deepEqual(soulDirInfo(id, options).copies, [copy]);
});

test('without a registered folder, two claims are ambiguous and neither is used (#80)', (t) => {
  const options = scratch(t);
  const root = soulsHome(options).root;
  const one = path.join(root, 'one.soul');
  const two = path.join(root, 'two.soul');
  mark(one);
  mark(two);
  assert.deepEqual(duplicateSoulDirs(options), [{ agentId: id, soulDir: null, copies: [one, two] }]);
  const located = locateSoulDir(one, options);
  assert.equal(located.status, 'duplicate');
  assert.match(located.message, /2 folders claim soul/);
});

test('a folder with no marker is a package; a marker for no active soul is refused (#80)', (t) => {
  const options = scratch(t);
  const pkg = path.join(options.home, 'shared.soul');
  mkdirSync(pkg, { recursive: true });
  assert.deepEqual(locateSoulDir(pkg, options), { path: pkg, status: 'package' });
  const stranger = path.join(options.home, 'stranger.soul');
  mark(stranger, 'agent_44444444-4444-4444-8444-444444444444');
  assert.equal(locateSoulDir(stranger, options).status, 'unregistered');
  upsertSoul({ ...showSoul(id, options), status: 'retired' }, options);
  const retired = path.join(options.home, 'retired.soul');
  mark(retired);
  assert.equal(locateSoulDir(retired, options).status, 'unregistered');
});

test('a linked, oversized or non-ID marker is invalid and never quoted (#400 review)', (t) => {
  const options = scratch(t);
  const secret = path.join(options.home, 'secret.txt');
  writeFileSync(secret, 'TOP-SECRET-CONTENTS\n');
  const linked = path.join(options.home, 'linked.soul');
  mkdirSync(path.join(linked, '.soul-state'), { recursive: true });
  symlinkSync(secret, path.join(linked, '.soul-state', 'agent-id'));
  const notId = path.join(options.home, 'not-id.soul');
  mark(notId, 'TOP-SECRET-CONTENTS');
  const big = path.join(options.home, 'big.soul');
  mark(big, `${id}${' '.repeat(400)}`);
  const folder = path.join(options.home, 'folder.soul');
  mkdirSync(path.join(folder, '.soul-state', 'agent-id'), { recursive: true });
  for (const dir of [linked, notId, big, folder]) {
    const located = locateSoulDir(dir, options);
    assert.equal(located.status, 'invalid', dir);
    assert.equal(located.agentId, undefined);
    assert.doesNotMatch(JSON.stringify(located), /TOP-SECRET/);
  }
});

test('soul locate prints the JSON a host reads', (t) => {
  const options = scratch(t);
  const pkg = path.join(options.home, 'shared.soul');
  mkdirSync(pkg, { recursive: true });
  const result = spawnSync(process.execPath, [path.join(import.meta.dirname, '..', 'soul-dir.mjs'), 'locate', pkg],
    { encoding: 'utf8', env: { HOME: options.home, PATH: process.env.PATH } });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), { path: pkg, status: 'package', name: null, description: null, preferredHarnesses: [], template: null });
  const usage = spawnSync(process.execPath, [path.join(import.meta.dirname, '..', 'soul-dir.mjs'), 'locate'],
    { encoding: 'utf8', env: { HOME: options.home, PATH: process.env.PATH } });
  assert.equal(usage.status, 1);
  assert.match(usage.stderr, /^soul locate: usage/);
});

// #419: a failed launch, or a removed soul, moves every folder carrying its
// marker into the souls root's .archive, never deleting one. The archive is
// not a soul folder, so it claims nothing; a retired soul's folder shows as an
// orphan until it is archived.
test('archiving moves every folder of a soul into .archive and keeps its contents', (t) => {
  const options = scratch(t);
  const { root } = soulsHome(options);
  const own = path.join(root, 'test-soul.soul');
  const copy = path.join(root, 'test-soul copy.soul');
  const other = path.join(root, 'other.soul');
  mark(own); mark(copy); mark(other, 'agent_44444444-4444-4444-8444-444444444444');
  writeFileSync(path.join(own, 'soul.json'), '{"name":"test-soul"}\n');
  registerSoulDir(id, own, { file: options.file });
  assert.deepEqual(soulDirsOf(id, options), [copy, own].sort());
  const now = () => new Date('2026-10-03T22:10:05.123Z');
  const moved = archiveSoulDirs(id, { ...options, now });
  const archive = path.join(root, '.archive');
  assert.deepEqual(moved.map(({ from }) => from).sort(), [copy, own].sort());
  assert.deepEqual(moved.map(({ to }) => path.basename(to)).sort(),
    ['20261003T221005Z-test-soul copy.soul', '20261003T221005Z-test-soul.soul']);
  assert.ok(moved.every(({ from, to }) => !existsSync(from) && path.dirname(to) === archive));
  assert.equal(readFileSync(path.join(archive, '20261003T221005Z-test-soul.soul', 'soul.json'), 'utf8'), '{"name":"test-soul"}\n');
  assert.ok(existsSync(other));
  assert.deepEqual(soulDirsOf(id, options), []);
  mark(own);
  const again = archiveSoulDirs(id, { ...options, now });
  assert.equal(path.basename(again[0].to), '20261003T221005Z-2-test-soul.soul');
  assert.deepEqual(archiveSoulDirs(id, { ...options, now }), []);
});

test('a folder whose soul is retired or unknown is an orphan until archived', (t) => {
  const options = scratch(t);
  const { root } = soulsHome(options);
  const own = path.join(root, 'test-soul.soul');
  const stray = path.join(root, 'stray.soul');
  const strayId = 'agent_55555555-5555-4555-8555-555555555555';
  mark(own); mark(stray, strayId);
  assert.deepEqual(orphanSoulDirs(options), [{ agentId: strayId, path: stray, status: 'unknown' }]);
  upsertSoul({ id, name: 'test-soul', status: 'retired', spacePath: path.join(options.home, 'space') }, { file: options.file });
  assert.deepEqual(orphanSoulDirs(options), [
    { agentId: strayId, path: stray, status: 'unknown' },
    { agentId: id, path: own, status: 'retired' },
  ].sort((left, right) => left.path.localeCompare(right.path)));
  archiveSoulDirs(id, options);
  assert.deepEqual(orphanSoulDirs(options), [{ agentId: strayId, path: stray, status: 'unknown' }]);
});

test('locate CLI prefills package, installed and copy from their own manifest with either JSON spelling', (t) => {
  const options = scratch(t);
  const root = soulsHome(options).root;
  const own = path.join(root, 'Own.soul');
  const copy = path.join(root, 'Copy.soul');
  const pkg = path.join(root, 'Package.soul');
  mark(own);
  registerSoulDir(id, own, options);
  mark(copy);
  mkdirSync(pkg);
  for (const [dir, status] of [[pkg, 'package'], [own, 'installed'], [copy, 'copy']]) {
    const fields = { name: `${status} name`, description: 'What this soul does', preferredHarnesses: ['codex', 'claude'], template: true };
    writeFileSync(path.join(dir, 'soul.json'), JSON.stringify(fields));
    for (const flags of [[], ['--json']]) {
      const result = spawnSync(process.execPath, [path.join(import.meta.dirname, '..', 'agent-bot.mjs'), 'soul', 'locate', dir, ...flags],
        { encoding: 'utf8', env: { HOME: options.home, PATH: process.env.PATH, AGENT_BOT_POPULATION_PATH: options.file } });
      assert.equal(result.status, 0, result.stderr);
      const output = JSON.parse(result.stdout);
      assert.equal(output.status, status);
      for (const key of Object.keys(fields)) assert.deepEqual(output[key], fields[key]);
    }
  }
});

test('locate metadata tolerates missing, malformed and unsafe manifests and invalid markers', async (t) => {
  const { locateSoulInfo } = await import('../soul-dir.mjs');
  const options = scratch(t);
  const pkg = path.join(options.home, 'Package.soul');
  mkdirSync(pkg);
  const manifest = path.join(pkg, 'soul.json');
  const empty = { name: null, description: null, preferredHarnesses: [], template: null };
  const check = () => {
    const found = locateSoulInfo(pkg, options);
    for (const key of Object.keys(empty)) assert.deepEqual(found[key], empty[key]);
  };
  check();
  for (const content of ['{', 'null', '[]', '42']) { writeFileSync(manifest, content); check(); }
  writeFileSync(manifest, JSON.stringify({ name: 42, description: {}, preferredHarnesses: 'claude', template: 'true' }));
  check();
  writeFileSync(manifest, JSON.stringify({ name: 'Valid', preferredHarnesses: [], template: false }));
  assert.equal(locateSoulInfo(pkg, options).template, false);
  writeFileSync(manifest, JSON.stringify({ name: 'Valid' }));
  assert.equal(locateSoulInfo(pkg, options).template, false);
  rmSync(manifest);
  symlinkSync('/dev/zero', manifest);
  check();
  rmSync(manifest);
  writeFileSync(manifest, ' '.repeat(65537));
  check();
  mark(pkg, 'invalid marker');
  assert.equal(locateSoulInfo(pkg, options).status, 'invalid');
  check();
});
