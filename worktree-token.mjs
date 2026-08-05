#!/usr/bin/env node
// Print a GH_TOKEN for the bot identity of the CURRENT worktree, or nothing
// when this isn't a bot worktree. Used by the gh shim (install-gh-shim.mjs)
// so API calls made from bot territory authenticate as the bot automatically.
//
// Exit contract (the shim depends on it):
//   0 + token on stdout  -> bot worktree, token ready
//   0 + empty stdout     -> not a bot worktree; the shim separately decides
//                           whether this is a human shell or a blocked agent
//   non-zero             -> bot worktree but the mint FAILED; caller must
//                           abort rather than fall back to the human
//
// The worktree's identity is whatever setup-worktree baked into it — the same
// config.worktree that governs commits, so git and gh can never disagree.
// Tokens are cached per worktree inside the private git dir (never in the
// working tree) and reused until 5 minutes before expiry. Scratchpad
// territory has no git dir; its cache lives inside the session-private
// scratchpad itself.

import process from 'node:process';
import { readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { desktopConfigPath, worktreeRoot } from './claude-worktree-create.mjs';
import { mint } from './mint-token.mjs';
import { detectAgentHarness, HARNESSES } from './detect-harness.mjs';
import { loadConfig, slugForHarness } from './config.mjs';
import { resolveAgentSlug, scratchpadRoot } from './resolve-agent.mjs';

const KNOWN_TOOLS = new Set(HARNESSES.map((h) => h.key));

function git(...args) {
  // stdio pipes throughout: execFileSync otherwise passes git's stderr
  // through to the parent, leaking "fatal: not a git repository" noise into
  // every human-context invocation.
  return execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

// The `.<tool>/worktrees` segment is the signal; the root above it is not.
// A workstation whose boot volume is too small keeps agent worktrees on
// `/Volumes/<drive>/.claude/worktrees` — a fact about the hardware, never a
// statement about who owns the work.
export function pathSlug(toplevel, config = loadConfig()) {
  if (!toplevel) return null;
  const m = toplevel.match(/(?:^|\/)\.([a-z]+)\/worktrees\//);
  if (!m) return null;
  // Only known harness tool dirs are territory — a random .<name>/worktrees
  // path must not invent a slug from the config prefix.
  if (!KNOWN_TOOLS.has(m[1])) return null;
  return slugForHarness(m[1], config);
}

// A relocation root need not contain the segment: `AGENT_WORKTREE_ROOT` and the
// desktop app's own preference take any directory, and both creators then build
// `<root>/<repo>/<name>`. Those worktrees are Claude's by configuration even
// though the path never says so.
//
// A root of `/` or the home directory itself would make every human checkout
// territory, so those are refused.
export function configuredRootSlug(toplevel, root, home, config = loadConfig()) {
  if (!toplevel || !root || root === '/' || root === home) return null;
  if (toplevel !== root && !toplevel.startsWith(`${root}/`)) return null;
  return slugForHarness('claude', config);
}

// Claude Code hands each session a private scratchpad directory and tells the
// agent to do its temporary file work there — bot land by construction,
// though it is not a repository and no worktree signal can ever appear in it.
// The chain rule itself lives in resolve-agent.mjs (territoryHarness /
// scratchpadRoot) so that token minting and agent selection answer scratchpad
// ownership identically; this module only maps the territory to its App slug.
export { scratchpadRoot };

export function scratchpadSlug(cwd, config = loadConfig()) {
  if (!scratchpadRoot(cwd)) return null;
  return slugForHarness('claude', config);
}

// The credential-helper line baked in by setup-worktree marks territory the
// path rule cannot see (an explicitly configured worktree elsewhere).
export function helperSlug(helperLines) {
  for (const line of (helperLines ?? '').split('\n').reverse()) {
    const m = line.match(/(?:git-credential-bot\.mjs|agent-bot'?\s+credential)'?\s+(\S+)\s*$/);
    if (m) return m[1];
  }
  return null;
}

// Resolution order: an explicit pin overrides WHICH bot but only inside
// territory; the directory is the primary territory signal; the helper line
// covers configured worktrees outside the directory pattern; the scratchpad
// chain is the last fallback, for the one bot place with no repository at
// all. A stray pin in a normal clone still never makes the shim mint — a pin
// alone is not territory.
export function resolveSlug({
  selected = null,
  pinned = null,
  toplevel,
  helperLines,
  configuredRoot = null,
  home = null,
  cwd = null,
  config = loadConfig(),
}) {
  const territory =
    pathSlug(toplevel, config) ??
    configuredRootSlug(toplevel, configuredRoot, home, config) ??
    helperSlug(helperLines) ??
    scratchpadSlug(cwd, config);
  if (!territory) return null;
  return selected || pinned || territory;
}

// Back-compat name used by the gh shim's earlier tests.
export function worktreeSlug(helperLines, pinned) {
  return resolveSlug({ pinned, toplevel: null, home: null, helperLines });
}

async function main() {
  // Agent-process detection is intentionally independent of the current
  // repository. The gh shim uses it to fail closed before a stock human
  // credential can be exercised from a primary checkout or non-repo path.
  if (process.argv.includes('--agent-slug')) {
    const agentSlug = detectAgentHarness(process.env);
    if (agentSlug) process.stdout.write(`${agentSlug}\n`);
    return;
  }

  let gitDir = null;
  try {
    gitDir = git('rev-parse', '--absolute-git-dir');
  } catch {
    // Not a repository. Once this meant human context unconditionally; the
    // scratchpad rule is the one territory signal that needs no repo, so
    // resolution continues with every repo-derived signal absent.
  }
  let helpers = '';
  if (gitDir) {
    try {
      helpers = git('config', '--get-all', 'credential.helper');
    } catch {
      /* none configured */
    }
  }
  // The gate matters: outside a repo `git config --get-all` reads the global
  // scope, and a bot helper line there must not turn every non-repo
  // directory into territory.
  let toplevel = null;
  try {
    toplevel = git('rev-parse', '--show-toplevel');
  } catch {
    /* bare or odd repo — path rule cannot apply */
  }
  let configuredRoot = null;
  try {
    let desktopConfig = null;
    try {
      desktopConfig = readFileSync(desktopConfigPath(), 'utf8');
    } catch {
      /* no desktop config on this machine */
    }
    configuredRoot = worktreeRoot({ desktopConfig });
  } catch {
    /* a malformed preference must never break identity resolution */
  }
  const config = loadConfig();
  const cwd = process.cwd();
  const selected = resolveAgentSlug({ cwd: toplevel ?? cwd, config, worktree: true });
  const slug = resolveSlug({
    selected,
    toplevel,
    helperLines: helpers,
    configuredRoot,
    home: homedir(),
    cwd,
    config,
  });
  // --slug: identity only, no mint, no network — the gh shim's `whoami`.
  if (process.argv.includes('--slug')) {
    if (slug) process.stdout.write(`${slug}\n`);
    return;
  }
  if (!slug) return; // human worktree — print nothing

  // Scratchpad territory has no private git dir; the cache lives inside the
  // scratchpad itself — session-private, 0600, gone with the session's tmp.
  const cachePath = gitDir
    ? join(gitDir, 'agent-bot-token.json')
    : join(scratchpadRoot(cwd), '.agent-bot-token.json');
  try {
    const cached = JSON.parse(readFileSync(cachePath, 'utf8'));
    if (cached.slug === slug && Date.parse(cached.expires_at) - Date.now() > 5 * 60 * 1000) {
      process.stdout.write(`${cached.token}\n`);
      return;
    }
  } catch {
    /* no usable cache */
  }

  const grant = await mint({ slug });
  try {
    writeFileSync(cachePath, `${JSON.stringify({ slug, token: grant.token, expires_at: grant.expires_at })}\n`, {
      mode: 0o600,
    });
  } catch {
    // Best-effort: a linked worktree's git dir lives under the MAIN
    // checkout, which sandboxed harnesses (Codex) may not allow writes to.
    // An uncached mint still succeeds — only a failed MINT may abort.
  }
  process.stdout.write(`${grant.token}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(`worktree-token: ${err.message}`);
    process.exit(1);
  });
}
