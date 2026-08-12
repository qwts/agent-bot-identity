#!/usr/bin/env node
// One-shot bot-identity setup for the current git worktree.
// Harness-agnostic: git's post-checkout hook invokes it regardless of which
// tool created the worktree. Provider transcript adapters are inputs to the
// vendor-neutral execution-identity contract. Exits 0 quietly whenever it has
// nothing to do, and configures nothing outside the worktree it runs in.
//
//   agent-bot setup-worktree [app-slug]
//
// Slug resolution, first hit wins: explicit arg, then $GH_AGENT_APP, then the
// git config value `agentBot.app`. The resolved App is persisted as the
// worktree pin, so later token minters and the gh shim cannot fall back to a
// different harness identity. Resolution itself lives in resolve-agent.mjs,
// shared with the token minters so a pinned worktree commits and pushes as
// the same agent.
//
// What it does, all scoped via extensions.worktreeConfig:
//   - author/committer identity = <slug>[bot] with the bot's noreply email
//   - commit signing off (the human's key would show Unverified on bot commits)
//   - credential helper = git-credential-bot.mjs, so pushes mint on demand
//   - rewrites an SSH origin URL to HTTPS (SSH would push as the human)
//   - pins core.hooksPath here while chaining any previous hooks path
//   - mints/binds a transcript-bound Agent ID (ENG-0081)
//   - initializes that soul's durable Agent Space
//   - registers the soul in the workstation population census
//
// Guard: it only touches LINKED worktrees (git-dir != common-dir). A session
// in a primary checkout is left alone, so a human's own clone never silently
// becomes bot-authored.

import process from 'node:process';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { resolveAgentSlug, pinnedSlug, territoryHarness, AGENT_ID_KEYS } from './resolve-agent.mjs';
import { loadConfig, apiBase, githubHost, harnessForSlug } from './config.mjs';
import { reconcileAppCredentials } from './credential-reconciler.mjs';
import {
  discoverTranscript,
  ensureAgentIdentity,
  identityFieldsFromEnv,
  stateDirectory,
} from './agent-identity.mjs';
import { initAgentSpace } from './agent-space.mjs';
import { upsertIdentitySoul } from './agent-population.mjs';

function git(...args) {
  return execFileSync('git', args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

export function validateAppSlug(slug) {
  if (!/^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/.test(slug)) {
    throw new Error(`invalid GitHub App slug: ${JSON.stringify(slug)}`);
  }
  return slug;
}

export function credentialHelperCommand(helper, slug, { subcommand = null } = {}) {
  // Git executes ! helpers through a POSIX shell, including under Git Bash.
  // fileURLToPath returns backslashes on Windows; the shell consumes those as
  // escapes unless the path is normalized and quoted.
  const shellPath = normalizeGitBashPath(helper).replaceAll("'", "'\"'\"'");
  const runner = shellPath.endsWith('.mjs') ? 'node ' : '';
  const command = subcommand ? `${subcommand} ` : '';
  return `!${runner}'${shellPath}' ${command}${validateAppSlug(slug)}`;
}

export function normalizeGitBashPath(value) {
  return value.replaceAll('\\', '/');
}

export function httpsRemoteUrl(value) {
  const match = value.match(/^(?:ssh:\/\/)?[^@/\s]+@([^:/\s]+)[:/](.+?)(?:\.git)?$/);
  if (match) return `https://${match[1]}/${match[2]}`;
  if (/^(?:ssh:\/\/|[^/@\s]+@[^:\s]+:)/.test(value)) {
    throw new Error(`cannot safely rewrite SSH remote URL: ${value}`);
  }
  return value;
}

function rewriteOriginUrls() {
  let origin;
  try {
    origin = git('remote', 'get-url', 'origin');
  } catch {
    return; // no origin remote
  }
  const fetchUrl = httpsRemoteUrl(origin);
  if (fetchUrl !== origin) git('remote', 'set-url', 'origin', fetchUrl);

  let pushUrls = [];
  try {
    pushUrls = git('config', '--get-all', 'remote.origin.pushurl').split('\n').filter(Boolean);
  } catch {
    return; // pushes use the fetch URL, which is already safe
  }
  const safePushUrls = pushUrls.map(httpsRemoteUrl);
  if (safePushUrls.every((url, index) => url === pushUrls[index])) return;
  git('config', '--unset-all', 'remote.origin.pushurl');
  for (const url of safePushUrls) git('config', '--add', 'remote.origin.pushurl', url);
}

export async function botUid(slug, base, verifiedToken, {
  home = homedir(),
  fetchImpl = fetch,
} = {}) {
  const configDir = join(home, '.config', slug);
  const cachePath = join(configDir, 'bot-uid');
  const avatarPath = join(configDir, 'bot-avatar-url');
  let cachedUid = null;
  try {
    cachedUid = readFileSync(cachePath, 'utf8').trim() || null;
  } catch {
    /* not cached yet */
  }
  let cachedAvatar = null;
  try {
    cachedAvatar = readFileSync(avatarPath, 'utf8').trim() || null;
  } catch {
    /* not cached yet */
  }
  // An upgraded installation can hold a UID cached before the avatar cache
  // existed, and a non-numeric app-id (client ID) gives gh-pr-view-json no
  // fallback. Only a complete cache skips the profile lookup.
  if (cachedUid && cachedAvatar && /^https:\/\//.test(cachedAvatar)) return cachedUid;
  const lookup = (headers = {}) =>
    fetchImpl(`${base}/users/${encodeURIComponent(`${slug}[bot]`)}`, {
      headers: { accept: 'application/vnd.github+json', 'user-agent': 'agent-bot-identity', ...headers },
    });
  let profile = null;
  try {
    let res = await lookup();
    if (!res.ok) {
      // Enterprise-owned Apps can be externally invisible (EMU); the App can
      // always see its own bot user, so retry authenticated as the App.
      res = await lookup({ authorization: `Bearer ${verifiedToken}` });
    }
    if (!res.ok) throw new Error(`could not resolve ${slug}[bot]'s user id (HTTP ${res.status})`);
    profile = await res.json();
  } catch (error) {
    // The avatar is presentation, not identity: with a cached UID the worktree
    // is already bindable, so a failed refresh must not break setup.
    if (cachedUid) return cachedUid;
    throw error;
  }
  const uid = cachedUid ?? String(profile.id);
  mkdirSync(configDir, { recursive: true });
  if (!cachedUid) writeFileSync(cachePath, `${uid}\n`);
  if (typeof profile.avatar_url === 'string' && /^https:\/\//.test(profile.avatar_url)) {
    writeFileSync(avatarPath, `${profile.avatar_url}\n`);
  }
  return uid;
}

export async function main({
  reconcileCredentials = reconcileAppCredentials,
  rewriteOrigins = rewriteOriginUrls,
  resolveBotUid = botUid,
} = {}) {
  const config = loadConfig();
  let gitDir; let commonDir;
  try {
    gitDir = git('rev-parse', '--absolute-git-dir');
    commonDir = git('rev-parse', '--path-format=absolute', '--git-common-dir');
  } catch {
    return; // not inside a git repository — nothing to do
  }
  if (gitDir === commonDir) return; // primary checkout, not an agent worktree
  const previousSlug = pinnedSlug();
  const resolvedSlug = resolveAgentSlug({ explicit: process.argv[2], config, worktree: true });
  if (!resolvedSlug) return; // no identity resolved for this checkout — nothing to do
  const slug = validateAppSlug(resolvedSlug);
  const territory = territoryHarness();
  if (previousSlug && previousSlug !== slug && territory) {
    process.stderr.write(`setup-worktree: repaired ${previousSlug} to ${slug} for ${territory} territory\n`);
  }
  let verifiedToken = null;
  const [credential] = await reconcileCredentials({
    slugs: [slug],
    onVerified: (_verifiedSlug, grant) => {
      verifiedToken = grant.token;
    },
  });
  if (credential.local.status === 'restored') {
    process.stdout.write(`credential restored for ${slug}\n`);
  }
  // Eliminate every SSH push path only after the App credential is locally
  // ready and live-verified. A credential failure leaves the worktree wholly
  // untouched and still guarded as human territory.
  rewriteOrigins();
  const base = apiBase(config);
  const uid = await resolveBotUid(slug, base, verifiedToken);
  const host = githubHost(config);
  const installedRoot = join(homedir(), '.local');
  const helper = join(installedRoot, 'bin', 'agent-bot');
  const hooks = normalizeGitBashPath(join(installedRoot, 'share', 'agent-bot', 'hooks'));
  let previousHooks = null;
  try {
    previousHooks = normalizeGitBashPath(git('config', '--path', '--get', 'core.hooksPath')) || null;
  } catch {
    /* no hooks path was configured */
  }

  git('config', 'extensions.worktreeConfig', 'true');
  let currentAgentId = null;
  for (const key of AGENT_ID_KEYS) {
    try {
      currentAgentId = git('config', '--worktree', '--get', key) || null;
      if (currentAgentId) break;
    } catch {
      /* try next key */
    }
  }
  const executionIdentity = ensureAgentIdentity({
    currentId: currentAgentId,
    appSlug: slug,
    botUid: uid,
    harness: harnessForSlug(slug, config),
    transcript: discoverTranscript(),
    fields: identityFieldsFromEnv(),
    stateDir: stateDirectory(),
  });
  // Initialize and register before writing any worktree attribution. A missing,
  // corrupt, or mismatched space or census fails closed without leaving the
  // worktree partially bound.
  const space = initAgentSpace(executionIdentity.id);
  upsertIdentitySoul(executionIdentity.id, space.path);
  git('config', '--worktree', 'agentBot.app', slug);
  git('config', '--worktree', 'agentBot.agentId', executionIdentity.id);
  git('config', '--worktree', 'user.name', `${slug}[bot]`);
  git('config', '--worktree', 'user.email', `${uid}+${slug}[bot]@users.noreply.${host}`);
  git('config', '--worktree', 'commit.gpgsign', 'false');
  if (previousHooks && previousHooks !== hooks) {
    git('config', '--worktree', 'agentBot.chainedHooksPath', previousHooks);
  }
  git('config', '--worktree', 'core.hooksPath', hooks);
  try {
    git('config', '--worktree', '--unset-all', 'credential.helper');
  } catch {
    /* nothing to unset on first run */
  }
  git('config', '--worktree', '--add', 'credential.helper', '');
  git(
    'config',
    '--worktree',
    '--add',
    'credential.helper',
    credentialHelperCommand(helper, slug, { subcommand: 'credential' }),
  );

  const transcriptState = executionIdentity.transcript ? 'transcript bound' : 'transcript pending';
  const spaceState = space.created ? 'space created' : 'space ready';
  process.stdout.write(
    `worktree configured for ${slug}[bot] as ${executionIdentity.id} (${transcriptState}, ${spaceState})\n`,
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(`setup-worktree: ${err.message}`);
    process.exit(1);
  });
}
