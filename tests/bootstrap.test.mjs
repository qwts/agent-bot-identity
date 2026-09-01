import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  bootstrap,
  bootstrapConfigPath,
  configuredAppSlugs,
  installBootstrapConfig,
  installBootstrapProfile,
  main as bootstrapMain,
  parseBootstrapArgs,
} from '../bootstrap.mjs';
import { parseDoctorArgs } from '../doctor.mjs';
import {
  OrganizationProfileError,
  organizationProfileToConfig,
} from '../organization-profile.mjs';

function tempHome() {
  return mkdtempSync(join(tmpdir(), 'agent-bot-bootstrap-'));
}

function organizationProfile(overrides = {}) {
  return {
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
      { slug: 'example-old-agent', harness: 'codex', status: 'retired' },
    ],
    ...overrides,
  };
}

function readyReport(scope = 'all') {
  return {
    schema_version: 1,
    command: 'bootstrap',
    scope,
    ready: true,
    machine: {
      status: scope === 'worktree' ? 'not_requested' : 'ready',
      checks: [],
      apps: [],
    },
    worktree: {
      status: scope === 'machine' ? 'not_requested' : 'ready',
      checks: [],
    },
    first_actionable_failure: null,
  };
}

test('bootstrap CLI parses explicit phases and rejects ignored machine options', () => {
  assert.deepEqual(
    parseBootstrapArgs(['--config', '/tmp/config.json', '--app', 'two-agent', '--app', 'one-agent', '--with-gh-shim']),
    {
      apps: ['two-agent', 'one-agent'],
      configPath: '/tmp/config.json',
      profilePath: null,
      help: false,
      json: false,
      phase: 'all',
      requireSchemaVersion: null,
      withGhShim: true,
    },
  );
  assert.equal(parseBootstrapArgs(['--json', '--require-schema-version', '1']).json, true);
  assert.equal(
    parseBootstrapArgs(['--require-schema-version', '1']).requireSchemaVersion,
    1,
  );
  assert.equal(parseBootstrapArgs(['--machine-only']).phase, 'machine');
  assert.equal(parseBootstrapArgs(['--worktree-only']).phase, 'worktree');
  assert.equal(parseBootstrapArgs(['--profile', '-']).profilePath, '-');
  assert.throws(
    () => parseBootstrapArgs(['--machine-only', '--worktree-only']),
    /conflicts/,
  );
  assert.throws(
    () => parseBootstrapArgs(['--worktree-only', '--with-gh-shim']),
    /does not accept machine setup options/,
  );
  assert.throws(() => parseBootstrapArgs(['--config']), /requires a value/);
  assert.throws(
    () => parseBootstrapArgs(['--profile', '/profile.json', '--config', '/config.json']),
    /conflicts/,
  );
  assert.throws(
    () => parseBootstrapArgs(['--worktree-only', '--profile', '/profile.json']),
    /does not accept machine setup options/,
  );
  assert.throws(() => parseBootstrapArgs(['--unknown']), /unknown option/);
});

test('doctor exposes a machine-only verification phase', () => {
  assert.deepEqual(parseDoctorArgs([]), {
    apps: [],
    help: false,
    json: false,
    machineOnly: false,
    requireSchemaVersion: null,
  });
  assert.deepEqual(parseDoctorArgs(['--machine-only', '--json']), {
    apps: [],
    help: false,
    json: true,
    machineOnly: true,
    requireSchemaVersion: null,
  });
  assert.deepEqual(parseDoctorArgs(['--app', 'explicit-agent', '--require-schema-version', '1']), {
    apps: ['explicit-agent'],
    help: false,
    json: false,
    machineOnly: false,
    requireSchemaVersion: 1,
  });
  assert.throws(() => parseDoctorArgs(['--repair']), /diagnostic only/);
});

test('explicit config installation is normalized, private, and idempotent', () => {
  const home = tempHome();
  const source = join(home, 'organization.json');
  writeFileSync(source, JSON.stringify({ apps: { codex: 'org-codex-agent' }, owner: 'org' }));

  const first = installBootstrapConfig({ sourcePath: source, home, env: {} });
  assert.equal(first.updated, true);
  assert.deepEqual(first.config, { apps: { codex: 'org-codex-agent' }, owner: 'org' });
  assert.equal(
    readFileSync(bootstrapConfigPath(home), 'utf8'),
    '{\n  "apps": {\n    "codex": "org-codex-agent"\n  },\n  "owner": "org"\n}\n',
  );
  assert.equal(statSync(bootstrapConfigPath(home)).mode & 0o777, 0o600);

  const second = installBootstrapConfig({ sourcePath: source, home, env: {} });
  assert.equal(second.updated, false);
});

test('explicit config refuses different content and foreign symlinks', () => {
  const home = tempHome();
  const source = join(home, 'organization.json');
  const destination = bootstrapConfigPath(home);
  mkdirSync(dirname(destination), { recursive: true });
  writeFileSync(source, JSON.stringify({ prefix: 'new' }));
  writeFileSync(destination, JSON.stringify({ prefix: 'existing' }));
  assert.throws(
    () => installBootstrapConfig({ sourcePath: source, home, env: {} }),
    /conflicts/,
  );

  const linkedHome = tempHome();
  const linkedDestination = bootstrapConfigPath(linkedHome);
  mkdirSync(dirname(linkedDestination), { recursive: true });
  symlinkSync(source, linkedDestination);
  assert.throws(
    () => installBootstrapConfig({ sourcePath: source, home: linkedHome, env: {} }),
    /not a regular agent-bot config file/,
  );
});

test('organization profile installation is private, projected, and idempotent', () => {
  const home = tempHome();
  const source = join(home, 'organization-profile.json');
  writeFileSync(source, JSON.stringify(organizationProfile()));

  const first = installBootstrapProfile({ sourcePath: source, home, env: {} });
  assert.equal(first.updated, true);
  assert.equal(first.profile.schema_version, 1);
  assert.deepEqual(first.config.apps, { codex: 'example-codex-agent' });
  assert.equal(first.config.profile.identities.length, 3);
  assert.equal(statSync(bootstrapConfigPath(home)).mode & 0o777, 0o600);

  const second = installBootstrapProfile({ sourcePath: source, home, env: {} });
  assert.equal(second.updated, false);
  assert.deepEqual(second.config, first.config);
});

test('organization profile accepts stdin and validates before any mutation', () => {
  const home = tempHome();
  const stdin = installBootstrapProfile({
    sourcePath: '-',
    home,
    env: {},
    stdin: 17,
    read: (source, encoding) => {
      assert.equal(source, 17);
      assert.equal(encoding, 'utf8');
      return JSON.stringify(organizationProfile());
    },
  });
  assert.equal(stdin.updated, true);

  for (const [overrides, code] of [
    [{ schema_version: 99 }, 'profile-schema-unsupported'],
    [{ minimum_runtime_interface_version: 99 }, 'profile-runtime-incompatible'],
  ]) {
    const invalidHome = tempHome();
    assert.throws(
      () => installBootstrapProfile({
        sourcePath: '-',
        home: invalidHome,
        env: {},
        read: () => JSON.stringify(organizationProfile(overrides)),
        lstat: () => assert.fail('profile destination inspected before validation'),
        mkdir: () => assert.fail('profile directories created before validation'),
        write: () => assert.fail('profile config written before validation'),
      }),
      (error) => error.code === code,
    );
  }
});

test('profile conflict leaves the installed runtime config untouched', () => {
  const home = tempHome();
  const destination = bootstrapConfigPath(home);
  mkdirSync(dirname(destination), { recursive: true });
  writeFileSync(destination, '{"apps":{"codex":"existing-agent"}}\n', { mode: 0o600 });
  const before = readFileSync(destination, 'utf8');
  assert.throws(
    () => installBootstrapProfile({
      sourcePath: '-',
      home,
      env: {},
      read: () => JSON.stringify(organizationProfile()),
    }),
    (error) => error.code === 'profile-config-conflict',
  );
  assert.equal(readFileSync(destination, 'utf8'), before);
});

test('configured App slugs are unique and deterministic', () => {
  assert.deepEqual(
    configuredAppSlugs(
      { prefix: 'org', apps: { codex: 'custom-codex-agent' } },
      ['z-agent', 'custom-codex-agent', 'a-agent'],
    ),
    [
      'a-agent',
      'custom-codex-agent',
      'org-claude-agent',
      'org-copilot-agent',
      'org-cursor-agent',
      'org-devin-agent',
      'org-muse-agent',
      'org-vscode-agent',
      'z-agent',
    ],
  );
});

test('configured roster includes every active profile App and excludes retired Apps', () => {
  const config = organizationProfileToConfig(organizationProfile());
  assert.deepEqual(
    configuredAppSlugs(config, ['explicit-agent', 'example-codex-agent']),
    [
      'example-codex-agent',
      'example-codex-sol-agent',
      'explicit-agent',
    ],
  );
});

test('configured roster rejects an explicitly selected retired profile App without reflecting it', () => {
  const config = organizationProfileToConfig(organizationProfile());
  assert.throws(
    () => configuredAppSlugs(config, ['example-old-agent']),
    (error) => {
      assert.equal(error.code, 'profile-app-retired');
      assert.doesNotMatch(error.message, /example-old-agent/);
      return true;
    },
  );
});

test('full bootstrap follows config, install, credentials, shim, worktree, readiness order', async () => {
  const calls = [];
  const result = await bootstrap(
    parseBootstrapArgs(['--config', '/profile.json', '--app', 'explicit-agent', '--with-gh-shim']),
    {
      home: '/home/test',
      env: { HOME: '/home/test' },
      installConfig: (options) => {
        calls.push(['config', options.sourcePath]);
        return {
          config: { apps: { codex: 'codex-agent', claude: 'claude-agent' } },
          path: '/home/test/.config/agent-bot/config.json',
          updated: true,
        };
      },
      installRuntime: () => {
        calls.push(['install']);
        return { executable: '/home/test/.local/bin/agent-bot' };
      },
      reconcileCredentials: async ({ slugs }) => {
        calls.push(['credentials', ...slugs]);
        return slugs.map((slug) => ({
          slug,
          local: { status: 'ready', restored: [] },
          live: { status: 'ready', installationId: 1, expiresAt: 'later' },
        }));
      },
      installShim: () => {
        calls.push(['shim']);
        return { shimPath: '/home/test/.config/agent-bot/bin/gh' };
      },
      run: (executable, args) => calls.push(['run', executable, ...args]),
      collect: (options) => {
        calls.push(['collect', options.scope, ...options.appResults.map(({ slug }) => slug)]);
        return readyReport(options.scope);
      },
    },
  );

  assert.equal(result.ready, true);
  assert.deepEqual(
    calls,
    [
      ['config', '/profile.json'],
      ['install'],
      ['credentials', 'claude-agent', 'codex-agent', 'explicit-agent'],
      ['shim'],
      ['run', '/home/test/.local/bin/agent-bot', 'setup-worktree'],
      ['collect', 'all', 'claude-agent', 'codex-agent', 'explicit-agent'],
    ],
  );
});

test('profile bootstrap validates and applies the complete active roster before runtime mutation', async () => {
  const calls = [];
  const config = {
    owner: 'example',
    apps: { codex: 'example-codex-agent' },
    profile: {
      schemaVersion: 1,
      organization: 'example-engineering',
      accountOwner: 'example',
      minimumRuntimeInterfaceVersion: 1,
      identities: organizationProfile().identities.map((identity) => ({
        ...identity,
        models: identity.models ?? [],
      })),
    },
  };
  const report = await bootstrap(
    parseBootstrapArgs(['--profile', '-', '--machine-only']),
    {
      home: '/home/test',
      installConfig: () => assert.fail('legacy config adapter handled a profile'),
      installProfile: ({ sourcePath }) => {
        calls.push(['profile', sourcePath]);
        return { config, path: '/config', updated: true };
      },
      installRuntime: () => {
        calls.push(['runtime']);
        return { executable: '/installed/agent-bot' };
      },
      reconcileCredentials: async ({ slugs }) => {
        calls.push(['credentials', ...slugs]);
        return slugs.map((slug) => ({
          slug,
          local: { status: 'ready', restored: [] },
          live: { status: 'ready', installationId: 1, expiresAt: 'later' },
        }));
      },
      collect: (options) => {
        calls.push(['collect', ...options.appResults.map(({ slug }) => slug)]);
        return readyReport('machine');
      },
    },
  );
  assert.equal(report.ready, true);
  assert.deepEqual(calls, [
    ['profile', '-'],
    ['runtime'],
    ['credentials', 'example-codex-agent', 'example-codex-sol-agent'],
    ['collect', 'example-codex-agent', 'example-codex-sol-agent'],
  ]);
});

test('invalid profile failure stops every downstream bootstrap mutation with a safe result', async () => {
  const sentinel = 'SENTINEL_PRIVATE_KEY_OR_TOKEN';
  const report = await bootstrap(parseBootstrapArgs(['--profile', '-', '--machine-only']), {
    installProfile: () => {
      throw new OrganizationProfileError('profile-invalid', sentinel);
    },
    installRuntime: () => assert.fail('runtime installed after invalid profile'),
    reconcileCredentials: () => assert.fail('credentials reconciled after invalid profile'),
    collect: (options) => ({
      ...readyReport('machine'),
      ready: false,
      machine: { status: 'not_ready', checks: [options.operationFailure.check], apps: [] },
      first_actionable_failure: {
        scope: 'machine',
        check_id: options.operationFailure.check.id,
        app_slug: null,
        code: options.operationFailure.check.code,
        message: options.operationFailure.check.message,
        action: options.operationFailure.check.action,
      },
    }),
  });
  assert.equal(report.ready, false);
  assert.equal(report.first_actionable_failure.code, 'profile-invalid');
  assert.doesNotMatch(JSON.stringify(report), new RegExp(sentinel));
});

test('runtime install failure carries the installer error as evidence', async () => {
  const config = organizationProfileToConfig(organizationProfile());
  const report = await bootstrap(parseBootstrapArgs(['--machine-only']), {
    installConfig: () => ({ config, path: '/config', updated: false }),
    installRuntime: () => {
      const error = new Error("EPERM: operation not permitted, chmod '/prefix/opt/agent-bot/libexec/agent-bot'");
      error.code = 'EPERM';
      throw error;
    },
    reconcileCredentials: () => assert.fail('credentials reconciled after runtime install failure'),
    collect: (options) => ({
      ...readyReport('machine'),
      ready: false,
      machine: { status: 'not_ready', checks: [options.operationFailure.check], apps: [] },
      first_actionable_failure: {
        scope: 'machine',
        check_id: options.operationFailure.check.id,
        app_slug: null,
        code: options.operationFailure.check.code,
        message: options.operationFailure.check.message,
        action: options.operationFailure.check.action,
      },
    }),
  });
  assert.equal(report.ready, false);
  const check = report.machine.checks.find(({ id }) => id === 'bootstrap.runtime');
  assert.equal(check.code, 'runtime-install-failed');
  assert.equal(check.evidence.error_code, 'EPERM');
  assert.match(check.evidence.error, /chmod '\/prefix\/opt\/agent-bot\/libexec\/agent-bot'/);
});

test('retired explicit App stops bootstrap before runtime or credential mutation', async () => {
  const config = organizationProfileToConfig(organizationProfile());
  const report = await bootstrap(
    parseBootstrapArgs(['--app', 'example-old-agent', '--machine-only']),
    {
      installConfig: () => ({ config, path: '/config', updated: false }),
      installRuntime: () => assert.fail('runtime installed after retired App selection'),
      reconcileCredentials: () => assert.fail('retired App credentials were reconciled'),
      collect: (options) => ({
        ...readyReport('machine'),
        ready: false,
        machine: { status: 'not_ready', checks: [options.operationFailure.check], apps: [] },
        first_actionable_failure: {
          scope: 'machine',
          check_id: options.operationFailure.check.id,
          app_slug: null,
          code: options.operationFailure.check.code,
          message: options.operationFailure.check.message,
          action: options.operationFailure.check.action,
        },
      }),
    },
  );
  assert.equal(report.first_actionable_failure.code, 'profile-app-retired');
  assert.doesNotMatch(JSON.stringify(report), /example-old-agent/);
});

test('machine-only and worktree-only phases do not cross their mutation boundary', async () => {
  const machineCalls = [];
  await bootstrap(parseBootstrapArgs(['--machine-only']), {
    home: '/home/test',
    installConfig: () => ({ config: {}, path: '/config', updated: false }),
    installRuntime: () => ({ executable: '/installed/agent-bot' }),
    collect: (options) => {
      machineCalls.push(['collect', options.scope]);
      return readyReport(options.scope);
    },
    run: (_executable, args) => machineCalls.push(args),
  });
  assert.deepEqual(machineCalls, [['collect', 'machine']]);

  const worktreeCalls = [];
  await bootstrap(parseBootstrapArgs(['--worktree-only']), {
    home: '/home/test',
    verifyInstalled: () => {},
    installConfig: () => assert.fail('worktree phase installed config'),
    installRuntime: () => assert.fail('worktree phase installed runtime'),
    run: (_executable, args) => worktreeCalls.push(args),
    collect: (options) => {
      worktreeCalls.push(['collect', options.scope]);
      return readyReport(options.scope);
    },
  });
  assert.deepEqual(worktreeCalls, [['setup-worktree'], ['collect', 'worktree']]);
});

test('worktree-only fails before setup when the runtime is absent', async () => {
  let observed;
  const report = await bootstrap(parseBootstrapArgs(['--worktree-only']), {
    home: '/home/test',
    verifyInstalled: () => {
      throw new Error('agent-bot is not installed from this checkout');
    },
    run: () => assert.fail('setup ran without the installed runtime'),
    collect: (options) => {
      observed = options.operationFailure;
      return {
        ...readyReport('worktree'),
        ready: false,
        worktree: { status: 'not_ready', checks: [options.operationFailure.check] },
      };
    },
  });
  assert.equal(report.ready, false);
  assert.equal(observed.check.code, 'installed-runtime-required');
});

test('bootstrap refuses to continue after credential reconciliation fails', async () => {
  let observedResults;
  const failureResults = [{
    slug: 'missing-id-agent',
    local: { status: 'failed', code: 'missing-issuer', action: 'repair issuer' },
    live: { status: 'skipped' },
  }];
  const report = await bootstrap(
    parseBootstrapArgs(['--machine-only', '--app', 'missing-id-agent']),
    {
      home: '/home/test',
      installConfig: () => ({ config: {}, path: '/config', updated: false }),
      installRuntime: () => ({ executable: '/installed/agent-bot' }),
      reconcileCredentials: async () => {
        const error = new Error('secret-shaped provider detail');
        error.results = failureResults;
        throw error;
      },
      run: () => assert.fail('worktree setup ran after an incomplete credential'),
      collect: (options) => {
        observedResults = options.appResults;
        return {
          ...readyReport('machine'),
          ready: false,
          machine: { status: 'not_ready', checks: [], apps: [] },
        };
      },
    },
  );
  assert.equal(report.ready, false);
  assert.deepEqual(observedResults, failureResults);
});

test('unsupported schema fails before every bootstrap mutation', async () => {
  const report = await bootstrap(parseBootstrapArgs(['--require-schema-version', '2']), {
    installConfig: () => assert.fail('config mutated before schema preflight'),
    installRuntime: () => assert.fail('runtime mutated before schema preflight'),
    reconcileCredentials: () => assert.fail('credentials mutated before schema preflight'),
    installShim: () => assert.fail('shim mutated before schema preflight'),
    run: () => assert.fail('worktree mutated before schema preflight'),
    collect: () => assert.fail('probes ran before schema preflight'),
  });
  assert.equal(report.ready, false);
  assert.equal(report.first_actionable_failure.code, 'readiness-schema-unsupported');
});

test('full bootstrap requires a linked worktree while leaving machine readiness visible', async () => {
  const report = await bootstrap(parseBootstrapArgs([]), {
    home: '/home/test',
    installConfig: () => ({ config: {}, path: '/config', updated: false }),
    installRuntime: () => ({ executable: '/installed/agent-bot' }),
    run: () => {},
    collect: () => ({
      ...readyReport('all'),
      worktree: { status: 'not_applicable', checks: [] },
    }),
  });
  assert.equal(report.machine.status, 'ready');
  assert.equal(report.worktree.status, 'not_ready');
  assert.equal(report.first_actionable_failure.code, 'linked-worktree-required');
});

test('bootstrap JSON mode emits exactly one report object', async () => {
  let stdout = '';
  const previous = process.exitCode;
  try {
    const report = await bootstrapMain(['--json'], {
      output: { write: (value) => { stdout += value; } },
      runBootstrap: async () => readyReport('all'),
    });
    assert.equal(report.ready, true);
    assert.equal(JSON.parse(stdout).schema_version, 1);
    assert.equal(stdout.trim().split('\n').filter((line) => line.startsWith('{')).length, 1);
  } finally {
    process.exitCode = previous;
  }
});
