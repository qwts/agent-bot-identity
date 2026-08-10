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
  parseBootstrapArgs,
} from '../bootstrap.mjs';
import { parseDoctorArgs } from '../doctor.mjs';

function tempHome() {
  return mkdtempSync(join(tmpdir(), 'agent-bot-bootstrap-'));
}

test('bootstrap CLI parses explicit phases and rejects ignored machine options', () => {
  assert.deepEqual(
    parseBootstrapArgs(['--config', '/tmp/config.json', '--app', 'two-agent', '--app', 'one-agent', '--with-gh-shim']),
    {
      apps: ['two-agent', 'one-agent'],
      configPath: '/tmp/config.json',
      help: false,
      phase: 'all',
      withGhShim: true,
    },
  );
  assert.equal(parseBootstrapArgs(['--machine-only']).phase, 'machine');
  assert.equal(parseBootstrapArgs(['--worktree-only']).phase, 'worktree');
  assert.throws(
    () => parseBootstrapArgs(['--machine-only', '--worktree-only']),
    /conflicts/,
  );
  assert.throws(
    () => parseBootstrapArgs(['--worktree-only', '--with-gh-shim']),
    /does not accept machine setup options/,
  );
  assert.throws(() => parseBootstrapArgs(['--config']), /requires a value/);
  assert.throws(() => parseBootstrapArgs(['--unknown']), /unknown option/);
});

test('doctor exposes a machine-only verification phase', () => {
  assert.deepEqual(parseDoctorArgs([]), { apps: [], machineOnly: false });
  assert.deepEqual(parseDoctorArgs(['--machine-only']), { apps: [], machineOnly: true });
  assert.deepEqual(parseDoctorArgs(['--app', 'explicit-agent']), {
    apps: ['explicit-agent'],
    machineOnly: false,
  });
  assert.throws(() => parseDoctorArgs(['--repair']), /usage/);
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
      'org-vscode-agent',
      'z-agent',
    ],
  );
});

test('full bootstrap follows config, install, credentials, shim, worktree, doctor order', () => {
  const calls = [];
  const output = { write: (value) => calls.push(['output', value.trim()]) };
  const result = bootstrap(
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
      ensureCredential: ({ slug }) => {
        calls.push(['credential', slug]);
        return { path: `/home/test/.config/${slug}/private-key.pem` };
      },
      installShim: () => {
        calls.push(['shim']);
        return { shimPath: '/home/test/.config/agent-bot/bin/gh' };
      },
      run: (executable, args) => calls.push(['run', executable, ...args]),
      output,
    },
  );

  assert.equal(result.phase, 'all');
  assert.deepEqual(
    calls.filter(([kind]) => kind !== 'output'),
    [
      ['config', '/profile.json'],
      ['install'],
      ['credential', 'claude-agent'],
      ['credential', 'codex-agent'],
      ['credential', 'explicit-agent'],
      ['shim'],
      ['run', '/home/test/.local/bin/agent-bot', 'setup-worktree'],
      ['run', '/home/test/.local/bin/agent-bot', 'doctor', '--app', 'explicit-agent'],
    ],
  );
});

test('machine-only and worktree-only phases do not cross their mutation boundary', () => {
  const machineCalls = [];
  bootstrap(parseBootstrapArgs(['--machine-only']), {
    home: '/home/test',
    installConfig: () => ({ config: {}, path: '/config', updated: false }),
    installRuntime: () => ({ executable: '/installed/agent-bot' }),
    run: (_executable, args) => machineCalls.push(args),
    output: { write: () => {} },
  });
  assert.deepEqual(machineCalls, [['doctor', '--machine-only']]);

  const worktreeCalls = [];
  bootstrap(parseBootstrapArgs(['--worktree-only']), {
    home: '/home/test',
    verifyInstalled: () => {},
    installConfig: () => assert.fail('worktree phase installed config'),
    installRuntime: () => assert.fail('worktree phase installed runtime'),
    run: (_executable, args) => worktreeCalls.push(args),
    output: { write: () => {} },
  });
  assert.deepEqual(worktreeCalls, [['setup-worktree'], ['doctor']]);
});

test('worktree-only fails before setup when the runtime is absent', () => {
  assert.throws(
    () => bootstrap(parseBootstrapArgs(['--worktree-only']), {
      home: '/home/test',
      verifyInstalled: () => {
        throw new Error('agent-bot is not installed from this checkout');
      },
      output: { write: () => {} },
    }),
    /not installed/,
  );
});

test('bootstrap refuses to call an incomplete credential ready', () => {
  assert.throws(
    () => bootstrap(parseBootstrapArgs(['--machine-only', '--app', 'missing-id-agent']), {
      home: '/home/test',
      installConfig: () => ({ config: {}, path: '/config', updated: false }),
      installRuntime: () => ({ executable: '/installed/agent-bot' }),
      ensureCredential: () => ({ issuerMissing: true }),
      run: () => assert.fail('doctor ran after an incomplete credential'),
      output: { write: () => {} },
    }),
    /credential incomplete for missing-id-agent/,
  );
});
