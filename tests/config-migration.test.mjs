import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isGateEnabled, loadConfig } from '../config.mjs';
import { migratePreGateConfig, preGateConfigStatus } from '../config-migration.mjs';

const PRE_GATE = { apps: { claude: 'acme-claude-agent' }, owner: 'acme' };

function fixture({ config, identities = [], mode = 0o600 } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'agent-bot-pregate-'));
  const env = { XDG_STATE_HOME: join(home, '.local', 'state') };
  const dir = join(home, '.config', 'agent-bot');
  mkdirSync(dir, { recursive: true });
  const path = join(dir, 'config.json');
  if (config !== undefined) writeFileSync(path, JSON.stringify(config), { mode });
  const ids = join(home, '.local', 'state', 'agent-bot', 'agent-identities');
  mkdirSync(ids, { recursive: true });
  identities.forEach((record, i) => writeFileSync(join(ids, `agent_${i}.json`), JSON.stringify(record)));
  return { home, env, path, dir };
}

const appIdentity = { id: 'agent_0', github: { appSlug: 'acme-claude-agent', credentialProvider: 'worktree-token' } };

test('a pre-gate config whose souls use GitHub Apps keeps both add-ons on', () => {
  const { home, env, path, dir } = fixture({ config: PRE_GATE, identities: [{ id: 'agent_x', github: null }, appIdentity] });
  assert.equal(isGateEnabled('github-identity', { home, env }), false);
  assert.equal(preGateConfigStatus({ home, env }).needed, true);

  const result = migratePreGateConfig({ home, env });
  assert.equal(result.migrated, true);
  const config = loadConfig({ home, env });
  assert.equal(isGateEnabled('github-identity', { config }), true);
  assert.equal(isGateEnabled('persona-accounts', { config }), true);
  assert.deepEqual({ ...config, features: undefined }, { ...PRE_GATE, features: undefined }, 'everything else is kept');
  assert.equal(statSync(path).mode & 0o777, 0o600, 'the file mode is kept');
  assert.deepEqual(readdirSync(dir), ['config.json'], 'no temporary file is left behind');

  assert.deepEqual(migratePreGateConfig({ home, env }), { migrated: false, reason: 'has-features', path }, 'it runs once');
});

test('any features object is a choice and is never touched, even an empty one', () => {
  for (const features of [{}, { 'github-identity': false }]) {
    const { home, env, path } = fixture({ config: { ...PRE_GATE, features }, identities: [appIdentity] });
    const before = readFileSync(path, 'utf8');
    assert.equal(migratePreGateConfig({ home, env }).reason, 'has-features');
    assert.equal(readFileSync(path, 'utf8'), before);
  }
});

test('an install whose souls carry no GitHub App stays at the defaults', () => {
  const { home, env, path } = fixture({ config: PRE_GATE, identities: [{ id: 'agent_0', github: null }, { id: 'agent_1' }] });
  const before = readFileSync(path, 'utf8');
  assert.equal(migratePreGateConfig({ home, env }).reason, 'no-app-identities');
  assert.equal(readFileSync(path, 'utf8'), before);
});

test('no config, an invalid config and unreadable records change nothing', () => {
  const absent = fixture({ identities: [appIdentity] });
  assert.equal(migratePreGateConfig(absent).reason, 'no-config');

  const broken = fixture({ identities: [appIdentity] });
  writeFileSync(broken.path, '{ not json');
  assert.equal(migratePreGateConfig(broken).reason, 'invalid-config');
  assert.equal(readFileSync(broken.path, 'utf8'), '{ not json');

  const junk = fixture({ config: PRE_GATE });
  writeFileSync(join(junk.home, '.local', 'state', 'agent-bot', 'agent-identities', 'agent_bad.json'), 'nope');
  assert.equal(migratePreGateConfig(junk).reason, 'no-app-identities');
});

test('AGENT_BOT_CONFIG names the file that is checked and written', () => {
  const { home, env, dir } = fixture({ identities: [appIdentity] });
  const custom = join(dir, 'custom.json');
  writeFileSync(custom, JSON.stringify(PRE_GATE), { mode: 0o640 });
  const result = migratePreGateConfig({ home, env: { ...env, AGENT_BOT_CONFIG: custom } });
  assert.equal(result.migrated, true);
  assert.equal(result.path, custom);
  assert.equal(statSync(custom).mode & 0o777, 0o640);
  assert.equal(JSON.parse(readFileSync(custom, 'utf8')).features['github-identity'], true);
});
