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
import { detectHarness, HARNESSES } from './detect-harness.mjs';
import {
  appLifecycleStatus,
  harnessForSlug,
  loadConfig,
  slugForHarness,
} from './config.mjs';

// Pin keys written by setup-worktree. Prefer the standalone name; accept the
// playbook-engineering name so a migrated machine keeps working.
export const PIN_KEYS = ['agentBot.app', 'qwts.agentApp'];
export const AGENT_ID_KEYS = ['agentBot.agentId', 'qwts.agentId'];
export const CHAINED_HOOKS_KEYS = ['agentBot.chainedHooksPath', 'qwts.chainedHooksPath'];

const KNOWN_HARNESSES = new Set(HARNESSES.map(({ key }) => key));

// A worktree directory is an ownership boundary, not merely a convenience for
// discovering credentials. A launcher can inherit another tool's environment,
// but it cannot make a Claude worktree out of .codex/worktrees.
//
// The Claude Code session scratchpad chain —
// `<tmp>/claude-<uid>/<munged-project>/<session-uuid>/scratchpad` — is the
// same kind of boundary: harness-created, session-scoped, Claude's by
// construction. It lives here rather than in worktree-token so token minting
// and every other consumer answer ownership identically (ENG-0079) — an
// inherited CODEX_*/GH_AGENT_APP marker must no more mint a Codex token from
// a Claude scratchpad than from a Claude worktree. Root-agnostic like the
// worktrees rule: macOS says /private/tmp where Linux says /tmp.
const SCRATCHPAD_RE =
  /(?:^|\/)claude-\d+\/[^/]+\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/scratchpad(?=\/|$)/;

export function scratchpadRoot(cwd) {
  if (!cwd) return null;
  const m = cwd.match(SCRATCHPAD_RE);
  if (!m) return null;
  return cwd.slice(0, m.index + m[0].length);
}

export function territoryHarness(cwd = process.cwd()) {
  const match = cwd.match(/(?:^|\/)\.([a-z]+)\/worktrees\//);
  if (match && KNOWN_HARNESSES.has(match[1])) return match[1];
  if (scratchpadRoot(cwd)) return 'claude';
  return null;
}

// Default pin reader: inherits the caller's full process environment, which is
// correct for the CLI entrypoints (the runtime *should* see the real machine).
// Probes that must be hermetic — readiness, tests — pass their own `git`
// runner so every subprocess sees one consistent environment instead of a mix
// of injected and ambient state.
function defaultGitRunner(args, { cwd }) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

export function readGitConfig(cwd, keys, { git = defaultGitRunner } = {}) {
  for (const key of keys) {
    try {
      const value = (git(['config', '--get', key], { cwd }) ?? '').trim();
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
        { cause: error },
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
export function pinnedSlug(cwd = process.cwd(), options = {}) {
  return readGitConfig(cwd, PIN_KEYS, options);
}

function harnessOwnsTerritory(appSlug, territory, config) {
  const harness = harnessForSlug(appSlug, config);
  return (harness === 'claude-code' ? 'claude' : harness) === territory;
}

function requireActiveProfileApp(appSlug, config) {
  if (appLifecycleStatus(appSlug, config) === 'retired') {
    throw new Error('selected App is retired by the installed organization profile');
  }
  return appSlug;
}

export function resolveAgentSlug({
  explicit = null,
  env = process.env,
  cwd = process.cwd(),
  config,
  worktree = false,
  git,
} = {}) {
  const cfg = config ?? loadConfig({ env });
  const territory = worktree ? territoryHarness(cwd) : null;
  if (territory) {
    const territorySlug = slugForHarness(territory, cfg);
    if (!territorySlug) return null;
    if (explicit) {
      requireActiveProfileApp(explicit, cfg);
      if (!harnessOwnsTerritory(explicit, territory, cfg)) {
        throw new Error(`explicit App ${explicit} conflicts with ${territory} worktree territory`);
      }
      return explicit;
    }
    const launched = env.GH_AGENT_APP;
    if (launched) requireActiveProfileApp(launched, cfg);
    if (launched && harnessOwnsTerritory(launched, territory, cfg)) return launched;
    const pinned = pinnedSlug(cwd, { git });
    if (pinned) requireActiveProfileApp(pinned, cfg);
    if (pinned && harnessOwnsTerritory(pinned, territory, cfg)) return pinned;
    return territorySlug;
  }
  if (explicit) return requireActiveProfileApp(explicit, cfg);
  if (env.GH_AGENT_APP) return requireActiveProfileApp(env.GH_AGENT_APP, cfg);
  const pinned = pinnedSlug(cwd, { git });
  if (pinned) return requireActiveProfileApp(pinned, cfg);
  return slugForHarness(detectHarness(env), cfg);
}
