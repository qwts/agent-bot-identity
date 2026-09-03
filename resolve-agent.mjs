// One resolution order for every consumer that needs to know which agent it is.
// The account is the persona, the pin refines — but only if every path to a
// token asks the same question the same way (ENG-0079, ENG-0339).
//
//   explicit --app / argument   — the caller knows exactly what it wants
//   GH_AGENT_APP                — a launcher told this whole process
//   git config agentBot.app     — the pin (also reads qwts.agentApp)
//   accountHarness(config)      — the macOS account IS an agent persona (ENG-0339)
//   detectHarness(env) + config — the tool that is running, mapped to a slug;
//                                 opt-out with `detect: false` (see below)
//
// Each step is optional: no pin, no agent account, and no harness markers just
// means no identity, which is what the owner's own checkout should resolve to.
// What is *not* optional is the difference between a pin that is absent and a
// pin that could not be read — see pinnedSlug.
//
// The directory a checkout lives in is never an input (ENG-0339 supersedes
// ENG-0045): `.<tool>/worktrees/` is each harness's working layout inside its
// own account, and it neither grants nor vetoes an identity. An explicit App
// therefore never conflicts with anything — it is simply the answer.

import process from 'node:process';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { accountHarness, accountName, detectHarness } from './detect-harness.mjs';
import { PROFILE_HARNESSES } from './organization-profile.mjs';
import { appLifecycleStatus, loadConfig, slugForHarness } from './config.mjs';

// Pin keys written by setup-worktree. Prefer the standalone name; accept the
// playbook-engineering name so a migrated machine keeps working.
export const PIN_KEYS = ['agentBot.app', 'qwts.agentApp'];
export const AGENT_ID_KEYS = ['agentBot.agentId', 'qwts.agentId'];
export const CHAINED_HOOKS_KEYS = ['agentBot.chainedHooksPath', 'qwts.chainedHooksPath'];

// Layout recognition speaks the full profile vocabulary, not just the
// env-detectable subset — `.goose/worktrees/` is goose's layout even though no
// env matcher for goose exists.
const KNOWN_HARNESSES = new Set(PROFILE_HARNESSES);

// Which harness's worktree LAYOUT a path sits in, or null. Advisory only: the
// `.<tool>/worktrees` segment at any root says which tool placed the worktree
// there (doctor reports it as evidence, setup-worktree names it in a repair
// message). It is not an identity input and no consumer may treat it as one.
export function territoryHarness(cwd = process.cwd()) {
  const match = (cwd ?? '').match(/(?:^|\/)\.([a-z]+)\/worktrees\//);
  if (match && KNOWN_HARNESSES.has(match[1])) return match[1];
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
// through to the account. A malformed config, an ambiguous pin (two values), or
// a config we lack permission to read all mean *the pin could not be checked*
// — and falling back there produces exactly the split identity this module
// exists to prevent: commits authored as the pinned agent, tokens minted for
// the account. Those fail closed. Only `git config` exit 1, the key genuinely
// not being set, returns null.
export function pinnedSlug(cwd = process.cwd(), options = {}) {
  return readGitConfig(cwd, PIN_KEYS, options);
}

function requireActiveProfileApp(appSlug, config) {
  if (appLifecycleStatus(appSlug, config) === 'retired') {
    throw new Error('selected App is retired by the installed organization profile');
  }
  return appSlug;
}

// `detect` — whether environment markers (CLAUDECODE, CODEX_*, …) may answer
// when nothing above them does. They are a convenience for a deliberate CLI
// request (`agent-bot mint-token` typed inside a harness). Anything that acts
// without being asked — the gh shim, the credential path, hook-driven worktree
// setup — passes `detect: false`, because ENG-0339 makes bot identity in the
// owner's account a stated choice (--app, GH_AGENT_APP, a pin) and never an
// inference: unpinned work there is the human's, done by a delegate. In an
// agent account the account rung answers first either way.
export function resolveAgentSlug({
  explicit = null,
  env = process.env,
  cwd = process.cwd(),
  config,
  git,
  account = accountName(env),
  detect = true,
} = {}) {
  const cfg = config ?? loadConfig({ env });
  if (explicit) return requireActiveProfileApp(explicit, cfg);
  if (env.GH_AGENT_APP) return requireActiveProfileApp(env.GH_AGENT_APP, cfg);
  const pinned = pinnedSlug(cwd, { git });
  if (pinned) return requireActiveProfileApp(pinned, cfg);
  // ENG-0339: the account is the persona, so its input outranks environment
  // detection — a harness account resolves to its own App whatever tool runs
  // there. In the owner's account it yields nothing.
  const accountKey = accountHarness(cfg, account);
  if (accountKey) return slugForHarness(accountKey, cfg);
  if (!detect) return null;
  return slugForHarness(detectHarness(env), cfg);
}
