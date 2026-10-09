// One resolver for the unmanaged-author allowlist (#675): the committed git
// hooks, doctor and the organization profile agree on where it comes from.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { LEGACY_UNMANAGED_AUTHORS, unmanagedAuthors, unmanagedAuthorsWithLegacyDefault } from '../config.mjs';
import { organizationProfileToConfig, validateOrganizationProfile, ORGANIZATION_PROFILE_SCHEMA_VERSION } from '../organization-profile.mjs';
import { UNINSTALLED_REASON, uninstalledDecision } from '../uninstalled-identity-hook.mjs';

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

test('only the entry-point helper supplies the legacy default, and only when nothing is set', () => {
  assert.deepEqual(unmanagedAuthorsWithLegacyDefault({ env: {}, config: {} }), { authors: [...LEGACY_UNMANAGED_AUTHORS], source: 'default' });
  assert.deepEqual(unmanagedAuthorsWithLegacyDefault({ env: { AGENT_BOT_UNMANAGED_AUTHORS: '' }, config: {} }), { authors: [], source: 'env' });
  assert.deepEqual(unmanagedAuthorsWithLegacyDefault({ env: {}, config: configured }).source, 'config');
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
  assert.equal(shellAuthors({ ...base, AGENT_BOT_CONFIG: join(dir, 'absent.json') }), 'ai9d');
  // A config the resolver rejects yields nothing: the hook refuses.
  assert.equal(shellAuthors({ ...base, AGENT_BOT_CONFIG: bad }), '');
});

test('without Node the git hooks keep the compiled default they had before', { skip: ['/usr/bin/node', '/bin/node'].some(existsSync) && 'node is on the minimal PATH' }, () => {
  assert.equal(shellAuthors({ PATH: '/usr/bin:/bin', HOME: tmpdir(), AGENT_BOT_CONFIG: '/nonexistent' }), 'ai9d');
});
