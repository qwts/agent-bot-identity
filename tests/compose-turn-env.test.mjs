// The launch's sign-in probe and the harness turn read one environment
// (#536): runtimes, the routed tool home and the provider env together.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { composeTurnEnv } from '../wake-plane.mjs';

test('composeTurnEnv layers runtimes, routed tool home and provider env as the turn does', () => {
  const result = composeTurnEnv({
    agentId: 'agent_x', harness: 'opencode', baseEnv: { PATH: '/usr/bin', HOME: '/Users/o' }, env: { AGENT_BOT_BINDING: '/b' },
    runtimeEnvFor: () => ({ PATH: '/soul/bin:/usr/bin' }),
    toolHomeEnvFor: () => ({ XDG_DATA_HOME: '/soul/tools/opencode/data', HOME: '/never', CODEX_HOME: 42 }),
    providerEnvFor: () => ({ env: { OPENAI_API_KEY: 'secret' }, envKey: 'OPENAI_API_KEY' }),
  });
  assert.equal(result.harnessEnv.PATH, '/soul/bin:/usr/bin');
  assert.equal(result.harnessEnv.XDG_DATA_HOME, '/soul/tools/opencode/data');
  assert.equal(result.harnessEnv.HOME, '/Users/o', 'HOME is never routed');
  assert.equal(result.harnessEnv.OPENAI_API_KEY, 'secret', 'an env-var provider counts for the probe as for the harness');
  assert.equal(result.mcpEnv.OPENAI_API_KEY, undefined, 'the secret stays out of the reach server env');
  assert.deepEqual(result.routed, ['XDG_DATA_HOME']);
  assert.deepEqual(result.stripped, ['OPENAI_API_KEY']);
  assert.equal(result.turnEnv.AGENT_BOT_ID, 'agent_x');
});

test('without ports the turn env is the base env plus the soul identity, unrouted', () => {
  const { harnessEnv, routed } = composeTurnEnv({ agentId: 'agent_y', harness: 'claude', baseEnv: { PATH: '/usr/bin' } });
  assert.deepEqual(harnessEnv, { PATH: '/usr/bin', QWTS_AGENT_ID: 'agent_y', AGENT_BOT_ID: 'agent_y' });
  assert.deepEqual(routed, []);
});
