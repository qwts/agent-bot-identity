// User configuration and bot-slug resolution.
//
// Config lives at ~/.config/agent-bot/config.json (override the path with
// AGENT_BOT_CONFIG). Everything is optional — with no config the tools are
// inert no-ops, so cloning this repo can never hijack a machine's identity.
//
//   {
//     "prefix": "yourname",              // slug = <prefix>-<harness>-agent
//     "apps": { "claude": "custom" },    // per-harness overrides of that pattern
//     "owner": "your-org",               // pick the App installation by account
//                                        // when the App is installed on several
//     "apiBase": "https://api.github.com"  // GitHub Enterprise Server / ghe.com
//   }

import process from 'node:process';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { detectHarness } from './detect-harness.mjs';

export function loadConfig({ home = homedir(), env = process.env } = {}) {
  const path = env.AGENT_BOT_CONFIG ?? join(home, '.config', 'agent-bot', 'config.json');
  let raw;
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    return {}; // genuinely absent — the tools stay inert
  }
  try {
    return JSON.parse(raw.replace(/^\uFEFF/, ''));
  } catch (err) {
    // A present-but-broken config must fail loudly: silently treating it as
    // "no config" makes a typo indistinguishable from a missing file.
    throw new Error(`${path} exists but is not valid JSON: ${err.message}`);
  }
}

export function apiBase(config = loadConfig()) {
  return (config.apiBase ?? process.env.GITHUB_API_URL ?? 'https://api.github.com').replace(/\/+$/, '');
}

export function slugForHarness(harness, config) {
  if (!harness) return null;
  if (config.apps?.[harness]) return config.apps[harness];
  if (config.prefix) return `${config.prefix}-${harness}-agent`;
  return null;
}

// Resolve which bot identity applies right now. First hit wins:
//   1. an explicit --app <slug> argument
//   2. GH_AGENT_APP in the environment
//   3. gitConfigSlug, when the caller passes one (setup-worktree reads
//      `git config agentBot.app` so a checkout can pin its identity)
//   4. harness auto-detection mapped through the user config
// Returns null when nothing resolves — callers treat that as "do nothing".
export function resolveSlug({ argv = process.argv, env = process.env, config, gitConfigSlug = null } = {}) {
  const flag = argv.indexOf('--app');
  if (flag !== -1) {
    if (!argv[flag + 1]) throw new Error('--app requires a slug, e.g. --app yourname-claude-agent');
    return argv[flag + 1];
  }
  if (env.GH_AGENT_APP) return env.GH_AGENT_APP;
  if (gitConfigSlug) return gitConfigSlug;
  return slugForHarness(detectHarness(env), config ?? loadConfig({ env }));
}
