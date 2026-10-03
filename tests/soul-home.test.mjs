import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, renameSync, readlinkSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createSoulHomes, installHarnesses, npmCommand, soulHomePath, legacyHomePath, soulBindingForLaunch } from '../soul-home.mjs';

import { createBindingRegistry } from '../agent-binding.mjs';
import { displayName, populationFile, upsertSoul, showSoul } from '../agent-population.mjs';

function census(root) {
  const options = { env: {}, home: root, config: {} };
  options.file = populationFile(options);
  upsertSoul({ id: agentId, status: 'active', spacePath: path.join(root, 'spaces', agentId) }, { file: options.file });
  return options;
}

const agentId = 'agent_33333333-3333-4333-8333-333333333333';

function fakeBindings() {
  const bound = [];
  return { bound, bind: (entry) => { bound.push(entry); return 'secret'; },
    findAgent: (id) => { const entry = bound.findLast((b) => b.agentId === id);
      return entry ? { agentId: id, worktree: entry.worktree, file: path.join(entry.gitDir, 'agent-binding.json') } : null; } };
}

test('provisions a git home from the package once, then rebinds it', async (t) => {
  const root = mkdtempSync(path.join(tmpdir(), 'soul-home-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const pkg = path.join(root, 'pkg');
  mkdirSync(path.join(pkg, 'skills', 'hello'), { recursive: true });
  writeFileSync(path.join(pkg, 'AGENTS.md'), 'be kind\n');
  writeFileSync(path.join(pkg, 'skills', 'hello', 'SKILL.md'), 'hi\n');
  const bindings = fakeBindings();
  const installs = [];
  const options = census(root);
  const provision = createSoulHomes({ ...options, stateDir: path.join(root, 'state'), bindings, install: async (dir) => { installs.push(dir); } });
  const home = soulHomePath(agentId, options);
  const first = await provision({ agentId, harness: 'claude', packagePath: pkg });
  assert.equal(first.worktree, home);
  const directory = path.dirname(path.dirname(home));
  assert.equal(path.basename(directory), `${displayName(agentId)}.soul`);
  assert.equal(readFileSync(path.join(directory, 'AGENTS.md'), 'utf8'), 'be kind\n');
  assert.equal(readFileSync(path.join(directory, '.soul-state', 'agent-id'), 'utf8').trim(), agentId);
  assert.equal(readlinkSync(path.join(directory, '.soul-state', 'space')), path.join(root, 'spaces', agentId));
  assert.equal(statSync(path.join(directory, '.soul-state')).mode & 0o777, 0o700);
  assert.equal(statSync(path.join(directory, '.soul-state', 'agent-id')).mode & 0o777, 0o600);
  assert.equal(showSoul(agentId, { file: options.file }).soulDir, directory);
  assert.equal(readFileSync(path.join(home, 'AGENTS.md'), 'utf8'), 'be kind\n');
  assert.equal(readFileSync(path.join(home, 'skills', 'hello', 'SKILL.md'), 'utf8'), 'hi\n');
  assert.equal(bindings.bound[0].gitDir, realpathSync(path.join(home, '.git')));
  writeFileSync(path.join(home, 'AGENTS.md'), 'grown\n');
  await provision({ agentId, harness: 'claude', packagePath: pkg });
  assert.deepEqual(installs, [home], 'harnesses install once, when the home is made');
  assert.equal(readFileSync(path.join(home, 'AGENTS.md'), 'utf8'), 'grown\n', 'an existing home is never overwritten');
  assert.equal(bindings.bound.length, 2);
});

test('rejects an invalid agent ID before touching the disk', () => {
  assert.throws(() => soulHomePath('../x', { env: {}, home: '/tmp', config: {} }));
});

test('a failed harness install removes the half-made home', async (t) => {
  const root = mkdtempSync(path.join(tmpdir(), 'soul-home-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const options = census(root);
  const provision = createSoulHomes({ ...options, stateDir: root, bindings: fakeBindings(), install: async () => { throw new Error('npm said no'); } });
  await assert.rejects(provision({ agentId }), /npm said no/);
  assert.equal(existsSync(soulHomePath(agentId, options)), false);
});

test('installs pinned harnesses with npm ci, scripts off, using the host npm', async (t) => {
  const root = mkdtempSync(path.join(tmpdir(), 'soul-home-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const calls = [];
  const runImpl = async (command, args, options) => { calls.push({ command, args, cwd: options.cwd }); };
  assert.equal(await installHarnesses(root, { runImpl }), false, 'no package.json, nothing to install');
  writeFileSync(path.join(root, 'package.json'), '{}');
  await assert.rejects(installHarnesses(root, { runImpl }), /package-lock/);
  writeFileSync(path.join(root, 'package-lock.json'), '{}');
  assert.equal(await installHarnesses(root, { runImpl, node: '/app/node', env: { AGENT_BOT_NPM: '/app/npm/bin/npm-cli.js' } }), true);
  assert.deepEqual(calls, [{ command: '/app/node', args: ['/app/npm/bin/npm-cli.js', 'ci', '--ignore-scripts', '--omit=dev', '--no-audit', '--no-fund'], cwd: root }]);
  assert.deepEqual(npmCommand({}), { command: 'npm', args: [] });
});

test('two launches of the same new soul share one creation', async (t) => {
  const root = mkdtempSync(path.join(tmpdir(), 'soul-home-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  let installs = 0;
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const bindings = fakeBindings();
  const options = census(root);
  const provision = createSoulHomes({ ...options, stateDir: root, bindings, install: async () => { installs += 1; await gate; } });
  const first = provision({ agentId });
  const second = provision({ agentId });
  release();
  const [a, b] = await Promise.all([first, second]);
  assert.equal(installs, 1);
  assert.equal(a.worktree, b.worktree);
  assert.equal(existsSync(path.join(a.worktree, '.git')), true);
});

for (const crossDevice of [false, true]) {
  test(`migrates a legacy home ${crossDevice ? 'across devices with restart' : 'by atomic rename'} once`, async (t) => {
    const root = mkdtempSync(path.join(tmpdir(), 'soul-migration-'));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const options = census(root);
    const stateDir = path.join(root, 'state');
    const legacy = legacyHomePath(stateDir, agentId);
    mkdirSync(path.join(legacy, '.git'), { recursive: true });
    writeFileSync(path.join(legacy, 'memory'), 'keep me');
    const home = soulHomePath(agentId, options);
    const staging = `${home}.migrating`;
    mkdirSync(staging, { recursive: true });
    writeFileSync(path.join(staging, 'partial'), 'discard');
    let attempts = 0;
    const rename = (from, to) => {
      attempts++;
      if (crossDevice && from === legacy) throw Object.assign(new Error('different device'), { code: 'EXDEV' });
      renameSync(from, to);
    };
    const bindings = fakeBindings();
    const provision = createSoulHomes({ ...options, stateDir, bindings, rename,
      install: async () => { assert.fail('migration must not reinstall'); } });
    assert.equal((await provision({ agentId })).worktree, home);
    assert.equal(readFileSync(path.join(home, 'memory'), 'utf8'), 'keep me');
    assert.equal(existsSync(legacy), false);
    assert.equal(existsSync(staging), false);
    assert.equal(existsSync(path.join(home, 'partial')), false);
    assert.equal(readFileSync(path.join(path.dirname(home), 'migrated-from'), 'utf8').trim(), legacy);
    assert.equal(bindings.bound[0].worktree, home);
    await provision({ agentId });
    assert.equal(attempts, crossDevice ? 2 : 1);
  });
}

test('a failure promoting the cross-device copy preserves legacy and retries', async (t) => {
  const root = mkdtempSync(path.join(tmpdir(), 'soul-interrupt-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const options = census(root);
  const legacy = legacyHomePath(root, agentId);
  mkdirSync(path.join(legacy, '.git'), { recursive: true });
  writeFileSync(path.join(legacy, 'memory'), 'intact');
  let interrupted = true;
  const provision = createSoulHomes({ ...options, stateDir: root, bindings: fakeBindings(), rename: (from, to) => {
    if (from === legacy) throw Object.assign(new Error('different device'), { code: 'EXDEV' });
    if (interrupted) throw new Error('interrupted');
    renameSync(from, to);
  } });
  await assert.rejects(provision({ agentId }), /interrupted/);
  assert.equal(readFileSync(path.join(legacy, 'memory'), 'utf8'), 'intact');
  interrupted = false;
  await provision({ agentId });
  assert.equal(existsSync(legacy), false);
});

test('restart after promotion finishes binding and removes the legacy copy', async (t) => {
  const root = mkdtempSync(path.join(tmpdir(), 'soul-promoted-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const options = census(root);
  const legacy = legacyHomePath(root, agentId);
  mkdirSync(path.join(legacy, '.git'), { recursive: true });
  const bindings = fakeBindings();
  const bind = bindings.bind;
  bindings.bind = () => { throw new Error('binding interrupted'); };
  const provision = createSoulHomes({ ...options, stateDir: root, bindings, rename: (from, to) => {
    if (from === legacy) throw Object.assign(new Error('different device'), { code: 'EXDEV' });
    renameSync(from, to);
  } });
  await assert.rejects(provision({ agentId }), /binding interrupted/);
  assert.equal(existsSync(path.join(soulHomePath(agentId, options), '.git')), true);
  assert.equal(existsSync(legacy), true);
  bindings.bind = bind;
  await provision({ agentId });
  assert.equal(existsSync(legacy), false);
});

test('migration revokes legacy bindings and preserves bindings to other checkouts', async (t) => {
  const root = mkdtempSync(path.join(tmpdir(), 'soul-binding-migration-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const options = census(root);
  const legacy = legacyHomePath(root, agentId);
  mkdirSync(path.join(legacy, '.git'), { recursive: true });
  const now = new Date('2026-10-02T12:00:00.000Z');
  const bindings = createBindingRegistry({ now: () => now });
  const old = bindings.bind({ agentId, worktree: legacy, gitDir: path.join(legacy, '.git') });
  const other = bindings.bind({ agentId, worktree: '/other/checkout' });
  const provision = createSoulHomes({ ...options, stateDir: root, bindings });
  const result = await provision({ agentId });
  assert.equal(result.worktree, soulHomePath(agentId, options));
  assert.equal(bindings.resolve(old), null);
  assert.ok(bindings.resolve(other));
  assert.equal(existsSync(result.file), true);
});

test('launch migrates a live legacy binding and reprovisions the new home for recovery', async (t) => {
  const root = mkdtempSync(path.join(tmpdir(), 'soul-launch-migration-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const options = census(root);
  const legacy = legacyHomePath(root, agentId);
  mkdirSync(path.join(legacy, '.git'), { recursive: true });
  writeFileSync(path.join(legacy, 'memory'), 'keep');
  const bindings = createBindingRegistry();
  bindings.bind({ agentId, worktree: legacy, gitDir: path.join(legacy, '.git') });
  const provision = createSoulHomes({ ...options, stateDir: root, bindings });
  const lookup = () => soulBindingForLaunch(agentId, { stateDir: root, bindings, provision, harness: 'claude' });
  const bound = await lookup();
  assert.equal(bound.worktree, soulHomePath(agentId, options));
  assert.equal(readFileSync(path.join(bound.worktree, 'memory'), 'utf8'), 'keep');
  assert.equal(existsSync(legacy), false);
  // Model a process stopped after promotion/rebind, before old-copy cleanup.
  mkdirSync(path.join(legacy, '.git'), { recursive: true });
  await lookup();
  assert.equal(existsSync(legacy), false);
  const checkout = path.join(root, 'checkout');
  mkdirSync(checkout);
  const external = { worktree: checkout, file: '/binding' };
  assert.equal(soulBindingForLaunch(agentId, { stateDir: root,
    bindings: { findAgent: () => external }, provision: () => assert.fail('live checkout must be kept') }), external);
});
