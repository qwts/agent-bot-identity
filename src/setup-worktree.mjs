#!/usr/bin/env node
// One-shot bot-identity setup for the current git worktree. Invoked by the
// post-checkout hook in ../hooks (which git runs on `git worktree add` no
// matter what tool created the worktree), so it needs no per-IDE session
// mechanism. Exits 0 quietly whenever it has nothing to do, and configures
// nothing outside the worktree it runs in.
//
//   node src/setup-worktree.mjs [app-slug]
//
// Identity resolution, first hit wins: explicit arg, GH_AGENT_APP, the git
// config value `agentBot.app` (pin a checkout to one identity), then harness
// auto-detection mapped through ~/.config/agent-bot/config.json.
//
// What it applies, all scoped via extensions.worktreeConfig:
//   - author/committer identity = <slug>[bot] with the bot's noreply email
//   - commit signing off (a human key would show Unverified on bot commits)
//   - credential helper = git-credential-bot.mjs, so pushes mint on demand
//   - rewrites an SSH origin URL to HTTPS (SSH would push as the human)
//
// Guard: it only touches LINKED worktrees (git-dir != common-dir). A primary
// checkout is left alone, so a human's own clone never silently becomes
// bot-authored.

import process from 'node:process';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { loadConfig, apiBase, resolveSlug } from './config.mjs';
import { mint } from './mint-token.mjs';

function git(...args) {
  return execFileSync('git', args, { encoding: 'utf8' }).trim();
}

async function botUid(slug, base) {
  const cachePath = join(homedir(), '.config', slug, 'bot-uid');
  try {
    return readFileSync(cachePath, 'utf8').trim();
  } catch {
    /* not cached yet */
  }
  const lookup = (headers = {}) =>
    fetch(`${base}/users/${encodeURIComponent(`${slug}[bot]`)}`, {
      headers: { accept: 'application/vnd.github+json', 'user-agent': 'agent-bot-identity', ...headers },
    });
  let res = await lookup();
  if (!res.ok) {
    // Enterprise-owned Apps can be externally invisible (EMU); the App can
    // always see its own bot user, so retry authenticated as the App.
    const { token } = await mint({ slug });
    res = await lookup({ authorization: `Bearer ${token}` });
  }
  if (!res.ok) throw new Error(`could not resolve ${slug}[bot]'s user id (HTTP ${res.status})`);
  const uid = String((await res.json()).id);
  mkdirSync(dirname(cachePath), { recursive: true });
  writeFileSync(cachePath, `${uid}\n`);
  return uid;
}

async function main() {
  let gitDir;
  let commonDir;
  try {
    gitDir = git('rev-parse', '--absolute-git-dir');
    commonDir = git('rev-parse', '--path-format=absolute', '--git-common-dir');
  } catch {
    return; // not inside a git repository — nothing to do
  }
  if (gitDir === commonDir) return; // primary checkout, not an agent worktree

  let gitConfigSlug = null;
  try {
    gitConfigSlug = git('config', '--get', 'agentBot.app') || null;
  } catch {
    /* unset */
  }
  const config = loadConfig();
  const slug = process.argv[2] ?? resolveSlug({ argv: [], env: process.env, config, gitConfigSlug });
  if (!slug) return; // no identity resolved — a human worktree stays human

  const base = apiBase(config);
  const uid = await botUid(slug, base);
  const noreplyHost = new URL(base).host.replace(/^api\./, '');
  const helper = join(dirname(fileURLToPath(import.meta.url)), 'git-credential-bot.mjs');

  git('config', 'extensions.worktreeConfig', 'true');
  git('config', '--worktree', 'user.name', `${slug}[bot]`);
  git('config', '--worktree', 'user.email', `${uid}+${slug}[bot]@users.noreply.${noreplyHost}`);
  git('config', '--worktree', 'commit.gpgsign', 'false');
  try {
    git('config', '--worktree', '--unset-all', 'credential.helper');
  } catch {
    /* nothing to unset on first run */
  }
  git('config', '--worktree', '--add', 'credential.helper', '');
  git('config', '--worktree', '--add', 'credential.helper', `!node ${helper} ${slug}`);

  try {
    const origin = git('remote', 'get-url', 'origin');
    const sshMatch = origin.match(/^(?:ssh:\/\/)?git@([^:/]+)[:/](.+?)(?:\.git)?$/);
    if (sshMatch) git('remote', 'set-url', 'origin', `https://${sshMatch[1]}/${sshMatch[2]}`);
  } catch {
    /* no origin remote — fine */
  }

  process.stdout.write(`worktree configured for ${slug}[bot]\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(`setup-worktree: ${err.message}`);
    process.exit(1);
  });
}
