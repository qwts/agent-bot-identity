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
//     "owner": "your-org",               // account an App is installed on; consulted
//                                        // only when an App has several installations
//     "apiBase": "https://api.github.com", // GitHub Enterprise Server / ghe.com
//     "settings": {                        // durable, secret-free user policy
//       "spacesRoot": "/absolute/path",
//       "soulsRoot": "/absolute/path",
//       "daemonPreference": "off",         // off | prefer | required
//       "unmanagedAuthors": ["ai9d"],      // humans who may publish as themselves
//                                          // from an agent session (#675)
//       "keydTeamId": "ABCDE12345",        // Developer ID team that signs keyd (#594)
//       "keydIdentifier": "agent-bot-keyd", // keyd's code-signing identifier (#594)
//       "soulCoauthorDomain": "souls.example.org", // soul co-author email domain (ADR-0815)
//       "skillSearchAdapter": "local-text"  // soul skill search adapter (#902)
//     },
//     "scope": { "apps": ["you-claude-agent"] } // this account serves only these Apps
//   }
//
// `scope` is for a machine account dedicated to one identity (a per-harness
// agent account): the credential roster is exactly those Apps instead of
// every active App in the profile, so a home that holds one key is complete,
// not incomplete. It is written by `bootstrap --profile ... --scope-app`.

import process from 'node:process';
import { createHash } from 'node:crypto';
import { lstatSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import {
  OrganizationProfileError,
  PROFILE_HARNESSES,
  isSoulCoauthorDomain,
  ownerKeysProblem,
  profileStatusForSlug,
  runtimeProfileInfo,
} from './organization-profile-schema.mjs';

const DAEMON_PREFERENCES = new Set(['off', 'prefer', 'required']);
const SCOPE_SLUG_RE = /^[a-z0-9][a-z0-9-]*$/;
export const FEATURE_GATES = Object.freeze(['github-identity', 'persona-accounts']);

// Add-ons use this single gate seam. Gates are config-only and default off;
// environment variables never implicitly enable them.
export function isGateEnabled(name, { env = process.env, home = homedir(), config } = {}) {
  void env;
  if (!FEATURE_GATES.includes(name)) throw new Error(`unknown feature gate: ${name}`);
  const loaded = config === undefined ? loadConfig({ home, env }) : config;
  validateFeatures(loaded);
  return loaded.features?.[name] === true;
}

export function gateStatus(config = {}) {
  return Object.fromEntries(FEATURE_GATES.map((name) => [name, {
    enabled: config.features?.[name] === true,
    source: config.features && Object.hasOwn(config.features, name) ? 'user-config' : 'default',
  }]));
}

export function configPath({ home = homedir(), env = process.env } = {}) {
  return env.AGENT_BOT_CONFIG ?? join(home, '.config', 'agent-bot', 'config.json');
}

export function loadConfig({ home = homedir(), env = process.env } = {}) {
  const path = configPath({ home, env });
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
  return parseConfig(raw, path);
}

// Parse and validate config text. Pure in its input, so the same bytes always
// validate the same way; the generated hook fallback relies on that (#675).
export function parseConfig(raw, path = 'agent-bot config') {
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

export function soulsRootSetting(config = loadConfig()) {
  const value = settingsSection(config).soulsRoot;
  if (value === undefined) return null;
  if (
    typeof value !== 'string'
    || value.length === 0
    || value.includes('\0')
    || !isAbsolute(value)
  ) {
    throw new Error('invalid settings.soulsRoot: expected a non-empty absolute path');
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

// The unmanaged authors (ENG-0128): people who may publish as themselves from
// an agent session. Lowercase logins, git names or email local parts, as the
// hooks compare them; no commas or whitespace, since the environment form is
// a comma list.
const UNMANAGED_AUTHOR = /^[a-z0-9][a-z0-9._@+-]{0,99}$/;
const MAX_UNMANAGED_AUTHORS = 64;

export function unmanagedAuthorsSetting(config = loadConfig()) {
  const value = settingsSection(config).unmanagedAuthors;
  if (value === undefined) return null;
  if (!Array.isArray(value) || value.length > MAX_UNMANAGED_AUTHORS
    || !value.every((author) => typeof author === 'string' && UNMANAGED_AUTHOR.test(author))) {
    throw new Error(`invalid settings.unmanagedAuthors: expected at most ${MAX_UNMANAGED_AUTHORS} lowercase logins (letters, digits, . _ @ + -)`);
  }
  return [...new Set(value)];
}

export function parseUnmanagedAuthorList(raw) {
  if (typeof raw !== 'string' || !raw.trim()) return [];
  return raw.split(',').map((part) => part.trim().toLowerCase()).filter(Boolean);
}

// The one resolver every reader of the allowlist uses (#675). An operator's
// AGENT_BOT_UNMANAGED_AUTHORS wins whenever it is set, even empty; otherwise
// the validated config (an organization profile projects into it); otherwise
// none. A malformed config throws: the callers refuse rather than guess.
// The config is read only when the environment does not decide, so a
// malformed config never overrides an explicit operator setting.
export function unmanagedAuthors({ env = process.env, config, home } = {}) {
  if (env.AGENT_BOT_UNMANAGED_AUTHORS !== undefined) {
    return { authors: parseUnmanagedAuthorList(env.AGENT_BOT_UNMANAGED_AUTHORS), source: 'env' };
  }
  const configured = unmanagedAuthorsSetting(config ?? loadConfig(home === undefined ? { env } : { env, home }));
  return configured === null ? { authors: [], source: 'none' } : { authors: configured, source: 'config' };
}

// What a generated hook fallback may grant without the installed runtime
// (#675): the configured allowlist for exactly these config bytes, resolved by
// the shared validator. An absent file grants nothing; a malformed one grants
// nothing, as the shared resolver refuses it. The fallback compares the digest
// at decision time, so an edited config grants nothing until hooks re-sync.
export function unmanagedAuthorsSnapshot({ home = homedir(), env = process.env } = {}) {
  const path = configPath({ home, env });
  let bytes;
  try {
    bytes = readFileSync(path);
  } catch {
    return { sha256: null, authors: [] };
  }
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  try {
    return { sha256, authors: unmanagedAuthorsSetting(parseConfig(bytes.toString('utf8'), path)) ?? [] };
  } catch {
    return { sha256, authors: [] };
  }
}

// Who must have signed the keyd binary before agent-bot pins its presence
// key (#594). The Team ID has no built-in default: it comes from the
// organization profile (`settings.keyd_team_id`, projected here), the
// config, or the environment, and with none set nothing is pinned, so the
// owner gate falls back to the administrator dialog (#752). The identifier
// defaults to keyd's own. ANY_DEVELOPER_ID, set explicitly, drops that part
// of the check; owner-presence.mjs pins under it only with the owner's
// verification. Both values end up in a code-signing requirement, so only
// these shapes are accepted.
export const DEFAULT_KEYD_IDENTIFIER = 'agent-bot-keyd';
export const ANY_DEVELOPER_ID = 'any-developer-id';
const KEYD_TEAM_ID = { pattern: /^[A-Z0-9]{10}$/, shape: 'a 10-character Team ID (A-Z, 0-9)' };
const KEYD_IDENTIFIER = { pattern: /^[A-Za-z0-9][A-Za-z0-9.-]{0,254}$/, shape: 'a code-signing identifier (letters, digits, . -)' };

function keydSignerValue(value, { pattern, shape }, name) {
  if (value === ANY_DEVELOPER_ID || (typeof value === 'string' && pattern.test(value))) return value;
  throw new Error(`invalid ${name}: expected ${shape} or ${ANY_DEVELOPER_ID}`);
}

export function keydSignerSetting(config = loadConfig()) {
  const settings = settingsSection(config);
  return {
    teamId: settings.keydTeamId === undefined ? null : keydSignerValue(settings.keydTeamId, KEYD_TEAM_ID, 'settings.keydTeamId'),
    identifier: settings.keydIdentifier === undefined ? null : keydSignerValue(settings.keydIdentifier, KEYD_IDENTIFIER, 'settings.keydIdentifier'),
  };
}

// AGENT_BOT_KEYD_TEAM_ID and AGENT_BOT_KEYD_IDENTIFIER win when set and
// non-empty, then the config, each value on its own; the identifier then
// falls back to keyd's, the Team ID to null (nothing pinned). The config is
// read only when the environment leaves one open, and then as a whole: like
// every other setting, a malformed keyd value makes the config fail to load,
// even if the environment overrides that value. A malformed value throws;
// the caller pins nothing.
export function keydSigner({ env = process.env, config, home } = {}) {
  const {
    AGENT_BOT_KEYD_TEAM_ID: envTeam,
    AGENT_BOT_KEYD_IDENTIFIER: envIdentifier,
  } = keydSignerEnvironment(env);
  const configured = envTeam && envIdentifier
    ? { teamId: null, identifier: null }
    : keydSignerSetting(config ?? loadConfig({ env, home }));
  return {
    teamId: envTeam ?? configured.teamId,
    identifier: envIdentifier ?? configured.identifier ?? DEFAULT_KEYD_IDENTIFIER,
  };
}

// The environment half of keydSigner alone, trimmed and validated, an unset
// or empty variable absent; the config is never read. The supervised daemon
// is given these in its unit, so it keeps the installing host's signer (#865).
export function keydSignerEnvironment(env = process.env) {
  const fromEnv = (name) => (env[name] ? env[name].trim() : '');
  const team = fromEnv('AGENT_BOT_KEYD_TEAM_ID');
  const identifier = fromEnv('AGENT_BOT_KEYD_IDENTIFIER');
  return {
    ...(team ? { AGENT_BOT_KEYD_TEAM_ID: keydSignerValue(team, KEYD_TEAM_ID, 'AGENT_BOT_KEYD_TEAM_ID') } : {}),
    ...(identifier ? { AGENT_BOT_KEYD_IDENTIFIER: keydSignerValue(identifier, KEYD_IDENTIFIER, 'AGENT_BOT_KEYD_IDENTIFIER') } : {}),
  };
}

// `owner` names the GitHub account an App is installed on. It is a selector
// for mint-token, not the roster's governance owner, and the two may differ.
function validateOwner(config) {
  const owner = config.owner;
  if (owner === undefined) return;
  if (typeof owner !== 'string' || owner.length === 0 || owner.includes('\0')) {
    throw new Error('invalid owner: expected a non-empty GitHub account name');
  }
}

// The organization's domain for soul co-author emails (ADR-0815), or null
// for the reserved default. The profile validates it; a hand-written config
// is held to the same rule, and a malformed value fails the config load.
export function soulCoauthorDomainSetting(config = loadConfig()) {
  const value = settingsSection(config).soulCoauthorDomain;
  if (value === undefined) return null;
  if (!isSoulCoauthorDomain(value)) {
    throw new Error('invalid settings.soulCoauthorDomain: expected a lowercase domain name that is not a GitHub domain');
  }
  return value;
}

// The adapter `soul skill search` uses (#902), or null when none is
// configured and search reports that plainly. A host setting, never part of
// a soul package. `local-text` searches the soul's own definition and skill
// files; it sets up no service.
export const SKILL_SEARCH_ADAPTERS = Object.freeze(['local-text']);
export function skillSearchAdapterSetting(config = loadConfig()) {
  const value = settingsSection(config).skillSearchAdapter;
  if (value === undefined) return null;
  if (!SKILL_SEARCH_ADAPTERS.includes(value)) {
    throw new Error(`invalid settings.skillSearchAdapter: expected one of ${SKILL_SEARCH_ADAPTERS.join(', ')}`);
  }
  return value;
}

// The owner statement keys this organization accepts (#753), as
// `{ name, store, alg, fingerprint }`, or null when it declares none. The
// profile validates them; a hand-written config is held to the same rule,
// and a malformed list fails the config load.
export function ownerKeysSetting(config = loadConfig()) {
  const value = settingsSection(config).ownerKeys;
  if (value === undefined) return null;
  const problem = ownerKeysProblem(value);
  if (problem) throw new Error(`invalid settings.ownerKeys: ${problem}`);
  return value;
}

function validateSettings(config) {
  const settings = settingsSection(config);
  validateOwner(config);
  if (settings.spacesRoot !== undefined) spacesRootSetting(config);
  if (settings.soulsRoot !== undefined) soulsRootSetting(config);
  if (settings.daemonPreference !== undefined) validateDaemonPreference(settings.daemonPreference);
  if (settings.unmanagedAuthors !== undefined) unmanagedAuthorsSetting(config);
  soulCoauthorDomainSetting(config);
  skillSearchAdapterSetting(config);
  ownerKeysSetting(config);
  keydSignerSetting(config);
  rosterScope(config);
  validateFeatures(config);
}

function validateFeatures(config) {
  if (config.features !== undefined) {
    if (!config.features || typeof config.features !== 'object' || Array.isArray(config.features)) {
      throw new Error('agent-bot config features must be an object');
    }
    for (const [name, enabled] of Object.entries(config.features)) {
      if (!FEATURE_GATES.includes(name)) throw new Error(`unknown feature gate: ${name}`);
      if (typeof enabled !== 'boolean') throw new Error(`invalid features.${name}: expected true or false`);
    }
  }
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
// list (organization-profile-schema.mjs is a shared leaf with no import cycle
// with this module, unlike detect-harness.mjs). `vscode` is retained for the pre-copilot Apps that
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
