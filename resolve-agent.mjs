// One resolution order for every consumer that needs to know which agent it is.
// The harness detects, the pin refines — but only if every path to a token asks
// the same question the same way (ENG-0079).
//
//   explicit --app / argument   — the caller knows exactly what it wants
//   GH_AGENT_APP                — a launcher told this whole process
//   git config agentBot.app     — the pin (also reads qwts.agentApp)
//   detectHarness(env) + config — the tool that is running, mapped to a slug
//
// Each step is optional: no pin and no harness markers just means no identity,
// which is what a plain human checkout should resolve to. What is *not*
// optional is the difference between a pin that is absent and a pin that could
// not be read — see pinnedSlug.

import process from 'node:process';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { detectHarness } from './detect-harness.mjs';
import { loadConfig, slugForHarness } from './config.mjs';

// Pin keys written by setup-worktree. Prefer the standalone name; accept the
// playbook-engineering name so a migrated machine keeps working.
export const PIN_KEYS = ['agentBot.app', 'qwts.agentApp'];
export const AGENT_ID_KEYS = ['agentBot.agentId', 'qwts.agentId'];
export const CHAINED_HOOKS_KEYS = ['agentBot.chainedHooksPath', 'qwts.chainedHooksPath'];

export function readGitConfig(cwd, keys) {
  for (const key of keys) {
    try {
      const value = execFileSync('git', ['config', '--get', key], {
        cwd,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      }).trim();
      if (value) return value;
    } catch (error) {
      if (error.status === 1) continue; // unset for this key
      if (error.code === 'ENOENT') {
        if (!existsSync(cwd)) throw new Error(`cannot resolve an agent for a directory that does not exist: ${cwd}`);
        return null;
      }
      const detail = (error.stderr ?? '').toString().trim() || `git config exited ${error.status ?? 'abnormally'}`;
      throw new Error(
        `could not read the ${key} pin in ${cwd}: ${detail}. ` +
          'Refusing to fall back to harness detection — an unverifiable pin is not an absent one.',
      );
    }
  }
  return null;
}

// Unset and unverifiable are different answers, and only one of them may fall
// through to detection. A malformed config, an ambiguous pin (two values), or
// a config we lack permission to read all mean *the pin could not be checked*
// — and falling back there produces exactly the split identity this module
// exists to prevent: commits authored as the pinned agent, tokens minted for
// the harness. Those fail closed. Only `git config` exit 1, the key genuinely
// not being set, returns null.
export function pinnedSlug(cwd = process.cwd()) {
  return readGitConfig(cwd, PIN_KEYS);
}

export function resolveAgentSlug({
  explicit = null,
  env = process.env,
  cwd = process.cwd(),
  config,
} = {}) {
  if (explicit) return explicit;
  if (env.GH_AGENT_APP) return env.GH_AGENT_APP;
  const pinned = pinnedSlug(cwd);
  if (pinned) return pinned;
  const cfg = config ?? loadConfig({ env });
  return slugForHarness(detectHarness(env), cfg);
}
