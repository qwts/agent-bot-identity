import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, renameSync, readlinkSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createSoulHomes, installHarnesses, installSoulHarnesses, soulHarnessesPath, npmCommand, soulHomePath, legacyHomePath, soulBindingForLaunch } from '../soul-home.mjs';

import { GENERATED_HARNESS_MARKER, PACKAGE_IGNORE_LIST, PRIOR_PACKAGE_IGNORE_LISTS } from '../soul-package.mjs';
import { createBindingRegistry } from '../agent-binding.mjs';
import { mintAgentIdentity } from '../agent-identity.mjs';
import { displayName, populationFile, upsertSoul, showSoul } from '../agent-population.mjs';

function census(root) {
  const options = { env: {}, home: root, config: {}, stateDir: root };
  mintAgentIdentity({ ...options, idFactory: () => agentId, harness: 'claude', useGithub: false });
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
  writeFileSync(path.join(pkg, 'skills', 'hello', 'SKILL.md'), '---\nname: hello\ndescription: Say hello\n---\nhi\n');
  writeFileSync(path.join(pkg, 'soul.json'), JSON.stringify({ formatVersion: 2, name: 'test', description: 'test', displaySeed: 'test', preferredHarnesses: [], parentRevision: null, revision: `sha256:${'0'.repeat(64)}`, ignore: PACKAGE_IGNORE_LIST }));
  pinnedPackage(pkg);
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
  assert.match(readFileSync(path.join(home, 'skills', 'hello', 'SKILL.md'), 'utf8'), /hi\n$/);
  assert.equal(readFileSync(path.join(home, 'CLAUDE.md'), 'utf8'), `${GENERATED_HARNESS_MARKER}\n@AGENTS.md\n`);
  assert.equal(bindings.bound[0].gitDir, realpathSync(path.join(home, '.git')));
  writeFileSync(path.join(home, 'AGENTS.md'), 'grown\n');
  await provision({ agentId, harness: 'claude', packagePath: pkg });
  assert.deepEqual(installs, [home], 'harnesses install once, when the home is made');
  assert.equal(readFileSync(path.join(home, 'AGENTS.md'), 'utf8'), 'grown\n', 'an existing home is never overwritten');
  assert.equal(bindings.bound.length, 2);
});

test('an existing home is rebuilt before a launch; a conflict is reported and the launch proceeds', async (t) => {
  const root = mkdtempSync(path.join(tmpdir(), 'soul-home-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const pkg = path.join(root, 'pkg');
  mkdirSync(pkg, { recursive: true });
  writeFileSync(path.join(pkg, 'AGENTS.md'), 'be kind\n');
  // The ignore list a release before 0.10.25 wrote: such a soul must still build.
  writeFileSync(path.join(pkg, 'soul.json'), JSON.stringify({ formatVersion: 2, name: 'test', description: 'test', displaySeed: 'test', preferredHarnesses: [], parentRevision: null, revision: `sha256:${'0'.repeat(64)}`, ignore: PRIOR_PACKAGE_IGNORE_LISTS.at(-1) }));
  pinnedPackage(pkg);
  const warnings = [];
  const options = census(root);
  const provision = createSoulHomes({ ...options, stateDir: path.join(root, 'state'), bindings: fakeBindings(), install: async () => {}, warn: (m) => warnings.push(m) });
  const home = soulHomePath(agentId, options);
  await provision({ agentId, harness: 'claude', packagePath: pkg });
  assert.ok(existsSync(path.join(home, '.mcp.json')), 'a new home carries the MCP entry');
  // An older home: made before the builder rendered the MCP entry.
  rmSync(path.join(home, '.mcp.json'));
  await provision({ agentId, harness: 'claude', packagePath: pkg });
  assert.ok(existsSync(path.join(home, '.mcp.json')), 'the next launch renders what the builder adds now');
  assert.deepEqual(warnings, []);
  // A hand-edited generated file is a conflict: reported, and the launch still binds.
  writeFileSync(path.join(home, 'CLAUDE.md'), 'mine\n');
  const bound = await provision({ agentId, harness: 'claude', packagePath: pkg });
  assert.equal(bound.worktree, home);
  assert.equal(readFileSync(path.join(home, 'CLAUDE.md'), 'utf8'), 'mine\n', 'the conflict is left alone');
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /was not rebuilt: .*CLAUDE\.md/);
});

test('rejects an invalid agent ID before touching the disk', () => {
  assert.throws(() => soulHomePath('../x', { env: {}, home: '/tmp', config: {} }));
});

test('a failed harness install removes the half-made home', async (t) => {
  const root = mkdtempSync(path.join(tmpdir(), 'soul-home-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const options = census(root);
  const provision = createSoulHomes({ ...options, stateDir: root, bindings: fakeBindings(), install: async () => { throw new Error('npm said no'); } });
  const pkg = pinnedPackage(path.join(root, 'pkg'));
  await assert.rejects(provision({ agentId, packagePath: pkg }), /npm said no/);
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
  const pkg = pinnedPackage(path.join(root, 'pkg'));
  const first = provision({ agentId, packagePath: pkg });
  const second = provision({ agentId, packagePath: pkg });
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

const claudePackage = '@zed-industries/claude-code-acp';
const codexPackage = '@agentclientprotocol/codex-acp';

function pinnedPackage(directory) {
  mkdirSync(directory, { recursive: true });
  const dependencies = { [claudePackage]: '0.16.1', [codexPackage]: '2.1.0' };
  const manifest = { name: 'two-adapters', private: true, dependencies,
    devDependencies: { tooling: '1.0.0' }, optionalDependencies: { unrelated: '1.0.0' },
    peerDependencies: { unrelated: '1.0.0' }, workspaces: ['extra/*'] };
  const entry = (fields = {}) => ({ version: '1.0.0', resolved: 'https://example.invalid/pinned.tgz', integrity: 'sha512-pin', ...fields });
  const packages = {
    '': manifest,
    [`node_modules/${claudePackage}`]: entry({ version: '0.16.1', dependencies: { shared: '1.0.0', 'claude-only': '1.0.0', nested: '2.0.0' } }),
    [`node_modules/${codexPackage}`]: entry({ version: '2.1.0', dependencies: { shared: '1.0.0', 'codex-only': '1.0.0', nested: '1.0.0' } }),
    'node_modules/shared': entry({ peerDependencies: { peer: '1.0.0', absent: '*' }, peerDependenciesMeta: { absent: { optional: true } } }),
    'node_modules/peer': entry({ dependencies: { shared: '1.0.0' } }), // cycle
    'node_modules/claude-only': entry({ optionalDependencies: { platform: '1.0.0', missing: '*' } }),
    'node_modules/codex-only': entry(),
    'node_modules/platform': entry({ optional: true, os: ['darwin'] }),
    [`node_modules/${claudePackage}/node_modules/nested`]: entry({ version: '2.0.0', dependencies: { shared: '1.0.0' } }),
    'node_modules/nested': entry(),
    'node_modules/tooling': entry({ dev: true }),
    'node_modules/unrelated': entry(),
  };
  writeFileSync(path.join(directory, 'package.json'), JSON.stringify(manifest));
  writeFileSync(path.join(directory, 'package-lock.json'), JSON.stringify({ name: manifest.name, lockfileVersion: 3, requires: true, packages }));
  return directory;
}

for (const harness of ['claude', 'codex']) {
  test(`installs only ${harness}'s locked adapter and reachable dependencies`, async (t) => {
    const root = mkdtempSync(path.join(tmpdir(), 'soul-prune-'));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const options = census(root);
    const source = pinnedPackage(path.join(root, 'pkg'));
    const original = readFileSync(path.join(source, 'package-lock.json'), 'utf8');
    const calls = [];
    const dir = await installSoulHarnesses(agentId, source, { ...options, harness,
      install: (directory, opts) => installHarnesses(directory, { ...opts,
        runImpl: async (command, args, settings) => calls.push({ command, args, cwd: settings.cwd }) }) });
    assert.equal(dir, soulHarnessesPath(agentId, options));
    const manifest = JSON.parse(readFileSync(path.join(dir, 'package.json')));
    const lock = JSON.parse(readFileSync(path.join(dir, 'package-lock.json')));
    const adapter = harness === 'claude' ? claudePackage : codexPackage;
    assert.deepEqual(manifest.dependencies, { [adapter]: harness === 'claude' ? '0.16.1' : '2.1.0' }, 'template pins win over registry versions');
    for (const field of ['devDependencies', 'optionalDependencies', 'peerDependencies', 'workspaces']) assert.equal(manifest[field], undefined);
    assert.deepEqual(lock.packages[''].dependencies, manifest.dependencies);
    const wanted = ['', `node_modules/${adapter}`, 'node_modules/shared', 'node_modules/peer',
      ...(harness === 'claude' ? ['node_modules/claude-only', 'node_modules/platform', `node_modules/${claudePackage}/node_modules/nested`]
        : ['node_modules/codex-only', 'node_modules/nested'])];
    assert.deepEqual(Object.keys(lock.packages).sort(), wanted.sort());
    const sourceLock = JSON.parse(original);
    for (const location of wanted.filter(Boolean)) assert.deepEqual(lock.packages[location], sourceLock.packages[location]);
    assert.equal(readFileSync(path.join(source, 'package-lock.json'), 'utf8'), original);
    assert.equal(Object.keys(JSON.parse(readFileSync(path.join(source, 'package.json'))).dependencies).length, 2);
    assert.deepEqual(calls, [{ command: 'npm', args: ['ci', '--ignore-scripts', '--omit=dev', '--no-audit', '--no-fund'], cwd: dir }]);
  });
}

test('unknown and adapter-free harnesses, missing pins and absent package files install nothing', async (t) => {
  const root = mkdtempSync(path.join(tmpdir(), 'soul-no-adapter-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const options = census(root);
  const source = pinnedPackage(path.join(root, 'pkg'));
  const install = async () => assert.fail('nothing to install');
  for (const harness of ['unknown', 'muse', 'opencode']) {
    assert.equal(await installSoulHarnesses(agentId, source, { ...options, harness, install }), null);
  }
  writeFileSync(path.join(source, 'package.json'), '{}');
  assert.equal(await installSoulHarnesses(agentId, source, { ...options, harness: 'claude', install }), null);
  assert.equal(await installSoulHarnesses(agentId, null, { ...options, install }), null);
  rmSync(path.join(source, 'package-lock.json'));
  assert.equal(await installSoulHarnesses(agentId, source, { ...options, install }), null);
  assert.equal(existsSync(soulHarnessesPath(agentId, options)), false);
});

test('an omitted harness uses the identity record', async (t) => {
  const root = mkdtempSync(path.join(tmpdir(), 'soul-population-harness-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const options = census(root);
  const source = pinnedPackage(path.join(root, 'pkg'));
  const dir = await installSoulHarnesses(agentId, source, { ...options, install: async () => {} });
  assert.deepEqual(JSON.parse(readFileSync(path.join(dir, 'package.json'))).dependencies, { [claudePackage]: '0.16.1' });
});

test('invalid or incomplete adapter locks fail before npm runs', async (t) => {
  const root = mkdtempSync(path.join(tmpdir(), 'soul-bad-lock-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const options = census(root);
  const source = pinnedPackage(path.join(root, 'pkg'));
  const lockPath = path.join(source, 'package-lock.json');
  const lock = JSON.parse(readFileSync(lockPath));
  delete lock.packages['node_modules/shared'];
  writeFileSync(lockPath, JSON.stringify(lock));
  await assert.rejects(installSoulHarnesses(agentId, source, { ...options, install: async () => assert.fail('bad lock') }), /missing shared/);
  lock.lockfileVersion = 1;
  writeFileSync(lockPath, JSON.stringify(lock));
  await assert.rejects(installSoulHarnesses(agentId, source, options), /v3 package-lock/);
});

test('home relaunch switches harnesses, retries failures and skips unchanged installs', async (t) => {
  const root = mkdtempSync(path.join(tmpdir(), 'soul-switch-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const options = census(root);
  const source = pinnedPackage(path.join(root, 'pkg'));
  const bindings = fakeBindings();
  const seen = [];
  let fail = false;
  const provision = createSoulHomes({ ...options, stateDir: root, bindings, install: async (dir) => {
    const deps = JSON.parse(readFileSync(path.join(dir, 'package.json'))).dependencies;
    seen.push(Object.keys(deps));
    if (fail) throw new Error('install failed');
    mkdirSync(path.join(dir, 'node_modules'), { recursive: true });
  } });
  await provision({ agentId, packagePath: source });
  const launch = (harness) => soulBindingForLaunch(agentId, { stateDir: root, bindings, provision, harness });
  await launch('claude');
  fail = true;
  await assert.rejects(launch('codex'), /install failed/);
  fail = false;
  await launch('claude');
  await launch('codex');
  await launch('codex');
  assert.deepEqual(seen, [[claudePackage], [codexPackage], [claudePackage], [codexPackage]]);
  const home = soulHomePath(agentId, options);
  assert.deepEqual(JSON.parse(readFileSync(path.join(home, 'package.json'))).dependencies, { [codexPackage]: '2.1.0' });
  await launch('muse');
  assert.equal(existsSync(path.join(home, 'node_modules')), false);
  assert.equal(seen.length, 4);
});

test('a live checkout prepares the launch harness without replacing its binding', async (t) => {
  const root = mkdtempSync(path.join(tmpdir(), 'soul-live-harness-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const binding = { worktree: root, file: '/binding' };
  const calls = [];
  const result = await soulBindingForLaunch(agentId, { stateDir: root, harness: 'codex',
    bindings: { findAgent: () => binding }, provision: () => assert.fail('live binding'),
    prepareHarness: async (...args) => calls.push(args) });
  assert.equal(result, binding);
  assert.deepEqual(calls, [[agentId, 'codex', root]]);
});
