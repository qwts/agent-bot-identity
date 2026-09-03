// Hermetic fresh-machine bootstrap coverage (ENG issue #67).
//
// Every scenario runs the public source launcher (`./agent-bot bootstrap`)
// end to end in a child process, under a cold temporary HOME with nothing
// installed and a controlled PATH built by tests/helpers/cold-home.mjs:
// real git and node behind explicit symlinks, a fake Proton Pass CLI serving
// deterministic fixtures, guarded stand-ins that fail loudly if the runtime
// ever reaches for the host's `security`, `pass`, `gh`, or `npm`, and a mock
// GitHub App server for installation discovery, token minting, and bot UID
// lookup. No scenario reads or writes the developer's real keychain, pass
// store, runtime config, or global Git settings, and nothing requires npm or
// the network.

import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { installationPaths } from '../install.mjs';
import { credentialHelperCommand } from '../setup-worktree.mjs';
import {
  addLinkedWorktree,
  createColdHome,
  createRepoWithLinkedWorktree,
  guardedInvocations,
  minimalUtilityPath,
  seedPassItem,
} from './helpers/cold-home.mjs';
import { MOCK_BOT_UID, startMockGitHubApp } from './helpers/mock-github-app.mjs';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const LAUNCHER = join(ROOT, 'agent-bot');
const SLUG = 'cold-codex-agent';

const servers = [];
// `after`, not `afterEach`: top-level afterEach hooks also run between
// subtests, which would kill the mock GitHub App halfway through a scenario.
after(() => {
  servers.splice(0).forEach((server) => server.stop());
});

function runLauncher(fixture, args, { cwd = fixture.root, env = {} } = {}) {
  return spawnSync(LAUNCHER, args, {
    cwd,
    env: { ...fixture.env, ...env },
    encoding: 'utf8',
  });
}

function reportFrom(run) {
  assert.doesNotMatch(
    run.stderr,
    /keychain|osxkeychain|security:|pass-cli|gh auth/i,
    'bootstrap must never surface host credential-store noise',
  );
  return JSON.parse(run.stdout);
}

function git(fixture, cwd, ...args) {
  // Trailing-only trim: `credential.helper` legitimately begins with an empty
  // entry (the reset), which a full trim would silently swallow.
  return execFileSync('git', args, {
    cwd,
    env: fixture.env,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).replace(/[\r\n]+$/, '');
}

function optionalGit(fixture, cwd, ...args) {
  const result = spawnSync('git', args, { cwd, env: fixture.env, encoding: 'utf8' });
  return result.status === 0 ? result.stdout.trim() : null;
}

function writeConfigSource(fixture, apiBase) {
  const source = join(fixture.root, 'organization-config.json');
  writeFileSync(source, JSON.stringify({
    apps: { codex: SLUG },
    owner: 'test-owner',
    apiBase,
  }));
  return source;
}

function assertColdSandboxIntact(fixture) {
  assert.equal(guardedInvocations(fixture), '', 'a guarded host executable was invoked');
}

test('cold machine bootstrap: delegate refusal, complete install, idempotent rerun, worktree-only binding', async (t) => {
  const fixture = createColdHome();
  const github = startMockGitHubApp(fixture.root);
  servers.push(github);
  seedPassItem(fixture, SLUG, { privateKeyPem: github.privateKeyPem });
  const configSource = writeConfigSource(fixture, github.apiBase);
  const { repo, worktree } = createRepoWithLinkedWorktree(fixture);
  const paths = installationPaths(fixture.home);
  const configPath = join(fixture.home, '.config', 'agent-bot', 'config.json');
  const shimPath = join(fixture.home, '.config', 'agent-bot', 'bin', 'gh');
  const host = new URL(github.apiBase).host;

  // ENG-0339: the account, not the directory, is bot territory. The fixture's
  // account is the owner's (AGENT_BOT_ACCOUNT unset — the real short name,
  // which is not on the roster), so with no pin and no GH_AGENT_APP the
  // checkout is the human's own and bootstrap has no identity to bind.
  await t.test('full bootstrap in the owner account readies the machine but leaves the human checkout human', () => {
    const run = runLauncher(fixture, ['bootstrap', '--json', '--with-gh-shim', '--config', configSource], { cwd: repo });
    const report = reportFrom(run);
    assert.equal(run.status, 1, run.stdout);
    assert.equal(report.ready, false);
    assert.equal(report.machine.status, 'ready');
    assert.equal(report.worktree.status, 'not_ready');
    assert.equal(report.first_actionable_failure.code, 'bot-identity-unresolved');
    // Machine state exists now; the human's primary checkout stays human.
    assert.equal(readlinkSync(paths.executable), LAUNCHER);
    assert.equal(optionalGit(fixture, repo, 'config', '--get', 'agentBot.app'), null);
    assert.equal(git(fixture, repo, 'config', '--get', 'user.name'), 'Fixture Human');
  });

  // From here the scenario runs as the agent account (AGENT_BOT_ACCOUNT names
  // it, the same seam the shell hooks and the gh shim honor): the account is
  // the identity a checkout resolves through when nothing pins it.
  const AGENT_ACCOUNT = { AGENT_BOT_ACCOUNT: SLUG };

  await t.test('complete bootstrap restores credentials cold and binds the linked worktree', () => {
    const run = runLauncher(fixture, ['bootstrap', '--json', '--with-gh-shim', '--config', configSource], { cwd: worktree, env: AGENT_ACCOUNT });
    const report = reportFrom(run);
    assert.equal(run.status, 0, `${run.stdout}\n${run.stderr}`);
    assert.equal(report.ready, true);
    assert.equal(report.scope, 'all');
    assert.equal(report.machine.status, 'ready');
    assert.equal(report.worktree.status, 'ready');

    // Fake secure store actually served the credentials on this cold HOME.
    assert.deepEqual(report.machine.apps.map((app) => app.slug), [SLUG]);
    assert.equal(report.machine.apps[0].credential.status, 'ready');
    assert.equal(report.machine.apps[0].live_mint.status, 'ready');
    assert.equal(report.machine.apps[0].live_mint.evidence.installation_id, 1);
    assert.equal(
      readFileSync(join(fixture.home, '.config', SLUG, 'app-id'), 'utf8').trim(),
      '12345',
    );
    assert.equal(
      readFileSync(join(fixture.home, '.config', SLUG, 'private-key.pem'), 'utf8'),
      github.privateKeyPem,
    );
    assert.equal(statSync(configPath).mode & 0o777, 0o600);
    assert.deepEqual(JSON.parse(readFileSync(configPath, 'utf8')).apps, { codex: SLUG });

    // Machine installation is complete and entirely inside the cold HOME.
    assert.equal(readlinkSync(paths.executable), LAUNCHER);
    assert.ok(lstatSync(join(paths.hooksDir, 'post-checkout')).isFile());
    assert.ok(existsSync(paths.agentHook));
    assert.ok(existsSync(shimPath));
    assert.equal(readlinkSync(join(fixture.home, '.local', 'bin', 'gh')), shimPath);
    const globalConfig = readFileSync(fixture.globalGitConfig, 'utf8');
    assert.match(globalConfig, /hooksPath = .*\.local\/share\/agent-bot\/hooks/);
    assert.doesNotMatch(globalConfig, /credential|user\.name|signingkey/i);

    // Worktree identity: the bot, and only the bot.
    assert.equal(git(fixture, worktree, 'config', '--worktree', '--get', 'agentBot.app'), SLUG);
    assert.equal(git(fixture, worktree, 'config', '--worktree', '--get', 'user.name'), `${SLUG}[bot]`);
    assert.equal(
      git(fixture, worktree, 'config', '--worktree', '--get', 'user.email'),
      `${MOCK_BOT_UID}+${SLUG}[bot]@users.noreply.${host}`,
    );
    assert.equal(git(fixture, worktree, 'config', '--worktree', '--get', 'commit.gpgsign'), 'false');
    assert.equal(
      readFileSync(join(fixture.home, '.config', SLUG, 'bot-uid'), 'utf8').trim(),
      MOCK_BOT_UID,
    );

    // Requirement: no human credential helper and no GitHub login may be
    // selected. The helper list must be exactly a reset entry (which blots out
    // every inherited human helper) followed by the bot App helper.
    const helpers = git(fixture, worktree, 'config', '--get-all', 'credential.helper').split('\n');
    assert.deepEqual(helpers, [
      '',
      credentialHelperCommand(paths.executable, SLUG, { subcommand: 'credential' }),
    ]);
    for (const helper of helpers) {
      assert.doesNotMatch(helper, /osxkeychain|libsecret|wincred|manager|store|cache|gh\s+auth|!gh\b/i);
    }
    assert.equal(
      git(fixture, worktree, 'remote', 'get-url', 'origin'),
      'https://github.com/example/repo',
      'SSH origin must be rewritten so pushes cannot authenticate as the human',
    );

    assertColdSandboxIntact(fixture);
  });

  await t.test('bootstrap rerun is idempotent', () => {
    const zshenvBefore = readFileSync(join(fixture.home, '.zshenv'), 'utf8');
    const configBefore = readFileSync(configPath, 'utf8');

    const run = runLauncher(fixture, ['bootstrap', '--json', '--with-gh-shim', '--config', configSource], { cwd: worktree, env: AGENT_ACCOUNT });
    const report = reportFrom(run);
    assert.equal(run.status, 0, `${run.stdout}\n${run.stderr}`);
    assert.equal(report.ready, true);

    assert.equal(readFileSync(configPath, 'utf8'), configBefore);
    const zshenv = readFileSync(join(fixture.home, '.zshenv'), 'utf8');
    assert.equal(zshenv, zshenvBefore);
    assert.equal(zshenv.split('# agent-bot CLI').length, 2, 'PATH line must not be duplicated');
    const helpers = git(fixture, worktree, 'config', '--get-all', 'credential.helper').split('\n');
    assert.equal(helpers.length, 2, 'rerun must not stack credential helpers');
    assertColdSandboxIntact(fixture);
  });

  await t.test('worktree-only bootstrap binds a second linked worktree without machine mutation', () => {
    const second = addLinkedWorktree(fixture, repo, { session: 'second', branch: 'second-topic' });
    const globalBefore = readFileSync(fixture.globalGitConfig, 'utf8');

    const run = runLauncher(fixture, ['bootstrap', '--worktree-only', '--json'], { cwd: second, env: AGENT_ACCOUNT });
    const report = reportFrom(run);
    assert.equal(run.status, 0, `${run.stdout}\n${run.stderr}`);
    assert.equal(report.ready, true);
    assert.equal(report.scope, 'worktree');
    assert.equal(report.machine.status, 'not_requested');
    assert.equal(report.worktree.status, 'ready');

    assert.equal(git(fixture, second, 'config', '--worktree', '--get', 'agentBot.app'), SLUG);
    assert.equal(git(fixture, second, 'config', '--worktree', '--get', 'user.name'), `${SLUG}[bot]`);
    assert.equal(readFileSync(fixture.globalGitConfig, 'utf8'), globalBefore);
    assert.equal(optionalGit(fixture, repo, 'config', '--get', 'agentBot.app'), null);
    assertColdSandboxIntact(fixture);
  });

  // ENG-0339 acceptance (c): in an agent account every checkout is bot work,
  // the primary one included — no linked-worktree requirement remains.
  await t.test('worktree-only bootstrap binds the primary checkout in an agent account', () => {
    const run = runLauncher(fixture, ['bootstrap', '--worktree-only', '--json'], { cwd: repo, env: AGENT_ACCOUNT });
    const report = reportFrom(run);
    assert.equal(run.status, 0, `${run.stdout}\n${run.stderr}`);
    assert.equal(report.ready, true);
    assert.equal(report.worktree.status, 'ready');
    assert.equal(report.worktree.checks[0].message, 'primary checkout');
    assert.equal(git(fixture, repo, 'config', '--worktree', '--get', 'agentBot.app'), SLUG);
    assert.equal(git(fixture, repo, 'config', '--worktree', '--get', 'user.name'), `${SLUG}[bot]`);
    assertColdSandboxIntact(fixture);
  });
});

test('bootstrap refuses a conflicting installed runtime config without mutating the machine', () => {
  const fixture = createColdHome();
  const configPath = join(fixture.home, '.config', 'agent-bot', 'config.json');
  mkdirSync(dirname(configPath), { recursive: true });
  const existing = JSON.stringify({ apps: { codex: 'existing-agent' } });
  writeFileSync(configPath, existing, { mode: 0o600 });
  const source = writeConfigSource(fixture, 'https://api.github.invalid');

  const run = runLauncher(fixture, ['bootstrap', '--json', '--machine-only', '--config', source]);
  const report = reportFrom(run);
  assert.equal(run.status, 1, run.stdout);
  assert.equal(report.ready, false);
  assert.equal(report.first_actionable_failure.code, 'config-apply-failed');

  assert.equal(readFileSync(configPath, 'utf8'), existing, 'conflicting config must stay untouched');
  assert.equal(existsSync(installationPaths(fixture.home).executable), false, 'runtime must not install after the conflict');
  assert.equal(readFileSync(fixture.globalGitConfig, 'utf8'), '');
  assertColdSandboxIntact(fixture);
});

test('bootstrap rejects an invalid organization profile before any machine mutation', () => {
  const fixture = createColdHome();
  const sentinel = 'SENTINEL_OWNER_NEVER_IN_REPORT';
  const profile = join(fixture.root, 'organization-profile.json');
  writeFileSync(profile, JSON.stringify({
    schema_version: 1,
    organization: 'cold-fixture-org',
    account_owner: sentinel,
    minimum_runtime_interface_version: 1,
    // defaults and identities are deliberately missing.
  }));

  const run = runLauncher(fixture, ['bootstrap', '--json', '--machine-only', '--profile', profile]);
  const report = reportFrom(run);
  assert.equal(run.status, 1, run.stdout);
  assert.equal(report.ready, false);
  assert.equal(report.first_actionable_failure.code, 'profile-invalid');
  assert.doesNotMatch(run.stdout, new RegExp(sentinel), 'profile content must not leak into the report');

  assert.equal(existsSync(join(fixture.home, '.config', 'agent-bot', 'config.json')), false);
  assert.equal(existsSync(installationPaths(fixture.home).executable), false);
  assert.equal(readFileSync(fixture.globalGitConfig, 'utf8'), '');
  assertColdSandboxIntact(fixture);
});

test('bootstrap reports missing provider credentials and leaves shim and worktree untouched', () => {
  const fixture = createColdHome();
  // Valid config, but the fake secure store holds no item for the App.
  const source = writeConfigSource(fixture, 'https://api.github.invalid');
  const { worktree } = createRepoWithLinkedWorktree(fixture);

  const run = runLauncher(fixture, ['bootstrap', '--json', '--with-gh-shim', '--config', source], { cwd: worktree, env: { AGENT_BOT_ACCOUNT: SLUG } });
  const report = reportFrom(run);
  assert.equal(run.status, 1, run.stdout);
  assert.equal(report.ready, false);
  assert.equal(report.machine.status, 'not_ready');
  assert.deepEqual(report.machine.apps.map((app) => app.slug), [SLUG]);
  assert.equal(report.machine.apps[0].credential.status, 'failed');
  assert.equal(report.machine.apps[0].credential.code, 'missing-item');
  assert.equal(report.machine.apps[0].live_mint.status, 'skipped');

  // Ordered refusal: nothing downstream of the credential failure may mutate.
  assert.equal(existsSync(join(fixture.home, '.config', SLUG, 'private-key.pem')), false);
  assert.equal(existsSync(join(fixture.home, '.config', 'agent-bot', 'bin', 'gh')), false, 'gh shim must not install');
  assert.equal(optionalGit(fixture, worktree, 'config', '--worktree', '--get', 'agentBot.app'), null);
  assertColdSandboxIntact(fixture);
});

test('source launcher fails closed when no supported Node is discoverable', () => {
  const fixture = createColdHome({ node: false });
  const utilities = minimalUtilityPath(fixture.root);

  const unavailable = spawnSync(LAUNCHER, ['--version'], {
    encoding: 'utf8',
    env: { ...fixture.env, PATH: utilities },
  });
  assert.equal(unavailable.status, 127);
  assert.match(unavailable.stderr, /Node\.js >= 20 is required; install it or set AGENT_BOT_NODE/);

  // Same machine, explicit runtime: proves discovery was the only failure and
  // the documented AGENT_BOT_NODE escape hatch works without npm.
  const explicit = spawnSync(LAUNCHER, ['--version'], {
    encoding: 'utf8',
    env: { ...fixture.env, PATH: utilities, AGENT_BOT_NODE: process.execPath },
  });
  assert.equal(explicit.status, 0, explicit.stderr);

  // An nvm-managed Node inside the cold HOME is discovered from the same
  // Node-free PATH — the launcher's supported discovery, npm never involved.
  const nvmNode = join(fixture.home, '.nvm', 'versions', 'node', 'v20.0.0', 'bin', 'node');
  mkdirSync(dirname(nvmNode), { recursive: true });
  symlinkSync(process.execPath, nvmNode);
  const discovered = spawnSync(LAUNCHER, ['--version'], {
    encoding: 'utf8',
    env: { ...fixture.env, PATH: utilities },
  });
  assert.equal(discovered.status, 0, discovered.stderr);
  assertColdSandboxIntact(fixture);
});

test('worktree-only bootstrap fails closed on a machine without the installed runtime', () => {
  const fixture = createColdHome();
  const { worktree } = createRepoWithLinkedWorktree(fixture);

  const run = runLauncher(fixture, ['bootstrap', '--worktree-only', '--json'], { cwd: worktree });
  const report = reportFrom(run);
  assert.equal(run.status, 1, run.stdout);
  assert.equal(report.ready, false);
  assert.equal(report.scope, 'worktree');
  assert.equal(report.first_actionable_failure.code, 'installed-runtime-required');
  assert.equal(optionalGit(fixture, worktree, 'config', '--worktree', '--get', 'agentBot.app'), null);
  assertColdSandboxIntact(fixture);
});
