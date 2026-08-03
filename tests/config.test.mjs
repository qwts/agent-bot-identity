import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  apiBase,
  githubHost,
  harnessForSlug,
  loadConfig,
  slugForHarness,
} from '../config.mjs';

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

test('AGENT_BOT_CONFIG points loadConfig at an explicit file', () => {
  const home = tempHome();
  const path = join(home, 'alt.json');
  writeFileSync(path, JSON.stringify({ prefix: 'alt' }));
  assert.deepEqual(loadConfig({ home, env: { AGENT_BOT_CONFIG: path } }), { prefix: 'alt' });
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
    'you-vscode-agent': 'vscode',
  };
  for (const [slug, harness] of Object.entries(expected)) {
    assert.equal(harnessForSlug(slug, config), harness, `${slug} did not map to ${harness}`);
  }
  // Model-pinned variants resolve to the same harness.
  assert.equal(harnessForSlug('you-cursor-kimi-agent', config), 'cursor');
  assert.equal(harnessForSlug('you-copilot-x-agent', config), 'copilot');
  // And the unconfigured best-effort path knows them too.
  assert.equal(harnessForSlug('other-copilot-agent', {}), 'copilot');
  assert.equal(harnessForSlug('other-devin-agent', {}), 'devin');
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
