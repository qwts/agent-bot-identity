// The organization's soul co-author domain (ADR-0815): an optional profile
// setting that projects into config like unmanaged_authors, never a GitHub
// domain, and never a way out of the soul-substitution refusal.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SOUL_COAUTHOR_DOMAIN, assertSoulCoAuthor, soulCoAuthorDomains, soulCoAuthorTrailer } from '../agent-identity.mjs';
import { loadConfig, soulCoauthorDomainSetting } from '../config.mjs';
import {
  ORGANIZATION_PROFILE_SCHEMA_VERSION,
  isProjectedRuntimeConfig,
  organizationProfileToConfig,
  runtimeProfileInfo,
  validateOrganizationProfile,
} from '../organization-profile.mjs';

const profile = (settings) => ({
  schema_version: ORGANIZATION_PROFILE_SCHEMA_VERSION,
  organization: 'example-engineering',
  account_owner: 'example-owner',
  minimum_runtime_interface_version: 1,
  defaults: { claude: 'example-claude-agent' },
  identities: [{ slug: 'example-claude-agent', harness: 'claude', status: 'active' }],
  settings,
});

const BAD_DOMAINS = [
  'github.com', 'users.noreply.github.com', 'souls.github.com', 'githubusercontent.com', 'example.github.io',
  'ghe.com', 'acme.ghe.com', 'users.noreply.github.example.org',
  'Souls.Example.org', 'localhost', 'souls..example.org', '-souls.example.org', 'souls-.example.org',
  'souls.example.org.', '1.2.3.4', 'souls.example.org/x', 'agent@souls.example.org', 'souls example.org',
  `${'a'.repeat(64)}.example.org`, '', 7, null,
];

test('the profile projects soul_coauthor_domain into config and back', () => {
  const config = organizationProfileToConfig(validateOrganizationProfile(profile({ soul_coauthor_domain: 'souls.example.org' })));
  assert.equal(config.settings.soulCoauthorDomain, 'souls.example.org');
  assert.equal(soulCoauthorDomainSetting(config), 'souls.example.org');
  assert.equal(isProjectedRuntimeConfig(config), true);
  assert.equal(runtimeProfileInfo(config).organization, 'example-engineering');
  assert.deepEqual(soulCoAuthorDomains(config), ['souls.example.org', SOUL_COAUTHOR_DOMAIN]);
  assert.deepEqual(soulCoAuthorDomains({}), [SOUL_COAUTHOR_DOMAIN]);
  assert.equal(soulCoauthorDomainSetting({}), null);
});

test('GitHub domains and anything that is not a lowercase domain name are refused', () => {
  for (const bad of BAD_DOMAINS) {
    assert.throws(() => validateOrganizationProfile(profile({ soul_coauthor_domain: bad })), /soul_coauthor_domain/, String(bad));
    assert.throws(() => soulCoauthorDomainSetting({ settings: { soulCoauthorDomain: bad } }), /invalid settings\.soulCoauthorDomain/, String(bad));
  }
  for (const good of ['souls.example.org', 'agents.acme.invalid', 'x1.y-2.example']) {
    assert.equal(validateOrganizationProfile(profile({ soul_coauthor_domain: good })).settings.soul_coauthor_domain, good);
  }
});

test('a malformed domain in a hand-written config fails the config load', () => {
  const file = join(mkdtempSync(join(tmpdir(), 'soul-domain-')), 'config.json');
  writeFileSync(file, JSON.stringify({ settings: { soulCoauthorDomain: 'users.noreply.github.com' } }));
  assert.throws(() => loadConfig({ env: { AGENT_BOT_CONFIG: file } }), /invalid settings\.soulCoauthorDomain/);
});

test('with an organization domain, a credit in either soul domain is still checked', () => {
  const bound = 'agent_11111111-1111-4111-8111-111111111111';
  const other = 'agent_22222222-2222-4222-8222-222222222222';
  const domains = soulCoAuthorDomains({ settings: { soulCoauthorDomain: 'souls.example.org' } });
  assert.equal(soulCoAuthorTrailer(bound, 'Bound', domains[0]), `Co-authored-by: Bound <${bound}@souls.example.org>`);
  assert.doesNotThrow(() => assertSoulCoAuthor(`x\n\nCo-authored-by: Bound <${bound}@souls.example.org>\n`, bound, domains));
  for (const domain of domains) {
    assert.throws(() => assertSoulCoAuthor(`x\n\nCo-authored-by: Other <${other}@${domain}>\n`, bound, domains), /credits another soul/);
  }
  // Other domains are people, not souls, and are left alone.
  assert.doesNotThrow(() => assertSoulCoAuthor(`x\n\nCo-authored-by: Other <${other}@example.org>\n`, bound, domains));
});
