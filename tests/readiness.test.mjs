import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { installationPaths } from '../install.mjs';
import { main as doctorMain } from '../doctor.mjs';
import { organizationProfileToConfig } from '../organization-profile.mjs';
import { hermeticGitEnv } from './helpers/hermetic-git.mjs';
import {
  READINESS_SCHEMA_VERSION,
  collectReadiness,
  credentialHelperSequenceReady,
  renderReadinessJson,
  renderReadinessReport,
  requireReadinessSchema,
} from '../readiness.mjs';

const roots = [];
const sourceEntrypoint = fileURLToPath(new URL('../agent-bot', import.meta.url));

function tempRoot() {
  const root = mkdtempSync(join(tmpdir(), 'agent-readiness-'));
  roots.push(root);
  return root;
}

// Secret-free failure summary: check IDs, codes, and git error evidence only —
// never messages, paths, or credential material.
function failedChecks(report) {
  return [
    ...report.machine.checks,
    ...report.machine.apps.flatMap((app) => [app.credential, app.live_mint]),
    ...report.worktree.checks,
  ]
    .filter((check) => check.status === 'failed')
    .map((check) => {
      const gitError = check.evidence?.git_error;
      return `${check.id}:${check.code ?? 'no-code'}${gitError ? `:${gitError}` : ''}`;
    })
    .join(', ') || 'none';
}

function machineDependencies(home, { shim = false, inspectCredentials } = {}) {
  const paths = installationPaths(home);
  return {
    home,
    env: { HOME: home },
    cwd: home,
    lstat: () => ({ isSymbolicLink: () => true }),
    readlink: () => sourceEntrypoint,
    spawn: () => ({ status: 0, stdout: `${paths.executable}\n` }),
    exists: (path) => shim && path.endsWith('/bin/gh'),
    access: () => {},
    git: (args) => {
      if (args[0] === '--version') return 'git version 2.50.1';
      if (args.join(' ') === 'config --global --get core.hooksPath') return paths.hooksDir;
      throw Object.assign(new Error('unexpected git call'), { status: 1 });
    },
    load: () => ({ apps: { codex: 'org-codex-agent', claude: 'org-claude-agent' } }),
    inspectCredentials: inspectCredentials ?? (async ({ slugs }) => slugs.map((slug, index) => ({
      slug,
      local: { status: 'ready', restored: [] },
      live: {
        status: 'ready',
        installationId: index + 1,
        expiresAt: '2026-08-10T00:00:00.000Z',
      },
    }))),
  };
}

after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

test('schema v1 is deterministic, secret-free, and warnings do not fail readiness', async () => {
  const home = tempRoot();
  const report = await collectReadiness({
    command: 'doctor',
    scope: 'machine',
    ...machineDependencies(home),
    load: () => ({
      apiBase: 'https://secret-user:secret-password@api.github.com/private-path',
      apps: { codex: 'org-codex-agent', claude: 'org-claude-agent' },
    }),
  });
  assert.deepEqual(Object.keys(report), [
    'schema_version',
    'command',
    'scope',
    'ready',
    'machine',
    'worktree',
    'first_actionable_failure',
  ]);
  assert.equal(report.schema_version, READINESS_SCHEMA_VERSION);
  assert.equal(report.ready, true);
  assert.equal(report.machine.status, 'ready');
  assert.equal(report.worktree.status, 'not_requested');
  assert.deepEqual(report.machine.apps.map(({ slug }) => slug), [
    'org-claude-agent',
    'org-codex-agent',
  ]);
  assert.equal(report.machine.checks.find(({ id }) => id === 'shim.gh').status, 'warning');
  assert.equal(
    report.machine.checks.find(({ id }) => id === 'config.runtime').evidence.api_base,
    'https://api.github.com',
  );
  assert.equal(report.first_actionable_failure, null);
  assert.doesNotMatch(
    renderReadinessJson(report),
    /token|private-key\.pem|BEGIN PRIVATE KEY|secret-user|secret-password|private-path/,
  );
});

test('machine readiness reports profile compatibility and the complete active roster', async () => {
  const home = tempRoot();
  const config = organizationProfileToConfig({
    schema_version: 1,
    organization: 'example-engineering',
    account_owner: 'example',
    minimum_runtime_interface_version: 1,
    defaults: { codex: 'example-codex-agent' },
    identities: [
      { slug: 'example-codex-agent', harness: 'codex', status: 'active' },
      {
        slug: 'example-codex-sol-agent',
        harness: 'codex',
        status: 'active',
        models: ['gpt-5.6-sol'],
      },
      { slug: 'example-retired-agent', harness: 'codex', status: 'retired' },
    ],
  });
  const report = await collectReadiness({
    command: 'doctor',
    scope: 'machine',
    ...machineDependencies(home),
    load: () => config,
  });
  const profile = report.machine.checks.find(({ id }) => id === 'config.profile');
  assert.equal(profile.status, 'ready');
  assert.deepEqual(profile.evidence, {
    source: 'organization-profile',
    organization: 'example-engineering',
    account_owner: 'example',
    profile_schema_version: 1,
    runtime_interface_version: 1,
    active_apps: 2,
    retired_apps: 1,
  });
  assert.deepEqual(report.machine.apps.map(({ slug }) => slug), [
    'example-codex-agent',
    'example-codex-sol-agent',
  ]);
});

test('machine report identifies the exact App and suppresses all live evidence after a local failure', async () => {
  const home = tempRoot();
  const report = await collectReadiness({
    command: 'doctor',
    scope: 'machine',
    ...machineDependencies(home, {
      inspectCredentials: async ({ slugs }) => slugs.map((slug) => ({
        slug,
        local: slug === 'org-codex-agent'
          ? { status: 'failed', code: 'missing-private-key', action: 'repair key' }
          : { status: 'ready', restored: [] },
        live: { status: 'skipped', code: 'local-roster-incomplete' },
      })),
    }),
  });
  assert.equal(report.ready, false);
  const failed = report.machine.apps.find(({ slug }) => slug === 'org-codex-agent');
  assert.equal(failed.credential.code, 'missing-private-key');
  assert.ok(report.machine.apps.every(({ live_mint }) => live_mint.status === 'skipped'));
  assert.equal(report.first_actionable_failure.app_slug, 'org-codex-agent');
});

test('required shim, installed skill, managed target, and config failures are independent checks', async () => {
  const home = tempRoot();
  let inspected = false;
  const base = machineDependencies(home, {
    inspectCredentials: async () => {
      inspected = true;
      return [];
    },
  });
  const report = await collectReadiness({
    command: 'doctor',
    scope: 'machine',
    ...base,
    expectedGhShim: true,
    readlink: () => '/foreign/agent-bot',
    access: (path) => {
      if (path.includes('/skills/agent-bot/')) throw Object.assign(new Error('missing'), { code: 'ENOENT' });
    },
    load: () => { throw new Error('secret config contents'); },
  });
  assert.equal(inspected, false);
  assert.equal(report.ready, false);
  assert.equal(
    report.machine.checks.find(({ id }) => id === 'runtime.installed_cli').code,
    'installed-cli-unmanaged',
  );
  assert.equal(report.machine.checks.find(({ id }) => id === 'config.runtime').code, 'config-invalid');
  assert.equal(report.machine.checks.find(({ id }) => id === 'shim.gh').status, 'failed');
  assert.equal(report.machine.checks.find(({ id }) => id === 'skill.runtime').status, 'failed');
  assert.doesNotMatch(JSON.stringify(report), /secret config contents|\/foreign\/agent-bot/);
});

test('skipped bootstrap verification passes a null verifier and preserves the operation failure', async () => {
  const home = tempRoot();
  let verifier = 'unobserved';
  const operationCheck = {
    id: 'bootstrap.runtime',
    status: 'failed',
    code: 'runtime-install-failed',
    message: 'runtime install failed',
    action: 'repair runtime',
    evidence: {},
  };
  const report = await collectReadiness({
    command: 'bootstrap',
    scope: 'machine',
    operationFailure: { scope: 'machine', check: operationCheck },
    verifyApps: false,
    ...machineDependencies(home, {
      inspectCredentials: async ({ slugs, verify }) => {
        verifier = verify;
        return slugs.map((slug) => ({
          slug,
          local: { status: 'ready', restored: [] },
          live: { status: 'skipped', code: 'verification-not-run' },
        }));
      },
    }),
  });
  assert.equal(verifier, null);
  assert.equal(report.first_actionable_failure.code, 'runtime-install-failed');
  assert.equal(report.ready, false);
});

test('bootstrap evidence must cover the exact roster and restored credentials are ready', async () => {
  const home = tempRoot();
  const result = (slug, localStatus = 'ready') => ({
    slug,
    local: { status: localStatus, restored: localStatus === 'restored' ? ['app-id'] : [] },
    live: {
      status: 'ready',
      installationId: 1,
      expiresAt: '2026-08-10T00:00:00Z',
    },
  });
  const complete = await collectReadiness({
    command: 'bootstrap',
    scope: 'machine',
    ...machineDependencies(home),
    appResults: [result('org-codex-agent'), result('org-claude-agent', 'restored')],
  });
  assert.equal(complete.ready, true);
  const restored = complete.machine.apps.find(({ slug }) => slug === 'org-claude-agent');
  assert.equal(restored.credential.status, 'ready');
  assert.match(restored.credential.message, /restored and validated/);

  const incomplete = await collectReadiness({
    command: 'bootstrap',
    scope: 'machine',
    ...machineDependencies(home, {
      inspectCredentials: async () => assert.fail('an incomplete supplied roster was re-probed'),
    }),
    appResults: [result('org-codex-agent')],
  });
  assert.equal(incomplete.ready, false);
  assert.equal(
    incomplete.machine.checks.find(({ id }) => id === 'credential.roster').code,
    'credential-roster-incomplete',
  );
});

// A private linked-worktree repository with a complete, correct bot identity
// boundary. Hermetic by construction: the fixture's own git subprocesses and
// everything collectReadiness probes run with the same clean environment, so
// ambient GIT_CONFIG_* pairs or the host's global config cannot answer for it.
function linkedWorktreeFixture() {
  const root = tempRoot();
  const repo = join(root, 'repo');
  const worktree = join(root, 'worktree');
  const home = join(root, 'home');
  mkdirSync(repo);
  mkdirSync(home);
  const env = hermeticGitEnv({ PATH: process.env.PATH }, { HOME: home });
  const git = (...args) => execFileSync('git', args, {
    cwd: repo,
    env,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
  git('init', '--quiet', '--initial-branch=main');
  git('config', 'user.name', 'Test');
  git('config', 'user.email', 'test@example.com');
  git('config', 'extensions.worktreeConfig', 'true');
  git('commit', '--quiet', '--allow-empty', '-m', 'initial');
  git('worktree', 'add', '--quiet', '--detach', worktree);
  const worktreeGit = (...args) => execFileSync('git', args, {
    cwd: worktree,
    env,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
  const slug = 'org-codex-agent';
  const id = 'agent_11111111-1111-4111-8111-111111111111';
  worktreeGit('config', '--worktree', 'agentBot.app', slug);
  worktreeGit('config', '--worktree', 'agentBot.agentId', id);
  worktreeGit('config', '--worktree', 'user.name', `${slug}[bot]`);
  worktreeGit('config', '--worktree', 'user.email', `123+${slug}[bot]@users.noreply.github.com`);
  worktreeGit('config', '--worktree', 'commit.gpgsign', 'false');
  worktreeGit('config', '--worktree', 'core.hooksPath', installationPaths(home).hooksDir);
  worktreeGit('config', '--worktree', '--add', 'credential.helper', '');
  worktreeGit(
    'config',
    '--worktree',
    '--add',
    'credential.helper',
    `!'${installationPaths(home).executable}' credential ${slug}`,
  );
  worktreeGit('remote', 'add', 'origin', 'https://github.com/qwts/example.git');
  const collectOptions = {
    command: 'doctor',
    scope: 'worktree',
    cwd: worktree,
    home,
    env,
    load: () => ({ apps: { codex: slug } }),
    inspectSpace: () => ({ status: 'ok', id, path: join(home, 'space') }),
  };
  return { root, home, worktree, slug, id, env, worktreeGit, collectOptions };
}

test('linked-worktree readiness verifies the complete identity boundary', async () => {
  const { collectOptions, worktreeGit } = linkedWorktreeFixture();
  const report = await collectReadiness(collectOptions);
  assert.equal(report.ready, true, `worktree not ready; failed checks: ${failedChecks(report)}`);
  assert.equal(report.worktree.status, 'ready');
  assert.ok(report.worktree.checks.every(({ status }) => status !== 'failed'));

  worktreeGit('remote', 'set-url', 'origin', 'git@github.com:qwts/example.git');
  const unsafe = await collectReadiness(collectOptions);
  assert.equal(unsafe.ready, false);
  assert.equal(
    unsafe.worktree.checks.find(({ id: checkId }) => checkId === 'worktree.remote').code,
    'origin-ssh',
  );
  assert.doesNotMatch(JSON.stringify(unsafe), /git@github\.com/);
});

test('worktree readiness ignores ambient GIT_CONFIG_* and global identity', async () => {
  const { collectOptions } = linkedWorktreeFixture();
  // Simulate an agent container that injects command-scope Git config into
  // every inherited environment: a conflicting App pin, a human identity, and
  // an insteadOf rewrite. None of it may reach the probe's subprocesses.
  const poison = {
    GIT_CONFIG_COUNT: '4',
    GIT_CONFIG_KEY_0: 'agentBot.app',
    GIT_CONFIG_VALUE_0: 'ambient-wrong-agent',
    GIT_CONFIG_KEY_1: 'user.name',
    GIT_CONFIG_VALUE_1: 'Ambient Human',
    GIT_CONFIG_KEY_2: 'commit.gpgsign',
    GIT_CONFIG_VALUE_2: 'true',
    GIT_CONFIG_KEY_3: 'url.https://github.com/.insteadOf',
    GIT_CONFIG_VALUE_3: 'git@github.com:',
  };
  const saved = new Map(Object.keys(poison).map((key) => [key, process.env[key]]));
  try {
    Object.assign(process.env, poison);
    const report = await collectReadiness(collectOptions);
    assert.equal(report.ready, true, `worktree not ready; failed checks: ${failedChecks(report)}`);
    assert.doesNotMatch(JSON.stringify(report), /ambient-wrong-agent|Ambient Human/);
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test('parallel worktree probes stay stable and independent', async () => {
  // Regression for the intermittent parallel-suite failure: several complete
  // fixtures probed concurrently, each spawning its own git subprocesses. Any
  // cross-contamination or silently swallowed subprocess failure surfaces
  // here as a named check and code instead of a bare `false !== true`.
  const fixtures = Array.from({ length: 6 }, () => linkedWorktreeFixture());
  const reports = await Promise.all(
    fixtures.map(({ collectOptions }) => collectReadiness(collectOptions)),
  );
  for (const report of reports) {
    assert.equal(report.ready, true, `worktree not ready; failed checks: ${failedChecks(report)}`);
  }
});

test('an abnormal git failure fails closed with the check ID and a safe error code', async () => {
  const { collectOptions } = linkedWorktreeFixture();
  // Spawn-level failures (EAGAIN/ENOMEM under parallel load) must not read as
  // "missing" or "mismatched" identity: the check names itself, carries the
  // errno, and the report stays not-ready.
  const transient = (message, code) => Object.assign(new Error(message), {
    code,
    errno: -11,
    syscall: 'spawn git',
  });
  const failing = (matcher, error) => (args, options) => {
    if (args.join(' ').includes(matcher)) throw error;
    return execFileSync('git', args, {
      cwd: options.cwd,
      env: options.env,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).replace(/[\r\n]+$/, '');
  };

  const attribution = await collectReadiness({
    ...collectOptions,
    git: failing('--get user.email', transient('spawn EAGAIN', 'EAGAIN')),
  });
  assert.equal(attribution.ready, false);
  const attributionCheck = attribution.worktree.checks
    .find(({ id: checkId }) => checkId === 'worktree.attribution');
  assert.equal(attributionCheck.code, 'worktree-attribution-unreadable');
  assert.equal(attributionCheck.evidence.git_error, 'EAGAIN');

  const pin = await collectReadiness({
    ...collectOptions,
    git: failing('--get agentBot.app', transient('spawn ENOMEM', 'ENOMEM')),
  });
  assert.equal(pin.ready, false);
  const appCheck = pin.worktree.checks.find(({ id: checkId }) => checkId === 'worktree.app');
  assert.equal(appCheck.code, 'worktree-app-unreadable');
  assert.equal(appCheck.evidence.git_error, 'ENOMEM');
  assert.equal(
    pin.worktree.checks.filter(({ id: checkId }) => checkId === 'worktree.app').length,
    1,
  );

  const agentId = await collectReadiness({
    ...collectOptions,
    git: failing('--get agentBot.agentId', transient('spawn EAGAIN', 'EAGAIN')),
  });
  assert.equal(agentId.ready, false);
  const agentIdCheck = agentId.worktree.checks
    .find(({ id: checkId }) => checkId === 'worktree.agent_id');
  assert.equal(agentIdCheck.code, 'agent-id-unreadable');
  assert.equal(agentIdCheck.evidence.git_error, 'EAGAIN');

  for (const report of [attribution, pin, agentId]) {
    assert.doesNotMatch(
      JSON.stringify(report),
      /spawn EAGAIN|spawn ENOMEM|token|BEGIN PRIVATE KEY/,
    );
  }
});

test('credential helper readiness requires the exact fail-closed reset sequence', () => {
  const expected = "!'/home/test/.local/bin/agent-bot' credential org-codex-agent";
  assert.equal(credentialHelperSequenceReady(['', expected], expected), true);
  assert.equal(credentialHelperSequenceReady([expected], expected), false);
  assert.equal(credentialHelperSequenceReady([expected, ''], expected), false);
  assert.equal(credentialHelperSequenceReady(['', expected, 'osxkeychain'], expected), false);
  assert.equal(credentialHelperSequenceReady(['', 'osxkeychain', expected], expected), false);
  assert.equal(
    credentialHelperSequenceReady(['', "!'/other/agent-bot' credential org-codex-agent"], expected),
    false,
  );
});

test('primary checkout is explicitly not applicable for diagnostic worktree readiness', async () => {
  const root = tempRoot();
  const repo = join(root, 'repo');
  mkdirSync(repo);
  execFileSync('git', ['init', '--quiet', '--initial-branch=main'], { cwd: repo });
  const report = await collectReadiness({
    command: 'doctor',
    scope: 'worktree',
    cwd: repo,
    home: root,
    env: { HOME: root },
    load: () => ({}),
  });
  assert.equal(report.ready, true);
  assert.equal(report.worktree.status, 'not_applicable');
  assert.equal(report.worktree.checks[0].code, 'primary-checkout');
});

test('schema requirements and human output expose only the first action', async () => {
  assert.doesNotThrow(() => requireReadinessSchema(1));
  assert.throws(() => requireReadinessSchema(2), /does not satisfy/);
  assert.throws(() => requireReadinessSchema(0), /positive integer/);

  const home = tempRoot();
  const report = await collectReadiness({
    command: 'doctor',
    scope: 'machine',
    ...machineDependencies(home, {
      inspectCredentials: async ({ slugs }) => slugs.map((slug) => ({
        slug,
        local: { status: 'failed', code: 'missing-issuer', action: 'repair first credential' },
        live: { status: 'skipped' },
      })),
    }),
  });
  const human = renderReadinessReport(report);
  assert.equal((human.match(/fix:/g) ?? []).length, 1);
  assert.match(human, /fix: repair first credential/);
});

test('doctor JSON mode emits only the versioned report', async () => {
  const report = {
    schema_version: 1,
    command: 'doctor',
    scope: 'machine',
    ready: true,
    machine: { status: 'ready', checks: [], apps: [] },
    worktree: { status: 'not_requested', checks: [] },
    first_actionable_failure: null,
  };
  let stdout = '';
  const previous = process.exitCode;
  try {
    await doctorMain(['--machine-only', '--json', '--require-schema-version', '1'], {
      collect: async () => report,
      output: { write: (value) => { stdout += value; } },
    });
    assert.deepEqual(JSON.parse(stdout), report);
    assert.equal(stdout.trim().split('\n').filter((line) => line.startsWith('{')).length, 1);
  } finally {
    process.exitCode = previous;
  }
});

test('doctor emits a structured schema failure without running probes', async () => {
  let stdout = '';
  const previous = process.exitCode;
  try {
    const report = await doctorMain(['--machine-only', '--json', '--require-schema-version', '2'], {
      collect: async () => assert.fail('probes ran for an unsupported schema'),
      output: { write: (value) => { stdout += value; } },
    });
    assert.equal(report.ready, false);
    assert.equal(JSON.parse(stdout).first_actionable_failure.code, 'readiness-schema-unsupported');
  } finally {
    process.exitCode = previous;
  }
});
