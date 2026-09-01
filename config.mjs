// User configuration and harness → bot-slug mapping.
//
// Config lives at ~/.config/agent-bot/config.json (override with
// AGENT_BOT_CONFIG). Everything is optional — with no App mapping the identity
// tools are inert no-ops, so cloning this repo can never hijack a machine's
// identity. A validated organization profile projects into this same runtime
// representation and adds lifecycle/model metadata under `profile`.
// Secret-free settings may still select local runtime policy.
//
//   {
//     "prefix": "yourname",              // slug = <prefix>-<harness>-agent
//     "apps": { "claude": "custom" },    // per-harness overrides of that pattern
//     "owner": "your-org",               // pick the App installation by account
//     "apiBase": "https://api.github.com", // GitHub Enterprise Server / ghe.com
//     "settings": {                        // durable, secret-free user policy
//       "spacesRoot": "/absolute/path",
//       "daemonPreference": "off"          // off | prefer | required
//     },
//     "scope": { "apps": ["you-claude-agent"] } // this account serves only these Apps
//   }
//
// `scope` is for a machine account dedicated to one identity (a per-harness
// agent account): the credential roster is exactly those Apps instead of
// every active App in the profile, so a home that holds one key is complete,
// not incomplete. It is written by `bootstrap --profile ... --scope-app`.

import process from 'node:process';
import { lstatSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import {
  OrganizationProfileError,
  PROFILE_HARNESSES,
  profileStatusForSlug,
  runtimeProfileInfo,
} from './organization-profile.mjs';

const DAEMON_PREFERENCES = new Set(['off', 'prefer', 'required']);
const SCOPE_SLUG_RE = /^[a-z0-9][a-z0-9-]*$/;

export function loadConfig({ home = homedir(), env = process.env } = {}) {
  const path = env.AGENT_BOT_CONFIG ?? join(home, '.config', 'agent-bot', 'config.json');
  let raw;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (err) {
    if (err?.code === 'ENOENT') {
      try {
        lstatSync(path);
      } catch (lstatError) {
        if (lstatError?.code === 'ENOENT') return {}; // genuinely absent — identity stays inert
        throw new Error(`${path} could not be inspected: ${lstatError.message}`);
      }
    }
    throw new Error(`${path} exists but could not be read: ${err.message}`);
  }
  let config;
  try {
    config = JSON.parse(raw.replace(/^\uFEFF/, ''));
  } catch (err) {
    // A present-but-broken config must fail loudly: silently treating it as
    // "no config" makes a typo indistinguishable from a missing file.
    throw new Error(`${path} exists but is not valid JSON: ${err.message}`);
  }
  validateSettings(config);
  runtimeProfileInfo(config);
  return config;
}

function settingsSection(config) {
  if (!config || typeof config !== 'object' || Array.isArray(config)) {
    throw new Error('agent-bot config must be an object');
  }
  if (config.settings === undefined) return {};
  if (!config.settings || typeof config.settings !== 'object' || Array.isArray(config.settings)) {
    throw new Error('agent-bot config settings must be an object');
  }
  return config.settings;
}

// Return the durable user setting only. agent-space.mjs owns the environment
// override and the ~/.agent-space default. XDG_DATA_HOME names the legacy
// tree for the one-time cutover; it is not a resolution input.
export function spacesRootSetting(config = loadConfig()) {
  const value = settingsSection(config).spacesRoot;
  if (value === undefined) return null;
  if (
    typeof value !== 'string'
    || value.length === 0
    || value.includes('\0')
    || !isAbsolute(value)
  ) {
    throw new Error('invalid settings.spacesRoot: expected a non-empty absolute path');
  }
  return value;
}

export function daemonPreference(
  { env = process.env, home = homedir(), config } = {},
) {
  const override = env.AGENT_BOT_DAEMON_PREFERENCE;
  if (override !== undefined && override !== '') return validateDaemonPreference(override);
  const loaded = config === undefined ? loadConfig({ home, env }) : config;
  const value = settingsSection(loaded).daemonPreference ?? 'off';
  return validateDaemonPreference(value);
}

function validateDaemonPreference(value) {
  if (typeof value !== 'string' || !DAEMON_PREFERENCES.has(value)) {
    throw new Error('invalid daemon preference: expected off, prefer, or required');
  }
  return value;
}

// The App roster this account is scoped to, sorted and unique, or null when
// the config carries no scope (the roster is then every active profile App).
export function rosterScope(config = loadConfig()) {
  if (!config || typeof config !== 'object' || Array.isArray(config)) {
    throw new Error('agent-bot config must be an object');
  }
  if (config.scope === undefined) return null;
  const scope = config.scope;
  if (!scope || typeof scope !== 'object' || Array.isArray(scope)) {
    throw new Error('agent-bot config scope must be an object');
  }
  const apps = scope.apps;
  if (
    !Array.isArray(apps)
    || apps.length === 0
    || apps.some((slug) => typeof slug !== 'string' || !SCOPE_SLUG_RE.test(slug))
  ) {
    throw new Error('invalid scope.apps: expected a non-empty list of App slugs');
  }
  return [...new Set(apps)].sort();
}

// Project a config onto a roster scope. Every scoped App must be active in
// the installed organization profile: a retired identity must not regain a
// foothold by being the only App an account serves, and a slug the profile
// never listed has no App behind it at all. Deterministic for a given
// (profile, scope) pair, so a rerun projects an identical config.
export function scopeConfigToApps(config, apps = []) {
  const wanted = [...new Set(apps)].sort();
  if (wanted.length === 0) return config;
  for (const slug of wanted) {
    if (typeof slug !== 'string' || !SCOPE_SLUG_RE.test(slug)) {
      throw new OrganizationProfileError('profile-app-unknown', 'a roster scope names an invalid App slug');
    }
    const status = profileStatusForSlug(slug, config);
    if (status === 'retired') {
      throw new OrganizationProfileError(
        'profile-app-retired',
        'a roster scope names an App retired by the organization profile',
      );
    }
    if (status !== 'active') {
      throw new OrganizationProfileError(
        'profile-app-unknown',
        'a roster scope names an App the organization profile does not list',
      );
    }
  }
  return { ...config, scope: { apps: wanted } };
}

function validateSettings(config) {
  const settings = settingsSection(config);
  if (settings.spacesRoot !== undefined) spacesRootSetting(config);
  if (settings.daemonPreference !== undefined) validateDaemonPreference(settings.daemonPreference);
  rosterScope(config);
}

export function apiBase(config = loadConfig()) {
  return (config.apiBase ?? process.env.GITHUB_API_URL ?? 'https://api.github.com').replace(/\/+$/, '');
}

export function githubHost(config = loadConfig()) {
  return new URL(apiBase(config)).host.replace(/^api\./, '');
}

export function slugForHarness(harness, config = loadConfig()) {
  if (!harness) return null;
  if (config.apps?.[harness]) return config.apps[harness];
  if (config.prefix) return `${config.prefix}-${harness}-agent`;
  return null;
}

export function appLifecycleStatus(appSlug, config = loadConfig()) {
  return profileStatusForSlug(appSlug, config);
}

// Harness keys recognised in an App slug: the profile vocabulary is the one
// list (organization-profile.mjs has no import cycle with this module, unlike
// detect-harness.mjs). `vscode` is retained for the pre-copilot Apps that
// still carry it.
const SLUG_HARNESSES = PROFILE_HARNESSES;

// Map an App slug back to its harness key. Used by execution-identity records
// when there is no local agents roster (standalone clone).
export function harnessForSlug(appSlug, config = loadConfig()) {
  if (!appSlug) return null;
  for (const [key, slug] of Object.entries(config.apps ?? {})) {
    if (slug === appSlug) return key === 'claude' ? 'claude-code' : key;
  }
  const profileIdentity = runtimeProfileInfo(config)?.identities
    .find(({ slug }) => slug === appSlug);
  if (profileIdentity) {
    if (profileIdentity.status !== 'active') return null;
    return profileIdentity.harness === 'claude' ? 'claude-code' : profileIdentity.harness;
  }
  const prefix = config.prefix;
  if (prefix && appSlug.startsWith(`${prefix}-`) && appSlug.endsWith('-agent')) {
    const mid = appSlug.slice(prefix.length + 1, -('-agent'.length));
    const harness = mid.split('-')[0];
    if (SLUG_HARNESSES.includes(harness)) {
      return harness === 'claude' ? 'claude-code' : harness;
    }
  }
  // Best-effort for unconfigured / pinned model Apps: <anything>-claude-…-agent
  const m = appSlug.match(new RegExp(`(?:^|-)(${SLUG_HARNESSES.join('|')})(?:-|$)`));
  if (!m) return null;
  return m[1] === 'claude' ? 'claude-code' : m[1];
}
