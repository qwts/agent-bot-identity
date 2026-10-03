import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { soulsHome } from '../souls-root.mjs';
import { loadConfig, soulsRootSetting } from '../config.mjs';
import { registerSoulDir, showSoul, soulDirectory, upsertSoul } from '../agent-population.mjs';
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
