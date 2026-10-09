// Credential item names are built in one place and keep the names earlier
// releases wrote (#676).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CREDENTIAL_VAULT, credentialNamespace, credentialVault, itemTitle, managedAppItem, soulAppItem, soulSecretItem } from '../credential-names.mjs';
import { keychainItem, passCliItem, passCliSecretItem, secretItem } from '../soul-credentials.mjs';
import { SOUL_CREDENTIAL_VAULT } from '../secret-providers/pass-cli-credentials.mjs';
import { AGENT_IDENTITIES_VAULT } from '../ensure-private-key.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const AGENT = 'agent_0f554a21-0b41-884e-b9ed-fd1d10fa5a4a';

test('default names are byte-for-byte the names already in stores', () => {
  assert.deepEqual(soulAppItem(AGENT, 'you-claude-agent'), { service: `agent-bot.soul.${AGENT}`, account: 'github-app/you-claude-agent' });
  assert.deepEqual(soulSecretItem(AGENT, 'openai-api-key'), { service: `agent-bot.soul.${AGENT}`, account: 'secret/openai-api-key' });
  assert.deepEqual(managedAppItem('you-claude-agent'), { service: 'agent-bot.app.you-claude-agent', account: 'github-app/you-claude-agent' });
  assert.equal(itemTitle(soulAppItem(AGENT, 'you-claude-agent')), `agent-bot.soul.${AGENT}/github-app/you-claude-agent`);
  assert.equal(CREDENTIAL_VAULT, 'Agent Identities');
  assert.equal(SOUL_CREDENTIAL_VAULT, CREDENTIAL_VAULT);
  assert.equal(AGENT_IDENTITIES_VAULT, CREDENTIAL_VAULT);
});

test('soul-credentials keeps its exported names over the builders', () => {
  assert.deepEqual(keychainItem(AGENT, 'you-claude-agent'), soulAppItem(AGENT, 'you-claude-agent'));
  assert.deepEqual(secretItem(AGENT, 'openai-api-key'), soulSecretItem(AGENT, 'openai-api-key'));
  assert.equal(passCliItem(AGENT, 'you-claude-agent'), `agent-bot.soul.${AGENT}/github-app/you-claude-agent`);
  assert.equal(passCliSecretItem(AGENT, 'openai-api-key'), `agent-bot.soul.${AGENT}/secret/openai-api-key`);
});

test('an unset or empty host namespace and vault keep the default names', () => {
  for (const env of [{}, { AGENT_BOT_CREDENTIAL_NAMESPACE: '', AGENT_BOT_CREDENTIAL_VAULT: '' }]) {
    assert.equal(credentialNamespace(env), 'agent-bot');
    assert.equal(credentialVault(env), 'Agent Identities');
    assert.deepEqual(soulAppItem(AGENT, 'you-claude-agent', { namespace: credentialNamespace(env) }), soulAppItem(AGENT, 'you-claude-agent'));
  }
});

test('a host namespace renames every soul and managed App item', () => {
  const names = { namespace: credentialNamespace({ AGENT_BOT_CREDENTIAL_NAMESPACE: 'app.geniusbar' }) };
  assert.deepEqual(soulAppItem(AGENT, 'you-claude-agent', names), { service: `app.geniusbar.soul.${AGENT}`, account: 'github-app/you-claude-agent' });
  assert.deepEqual(soulSecretItem(AGENT, 'openai-api-key', names), { service: `app.geniusbar.soul.${AGENT}`, account: 'secret/openai-api-key' });
  assert.deepEqual(managedAppItem('you-claude-agent', names), { service: 'app.geniusbar.app.you-claude-agent', account: 'github-app/you-claude-agent' });
  assert.equal(passCliItem(AGENT, 'you-claude-agent', names), `app.geniusbar.soul.${AGENT}/github-app/you-claude-agent`);
  assert.equal(credentialVault({ AGENT_BOT_CREDENTIAL_VAULT: 'GeniusBar Identities' }), 'GeniusBar Identities');
});

test('malformed parts refuse before a name exists', () => {
  assert.throws(() => soulAppItem('agent_nope', 'you-claude-agent'));
  assert.throws(() => soulAppItem(AGENT, '-bad-'), /invalid GitHub App slug/);
  assert.throws(() => soulAppItem(AGENT, 'a/b'), /invalid GitHub App slug/);
  assert.throws(() => managedAppItem('../x'), /invalid GitHub App slug/);
  assert.throws(() => soulSecretItem(AGENT, 'a/b'), /invalid secret name/);
  assert.throws(() => soulSecretItem(AGENT, ''), /invalid secret name/);
});

function runtimeSources(dir, rel = '') {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    if (['node_modules', 'tests', '.git'].includes(entry.name)) return [];
    const path = join(dir, entry.name);
    const name = rel ? `${rel}/${entry.name}` : entry.name;
    if (entry.isDirectory()) return runtimeSources(path, name);
    return entry.name.endsWith('.mjs') ? [{ path, name }] : [];
  });
}

test('no runtime file builds a credential item name outside credential-names.mjs', () => {
  const built = /agent-bot\.(?:soul|app)\.\$\{|['"`]Agent Identities['"`]/u;
  const offenders = runtimeSources(ROOT)
    .filter(({ name }) => name !== 'credential-names.mjs')
    .filter(({ path }) => built.test(readFileSync(path, 'utf8')))
    .map(({ name }) => name);
  assert.deepEqual(offenders, [], 'build credential item names with credential-names.mjs');
});
