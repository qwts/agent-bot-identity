import { readFileSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { isDeepStrictEqual } from 'node:util';

export const ORGANIZATION_PROFILE_SCHEMA_VERSION = 1;
export const RUNTIME_PROFILE_INTERFACE_VERSION = 1;

// One harness key per independently attributable harness (ENG-0339: the
// active roster is harness-level). Environment detection knows only a subset
// of these — the rest resolve through the account-name input in
// detect-harness.mjs, so adding a harness here needs no per-tool env research.
export const PROFILE_HARNESSES = Object.freeze([
  'aider',
  'amp',
  'antigravity',
  'claude',
  'cline',
  'codex',
  'copilot',
  'cursor',
  'deepseek',
  'devin',
  'droid',
  'goose',
  'grok',
  'hermes',
  'kiro',
  'muse',
  'opencode',
  'pi',
  'qwen',
  'vscode',
  'warp',
  'zcode',
]);

const HARNESSES = new Set(PROFILE_HARNESSES);
const STATUSES = new Set(['active', 'retired']);
const DAEMON_PREFERENCES = new Set(['off', 'prefer', 'required']);
const APP_SLUG_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/;
const IDENTIFIER_RE = /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/;
const ACCOUNT_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/;
const MODEL_RE = /^[A-Za-z0-9](?:[A-Za-z0-9._:+/-]*[A-Za-z0-9])?$/;

export class OrganizationProfileError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'OrganizationProfileError';
    this.code = code;
  }
}

function fail(code, message) {
  throw new OrganizationProfileError(code, message);
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function requireObject(value, label) {
  if (!isObject(value)) fail('profile-invalid', `${label} must be an object`);
  return value;
}

function requireExactKeys(value, { allowed, required = allowed }, label) {
  const keys = Object.keys(value);
  if (keys.some((key) => !allowed.includes(key))) {
    fail('profile-invalid', `${label} contains unsupported fields`);
  }
  if (required.some((key) => !Object.hasOwn(value, key))) {
    fail('profile-invalid', `${label} is incomplete`);
  }
}

function requireInteger(value, label) {
  if (!Number.isInteger(value) || value < 1) {
    fail('profile-invalid', `${label} must be a positive integer`);
  }
  return value;
}

function requireString(value, { label, pattern, maximum = 128 }) {
  if (
    typeof value !== 'string'
    || value.length === 0
    || value.length > maximum
    || value.includes('\0')
    || !pattern.test(value)
  ) {
    fail('profile-invalid', `${label} is invalid`);
  }
  return value;
}

function requireHarness(value) {
  if (typeof value !== 'string' || !HARNESSES.has(value)) {
    fail('profile-invalid', 'organization profile contains an unsupported harness');
  }
  return value;
}

function requireAppSlug(value) {
  return requireString(value, {
    label: 'organization profile App slug',
    pattern: APP_SLUG_RE,
    maximum: 100,
  });
}

function normalizeApiBase(value) {
  if (value === undefined) return null;
  if (typeof value !== 'string' || value.length === 0 || value.length > 2048) {
    fail('profile-invalid', 'organization profile api_base is invalid');
  }
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    fail('profile-invalid', 'organization profile api_base is invalid');
  }
  if (
    parsed.protocol !== 'https:'
    || parsed.username
    || parsed.password
    || parsed.search
    || parsed.hash
  ) {
    fail('profile-invalid', 'organization profile api_base must be a credential-free HTTPS URL');
  }
  return value.replace(/\/+$/, '');
}

function normalizeSettings(value) {
  if (value === undefined) return null;
  const settings = requireObject(value, 'organization profile settings');
  requireExactKeys(settings, {
    allowed: ['spaces_root', 'daemon_preference'],
    required: [],
  }, 'organization profile settings');
  const normalized = {};
  if (settings.spaces_root !== undefined) {
    if (
      typeof settings.spaces_root !== 'string'
      || settings.spaces_root.length === 0
      || settings.spaces_root.includes('\0')
      || !isAbsolute(settings.spaces_root)
    ) {
      fail('profile-invalid', 'organization profile spaces_root must be a non-empty absolute path');
    }
    normalized.spaces_root = settings.spaces_root;
  }
  if (settings.daemon_preference !== undefined) {
    if (
      typeof settings.daemon_preference !== 'string'
      || !DAEMON_PREFERENCES.has(settings.daemon_preference)
    ) {
      fail('profile-invalid', 'organization profile daemon_preference is invalid');
    }
    normalized.daemon_preference = settings.daemon_preference;
  }
  return normalized;
}

function normalizeIdentity(value) {
  const identity = requireObject(value, 'organization profile identity');
  requireExactKeys(identity, {
    allowed: ['slug', 'harness', 'status', 'models'],
    required: ['slug', 'harness', 'status'],
  }, 'organization profile identity');
  const slug = requireAppSlug(identity.slug);
  const harness = requireHarness(identity.harness);
  if (typeof identity.status !== 'string' || !STATUSES.has(identity.status)) {
    fail('profile-invalid', 'organization profile identity status is invalid');
  }
  if (identity.models !== undefined && !Array.isArray(identity.models)) {
    fail('profile-invalid', 'organization profile identity models must be an array');
  }
  const models = (identity.models ?? []).map((model) => requireString(model, {
    label: 'organization profile model identifier',
    pattern: MODEL_RE,
    maximum: 128,
  }));
  if (new Set(models).size !== models.length) {
    fail('profile-invalid', 'organization profile identity contains duplicate model mappings');
  }
  return {
    slug,
    harness,
    status: identity.status,
    models: [...models].sort(),
  };
}

export function validateOrganizationProfile(value) {
  const profile = requireObject(value, 'organization profile');
  requireExactKeys(profile, {
    allowed: [
      'schema_version',
      'organization',
      'account_owner',
      'minimum_runtime_interface_version',
      'defaults',
      'identities',
      'api_base',
      'settings',
    ],
    required: [
      'schema_version',
      'organization',
      'account_owner',
      'minimum_runtime_interface_version',
      'defaults',
      'identities',
    ],
  }, 'organization profile');

  const schemaVersion = requireInteger(profile.schema_version, 'organization profile schema_version');
  if (schemaVersion !== ORGANIZATION_PROFILE_SCHEMA_VERSION) {
    fail('profile-schema-unsupported', 'organization profile schema version is unsupported');
  }
  const minimumRuntimeInterfaceVersion = requireInteger(
    profile.minimum_runtime_interface_version,
    'organization profile minimum_runtime_interface_version',
  );
  if (minimumRuntimeInterfaceVersion > RUNTIME_PROFILE_INTERFACE_VERSION) {
    fail(
      'profile-runtime-incompatible',
      'organization profile requires a newer agent-bot runtime interface',
    );
  }

  const organization = requireString(profile.organization, {
    label: 'organization profile organization identifier',
    pattern: IDENTIFIER_RE,
    maximum: 100,
  });
  const accountOwner = requireString(profile.account_owner, {
    label: 'organization profile account owner',
    pattern: ACCOUNT_RE,
    maximum: 100,
  });

  const defaultsInput = requireObject(profile.defaults, 'organization profile defaults');
  const defaults = {};
  for (const harness of Object.keys(defaultsInput).sort()) {
    requireHarness(harness);
    defaults[harness] = requireAppSlug(defaultsInput[harness]);
  }
  if (Object.keys(defaults).length === 0) {
    fail('profile-invalid', 'organization profile defaults must not be empty');
  }

  if (!Array.isArray(profile.identities) || profile.identities.length === 0) {
    fail('profile-invalid', 'organization profile identities must be a non-empty array');
  }
  const identities = profile.identities.map(normalizeIdentity)
    .sort((left, right) => left.slug.localeCompare(right.slug));
  const bySlug = new Map();
  const activeHarnesses = new Set();
  for (const identity of identities) {
    if (bySlug.has(identity.slug)) {
      fail('profile-invalid', 'organization profile contains duplicate App identities');
    }
    bySlug.set(identity.slug, identity);
    if (identity.status !== 'active') continue;
    activeHarnesses.add(identity.harness);
  }

  for (const harness of activeHarnesses) {
    if (!Object.hasOwn(defaults, harness)) {
      fail('profile-invalid', 'organization profile is missing an active harness default');
    }
  }
  for (const [harness, slug] of Object.entries(defaults)) {
    const identity = bySlug.get(slug);
    if (
      !identity
      || identity.harness !== harness
      || identity.status !== 'active'
    ) {
      fail('profile-invalid', 'organization profile default must reference an active matching identity');
    }
  }

  const normalized = {
    schema_version: schemaVersion,
    organization,
    account_owner: accountOwner,
    minimum_runtime_interface_version: minimumRuntimeInterfaceVersion,
    defaults,
    identities,
  };
  const apiBase = normalizeApiBase(profile.api_base);
  if (apiBase !== null) normalized.api_base = apiBase;
  const settings = normalizeSettings(profile.settings);
  if (settings !== null) normalized.settings = settings;
  return normalized;
}

export function parseOrganizationProfile(raw) {
  if (typeof raw !== 'string') {
    fail('profile-invalid', 'organization profile input must be JSON text');
  }
  let value;
  try {
    value = JSON.parse(raw.replace(/^\uFEFF/, ''));
  } catch {
    fail('profile-invalid', 'organization profile is not valid JSON');
  }
  return validateOrganizationProfile(value);
}

export function readOrganizationProfile({
  sourcePath,
  read = readFileSync,
  stdin = 0,
} = {}) {
  if (typeof sourcePath !== 'string' || sourcePath.length === 0) {
    fail('profile-read-failed', 'organization profile source is required');
  }
  let raw;
  try {
    raw = read(sourcePath === '-' ? stdin : sourcePath, 'utf8');
  } catch {
    fail('profile-read-failed', 'organization profile could not be read');
  }
  return parseOrganizationProfile(raw);
}

export function organizationProfileToConfig(value) {
  const profile = validateOrganizationProfile(value);
  const config = {
    profile: {
      schemaVersion: profile.schema_version,
      organization: profile.organization,
      accountOwner: profile.account_owner,
      minimumRuntimeInterfaceVersion: profile.minimum_runtime_interface_version,
      identities: profile.identities,
    },
    // The governance owner is the default installation account: today's
    // profile carries no per-identity installation account, and a user-owned
    // roster hosts its own Apps. An operator may set `owner` to another
    // account; mint-token consults it only for an App installed on several.
    owner: profile.account_owner,
    apps: profile.defaults,
  };
  if (profile.api_base !== undefined) config.apiBase = profile.api_base;
  if (profile.settings !== undefined) {
    config.settings = {};
    if (profile.settings.spaces_root !== undefined) {
      config.settings.spacesRoot = profile.settings.spaces_root;
    }
    if (profile.settings.daemon_preference !== undefined) {
      config.settings.daemonPreference = profile.settings.daemon_preference;
    }
  }
  return config;
}

function profileFromRuntimeConfig(config) {
  const metadata = requireObject(config.profile, 'runtime organization profile metadata');
  requireExactKeys(metadata, {
    allowed: [
      'schemaVersion',
      'organization',
      'accountOwner',
      'minimumRuntimeInterfaceVersion',
      'identities',
    ],
  }, 'runtime organization profile metadata');
  // `owner` is deliberately not compared with `accountOwner`. They answer
  // different questions: `owner` selects the account an App is installed on,
  // `accountOwner` is the roster's governance owner. They coincide for a
  // user-owned roster and legitimately differ when a private App is owned by
  // — and so installed on — an organization the governance owner controls
  // (#194). The check that means something is `owner` against the App's
  // actual installations, and mint-token performs it at mint time.
  const settings = {};
  if (config.settings?.spacesRoot !== undefined) settings.spaces_root = config.settings.spacesRoot;
  if (config.settings?.daemonPreference !== undefined) {
    settings.daemon_preference = config.settings.daemonPreference;
  }
  return validateOrganizationProfile({
    schema_version: metadata.schemaVersion,
    organization: metadata.organization,
    account_owner: metadata.accountOwner,
    minimum_runtime_interface_version: metadata.minimumRuntimeInterfaceVersion,
    defaults: config.apps,
    identities: metadata.identities,
    ...(config.apiBase === undefined ? {} : { api_base: config.apiBase }),
    ...(Object.keys(settings).length === 0 ? {} : { settings }),
  });
}

// True when the runtime config is exactly what projecting its own embedded
// profile snapshot yields (a roster scope aside): it is profile-owned, so a
// newer published profile may replace it. Hand-written configs (no
// snapshot), configs whose snapshot no longer validates, and configs that
// drifted from their snapshot (a harness mapping outside the embedded
// roster, an `owner` other than the account owner the profile projects) are
// not projections and are never overwritten.
export function isProjectedRuntimeConfig(config) {
  if (!config || typeof config !== 'object' || !Object.hasOwn(config, 'profile')) return false;
  const { scope, ...unscoped } = config;
  try {
    return isDeepStrictEqual(organizationProfileToConfig(profileFromRuntimeConfig(unscoped)), unscoped);
  } catch {
    return false;
  }
}

export function runtimeProfileInfo(config) {
  if (!config || !Object.hasOwn(config, 'profile')) return null;
  const profile = profileFromRuntimeConfig(config);
  const active = profile.identities.filter((identity) => identity.status === 'active');
  const retired = profile.identities.filter((identity) => identity.status === 'retired');
  return {
    schemaVersion: profile.schema_version,
    organization: profile.organization,
    accountOwner: profile.account_owner,
    minimumRuntimeInterfaceVersion: profile.minimum_runtime_interface_version,
    defaults: profile.defaults,
    identities: profile.identities,
    active,
    retired,
  };
}

export function profileAppSlugs(config) {
  return runtimeProfileInfo(config)?.active.map(({ slug }) => slug).sort() ?? [];
}

export function profileStatusForSlug(slug, config) {
  if (!slug) return null;
  return runtimeProfileInfo(config)?.identities.find((identity) => identity.slug === slug)?.status
    ?? null;
}
