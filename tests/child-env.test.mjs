import test from 'node:test';
import assert from 'node:assert/strict';

import { minimalChildEnv } from '../child-env.mjs';
import { soulEnvironment } from '../shell-path.mjs';
import { composeTurnEnv } from '../turn-env.mjs';

test('child boundary drops ambient secrets and execution injection variables', () => {
  const source = {
    PATH: '/usr/bin', HOME: '/tmp/owner', LANG: 'en_US.UTF-8',
    AWS_SECRET_ACCESS_KEY: 'owner-secret',
    GITHUB_TOKEN: 'owner-token',
    OPENAI_API_KEY: 'owner-provider-key',
    SSH_AUTH_SOCK: '/tmp/agent.sock',
    NODE_OPTIONS: '--require /tmp/injected.js',
    NPM_CONFIG_USERCONFIG: '/tmp/owner/.npmrc',
  };
  assert.deepEqual(minimalChildEnv(source), {
    PATH: '/usr/bin', HOME: '/tmp/owner', LANG: 'en_US.UTF-8',
  });
  const harness = soulEnvironment(source, { home: '/tmp/owner' });
  for (const name of ['AWS_SECRET_ACCESS_KEY', 'GITHUB_TOKEN', 'OPENAI_API_KEY',
    'SSH_AUTH_SOCK', 'NODE_OPTIONS', 'NPM_CONFIG_USERCONFIG']) {
    assert.equal(Object.hasOwn(harness, name), false, name);
  }
});

test('turn inherits only safe base fields and explicitly routed soul secret', () => {
  const turn = composeTurnEnv({
    agentId: 'test-soul', harness: 'codex',
    baseEnv: { PATH: '/usr/bin', AWS_SECRET_ACCESS_KEY: 'host', OPENAI_API_KEY: 'host' },
    env: { GITHUB_TOKEN: 'owner', NODE_OPTIONS: '--require evil', LANG: 'C' },
    runtimeEnvFor: () => ({ UV_CACHE_DIR: '/tmp/soul-cache' }),
    providerEnvFor: () => ({ envKey: 'OPENAI_API_KEY', env: { OPENAI_API_KEY: 'soul-only' } }),
  });
  assert.equal(turn.turnEnv.PATH, '/usr/bin');
  assert.equal(turn.turnEnv.LANG, 'C');
  assert.equal(turn.turnEnv.UV_CACHE_DIR, '/tmp/soul-cache');
  assert.equal(turn.turnEnv.AWS_SECRET_ACCESS_KEY, undefined);
  assert.equal(turn.turnEnv.GITHUB_TOKEN, undefined);
  assert.equal(turn.turnEnv.NODE_OPTIONS, undefined);
  assert.equal(turn.harnessEnv.OPENAI_API_KEY, 'soul-only');
  assert.equal(turn.mcpEnv.OPENAI_API_KEY, undefined);
});
