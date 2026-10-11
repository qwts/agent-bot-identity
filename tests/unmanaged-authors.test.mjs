// One resolver for the unmanaged-author allowlist (#675): the committed git
// hooks, doctor and the organization profile agree on where it comes from.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as configModule from '../config.mjs';
import { unmanagedAuthors } from '../config.mjs';
import { organizationProfileToConfig, validateOrganizationProfile, ORGANIZATION_PROFILE_SCHEMA_VERSION } from '../organization-profile.mjs';
import { UNINSTALLED_REASON, unmanagedAuthorList, uninstalledDecision } from '../uninstalled-identity-hook.mjs';

const HOOKS = fileURLToPath(new URL('../hooks/', import.meta.url));

const configured = { settings: { unmanagedAuthors: ['alice', 'bob@example.com'] } };
const malformed = { settings: { unmanagedAuthors: ['Alice,Bob'] } };

test('env wins when set, even empty; then config; then none', () => {
  assert.deepEqual(unmanagedAuthors({ env: { AGENT_BOT_UNMANAGED_AUTHORS: 'Zed, y' }, config: configured }), { authors: ['zed', 'y'], source: 'env' });
  assert.deepEqual(unmanagedAuthors({ env: { AGENT_BOT_UNMANAGED_AUTHORS: '' }, config: configured }), { authors: [], source: 'env' });
  assert.deepEqual(unmanagedAuthors({ env: {}, config: configured }), { authors: ['alice', 'bob@example.com'], source: 'config' });
  assert.deepEqual(unmanagedAuthors({ env: {}, config: {} }), { authors: [], source: 'none' });
  assert.throws(() => unmanagedAuthors({ env: {}, config: malformed }), /invalid settings\.unmanagedAuthors/);
  assert.throws(() => unmanagedAuthors({ env: {}, config: { settings: { unmanagedAuthors: 'alice' } } }), /invalid settings\.unmanagedAuthors/);
});

test('a set env decides without reading the config, so a malformed config cannot override it', () => {
  const dir = mkdtempSync(join(tmpdir(), 'unmanaged-env-'));
  const bad = join(dir, 'bad.json');
  writeFileSync(bad, JSON.stringify(malformed));
  assert.deepEqual(unmanagedAuthors({ env: { AGENT_BOT_CONFIG: bad, AGENT_BOT_UNMANAGED_AUTHORS: 'zed' } }), { authors: ['zed'], source: 'env' });
  assert.deepEqual(unmanagedAuthors({ env: { AGENT_BOT_CONFIG: bad, AGENT_BOT_UNMANAGED_AUTHORS: '' } }), { authors: [], source: 'env' });
  assert.throws(() => unmanagedAuthors({ env: { AGENT_BOT_CONFIG: bad } }), /invalid settings\.unmanagedAuthors/);
});

test('nothing selected is no allowlist: there is no compiled default (#675)', () => {
  assert.deepEqual(unmanagedAuthors({ env: {}, config: {} }), { authors: [], source: 'none' });
  assert.equal('unmanagedAuthorsWithLegacyDefault' in configModule, false);
  assert.equal('LEGACY_UNMANAGED_AUTHORS' in configModule, false);
});

test('the identity hook library is unchanged: nothing set still refuses a human commit', () => {
  const env = { GIT_AUTHOR_NAME: 'ai9d', GIT_AUTHOR_EMAIL: 'ai9d@example.com' };
  assert.deepEqual(uninstalledDecision({ event: 'pre-commit', env }), { decision: 'deny', reason: UNINSTALLED_REASON });
  assert.equal(uninstalledDecision({ event: 'pre-commit', env: { ...env, AGENT_BOT_UNMANAGED_AUTHORS: 'ai9d' } }).decision, 'allow');
});

test('the organization profile projects unmanaged_authors into config and refuses malformed lists', () => {
  const profile = (settings) => ({
    schema_version: ORGANIZATION_PROFILE_SCHEMA_VERSION,
    organization: 'example-engineering',
    account_owner: 'example-owner',
    minimum_runtime_interface_version: 1,
    defaults: { claude: 'example-claude-agent' },
    identities: [{ slug: 'example-claude-agent', harness: 'claude', status: 'active' }],
    settings,
  });
  const config = organizationProfileToConfig(validateOrganizationProfile(profile({ unmanaged_authors: ['alice'] })));
  assert.deepEqual(config.settings.unmanagedAuthors, ['alice']);
  assert.deepEqual(unmanagedAuthors({ env: {}, config }), { authors: ['alice'], source: 'config' });
  for (const bad of [['Alice'], ['a,b'], ['a b'], 'alice', ['alice', 'alice'], [7]]) {
    assert.throws(() => validateOrganizationProfile(profile({ unmanaged_authors: bad })), /unmanaged_authors/);
  }
});

// The committed hooks source hooks/agent-context; $0 is the hook, so the
// helper finds config.mjs beside the hooks directory as it does in a checkout.
function shellAuthors(env) {
  const script = `. "${join(HOOKS, 'agent-context')}"; agent_bot_unmanaged_authors`;
  return execFileSync('/bin/sh', ['-c', script, join(HOOKS, 'pre-commit')], { env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

test('the git hooks resolve the same list doctor reports', () => {
  const dir = mkdtempSync(join(tmpdir(), 'unmanaged-'));
  const write = (name, value) => { const file = join(dir, name); writeFileSync(file, JSON.stringify(value)); return file; };
  const good = write('good.json', configured);
  const bad = write('bad.json', malformed);
  const base = { PATH: process.env.PATH, HOME: dir };
  assert.equal(shellAuthors({ ...base, AGENT_BOT_CONFIG: good, AGENT_BOT_UNMANAGED_AUTHORS: 'zed' }), 'zed');
  assert.equal(shellAuthors({ ...base, AGENT_BOT_CONFIG: good, AGENT_BOT_UNMANAGED_AUTHORS: '' }), '');
  assert.equal(shellAuthors({ ...base, AGENT_BOT_CONFIG: good }), 'alice,bob@example.com');
  // Nothing selected: no compiled default, so the hook refuses (#675).
  assert.equal(shellAuthors({ ...base, AGENT_BOT_CONFIG: join(dir, 'absent.json') }), '');
  // A config the resolver rejects yields nothing: the hook refuses.
  assert.equal(shellAuthors({ ...base, AGENT_BOT_CONFIG: bad }), '');
});

test('without Node the git hooks resolve nothing and refuse (#675)', { skip: ['/usr/bin/node', '/bin/node'].some(existsSync) && 'node is on the minimal PATH' }, () => {
  assert.equal(shellAuthors({ PATH: '/usr/bin:/bin', HOME: tmpdir(), AGENT_BOT_CONFIG: '/nonexistent' }), '');
});

// Configs the shared resolver refuses while their allowlist alone is valid:
// the fallback must refuse them too, not grant the list (#675 review).
const REFUSED_WITH_VALID_LIST = {
  'invalid feature value': { ...configured, features: { 'github-identity': 'false' } },
  'unknown feature gate': { ...configured, features: { teleport: true } },
  'invalid daemonPreference': { settings: { ...configured.settings, daemonPreference: 'invalid' } },
  'relative soulsRoot': { settings: { ...configured.settings, soulsRoot: 'relative/souls' } },
  'invalid owner': { ...configured, owner: '' },
  'invalid scope': { ...configured, scope: { apps: [] } },
  'invalid profile': { ...configured, profile: 'not-a-profile' },
};

test('the generated fallback grants exactly what the shared resolver grants for the snapshotted bytes (#675)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'unmanaged-parity-'));
  const write = (name, value) => { const file = join(dir, name); writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value)); return file; };
  const refused = Object.entries(REFUSED_WITH_VALID_LIST).map(([name, value]) => [name, write(`${name.replaceAll(' ', '-')}.json`, value)]);
  for (const [name, file] of refused) {
    assert.throws(() => unmanagedAuthors({ env: { AGENT_BOT_CONFIG: file } }), undefined, `${name} must be one the shared resolver refuses`);
  }
  const files = [
    ['good', write('good.json', configured)], ['bad list', write('bad.json', malformed)], ['empty', write('empty.json', {})],
    ['duplicate', write('dup.json', { settings: { unmanagedAuthors: ['a', 'a'] } })], ['bom', write('bom.json', `\uFEFF${JSON.stringify(configured)}`)],
    ['non-object settings', write('settings.json', { settings: ['alice'] })], ['bad JSON', write('broken.json', '{ "settings": ')],
    ['absent', join(dir, 'absent.json')], ...refused,
  ];
  for (const [name, file] of files) {
    const snapshot = configModule.unmanagedAuthorsSnapshot({ env: { AGENT_BOT_CONFIG: file } });
    for (const extra of [{}, { AGENT_BOT_UNMANAGED_AUTHORS: '' }, { AGENT_BOT_UNMANAGED_AUTHORS: 'Zed, y' }]) {
      const env = { AGENT_BOT_CONFIG: file, ...extra };
      let shared;
      try { shared = unmanagedAuthors({ env }).authors; } catch { shared = []; } // a throw makes the hooks refuse
      assert.deepEqual(unmanagedAuthorList(env, snapshot), shared, `${name} ${JSON.stringify(extra)}`);
    }
  }
  assert.deepEqual(configModule.unmanagedAuthorsSnapshot({ env: { AGENT_BOT_CONFIG: files[0][1] } }).authors, ['alice', 'bob@example.com']);
  // HOME locates the default config exactly as loadConfig does.
  const home = mkdtempSync(join(tmpdir(), 'unmanaged-home-'));
  mkdirSync(join(home, '.config', 'agent-bot'), { recursive: true });
  const homeConfig = join(home, '.config', 'agent-bot', 'config.json');
  writeFileSync(homeConfig, JSON.stringify(configured));
  const homeSnapshot = configModule.unmanagedAuthorsSnapshot({ env: {}, home });
  assert.deepEqual(unmanagedAuthorList({ HOME: home }, homeSnapshot), unmanagedAuthors({ env: {}, home }).authors);
  assert.deepEqual(unmanagedAuthorList({}, homeSnapshot), [], 'no HOME and no AGENT_BOT_CONFIG grants nothing');
  assert.deepEqual(unmanagedAuthorList({ HOME: home }), [], 'no snapshot grants nothing');
  // Any edit after the snapshot grants nothing until hooks re-sync, even one
  // the shared resolver would still accept.
  writeFileSync(homeConfig, JSON.stringify({ ...configured, owner: 'someone' }));
  assert.deepEqual(unmanagedAuthorList({ HOME: home }, homeSnapshot), []);
  writeFileSync(homeConfig, JSON.stringify({ ...configured, features: { 'github-identity': 'false' } }));
  assert.deepEqual(unmanagedAuthorList({ HOME: home }, homeSnapshot), []);
  assert.deepEqual(unmanagedAuthorList({ HOME: home, AGENT_BOT_UNMANAGED_AUTHORS: 'zed' }, homeSnapshot), ['zed'], 'env still wins');
});
