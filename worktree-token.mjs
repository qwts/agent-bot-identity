#!/usr/bin/env node
// Print a GH_TOKEN for the bot identity this process acts as, or nothing when
// no bot identity resolves here. Used by the gh shim (install-gh-shim.mjs) so
// API calls made as a bot authenticate as that bot automatically.
//
// Exit contract (the shim depends on it):
//   0 + token on stdout  -> a bot identity resolved, token ready
//   0 + empty stdout     -> no bot identity here: the human persona (delegate
//                           mode, ENG-0339), and the shim runs stock gh
//   non-zero             -> a bot identity resolved but the mint FAILED; caller
//                           must abort rather than fall back to the human
//
// Identity is the shared resolver's answer (resolve-agent.mjs): explicit
// GH_AGENT_APP, then the checkout's pin, then the account — with the
// credential-helper line setup-worktree baked into a configured checkout as a
// last signal, so git and gh can never disagree. Environment markers alone
// never mint: in the owner's account a harness that was not told to be the
// bot is the delegate and gets stock gh. The directory is not consulted at
// all — a primary checkout in an agent account mints like any other.
//
// Tokens are cached per checkout inside the private git dir (never in the
// working tree) and reused until 5 minutes before expiry. Outside a
// repository the cache lives in the account's private agent-bot state
// directory, keyed by App.

import process from 'node:process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { mint } from './mint-token.mjs';
import { accountHarness, accountName, detectAgentHarness } from './detect-harness.mjs';
import { loadConfig, slugForHarness } from './config.mjs';
import { resolveAgentSlug } from './resolve-agent.mjs';
import { stateDirectory } from './agent-identity.mjs';

function git(...args) {
  // stdio pipes throughout: execFileSync otherwise passes git's stderr
  // through to the parent, leaking "fatal: not a git repository" noise into
  // every human-context invocation.
  return execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

// The credential-helper line baked in by setup-worktree marks a checkout that
// was configured as a bot even where the pin cannot be read.
export function helperSlug(helperLines) {
  for (const line of (helperLines ?? '').split('\n').reverse()) {
    const m = line.match(/(?:git-credential-bot\.mjs|agent-bot'?\s+credential)'?\s+(\S+)\s*$/);
    if (m) return m[1];
  }
  return null;
}

// The account's own App slug — the exact roster match the shell hooks and the
// gh shim consult instead of a name glob, so shell and JS agree on what an
// agent account is (ENG-0339). Null in the owner's account.
export function accountSlug(env = process.env, config = loadConfig({ env })) {
  return slugForHarness(accountHarness(config, accountName(env)), config);
}

// Resolution order: the shared resolver's selection (explicit, launcher, pin,
// account) outranks everything; a pin read separately covers callers that
// have no resolver result; the helper line is the last signal. Nothing here
// looks at the directory.
export function resolveSlug({ selected = null, pinned = null, helperLines = '' } = {}) {
  return selected || pinned || helperSlug(helperLines);
}

// Back-compat name used by the gh shim's earlier tests.
export function worktreeSlug(helperLines, pinned) {
  return resolveSlug({ pinned, helperLines });
}

function cachePath(gitDir, slug) {
  if (gitDir) return join(gitDir, 'agent-bot-token.json');
  const dir = join(stateDirectory(), 'tokens');
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  return join(dir, `${slug}.json`);
}

async function main() {
  // Agent-process detection is intentionally independent of the current
  // repository. The gh shim uses it for the Codex desktop compatibility path.
  if (process.argv.includes('--agent-slug')) {
    const agentSlug = detectAgentHarness(process.env);
    if (agentSlug) process.stdout.write(`${agentSlug}\n`);
    return;
  }
  // --account-slug: is this an agent account, answered by the roster, for the
  // shell hooks and the shim.
  if (process.argv.includes('--account-slug')) {
    const slug = accountSlug(process.env);
    if (slug) process.stdout.write(`${slug}\n`);
    return;
  }

  let gitDir = null;
  try {
    gitDir = git('rev-parse', '--absolute-git-dir');
  } catch {
    // Not a repository. The account and a launcher's GH_AGENT_APP still
    // answer; only the repo-derived signals are absent.
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
  // directory into a bot.
  let toplevel = null;
  try {
    toplevel = git('rev-parse', '--show-toplevel');
  } catch {
    /* bare or odd repo — the pin is read from the cwd instead */
  }
  const config = loadConfig();
  const cwd = process.cwd();
  const selected = resolveAgentSlug({ cwd: toplevel ?? cwd, config, detect: false });
  const slug = resolveSlug({ selected, helperLines: helpers });
  // --slug: identity only, no mint, no network — the gh shim's `whoami`.
  if (process.argv.includes('--slug')) {
    if (slug) process.stdout.write(`${slug}\n`);
    return;
  }
  if (!slug) return; // human persona — print nothing

  const cache = cachePath(gitDir, slug);
  try {
    const cached = JSON.parse(readFileSync(cache, 'utf8'));
    if (cached.slug === slug && Date.parse(cached.expires_at) - Date.now() > 5 * 60 * 1000) {
      process.stdout.write(`${cached.token}\n`);
      return;
    }
  } catch {
    /* no usable cache */
  }

  const grant = await mint({ slug });
  try {
    writeFileSync(cache, `${JSON.stringify({ slug, token: grant.token, expires_at: grant.expires_at })}\n`, {
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
