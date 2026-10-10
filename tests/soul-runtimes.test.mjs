import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn as spawnChild, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mintAgentIdentity, stateDirectory } from '../agent-identity.mjs';
import { auditFile } from '../agent-principals.mjs';
import { upsertSoul } from '../agent-population.mjs';
import { initAgentSpace } from '../agent-space.mjs';
import { RUNTIME_CATALOG, RUNTIME_NAMES, RUNTIME_PLATFORMS, SHA256_HEX, hostPlatform, newestPin, normalizeHarnessInstall, normalizeRuntimeDeclaration, resolveCatalogPin, versionMatches } from '../runtime-catalog.mjs';
import { computePackageRevision, PACKAGE_IGNORE_LIST, validateRuntimesDeclaration, validateSoulPackage } from '../soul-package.mjs';
import { INSTALL_STAMP, RUNTIME_ERROR_CODES, downloadCacheDir, fetchArchive, inspectRuntimeOverrides, inspectSoulRuntimes, installSoulRuntimes, pendingSoulRuntimes, runtimeLaunchEnv, soulRuntimeEnv, soulRuntimesCommand } from '../soul-runtimes.mjs';
import { createAcpExecutor } from '../acp-engine.mjs';
import { createLaunchHandler } from '../daemon-launch.mjs';
import { acpExecutorFor, coldTurnExecutor } from '../wake-plane.mjs';
import { createResumeExecutor } from '../wake-resume.mjs';

const ID = 'agent_12345678-1234-4234-8234-123456789abc';
const ROOT = fileURLToPath(new URL('..', import.meta.url));
const PLATFORM = 'darwin-arm64';
// A script is written executable, as a real archive or uv install carries it.
const put = (file, contents) => { mkdirSync(path.dirname(file), { recursive: true }); writeFileSync(file, contents, { mode: String(contents).startsWith('#!') ? 0o755 : 0o644 }); };
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const NODE = resolveCatalogPin('node', '24');
const GO = resolveCatalogPin('go', '1');
const UV = newestPin('uv');
const PYTHON = resolveCatalogPin('python', '3.12');

// A fake archive is JSON naming its files; the fake `tar` below unpacks it.
const archive = (files) => Buffer.from(JSON.stringify(files));
const NODE_ARCHIVE = archive({ [`node-v${NODE.version}-darwin-arm64/bin/node`]: '#!/bin/sh\n', [`node-v${NODE.version}-darwin-arm64/bin/npm`]: '#!/bin/sh\n' });
const GO_ARCHIVE = archive({ 'go/bin/go': '#!/bin/sh\n', 'go/VERSION': `go${GO.version}` });
const UV_ARCHIVE = archive({ [`uv-aarch64-apple-darwin/uv`]: '#!/bin/sh\n', [`uv-aarch64-apple-darwin/uvx`]: '#!/bin/sh\n' });
const OPENCODE_ARCHIVE = archive({ opencode: '#!/bin/sh\n' });

// A catalog shaped like the real one, with digests of the fake archives, so
// a test never downloads and the real pins stay what the catalog says.
function fakeCatalog() {
  const source = (bytes, bin) => Object.fromEntries(RUNTIME_PLATFORMS.map((platform) => [platform, { url: `https://example.test/${platform}/${sha(bytes).slice(0, 8)}.tar.gz`, sha256: sha(bytes), bin }]));
  return {
    node: [{ version: NODE.version, sources: source(NODE_ARCHIVE, 'bin') }],
    go: [{ version: GO.version, sources: source(GO_ARCHIVE, 'bin') }],
    uv: [{ version: UV.version, sources: source(UV_ARCHIVE, '.') }],
    python: [{ version: PYTHON.version, via: 'uv', sources: null }],
  };
}

// fetch and run doubles: `fetched` counts downloads per URL; `commands`
// records every process the provisioner would start.
function doubles({ archives, fail = {} } = {}) {
  const fetched = [], commands = [];
  const fetchFn = async (url) => {
    fetched.push(url);
    if (fail[url] === 'offline') throw new Error('getaddrinfo ENOTFOUND');
    if (fail[url] === '404') return { ok: false, status: 404, body: null };
    const bytes = archives[url];
    if (!bytes) throw new Error(`unexpected download ${url}`);
    return { ok: true, status: 200, body: bytes };
  };
  const runImpl = async (command, args, options = {}) => {
    commands.push({ command: path.basename(command), args, env: options.env ?? null });
    if (command === 'tar') {
      const files = JSON.parse(readFileSync(args[1], 'utf8'));
      if (files.corrupt) throw Object.assign(new Error('tar failed'), { stderr: 'tar: Unrecognized archive format' });
      for (const [name, contents] of Object.entries(files)) put(path.join(args[3], name), contents);
      return { stdout: '', stderr: '' };
    }
    if (args[0] === 'python' && args[1] === 'install') {
      const dir = args[args.indexOf('--install-dir') + 1];
      if (options.env?.UV_FAIL) throw Object.assign(new Error('uv failed'), { stderr: 'error: No download found for request' });
      put(path.join(dir, `cpython-${args[2]}-macos-aarch64-none`, 'bin', 'python3'), '#!/bin/sh\n');
      return { stdout: '', stderr: '' };
    }
    if (args[0] === 'tool' && args[1] === 'install') {
      put(path.join(options.env.UV_TOOL_BIN_DIR, 'goose'), '#!/bin/sh\n');
      put(path.join(options.env.UV_TOOL_DIR, 'goose-ai', 'bin', 'python'), '#!/bin/sh\n');
      return { stdout: '', stderr: '' };
    }
    throw new Error(`unexpected command ${command} ${args.join(' ')}`);
  };
  return { fetchFn, runImpl, fetched, commands };
}

function fixture(t, { manifest = {}, census = false } = {}) {
  const home = mkdtempSync(path.join(realpathSync(tmpdir()), 'soul-runtimes-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const env = { PATH: '/usr/bin:/bin', HOME: home, AGENT_BOT_CACHE_HOME: path.join(home, 'cache'), XDG_STATE_HOME: path.join(home, 'state'),
    AGENT_BOT_SOULS_HOME: path.join(home, 'souls'), AGENT_BOT_SPACES_HOME: path.join(home, 'spaces'), AGENT_BOT_POPULATION_PATH: path.join(home, 'population.json'),
    AGENT_BOT_DAEMON_STATE_PATH: path.join(home, 'daemon.json'), AGENT_BOT_CONFIG: path.join(home, 'no-config') };
  const dir = path.join(env.AGENT_BOT_SOULS_HOME, 'Billy.soul');
  const soul = { formatVersion: 2, ignore: PACKAGE_IGNORE_LIST, name: 'Billy', description: 'Test', displaySeed: 'billy', preferredHarnesses: ['opencode'],
    revision: `sha256:${'0'.repeat(64)}`, parentRevision: null, ...manifest };
  put(path.join(dir, 'soul.json'), JSON.stringify(soul));
  put(path.join(dir, 'AGENTS.md'), '# Billy\n');
  put(path.join(dir, '.soul-state', 'agent-id'), `${ID}\n`);
  const catalog = fakeCatalog();
  const archives = {};
  for (const [bytes, pins] of [[NODE_ARCHIVE, catalog.node], [GO_ARCHIVE, catalog.go], [UV_ARCHIVE, catalog.uv]]) {
    for (const pin of pins) for (const source of Object.values(pin.sources)) archives[source.url] = bytes;
  }
  const options = { env, home, platform: PLATFORM, catalog };
  if (census) {
    mintAgentIdentity({ stateDir: stateDirectory({ env, home }), idFactory: () => ID, harness: 'opencode', appSlug: null, useGithub: false });
    const space = initAgentSpace(ID, { env, home });
    upsertSoul({ id: ID, name: 'billy', displayName: 'Billy', soulDir: dir, spacePath: space.path, status: 'active', parentId: null, appSlug: null }, { file: env.AGENT_BOT_POPULATION_PATH });
  }
  const writeManifest = (change) => { change(soul); put(path.join(dir, 'soul.json'), JSON.stringify(soul)); };
  return { home, env, dir, soul, catalog, archives, options, writeManifest, runtimes: path.join(dir, '.soul-state', 'runtimes'), cache: path.join(home, 'cache', 'downloads') };
}

const tree = (dir) => (existsSync(dir) ? readdirSync(dir, { recursive: true }).map(String).filter((p) => !p.includes('cpython') || p.endsWith('python3')).sort() : null);

test('the catalog pins one version per supported major with an https URL and a 64-hex sha256 for every platform', () => {
  assert.deepEqual(Object.keys(RUNTIME_CATALOG).sort(), ['go', 'node', 'python', 'uv']);
  for (const [name, pins] of Object.entries(RUNTIME_CATALOG)) {
    assert.ok(pins.length >= 1, name);
    const majors = new Set();
    for (const pin of pins) {
      assert.match(pin.version, /^\d+\.\d+\.\d+$/, `${name} ${pin.version}`);
      const major = name === 'python' ? pin.version.split('.').slice(0, 2).join('.') : pin.version.split('.')[0];
      assert.ok(!majors.has(major), `${name} pins ${major} once`);
      majors.add(major);
      if (name === 'python') { assert.equal(pin.via, 'uv'); assert.equal(pin.sources, null); continue; }
      assert.deepEqual(Object.keys(pin.sources).sort(), [...RUNTIME_PLATFORMS].sort(), `${name} ${pin.version} covers every platform`);
      for (const [platform, source] of Object.entries(pin.sources)) {
        assert.match(source.url, /^https:\/\/(nodejs\.org|go\.dev|github\.com\/astral-sh)\//, `${name} ${platform}`);
        assert.match(source.sha256, SHA256_HEX, `${name} ${platform}`);
        assert.ok(['bin', '.'].includes(source.bin));
        assert.ok(source.url.includes(pin.version), `${name} ${platform} names its version`);
      }
    }
  }
  assert.deepEqual(RUNTIME_CATALOG.node.map((pin) => pin.version.split('.')[0]), ['22', '24']);
  assert.deepEqual(RUNTIME_CATALOG.python.map((pin) => pin.version.split('.').slice(0, 2).join('.')), ['3.12', '3.13']);
  assert.ok(new Set(Object.values(RUNTIME_CATALOG).flat().flatMap((pin) => Object.values(pin.sources ?? {}).map((s) => s.sha256))).size === 20, 'twenty distinct digests');
  assert.equal(hostPlatform({ platform: 'darwin', arch: 'arm64' }), 'darwin-arm64');
  assert.equal(hostPlatform({ platform: 'freebsd', arch: 'x64' }), null);
  assert.equal(hostPlatform({ platform: 'win32', arch: 'x64' }), 'win32-x64');
});

test('a declared version is a major, a range of one, or exact, and resolves to the newest matching pin', () => {
  assert.equal(resolveCatalogPin('node', '24').version, RUNTIME_CATALOG.node.at(-1).version);
  assert.equal(resolveCatalogPin('node', '24.x').version, RUNTIME_CATALOG.node.at(-1).version);
  assert.equal(resolveCatalogPin('node', '22').version, RUNTIME_CATALOG.node[0].version);
  assert.equal(resolveCatalogPin('node', RUNTIME_CATALOG.node[1].version).version, RUNTIME_CATALOG.node[1].version);
  assert.equal(resolveCatalogPin('node', '24.0.0'), null, 'an exact version the catalog does not pin');
  assert.equal(resolveCatalogPin('node', '20'), null);
  assert.equal(resolveCatalogPin('python', '3.12').version, RUNTIME_CATALOG.python[0].version);
  assert.equal(resolveCatalogPin('python', '3').version, RUNTIME_CATALOG.python.at(-1).version, 'the newest minor');
  assert.equal(resolveCatalogPin('go', '1').version, RUNTIME_CATALOG.go[0].version);
  assert.equal(resolveCatalogPin('go', '>=1.20'), null, 'comparators are not ranges');
  assert.equal(resolveCatalogPin('ruby', '3'), null);
  assert.ok(versionMatches('24', '24.21.0') && versionMatches('24.21', '24.21.0') && !versionMatches('24.2', '24.21.0') && !versionMatches('2', '24.21.0'));
  assert.deepEqual(normalizeRuntimeDeclaration('node', '24'), { version: '24', via: null, sources: null });
  assert.deepEqual(normalizeRuntimeDeclaration('python', { version: '3.12', via: 'uv' }), { version: '3.12', via: 'uv', sources: null });
  const sources = { 'darwin-arm64': { url: 'https://example.com/n.tgz', sha256: 'a'.repeat(64) }, 'win32-x64': { url: 'https://example.com/n.zip', sha256: 'b'.repeat(64) } };
  assert.deepEqual(normalizeRuntimeDeclaration('node', { version: '24.21.0', sources }).sources,
    { 'darwin-arm64': { url: 'https://example.com/n.tgz', sha256: 'a'.repeat(64), bin: 'bin' }, 'win32-x64': { url: 'https://example.com/n.zip', sha256: 'b'.repeat(64), bin: '.' } });
  for (const [name, value, message] of [
    ['node', '24.x.1', /version or range/], ['node', '^24', /version or range/], ['node', 24, /version string or an object/], ['node', { version: '24', extra: 1 }, /extra is unknown/],
    ['node', { version: '24', sources }, /must be exact when sources/], ['node', { version: '24.21.0', sources: {} }, /map platforms/],
    ['node', { version: '24.21.0', sources: { 'plan9-x64': sources['darwin-arm64'] } }, /not a platform/],
    ['node', { version: '24.21.0', sources: { 'darwin-arm64': { url: 'http://example.com/n.tgz', sha256: 'a'.repeat(64) } } }, /https URL/],
    ['node', { version: '24.21.0', sources: { 'darwin-arm64': { url: 'https://example.com/n.tgz', sha256: 'A'.repeat(64) } } }, /64 lowercase hex/],
    ['node', { version: '24.21.0', sources: { 'darwin-arm64': { url: 'https://example.com/n.tgz', sha256: 'a'.repeat(64), md5: 'x' } } }, /md5 is unknown/],
    ['python', { version: '3.12', via: 'pyenv' }, /via must be "uv"/], ['python', { version: '3.12', sources }, /uv provides python/], ['go', { version: '1', via: 'uv' }, /via is unknown/],
    ['ruby', '3', /not a runtime/],
  ]) assert.throws(() => normalizeRuntimeDeclaration(name, value), message, `${name} ${JSON.stringify(value)}`);
  assert.deepEqual(normalizeHarnessInstall({ kind: 'archive', version: '1.2.3', url: 'https://example.com/{platform}/{version}.zip', sha256: { 'darwin-arm64': 'a'.repeat(64) } }, 'x', { defaultBin: 'opencode' }),
    { kind: 'archive', version: '1.2.3', url: 'https://example.com/{platform}/{version}.zip', sha256: { 'darwin-arm64': 'a'.repeat(64) }, bin: 'opencode' });
  assert.deepEqual(normalizeHarnessInstall({ kind: 'uv-tool', package: 'goose-ai', version: '1.9.0', bin: 'goose' }, 'x'), { kind: 'uv-tool', package: 'goose-ai', version: '1.9.0', bin: 'goose' });
  for (const [value, message] of [
    [{ kind: 'npm' }, /kind must be archive or uv-tool/], [{ kind: 'archive', version: '1', url: 'https://e.com/a', sha256: {}, bin: 'a' }, /sha256 must map platforms/],
    [{ kind: 'archive', version: '1', url: 'https://e.com/a', sha256: { 'darwin-arm64': 'a'.repeat(64) }, extra: 1 }, /extra is unknown/],
    [{ kind: 'archive', version: '1', url: { 'linux-x64': 'https://e.com/a' }, sha256: { 'darwin-arm64': 'a'.repeat(64) }, bin: 'a' }, /linux-x64 has no sha256/],
    [{ kind: 'archive', version: '1', url: 'ftp://e.com/a', sha256: { 'darwin-arm64': 'a'.repeat(64) }, bin: 'a' }, /https URL/],
    [{ kind: 'uv-tool', package: 'goose ai', version: '1', bin: 'g' }, /PyPI package name/], [{ kind: 'uv-tool', package: 'goose-ai', version: 'latest', bin: 'g' }, /exact version/],
    [{ kind: 'uv-tool', package: 'goose-ai', version: '1' }, /bin must name the executable/], [{ kind: 'uv-tool', package: 'goose-ai', version: '1', bin: '../x' }, /executable name/],
  ]) assert.throws(() => normalizeHarnessInstall(value, 'x'), message, JSON.stringify(value));
});

test('soul.json validates runtimes and harnesses.<h>.install strictly, and explicit sources change the revision', (t) => {
  const f = fixture(t);
  const seal = () => f.writeManifest((m) => { m.revision = computePackageRevision(f.dir); });
  seal();
  const base = validateSoulPackage(f.dir).revision;
  f.writeManifest((m) => { m.runtimes = { node: '24', python: '3.12', go: '1.x' }; });
  seal();
  const declared = validateSoulPackage(f.dir).revision;
  assert.notEqual(declared, base, 'a declaration is definition');
  const sources = { 'darwin-arm64': { url: 'https://example.com/node.tgz', sha256: 'a'.repeat(64) } };
  f.writeManifest((m) => { m.runtimes = { node: { version: '24.21.0', sources }, python: '3.12', go: '1.x' }; });
  seal();
  const pinned = validateSoulPackage(f.dir).revision;
  assert.notEqual(pinned, declared, 'explicit sources change the revision');
  f.writeManifest((m) => { m.runtimes.node.sources['darwin-arm64'].sha256 = 'b'.repeat(64); });
  seal();
  assert.notEqual(validateSoulPackage(f.dir).revision, pinned, 'so does one digest');
  f.writeManifest((m) => { m.harnesses = { opencode: { install: { kind: 'archive', version: '1.2.3', url: 'https://example.com/opencode-{platform}.zip', sha256: { 'darwin-arm64': 'c'.repeat(64) } } },
    muse: { install: { kind: 'uv-tool', package: 'muse-cli', version: '2.0.0', bin: 'muse' } } }; });
  seal();
  assert.ok(validateSoulPackage(f.dir).revision);
  const refused = (change, message) => {
    const before = JSON.stringify(f.soul);
    f.writeManifest(change);
    assert.throws(() => { seal(); validateSoulPackage(f.dir); }, message, before);
    for (const key of Object.keys(f.soul)) delete f.soul[key];
    Object.assign(f.soul, JSON.parse(before));
    f.writeManifest(() => {});
  };
  refused((m) => { m.runtimes = { ruby: '3' }; }, /runtimes\.ruby is not a runtime/);
  refused((m) => { m.runtimes = ['node']; }, /runtimes must be an object/);
  refused((m) => { m.runtimes = { node: { version: '24', bin: 'x' } }; }, /runtimes\.node\.bin is unknown/);
  refused((m) => { m.runtimes = { node: '24', python: 'latest' }; }, /runtimes\.python must be a version or range/);
  refused((m) => { m.harnesses.opencode.install.sha256 = { 'darwin-arm64': 'nope' }; }, /harnesses\.opencode\.install\.sha256\.darwin-arm64 must be 64 lowercase hex/);
  refused((m) => { m.harnesses.opencode.install.mirror = 'x'; }, /harnesses\.opencode\.install\.mirror is unknown/);
  refused((m) => { m.harnesses.claude = { install: { kind: 'archive', version: '1', url: 'https://e.com/a', sha256: { 'darwin-arm64': 'a'.repeat(64) } } }; }, /claude is an npm harness, pinned in package\.json/);
  refused((m) => { m.harness = { install: { kind: 'uv-tool', package: 'x', version: '1', bin: 'x' } }; }, /harness\.install is only accepted under harnesses/);
  refused((m) => { delete m.runtimes.python; }, /muse\.install is a uv tool, which needs runtimes\.python/);
  refused((m) => { m.harnesses.opencode.install = { kind: 'archive', version: '1', url: 'https://e.com/a' }; }, /sha256 must map platforms/);
  assert.deepEqual(validateRuntimesDeclaration({ node: '22' }), { node: '22' });
  assert.throws(() => validateRuntimesDeclaration({ go: { version: '1', sources: { 'linux-x64': { url: 'https://e.com/go.tgz', sha256: 'a'.repeat(64) } } } }), /must be exact when sources/);
});

test('an install lands atomically under .soul-state/runtimes with a stamp, is idempotent, shares the verified archive, and reports installed', async (t) => {
  const f = fixture(t, { manifest: { runtimes: { node: '24', go: '1' } } });
  const d = doubles({ archives: f.archives });
  const before = inspectSoulRuntimes(f.dir, f.options);
  assert.deepEqual(before.runtimes.map((r) => [r.name, r.status, r.version, r.source, r.path]), [['node', 'missing', NODE.version, 'catalog', null], ['go', 'missing', GO.version, 'catalog', null]]);
  assert.equal(before.ready, false);
  assert.equal(before.cache, f.cache);
  assert.equal(downloadCacheDir({ env: { XDG_CACHE_HOME: '/x' }, home: '/h' }), '/x/agent-bot/downloads');
  assert.equal(downloadCacheDir({ env: {}, home: '/h' }), '/h/.cache/agent-bot/downloads');
  const result = await installSoulRuntimes(f.dir, { ...f.options, fetchFn: d.fetchFn, runImpl: d.runImpl, now: () => new Date('2026-10-07T12:00:00Z') });
  assert.deepEqual(result.installed, ['node', 'go']);
  assert.deepEqual(result.skipped, []);
  assert.equal(result.ready, true);
  const nodeDir = path.join(f.runtimes, 'node', NODE.version), goDir = path.join(f.runtimes, 'go', GO.version);
  assert.deepEqual(result.runtimes.map((r) => [r.name, r.status, r.path, r.bin]), [['node', 'installed', nodeDir, 'bin'], ['go', 'installed', goDir, 'bin']]);
  assert.ok(existsSync(path.join(nodeDir, 'bin', 'npm')), 'the node tarball brings npm');
  assert.ok(existsSync(path.join(goDir, 'bin', 'go')));
  const stamp = JSON.parse(readFileSync(path.join(nodeDir, INSTALL_STAMP), 'utf8'));
  assert.deepEqual(stamp, { schemaVersion: 1, name: 'node', kind: 'archive', version: NODE.version, platform: PLATFORM, url: f.catalog.node[0].sources[PLATFORM].url,
    sha256: sha(NODE_ARCHIVE), bin: 'bin', installedAt: '2026-10-07T12:00:00.000Z' });
  assert.deepEqual(JSON.parse(readFileSync(path.join(f.runtimes, 'node', 'last-install.json'), 'utf8')), { version: NODE.version, status: 'ok', at: '2026-10-07T12:00:00.000Z' });
  assert.deepEqual(readdirSync(path.join(f.runtimes, 'node')).sort(), [NODE.version, 'last-install.json'], 'no staging directory remains');
  assert.deepEqual(readdirSync(f.cache).sort(), [sha(GO_ARCHIVE), sha(NODE_ARCHIVE)].sort(), 'only the verified archives are shared, by digest');
  assert.deepEqual(d.commands.map((c) => [c.command, c.args[0], c.args[1] === path.join(f.cache, sha(NODE_ARCHIVE)) || c.args[1] === path.join(f.cache, sha(GO_ARCHIVE))]), [['tar', '-xf', true], ['tar', '-xf', true]]);
  // Again: nothing downloads, nothing re-extracts.
  const again = await installSoulRuntimes(f.dir, { ...f.options, fetchFn: d.fetchFn, runImpl: d.runImpl });
  assert.deepEqual([again.installed, again.skipped], [[], ['node', 'go']]);
  assert.equal(d.fetched.length, 2);
  assert.equal(d.commands.length, 2);
  // A second soul pinning the same node reuses the shared archive.
  const other = fixture(t, { manifest: { runtimes: { node: '24' } } });
  const otherResult = await installSoulRuntimes(other.dir, { ...other.options, env: f.env, home: f.home, fetchFn: d.fetchFn, runImpl: d.runImpl });
  assert.deepEqual(otherResult.installed, ['node']);
  assert.equal(d.fetched.length, 2, 'the cached archive was reused');
  // A cached archive that no longer hashes is dropped and fetched again.
  writeFileSync(path.join(f.cache, sha(NODE_ARCHIVE)), 'damaged');
  rmSync(path.join(other.runtimes, 'node'), { recursive: true });
  await installSoulRuntimes(other.dir, { ...other.options, env: f.env, home: f.home, fetchFn: d.fetchFn, runImpl: d.runImpl });
  assert.equal(d.fetched.length, 3);
  assert.equal(sha(readFileSync(path.join(f.cache, sha(NODE_ARCHIVE)))), sha(NODE_ARCHIVE), 'the bad archive was replaced by a verified one');
  // --runtime limits the install; uv is installed with python it provides.
  f.writeManifest((m) => { m.runtimes.python = '3.12'; });
  const only = await installSoulRuntimes(f.dir, { ...f.options, only: 'python', fetchFn: d.fetchFn, runImpl: d.runImpl });
  assert.deepEqual(only.installed, ['uv', 'python']);
  assert.deepEqual(only.runtimes.map((r) => [r.name, r.status, r.requiredBy]), [['node', 'installed', []], ['uv', 'installed', ['python']], ['python', 'installed', []], ['go', 'installed', []]]);
  const python = only.runtimes.find((r) => r.name === 'python');
  assert.equal(python.bin, `cpython-${PYTHON.version}-macos-aarch64-none/bin`);
  assert.ok(existsSync(path.join(python.path, python.bin, 'python3')));
  const uvInstall = d.commands.find((c) => c.args[0] === 'python');
  assert.equal(uvInstall.command, 'uv');
  assert.deepEqual(uvInstall.args.slice(0, 3), ['python', 'install', PYTHON.version]);
  assert.ok(uvInstall.args.includes('--no-bin'), 'never ~/.local/bin');
  assert.ok(uvInstall.env.UV_PYTHON_INSTALL_DIR.startsWith(path.join(f.runtimes, 'python', '.installing-')), 'uv installs into the staging directory');
  assert.equal(uvInstall.env.UV_CACHE_DIR, path.join(f.runtimes, 'uv', 'cache'));
  assert.deepEqual(readdirSync(path.join(f.runtimes, 'python')).sort(), [PYTHON.version, 'last-install.json']);
});

test('a failed install keeps the previous one and records its coded error; checksum, offline, 404, extraction and platform failures are distinct', async (t) => {
  const f = fixture(t, { manifest: { runtimes: { node: '24' } } });
  const d = doubles({ archives: f.archives });
  await installSoulRuntimes(f.dir, { ...f.options, fetchFn: d.fetchFn, runImpl: d.runImpl });
  const installed = tree(f.runtimes);
  // The catalog moves node 24 on: the new pin's archive is corrupt.
  const bumped = structuredClone(f.catalog);
  const next = { version: '24.99.0', sources: Object.fromEntries(RUNTIME_PLATFORMS.map((p) => [p, { url: `https://example.test/${p}/next.tgz`, sha256: 'f'.repeat(64), bin: 'bin' }])) };
  bumped.node.push(next);
  const url = next.sources[PLATFORM].url;
  const attempt = (archives, fail) => installSoulRuntimes(f.dir, { ...f.options, catalog: bumped, fetchFn: doubles({ archives, fail }).fetchFn, runImpl: d.runImpl, now: () => new Date('2026-10-07T12:00:00Z') });
  const expectCode = async (promise, code, pattern) => {
    const error = await promise.then(() => null, (e) => e);
    assert.ok(error, 'rejects');
    assert.equal(error.code, code, error.message);
    assert.match(error.message, pattern);
    assert.equal(error.runtime, 'Billy.soul node');
    assert.equal(error.action, 'agent-bot soul runtimes install Billy.soul --runtime node');
    assert.deepEqual(tree(f.runtimes).filter((p) => !p.endsWith('last-install.json')), installed.filter((p) => !p.endsWith('last-install.json')), 'the previous install is untouched and no staging remains');
    assert.deepEqual(JSON.parse(readFileSync(path.join(f.runtimes, 'node', 'last-install.json'), 'utf8')), { version: '24.99.0', status: 'failed', code, message: error.message, at: '2026-10-07T12:00:00.000Z' });
    assert.deepEqual(readdirSync(f.cache).filter((name) => name.startsWith('.partial')), [], 'no partial download remains');
    return error;
  };
  await expectCode(attempt({ [url]: Buffer.from('not the pinned bytes') }), 'runtime-checksum-mismatch', /hashed sha256:[0-9a-f]{64}, expected sha256:f{64}; the download is corrupt or tampered and was discarded/);
  assert.ok(!existsSync(path.join(f.cache, 'f'.repeat(64))), 'a mismatching download is never cached');
  await expectCode(attempt({}, { [url]: 'offline' }), 'runtime-download-failed', /could not download .*ENOTFOUND.*; check the network and retry/);
  await expectCode(attempt({}, { [url]: '404' }), 'runtime-download-failed', /answered 404/);
  const corrupt = archive({ corrupt: true });
  next.sources[PLATFORM].sha256 = sha(corrupt);
  await expectCode(attempt({ [url]: corrupt }), 'runtime-install-failed', /could not extract next\.tgz \(tar: Unrecognized archive format\)/);
  const noBin = archive({ 'node-v24.99.0/README': 'no binaries' });
  next.sources[PLATFORM].sha256 = sha(noBin);
  await expectCode(attempt({ [url]: noBin }), 'runtime-install-failed', /the archive has no bin\/node/);
  // The descriptor-facing inspection carries the last error until the install succeeds.
  const state = inspectSoulRuntimes(f.dir, { ...f.options, catalog: bumped });
  assert.deepEqual(state.runtimes[0].lastError, { code: 'runtime-install-failed', message: state.runtimes[0].lastError.message, at: '2026-10-07T12:00:00.000Z' });
  assert.equal(state.runtimes[0].status, 'missing');
  // Unsupported platform: nothing is attempted and nothing is written.
  const unsupported = await installSoulRuntimes(f.dir, { ...f.options, catalog: bumped, platform: 'plan9-x64', fetchFn: d.fetchFn, runImpl: d.runImpl }).then(() => null, (e) => e);
  assert.equal(unsupported.code, 'runtime-unsupported-platform');
  assert.match(unsupported.message, /node 24\.99\.0 has no download for plan9-x64/);
  assert.equal(unsupported.action, 'declare runtimes.node sources for plan9-x64 in a revision');
  assert.equal(inspectSoulRuntimes(f.dir, { ...f.options, platform: null }).runtimes[0].status, 'unsupported');
  // Package sources win over the catalog, and cover only what they name.
  f.writeManifest((m) => { m.runtimes = { node: { version: '24.99.0', sources: { 'linux-x64': { url: 'https://example.test/own.tgz', sha256: sha(NODE_ARCHIVE) } } } }; });
  const own = inspectSoulRuntimes(f.dir, { ...f.options, catalog: bumped });
  assert.deepEqual([own.runtimes[0].source, own.runtimes[0].status, own.runtimes[0].reason], ['package', 'unsupported', `the package's sources for node 24.99.0 do not cover ${PLATFORM}`]);
  const onLinux = await installSoulRuntimes(f.dir, { ...f.options, catalog: bumped, platform: 'linux-x64', fetchFn: doubles({ archives: { 'https://example.test/own.tgz': NODE_ARCHIVE } }).fetchFn, runImpl: d.runImpl });
  assert.deepEqual(onLinux.installed, ['node']);
  assert.equal(JSON.parse(readFileSync(path.join(f.runtimes, 'node', '24.99.0', INSTALL_STAMP), 'utf8')).url, 'https://example.test/own.tgz');
  // An invalid declaration is refused before anything is fetched.
  f.writeManifest((m) => { m.runtimes = { node: 'latest' }; });
  const invalid = await installSoulRuntimes(f.dir, { ...f.options, fetchFn: d.fetchFn, runImpl: d.runImpl }).then(() => null, (e) => e);
  assert.equal(invalid.code, 'runtime-install-failed');
  assert.match(invalid.message, /runtimes\.node must be a version or range/);
  assert.deepEqual(RUNTIME_ERROR_CODES, ['runtime-download-failed', 'runtime-checksum-mismatch', 'runtime-unsupported-platform', 'runtime-install-failed', 'runtime-override-invalid', 'runtime-override-unsupported-platform']);
  // A soul without .soul-state cannot hold an install.
  rmSync(path.join(f.dir, '.soul-state'), { recursive: true });
  await assert.rejects(installSoulRuntimes(f.dir, { ...f.options, fetchFn: d.fetchFn, runImpl: d.runImpl }), (e) => e.code === 'soul-state-missing');
});

test('fetchArchive verifies before sharing and never leaves a partial file', async (t) => {
  const f = fixture(t);
  const bytes = Buffer.from('archive bytes');
  const stream = new ReadableStream({ start(controller) { controller.enqueue(bytes.subarray(0, 4)); controller.enqueue(bytes.subarray(4)); controller.close(); } });
  const fetched = await fetchArchive({ url: 'https://example.test/a.tgz', sha256: sha(bytes) }, { cache: f.cache, label: 'x', fetchFn: async () => ({ ok: true, status: 200, body: stream }) });
  assert.deepEqual(fetched, { file: path.join(f.cache, sha(bytes)), reused: false });
  assert.equal(readFileSync(fetched.file, 'utf8'), 'archive bytes');
  assert.deepEqual(await fetchArchive({ url: 'https://example.test/a.tgz', sha256: sha(bytes) }, { cache: f.cache, label: 'x', fetchFn: async () => { throw new Error('no network'); } }), { file: fetched.file, reused: true });
  const failing = async () => ({ ok: true, status: 200, body: new ReadableStream({ start(controller) { controller.enqueue(bytes.subarray(0, 4)); controller.error(new Error('reset by peer')); } }) });
  await assert.rejects(fetchArchive({ url: 'https://example.test/b.tgz', sha256: 'a'.repeat(64) }, { cache: f.cache, label: 'x', fetchFn: failing }), (e) => e.code === 'runtime-download-failed' && /reset by peer/.test(e.message));
  assert.deepEqual(readdirSync(f.cache), [sha(bytes)]);
});

test('an early download failure cannot leave a file created by a late stream open (#617)', (t) => {
  const f = fixture(t);
  // Node 20 can reject pipeline before its output stream's asynchronous open
  // finishes. Delay that open in a separate process so the race is reliable
  // without monkeypatching fs for any other fixture in this test process.
  const source = `
    import fs from 'node:fs';
    import assert from 'node:assert/strict';
    const { fetchArchive } = await import(${JSON.stringify(new URL('../soul-runtimes.mjs', import.meta.url).href)});
    const cache = process.argv[1];
    const originalOpen = fs.open;
    let pending;
    fs.open = (...args) => {
      if (!String(args[0]).includes('.partial-')) return originalOpen(...args);
      pending = new Promise(resolve => setTimeout(() => {
        originalOpen(...args.slice(0, -1), (error, fd) => { args.at(-1)(error, fd); resolve(); });
      }, 100));
    };
    try {
      await assert.rejects(fetchArchive({ url: 'https://example.test/early.tgz', sha256: 'a'.repeat(64) }, {
        cache, label: 'fixture', fetchFn: async () => ({ ok: true,
          body: new ReadableStream({ start(controller) { controller.error(new Error('early failure')); } }),
        }),
      }), error => error.code === 'runtime-download-failed' && /early failure/.test(error.message));
      await pending;
      await new Promise(resolve => setImmediate(resolve));
      assert.deepEqual(fs.readdirSync(cache), []);
    } finally { fs.open = originalOpen; }
  `;
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', source, f.cache], { encoding: 'utf8', timeout: 10_000 });
  assert.equal(child.status, 0, `${child.error?.message ?? ''}${child.stderr}`);
  assert.deepEqual(readdirSync(f.cache), []);
});

test('non-npm harnesses install from a pinned archive or as a uv tool into .soul-state/runtimes/harnesses, and the old npm location keeps working', async (t) => {
  const opencodeUrl = `https://example.test/opencode-${PLATFORM}-1.2.3.zip`;
  const f = fixture(t, { manifest: { runtimes: { python: '3.12' }, harnesses: {
    opencode: { install: { kind: 'archive', version: '1.2.3', url: 'https://example.test/opencode-{platform}-{version}.zip', sha256: { [PLATFORM]: sha(OPENCODE_ARCHIVE), 'linux-x64': 'd'.repeat(64) } } },
    muse: { install: { kind: 'uv-tool', package: 'goose-ai', version: '1.9.0', bin: 'goose' } } } } });
  const d = doubles({ archives: { ...f.archives, [opencodeUrl]: OPENCODE_ARCHIVE } });
  const before = inspectSoulRuntimes(f.dir, f.options);
  assert.deepEqual(before.harnesses.map((h) => [h.name, h.kind, h.package, h.version, h.executable, h.status]),
    [['opencode', 'archive', null, '1.2.3', 'opencode', 'missing'], ['muse', 'uv-tool', 'goose-ai', '1.9.0', 'goose', 'missing']]);
  assert.deepEqual(before.runtimes.map((r) => [r.name, r.requiredBy]), [['uv', ['python', 'muse']], ['python', []]]);
  assert.equal(inspectSoulRuntimes(f.dir, { ...f.options, platform: 'win32-x64' }).harnesses[0].status, 'unsupported');
  const result = await installSoulRuntimes(f.dir, { ...f.options, fetchFn: d.fetchFn, runImpl: d.runImpl });
  assert.deepEqual(result.installed, ['uv', 'python', 'opencode', 'muse']);
  const opencode = result.harnesses.find((h) => h.name === 'opencode'), muse = result.harnesses.find((h) => h.name === 'muse');
  assert.deepEqual([opencode.status, opencode.path, opencode.bin], ['installed', path.join(f.runtimes, 'harnesses', 'opencode', '1.2.3'), '.']);
  assert.ok(existsSync(path.join(opencode.path, 'opencode')));
  assert.deepEqual([muse.status, muse.path, muse.bin], ['installed', path.join(f.runtimes, 'harnesses', 'muse', '1.9.0'), 'bin']);
  assert.ok(existsSync(path.join(muse.path, 'bin', 'goose')));
  assert.ok(!existsSync(`${muse.path}.installing`), 'the in-place marker is gone');
  const tool = d.commands.find((c) => c.args[0] === 'tool');
  assert.deepEqual(tool.args, ['tool', 'install', 'goose-ai==1.9.0']);
  assert.equal(tool.env.UV_TOOL_DIR, path.join(muse.path, 'tools'));
  assert.equal(tool.env.UV_TOOL_BIN_DIR, path.join(muse.path, 'bin'));
  assert.equal(tool.env.UV_PYTHON_INSTALL_DIR, path.join(f.runtimes, 'python', PYTHON.version));
  assert.equal(tool.env.UV_PYTHON_PREFERENCE, 'only-managed');
  assert.equal(result.ready, true);
  // A harness archive without its executable is refused and leaves nothing.
  f.writeManifest((m) => { m.harnesses.opencode.install.version = '2.0.0'; m.harnesses.opencode.install.sha256[PLATFORM] = sha(GO_ARCHIVE); });
  const wrong = await installSoulRuntimes(f.dir, { ...f.options, only: 'opencode', fetchFn: doubles({ archives: { [`https://example.test/opencode-${PLATFORM}-2.0.0.zip`]: GO_ARCHIVE } }).fetchFn, runImpl: d.runImpl }).then(() => null, (e) => e);
  assert.equal(wrong.code, 'runtime-install-failed');
  assert.match(wrong.message, /the archive has no opencode/);
  assert.deepEqual(readdirSync(path.join(f.runtimes, 'harnesses', 'opencode')).sort(), ['1.2.3', 'last-install.json']);
  // The launch env routes the installed harness and runtimes first, with their env, never HOME.
  f.writeManifest((m) => { m.harnesses.opencode.install.version = '1.2.3'; m.harnesses.opencode.install.sha256[PLATFORM] = sha(OPENCODE_ARCHIVE); });
  const routed = runtimeLaunchEnv(inspectSoulRuntimes(f.dir, f.options), { env: { PATH: '/usr/bin:/bin', HOME: '/Users/host' }, harness: 'muse', node: '/Applications/GeniusBar.app/node' });
  assert.deepEqual(routed.missing, []);
  assert.deepEqual(routed.env.PATH.split(path.delimiter), [path.join(muse.path, 'bin'), opencode.path, path.join(f.runtimes, 'uv', UV.version),
    path.join(f.runtimes, 'python', PYTHON.version, `cpython-${PYTHON.version}-macos-aarch64-none`, 'bin'), '/Applications/GeniusBar.app', '/usr/bin', '/bin'], 'harness installs, soul runtimes, the host-bundled node, then PATH');
  assert.deepEqual(Object.keys(routed.env).sort(), ['PATH', 'UV_CACHE_DIR', 'UV_PYTHON_INSTALL_DIR', 'UV_PYTHON_PREFERENCE', 'UV_TOOL_BIN_DIR', 'UV_TOOL_DIR']);
  assert.equal(routed.env.UV_TOOL_DIR, path.join(muse.path, 'tools'), 'the launched uv-tool harness gets its own tool dir');
  assert.equal(routed.routing['harness:muse'].source, 'soul');
  assert.equal(routed.routing.node.source, 'host-bundled');
  assert.equal(runtimeLaunchEnv(inspectSoulRuntimes(f.dir, f.options), { env: {}, harness: 'opencode', node: null }).env.UV_TOOL_DIR, path.join(f.runtimes, 'uv', 'tools'));
});

test('the launch env follows the override order: per-agent option, the soul install, the host-bundled node, then PATH', async (t) => {
  const f = fixture(t, { manifest: { runtimes: { node: '24', go: '1' } } });
  const d = doubles({ archives: f.archives });
  const missing = runtimeLaunchEnv(inspectSoulRuntimes(f.dir, f.options), { env: { PATH: '/usr/bin' }, node: '/host/node/bin/node' });
  assert.deepEqual(missing.missing, ['node', 'go']);
  assert.deepEqual(missing.env, {}, 'a declared runtime never falls through to PATH');
  assert.deepEqual(missing.routing, { node: { source: 'missing', version: NODE.version, bin: null }, go: { source: 'missing', version: GO.version, bin: null }, python: { source: 'host', version: null, bin: null } });
  await installSoulRuntimes(f.dir, { ...f.options, fetchFn: d.fetchFn, runImpl: d.runImpl });
  const state = inspectSoulRuntimes(f.dir, f.options);
  const soul = runtimeLaunchEnv(state, { env: { PATH: `/usr/bin${path.delimiter}/bin`, HOME: '/Users/host', GOPATH: '/Users/host/go' }, node: '/host/node/bin/node' });
  const nodeBin = path.join(f.runtimes, 'node', NODE.version, 'bin'), goDir = path.join(f.runtimes, 'go', GO.version);
  assert.deepEqual(soul.env, { PATH: [nodeBin, path.join(goDir, 'bin'), '/usr/bin', '/bin'].join(path.delimiter), npm_config_cache: path.join(f.runtimes, 'node', 'npm-cache'),
    GOROOT: goDir, GOPATH: path.join(f.runtimes, 'go', 'gopath'), GOMODCACHE: path.join(f.runtimes, 'go', 'gopath', 'pkg', 'mod'), GOCACHE: path.join(f.runtimes, 'go', 'cache') });
  assert.ok(!('HOME' in soul.env), 'HOME is never routed');
  assert.deepEqual(soul.routing.node, { source: 'soul', version: NODE.version, bin: nodeBin });
  assert.deepEqual(soul.missing, []);
  // A per-agent override wins and is used as-is, without the soul's env for it.
  const own = mkdtempSync(path.join(f.home, 'my-go-'));
  put(path.join(own, 'bin', 'go'), '');
  const externalGo = realpathSync(path.join(own, 'bin', 'go'));
  const overridden = runtimeLaunchEnv(state, { env: { PATH: '/usr/bin' }, overrides: { go: { executable: externalGo }, npm: { executable: '/opt/external/npm' } }, node: '/host/node/bin/node' });
  assert.deepEqual(overridden.routing.go, { source: 'override', version: null, bin: path.join(f.runtimes, 'overrides', 'bin'), executable: externalGo, verification: 'unverified-external' });
  assert.deepEqual(overridden.routing['executable:npm'], { source: 'override', version: null, bin: path.join(f.runtimes, 'overrides', 'bin'), executable: '/opt/external/npm', verification: 'unverified-external' });
  assert.equal(overridden.env.GOROOT, undefined, 'runtime variables are omitted for the external tool');
  assert.equal(overridden.env.PATH.split(path.delimiter)[0], path.join(f.runtimes, 'overrides', 'bin'));
  // Undeclared: the host's bundled node before PATH; python and go from PATH.
  f.writeManifest((m) => { delete m.runtimes; });
  const host = runtimeLaunchEnv(inspectSoulRuntimes(f.dir, f.options), { env: { PATH: '/usr/bin' }, node: '/Applications/GeniusBar.app/Contents/node' });
  assert.deepEqual(host.env, { PATH: ['/Applications/GeniusBar.app/Contents', '/usr/bin'].join(path.delimiter) });
  assert.deepEqual(host.routing, { node: { source: 'host-bundled', version: null, bin: '/Applications/GeniusBar.app/Contents' }, python: { source: 'host', version: null, bin: null }, go: { source: 'host', version: null, bin: null } });
});

test('daemon turns refuse unavailable declarations before harness creation, including later cold turns (#617)', async (t) => {
  const f = fixture(t, { manifest: { runtimes: { node: '24' } }, census: true });
  const d = doubles({ archives: f.archives });
  let created = 0;
  const factory = acpExecutorFor({ identities: () => ({}), policy: {}, baseEnv: f.env,
    runtimeEnvFor: ({ agentId, harness, env }) => soulRuntimeEnv(agentId, { ...f.options, env, harness }),
    createExecutor: (options) => { created++; return async () => ({ path: options.env.PATH }); } });
  const request = { agentId: ID, harness: 'opencode', cwd: f.dir, env: {} };
  const refused = (code, runtime) => (error) => error.code === code && error.runtime === runtime && typeof error.action === 'string';
  assert.throws(() => factory(request), refused('runtime-install-failed', 'node'));
  assert.equal(created, 0);
  await installSoulRuntimes(f.dir, { ...f.options, fetchFn: d.fetchFn, runImpl: d.runImpl });
  const executor = factory(request);
  assert.equal((await executor()).path.split(path.delimiter)[0], path.join(f.runtimes, 'node', NODE.version, 'bin'));
  assert.equal(created, 1);
  // A later cold/resumed turn must re-inspect, even when a stamp and bin
  // directory survive deletion of the executable.
  rmSync(path.join(f.runtimes, 'node', NODE.version, 'bin', 'node'));
  await assert.rejects(coldTurnExecutor({ executorFor: factory })({ invocation: request, message: 'continue', env: {} }), refused('runtime-install-failed', 'node'));
  assert.equal(created, 1);
  f.writeManifest((m) => { m.runtimes.node = '999'; });
  assert.throws(() => factory(request), refused('runtime-unsupported-platform', 'node'));
  f.writeManifest((m) => { m.runtimes.node = false; });
  assert.throws(() => factory(request), refused('runtime-install-failed', 'runtimes.node'));
  put(path.join(f.dir, 'soul.json'), '{broken');
  assert.throws(() => factory(request), refused('runtime-install-failed', 'soul.json'));
  assert.equal(created, 1, 'none of the failed resolutions reached the harness');
});

// #617 slice 3: the interactive executor factory, a cold wake and a launch
// share the daemon's one acpExecutorFor, built here as agent-daemon.mjs
// builds it: runtimeEnvFor is the real soulRuntimeEnv over the soul's
// soul.json, census row and install receipt. The real ACP engine resolves
// the adapter; a capturing spawn records what it chose, then runs the
// fixture agent on this Node (the fake archive's node is an empty script).
function parityRig(t, f) {
  const adapter = fileURLToPath(new URL('./fixtures/fake-acp-agent.mjs', import.meta.url));
  put(path.join(f.dir, 'node_modules', '.bin', '.keep'), '');
  symlinkSync(adapter, path.join(f.dir, 'node_modules', '.bin', 'fake-acp'));
  const registry = { claude: { harness: 'claude', enabled: true, soulBin: 'fake-acp', command: '/nonexistent/claude', args: [], stripEnv: [] } };
  const spawns = [];
  const factory = acpExecutorFor({ identities: () => ({}), policy: { version: 1, rules: [], fallback: 'deny' }, baseEnv: f.env,
    runtimeEnvFor: ({ agentId, harness, env }) => soulRuntimeEnv(agentId, { ...f.options, env, harness }),
    createExecutor: (options) => createAcpExecutor({ ...options, registry,
      spawn: (command, args, spawnOptions) => {
        spawns.push({ command: [command, ...args], env: spawnOptions.env });
        return spawnChild(process.execPath, args, spawnOptions);
      } }) });
  const journal = mkdtempSync(path.join(tmpdir(), 'launch-parity-'));
  t.after(() => rmSync(journal, { recursive: true, force: true }));
  const reports = [];
  const handler = createLaunchHandler({ file: path.join(journal, 'launch-requests.json'),
    identities: () => ({ id: ID, harness: 'claude' }),
    spawnPackage: () => { throw new Error('unexpected package spawn'); },
    lookupBinding: () => ({ worktree: f.dir, file: path.join(f.dir, '.soul-state', 'binding.json') }),
    provisionHome: () => null, executorFor: factory });
  const request = { agentId: ID, harness: 'claude', cwd: f.dir, env: {} };
  const port = { invocation: { agentId: ID, harness: 'claude', cwd: f.dir }, message: 'ping', attachments: [],
    appendEvent: () => ({}), addArtifact: () => ({}), signal: new AbortController().signal, requestApproval: async () => ({ decision: 'deny' }) };
  const coldEvents = [];
  const paths = {
    interactive: () => factory(request)(port),
    cold: () => coldTurnExecutor({ executorFor: factory, onEvent: (type) => coldEvents.push(type) })({ invocation: port.invocation, message: 'ping', attachments: [], env: {} }),
    launch: (requestId) => handler({ event: 'launch', requestId, principal: 'p1', account: 'worker', soul: ID, harness: 'claude' },
      { account: 'worker', report: async (result) => { reports.push(result); } }),
  };
  return { adapter: realpathSync(adapter), spawns, reports, coldEvents, paths };
}

test('a declared, installed runtime is the Node every daemon turn start spawns the adapter on, with one env (#617)', async (t) => {
  const f = fixture(t, { manifest: { runtimes: { node: '24' } }, census: true });
  await installSoulRuntimes(f.dir, { ...f.options, ...doubles({ archives: f.archives }) });
  // A real archive carries the executable bit; the fake tar writes 0644.
  const soulNode = path.join(f.runtimes, 'node', NODE.version, 'bin', 'node');
  chmodSync(soulNode, 0o755);
  const r = parityRig(t, f);
  await r.paths.interactive();
  await r.paths.cold();
  await r.paths.launch('r1');
  assert.ok(r.coldEvents.includes('harness-session') && r.coldEvents.includes('update'), `the cold turn completed: ${r.coldEvents}`);
  assert.equal(r.reports[0].status, 'launched', JSON.stringify(r.reports[0]));
  assert.equal(r.spawns.length, 3);
  for (const spawned of r.spawns) {
    assert.deepEqual(spawned.command, [soulNode, r.adapter], 'the receipt-verified install, never a host Node');
    assert.equal(spawned.env.PATH.split(path.delimiter)[0], path.dirname(soulNode));
    assert.equal(spawned.env.npm_config_cache, path.join(f.runtimes, 'node', 'npm-cache'));
  }
  // One env on every path, save the launch's binding file.
  const { AGENT_BOT_BINDING, ...launchEnv } = r.spawns[2].env;
  assert.equal(AGENT_BOT_BINDING, path.join(f.dir, '.soul-state', 'binding.json'));
  assert.deepEqual(r.spawns[1].env, r.spawns[0].env);
  assert.deepEqual(launchEnv, r.spawns[0].env);
});

test('a removed executable or a corrupt receipt refuses every daemon turn start before any spawn (#617)', async (t) => {
  for (const damage of ['executable', 'receipt']) {
    const f = fixture(t, { manifest: { runtimes: { node: '24' } }, census: true });
    await installSoulRuntimes(f.dir, { ...f.options, ...doubles({ archives: f.archives }) });
    const installed = path.join(f.runtimes, 'node', NODE.version);
    if (damage === 'executable') rmSync(path.join(installed, 'bin', 'node'));
    else put(path.join(installed, INSTALL_STAMP), JSON.stringify({ ...JSON.parse(readFileSync(path.join(installed, INSTALL_STAMP), 'utf8')), sha256: '0'.repeat(64) }));
    const r = parityRig(t, f);
    const refused = (error) => error.code === 'runtime-install-failed' && error.runtime === 'node';
    await assert.rejects(async () => r.paths.interactive(), refused, damage);
    await assert.rejects(r.paths.cold(), refused, damage);
    await r.paths.launch('r1');
    assert.equal(r.reports[0].status, 'failed', damage);
    assert.match(r.reports[0].detail, /^runtime-install-failed: .*refusing host fallback/, damage);
    assert.deepEqual(r.spawns, [], `${damage}: no harness process starts`);
  }
});

// #617 slice 3b: the resume wake lane composes its env through the same
// runtime port as ACP turns and runs the harness CLI that env selects. A
// host stand-in for each CLI sits on the host PATH, so a lane that ignored
// the soul's declarations would run it instead.
function resumeRig(t, f, { session = null } = {}) {
  const hostBin = path.join(f.home, 'host-bin');
  for (const name of ['opencode', 'devin']) { put(path.join(hostBin, name), '#!/bin/sh\n'); chmodSync(path.join(hostBin, name), 0o755); }
  const runs = [];
  const recorded = [];
  const sessions = { recorded: () => (session ? { sessionId: session, store: 'host' } : null), set: (...args) => recorded.push(args) };
  const execute = createResumeExecutor({ sessions, home: f.home, baseEnv: { ...f.env, PATH: `${hostBin}${path.delimiter}${f.env.PATH}` },
    runtimeEnvFor: ({ agentId, harness, env }) => soulRuntimeEnv(agentId, { ...f.options, env, harness }),
    run: async (command, args, options) => { runs.push({ command, env: options.env }); return { code: 0, stdout: '[]', stderr: '' }; } });
  const turn = (harness) => execute({ invocation: { agentId: ID, harness, cwd: f.dir }, message: 'm', env: {}, policy: 'read-only' });
  return { hostBin, runs, recorded, turn };
}

test('the resume lane runs a declared, installed harness from the soul and the host CLI only when undeclared (#617)', async (t) => {
  const opencodeUrl = `https://example.test/opencode-${PLATFORM}-1.2.3.zip`;
  const f = fixture(t, { census: true, manifest: { harnesses: {
    opencode: { install: { kind: 'archive', version: '1.2.3', url: 'https://example.test/opencode-{platform}-{version}.zip', sha256: { [PLATFORM]: sha(OPENCODE_ARCHIVE) } } } } } });
  await installSoulRuntimes(f.dir, { ...f.options, ...doubles({ archives: { [opencodeUrl]: OPENCODE_ARCHIVE } }) });
  const installed = path.join(f.runtimes, 'harnesses', 'opencode', '1.2.3', 'opencode');
  chmodSync(installed, 0o755); // a real archive carries the bit; the fake tar writes 0644
  const r = resumeRig(t, f, { session: 'ses_kept' });
  await r.turn('opencode').catch(() => {});
  assert.equal(r.runs.length, 1);
  assert.equal(r.runs[0].command, installed, 'the soul\'s installed opencode, not the host\'s');
  assert.equal(r.runs[0].env.PATH.split(path.delimiter)[0], path.dirname(installed));
  // Undeclared: the explicit host route, unchanged.
  f.writeManifest((m) => { delete m.harnesses; });
  await r.turn('opencode').catch(() => {});
  assert.equal(r.runs[1].command, path.join(r.hostBin, 'opencode'));
});

test('a removed or mismatched declared install refuses the resume lane before any run, Devin\'s session listing included (#617)', async (t) => {
  for (const damage of ['executable', 'receipt']) {
    const f = fixture(t, { census: true, manifest: { runtimes: { node: '24' } } });
    await installSoulRuntimes(f.dir, { ...f.options, ...doubles({ archives: f.archives }) });
    const installed = path.join(f.runtimes, 'node', NODE.version);
    if (damage === 'executable') rmSync(path.join(installed, 'bin', 'node'));
    else put(path.join(installed, INSTALL_STAMP), JSON.stringify({ ...JSON.parse(readFileSync(path.join(installed, INSTALL_STAMP), 'utf8')), sha256: '0'.repeat(64) }));
    // No recorded session: a Devin turn would list sessions first.
    const r = resumeRig(t, f);
    for (const harness of ['devin', 'opencode']) {
      await assert.rejects(r.turn(harness), (error) => error.code === 'runtime-install-failed' && error.runtime === 'node' && /refusing host fallback/.test(error.message), `${damage} ${harness}`);
    }
    assert.deepEqual(r.runs, [], `${damage}: no harness process, not even devin list`);
    assert.deepEqual(r.recorded, [], 'no session is recorded or replaced');
  }
});

test('daemon env refuses a missing selected harness install but allows undeclared host tools (#617)', (t) => {
  const f = fixture(t, { manifest: { harnesses: { muse: { install: { kind: 'archive', version: '1.2.3', bin: 'muse', url: 'https://example.test/muse.tgz', sha256: { [PLATFORM]: 'a'.repeat(64) } } } } }, census: true });
  assert.throws(() => soulRuntimeEnv(ID, { ...f.options, harness: 'muse' }), (error) => error.code === 'runtime-install-failed' && error.runtime === 'harness:muse');
  const env = soulRuntimeEnv(ID, { ...f.options, harness: 'opencode', node: '/host/bin/node' });
  assert.equal(env.PATH.split(path.delimiter)[0], '/host/bin');
});

test('soul runtimes and soul runtimes install report by Agent ID or name with --json, the install is owner gated, and the daemon helpers answer', async (t) => {
  const f = fixture(t, { manifest: { runtimes: { node: '24' } }, census: true });
  const d = doubles({ archives: f.archives });
  const gates = [];
  const options = { ...f.options, fetchFn: d.fetchFn, runImpl: d.runImpl, cwd: f.home, file: f.env.AGENT_BOT_POPULATION_PATH,
    gate: async (action, { principal }) => { gates.push([action, principal]); return { method: 'consent' }; } };
  let out = '';
  const write = (value) => { out += value; };
  const status = await soulRuntimesCommand(['billy', '--json'], { ...options, write });
  assert.deepEqual(JSON.parse(out), status);
  assert.deepEqual(Object.keys(status), ['schemaVersion', 'agentId', 'soulDir', 'platform', 'root', 'cache', 'runtimes', 'harnesses', 'overrides', 'invalid', 'ready']);
  assert.deepEqual(status.runtimes, [{ name: 'node', declared: '24', requiredBy: [], version: NODE.version, source: 'catalog', status: 'missing', reason: null, path: null, bin: null, lastError: null, via: null }]);
  assert.deepEqual([status.agentId, status.soulDir, status.platform, status.root, status.cache, status.ready], [ID, f.dir, PLATFORM, f.runtimes, f.cache, false]);
  assert.deepEqual(status.overrides, []);
  assert.deepEqual(gates, [], 'reading is not an owner action');
  assert.deepEqual(pendingSoulRuntimes(ID, options), ['node']);
  out = '';
  const installed = await soulRuntimesCommand(['install', ID, '--json', '--principal-stdin'], { ...options, write, readStdin: () => '{"principalId":"p1"}' });
  assert.deepEqual(JSON.parse(out), installed);
  assert.deepEqual(gates, [[`install ${ID}'s declared runtimes into its soul folder`, { principalId: 'p1' }]]);
  assert.deepEqual([installed.installed, installed.skipped, installed.ready], [['node'], [], true]);
  assert.equal(installed.runtimes[0].status, 'installed');
  assert.deepEqual(pendingSoulRuntimes(ID, options), []);
  assert.match(readFileSync(auditFile({ env: f.env, home: f.home }), 'utf8').split('\n').find((line) => line.includes('soul-runtimes')), /"operation":"install","decision":"installed"/);
  const env = soulRuntimeEnv(ID, { ...options, env: { PATH: '/usr/bin' }, node: '/host/bin/node' });
  assert.equal(env.PATH.split(path.delimiter)[0], path.join(f.runtimes, 'node', NODE.version, 'bin'));
  out = '';
  await soulRuntimesCommand(['billy'], { ...options, write });
  assert.match(out, new RegExp(`^agentId: ${ID}\\n.*\\nnode: installed ${NODE.version.replaceAll('.', '\\.')} \\(declared 24, catalog\\)`, 's'));
  for (const args of [[], ['--json'], ['install'], ['billy', '--runtime', 'node'], ['billy', '--principal-stdin'], ['billy', 'extra'], ['billy', '--nope'], ['install', 'billy', '--runtime']]) {
    await assert.rejects(soulRuntimesCommand(args, { ...options, write: () => {} }), /usage:/, args.join(' '));
  }
  await assert.rejects(soulRuntimesCommand(['install', 'billy', '--runtime', 'ruby'], { ...options, write: () => {} }), /--runtime must be one of/);
  await assert.rejects(soulRuntimesCommand(['nobody'], { ...options, write: () => {} }), (e) => e.code === 'soul-not-found');
  // The stable CLI: status needs no gate and prints the same JSON; an unknown soul is coded.
  const cli = spawnSync(process.execPath, [path.join(ROOT, 'agent-bot.mjs'), 'soul', 'runtimes', 'billy', '--json'], { cwd: f.home, env: { ...f.env, PATH: process.env.PATH }, encoding: 'utf8', timeout: 20000 });
  assert.equal(cli.status, 0, cli.stderr);
  const printed = JSON.parse(cli.stdout);
  assert.equal(printed.agentId, ID);
  // This child uses the shipped catalog, not our fake archive digests.
  assert.equal(printed.runtimes[0].status, 'missing');
  assert.match(printed.runtimes[0].reason, /receipt does not match/);
  const unknown = spawnSync(process.execPath, [path.join(ROOT, 'agent-bot.mjs'), 'soul', 'runtimes', 'nobody', '--json'], { cwd: f.home, env: { ...f.env, PATH: process.env.PATH }, encoding: 'utf8', timeout: 20000 });
  assert.equal(unknown.status, 1);
  assert.deepEqual(JSON.parse(unknown.stdout), { error: { code: 'soul-not-found', message: 'Soul not found.', runtime: null, action: null } });
  const help = spawnSync(process.execPath, [path.join(ROOT, 'agent-bot.mjs'), 'soul', '--help'], { encoding: 'utf8', timeout: 20000 });
  assert.match(help.stdout, /agent-bot soul runtimes install <agentId\|name> \[--json\] \[--runtime NAME\] \[--principal-stdin\]/);
  assert.ok(RUNTIME_NAMES.every((name) => help.stdout.includes(name)));
});

test('owner-managed executable overrides use one-name shims, satisfy only the selected runtime, and fail closed when stale', async (t) => {
  const f = fixture(t, { manifest: { runtimes: { node: '24' } }, census: true });
  const options = { ...f.options, file: f.env.AGENT_BOT_POPULATION_PATH, cwd: f.home };
  const gates = [], output = [];
  const gate = async (action, { principal }) => { gates.push([action, principal]); };
  const write = (value) => output.push(value);
  const external = path.join(f.home, 'external-node');
  const externalNode = path.join(external, 'node'), externalNpm = path.join(external, 'npm');
  put(externalNode, '#!/bin/sh\nexit 0\n');
  put(externalNpm, '#!/bin/sh\nexit 0\n');
  put(path.join(external, 'npx'), '#!/bin/sh\nexit 0\n');

  const setNode = await soulRuntimesCommand(['override', ID, 'node', externalNode, '--json', '--principal-stdin'], {
    ...options, gate, write, readStdin: () => '{"principalId":"p1"}',
  });
  assert.deepEqual(setNode, { schemaVersion: 1, agentId: ID, name: 'node', status: 'selected', executable: realpathSync(externalNode), verification: 'unverified-external' });
  const shim = path.join(f.runtimes, 'overrides', 'bin');
  assert.deepEqual(readdirSync(shim), ['node'], 'the external directory’s npm and npx siblings never enter PATH');
  assert.equal(realpathSync(path.join(shim, 'node')), realpathSync(externalNode));
  const provisioned = await installSoulRuntimes(f.dir, { ...f.options, fetchFn: async () => assert.fail('an active runtime override prevents managed installation'), runImpl: async () => assert.fail('an active runtime override prevents managed installation') });
  assert.deepEqual(provisioned.installed, []);
  assert.deepEqual(provisioned.skipped, ['override:node']);
  assert.deepEqual(pendingSoulRuntimes(ID, options), [], 'a selected node override satisfies only the matching runtime');
  const launch = soulRuntimeEnv(ID, { ...options, env: { PATH: '/host/bin', npm_config_cache: '/host/npm-cache', NODE_PATH: '/host/node-modules' } });
  assert.equal(launch.PATH.split(path.delimiter)[0], shim);
  assert.ok(!launch.PATH.split(path.delimiter).includes(external));
  assert.equal(launch.npm_config_cache, undefined);
  assert.equal(launch.NODE_PATH, undefined);
  const unexpected = path.join(shim, 'claude');
  symlinkSync(externalNode, unexpected);
  assert.throws(() => soulRuntimeEnv(ID, { ...options, env: { PATH: '/host/bin' } }), (error) => error.code === 'runtime-override-invalid' && /remove that host-local entry/.test(error.message));
  rmSync(unexpected);
  rmSync(shim, { recursive: true });
  put(shim, 'unexpected regular file');
  assert.throws(() => soulRuntimeEnv(ID, options), (error) => error.code === 'runtime-override-invalid', 'a non-directory shim refuses with the stable code');
  rmSync(shim);
  symlinkSync(path.join(f.home, 'missing-shim-target'), shim);
  assert.throws(() => soulRuntimeEnv(ID, options), (error) => error.code === 'runtime-override-invalid', 'a dangling shim-directory link refuses with the stable code');
  rmSync(shim);
  soulRuntimeEnv(ID, options);

  await soulRuntimesCommand(['override', ID, 'npm', externalNpm, '--json'], { ...options, gate, write });
  assert.deepEqual(readdirSync(shim).sort(), ['node', 'npm']);
  let status = inspectRuntimeOverrides(f.dir, { agentId: ID, platform: PLATFORM });
  assert.deepEqual(status.rows.map((row) => [row.name, row.runtime, row.status, row.verification]), [
    ['node', 'node', 'selected', 'unverified-external'], ['npm', null, 'selected', 'unverified-external'],
  ]);

  await soulRuntimesCommand(['override', ID, 'node', '--clear', '--json'], { ...options, gate, write });
  assert.deepEqual(readdirSync(shim), ['npm']);
  assert.deepEqual(pendingSoulRuntimes(ID, options), ['node'], 'an npm override does not satisfy a missing node runtime');
  assert.throws(() => soulRuntimeEnv(ID, { ...options, env: { PATH: '/host/bin' } }), (error) => error.code === 'runtime-install-failed' && error.runtime === 'node');
  await soulRuntimesCommand(['override', ID, 'npm', '--clear'], { ...options, gate, write });
  assert.deepEqual(readdirSync(shim), []);
  assert.equal(gates.length, 4);
  assert.equal(gates[0][0], `set ${ID}'s node executable override`);
  assert.deepEqual(gates[0][1], { principalId: 'p1' });
  const receipts = readFileSync(auditFile({ env: f.env, home: f.home }), 'utf8');
  assert.match(receipts, /"operation":"override","decision":"selected"/);
  assert.match(receipts, /"operation":"override-clear","decision":"cleared"/);

  await soulRuntimesCommand(['override', ID, 'node', externalNode, '--json'], { ...options, gate, write });
  rmSync(externalNode);
  status = await soulRuntimesCommand([ID, '--json'], { ...options, write });
  assert.equal(status.overrides[0].status, 'invalid');
  assert.equal(status.overrides[0].code, 'runtime-override-invalid');
  assert.ok(status.overrides[0].reason.includes(setNode.executable), 'the stale-path error names the recorded executable');
  assert.match(status.overrides[0].action, /--clear/);
  assert.throws(() => soulRuntimeEnv(ID, { ...options, env: { PATH: '/host/bin' } }), (error) => error.code === 'runtime-override-invalid' && /--clear/.test(error.action));
  await soulRuntimesCommand(['override', ID, 'node', '--clear'], { ...options, gate, write });
  await assert.rejects(soulRuntimesCommand(['override', ID, 'node', externalNpm], { ...options, gate, write, platform: 'win32-x64' }), (error) => error.code === 'runtime-override-unsupported-platform');

  for (const candidate of ['relative/path', external, path.join(f.home, 'non-executable')]) {
    if (candidate.endsWith('non-executable')) { put(candidate, 'no execute bit'); chmodSync(candidate, 0o644); }
    await assert.rejects(soulRuntimesCommand(['override', ID, 'node', candidate], { ...options, gate, write }),
      (error) => error.code === 'runtime-override-invalid', candidate);
  }
  const rejected = async () => { throw new Error('owner gate refused'); };
  const stateBefore = existsSync(path.join(f.runtimes, 'overrides', 'node.json'));
  const receiptsBefore = readFileSync(auditFile({ env: f.env, home: f.home }), 'utf8');
  await assert.rejects(soulRuntimesCommand(['override', ID, 'node', externalNpm], { ...options, gate: rejected, write }), /owner gate refused/);
  assert.equal(existsSync(path.join(f.runtimes, 'overrides', 'node.json')), stateBefore);
  assert.equal(readFileSync(auditFile({ env: f.env, home: f.home }), 'utf8'), receiptsBefore);

  const malformedFile = path.join(f.runtimes, 'overrides', 'node.json');
  put(malformedFile, '{broken');
  assert.equal(inspectRuntimeOverrides(f.dir, { agentId: ID, platform: PLATFORM }).rows[0].status, 'invalid');
  rmSync(malformedFile);
  const outside = path.join(f.home, 'outside-state');
  put(path.join(outside, 'runtimes', 'overrides', 'node.json'), 'sentinel');
  rmSync(path.join(f.dir, '.soul-state'), { recursive: true, force: true });
  symlinkSync(outside, path.join(f.dir, '.soul-state'));
  await assert.rejects(soulRuntimesCommand(['override', ID, 'node', '--clear'], { ...options, gate, write }),
    (error) => error.code === 'runtime-override-invalid');
  assert.equal(readFileSync(path.join(outside, 'runtimes', 'overrides', 'node.json'), 'utf8'), 'sentinel');
});

test('an unsafe override shim directory refuses set and clear before the record changes', async (t) => {
  const f = fixture(t, { manifest: { runtimes: { node: '24' } }, census: true });
  const options = { ...f.options, file: f.env.AGENT_BOT_POPULATION_PATH, cwd: f.home };
  const gate = async () => {}, write = () => {};
  const externalNpm = path.join(f.home, 'external', 'npm'), externalNode = path.join(f.home, 'external', 'node');
  put(externalNpm, '#!/bin/sh\nexit 0\n');
  put(externalNode, '#!/bin/sh\nexit 0\n');
  await soulRuntimesCommand(['override', ID, 'npm', externalNpm], { ...options, gate, write });
  const overrides = path.join(f.runtimes, 'overrides');
  const npmRecord = readFileSync(path.join(overrides, 'npm.json'));
  const stray = path.join(overrides, 'bin', 'gofmt');
  put(stray, 'unexpected regular file');
  const receiptsBefore = readFileSync(auditFile({ env: f.env, home: f.home }), 'utf8');

  await assert.rejects(soulRuntimesCommand(['override', ID, 'node', externalNode], { ...options, gate, write }),
    (error) => error.code === 'runtime-override-invalid' && /remove that host-local entry/.test(error.message));
  assert.ok(!existsSync(path.join(overrides, 'node.json')), 'a refused set leaves no selection behind');
  await assert.rejects(soulRuntimesCommand(['override', ID, 'npm', '--clear'], { ...options, gate, write }),
    (error) => error.code === 'runtime-override-invalid');
  assert.deepEqual(readFileSync(path.join(overrides, 'npm.json')), npmRecord, 'a refused clear keeps the selection');
  assert.equal(readFileSync(auditFile({ env: f.env, home: f.home }), 'utf8'), receiptsBefore, 'nothing changed, so nothing is receipted');

  rmSync(stray);
  await soulRuntimesCommand(['override', ID, 'npm', '--clear'], { ...options, gate, write });
  assert.ok(!existsSync(path.join(overrides, 'npm.json')));
});


test('override clear recovers a malformed directory without following links or removing other selections', async (t) => {
  const f = fixture(t, { census: true });
  const options = { ...f.options, file: f.env.AGENT_BOT_POPULATION_PATH, cwd: f.home, gate: async () => {}, write: () => {} };
  const external = path.join(f.home, 'external-npm');
  put(external, '#!/bin/sh\nexit 0\n');
  await soulRuntimesCommand(['override', ID, 'npm', external], options);
  const directory = path.join(f.runtimes, 'overrides');
  const malformed = path.join(directory, 'node.json');
  const sentinel = path.join(f.home, 'outside-record', 'sentinel');
  put(sentinel, 'keep outside data');
  put(path.join(malformed, 'nested', 'bad-record'), 'malformed');
  symlinkSync(path.dirname(sentinel), path.join(malformed, 'outside-link'));
  const npmBefore = readFileSync(path.join(directory, 'npm.json'), 'utf8');
  const invalid = inspectRuntimeOverrides(f.dir, { agentId: ID, platform: PLATFORM }).errors[0];
  assert.equal(invalid.code, 'runtime-override-invalid');
  assert.equal(invalid.action, `agent-bot soul runtimes override ${ID} node --clear`);

  const result = await soulRuntimesCommand(['override', ID, 'node', '--clear'], options);
  assert.equal(result.status, 'cleared');
  assert.equal(existsSync(malformed), false);
  assert.equal(readFileSync(sentinel, 'utf8'), 'keep outside data');
  assert.equal(readFileSync(path.join(directory, 'npm.json'), 'utf8'), npmBefore);
  assert.equal(realpathSync(path.join(directory, 'bin', 'npm')), realpathSync(external));
  assert.equal(inspectRuntimeOverrides(f.dir, { agentId: ID, platform: PLATFORM }).errors.length, 0);

  symlinkSync(path.dirname(sentinel), malformed);
  await soulRuntimesCommand(['override', ID, 'node', '--clear'], options);
  assert.ok(!readdirSync(directory).includes('node.json'));
  assert.equal(readFileSync(sentinel, 'utf8'), 'keep outside data');
});

test('setting an override identifies the soul when its store is unsafe', async (t) => {
  const f = fixture(t, { census: true });
  const external = path.join(f.home, 'external-node');
  put(external, '#!/bin/sh\nexit 0\n');
  const outside = path.join(f.home, 'outside-store');
  put(path.join(outside, 'sentinel'), 'keep outside data');
  mkdirSync(f.runtimes, { recursive: true });
  symlinkSync(outside, path.join(f.runtimes, 'overrides'));
  const options = { ...f.options, file: f.env.AGENT_BOT_POPULATION_PATH, cwd: f.home, gate: async () => {}, write: () => {} };
  await assert.rejects(soulRuntimesCommand(['override', ID, 'node', external], options), (error) => {
    assert.equal(error.code, 'runtime-override-invalid');
    assert.ok(error.message.startsWith(`${ID}: `), error.message);
    return true;
  });
  assert.deepEqual(readdirSync(outside), ['sentinel']);
  assert.equal(readFileSync(path.join(outside, 'sentinel'), 'utf8'), 'keep outside data');
  assert.equal(existsSync(auditFile({ env: f.env, home: f.home })), false);
});

test('external runtime overrides preserve exact PATH identity and clear variables in the spawned environment', (t) => {
  const f = fixture(t, { manifest: { runtimes: { node: '24', python: '3.12', go: '1.x' } } });
  const inspection = inspectSoulRuntimes(f.dir, f.options);
  const managedBin = path.join(f.runtimes, 'node', NODE.version, 'bin');
  const harnessBin = path.join(f.runtimes, 'harnesses', 'muse', 'bin');
  const state = { ...inspection,
    runtimes: inspection.runtimes.map((row) => row.name === 'node' ? { ...row, status: 'installed', path: path.dirname(managedBin), bin: 'bin' } : row),
    harnesses: [{ name: 'muse', status: 'installed', path: path.dirname(harnessBin), bin: 'bin', version: '1' }] };
  const routed = runtimeLaunchEnv(state, { env: { PATH: '/host/bin' }, overrides: { node: { executable: '/external/node' } }, node: process.execPath });
  assert.deepEqual(routed.env.PATH.split(path.delimiter).slice(0, 4), [path.join(f.runtimes, 'overrides', 'bin'), harnessBin, managedBin, '/host/bin']);
  assert.equal(routed.routing.node.executable, '/external/node');
  assert.equal(routed.routing['executable:npm'], undefined);
  assert.equal(routed.routing['executable:npx'], undefined);

  const base = { PATH: '/host/bin', npm_config_cache: 'host', NODE_PATH: 'host', GOROOT: 'host', GOPATH: 'host', GOMODCACHE: 'host', GOCACHE: 'host', GOTOOLCHAIN: 'auto',
    UV_PYTHON_INSTALL_DIR: 'host', UV_PYTHON_PREFERENCE: 'system', PYTHONHOME: 'host', VIRTUAL_ENV: 'host', UV_CACHE_DIR: 'host', UV_TOOL_DIR: 'host', UV_TOOL_BIN_DIR: 'host', KEEP_ME: 'retained' };
  const selections = Object.fromEntries(['node', 'npm', 'npx', 'go', 'gofmt', 'python3', 'uv', 'uvx'].map((name) => [name, { executable: `/external/${name}` }]));
  const patch = runtimeLaunchEnv(inspection, { env: base, overrides: selections }).env;
  const keys = ['npm_config_cache', 'NODE_PATH', 'GOROOT', 'GOPATH', 'GOMODCACHE', 'GOCACHE', 'GOTOOLCHAIN', 'UV_PYTHON_INSTALL_DIR',
    'UV_PYTHON_PREFERENCE', 'PYTHONHOME', 'VIRTUAL_ENV', 'UV_CACHE_DIR', 'UV_TOOL_DIR', 'UV_TOOL_BIN_DIR'];
  const child = spawnSync(process.execPath, ['-e', `console.log(JSON.stringify(process.env))`], { env: { ...base, ...patch }, encoding: 'utf8' });
  assert.equal(child.status, 0, child.stderr);
  const observed = JSON.parse(child.stdout);
  for (const key of keys) assert.equal(Object.hasOwn(observed, key), false, `${key} is absent in the actual spawned environment`);
  assert.equal(observed.KEEP_ME, 'retained');
});

test('runtime status reads an override without creating its shim directory', async (t) => {
  const f = fixture(t, { manifest: { runtimes: { node: '24' } }, census: true });
  const external = path.join(f.home, 'external-node');
  put(external, '#!/bin/sh\n');
  put(path.join(f.runtimes, 'overrides', 'node.json'), JSON.stringify({ schemaVersion: 1, executable: realpathSync(external) }));
  const before = tree(f.dir);
  const status = await soulRuntimesCommand([ID, '--json'], { ...f.options, write: () => {} });
  assert.equal(status.overrides[0].status, 'selected');
  assert.deepEqual(tree(f.dir), before, 'status does not create or repair one-name shims');
  assert.equal(existsSync(path.join(f.runtimes, 'overrides', 'bin')), false);
});

test('Python and uv-tool provisioning honor explicit uv without downloading managed uv, while Python-only selection drops unused uv', async (t) => {
  const pythonOnly = fixture(t, { manifest: { runtimes: { python: '3.12' } }, census: true });
  const pythonExe = path.join(pythonOnly.home, 'external-python');
  put(pythonExe, '#!/bin/sh\n');
  put(path.join(pythonOnly.runtimes, 'overrides', 'python3.json'), JSON.stringify({ schemaVersion: 1, executable: realpathSync(pythonExe) }));
  const skipped = await installSoulRuntimes(pythonOnly.dir, { ...pythonOnly.options, fetchFn: async () => assert.fail('a Python override needs no implicit uv when no uv-tool harness uses it') });
  assert.deepEqual(skipped.skipped, ['override:python']);
  assert.deepEqual(pendingSoulRuntimes(ID, { ...pythonOnly.options, file: pythonOnly.env.AGENT_BOT_POPULATION_PATH }), []);
  assert.equal(skipped.runtimes.find((row) => row.name === 'python').status, 'missing', 'managed status remains honest');
  const pythonLaunch = soulRuntimeEnv(ID, { ...pythonOnly.options, file: pythonOnly.env.AGENT_BOT_POPULATION_PATH, env: { PATH: '/host/bin' } });
  assert.ok(pythonLaunch.PATH.includes(path.join(pythonOnly.runtimes, 'overrides', 'bin')));

  const pythonTool = fixture(t, { manifest: { runtimes: { python: '3.12' }, harnesses: { muse: { install: { kind: 'uv-tool', package: 'goose-ai', version: '1.9.0', bin: 'goose' } } } }, census: true });
  const selectedPython = path.join(pythonTool.home, 'selected-python');
  put(selectedPython, '#!/bin/sh\n');
  put(path.join(pythonTool.runtimes, 'overrides', 'python3.json'), JSON.stringify({ schemaVersion: 1, executable: realpathSync(selectedPython) }));
  const pythonToolDoubles = doubles({ archives: pythonTool.archives });
  await installSoulRuntimes(pythonTool.dir, { ...pythonTool.options, ...pythonToolDoubles });
  const uvToolCall = pythonToolDoubles.commands.find((entry) => entry.args[0] === 'tool' && entry.args[1] === 'install');
  assert.ok(uvToolCall.args.includes('--python'));
  assert.equal(uvToolCall.args[uvToolCall.args.indexOf('--python') + 1], realpathSync(selectedPython));
  assert.ok(uvToolCall.args.includes('--no-python-downloads'), 'an unavailable exact override cannot fall back to a downloaded interpreter');
  assert.equal(uvToolCall.env.UV_PYTHON_INSTALL_DIR, path.join(pythonTool.runtimes, 'python', 'uv-managed'));
  assert.equal(uvToolCall.env.UV_PYTHON_PREFERENCE, 'only-managed');

  const cases = [
    { runtimes: { python: '3.12' } },
    { runtimes: { python: '3.12' }, harnesses: { muse: { install: { kind: 'uv-tool', package: 'goose-ai', version: '1.9.0', bin: 'goose' } } } },
    { harnesses: { muse: { install: { kind: 'uv-tool', package: 'goose-ai', version: '1.9.0', bin: 'goose' } } } },
  ];
  for (const manifest of cases) {
    const f = fixture(t, { manifest, census: true });
    const uv = path.join(f.home, 'external-uv');
    put(uv, '#!/bin/sh\n');
    put(path.join(f.runtimes, 'overrides', 'uv.json'), JSON.stringify({ schemaVersion: 1, executable: realpathSync(uv) }));
    const d = doubles({ archives: f.archives });
    const result = await installSoulRuntimes(f.dir, { ...f.options, ...d });
    assert.ok(!result.installed.includes('uv'));
    assert.ok(!d.fetched.some((url) => url.includes('/uv-')), 'the external uv selection avoids a managed uv archive');
    assert.ok(d.commands.filter((entry) => ['python', 'tool'].includes(entry.args[0])).every((entry) => entry.command === 'external-uv'), 'dependent provisioning invokes the selected uv executable');
    if (manifest.runtimes?.python) assert.ok(result.installed.includes('python'), 'uv does not override the Python executable');
    if (manifest.harnesses?.muse) assert.ok(result.installed.includes('muse'), 'the selected uv can provision its uv-tool harness');
  }
});

test('readiness rejects mismatched receipts and never routes their executable (#617)', async (t) => {
  const f = fixture(t, { manifest: { runtimes: { node: '24' } }, census: true });
  const d = doubles({ archives: f.archives });
  await installSoulRuntimes(f.dir, { ...f.options, ...d });
  const directory = path.join(f.runtimes, 'node', NODE.version);
  const file = path.join(directory, INSTALL_STAMP);
  const good = JSON.parse(readFileSync(file, 'utf8'));
  for (const patch of [
    { schemaVersion: 2 }, { name: 'go' }, { kind: 'uv-python' }, { version: '0.0.0' },
    { platform: 'win32-x64' }, { sha256: '0'.repeat(64) }, { bin: '../outside' },
    { bin: '/tmp' }, { bin: 'C:/outside' }, { bin: 'bin\\outside' }, { bin: '.' },
  ]) {
    put(file, JSON.stringify({ ...good, ...patch }));
    const state = inspectSoulRuntimes(f.dir, f.options);
    assert.equal(state.ready, false, JSON.stringify(patch));
    assert.equal(state.runtimes[0].status, 'missing');
    assert.equal(state.runtimes[0].path, null);
    assert.equal(state.runtimes[0].bin, null);
    assert.match(state.runtimes[0].reason, /install receipt/);
    assert.throws(() => soulRuntimeEnv(ID, f.options), /refusing host fallback/);
  }
  put(file, JSON.stringify(good));
  assert.equal(inspectSoulRuntimes(f.dir, f.options).ready, true);
});

test('same-version archive repair retains the conflicting install and failures leave it untouched (#617)', async (t) => {
  const f = fixture(t, { manifest: { runtimes: { node: '24' } } });
  const d = doubles({ archives: f.archives });
  await installSoulRuntimes(f.dir, { ...f.options, ...d });
  const directory = path.join(f.runtimes, 'node', NODE.version);
  const originalReceipt = readFileSync(path.join(directory, INSTALL_STAMP), 'utf8');
  put(path.join(directory, 'owner-note'), 'keep for recovery');
  const changed = archive({ [`node-v${NODE.version}/bin/node`]: '#!/bin/sh\n# new node\n', [`node-v${NODE.version}/bin/npm`]: '#!/bin/sh\n# new npm\n' });
  const source = f.catalog.node[0].sources[PLATFORM];
  source.url = 'https://example.test/replacement.tgz';
  source.sha256 = sha(changed);
  assert.match(inspectSoulRuntimes(f.dir, f.options).runtimes[0].reason, /archive digest/);
  await assert.rejects(installSoulRuntimes(f.dir, { ...f.options, runImpl: d.runImpl,
    fetchFn: doubles({ archives: { [source.url]: Buffer.from('bad') } }).fetchFn }), error => error.code === 'runtime-checksum-mismatch');
  assert.equal(readFileSync(path.join(directory, INSTALL_STAMP), 'utf8'), originalReceipt);
  assert.equal(readFileSync(path.join(directory, 'owner-note'), 'utf8'), 'keep for recovery');
  assert.equal(readdirSync(path.dirname(directory)).some(name => name.includes('.retained-')), false);
  const logs = [];
  const repaired = await installSoulRuntimes(f.dir, { ...f.options, runImpl: d.runImpl,
    fetchFn: doubles({ archives: { [source.url]: changed } }).fetchFn, log: line => logs.push(line) });
  assert.equal(repaired.ready, true);
  assert.equal(readFileSync(path.join(directory, 'bin/node'), 'utf8'), '#!/bin/sh\n# new node\n');
  const retained = readdirSync(path.dirname(directory)).filter(name => name.startsWith(`${NODE.version}.retained-`));
  assert.equal(retained.length, 1);
  assert.equal(readFileSync(path.join(path.dirname(directory), retained[0], INSTALL_STAMP), 'utf8'), originalReceipt);
  assert.equal(readFileSync(path.join(path.dirname(directory), retained[0], 'owner-note'), 'utf8'), 'keep for recovery');
  assert.ok(logs.some(line => line.includes(retained[0])));
  const again = await installSoulRuntimes(f.dir, { ...f.options, fetchFn: () => { throw new Error('no download'); } });
  assert.deepEqual(again.skipped, ['node']);
});

test('an installed runtime without the execute bit is not ready and refuses rather than run a host Node (#617)', async (t) => {
  const f = fixture(t, { manifest: { runtimes: { node: '24' } }, census: true });
  await installSoulRuntimes(f.dir, { ...f.options, ...doubles({ archives: f.archives }) });
  const node = path.join(f.runtimes, 'node', NODE.version, 'bin', 'node');
  assert.equal(inspectSoulRuntimes(f.dir, f.options).ready, true);
  chmodSync(node, 0o644);
  const row = inspectSoulRuntimes(f.dir, f.options).runtimes[0];
  assert.deepEqual([row.status, row.path, row.reason], ['missing', null, 'the installed node is missing or not executable']);
  assert.throws(() => soulRuntimeEnv(ID, { ...f.options, node: process.execPath }), (error) => error.code === 'runtime-install-failed'
    && error.runtime === 'node' && /not executable\); refusing host fallback/.test(error.message));
  // An archive whose declared executable is not executable is never published.
  const unexecutable = archive({ [`node-v${NODE.version}-darwin-arm64/bin/node`]: 'not a script', [`node-v${NODE.version}-darwin-arm64/bin/npm`]: 'not a script' });
  const source = f.catalog.node[0].sources[PLATFORM];
  source.url = 'https://example.test/unexecutable.tgz';
  source.sha256 = sha(unexecutable);
  rmSync(path.join(f.runtimes, 'node'), { recursive: true });
  await assert.rejects(installSoulRuntimes(f.dir, { ...f.options, ...doubles({ archives: { [source.url]: unexecutable } }) }), (error) => error.code === 'runtime-install-failed');
  assert.equal(inspectSoulRuntimes(f.dir, f.options).ready, false);
});

test('readiness selects the platform\'s executable name: a POSIX install is not satisfied by a node.exe, and a Windows one needs it (#617)', async (t) => {
  const f = fixture(t, { manifest: { runtimes: { node: '24' } }, census: true });
  await installSoulRuntimes(f.dir, { ...f.options, ...doubles({ archives: f.archives }) });
  const bin = path.join(f.runtimes, 'node', NODE.version, 'bin');
  chmodSync(path.join(bin, 'node'), 0o644);
  put(path.join(bin, 'node.exe'), '#!/bin/sh\n# a Windows-named node\n');
  const posix = inspectSoulRuntimes(f.dir, f.options).runtimes[0];
  assert.deepEqual([posix.status, posix.reason], ['missing', 'the installed node is missing or not executable']);
  assert.throws(() => soulRuntimeEnv(ID, { ...f.options, node: process.execPath }), (error) => error.code === 'runtime-install-failed' && error.runtime === 'node');

  // A Windows-shaped archive installs and is ready for win32 only.
  const w = fixture(t, { manifest: { runtimes: { node: '24' } } });
  const windows = archive({ [`node-v${NODE.version}-win-x64/bin/node.exe`]: '#!/bin/sh\n# node.exe\n', [`node-v${NODE.version}-win-x64/bin/npm`]: '#!/bin/sh\n' });
  const source = w.catalog.node[0].sources['win32-x64'];
  source.url = 'https://example.test/node-win.zip';
  source.sha256 = sha(windows);
  const installed = await installSoulRuntimes(w.dir, { ...w.options, platform: 'win32-x64', ...doubles({ archives: { [source.url]: windows } }) });
  assert.equal(installed.ready, true);
  assert.equal(inspectSoulRuntimes(w.dir, { ...w.options, platform: 'win32-x64' }).runtimes[0].status, 'installed');
  // On Windows only node.exe counts: a bare executable `node` does not stand in.
  const winBin = path.join(w.runtimes, 'node', NODE.version, 'bin');
  rmSync(path.join(winBin, 'node.exe'));
  put(path.join(winBin, 'node'), '#!/bin/sh\n# bare node\n');
  const bare = inspectSoulRuntimes(w.dir, { ...w.options, platform: 'win32-x64' }).runtimes[0];
  assert.deepEqual([bare.status, bare.reason], ['missing', 'the installed node.exe is missing or not executable']);

  // A harness install that declares `bin: 'Tool.EXE'` is not asked for Tool.EXE.exe.
  const toolArchive = archive({ 'Tool.EXE': '#!/bin/sh\n# tool\n' });
  const h = fixture(t, { manifest: { harnesses: { tool: { install: { kind: 'archive', version: '1.0.0', bin: 'Tool.EXE',
    url: 'https://example.test/tool-{platform}-{version}.zip', sha256: { 'win32-x64': sha(toolArchive) } } } } } });
  const toolInstall = await installSoulRuntimes(h.dir, { ...h.options, platform: 'win32-x64', ...doubles({ archives: { 'https://example.test/tool-win32-x64-1.0.0.zip': toolArchive } }) });
  assert.equal(toolInstall.harnesses[0].status, 'installed');
  assert.equal(inspectSoulRuntimes(h.dir, { ...h.options, platform: 'win32-x64' }).harnesses[0].status, 'installed');
});

test('readiness accepts internal executable links but refuses external links and escaped installation roots (#617)', async (t) => {
  const f = fixture(t, { manifest: { runtimes: { node: '24' } } });
  const d = doubles({ archives: f.archives });
  await installSoulRuntimes(f.dir, { ...f.options, ...d });
  const directory = path.join(f.runtimes, 'node', NODE.version);
  const executable = path.join(directory, 'bin/node');
  rmSync(executable);
  put(path.join(directory, 'bin/node-real'), '#!/bin/sh\n# internal node\n');
  symlinkSync('node-real', executable);
  assert.equal(inspectSoulRuntimes(f.dir, f.options).ready, true);
  rmSync(executable);
  const outside = path.join(f.home, 'outside-node');
  put(outside, 'outside node');
  symlinkSync(outside, executable);
  assert.equal(inspectSoulRuntimes(f.dir, f.options).ready, false);
  const repaired = await installSoulRuntimes(f.dir, { ...f.options, ...d });
  assert.equal(repaired.ready, true);
  assert.equal(readFileSync(outside, 'utf8'), 'outside node');
  const escaped = fixture(t, { manifest: { runtimes: { node: '24' } } });
  const externalRoot = path.join(escaped.home, 'external');
  mkdirSync(externalRoot);
  symlinkSync(externalRoot, escaped.runtimes);
  await assert.rejects(installSoulRuntimes(escaped.dir, { ...escaped.options,
    fetchFn: () => { throw new Error('must not download'); } }), /installation path escapes/);
  assert.deepEqual(readdirSync(externalRoot), []);
});
