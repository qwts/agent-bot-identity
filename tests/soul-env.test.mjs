import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mintAgentIdentity, stateDirectory } from '../agent-identity.mjs';
import { showSoul, upsertSoul } from '../agent-population.mjs';
import { initAgentSpace } from '../agent-space.mjs';
import { buildSoulDirectory } from '../soul-build.mjs';
import { CLASSIFICATIONS, SOUL_LAYOUT } from '../soul-env-contract.mjs';
import { ENV_CAPABILITIES, readSoulEnvironment, soulEnvCommand } from '../soul-env.mjs';
import { computePackageRevision, PACKAGE_IGNORE_LIST, PRIOR_PACKAGE_IGNORE_LISTS } from '../soul-package.mjs';

const ID = 'agent_12345678-1234-4234-8234-123456789abc';
const OTHER = 'agent_12345678-1234-4234-8234-123456789def';
const ROOT = fileURLToPath(new URL('..', import.meta.url));
const put = (file, contents) => { mkdirSync(path.dirname(file), { recursive: true }); writeFileSync(file, contents); };

// A real-shaped census: identity record, population row, souls root, spaces
// root and state under one temp home. `installed` writes the soul folder the
// way spawn + the first launch leave it; without it the row is fresh.
function fixture(t, { installed = true, ignore = PACKAGE_IGNORE_LIST, link = true } = {}) {
  const home = mkdtempSync(path.join(realpathSync(tmpdir()), 'soul-env-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const env = { PATH: process.env.PATH, HOME: home, XDG_STATE_HOME: path.join(home, 'state'), AGENT_BOT_SOULS_HOME: path.join(home, 'souls'),
    AGENT_BOT_SPACES_HOME: path.join(home, 'spaces'), AGENT_BOT_POPULATION_PATH: path.join(home, 'population.json'),
    AGENT_BOT_DAEMON_STATE_PATH: path.join(home, 'daemon.json'), AGENT_BOT_CONFIG: path.join(home, 'no-config') };
  const options = { env, home };
  const file = env.AGENT_BOT_POPULATION_PATH;
  const dir = path.join(env.AGENT_BOT_SOULS_HOME, 'Billy - Starter.soul');
  mintAgentIdentity({ stateDir: stateDirectory(options), idFactory: () => ID, harness: 'codex', appSlug: null, useGithub: false });
  const space = initAgentSpace(ID, options);
  upsertSoul({ id: ID, name: 'billy', displayName: 'Billy - Starter', ...(installed ? { soulDir: dir } : {}), spacePath: space.path,
    status: 'active', parentId: null, appSlug: null }, { file });
  const manifest = { formatVersion: 2, ignore, name: 'Billy - Starter', description: 'Starter instance', displaySeed: ID,
    preferredHarnesses: ['codex'], revision: `sha256:${'0'.repeat(64)}`, parentRevision: null, template: false,
    credentials: { github: { app: 'billy-app', store: 'file' } }, runtimes: { node: { version: '24.11.1' } } };
  if (installed) {
    put(path.join(dir, 'soul.json'), JSON.stringify(manifest));
    put(path.join(dir, 'AGENTS.md'), '# Billy\n');
    put(path.join(dir, 'skills', 'hello', 'SKILL.md'), '---\nname: hello\ndescription: Say hello\n---\nhi\n');
    put(path.join(dir, 'package.json'), JSON.stringify({ dependencies: { '@agentclientprotocol/codex-acp': '2.1.1' } }));
    put(path.join(dir, 'package-lock.json'), JSON.stringify({ lockfileVersion: 3, packages: {} }));
    manifest.revision = computePackageRevision(dir);
    put(path.join(dir, 'soul.json'), JSON.stringify(manifest));
    buildSoulDirectory(dir);
    put(path.join(dir, '.soul-state', 'agent-id'), `${ID}\n`);
    put(path.join(dir, '.soul-state', 'credentials', 'github-app-billy-app.json'), 'NEVER-RETURN-THIS');
    put(path.join(dir, '.soul-state', 'home', 'AGENTS.md'), '# Billy\n');
    mkdirSync(path.join(dir, '.soul-state', 'home', '.git'));
    put(path.join(dir, '.soul-state', 'home-harness'), '"codex"');
    put(path.join(dir, '.soul-state', 'home', 'node_modules', '@agentclientprotocol', 'codex-acp', 'package.json'), '{"version":"2.1.1"}');
    put(path.join(dir, '.soul-state', 'home', 'node_modules', '.bin', 'codex-acp'), '#!/bin/sh\n');
    if (link) symlinkSync(space.path, path.join(dir, '.soul-state', 'space'), 'dir');
    mkdirSync(path.join(dir, 'worktrees', 'workspace', '.git'), { recursive: true });
    put(path.join(dir, 'worktrees', 'workspace', '.git', 'HEAD'), 'ref: refs/heads/main\n');
    const checkout = path.join(home, 'Code', 'GeniusBar', '.worktrees', '34');
    put(path.join(checkout, '.git'), `gitdir: ${path.join(home, 'Code', 'GeniusBar', '.git', 'worktrees', '34')}\n`);
    put(path.join(home, 'Code', 'GeniusBar', '.git', 'worktrees', '34', 'HEAD'), 'ref: refs/heads/feature/34\n');
    symlinkSync(checkout, path.join(dir, 'worktrees', 'geniusbar-34'), 'dir');
  }
  return { home, env, options, dir, file, manifest, space: space.path };
}

// Reading must not alter any file, link or directory, nor the census.
function snapshot(root) {
  const entries = [];
  function walk(dir) {
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const file = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) { entries.push([path.relative(root, file), 'link']); continue; }
      const stat = statSync(file);
      entries.push([path.relative(root, file), stat.mode, stat.mtimeMs, entry.isFile() ? readFileSync(file).toString('base64') : null]);
      if (entry.isDirectory()) walk(file);
    }
  }
  walk(root);
  return entries;
}

const component = (result, id) => result.components.find((entry) => entry.id === id);

test('the descriptor has the complete schema v1 shape for a launched soul and reads nothing twice', (t) => {
  const f = fixture(t), before = snapshot(f.home);
  const result = readSoulEnvironment(ID, f.options);
  assert.deepEqual(snapshot(f.home), before, 'a read leaves the home byte for byte as it was');
  assert.deepEqual(Object.keys(result), ['schemaVersion', 'engine', 'identity', 'root', 'components', 'classification', 'harnesses',
    'runtimes', 'providers', 'launch', 'readiness', 'migration', 'retention', 'errors']);
  assert.equal(result.schemaVersion, 1);
  assert.deepEqual(result.engine, { version: JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version, contractVersion: 1, capabilities: [...ENV_CAPABILITIES] });
  assert.deepEqual(result.engine.capabilities, ['env', 'revision-prepare']);
  assert.deepEqual(result.identity, { agentId: ID, name: 'billy', displayName: 'Billy - Starter', status: 'active', harness: 'codex',
    genesis: { revision: null, parentSoul: null }, revision: f.manifest.revision, parentRevision: null, template: false, formatVersion: 2 });
  assert.deepEqual(result.root, { soulDir: f.dir, soulsRoot: f.env.AGENT_BOT_SOULS_HOME, source: 'environment', registered: true, marker: 'ok',
    copies: [], device: statSync(f.dir).dev });
  assert.deepEqual(result.components.map((entry) => entry.id), SOUL_LAYOUT.map((entry) => entry.id));
  for (const entry of result.components) {
    const layout = SOUL_LAYOUT.find((row) => row.id === entry.id);
    assert.deepEqual([entry.path, entry.classification, entry.retention], [layout.path, layout.classification, layout.retention], entry.id);
    assert.equal(typeof entry.present, 'boolean', entry.id);
  }
  assert.deepEqual(component(result, 'skills').entries, ['hello']);
  assert.equal(component(result, 'hooks').present, false);
  assert.equal(component(result, 'harness-pins').present, true);
  const generated = component(result, 'generated');
  assert.equal(generated.present, true);
  assert.deepEqual(generated.drift, []);
  assert.ok(generated.paths.includes('.codex/'));
  assert.equal(generated.marker, '<!-- agent-bot soul-builder: generated -->');
  const workspaces = component(result, 'workspaces');
  assert.deepEqual(workspaces.entries, [
    { name: 'geniusbar-34', path: path.join(f.dir, 'worktrees', 'geniusbar-34'), location: 'linked', target: path.join(f.home, 'Code', 'GeniusBar', '.worktrees', '34'),
      repository: path.join(f.home, 'Code', 'GeniusBar', '.git', 'worktrees', '34'), branch: 'feature/34' },
    { name: 'workspace', path: path.join(f.dir, 'worktrees', 'workspace'), location: 'inside', target: null, repository: 'own', branch: 'main' },
  ]);
  const home = component(result, 'home');
  assert.deepEqual([home.present, home.git, home.built, home.harnessInstall], [true, true, true, 'codex']);
  assert.deepEqual(component(result, 'tool-state').entries, [{ harness: 'codex', path: '.soul-state/tools/codex', routing: [], containment: 'shared-host',
    hostPath: path.join(f.home, '.codex'), signIn: 'unknown' }]);
  const credentials = component(result, 'credentials');
  assert.deepEqual([credentials.present, credentials.exportable, credentials.declared], [true, false, 'billy-app']);
  assert.ok(!JSON.stringify(result).includes('NEVER-RETURN-THIS'), 'credential contents never appear');
  const memory = component(result, 'memory');
  assert.deepEqual(memory, { id: 'memory', path: '.soul-state/space', classification: 'memory', present: true, retention: 'durable',
    location: 'linked', target: f.space, contained: false, spacePath: f.space, status: 'ok' });
  const history = component(result, 'history');
  assert.equal(history.present, false);
  assert.equal(history.external[0].what, 'revision journal');
  assert.equal(history.external[0].path, path.join(stateDirectory(f.options), 'soul-revisions', ID));
  assert.ok(history.external.every((row) => typeof row.present === 'boolean'));
  assert.deepEqual(component(result, 'temp').entries, []);
  const tools = component(result, 'host-tools');
  assert.equal(tools.present, true);
  assert.deepEqual(tools.entries.map((row) => row.name), ['agent-bot', 'agent-comms', 'git']);
  assert.equal(tools.entries[0].path, path.join(ROOT, 'agent-bot'));
  assert.deepEqual(result.classification.enum, [...CLASSIFICATIONS]);
  assert.equal(result.classification.rules.at(-1).match, 'default');
  assert.deepEqual(result.harnesses, { selected: 'codex', launchable: true,
    declared: [{ name: 'codex', kind: 'npm', package: '@agentclientprotocol/codex-acp', version: '2.1.1', source: 'package.json' }],
    installed: [{ name: 'codex', kind: 'npm', package: '@agentclientprotocol/codex-acp', version: '2.1.1', location: '.soul-state/home',
      bin: path.join(f.dir, '.soul-state', 'home', 'node_modules', '.bin', 'codex-acp'), status: 'ok' }] });
  assert.deepEqual(result.runtimes, { declared: { node: { version: '24.11.1' } }, installed: [],
    missing: [{ name: 'node', version: '24.11.1', reason: 'not provisioned' }], unsupported: [] });
  assert.deepEqual(result.providers, {});
  assert.equal(result.launch.supported, true);
  assert.equal(result.launch.lane, 'acp');
  assert.equal(result.launch.cwd, path.join(f.dir, '.soul-state', 'home'));
  assert.deepEqual(result.launch.routing, { HOME: 'host', PATH: 'host', TMPDIR: 'host' });
  assert.equal(result.launch.limitations.length, 1);
  assert.equal(result.launch.limitations[0].harness, 'codex');
  assert.match(result.launch.limitations[0].message, /shared on the host/);
  assert.deepEqual(result.readiness, { ready: true, problems: [] });
  assert.deepEqual(result.migration, { status: 'pending', journal: '.soul-state/migration.json',
    steps: [{ id: 'space-into-soul', status: 'pending', from: f.space, to: path.join(f.dir, '.soul-state', 'space') }] });
  assert.deepEqual(result.retention, {
    durable: ['manifest', 'instructions', 'skills', 'hooks', 'tools-bin', 'workflows', 'sop', 'harness-pins', 'workspaces', 'home', 'tool-state', 'credentials', 'memory', 'history'],
    reconstructible: ['generated', 'runtimes', 'cache'], disposable: ['temp'] });
  assert.deepEqual(result.errors, []);
  assert.deepEqual(readSoulEnvironment('billy', f.options), result, 'a census name resolves like an Agent ID');
  assert.deepEqual(readSoulEnvironment('Billy - Starter', f.options), result, 'so does the display name');
});

test('a fresh census row gains no directory, link or registry entry from a read', (t) => {
  const f = fixture(t, { installed: false });
  const census = readFileSync(f.file, 'utf8'), before = snapshot(f.home);
  const result = readSoulEnvironment(ID, f.options);
  assert.equal(readFileSync(f.file, 'utf8'), census, 'the census is not rewritten');
  assert.deepEqual(snapshot(f.home), before);
  assert.equal(existsSync(f.env.AGENT_BOT_SOULS_HOME), false, 'the souls root is not created');
  assert.equal(showSoul(ID, { file: f.file }).soulDir, undefined);
  assert.equal(result.root.soulDir, path.join(f.env.AGENT_BOT_SOULS_HOME, 'billy.soul'));
  assert.deepEqual([result.root.registered, result.root.marker, result.root.device], [false, 'missing', null]);
  assert.ok(result.components.every((entry) => entry.id === 'host-tools' || entry.present === false));
  assert.equal(component(result, 'memory').location, null);
  assert.equal(component(result, 'memory').contained, false);
  assert.deepEqual(result.migration, { status: 'none', journal: '.soul-state/migration.json', steps: [] });
  assert.deepEqual(result.harnesses, { selected: 'codex', declared: [], installed: [], launchable: false });
  assert.deepEqual(result.runtimes, { declared: {}, installed: [], missing: [], unsupported: [] });
  assert.deepEqual(result.readiness.problems.map((p) => [p.code, p.severity]), [['home-missing', 'warning']]);
  assert.equal(result.readiness.ready, true, 'a soul that has not launched yet is not broken');
  assert.deepEqual(result.identity.revision, null);
});

test('memory inside the soul reports contained with no migration step', (t) => {
  const f = fixture(t, { link: false });
  mkdirSync(path.join(f.dir, '.soul-state', 'space'));
  const memory = component(readSoulEnvironment(ID, f.options), 'memory');
  assert.deepEqual([memory.location, memory.target, memory.contained], ['inside', null, true]);
  assert.equal(readSoulEnvironment(ID, f.options).migration.status, 'none');
});

test('generated drift, a legacy harness install, copies and unregistered roots are reported, never fixed', (t) => {
  const f = fixture(t);
  // A skill added after the last build: its harness mirror is missing.
  put(path.join(f.dir, 'skills', 'grown', 'SKILL.md'), '---\nname: grown\ndescription: Added after the build.\n---\n# Grown\n');
  put(path.join(f.dir, '.soul-state', 'harnesses', 'node_modules', '@agentclientprotocol', 'codex-acp', 'package.json'), '{"version":"2.0.0"}');
  mkdirSync(path.join(f.dir, '.soul-state', 'tmp', 'revision-00000000-0000-4000-8000-000000000000'), { recursive: true });
  const copy = path.join(f.env.AGENT_BOT_SOULS_HOME, 'Billy - Starter copy.soul');
  put(path.join(copy, '.soul-state', 'agent-id'), `${ID}\n`);
  const before = snapshot(f.home);
  const result = readSoulEnvironment(ID, f.options);
  assert.deepEqual(snapshot(f.home), before, 'drift is reported, not rebuilt');
  assert.ok(component(result, 'generated').drift.length > 0);
  assert.deepEqual(result.readiness.problems.map((p) => p.code).sort(), ['generated-drift', 'root-duplicate']);
  assert.equal(result.readiness.problems.find((p) => p.code === 'generated-drift').action, `agent-bot soul build ${JSON.stringify(f.dir)}`);
  assert.equal(result.readiness.ready, true, 'warnings do not make a soul unready');
  assert.deepEqual(result.root.copies, [copy]);
  assert.deepEqual(result.harnesses.installed.map((row) => [row.location, row.version]), [['.soul-state/home', '2.1.1'], ['.soul-state/harnesses', '2.0.0']]);
  assert.deepEqual(result.migration.steps.map((step) => step.id), ['space-into-soul', 'harnesses-into-runtimes']);
  assert.deepEqual(component(result, 'temp').entries.map((row) => [row.name, row.kind]), [['revision-00000000-0000-4000-8000-000000000000', 'revision-staging']]);

  // A soul whose census row says another folder, and whose marker is bad.
  rmSync(copy, { recursive: true, force: true });
  rmSync(path.join(f.dir, '.soul-state', 'home', 'node_modules'), { recursive: true, force: true });
  const joined = readSoulEnvironment(ID, f.options);
  assert.equal(joined.harnesses.launchable, true, 'a joined soul launches from .soul-state/harnesses (#417)');
  rmSync(path.join(f.dir, '.soul-state', 'harnesses'), { recursive: true, force: true });
  const missing = readSoulEnvironment(ID, f.options);
  assert.deepEqual(missing.readiness.problems.map((p) => p.code).sort(), ['generated-drift', 'harness-missing']);
  assert.equal(missing.harnesses.launchable, false);
  writeFileSync(path.join(f.dir, '.soul-state', 'agent-id'), 'not-an-agent-id\n');
  const invalid = readSoulEnvironment(ID, f.options);
  assert.equal(invalid.root.marker, 'invalid');
  assert.equal(invalid.readiness.ready, false);
  assert.ok(invalid.readiness.problems.some((p) => p.code === 'marker-invalid' && p.severity === 'error'));
});

test('an unmarked generated file is a conflict, which makes the soul unready', (t) => {
  const f = fixture(t);
  writeFileSync(path.join(f.dir, 'CLAUDE.md'), 'hand edited\n');
  const result = readSoulEnvironment(ID, f.options);
  assert.equal(result.readiness.ready, false);
  assert.ok(result.readiness.problems.some((p) => p.code === 'generated-conflict' && p.severity === 'error'));
  assert.equal(component(result, 'generated').drift, null);
});

test('a soul written by an earlier release with an older ignore list still reads', (t) => {
  for (const ignore of PRIOR_PACKAGE_IGNORE_LISTS) {
    const f = fixture(t, { ignore });
    const result = readSoulEnvironment(ID, f.options);
    assert.equal(result.identity.formatVersion, 2);
    assert.deepEqual(result.errors, []);
    assert.ok(result.components.length === SOUL_LAYOUT.length);
  }
});

test('an unknown soul is a usage-level failure with a stable code; the CLI prints the schema with --json', (t) => {
  const f = fixture(t);
  assert.throws(() => readSoulEnvironment(OTHER, f.options), (error) => error.code === 'soul-not-found');
  assert.throws(() => readSoulEnvironment('nobody', f.options), (error) => error.code === 'soul-not-found');
  for (const args of [[], ['--json'], [ID, '--nope'], [ID, OTHER], [ID, '--json', '--json']]) {
    assert.throws(() => soulEnvCommand(args, { ...f.options, write: () => {} }), /usage:/);
  }
  let out = '';
  const direct = soulEnvCommand([ID, '--json'], { ...f.options, write: (value) => { out += value; } });
  assert.deepEqual(JSON.parse(out), direct);
  out = '';
  soulEnvCommand(['billy'], { ...f.options, write: (value) => { out += value; } });
  assert.match(out, /^agentId: agent_/);
  assert.match(out, /memory: present \(memory, durable\) \.soul-state\/space/);
  assert.match(out, /migration: pending \(space-into-soul\)/);
  const cli = spawnSync(process.execPath, [path.join(ROOT, 'agent-bot.mjs'), 'soul', 'env', 'billy', '--json'],
    { cwd: f.home, env: f.env, encoding: 'utf8', timeout: 20000 });
  assert.equal(cli.status, 0, cli.stderr);
  assert.deepEqual(JSON.parse(cli.stdout), direct);
  const unknown = spawnSync(process.execPath, [path.join(ROOT, 'agent-bot.mjs'), 'soul', 'env', 'nobody', '--json'],
    { cwd: f.home, env: f.env, encoding: 'utf8', timeout: 20000 });
  assert.equal(unknown.status, 1);
  assert.deepEqual(JSON.parse(unknown.stdout), { error: { code: 'soul-not-found', message: 'Soul not found.' } });
  const help = spawnSync(process.execPath, [path.join(ROOT, 'agent-bot.mjs'), 'soul', '--help'], { encoding: 'utf8', timeout: 20000 });
  assert.match(help.stdout, /agent-bot soul env <agentId\|name> \[--json\]/);
  assert.match(help.stdout, /soul revision prepare <agentId\|name>/);
});
