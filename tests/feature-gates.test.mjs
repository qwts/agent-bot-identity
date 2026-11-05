import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  applyEnabledFeatures,
  enabledFeaturesFromEnv,
  gateStatus,
  isGateEnabled,
  loadConfig,
  parseFeatureList,
  writeEnabledFeaturesToConfig,
} from '../config.mjs';

test('feature gates default off and only explicit config true enables them', () => {
  const home = mkdtempSync(join(tmpdir(), 'agent-bot-gates-'));
  assert.equal(isGateEnabled('github-identity', { home, env: {} }), false);
  assert.equal(isGateEnabled('persona-accounts', { home }), false);
  const path = join(home, '.config', 'agent-bot', 'config.json');
  mkdirSync(join(home, '.config', 'agent-bot'), { recursive: true });
  writeFileSync(path, JSON.stringify({ features: { 'github-identity': true } }));
  const config = loadConfig({ home });
  assert.equal(isGateEnabled('github-identity', { config }), true);
  assert.equal(isGateEnabled('persona-accounts', { config }), false);
  assert.deepEqual(gateStatus(config), {
    'github-identity': { enabled: true, source: 'user-config' },
    'persona-accounts': { enabled: false, source: 'default' },
  });
  assert.throws(() => isGateEnabled('unknown'), /unknown feature gate/);
});

test('malformed feature gates fail closed from a config file and from an injected config', () => {
  const home = mkdtempSync(join(tmpdir(), 'agent-bot-gates-'));
  const dir = join(home, '.config', 'agent-bot');
  mkdirSync(dir, { recursive: true });
  const path = join(dir, 'config.json');
  writeFileSync(path, JSON.stringify({ features: { 'unknown-addon': true } }));
  assert.throws(() => loadConfig({ home, env: {} }), /unknown feature gate: unknown-addon/);
  writeFileSync(path, JSON.stringify({ features: { 'github-identity': 'yes' } }));
  assert.throws(() => loadConfig({ home, env: {} }), /invalid features\.github-identity/);
  assert.throws(() => isGateEnabled('github-identity', { config: { features: { 'github-identity': 'yes' } } }), /invalid features\.github-identity/);
  assert.throws(() => isGateEnabled('github-identity', { config: { features: [] } }), /features must be an object/);
});

test('parseFeatureList, enabledFeaturesFromEnv, and writeEnabledFeaturesToConfig enable feature gates headlessly (#1350)', () => {
  assert.deepEqual(parseFeatureList(''), []);
  assert.deepEqual(parseFeatureList(null), []);
  assert.deepEqual(parseFeatureList('github-identity, persona-accounts,github-identity'), [
    'github-identity',
    'persona-accounts',
  ]);
  assert.deepEqual(parseFeatureList(['github-identity', 'persona-accounts,github-identity']), [
    'github-identity',
    'persona-accounts',
  ]);
  assert.throws(() => parseFeatureList('unknown-addon'), /unknown feature gate: unknown-addon/);
  assert.deepEqual(enabledFeaturesFromEnv({ AGENT_BOT_ENABLE_FEATURES: 'github-identity' }), ['github-identity']);

  const home = mkdtempSync(join(tmpdir(), 'agent-bot-gates-write-'));
  const first = writeEnabledFeaturesToConfig({ features: ['github-identity'], home, env: {} });
  assert.equal(first.updated, true);
  assert.equal(isGateEnabled('github-identity', { home, env: {} }), true);
  if (process.platform !== 'win32') {
    assert.equal(statSync(first.path).mode & 0o777, 0o600);
    assert.equal(statSync(join(home, '.config', 'agent-bot')).mode & 0o777, 0o700);
  }
  const second = writeEnabledFeaturesToConfig({ features: ['github-identity'], home, env: {} });
  assert.equal(second.updated, false);

  // Existing keys in config.json are preserved when adding a second feature gate.
  writeFileSync(first.path, JSON.stringify({ owner: 'qwts', features: { 'github-identity': true } }, null, 2));
  const third = writeEnabledFeaturesToConfig({ features: ['persona-accounts'], home, env: {} });
  assert.equal(third.updated, true);
  const parsed = JSON.parse(readFileSync(first.path, 'utf8'));
  assert.equal(parsed.owner, 'qwts');
  assert.deepEqual(parsed.features, {
    'github-identity': true,
    'persona-accounts': true,
  });
  assert.deepEqual(applyEnabledFeatures({ owner: 'qwts' }, ['github-identity']), {
    owner: 'qwts',
    features: { 'github-identity': true },
  });

  // Rejects symlinked or non-regular config.json and cleans up temp file on rename failure.
  const linkedHome = mkdtempSync(join(tmpdir(), 'agent-bot-gates-link-'));
  const linkedDir = join(linkedHome, '.config', 'agent-bot');
  mkdirSync(linkedDir, { recursive: true });
  const target = join(linkedHome, 'target.json');
  writeFileSync(target, '{}');
  symlinkSync(target, join(linkedDir, 'config.json'));
  assert.throws(
    () => writeEnabledFeaturesToConfig({ features: ['github-identity'], home: linkedHome, env: {} }),
    /not a regular agent-bot config file/,
  );

  const dirConfigHome = mkdtempSync(join(tmpdir(), 'agent-bot-gates-dir-'));
  mkdirSync(join(dirConfigHome, '.config', 'agent-bot', 'config.json'), { recursive: true });
  assert.throws(
    () => writeEnabledFeaturesToConfig({ features: ['github-identity'], home: dirConfigHome, env: {} }),
    /exists but could not be read|not a regular agent-bot config file/,
  );

  const renameFailHome = mkdtempSync(join(tmpdir(), 'agent-bot-gates-rename-'));
  assert.throws(
    () => writeEnabledFeaturesToConfig({
      features: ['github-identity'],
      home: renameFailHome,
      env: {},
      rename: () => { throw new Error('simulated rename failure'); },
    }),
    /simulated rename failure/,
  );
  assert.deepEqual(readdirSync(join(renameFailHome, '.config', 'agent-bot')), []);
});
