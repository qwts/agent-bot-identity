// User configuration and harness → bot-slug mapping.
//
// Config lives at ~/.config/agent-bot/config.json (override with
// AGENT_BOT_CONFIG). Everything is optional — with no App mapping the identity
// tools are inert no-ops, so cloning this repo can never hijack a machine's
// identity. Secret-free settings may still select local runtime policy.
//
//   {
//     "prefix": "yourname",              // slug = <prefix>-<harness>-agent
//     "apps": { "claude": "custom" },    // per-harness overrides of that pattern
//     "owner": "your-org",               // pick the App installation by account
//     "apiBase": "https://api.github.com", // GitHub Enterprise Server / ghe.com
//     "settings": {                        // durable, secret-free user policy
//       "spacesRoot": "/absolute/path",
//       "daemonPreference": "off"          // off | prefer | required
//     }
//   }

import process from 'node:process';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';

const DAEMON_PREFERENCES = new Set(['off', 'prefer', 'required']);

export function loadConfig({ home = homedir(), env = process.env } = {}) {
  const path = env.AGENT_BOT_CONFIG ?? join(home, '.config', 'agent-bot', 'config.json');
  let raw;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (err) {
    if (err?.code === 'ENOENT') return {}; // genuinely absent — identity stays inert
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
// override and XDG fallback so it can preserve the 0.x path compatibility
// behavior governed by ENG-0172.
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

function validateSettings(config) {
  const settings = settingsSection(config);
  if (settings.spacesRoot !== undefined) spacesRootSetting(config);
  if (settings.daemonPreference !== undefined) validateDaemonPreference(settings.daemonPreference);
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

// Harness keys recognised in an App slug. Kept local rather than imported from
// detect-harness.mjs, which imports this module — the two lists are tied
// together by a test instead of by a cycle. `vscode` is retained for the
// pre-copilot Apps that still carry it.
const SLUG_HARNESSES = ['claude', 'codex', 'cursor', 'copilot', 'devin', 'vscode'];

// Map an App slug back to its harness key. Used by execution-identity records
// when there is no local agents roster (standalone clone).
export function harnessForSlug(appSlug, config = loadConfig()) {
  if (!appSlug) return null;
  for (const [key, slug] of Object.entries(config.apps ?? {})) {
    if (slug === appSlug) return key === 'claude' ? 'claude-code' : key;
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
