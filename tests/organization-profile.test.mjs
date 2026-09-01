import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ORGANIZATION_PROFILE_SCHEMA_VERSION,
  OrganizationProfileError,
  PROFILE_HARNESSES,
  RUNTIME_PROFILE_INTERFACE_VERSION,
  organizationProfileToConfig,
  parseOrganizationProfile,
  profileAppSlugs,
  runtimeProfileInfo,
  validateOrganizationProfile,
} from '../organization-profile.mjs';
import { HARNESSES } from '../detect-harness.mjs';

function completeProfile(overrides = {}) {
  return {
    schema_version: ORGANIZATION_PROFILE_SCHEMA_VERSION,
    organization: 'example-engineering',
    account_owner: 'example',
    minimum_runtime_interface_version: RUNTIME_PROFILE_INTERFACE_VERSION,
    defaults: {
      codex: 'example-codex-agent',
      claude: 'example-claude-agent',
    },
    identities: [
      {
        slug: 'example-codex-sol-agent',
        harness: 'codex',
        status: 'active',
        models: ['gpt-5.6-sol'],
      },
      {
        slug: 'example-retired-codex-agent',
        harness: 'codex',
        status: 'retired',
        models: ['legacy-model'],
      },
      {
        slug: 'example-claude-agent',
        harness: 'claude',
        status: 'active',
      },
      {
        slug: 'example-codex-agent',
        harness: 'codex',
        status: 'active',
      },
    ],
    api_base: 'https://github.example.test/api/v3/',
    settings: {
      spaces_root: '/srv/agent-spaces',
      daemon_preference: 'prefer',
    },
    ...overrides,
  };
}

// ENG-0339 split the vocabulary: environment detection knows the harnesses
// with measured markers, while the rest resolve through the account-name
// input. The surviving invariant is containment — an env-detectable harness
// the profile rejects would fail closed against its own machine's profile.
test('profile harness vocabulary is sorted, unique, and contains every env-detected harness', () => {
  assert.deepEqual([...PROFILE_HARNESSES], [...new Set(PROFILE_HARNESSES)].sort());
  for (const { key } of HARNESSES) {
    assert.ok(
      PROFILE_HARNESSES.includes(key),
      `detect-harness knows "${key}" but the profile vocabulary rejects it`,
    );
  }
});

test('profile v1 normalizes complete defaults, model mappings, and lifecycle state', () => {
  const profile = validateOrganizationProfile(completeProfile());
  assert.deepEqual(Object.keys(profile.defaults), ['claude', 'codex']);
  assert.deepEqual(profile.identities.map(({ slug }) => slug), [
    'example-claude-agent',
    'example-codex-agent',
    'example-codex-sol-agent',
    'example-retired-codex-agent',
  ]);
  assert.equal(profile.api_base, 'https://github.example.test/api/v3');

  const config = organizationProfileToConfig(profile);
  assert.deepEqual(config.apps, {
    claude: 'example-claude-agent',
    codex: 'example-codex-agent',
  });
  assert.equal(config.owner, 'example');
  assert.deepEqual(config.settings, {
    spacesRoot: '/srv/agent-spaces',
    daemonPreference: 'prefer',
  });
  assert.deepEqual(profileAppSlugs(config), [
    'example-claude-agent',
    'example-codex-agent',
    'example-codex-sol-agent',
  ]);
  const info = runtimeProfileInfo(config);
  assert.equal(info.active.length, 3);
  assert.equal(info.retired.length, 1);
});

test('profile parsing is deterministic and strips no required lifecycle evidence', () => {
  const first = parseOrganizationProfile(JSON.stringify(completeProfile()));
  const second = parseOrganizationProfile(`\uFEFF${JSON.stringify({
    ...completeProfile(),
    identities: [...completeProfile().identities].reverse(),
  })}`);
  assert.deepEqual(first, second);
  assert.equal(first.identities.find(({ status }) => status === 'retired').slug, 'example-retired-codex-agent');
});

test('unknown schema and incompatible runtime requirements have distinct safe codes', () => {
  for (const [value, code] of [
    [completeProfile({ schema_version: 2 }), 'profile-schema-unsupported'],
    [completeProfile({ minimum_runtime_interface_version: 2 }), 'profile-runtime-incompatible'],
  ]) {
    assert.throws(
      () => validateOrganizationProfile(value),
      (error) => error instanceof OrganizationProfileError && error.code === code,
    );
  }
});

test('partial profiles fail when active harness defaults are absent or retired', () => {
  const missingDefault = completeProfile({ defaults: { codex: 'example-codex-agent' } });
  assert.throws(() => validateOrganizationProfile(missingDefault), /missing an active harness default/);

  const retiredDefault = completeProfile({
    defaults: {
      ...completeProfile().defaults,
      codex: 'example-retired-codex-agent',
    },
  });
  assert.throws(() => validateOrganizationProfile(retiredDefault), /active matching identity/);

  const incompleteIdentity = completeProfile();
  delete incompleteIdentity.identities[0].status;
  assert.throws(() => validateOrganizationProfile(incompleteIdentity), /identity is incomplete/);
});

test('invalid slugs and duplicate identities fail closed', () => {
  const invalidSlug = completeProfile();
  invalidSlug.identities[0].slug = '../private-key';
  assert.throws(() => validateOrganizationProfile(invalidSlug), /App slug is invalid/);

  const duplicate = completeProfile();
  duplicate.identities.push({ ...duplicate.identities[0] });
  assert.throws(() => validateOrganizationProfile(duplicate), /duplicate App identities/);
});

test('ambiguous active model mappings are ignored (models are parse-valid but not used for selection)', () => {
  const ambiguous = completeProfile();
  ambiguous.identities.push({
    slug: 'example-codex-terra-agent',
    harness: 'codex',
    status: 'active',
    models: ['gpt-5.6-sol'],
  });
  assert.doesNotThrow(() => validateOrganizationProfile(ambiguous));
});

test('profile errors never reflect secret-shaped input or unsupported field names', () => {
  const sentinel = 'SENTINEL_PRIVATE_KEY_OR_TOKEN=';
  for (const value of [
    { ...completeProfile(), private_key: sentinel },
    { ...completeProfile(), organization: sentinel },
    { ...completeProfile(), api_base: `https://${sentinel}@github.example.test` },
  ]) {
    assert.throws(
      () => validateOrganizationProfile(value),
      (error) => {
        assert.doesNotMatch(error.message, new RegExp(sentinel));
        assert.doesNotMatch(error.message, /private_key/);
        return true;
      },
    );
  }
  assert.throws(
    () => parseOrganizationProfile(`{"organization":"${sentinel}"`),
    (error) => !error.message.includes(sentinel),
  );
});

test('runtime profile metadata is revalidated instead of trusted after installation', () => {
  const config = organizationProfileToConfig(completeProfile());
  config.profile.identities[0].status = 'unknown';
  assert.throws(() => runtimeProfileInfo(config), /identity status is invalid/);

  const ownerMismatch = organizationProfileToConfig(completeProfile());
  ownerMismatch.owner = 'different-owner';
  assert.throws(() => runtimeProfileInfo(ownerMismatch), /owner is inconsistent/);
});
