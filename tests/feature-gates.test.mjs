import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gateStatus, isGateEnabled, loadConfig } from '../config.mjs';

test('feature gates default off and only explicit config true enables them', () => {
  const home = mkdtempSync(join(tmpdir(), 'agent-bot-gates-'));
  assert.equal(isGateEnabled('github-identity', { home, env: { GITHUB_IDENTITY: '1' } }), false);
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
