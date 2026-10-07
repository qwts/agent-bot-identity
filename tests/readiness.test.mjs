import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { installationPaths } from '../install.mjs';
import { main as doctorMain } from '../doctor.mjs';
import { organizationProfileToConfig } from '../organization-profile.mjs';
import { displayName } from '../agent-population.mjs';
import { hermeticGitEnv } from './helpers/hermetic-git.mjs';
import { ensureClaudeWorktreeAdapter } from '../sync-hooks.mjs';
import {
  READINESS_SCHEMA_VERSION,
  collectReadiness,
  harnessMcpWiring,
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
    inspectShellGh: () => shim
      ? { status: 'ready', code: null, evidence: {} }
      : { status: 'missing', code: 'gh-shim-missing', evidence: {} },
    access: () => {},
    git: (args) => {
      if (args[0] === '--version') return 'git version 2.50.1';
      if (args.join(' ') === 'config --global --get core.hooksPath') return paths.hooksDir;
      throw Object.assign(new Error('unexpected git call'), { status: 1 });
    },
    load: () => ({ apps: { codex: 'org-codex-agent', claude: 'org-claude-agent' } }),
    inspectDaemonSupervisor: () => ({
      supported: true,
      applied: true,
      loaded: true,
      platform: 'darwin',
      kind: 'launchd',
      unitPath: join(home, 'Library', 'LaunchAgents', 'dev.qwts.agent-bot.daemon.plist'),
      label: 'dev.qwts.agent-bot.daemon',
    }),
    probeDaemon: async () => ({
      running: true,
      pid: 4242,
      port: 50003,
      startedAt: '2026-08-16T00:00:00.000Z',
    }),
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

test('doctor warns when a pre-gate config has souls with GitHub Apps (#361)', async () => {
  const home = tempRoot();
  mkdirSync(join(home, '.config', 'agent-bot'), { recursive: true });
  writeFileSync(join(home, '.config', 'agent-bot', 'config.json'), JSON.stringify({ apps: { claude: 'org-claude-agent' } }));
  const ids = join(home, '.local', 'state', 'agent-bot', 'agent-identities');
  mkdirSync(ids, { recursive: true });
  writeFileSync(join(ids, 'agent_a.json'), JSON.stringify({ id: 'agent_a', github: { appSlug: 'org-claude-agent' } }));
  const report = await collectReadiness({ ...machineDependencies(home), scope: 'machine' });
  const gates = report.machine.checks.find(({ id }) => id === 'config.feature_gates');
  assert.equal(gates.status, 'warning');
  assert.equal(gates.code, 'feature-gates-pre-gate-config');
  assert.match(gates.action, /daemon install/);
});

test('doctor distinguishes dangling CLI targets and reports their evidence', async () => {
  const home = tempRoot();
  const target = '../../deleted-checkout/agent-bot';
  const report = await collectReadiness({
    ...machineDependencies(home), scope: 'machine', readlink: () => target,
  });
  const check = report.machine.checks.find(({ id }) => id === 'runtime.installed_cli');
  assert.equal(check.code, 'installed-cli-dangling');
  assert.equal(check.evidence.target, target);
  assert.equal(check.evidence.resolved_target, join(home, 'deleted-checkout', 'agent-bot'));
  assert.match(check.action, /source checkout bootstrap.*--machine-only/);
  const gates = report.machine.checks.find(({ id }) => id === 'config.feature_gates');
  assert.deepEqual(gates.evidence.gates, {
    'github-identity': { enabled: false, source: 'default' },
    'persona-accounts': { enabled: false, source: 'default' },
  });
});

for (const code of ['EACCES', 'EPERM', 'ELOOP', 'ENOTDIR']) {
  test(`doctor reports ${code} as unreadable rather than dangling`, async () => {
    const home = tempRoot();
    const report = await collectReadiness({
      ...machineDependencies(home), scope: 'machine',
      statFile: () => { throw Object.assign(new Error(code), { code }); },
    });
    const check = report.machine.checks.find(({ id }) => id === 'runtime.installed_cli');
    assert.equal(check.code, 'installed-cli-unreadable');
    assert.equal(check.evidence.error_code, code);
    assert.equal(check.evidence.target, sourceEntrypoint);
  });
}

test('doctor detects a missing managed target rather than reporting it ready', async () => {
  const home = tempRoot();
  const report = await collectReadiness({
    ...machineDependencies(home), scope: 'machine',
    statFile: () => { throw Object.assign(new Error('missing'), { code: 'ENOENT' }); },
  });
  assert.equal(report.machine.checks.find(({ id }) => id === 'runtime.installed_cli').code, 'installed-cli-dangling');
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

test('doctor reports account identity outside a repository, including machine-only mode', async () => {
  const home = tempRoot();
  for (const scope of ['all', 'machine']) {
    const report = await collectReadiness({
      ...machineDependencies(home),
      scope,
      env: { HOME: home, AGENT_BOT_ACCOUNT: 'org-qwen-agent', CLAUDECODE: '1' },
      load: () => ({ apps: { qwen: 'org-qwen-agent', claude: 'org-claude-agent' } }),
    });
    const check = report.machine.checks.find(({ id }) => id === 'account.app');
    assert.equal(check?.status, 'ready');
    assert.deepEqual(check.evidence, {
      account: 'org-qwen-agent', harness: 'qwen', app_slug: 'org-qwen-agent',
    });
    assert.match(renderReadinessReport(report), /account org-qwen-agent resolves to App org-qwen-agent/);
    assert.equal(JSON.parse(renderReadinessJson(report)).machine.checks.find(({ id }) => id === 'account.app').status, 'ready');
    assert.equal(report.worktree.status, scope === 'all' ? 'not_applicable' : 'not_requested');
    assert.equal(report.ready, true);
  }
});

test('doctor does not infer account identity from a name pattern or harness environment', async () => {
  const home = tempRoot();
  for (const account of ['owner', 'org-unknown-agent']) {
    const report = await collectReadiness({
      ...machineDependencies(home),
      env: { HOME: home, AGENT_BOT_ACCOUNT: account, CLAUDECODE: '1', GH_AGENT_APP: 'org-claude-agent' },
    });
    const check = report.machine.checks.find(({ id }) => id === 'account.app');
    assert.equal(check?.status, 'not_applicable');
    assert.deepEqual(check.evidence, { account, harness: null, app_slug: null });
    assert.equal(report.ready, true);
  }
});

test('doctor classifies accounts against the scoped active profile roster', async () => {
  const home = tempRoot();
  const profileConfig = organizationProfileToConfig({
    schema_version: 1,
    organization: 'example-engineering',
    account_owner: 'example',
    minimum_runtime_interface_version: 1,
    defaults: { codex: 'example-codex-agent', claude: 'custom-persona' },
    identities: [
      { slug: 'example-codex-agent', harness: 'codex', status: 'active' },
      { slug: 'example-codex-sol-agent', harness: 'codex', status: 'active', models: ['gpt-5.6-sol'] },
      { slug: 'custom-persona', harness: 'claude', status: 'active' },
      { slug: 'example-retired-agent', harness: 'codex', status: 'retired' },
    ],
  });
  for (const [account, apps, expectedHarness] of [
    ['example-codex-sol-agent', ['example-codex-sol-agent'], 'codex'],
    ['example-codex-sol-agent', null, 'codex'],
    ['custom-persona', ['custom-persona'], 'claude'],
    ['example-codex-agent', ['example-codex-sol-agent'], null],
    ['example-retired-agent', null, null],
    ['example-unknown-agent', null, null],
  ]) {
    const report = await collectReadiness({
      ...machineDependencies(home),
      scope: 'machine',
      env: { HOME: home, AGENT_BOT_ACCOUNT: account },
      load: () => ({ ...profileConfig, ...(apps ? { scope: { apps } } : {}) }),
    });
    const check = report.machine.checks.find(({ id }) => id === 'account.app');
    assert.equal(check.status, expectedHarness ? 'ready' : 'not_applicable', account);
    assert.deepEqual(check.evidence, {
      account, harness: expectedHarness, app_slug: expectedHarness ? account : null,
    });
    if (expectedHarness) assert.ok(report.machine.apps.some(({ slug }) => slug === account));
    assert.equal(report.ready, expectedHarness !== 'claude');
  }
});

test('doctor names a missing Claude transcript adapter and verifies explicit provisioning', async () => {
  const home = tempRoot();
  const env = { HOME: home, AGENT_BOT_ACCOUNT: 'org-claude-agent' };
  const config = { apps: { claude: 'org-claude-agent' } };
  const options = { ...machineDependencies(home), scope: 'machine', env, load: () => config };
  const missing = await collectReadiness(options);
  const check = missing.machine.checks.find(({ id }) => id === 'hooks.claude_worktree');
  assert.equal(check.code, 'claude-worktree-adapter-missing');
  assert.match(check.action, /bootstrap --machine-only/);
  assert.equal(missing.ready, false);
  ensureClaudeWorktreeAdapter({ home, env, config });
  const ready = await collectReadiness(options);
  assert.equal(ready.machine.checks.find(({ id }) => id === 'hooks.claude_worktree').status, 'ready');
  assert.equal(ready.ready, true);
  const stale = await collectReadiness({ ...options, now: new Date('2027-01-01T00:00:00Z') });
  const coverage = stale.machine.checks.find(({ id }) => id === 'hooks.coverage');
  assert.match(coverage.message, /claude \(verified, stale\)/);
  assert.match(coverage.action, /maintainer verification/);
});

test('doctor cannot classify an account with missing or invalid runtime config', async () => {
  const home = tempRoot();
  for (const load of [() => ({}), () => { throw new Error('invalid config'); }]) {
    const report = await collectReadiness({
      ...machineDependencies(home),
      env: { HOME: home, AGENT_BOT_ACCOUNT: 'org-codex-agent' },
      load,
    });
    const check = report.machine.checks.find(({ id }) => id === 'account.app');
    assert.equal(check?.status, 'failed');
    assert.equal(check.code, 'account-config-unavailable');
    assert.equal(check.evidence.app_slug, undefined);
    assert.equal(report.ready, false);
  }
});

test('doctor distinguishes shell shim readiness from Codex desktop interposition failures', async () => {
  const home = tempRoot();
  for (const [status, code, expectedStatus] of [
    ['unconfigured', 'codex-gh-interposer-unconfigured', 'warning'],
    ['missing', 'codex-gh-interposer-missing', 'failed'],
    ['replaced', 'codex-gh-interposer-replaced', 'failed'],
    ['recursive', 'codex-gh-interposer-recursive', 'failed'],
    ['legacy-ambiguous', 'codex-gh-interposer-legacy-ambiguous', 'failed'],
    ['unrecoverable', 'codex-gh-interposer-unrecoverable', 'failed'],
    ['ready', null, 'ready'],
  ]) {
    const report = await collectReadiness({
      command: 'doctor',
      scope: 'machine',
      ...machineDependencies(home, { shim: true }),
      inspectCodexDesktopGh: () => ({ status, code, evidence: { path: '/opt/homebrew/bin/gh' } }),
    });
    const shell = report.machine.checks.find(({ id }) => id === 'shim.gh');
    const desktop = report.machine.checks.find(({ id }) => id === 'shim.gh_codex_desktop');
    assert.equal(shell.status, 'ready');
    assert.equal(desktop.status, expectedStatus);
    assert.equal(desktop.code, code);
  }
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

test('doctor rejects an explicit retired App before credential inspection', async () => {
  const home = tempRoot();
  const config = organizationProfileToConfig({
    schema_version: 1,
    organization: 'example-engineering',
    account_owner: 'example',
    minimum_runtime_interface_version: 1,
    defaults: { codex: 'example-codex-agent' },
    identities: [
      { slug: 'example-codex-agent', harness: 'codex', status: 'active' },
      { slug: 'example-retired-agent', harness: 'codex', status: 'retired' },
    ],
  });
  const report = await collectReadiness({
    command: 'doctor',
    scope: 'machine',
    ...machineDependencies(home, {
      inspectCredentials: () => assert.fail('retired App credentials were inspected'),
    }),
    explicitApps: ['example-retired-agent'],
    load: () => config,
  });
  const failure = report.machine.checks.find(({ code }) => code === 'profile-app-retired');
  assert.equal(failure.status, 'failed');
  assert.equal(report.machine.apps.length, 0);
  assert.doesNotMatch(JSON.stringify(report), /example-retired-agent/);
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
    // The always-succeed statFile stub above makes the dedicated launcher
    // session directory appear to exist; probe it hermetically instead of
    // letting the default reach a real pass-cli from inside a unit test.
    statFile: () => ({ isDirectory: () => true }),
    probeSessionContext: () => [{ id: 'proton-pass', available: true, session: true, code: null }],
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
  assert.doesNotMatch(JSON.stringify(report), /secret config contents/);
  assert.equal(report.machine.checks.find(({ id }) => id === 'runtime.installed_cli').evidence.target, '/foreign/agent-bot');
});

test('skill readiness probes every reference and fails when only storage-surfaces.md is missing', async () => {
  const home = tempRoot();
  const probed = [];
  const ready = await collectReadiness({
    command: 'doctor',
    scope: 'machine',
    ...machineDependencies(home),
    access: (path) => {
      if (path.includes('/skills/agent-bot/')) probed.push(path);
    },
  });
  assert.equal(ready.machine.checks.find(({ id }) => id === 'skill.runtime').status, 'ready');
  assert.ok(probed.some((path) => path.endsWith('/skills/agent-bot/references/storage-surfaces.md')));

  const report = await collectReadiness({
    command: 'doctor',
    scope: 'machine',
    ...machineDependencies(home),
    access: (path) => {
      if (path.endsWith('/skills/agent-bot/references/storage-surfaces.md')) {
        throw Object.assign(new Error('missing'), { code: 'ENOENT' });
      }
    },
  });
  assert.equal(report.ready, false);
  const check = report.machine.checks.find(({ id }) => id === 'skill.runtime');
  assert.equal(check.status, 'failed');
  assert.equal(check.code, 'runtime-skill-incomplete');
});

test('skill readiness probes the Homebrew libexec bundle behind the stable bin wrapper', async () => {
  const home = tempRoot();
  const probed = [];
  const report = await collectReadiness({
    command: 'doctor',
    scope: 'machine',
    ...machineDependencies(home),
    readlink: () => '/opt/homebrew/opt/agent-bot/bin/agent-bot',
    access: (path) => {
      if (path.includes('/skills/agent-bot/')) probed.push(path);
    },
  });
  assert.equal(report.machine.checks.find(({ id }) => id === 'skill.runtime').status, 'ready');
  assert.equal(probed.length, 5);
  for (const path of probed) {
    assert.ok(path.startsWith('/opt/homebrew/opt/agent-bot/libexec/skills/agent-bot/'), path);
  }
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

  const gate = (slug) => ({
    slug,
    local: {
      status: 'failed',
      code: 'provider-session-required',
      action: 'unlock the secret store with: pass-cli login',
    },
    live: { status: 'skipped' },
  });
  const locked = await collectReadiness({
    command: 'bootstrap',
    scope: 'machine',
    ...machineDependencies(home, {
      inspectCredentials: async () => assert.fail('a complete locked-store roster was re-probed'),
    }),
    appResults: [gate('org-codex-agent'), gate('org-claude-agent')],
  });
  assert.equal(locked.ready, false);
  assert.equal(locked.machine.checks.find(({ id }) => id === 'credential.roster'), undefined);
  assert.equal(locked.first_actionable_failure.code, 'provider-session-required');
  assert.match(locked.first_actionable_failure.action, /pass-cli login/);
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
  const { collectOptions, env } = linkedWorktreeFixture();
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
    const { env: fixtureEnv, ...defaultOptions } = collectOptions;
    for (const options of [collectOptions, defaultOptions, { ...collectOptions, env: { ...env, ...poison } }]) {
      const ambient = process.env;
      try {
        process.env = hermeticGitEnv(ambient, { ...fixtureEnv, ...poison, GH_AGENT_APP: '' });
        const report = await collectReadiness(options);
        assert.equal(report.ready, true, `worktree not ready; failed checks: ${failedChecks(report)}`);
        assert.doesNotMatch(JSON.stringify(report), /ambient-wrong-agent|Ambient Human/);
      } finally {
        process.env = ambient;
      }
    }
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test('readiness Git config probes strip overrides and preserve hermetic config controls', async () => {
  const { collectOptions, env, home } = linkedWorktreeFixture();
  const globalConfig = join(home, '.gitconfig');
  writeFileSync(globalConfig, '[user]\n\tname = Ambient Human\n');
  const overrides = [
    'GIT_CONFIG', 'GIT_CONFIG_SYSTEM', 'GIT_CONFIG_PARAMETERS',
    'GIT_DIR', 'GIT_WORK_TREE', 'GIT_COMMON_DIR', 'GIT_INDEX_FILE',
    'GIT_NAMESPACE', 'GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES',
    'GIT_CEILING_DIRECTORIES',
  ];
  for (const key of overrides) {
    let configReads = 0;
    const poisonedEnv = { ...env, GIT_CONFIG_GLOBAL: globalConfig, [key]: '/injected' };
    const report = await collectReadiness({
      ...collectOptions,
      env: poisonedEnv,
      git: (args, options) => {
        if (args[0] === 'config') {
          configReads++;
          assert.equal(options.env[key], undefined, key);
          assert.equal(options.env.GIT_CONFIG_GLOBAL, globalConfig);
          assert.equal(options.env.GIT_CONFIG_NOSYSTEM, '1');
        }
        return execFileSync('git', args, {
          ...options, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
        }).replace(/[\r\n]+$/, '');
      },
    });
    assert.ok(configReads > 0, key);
    assert.equal(report.ready, true, `${key}: ${failedChecks(report)}`);
    assert.equal(poisonedEnv[key], '/injected');
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

// ENG-0339: a primary checkout in an agent account is bot work and is verified
// like a linked worktree; only a checkout with no bot identity is skipped.
test('a primary checkout with a stated bot identity is verified, not skipped', async () => {
  const root = tempRoot();
  const repo = join(root, 'repo');
  mkdirSync(repo);
  execFileSync('git', ['init', '--quiet', '--initial-branch=main'], { cwd: repo });
  for (const env of [
    { HOME: root, AGENT_BOT_ACCOUNT: 'you-codex-agent' },
    { HOME: root, AGENT_BOT_ACCOUNT: 'user', GH_AGENT_APP: 'you-codex-agent' },
  ]) {
    const report = await collectReadiness({
      command: 'doctor',
      scope: 'worktree',
      cwd: repo,
      home: root,
      env,
      load: () => ({ prefix: 'you' }),
    });
    assert.equal(report.worktree.status, 'not_ready');
    assert.equal(report.worktree.checks[0].message, 'primary checkout');
    assert.equal(report.worktree.checks[0].status, 'ready');
    assert.ok(report.worktree.checks.some((check) => check.id === 'worktree.app' && check.status === 'failed'));
  }
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

test('machine readiness reports the resolved spaces root and census agreement', async () => {
  const home = tempRoot();
  const ready = await collectReadiness({
    command: 'doctor',
    scope: 'machine',
    ...machineDependencies(home),
  });
  const root = ready.machine.checks.find(({ id }) => id === 'spaces.root');
  const agreement = ready.machine.checks.find(({ id }) => id === 'spaces.home');
  assert.equal(root.status, 'ready');
  assert.equal(root.evidence.source, 'default');
  assert.equal(root.evidence.root, join(home, '.agent-space'));
  assert.equal(agreement.status, 'ready');
  assert.equal(ready.ready, true);

  const conflict = await collectReadiness({
    command: 'doctor',
    scope: 'machine',
    ...machineDependencies(home),
    inspectCutover: () => ({
      override: false,
      source: 'default',
      resolvedRoot: join(home, '.agent-space'),
      destRoot: join(home, '.agent-space'),
      legacyRoot: join(home, '.local', 'share', 'agent-bot', 'spaces'),
      completed: false,
      inProgress: false,
      legacyPopulated: true,
      destPopulated: true,
      conflict: true,
    }),
  });
  assert.equal(conflict.ready, false);
  assert.equal(conflict.machine.checks.find(({ id }) => id === 'spaces.home').code, 'spaces-cutover-conflict');
  assert.equal(conflict.machine.checks.find(({ id }) => id === 'spaces.root').status, 'ready');
});

test('machine readiness fails closed when the cutover record is unreadable', async () => {
  const home = tempRoot();
  const record = join(home, '.local', 'state', 'agent-bot', 'spaces-cutover.json');
  mkdirSync(dirname(record), { recursive: true });
  writeFileSync(record, 'not-json\n');
  const report = await collectReadiness({
    command: 'doctor',
    scope: 'machine',
    ...machineDependencies(home),
  });
  assert.equal(report.ready, false);
  assert.equal(report.machine.checks.find(({ id }) => id === 'spaces.home').code, 'spaces-cutover-unreadable');
  assert.equal(report.machine.checks.find(({ id }) => id === 'spaces.root').status, 'ready');
  assert.doesNotMatch(JSON.stringify(report), /token|Bearer /);
});

test('machine readiness fails when the census is not under the resolved spaces root', async () => {
  const home = tempRoot();
  const census = join(home, '.local', 'state', 'agent-bot', 'population.json');
  mkdirSync(dirname(census), { recursive: true });
  writeFileSync(census, `${JSON.stringify({
    schemaVersion: 1,
    souls: {
      'agent_11111111-1111-4111-8111-111111111111': {
        id: 'agent_11111111-1111-4111-8111-111111111111',
        name: displayName('agent_11111111-1111-4111-8111-111111111111'),
        appSlug: 'qwts-codex-agent',
        parentId: null,
        status: 'active',
        spacePath: join(home, '.local', 'share', 'agent-bot', 'spaces', 'agent_11111111-1111-4111-8111-111111111111'),
        transcriptLocator: null,
        lastSeen: '2026-08-16T00:00:00.000Z',
      },
    },
  }, null, 2)}\n`);
  const report = await collectReadiness({
    command: 'doctor',
    scope: 'machine',
    ...machineDependencies(home),
  });
  assert.equal(report.ready, false);
  const homeCheck = report.machine.checks.find(({ id }) => id === 'spaces.home');
  assert.equal(homeCheck.code, 'spaces-census-mismatch');
  assert.match(homeCheck.action, /agent-bot update/);
});

test('machine readiness fails when the supervisor is missing or the daemon is down', async () => {
  const home = tempRoot();
  const missing = await collectReadiness({
    command: 'doctor',
    scope: 'machine',
    ...machineDependencies(home),
    inspectDaemonSupervisor: () => ({
      supported: true,
      applied: false,
      loaded: false,
      platform: 'darwin',
      kind: 'launchd',
    }),
    probeDaemon: async () => ({ running: false, reason: 'no daemon state file' }),
  });
  assert.equal(missing.ready, false);
  assert.equal(missing.machine.checks.find(({ id }) => id === 'daemon.supervisor').code, 'supervisor-not-applied');
  assert.equal(missing.machine.checks.find(({ id }) => id === 'daemon.health').code, 'daemon-not-running');
  assert.doesNotMatch(JSON.stringify(missing), /token|Bearer /);

  const unsupported = await collectReadiness({
    command: 'doctor',
    scope: 'machine',
    ...machineDependencies(home),
    inspectDaemonSupervisor: () => ({
      supported: false,
      applied: false,
      loaded: false,
      platform: 'win32',
      kind: null,
    }),
  });
  assert.equal(unsupported.machine.checks.find(({ id }) => id === 'daemon.supervisor').status, 'warning');
  assert.equal(unsupported.ready, true);
});

test('identity.class is durable when the installed hook is executable and a warning when it is not', async () => {
  const home = tempRoot();
  const durable = await collectReadiness({
    command: 'doctor',
    scope: 'machine',
    ...machineDependencies(home),
  });
  const durableClass = durable.machine.checks.find(({ id }) => id === 'identity.class');
  assert.equal(durableClass.status, 'ready');
  assert.equal(durableClass.evidence.class, 'durable');
  assert.equal(durable.ready, true);

  const uninstalled = await collectReadiness({
    command: 'doctor',
    scope: 'machine',
    ...machineDependencies(home),
    access: (path) => {
      if (String(path).includes('agent-hook')) {
        throw Object.assign(new Error('missing'), { code: 'ENOENT' });
      }
    },
  });
  const uninstalledClass = uninstalled.machine.checks.find(({ id }) => id === 'identity.class');
  assert.equal(uninstalledClass.status, 'warning');
  assert.equal(uninstalledClass.code, 'identity-uninstalled');
  assert.equal(uninstalledClass.evidence.class, 'uninstalled');
  assert.deepEqual(uninstalledClass.evidence.unmanaged_authors, ['ai9d']);
  assert.match(uninstalledClass.message, /unmanaged allowlisted author/);
  assert.notEqual(uninstalled.first_actionable_failure?.check_id, 'identity.class');
  assert.doesNotMatch(JSON.stringify(uninstalledClass), /token|BEGIN |passphrase/);
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

// doctor names active souls that no checkout references (#192): the census
// row records the checkout that pinned each soul, and a soul whose checkout
// is gone, pinned to another soul, or never recorded is unreferenced.
test('doctor names active souls that no checkout references', async () => {
  const home = tempRoot();
  const census = join(home, '.local', 'state', 'agent-bot', 'population.json');
  const ids = {
    held: 'agent_aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    repinned: 'agent_bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    unrecorded: 'agent_cccccccc-cccc-4ccc-8ccc-cccccccccccc',
    gone: 'agent_dddddddd-dddd-4ddd-8ddd-dddddddddddd',
    retired: 'agent_eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
  };
  const row = (id, worktree, status = 'active') => ({
    id,
    name: displayName(id),
    appSlug: 'qwts-codex-agent',
    parentId: null,
    status,
    spacePath: join(home, '.agent-space', id),
    worktree,
    transcriptLocator: null,
    lastSeen: '2026-08-16T00:00:00.000Z',
  });
  const write = (souls) => {
    mkdirSync(dirname(census), { recursive: true });
    writeFileSync(census, `${JSON.stringify({ schemaVersion: 1, souls }, null, 2)}\n`);
  };
  const pins = { [join(home, 'held')]: ids.held, [join(home, 'moved')]: 'agent_ffffffff-ffff-4fff-8fff-ffffffffffff' };
  const dependencies = machineDependencies(home);
  const git = (args, options = {}) => {
    if (args[0] === 'config' && args.includes('--get') && /agentId$/.test(args.at(-1))) {
      if (!Object.hasOwn(pins, options.cwd)) throw Object.assign(new Error('spawn git ENOENT'), { code: 'ENOENT' });
      if (args.at(-1) !== 'agentBot.agentId') throw Object.assign(new Error('unset'), { status: 1 });
      return pins[options.cwd];
    }
    return dependencies.git(args, options);
  };

  write({
    [ids.held]: row(ids.held, join(home, 'held')),
    [ids.repinned]: row(ids.repinned, join(home, 'moved')),
    [ids.unrecorded]: row(ids.unrecorded, null),
    [ids.gone]: row(ids.gone, join(home, 'gone')),
    [ids.retired]: row(ids.retired, null, 'retired'),
  });
  const report = await collectReadiness({ command: 'doctor', scope: 'machine', ...dependencies, git });
  const check = report.machine.checks.find(({ id }) => id === 'souls.referenced');
  assert.equal(check.status, 'warning');
  assert.equal(check.code, 'souls-unreferenced');
  assert.deepEqual(check.evidence, {
    active: 4,
    unreferenced: [ids.repinned, ids.unrecorded, ids.gone],
    unverified: [],
  });
  assert.match(check.message, new RegExp(ids.repinned));
  assert.match(check.action, /verify.*before.*retir/);
  assert.doesNotMatch(check.action, /--delete-space/);
  assert.equal(report.ready, true, 'unreferenced souls warn; they do not fail readiness');
  assert.doesNotMatch(JSON.stringify(report), /token|Bearer /);

  write({ [ids.held]: row(ids.held, join(home, 'held')) });
  const quiet = await collectReadiness({ command: 'doctor', scope: 'machine', ...dependencies, git });
  const held = quiet.machine.checks.find(({ id }) => id === 'souls.referenced');
  assert.equal(held.status, 'ready');
  assert.deepEqual(held.evidence, { active: 1 });

  for (const latest of ['gone', 'moved']) {
    write({
      [ids.held]: {
        ...row(ids.held, join(home, latest)),
        worktrees: [join(home, latest), join(home, 'held')],
      },
    });
    const shared = await collectReadiness({ command: 'doctor', scope: 'machine', ...dependencies, git });
    assert.equal(shared.machine.checks.find(({ id }) => id === 'souls.referenced').status, 'ready');
  }

  write({
    [ids.held]: {
      ...row(ids.held, join(home, 'gone')),
      worktrees: [join(home, 'gone'), join(home, 'unreadable')],
    },
  });
  const uncertain = await collectReadiness({
    command: 'doctor', scope: 'machine', ...dependencies,
    git: (args, options) => {
      if (options?.cwd === join(home, 'unreadable')) throw Object.assign(new Error('denied'), { code: 'EACCES' });
      return git(args, options);
    },
  });
  const unverified = uncertain.machine.checks.find(({ id }) => id === 'souls.referenced');
  assert.equal(unverified.code, 'souls-unverified');
  assert.deepEqual(unverified.evidence.unreferenced, []);
  assert.deepEqual(unverified.evidence.unverified, [ids.held]);
});

// A copied soul folder keeps the soul's marker (#80): doctor names it, and
// says nothing while each soul has one folder.
test('doctor warns when two soul folders claim one soul', async () => {
  const home = tempRoot();
  const census = join(home, '.local', 'state', 'agent-bot', 'population.json');
  const id = 'agent_aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const souls = join(home, '.agent-bot', 'souls');
  const own = join(souls, 'Starter - Starter.soul');
  const copy = join(souls, 'Starter - Starter copy.soul');
  const mark = (dir) => {
    mkdirSync(join(dir, '.soul-state'), { recursive: true });
    writeFileSync(join(dir, '.soul-state', 'agent-id'), `${id}\n`);
  };
  mkdirSync(dirname(census), { recursive: true });
  writeFileSync(census, `${JSON.stringify({ schemaVersion: 1, souls: { [id]: {
    id, name: displayName(id), soulDir: own, appSlug: null, parentId: null, status: 'active',
    spacePath: join(home, '.agent-space', id), worktree: null, worktrees: [], transcriptLocator: null,
    lastSeen: '2026-10-03T20:04:04.110Z' } } }, null, 2)}\n`);
  mark(own);
  const dependencies = machineDependencies(home);
  const single = await collectReadiness({ command: 'doctor', scope: 'machine', ...dependencies });
  assert.equal(single.machine.checks.find(({ id: check }) => check === 'souls.folders'), undefined);
  mark(copy);
  const report = await collectReadiness({ command: 'doctor', scope: 'machine', ...dependencies });
  const check = report.machine.checks.find(({ id: check }) => check === 'souls.folders');
  assert.equal(check.status, 'warning');
  assert.equal(check.code, 'soul-folder-duplicate');
  assert.deepEqual(check.evidence, { duplicates: [{ agentId: id, soulDir: own, copies: [copy] }] });
  assert.match(check.message, /copies .*Starter - Starter copy\.soul/);
  assert.match(check.action, /keep each soul's own folder/);
});

// A failed launch used to leave its folder behind (#419): doctor names a
// folder whose soul is retired or unknown, and stays quiet for active and
// finalized souls.
test('doctor warns about soul folders that belong to no active soul', async () => {
  const home = tempRoot();
  const census = join(home, '.local', 'state', 'agent-bot', 'population.json');
  const souls = join(home, '.agent-bot', 'souls');
  const ids = {
    active: 'agent_aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    finalized: 'agent_bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    retired: 'agent_cccccccc-cccc-4ccc-8ccc-cccccccccccc',
    unknown: 'agent_dddddddd-dddd-4ddd-8ddd-dddddddddddd',
  };
  const dirs = Object.fromEntries(Object.keys(ids).map((key) => [key, join(souls, `${key}.soul`)]));
  const row = (key, status) => ({ id: ids[key], name: displayName(ids[key]), soulDir: dirs[key], appSlug: null,
    parentId: null, status, spacePath: join(home, '.agent-space', ids[key]), worktree: null, worktrees: [],
    transcriptLocator: null, lastSeen: '2026-10-03T20:04:04.110Z' });
  mkdirSync(dirname(census), { recursive: true });
  writeFileSync(census, `${JSON.stringify({ schemaVersion: 1, souls: {
    [ids.active]: row('active', 'active'), [ids.finalized]: row('finalized', 'finalized'),
    [ids.retired]: row('retired', 'retired') } }, null, 2)}\n`);
  for (const key of ['active', 'finalized']) {
    mkdirSync(join(dirs[key], '.soul-state'), { recursive: true });
    writeFileSync(join(dirs[key], '.soul-state', 'agent-id'), `${ids[key]}\n`);
  }
  const dependencies = machineDependencies(home);
  const quiet = await collectReadiness({ command: 'doctor', scope: 'machine', ...dependencies });
  assert.equal(quiet.machine.checks.find(({ id }) => id === 'souls.orphans'), undefined);
  for (const key of ['retired', 'unknown']) {
    mkdirSync(join(dirs[key], '.soul-state'), { recursive: true });
    writeFileSync(join(dirs[key], '.soul-state', 'agent-id'), `${ids[key]}\n`);
  }
  const report = await collectReadiness({ command: 'doctor', scope: 'machine', ...dependencies });
  const check = report.machine.checks.find(({ id }) => id === 'souls.orphans');
  assert.equal(check.status, 'warning');
  assert.equal(check.code, 'soul-folder-orphan');
  assert.match(check.action, /agent-bot soul remove/);
  assert.deepEqual(check.evidence, { orphans: [
    { agentId: ids.retired, path: dirs.retired, status: 'retired' },
    { agentId: ids.unknown, path: dirs.unknown, status: 'unknown' },
  ] });
});

test('soul reference checks ignore global pins and honor legacy worktree pins', async () => {
  const { home, worktree, id, env, worktreeGit } = linkedWorktreeFixture();
  const census = join(home, '.local', 'state', 'agent-bot', 'population.json');
  mkdirSync(dirname(census), { recursive: true });
  writeFileSync(census, JSON.stringify({
    schemaVersion: 1,
    souls: {
      [id]: {
        id, appSlug: 'org-codex-agent', status: 'active',
        spacePath: join(home, '.agent-space', id), worktree,
        lastSeen: '2026-08-16T00:00:00.000Z',
      },
    },
  }));
  const dependencies = machineDependencies(home);
  const probe = async () => {
    const report = await collectReadiness({
      ...dependencies, scope: 'machine', env,
      git: (args, options) => {
        if (options?.cwd !== worktree) return dependencies.git(args, options);
        return execFileSync('git', args, { ...options, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
      },
    });
    return report.machine.checks.find(({ id: checkId }) => checkId === 'souls.referenced');
  };
  worktreeGit('config', '--worktree', '--unset', 'agentBot.agentId');
  writeFileSync(join(home, '.gitconfig'), `[agentBot]\n  agentId = ${id}\n`);
  assert.deepEqual((await probe()).evidence.unreferenced, [id]);

  writeFileSync(join(home, '.gitconfig'), '[agentBot]\n  agentId = agent_aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa\n');
  worktreeGit('config', '--worktree', 'qwts.agentId', id);
  assert.equal((await probe()).status, 'ready');
});

// #228 state introspection. All four sections are advisory, so the test that
// matters most is the first one: an input that was ready before must still be
// ready now. That pins "reports state without changing readiness", which is the
// property that would otherwise break bootstrap and a CI gate silently.

const STATE_CHECK_IDS = [
  'worktree.binding_summary',
  'securestore.session',
  'securestore.launcher_session',
  'inbox.configuration',
  'runtime.version_skew',
];

// Minimal dependencies: enough for the machine section to run without the
// unrelated lstat/readlink/exists stubbing that machineDependencies installs.
function censusScopeOptions(home, git) {
  return {
    command: 'doctor',
    scope: 'machine',
    home,
    env: { HOME: home },
    cwd: home,
    git: git ?? ((args) => {
      if (args[0] === '--version') return 'git version 2.50.1';
      throw Object.assign(new Error('unexpected git call'), { status: 1 });
    }),
    lstat: () => ({ isSymbolicLink: () => true }),
    readlink: () => sourceEntrypoint,
    access: () => {},
    exists: () => false,
    spawn: () => ({ status: 0, stdout: '' }),
    load: () => ({ apps: { claude: 'org-claude-agent', codex: 'org-codex-agent' } }),
    inspectShellGh: () => ({ status: 'missing', code: 'gh-shim-missing', evidence: {} }),
    inspectDaemonSupervisor: () => ({ supported: true, applied: true, loaded: true, platform: 'darwin', kind: 'launchd' }),
    probeDaemon: async () => ({ running: true }),
    verifyApps: false,
    appResults: { results: [] },
    probeSecretStore: () => [],
    listHarnessMcpServers: () => [],
  };
}

// Layered on the suite's own healthy machine fixture, so the regression below
// compares against a machine that genuinely reports ready.
function machineScopeOptions(overrides = {}) {
  const { root, ...rest } = overrides;
  const home = root ?? tempRoot();
  return {
    ...machineDependencies(home),
    command: 'doctor',
    scope: 'machine',
    probeSecretStore: () => [],
    listHarnessMcpServers: () => [],
    ...rest,
  };
}

test('#228 state sections report without making a ready machine not ready', async () => {
  const report = await collectReadiness(machineScopeOptions());
  for (const id of STATE_CHECK_IDS) {
    assert.ok(
      report.machine.checks.some((check) => check.id === id),
      `expected the ${id} section to be reported`,
    );
  }
  assert.equal(report.machine.status, 'ready');
  assert.equal(report.ready, true);
  assert.equal(report.first_actionable_failure, null);
});

test('every #228 section is advisory, so none can be a failure', async () => {
  // The worst case for each section at once: a foreign App, no store session,
  // a half-configured inbox, and a version skew. None may reach 'failed'.
  const report = await collectReadiness(machineScopeOptions({
    probeSecretStore: () => [{ id: 'proton-pass', available: true, session: false, code: 'PROVIDER_NO_SESSION' }],
    listHarnessMcpServers: () => [{ harness: 'opencode', mcp: 'agent-bot' }],
    env: { HOME: tempRoot(), GH_APP_HOOK_INBOX_URL: 'https://example.invalid' },
    readPackageVersion: (path) => (path.includes('libexec') ? '0.6.0' : '0.7.0'),
  }));
  for (const id of STATE_CHECK_IDS) {
    const check = report.machine.checks.find((entry) => entry.id === id);
    assert.notEqual(check.status, 'failed', `${id} must never fail the machine section`);
  }
  assert.equal(report.machine.status, 'ready');
});

test('the secure-store section names the recovery step and never reads a field', async () => {
  const calls = [];
  const report = await collectReadiness(machineScopeOptions({
    probeSecretStore: () => {
      calls.push('probe');
      return [{ id: 'proton-pass', available: true, session: false, code: 'PROVIDER_NO_SESSION' }];
    },
  }));
  const check = report.machine.checks.find((entry) => entry.id === 'securestore.session');
  assert.equal(check.status, 'warning');
  assert.equal(check.code, 'securestore-no-session');
  assert.match(check.action, /log the provider in/);
  // Presence and a code only: the report must never carry provider output.
  assert.deepEqual(Object.keys(check.evidence.providers[0]).sort(), ['available', 'code', 'id', 'session']);
  assert.deepEqual(calls, ['probe']);
});

test('the secure-store section distinguishes an absent provider from a dead session', async () => {
  const missing = await collectReadiness(machineScopeOptions({
    probeSecretStore: () => [{ id: 'proton-pass', available: false, session: false, code: null }],
  }));
  assert.equal(
    missing.machine.checks.find((entry) => entry.id === 'securestore.session').code,
    'securestore-provider-unavailable',
  );
  const absent = await collectReadiness(machineScopeOptions({ probeSecretStore: () => [] }));
  const check = absent.machine.checks.find((entry) => entry.id === 'securestore.session');
  assert.equal(check.status, 'not_applicable');
  const threw = await collectReadiness(machineScopeOptions({
    probeSecretStore: () => { throw Object.assign(new Error('nope'), { code: 'PROVIDER_UNAVAILABLE' }); },
  }));
  assert.equal(
    threw.machine.checks.find((entry) => entry.id === 'securestore.session').code,
    'securestore-probe-failed',
  );
});

// The launcher's dedicated pass-cli session is a different session from the
// interactive one, and the ambient securestore.session probe says nothing
// about it. These pin the blind spot the launcher section exists to close:
// doctor must name the directory, name the recovery command, distinguish a
// dead session from an unreachable provider, and never carry provider output.

function launcherStatFile() {
  const suffix = join('agent-bot', 'proton-pass');
  return (path) => {
    if (typeof path === 'string' && path.endsWith(suffix)) return { isDirectory: () => true };
    return statSync(path);
  };
}

test('the launcher secure-store section probes the dedicated session directory and names its recovery', async () => {
  const probed = [];
  const report = await collectReadiness(machineScopeOptions({
    statFile: launcherStatFile(),
    probeSessionContext: (context) => {
      probed.push(context);
      return [{ id: 'proton-pass', available: true, session: false, code: 'PROVIDER_NO_SESSION' }];
    },
  }));
  const check = report.machine.checks.find((entry) => entry.id === 'securestore.launcher_session');
  assert.equal(check.status, 'warning');
  assert.equal(check.code, 'securestore-launcher-no-session');
  assert.equal(probed.length, 1);
  assert.ok(probed[0].session_dir.endsWith(join('agent-bot', 'proton-pass')));
  assert.ok(check.action.includes(`PROTON_PASS_SESSION_DIR='${probed[0].session_dir}'`));
  assert.match(check.action, /pass-cli login/);
  // Presence, a directory, and codes only — never provider output.
  assert.deepEqual(
    Object.keys(check.evidence.contexts[0]).sort(),
    ['available', 'code', 'id', 'session', 'session_dir'],
  );
});

test('the launcher secure-store section distinguishes an absent provider from a dead session', async () => {
  const missing = await collectReadiness(machineScopeOptions({
    statFile: launcherStatFile(),
    probeSessionContext: () => [{ id: 'proton-pass', available: false, session: false, code: null }],
  }));
  const check = missing.machine.checks.find((entry) => entry.id === 'securestore.launcher_session');
  assert.equal(check.status, 'warning');
  assert.equal(check.code, 'securestore-provider-unavailable');
  assert.match(check.action, /logging in will not help/);
  const threw = await collectReadiness(machineScopeOptions({
    statFile: launcherStatFile(),
    probeSessionContext: () => {
      throw Object.assign(new Error('nope'), { code: 'PROVIDER_UNAVAILABLE' });
    },
  }));
  assert.equal(
    threw.machine.checks.find((entry) => entry.id === 'securestore.launcher_session').code,
    'securestore-probe-failed',
  );
});

test('the launcher secure-store section stays not_applicable without a dedicated session directory', async () => {
  const probed = [];
  const report = await collectReadiness(machineScopeOptions({
    probeSessionContext: (context) => {
      probed.push(context);
      return [{ id: 'proton-pass', available: true, session: true, code: null }];
    },
  }));
  const check = report.machine.checks.find((entry) => entry.id === 'securestore.launcher_session');
  assert.equal(check.status, 'not_applicable');
  assert.deepEqual(probed, []);
});

test('the launcher secure-store section honors XDG_STATE_HOME for the session directory', async () => {
  const home = tempRoot();
  const stateHome = join(home, 'state-root');
  const probed = [];
  const report = await collectReadiness(machineScopeOptions({
    root: home,
    env: { HOME: home, XDG_STATE_HOME: stateHome },
    statFile: launcherStatFile(),
    probeSessionContext: (context) => {
      probed.push(context);
      return [{ id: 'proton-pass', available: true, session: true, code: null }];
    },
  }));
  const check = report.machine.checks.find((entry) => entry.id === 'securestore.launcher_session');
  assert.equal(check.status, 'ready');
  assert.deepEqual(probed, [{
    id: 'proton-pass',
    session_dir: join(stateHome, 'agent-bot', 'proton-pass'),
  }]);
});

test('the launcher secure-store section distinguishes an unreadable directory from an absent one', async () => {
  const probed = [];
  const suffix = join('agent-bot', 'proton-pass');
  const unreadable = await collectReadiness(machineScopeOptions({
    statFile: (path) => {
      if (typeof path === 'string' && path.endsWith(suffix)) {
        throw Object.assign(new Error('permission denied'), { code: 'EACCES' });
      }
      return statSync(path);
    },
    probeSessionContext: (context) => {
      probed.push(context);
      return [{ id: 'proton-pass', available: true, session: true, code: null }];
    },
  }));
  const check = unreadable.machine.checks.find((entry) => entry.id === 'securestore.launcher_session');
  assert.equal(check.status, 'warning');
  assert.equal(check.code, 'securestore-launcher-unreadable');
  assert.equal(check.evidence.inspection.code, 'EACCES');
  assert.ok(check.evidence.inspection.session_dir.endsWith(suffix));
  // A directory doctor cannot inspect is never probed as a session context
  // and never reported as absent: both would hide the launcher outage.
  assert.deepEqual(probed, []);
  const regularFile = await collectReadiness(machineScopeOptions({
    statFile: (path) => {
      if (typeof path === 'string' && path.endsWith(suffix)) return {};
      return statSync(path);
    },
    probeSessionContext: () => assert.fail('a non-directory session path must not be probed'),
  }));
  const fileCheck = regularFile.machine.checks.find((entry) => entry.id === 'securestore.launcher_session');
  assert.equal(fileCheck.status, 'warning');
  assert.equal(fileCheck.code, 'securestore-launcher-unreadable');
  assert.equal(fileCheck.evidence.inspection.code, 'launcher-session-not-a-directory');
});

test('the launcher secure-store section shell-quotes the session directory in its recovery command', async () => {
  const home = tempRoot();
  // A state home whose name carries a single quote, a command substitution,
  // and backticks: interpolated into double quotes it would rewrite the
  // copy-paste recovery command instead of naming a directory.
  const stateHome = join(home, "we'ird-$(echo pwned)-`x`");
  const sessionDir = join(stateHome, 'agent-bot', 'proton-pass');
  const report = await collectReadiness(machineScopeOptions({
    root: home,
    env: { HOME: home, XDG_STATE_HOME: stateHome },
    statFile: (path) => (path === sessionDir ? { isDirectory: () => true } : statSync(path)),
    probeSessionContext: () => [{ id: 'proton-pass', available: true, session: false, code: 'PROVIDER_NO_SESSION' }],
  }));
  const check = report.machine.checks.find((entry) => entry.id === 'securestore.launcher_session');
  assert.equal(check.code, 'securestore-launcher-no-session');
  const quoted = `'${sessionDir.replaceAll("'", "'\\''")}'`;
  assert.ok(check.action.includes(`PROTON_PASS_SESSION_DIR=${quoted}`));
  // No unquoted or double-quoted interpolation of the directory survives.
  assert.doesNotMatch(check.action, /PROTON_PASS_SESSION_DIR="[^"]*"/u);
  assert.doesNotMatch(check.action, /PROTON_PASS_SESSION_DIR=[^' <]/u);
  // The message still names the directory verbatim for a human reader.
  assert.ok(check.message.includes(sessionDir));
});

test('the inbox section reports presence without carrying the bearer', async () => {
  const report = await collectReadiness(machineScopeOptions({
    env: {
      HOME: tempRoot(),
      GH_APP_HOOK_INBOX_URL: 'https://example.invalid',
      GH_APP_HOOK_INBOX_TOKEN: 'super-secret-bearer-value',
    },
    listHarnessMcpServers: () => [{ harness: 'opencode', mcp: 'agent-bot' }],
  }));
  const check = report.machine.checks.find((entry) => entry.id === 'inbox.configuration');
  assert.equal(check.status, 'ready');
  assert.equal(check.evidence.credential_configured, true);
  assert.deepEqual(check.evidence.harnesses_wired, ['opencode']);
  // The value is never echoed anywhere in the report.
  assert.doesNotMatch(JSON.stringify(report), /super-secret-bearer-value/);
  assert.doesNotMatch(JSON.stringify(report), /token|Bearer /);
});

test('the inbox section warns on a malformed inbox URL instead of reporting ready', async () => {
  for (const url of ['not a url', 'ftp://inbox.example.invalid']) {
    const report = await collectReadiness(machineScopeOptions({
      env: { HOME: tempRoot(), GH_APP_HOOK_INBOX_URL: url, GH_APP_HOOK_INBOX_TOKEN: 'super-secret-bearer-value' },
      listHarnessMcpServers: () => [{ harness: 'opencode', mcp: 'agent-bot' }],
    }));
    const check = report.machine.checks.find((entry) => entry.id === 'inbox.configuration');
    assert.equal(check.status, 'warning', url);
    assert.equal(check.code, 'inbox-url-invalid');
    assert.equal(check.evidence.host, null);
    assert.doesNotMatch(JSON.stringify(report), /super-secret-bearer-value/);
  }
});

test('the inbox section warns when a harness wires it but nothing is configured', async () => {
  const report = await collectReadiness(machineScopeOptions({
    listHarnessMcpServers: () => [{ harness: 'opencode', mcp: 'agent-bot' }],
  }));
  const check = report.machine.checks.find((entry) => entry.id === 'inbox.configuration');
  assert.equal(check.status, 'warning');
  assert.equal(check.code, 'inbox-incompletely-configured');
  assert.match(check.action, /gh-app-hook deployment procedure/);
});

// #318: the reachability probe is opt-in. Without a probe the check is absent
// and nothing is sent; with one, every outcome stays advisory.
test('the inbox probe is absent from a default run and makes no call', async () => {
  const report = await collectReadiness(machineScopeOptions({
    env: { HOME: tempRoot(), GH_APP_HOOK_INBOX_URL: 'https://example.invalid' },
  }));
  assert.equal(report.machine.checks.some((entry) => entry.id === 'inbox.reachability'), false);
});

test('the inbox probe reports skipped, not an error, when no inbox URL is configured', async () => {
  const report = await collectReadiness(machineScopeOptions({
    probeInbox: () => assert.fail('probed with no inbox URL'),
  }));
  const check = report.machine.checks.find((entry) => entry.id === 'inbox.reachability');
  assert.equal(check.status, 'not_applicable');
  assert.equal(check.code, 'inbox-probe-skipped');
  assert.equal(report.ready, true);
});

test('inbox probe outcomes map to distinct advisory checks naming only the host', async () => {
  for (const [result, status, code, pattern] of [
    [{ outcome: 'http', http_status: 404 }, 'ready', null, /reachable \(HTTP 404\)/],
    [{ outcome: 'http', http_status: 401 }, 'ready', null, /HTTP 401, expected without a bearer/],
    [{ outcome: 'http', http_status: 503 }, 'warning', 'inbox-probe-http-error', /reachable but failing \(HTTP 503\)/],
    [{ outcome: 'dns', error_code: 'ENOTFOUND' }, 'warning', 'inbox-probe-dns', /did not resolve/],
    [{ outcome: 'tls', error_code: 'CERT_HAS_EXPIRED' }, 'warning', 'inbox-probe-tls', /TLS handshake/],
    [{ outcome: 'refused', error_code: 'ECONNREFUSED' }, 'warning', 'inbox-probe-refused', /refused the connection/],
    [{ outcome: 'timeout', error_code: 'PROBE_TIMEOUT' }, 'warning', 'inbox-probe-timeout', /did not answer in time/],
  ]) {
    let probed = null;
    const report = await collectReadiness(machineScopeOptions({
      env: {
        HOME: tempRoot(),
        GH_APP_HOOK_INBOX_URL: 'https://inbox.example.invalid/base?key=query-secret',
        GH_APP_HOOK_INBOX_TOKEN: 'super-secret-bearer-value',
      },
      probeInbox: async (url) => { probed = url; return { host: 'inbox.example.invalid', ...result }; },
    }));
    const check = report.machine.checks.find((entry) => entry.id === 'inbox.reachability');
    assert.equal(check.status, status, result.outcome);
    assert.equal(check.code, code, result.outcome);
    assert.match(check.message, pattern);
    assert.match(check.message, /inbox\.example\.invalid/);
    assert.equal(probed, 'https://inbox.example.invalid/base?key=query-secret');
    assert.equal(report.ready, true, 'the probe is advisory');
    const rendered = JSON.stringify(report) + renderReadinessReport(report);
    assert.doesNotMatch(rendered, /super-secret-bearer-value|query-secret|token|Bearer /);
  }
});

test('doctor --probe-inbox sends no bearer and never prints it, in JSON or text', async () => {
  const seen = [];
  const server = createServer((req, res) => {
    seen.push({ method: req.method, url: req.url, headers: req.headers });
    res.writeHead(401).end();
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  const env = {
    HOME: tempRoot(),
    GH_APP_HOOK_INBOX_URL: `http://user:url-secret@127.0.0.1:${port}/x?key=query-secret`,
    GH_APP_HOOK_INBOX_TOKEN: 'super-secret-bearer-value',
  };
  const previous = process.exitCode;
  try {
    for (const argv of [['--machine-only', '--probe-inbox', '--json'], ['--machine-only', '--probe-inbox']]) {
      let stdout = '';
      const report = await doctorMain(argv, {
        collect: (options) => collectReadiness(machineScopeOptions({ ...options, env })),
        cache: () => {},
        output: { write: (value) => { stdout += value; } },
      });
      const check = report.machine.checks.find((entry) => entry.id === 'inbox.reachability');
      assert.equal(check.status, 'ready');
      assert.equal(check.evidence.http_status, 401);
      assert.equal(check.evidence.host, `127.0.0.1:${port}`);
      assert.match(stdout, /inbox broker 127\.0\.0\.1:\d+ is reachable/);
      assert.doesNotMatch(stdout, /super-secret-bearer-value|url-secret|query-secret|token|Bearer /);
    }
    assert.equal(seen.length, 2);
    for (const request of seen) {
      assert.equal(request.method, 'HEAD');
      assert.equal(request.url, '/inbox');
      assert.equal(request.headers.authorization, undefined);
      assert.doesNotMatch(JSON.stringify(request.headers), /secret/);
    }
    // Without the flag doctor passes no probe, so the listener is never hit.
    await doctorMain(['--machine-only', '--json'], {
      collect: (options) => {
        assert.equal(options.probeInbox, undefined);
        return collectReadiness(machineScopeOptions({ ...options, env }));
      },
      cache: () => {},
      output: { write: () => {} },
    });
    assert.equal(seen.length, 2);
  } finally {
    process.exitCode = previous;
    server.close();
  }
});

test('version skew is reported as a warning and explains the refusal', async () => {
  const report = await collectReadiness(machineScopeOptions({
    readPackageVersion: () => '0.7.0',
    installedCliVersion: () => '0.6.0',
    exists: (path) => path.endsWith('package.json'),
  }));
  const check = report.machine.checks.find((entry) => entry.id === 'runtime.version_skew');
  assert.equal(check.status, 'warning');
  assert.equal(check.code, 'runtime-version-skew');
  assert.equal(check.evidence.installed_version, '0.6.0');
  assert.equal(check.evidence.checkout_version, '0.7.0');
  assert.match(check.message, /refuses to replace a foreign Homebrew install/);
  assert.match(check.action, /brew upgrade agent-bot/);
});

test('the worktree summary is derived from the census without a git call per soul', async () => {
  const home = tempRoot();
  const census = join(home, '.local', 'state', 'agent-bot', 'population.json');
  // These rows name a rostered App. A row may also omit appSlug (#280);
  // normalizeSoul stores that absence as null.
  const row = (id, appSlug) => ({
    id,
    name: displayName(id),
    appSlug,
    parentId: null,
    status: 'active',
    spacePath: join(home, '.agent-space', id),
    worktree: join(home, id),
    transcriptLocator: null,
    lastSeen: '2026-08-16T00:00:00.000Z',
  });
  mkdirSync(dirname(census), { recursive: true });
  writeFileSync(census, `${JSON.stringify({
    schemaVersion: 1,
    souls: {
      'agent_11111111-1111-4111-8111-111111111111': row('agent_11111111-1111-4111-8111-111111111111', 'org-claude-agent'),
      'agent_22222222-2222-4222-8222-222222222222': row('agent_22222222-2222-4222-8222-222222222222', 'org-claude-agent'),
      'agent_33333333-3333-4333-8333-333333333333': row('agent_33333333-3333-4333-8333-333333333333', 'org-codex-agent'),
    },
  }, null, 2)}\n`);
  const report = await collectReadiness(censusScopeOptions(home, () => ''));
  const check = report.machine.checks.find((entry) => entry.id === 'worktree.binding_summary');
  assert.equal(check.status, 'ready');
  assert.equal(check.evidence.active, 3);
  assert.equal(check.evidence.checkouts, 3);
  assert.deepEqual(check.evidence.by_app, { 'org-claude-agent': 2, 'org-codex-agent': 1 });
  assert.deepEqual(check.evidence.not_in_roster, []);
});

test('the worktree summary is derived from the census, never from git', async () => {
  // Isolation rather than a call count: the pre-existing souls.referenced check
  // already spends a git call per soul, so counting total calls would attribute
  // that spend here. If this check shelled out at all, a git stub that throws
  // would take the summary down with it.
  const home = tempRoot();
  const census = join(home, '.local', 'state', 'agent-bot', 'population.json');
  const row = (id, appSlug) => ({
    id,
    name: displayName(id),
    appSlug,
    parentId: null,
    status: 'active',
    spacePath: join(home, '.agent-space', id),
    worktree: join(home, id),
    transcriptLocator: null,
    lastSeen: '2026-08-16T00:00:00.000Z',
  });
  mkdirSync(dirname(census), { recursive: true });
  writeFileSync(census, `${JSON.stringify({
    schemaVersion: 1,
    souls: {
      'agent_11111111-1111-4111-8111-111111111111': row('agent_11111111-1111-4111-8111-111111111111', 'org-claude-agent'),
      'agent_22222222-2222-4222-8222-222222222222': row('agent_22222222-2222-4222-8222-222222222222', 'org-codex-agent'),
    },
  }, null, 2)}\n`);
  const report = await collectReadiness(censusScopeOptions(home, () => {
    throw Object.assign(new Error('git must not be consulted for the binding summary'), { status: 1 });
  }));
  const check = report.machine.checks.find((entry) => entry.id === 'worktree.binding_summary');
  assert.ok(check, 'the binding summary must not depend on git');
  assert.equal(check.status, 'ready');
  assert.equal(check.evidence.checkouts, 2);
});

test('the worktree summary flags a checkout bound outside the configured roster', async () => {
  const home = tempRoot();
  const census = join(home, '.local', 'state', 'agent-bot', 'population.json');
  mkdirSync(dirname(census), { recursive: true });
  writeFileSync(census, `${JSON.stringify({
    schemaVersion: 1,
    souls: {
      'agent_11111111-1111-4111-8111-111111111111': {
        id: 'agent_11111111-1111-4111-8111-111111111111',
        name: displayName('agent_11111111-1111-4111-8111-111111111111'),
        appSlug: 'other-agent',
        parentId: null,
        status: 'active',
        spacePath: join(home, '.agent-space', 'agent_11111111-1111-4111-8111-111111111111'),
        worktree: join(home, 'repo'),
        transcriptLocator: null,
        lastSeen: '2026-08-16T00:00:00.000Z',
      },
    },
  }, null, 2)}\n`);
  const report = await collectReadiness(censusScopeOptions(home));
  const check = report.machine.checks.find((entry) => entry.id === 'worktree.binding_summary');
  assert.equal(check.status, 'warning');
  assert.equal(check.code, 'worktree-binding-foreign-app');
  assert.deepEqual(check.evidence.not_in_roster, ['other-agent']);
});

test('the current worktree binding fails only for a non-rostered App', async () => {
  const repo = join(tempRoot(), 'repo');
  mkdirSync(repo);
  execFileSync('git', ['init', '--quiet', '--initial-branch=main'], { cwd: repo });
  const env = hermeticGitEnv(process.env, { HOME: repo, GIT_CONFIG_GLOBAL: join(repo, '.gitconfig') });
  const git = (args, options) => execFileSync('git', args, {
    cwd: options?.cwd, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
  }).replace(/[\r\n]+$/, '');

  const unbound = await collectReadiness({
    command: 'doctor', scope: 'worktree', cwd: repo, home: repo, env, git,
    load: () => ({ apps: { claude: 'org-claude-agent' } }),
    isSoulBoundImpl: () => false,
  });
  const absent = unbound.worktree.checks.find((check) => check.id === 'worktree.binding');
  assert.equal(absent.status, 'warning');
  assert.equal(absent.code, 'worktree-binding-absent');
  assert.match(absent.action, /setup-worktree/);

  execFileSync('git', ['config', '--worktree', 'agentBot.app', 'other-agent'], { cwd: repo, env });
  const foreign = await collectReadiness({
    command: 'doctor', scope: 'worktree', cwd: repo, home: repo, env, git,
    load: () => ({ apps: { claude: 'org-claude-agent' } }),
    isSoulBoundImpl: () => false,
  });
  const foreignCheck = foreign.worktree.checks.find((check) => check.id === 'worktree.binding');
  assert.equal(foreignCheck.status, 'failed');
  assert.equal(foreignCheck.code, 'worktree-binding-not-in-roster');
  assert.equal(foreign.worktree.status, 'not_ready');

  execFileSync('git', ['config', '--worktree', 'agentBot.app', 'org-claude-agent'], { cwd: repo, env });
  const bound = await collectReadiness({
    command: 'doctor', scope: 'worktree', cwd: repo, home: repo, env, git,
    load: () => ({ apps: { claude: 'org-claude-agent' } }),
    isSoulBoundImpl: () => false,
  });
  assert.equal(
    bound.worktree.checks.find((check) => check.id === 'worktree.binding').status,
    'ready',
  );
});

test('a foreign App fails the worktree section, not just the check list', async () => {
  // The regression both reviewers found: appending a `failed` check without
  // recomputing the section left `ready: true` and a zero exit code.
  const repo = join(tempRoot(), 'repo');
  mkdirSync(repo);
  execFileSync('git', ['init', '--quiet', '--initial-branch=main'], { cwd: repo });
  const env = hermeticGitEnv(process.env, { HOME: repo, GIT_CONFIG_GLOBAL: join(repo, '.gitconfig') });
  const git = (args, options) => execFileSync('git', args, {
    cwd: options?.cwd, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
  }).replace(/[\r\n]+$/, '');
  execFileSync('git', ['config', '--worktree', 'agentBot.app', 'other-agent'], { cwd: repo, env });
  const report = await collectReadiness({
    command: 'doctor', scope: 'worktree', cwd: repo, home: repo, env, git,
    load: () => ({ apps: { claude: 'org-claude-agent' } }),
  });
  const binding = report.worktree.checks.find((check) => check.id === 'worktree.binding');
  assert.equal(binding.status, 'failed');
  // The section and the report must both reflect it.
  assert.equal(report.worktree.status, 'not_ready');
  assert.equal(report.ready, false);
  // firstActionableFailure reports the first failure in the section, which is a
  // pre-existing worktree check in a bare fixture. The binding failure is
  // asserted directly above and reflected in the section status here.
  assert.ok(report.first_actionable_failure);
});

test('an unconfigured roster does not make every App acceptable', async () => {
  // Absence of a roster is an unconfigured machine, not a machine where any
  // pinned App is fine. Treating it as allow-all made the foreign-App failure
  // unreachable on exactly the accounts least able to detect it.
  const repo = join(tempRoot(), 'repo');
  mkdirSync(repo);
  execFileSync('git', ['init', '--quiet', '--initial-branch=main'], { cwd: repo });
  const env = hermeticGitEnv(process.env, { HOME: repo, GIT_CONFIG_GLOBAL: join(repo, '.gitconfig') });
  const git = (args, options) => execFileSync('git', args, {
    cwd: options?.cwd, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
  }).replace(/[\r\n]+$/, '');
  execFileSync('git', ['config', '--worktree', 'agentBot.app', 'any-agent'], { cwd: repo, env });
  const report = await collectReadiness({
    command: 'doctor', scope: 'worktree', cwd: repo, home: repo, env, git,
    load: () => ({}),
  });
  const binding = report.worktree.checks.find((check) => check.id === 'worktree.binding');
  // Advisory, not failed: an unverifiable roster is an unconfigured machine, and
  // the other worktree checks in a bare fixture carry their own failures, so the
  // binding check's own status is what this asserts.
  assert.equal(binding.status, 'warning');
  assert.equal(binding.code, 'worktree-binding-no-roster');
});

test('the inbox section ignores an unrelated MCP server', async () => {
  // `mcp: 'other'` used to satisfy the truthiness filter, so a harness with some
  // unrelated server would read as inbox-wired and report ready.
  const report = await collectReadiness(machineScopeOptions({
    env: {
      HOME: tempRoot(),
      GH_APP_HOOK_INBOX_URL: 'https://example.invalid',
      GH_APP_HOOK_INBOX_TOKEN: 'a-bearer-value',
    },
    listHarnessMcpServers: () => [{ harness: 'claude', mcp: 'other' }],
  }));
  const check = report.machine.checks.find((entry) => entry.id === 'inbox.configuration');
  assert.equal(check.status, 'warning');
  assert.deepEqual(check.evidence.harnesses_wired, []);
});

test('the inbox section recognises the documented per-harness config shapes', async () => {
  for (const [label, harnesses, expected] of [
    ['claude mcpServers', [{ harness: 'claude', mcp: 'agent-bot' }], ['claude']],
    ['codex mcp_servers', [{ harness: 'codex', mcp: 'agent-bot' }], ['codex']],
    ['qwen mcpServers', [{ harness: 'qwen', mcp: 'agent-bot' }], ['qwen']],
  ]) {
    const report = await collectReadiness(machineScopeOptions({
      env: {
        HOME: tempRoot(),
        GH_APP_HOOK_INBOX_URL: 'https://example.invalid',
        GH_APP_HOOK_INBOX_TOKEN: 'a-bearer-value',
      },
      listHarnessMcpServers: () => harnesses,
    }));
    const check = report.machine.checks.find((entry) => entry.id === 'inbox.configuration');
    assert.equal(check.status, 'ready', label);
    assert.deepEqual(check.evidence.harnesses_wired, expected, label);
  }
});

test('version skew ignores an unrelated project manifest', async () => {
  // Accepting any package.json in the cwd compared the installed runtime against
  // whatever project doctor was run from, producing bogus skew and a bogus
  // `brew upgrade` recommendation.
  const project = tempRoot();
  writeFileSync(join(project, 'package.json'), JSON.stringify({ name: 'some-other-app', version: '9.9.9' }));
  const report = await collectReadiness(machineScopeOptions({
    cwd: project,
    readPackageVersion: (path) => (path.includes('some-other-app') ? '9.9.9' : '0.6.0'),
    exists: (path) => path.endsWith('package.json'),
  }));
  const check = report.machine.checks.find((entry) => entry.id === 'runtime.version_skew');
  assert.notEqual(check.code, 'runtime-version-skew');
  assert.notEqual(check.evidence.checkout_version, '9.9.9');
});

test('an unreachable store is not reported as a logged-out session', async () => {
  // A timeout or a missing executable must not send the operator to log in
  // again; the recovery is completely different.
  for (const code of ['PROVIDER_TIMEOUT', 'PROVIDER_START_FAILED', 'PROVIDER_UNAVAILABLE']) {
    const report = await collectReadiness(machineScopeOptions({
      probeSecretStore: () => [{ id: 'proton-pass', available: false, session: false, code }],
    }));
    const check = report.machine.checks.find((entry) => entry.id === 'securestore.session');
    assert.equal(check.code, 'securestore-provider-unavailable', code);
    assert.match(check.action, /will not help an unreachable provider/);
    assert.equal(check.evidence.providers[0].code, code);
  }
  const loggedOut = await collectReadiness(machineScopeOptions({
    probeSecretStore: () => [{ id: 'proton-pass', available: true, session: false, code: 'PROVIDER_NO_SESSION' }],
  }));
  const check = loggedOut.machine.checks.find((entry) => entry.id === 'securestore.session');
  assert.equal(check.code, 'securestore-no-session');
  assert.match(check.action, /log the provider in/);
});

test('the binding summary counts checkouts, not souls', async () => {
  // A soul may hold several linked worktrees; counting one per soul undercounts
  // what the check claims to summarize.
  const home = tempRoot();
  const census = join(home, '.local', 'state', 'agent-bot', 'population.json');
  mkdirSync(dirname(census), { recursive: true });
  writeFileSync(census, `${JSON.stringify({
    schemaVersion: 1,
    souls: {
      'agent_11111111-1111-4111-8111-111111111111': {
        id: 'agent_11111111-1111-4111-8111-111111111111',
        name: displayName('agent_11111111-1111-4111-8111-111111111111'),
        appSlug: 'org-claude-agent',
        parentId: null,
        status: 'active',
        spacePath: join(home, '.agent-space', 'a'),
        worktrees: [join(home, 'a'), join(home, 'b'), join(home, 'c')],
        transcriptLocator: null,
        lastSeen: '2026-08-16T00:00:00.000Z',
      },
    },
  }, null, 2)}\n`);
  const report = await collectReadiness(censusScopeOptions(home, () => ''));
  const check = report.machine.checks.find((entry) => entry.id === 'worktree.binding_summary');
  assert.equal(check.evidence.active, 1);
  assert.equal(check.evidence.checkouts, 3);
});

test('the binding check ignores GIT_CONFIG_* injection in the default env path', async () => {
  // The existing suite test cannot catch this: it passes a hermetic env, so
  // collectReadiness never defaults to process.env. This one leaves
  // GIT_CONFIG_COUNT poisoning the real environment the way a container would.
  const repo = join(tempRoot(), 'repo');
  mkdirSync(repo);
  execFileSync('git', ['init', '--quiet', '--initial-branch=main'], { cwd: repo });
  const clean = hermeticGitEnv(process.env, { HOME: repo, GIT_CONFIG_GLOBAL: join(repo, '.gitconfig') });
  const git = (args, options) => execFileSync('git', args, {
    cwd: options?.cwd, env: options?.env ?? clean, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
  }).replace(/[\r\n]+$/, '');
  execFileSync('git', ['config', '--worktree', 'agentBot.app', 'org-claude-agent'], { cwd: repo, env: clean });

  const saved = new Map();
  const poison = {
    GIT_CONFIG_COUNT: '1',
    GIT_CONFIG_KEY_0: 'agentBot.app',
    GIT_CONFIG_VALUE_0: 'ambient-wrong-agent',
  };
  for (const [key, value] of Object.entries(poison)) {
    saved.set(key, process.env[key]);
    process.env[key] = value;
  }
  try {
    // cwd is a real repo whose own config pins org-claude-agent.
    const report = await collectReadiness({
      command: 'doctor', scope: 'worktree', cwd: repo, home: repo, env: process.env, git,
      load: () => ({ apps: { claude: 'org-claude-agent' } }),
      isSoulBoundImpl: () => false,
    });
    const check = report.worktree.checks.find((entry) => entry.id === 'worktree.binding');
    assert.equal(check.status, 'ready');
    assert.equal(check.evidence.app_slug, 'org-claude-agent');
    assert.doesNotMatch(JSON.stringify(report), /ambient-wrong-agent/);
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test('the inbox section finds a project-scoped MCP registration', async () => {
  // Scanning only `home` reports a false negative for the common case where the
  // wiring is committed alongside the repository that needs it.
  const home = tempRoot();
  const project = tempRoot();
  writeFileSync(join(project, '.mcp.json'), JSON.stringify({
    mcpServers: { 'agent-bot': { command: ['agent-bot', 'mcp'] } },
  }));
  const harnessWires = harnessMcpWiring({ home, cwd: project });
  assert.ok(
    harnessWires.some((entry) => entry.harness === 'claude' && entry.scope === 'project'),
    `expected a project-scoped claude registration, saw ${JSON.stringify(harnessWires)}`,
  );
});

test('the inbox section still finds a user-scoped registration', async () => {
  const home = tempRoot();
  mkdirSync(join(home, '.config', 'opencode'), { recursive: true });
  writeFileSync(join(home, '.config', 'opencode', 'opencode.jsonc'), '{\n  "mcp": { "agent-bot": {} }\n}\n');
  const harnessWires = harnessMcpWiring({ home, cwd: tempRoot() });
  assert.ok(
    harnessWires.some((entry) => entry.harness === 'opencode' && entry.scope === 'user'),
    `expected a user-scoped opencode registration, saw ${JSON.stringify(harnessWires)}`,
  );
});

test('an unrelated MCP server is never reported as agent-bot wiring', async () => {
  const home = tempRoot();
  const project = tempRoot();
  writeFileSync(join(project, '.mcp.json'), JSON.stringify({
    mcpServers: { playwright: { command: ['npx', 'playwright'] } },
  }));
  assert.deepEqual(harnessMcpWiring({ home, cwd: project }), []);
});

// Qwen Code reads `mcpServers` from settings.json at two scopes: user
// ~/.qwen/settings.json and project .qwen/settings.json. Without a row in both
// tables a correctly wired Qwen harness is a permanent false negative, and
// inbox.configuration can never list `qwen` in harnesses_wired.
test('the inbox section finds a user-scoped Qwen registration', async () => {
  const home = tempRoot();
  mkdirSync(join(home, '.qwen'), { recursive: true });
  writeFileSync(join(home, '.qwen', 'settings.json'), JSON.stringify({
    mcpServers: { 'agent-bot': { command: 'agent-bot', args: ['mcp'] } },
  }));
  const harnessWires = harnessMcpWiring({ home, cwd: tempRoot() });
  assert.ok(
    harnessWires.some((entry) => entry.harness === 'qwen' && entry.scope === 'user'),
    `expected a user-scoped qwen registration, saw ${JSON.stringify(harnessWires)}`,
  );
});

test('the inbox section finds a project-scoped Qwen registration', async () => {
  const home = tempRoot();
  const project = tempRoot();
  mkdirSync(join(project, '.qwen'), { recursive: true });
  writeFileSync(join(project, '.qwen', 'settings.json'), JSON.stringify({
    mcpServers: { 'agent-bot': { command: 'agent-bot', args: ['mcp'] } },
  }));
  const harnessWires = harnessMcpWiring({ home, cwd: project });
  assert.ok(
    harnessWires.some((entry) => entry.harness === 'qwen' && entry.scope === 'project'),
    `expected a project-scoped qwen registration, saw ${JSON.stringify(harnessWires)}`,
  );
});

test('an unrelated MCP server in Qwen settings is not agent-bot wiring', async () => {
  const home = tempRoot();
  mkdirSync(join(home, '.qwen'), { recursive: true });
  writeFileSync(join(home, '.qwen', 'settings.json'), JSON.stringify({
    mcpServers: { playwright: { command: 'npx', args: ['playwright'] } },
  }));
  assert.deepEqual(harnessMcpWiring({ home, cwd: tempRoot() }), []);
});

test('doctor on a GeniusBar Mac skips what the app does not install and points at its menu (#428)', async () => {
  const home = tempRoot();
  const app = '/Applications/GeniusBar.app';
  const missing = () => { throw Object.assign(new Error('missing'), { code: 'ENOENT' }); };
  const report = await collectReadiness({
    ...machineDependencies(home),
    scope: 'machine',
    embeddingApp: app,
    lstat: missing,
    access: missing,
    spawn: () => ({ status: 1, stdout: '' }),
    git: (args) => {
      if (args[0] === '--version') return 'git version 2.50.1';
      throw Object.assign(new Error('unset'), { status: 1 });
    },
    load: () => ({}),
    inspectCredentials: async () => [],
  });
  const byId = Object.fromEntries(report.machine.checks.map((check) => [check.id, check]));
  assert.equal(byId['runtime.installed_cli'].status, 'ready');
  assert.match(byId['runtime.installed_cli'].message, /inside GeniusBar\.app \(\/Applications\/GeniusBar\.app\)/);
  assert.equal(byId['runtime.harness_path'].status, 'warning');
  assert.match(byId['runtime.harness_path'].action, /in GeniusBar, choose Command-line tools/);
  for (const id of ['config.runtime', 'account.app', 'hooks.installation']) {
    assert.equal(byId[id].status, 'not_applicable', id);
    assert.match(byId[id].message, /not used by GeniusBar/, id);
  }
  // Nothing tells a GeniusBar user to run a source-checkout bootstrap.
  const failed = report.machine.checks.filter((check) => check.status === 'failed');
  assert.deepEqual(failed.map(({ id }) => id).filter((id) => ['runtime.installed_cli', 'runtime.harness_path',
    'config.runtime', 'account.app', 'hooks.installation'].includes(id)), []);
  assert.doesNotMatch(renderReadinessReport(report), /source checkout bootstrap|bootstrap --machine-only/);
});

test('doctor from a source checkout still fails what it needs installed', async () => {
  const home = tempRoot();
  const report = await collectReadiness({ ...machineDependencies(home), scope: 'machine', embeddingApp: null,
    lstat: () => null, spawn: () => ({ status: 1, stdout: '' }) });
  const byId = Object.fromEntries(report.machine.checks.map((check) => [check.id, check]));
  assert.equal(byId['runtime.installed_cli'].status, 'failed');
  assert.equal(byId['runtime.harness_path'].status, 'failed');
});

test('doctor on a GeniusBar Mac inspects the daemon unit the app installed (#428)', async () => {
  const home = tempRoot();
  const app = join(home, 'GeniusBar.app');
  mkdirSync(join(app, 'Contents'), { recursive: true });
  writeFileSync(join(app, 'Contents', 'Info.plist'),
    '<?xml version="1.0"?><plist version="1.0"><dict><key>CFBundleIdentifier</key>\n  <string>app.geniusbar</string></dict></plist>');
  const labels = [];
  await collectReadiness({ ...machineDependencies(home), scope: 'machine', embeddingApp: app,
    inspectDaemonSupervisor: ({ env }) => { labels.push(env.AGENT_BOT_SERVICE_LABEL); return { supported: true, applied: true, loaded: true, platform: 'darwin', kind: 'launchd' }; } });
  assert.deepEqual(labels, ['app.geniusbar.agent-bot']);
  // A label the caller set wins.
  labels.length = 0;
  await collectReadiness({ ...machineDependencies(home), scope: 'machine', embeddingApp: app, env: { HOME: home, AGENT_BOT_SERVICE_LABEL: 'custom.label' },
    inspectDaemonSupervisor: ({ env }) => { labels.push(env.AGENT_BOT_SERVICE_LABEL); return { supported: true, applied: true, loaded: true, platform: 'darwin', kind: 'launchd' }; } });
  assert.deepEqual(labels, ['custom.label']);
});

test('doctor on a GeniusBar Mac never sends its user to agent-bot install or the source bootstrap (#428)', async () => {
  const home = tempRoot();
  const app = '/Applications/GeniusBar.app';
  const missing = () => { throw Object.assign(new Error('missing'), { code: 'ENOENT' }); };
  const report = await collectReadiness({
    ...machineDependencies(home),
    scope: 'machine',
    embeddingApp: app,
    access: missing,
    inspectDaemonSupervisor: () => ({ supported: true, applied: false, loaded: false, platform: 'darwin', kind: 'launchd' }),
    probeDaemon: async () => ({ running: false }),
    load: () => ({}),
    inspectCredentials: async () => [],
  });
  const byId = Object.fromEntries(report.machine.checks.map((check) => [check.id, check]));
  // No user-level identity hook is the app's design, not an ephemeral session.
  assert.equal(byId['identity.class'].status, 'not_applicable');
  assert.match(byId['identity.class'].message, /not used by GeniusBar/);
  assert.equal(byId['identity.class'].action, null);
  // The app's own services are reinstalled from the app, not `agent-bot install`.
  for (const id of ['daemon.supervisor', 'daemon.health']) {
    assert.equal(byId[id].status, 'failed', id);
    assert.equal(byId[id].action, 'open GeniusBar and choose Set up; it installs and restarts its own services', id);
  }
  // An incomplete in-app skill bundle means reinstalling the app.
  assert.equal(byId['skill.runtime'].status, 'failed');
  assert.match(byId['skill.runtime'].action, /^reinstall GeniusBar from its latest release/);
  const actions = report.machine.checks.map((check) => check.action ?? '').join('\n');
  assert.doesNotMatch(actions, /agent-bot install|bootstrap|restore the checkout/);
  assert.doesNotMatch(renderReadinessReport(report), /agent-bot install|source checkout bootstrap|restore the checkout/);
});

for (const state of ['missing', 'unreadable', 'live', 'human', 'missing-without-session-id']) {
  test(`current worktree binding distinguishes a rostered pin from a usable binding: ${state}`, async () => {
    const cwd = tempRoot();
    const sessionId = 'agent_11111111-1111-4111-8111-111111111111';
    const env = { HOME: cwd, ...(state === 'missing-without-session-id' ? {} : { AGENT_BOT_ID: sessionId }) };
    let bindingReads = 0;
    const report = await collectReadiness({
      command: 'doctor', scope: 'worktree', cwd, home: cwd, env,
      load: () => ({ apps: { grok: 'qwts-grok-agent' } }),
      git: (args) => {
        if (args.join(' ') === 'config --worktree --get agentBot.app') return 'qwts-grok-agent';
        throw Object.assign(new Error('unset'), { status: 1 });
      },
      isSoulBoundImpl: (options) => {
        assert.deepEqual(options, { env, cwd });
        return state !== 'human';
      },
      readBindingImpl: (options) => {
        assert.deepEqual(options, { env, cwd });
        bindingReads++;
        if (state === 'unreadable') throw new Error('private binding details must not be reported');
        return state === 'live' ? { agentId: sessionId } : null;
      },
    });
    const check = report.worktree.checks.find(({ id }) => id === 'worktree.binding');
    assert.equal(bindingReads, state === 'human' ? 0 : 1);
    if (state === 'live' || state === 'human') {
      assert.equal(check.status, 'ready');
      assert.equal(check.code, null);
      assert.equal(check.action, null);
      assert.equal(check.message, 'the current worktree is bound to qwts-grok-agent');
    } else {
      assert.equal(check.status, 'warning');
      assert.equal(check.code, 'worktree-binding-unusable');
      assert.equal(check.message, 'the current worktree is bound to qwts-grok-agent, but this session has no live daemon binding for it, so gh will refuse to run');
      assert.equal(check.action, 'check in as that soul (agent-bot join --name NAME --harness HARNESS) or re-bind this checkout to the session soul with: agent-bot setup-worktree');
      assert.deepEqual(check.evidence, {
        worktree: cwd, app_slug: 'qwts-grok-agent', roster: ['qwts-grok-agent'],
        session_soul: state === 'missing-without-session-id' ? null : sessionId,
      });
      assert.doesNotMatch(JSON.stringify(report), /private binding details/);
    }
  });
}
