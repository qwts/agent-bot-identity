import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { installWindowsLauncher, readWindowsLauncher, windowsLauncherText } from '../windows-cli-launcher.mjs';
import { installExecutable, installationPaths, isManagedExecutable, ensureExecutablePath } from '../install.mjs';
import { windowsInstallDirectory } from '../windows-install-path.mjs';
import { windowsGitShell, execCliFile } from '../windows-git-shell.mjs';
import { supervisorEnvironment } from '../daemon-supervisor.mjs';
import { daemonClient } from '../daemon-client.mjs';
import { upsertSoul, showSoul } from '../agent-population.mjs';
import { ensureSoulDirectory } from '../soul-home.mjs';
import { linkWorktree, assertWorktreeArea } from '../soul-worktrees.mjs';
import { realpathSync } from 'node:fs';
import { joinComms } from '../soul-join.mjs';
import { joinLaunchedSoul, leaveLaunchedSoul } from '../comms-membership.mjs';
import { lstatSync } from 'node:fs';

const native = { skip: process.platform !== 'win32' };
function fixture(t) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'agent-bot Windows launcher '));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const runtime = path.join(root, 'runtime with spaces');
  mkdirSync(runtime);
  writeFileSync(path.join(runtime, 'agent-bot.mjs'), 'console.log(JSON.stringify(process.argv.slice(2)));\n');
  return { root, entrypoint: path.join(runtime, 'agent-bot'), executable: path.join(root, 'bin', 'agent-bot') };
}

test('Windows install uses a canonical launcher pair without calling symlink', native, t => {
  const f = fixture(t);
  const executable = installExecutable({ home: f.root, entrypoint: f.entrypoint, symlink: () => assert.fail('symlink must not run') });
  assert.equal(executable, installationPaths(f.root).executable);
  assert.ok(readWindowsLauncher(executable));
  assert.equal(isManagedExecutable(executable, lstatSync(executable), f.entrypoint), true);
  assert.equal(installExecutable({ home: f.root, entrypoint: f.entrypoint }), executable);
  const result = spawnSync(path.join(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe'),
    ['-NoProfile', '-NonInteractive', '-Command', '& $env:LAUNCHER_PATH "argument with spaces" "quote-free"; exit $LASTEXITCODE'],
    { env: { ...process.env, LAUNCHER_PATH: executable + '.cmd' }, encoding: 'utf8', windowsHide: true, timeout: 10000 });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), ['argument with spaces', 'quote-free']);
});

// Exercise the installer's existing filesystem seams so this upgrade remains
// covered even on Windows accounts that cannot create legacy file symlinks.
function legacyLink(f, target) {
  const executable = installationPaths(f.root).executable;
  mkdirSync(path.dirname(executable), { recursive: true });
  writeFileSync(executable, 'legacy-link-fixture');
  return { executable, options: {
    home: f.root, entrypoint: f.entrypoint,
    lstat: file => file === executable ? { isSymbolicLink: () => true, isFile: () => false } : lstatSync(file),
    readlink: file => { assert.equal(file, executable); return target; },
    remove: file => { assert.equal(file, executable); rmSync(file); },
  } };
}

for (const name of ['agent-bot', 'agent-bot.mjs']) test(`Windows install migrates its legacy ${name} symlink`, native, t => {
  const f = fixture(t);
  const target = path.join(path.dirname(f.entrypoint), name);
  writeFileSync(target, 'legacy-runtime-preserved');
  const linked = name === 'agent-bot' ? target : path.relative(path.dirname(installationPaths(f.root).executable), target);
  const { executable, options } = legacyLink(f, linked);
  assert.equal(installExecutable(options), executable);
  assert.deepEqual(readWindowsLauncher(executable), { entry: path.join(path.dirname(f.entrypoint), 'agent-bot.mjs'), node: process.execPath });
  assert.equal(readFileSync(target, 'utf8'), 'legacy-runtime-preserved');
  assert.equal(installExecutable({ home: f.root, entrypoint: f.entrypoint }), executable);
});

test('Windows legacy migration preserves foreign symlinks and existing companions', native, t => {
  const f = fixture(t);
  const foreign = path.join(f.root, 'foreign', 'agent-bot');
  const { executable, options } = legacyLink(f, foreign);
  assert.throws(() => installExecutable(options));
  assert.equal(readFileSync(executable, 'utf8'), 'legacy-link-fixture');
  assert.equal(existsSync(executable + '.cmd'), false);
  writeFileSync(executable + '.cmd', 'existing-companion');
  assert.throws(() => installExecutable({ ...options, readlink: () => f.entrypoint }));
  assert.equal(readFileSync(executable, 'utf8'), 'legacy-link-fixture');
  assert.equal(readFileSync(executable + '.cmd', 'utf8'), 'existing-companion');
});

for (const suffix of ['', '.cmd']) test(`Windows install preserves foreign ${suffix || 'shell'} command`, native, t => {
  const f = fixture(t);
  mkdirSync(path.dirname(f.executable), { recursive: true });
  writeFileSync(f.executable + suffix, 'foreign-content');
  assert.throws(() => installWindowsLauncher(f.executable, { entrypoint: f.entrypoint }));
  assert.equal(readFileSync(f.executable + suffix, 'utf8'), 'foreign-content');
  assert.equal(existsSync(f.executable + (suffix ? '' : '.cmd')), false);
});

test('Windows pair refuses tampering, incomplete installs and another runtime', native, t => {
  const f = fixture(t);
  installWindowsLauncher(f.executable, { entrypoint: f.entrypoint });
  assert.throws(() => installWindowsLauncher(f.executable, { entrypoint: path.join(f.root, 'foreign', 'agent-bot') }));
  writeFileSync(f.executable + '.cmd', '@echo tampered\r\n');
  assert.equal(readWindowsLauncher(f.executable), null);
  assert.throws(() => installWindowsLauncher(f.executable, { entrypoint: f.entrypoint }));
  rmSync(f.executable + '.cmd');
  assert.equal(readWindowsLauncher(f.executable), null);
  assert.throws(() => installWindowsLauncher(f.executable, { entrypoint: f.entrypoint }));
});

test('Windows launcher refuses paths expanded by cmd or containing control data', native, t => {
  const f = fixture(t);
  for (const unsafe of ['percent%value', 'bang!value', 'quote"value', 'newline\nvalue']) {
    assert.throws(() => windowsLauncherText({ entrypoint: path.join(f.root, unsafe, 'agent-bot') }));
  }
});

test('Windows PATH registration preserves a mixed-case process Path and uses user registration', native, t => {
  const f = fixture(t);
  const env = { SystemRoot: process.env.SystemRoot, Path: 'C:\\existing tools;C:\\other' };
  let calls = 0;
  const result = ensureExecutablePath({ home: f.root, env, execFile: (command, args, options) => {
    calls++;
    assert.match(command, /WindowsPowerShell/);
    const script = Buffer.from(args.at(-1), 'base64').toString('utf16le');
    assert.match(script, /SetEnvironmentVariable\("Path",.*,"User"\)/);
    assert.doesNotMatch(script, /"Machine"/);
    assert.equal(options.input, installationPaths(f.root).binDir);
    return 'True';
  } });
  assert.equal(calls, 1);
  assert.equal(result.updated, true);
  assert.equal(env.Path, `${installationPaths(f.root).binDir};C:\\existing tools;C:\\other`);
  assert.equal(env.PATH, undefined);
  ensureExecutablePath({ home: f.root, env, execFile: () => 'False' });
  assert.equal(env.Path.split(';').length, 3);
});

test('Windows scheduler directory resolves an existing native handle and refuses malformed results', native, t => {
  const f = fixture(t);
  const physical = windowsInstallDirectory(f.root);
  assert.ok(path.isAbsolute(physical));
  assert.ok(existsSync(physical));
  for (const value of ['relative', 'C:\\unprefixed', '\\\\?\\C:\\bad\npath', '']) {
    assert.throws(() => windowsInstallDirectory(f.root, { run: () => value }), /install-directory-refused/);
  }
});

test('Windows hook dispatch uses Git shell and preserves argument boundaries', native, t => {
  const f = fixture(t);
  const git = args => {
    const result = spawnSync('git', args, { cwd: f.root, encoding: 'utf8', windowsHide: true });
    assert.equal(result.status, 0, result.stderr);
  };
  git(['init', '--quiet']);
  const hooks = path.join(f.root, 'chained hooks');
  mkdirSync(hooks);
  writeFileSync(path.join(hooks, 'post-rewrite'), '#!/bin/sh\nprintf "[%s]" "$@"\n', { mode: 0o755 });
  git(['config', 'agentBot.chainedHooksPath', hooks.replaceAll('\\', '/')]);
  const entry = path.resolve('agent-bot.mjs');
  const result = spawnSync(process.execPath, [entry, 'hook', 'post-rewrite', 'argument with spaces', 'second'],
    { cwd: f.root, encoding: 'utf8', windowsHide: true, timeout: 15000 });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, '[argument with spaces][second]');
  assert.throws(() => windowsGitShell({ exists: () => false }), /git-for-windows-shell-unavailable/);
});

test('Windows soul space and external worktree links use privilege-free junctions', native, t => {
  const f = fixture(t);
  const id = 'agent_33333333-3333-4333-8333-333333333333';
  const options = { home: f.root, env: { AGENT_BOT_SOULS_HOME: path.join(f.root, 'souls') },
    config: {}, file: path.join(f.root, 'population.json') };
  const space = path.join(f.root, 'existing space');
  mkdirSync(space);
  writeFileSync(path.join(space, 'memory'), 'preserved');
  upsertSoul({ id, name: 'windows-test', status: 'active', spacePath: space }, options);
  const soul = ensureSoulDirectory(id, null, options);
  const alias = path.join(soul, '.soul-state', 'space');
  assert.equal(realpathSync(alias), realpathSync(space));
  assert.equal(readFileSync(path.join(alias, 'memory'), 'utf8'), 'preserved');
  assert.equal(ensureSoulDirectory(id, null, options), soul);
  const link = linkWorktree(id, f.root, { ...options, name: 'existing-checkout' });
  assert.equal(realpathSync(link), realpathSync(f.root));
  assert.equal(linkWorktree(id, f.root, { ...options, name: 'existing-checkout' }), link);
  assert.doesNotThrow(() => assertWorktreeArea(id, f.root, options));
  const foreign = path.join(soul, 'worktrees', 'foreign');
  mkdirSync(foreign);
  assert.equal(linkWorktree(id, f.root, { ...options, name: 'foreign' }), foreign + '-2');
  assert.equal(lstatSync(foreign).isDirectory(), true);
  assert.equal(showSoul(id, options).spacePath, space);
  // Break only the junction before fixture cleanup, so the test cannot recurse
  // back into its own root through the external-checkout discovery alias.
  rmSync(link);
  rmSync(foreign + '-2');
});

test('Windows tool dispatch preserves shell metacharacters as literal arguments', native, async t => {
  const f = fixture(t);
  const command = path.join(f.root, 'comms launcher');
  const quote = value => `'${value.replaceAll("'", "'\\''")}'`;
  writeFileSync(command, `#!/bin/sh\nexec ${quote(process.execPath.replaceAll('\\', '/'))} ${quote(path.join(path.dirname(f.entrypoint), 'agent-bot.mjs').replaceAll('\\', '/'))} "$@"\n`);
  const args = ['spaced argument', 'semi;colon', '$(echo injected)', 'pipe|value', 'quote"value'];
  const stdout = await new Promise((resolve, reject) => execCliFile(command.replaceAll('\\', '/'), args,
    { cwd: f.root, env: process.env, timeout: 10000 }, (error, stdout) => error ? reject(error) : resolve(stdout)));
  assert.deepEqual(JSON.parse(stdout), args);
});

test('Windows scheduled daemon retains a host Path while health and storage deadlines stay separate', native, async t => {
  const f = fixture(t);
  const hostPath = 'C:\\host Git\\cmd;C:\\Windows\\System32';
  assert.equal(supervisorEnvironment({ platform: 'win32', home: f.root, env: { Path: hostPath } }).PATH, hostPath);
  const state = path.join(f.root, 'daemon.json');
  writeFileSync(state, JSON.stringify({ schemaVersion: 1, pid: 4242, host: '127.0.0.1', port: 45123, token: 't'.repeat(32), startedAt: new Date().toISOString() }));
  const budgets = [];
  const original = AbortSignal.timeout;
  AbortSignal.timeout = ms => { budgets.push(ms); return original(ms); };
  t.after(() => { AbortSignal.timeout = original; });
  const options = { env: { AGENT_BOT_DAEMON_STATE_PATH: state }, fetchImpl: async () => new Response(JSON.stringify({ status: 'ok', pid: 4242 })) };
  const client = daemonClient(options);
  assert.equal(await client.available(), true);
  await client.bind({ gitDir: f.root, token: 'fake-token', transcript: { provider: 'test', id: 'test' } });
  await daemonClient({ ...options, timeoutMs: 5000 }).bind({ gitDir: f.root, token: 'fake-token', transcript: { provider: 'test', id: 'test' } });
  assert.deepEqual(budgets, [1500, 60000, 5000]);
});

test('Windows Git hooks load native module paths and still reject human attribution for a stated bot', native, t => {
  const f = fixture(t);
  const git = args => {
    const result = spawnSync('git', args, { cwd: f.root, encoding: 'utf8', windowsHide: true });
    assert.equal(result.status, 0, result.stderr);
  };
  git(['init', '--quiet']);
  git(['config', 'user.name', 'fixture-human']);
  git(['config', 'user.email', 'fixture@example.test']);
  const config = path.join(f.root, 'config.json');
  writeFileSync(config, JSON.stringify({ features: { 'github-identity': true } }));
  const installed = path.join(f.root, 'agent-hook');
  writeFileSync(installed, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  const entry = path.resolve('agent-bot.mjs');
  const env = { ...process.env, GH_AGENT_APP: 'qwts-codex-agent', AGENT_BOT_CONFIG: config, AGENT_BOT_HOOK_BIN: installed };
  const guard = spawnSync(process.execPath, [entry, 'hook', 'pre-commit'], { cwd: f.root, env, encoding: 'utf8', windowsHide: true });
  assert.notEqual(guard.status, 0);
  assert.match(guard.stderr, /qwts-codex-agent/);
  assert.doesNotMatch(guard.stderr, /ESM loader|protocol 'c:'/);
  writeFileSync(config, JSON.stringify({ features: { 'github-identity': false } }));
  const message = path.join(f.root, 'message');
  writeFileSync(message, 'fixture\n');
  const gate = spawnSync(process.execPath, [entry, 'hook', 'prepare-commit-msg', message], { cwd: f.root, env, encoding: 'utf8', windowsHide: true });
  assert.equal(gate.status, 0, gate.stderr);
});

test('Windows membership command budget contains the daemon and broker deadlines', native, async t => {
  const f = fixture(t);
  let calls = 0;
  const run = (file, args, options, callback) => {
    assert.equal(file, 'agent-comms');
    assert.equal(options.timeout, 90000);
    calls++;
    callback(null, JSON.stringify({ ok: true, address: 'fixture/soul' }));
  };
  const soul = { agentId: 'agent_33333333-3333-4333-8333-333333333333', harness: 'fixture', name: 'fixture', worktree: f.root,
    binding: { file: path.join(f.root, 'binding.json'), worktree: f.root } };
  await joinComms(soul, { env: process.env, run });
  await joinLaunchedSoul(soul, { env: { ...process.env, AGENT_BOT_SKIP_LOGIN_PATH: '1' }, run });
  await leaveLaunchedSoul(soul, { env: { ...process.env, AGENT_BOT_SKIP_LOGIN_PATH: '1' }, run });
  assert.equal(calls, 3);
});
