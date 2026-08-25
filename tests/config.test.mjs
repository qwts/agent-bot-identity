import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  apiBase,
  daemonPreference,
  githubHost,
  harnessForSlug,
  loadConfig,
  slugForHarness,
  spacesRootSetting,
} from '../config.mjs';
import { organizationProfileToConfig } from '../organization-profile.mjs';

function tempHome(name = 'agent-bot-config-') {
  return mkdtempSync(join(tmpdir(), name));
}

function writeConfig(home, value) {
  const dir = join(home, '.config', 'agent-bot');
  mkdirSync(dir, { recursive: true });
  const path = join(dir, 'config.json');
  writeFileSync(path, typeof value === 'string' ? value : `${JSON.stringify(value)}\n`);
  return path;
}

test('missing config returns an empty object', () => {
  const home = tempHome();
  assert.deepEqual(loadConfig({ home, env: {} }), {});
});

test('broken JSON fails loudly with the config path', () => {
  const home = tempHome();
  const path = writeConfig(home, '{not json');
  assert.throws(
    () => loadConfig({ home, env: {} }),
    (err) => {
      assert.match(err.message, /exists but is not valid JSON/);
      assert.match(err.message, new RegExp(path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
      return true;
    },
  );
});

test('present config read failures are not treated as missing', () => {
  const home = tempHome();
  const path = writeConfig(home, { prefix: 'you' });
  assert.throws(
    () => loadConfig({ home, env: { AGENT_BOT_CONFIG: `${path}/child` } }),
    /exists but could not be read/,
  );
});

test('dangling config symlinks fail closed instead of looking absent', () => {
  const home = tempHome();
  const dir = join(home, '.config', 'agent-bot');
  const path = join(dir, 'config.json');
  mkdirSync(dir, { recursive: true });
  symlinkSync(join(home, 'missing-config.json'), path);

  assert.throws(
    () => loadConfig({ home, env: {} }),
    /exists but could not be read/,
  );
});

test('AGENT_BOT_CONFIG points loadConfig at an explicit file', () => {
  const home = tempHome();
  const path = join(home, 'alt.json');
  writeFileSync(path, JSON.stringify({ prefix: 'alt' }));
  assert.deepEqual(loadConfig({ home, env: { AGENT_BOT_CONFIG: path } }), { prefix: 'alt' });
});

test('space root setting accepts only a non-empty absolute path', () => {
  assert.equal(spacesRootSetting({}), null);
  assert.equal(
    spacesRootSetting({ settings: { spacesRoot: '/srv/agent-spaces' } }),
    '/srv/agent-spaces',
  );
  for (const spacesRoot of ['', 'relative/spaces', 42, '/tmp/invalid\0root']) {
    assert.throws(
      () => spacesRootSetting({ settings: { spacesRoot } }),
      /expected a non-empty absolute path/,
    );
  }
  for (const settings of [null, [], 'invalid']) {
    assert.throws(() => spacesRootSetting({ settings }), /settings must be an object/);
  }
});

test('daemon preference follows environment, user setting, then off default', () => {
  assert.equal(daemonPreference({ env: {}, config: {} }), 'off');
  assert.equal(
    daemonPreference({ env: {}, config: { settings: { daemonPreference: 'prefer' } } }),
    'prefer',
  );
  assert.equal(
    daemonPreference({
      env: { AGENT_BOT_DAEMON_PREFERENCE: 'required' },
      config: { settings: { daemonPreference: 'invalid-lower-precedence-value' } },
    }),
    'required',
  );
  assert.equal(
    daemonPreference({
      env: { AGENT_BOT_DAEMON_PREFERENCE: '' },
      config: { settings: { daemonPreference: 'prefer' } },
    }),
    'prefer',
  );
});

test('loadConfig validates settings while allowing settings-only identity inertia', () => {
  const home = tempHome();
  writeConfig(home, { settings: { spacesRoot: '/srv/spaces', daemonPreference: 'prefer' } });
  const config = loadConfig({ home, env: {} });
  assert.equal(slugForHarness('codex', config), null);
  assert.equal(spacesRootSetting(config), '/srv/spaces');
  assert.equal(daemonPreference({ env: {}, config }), 'prefer');

  writeConfig(home, { settings: { daemonPreference: 'sometimes' } });
  assert.throws(() => loadConfig({ home, env: {} }), /expected off, prefer, or required/);
});

test('invalid daemon preferences fail closed without reflecting the value', () => {
  const invalid = 'must-not-print-invalid-daemon-policy';
  for (const options of [
    { env: { AGENT_BOT_DAEMON_PREFERENCE: invalid }, config: {} },
    { env: {}, config: { settings: { daemonPreference: invalid } } },
  ]) {
    assert.throws(
      () => daemonPreference(options),
      (error) => {
        assert.match(error.message, /expected off, prefer, or required/);
        assert.doesNotMatch(error.message, new RegExp(invalid));
        return true;
      },
    );
  }
});

test('prefix pattern builds <prefix>-<harness>-agent slugs', () => {
  const config = { prefix: 'you' };
  assert.equal(slugForHarness('claude', config), 'you-claude-agent');
  assert.equal(slugForHarness('codex', config), 'you-codex-agent');
  assert.equal(slugForHarness(null, config), null);
  assert.equal(slugForHarness('claude', {}), null);
});

test('apps overrides beat the prefix pattern', () => {
  const config = { prefix: 'you', apps: { claude: 'custom-claude-bot' } };
  assert.equal(slugForHarness('claude', config), 'custom-claude-bot');
  assert.equal(slugForHarness('codex', config), 'you-codex-agent');
});

test('installed organization profile exposes active model mappings and rejects inconsistent metadata', () => {
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
      {
        slug: 'example-retired-agent',
        harness: 'codex',
        status: 'retired',
        models: ['legacy'],
      },
    ],
  });
  assert.equal(harnessForSlug('example-codex-sol-agent', config), 'codex');
  assert.equal(harnessForSlug('example-retired-agent', config), null);

  const home = tempHome();
  writeConfig(home, config);
  assert.deepEqual(loadConfig({ home, env: {} }), config);
  config.profile.accountOwner = 'different-owner';
  writeConfig(home, config);
  assert.throws(() => loadConfig({ home, env: {} }), /owner is inconsistent/);
});

test('harnessForSlug reverse-looks up apps and prefix shapes', () => {
  const config = {
    prefix: 'you',
    apps: { cursor: 'team-cursor-bot' },
  };
  assert.equal(harnessForSlug('team-cursor-bot', config), 'cursor');
  assert.equal(harnessForSlug('you-claude-agent', config), 'claude-code');
  assert.equal(harnessForSlug('you-codex-agent', config), 'codex');
  assert.equal(harnessForSlug('you-claude-fable-agent', config), 'claude-code');
  assert.equal(harnessForSlug('other-claude-opus-agent', {}), 'claude-code');
  assert.equal(harnessForSlug('mystery-bot', {}), null);
  assert.equal(harnessForSlug(null, config), null);
});

// SLUG_HARNESSES is kept in step with detect-harness.mjs by a test rather than
// by an import, since detect-harness imports this module. That claim is only
// true if every key is actually exercised here.
test('harnessForSlug covers every harness key, including the new Apps', () => {
  const config = { prefix: 'you' };
  const expected = {
    'you-claude-agent': 'claude-code',
    'you-codex-agent': 'codex',
    'you-cursor-agent': 'cursor',
    'you-copilot-agent': 'copilot',
    'you-devin-agent': 'devin',
    'you-meta-agent': 'meta',
    'you-vscode-agent': 'vscode',
  };
  for (const [slug, harness] of Object.entries(expected)) {
    assert.equal(harnessForSlug(slug, config), harness, `${slug} did not map to ${harness}`);
  }
  // Model-pinned variants resolve to the same harness.
  assert.equal(harnessForSlug('you-cursor-kimi-agent', config), 'cursor');
  assert.equal(harnessForSlug('you-copilot-x-agent', config), 'copilot');
  assert.equal(harnessForSlug('you-meta-spark-agent', config), 'meta');
  // And the unconfigured best-effort path knows them too.
  assert.equal(harnessForSlug('other-copilot-agent', {}), 'copilot');
  assert.equal(harnessForSlug('other-devin-agent', {}), 'devin');
  // Meta Muse's real App slug carries the product name, not the harness key,
  // so it resolves through the apps map and NOT through slug parsing.
  assert.equal(harnessForSlug('qwts-muse-agent', { apps: { meta: 'qwts-muse-agent' } }), 'meta');
  assert.equal(harnessForSlug('qwts-muse-agent', {}), null);
});

test('every detect-harness key is recognized by harnessForSlug', async () => {
  const { HARNESSES } = await import('../detect-harness.mjs');
  const config = { prefix: 'you' };
  for (const { key } of HARNESSES) {
    const harness = harnessForSlug(`you-${key}-agent`, config);
    const expected = key === 'claude' ? 'claude-code' : key;
    assert.equal(harness, expected, `detect-harness knows "${key}" but config.mjs does not`);
  }
});

test('apiBase and githubHost honor config and defaults', () => {
  assert.equal(apiBase({}), 'https://api.github.com');
  assert.equal(githubHost({}), 'github.com');
  assert.equal(apiBase({ apiBase: 'https://github.example.com/api/v3/' }), 'https://github.example.com/api/v3');
  assert.equal(githubHost({ apiBase: 'https://api.github.com' }), 'github.com');
  assert.equal(githubHost({ apiBase: 'https://github.example.com/api/v3' }), 'github.example.com');
});
