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
//     (through the loopback daemon when settings.daemonPreference selects it;
//      see bindSoul for the prefer/required fallback policy)
//
// Guard: it acts only when a bot identity is STATED — an explicit App,
// GH_AGENT_APP, an existing pin — or the account is an agent account
// (ENG-0339), never on harness detection alone. A primary checkout is
// configured like any other when that holds (every checkout in an agent
// account is bot work); in the owner's account an unpinned clone resolves to
// nothing and is left alone, so a human's own checkout never silently becomes
// bot-authored. The `.<tool>/worktrees` directory is layout, not a signal.

import process from 'node:process';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { resolveAgentSlug, pinnedSlug, territoryHarness, AGENT_ID_KEYS } from './resolve-agent.mjs';
import { mintBindToken } from './agent-binding.mjs';
import { loadConfig, apiBase, daemonPreference, githubHost, harnessForSlug } from './config.mjs';
import { daemonClient } from './agent-daemon.mjs';
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
  try {
    mkdirSync(configDir, { recursive: true });
    if (!cachedUid) writeFileSync(cachePath, `${uid}\n`);
    if (typeof profile.avatar_url === 'string' && /^https:\/\//.test(profile.avatar_url)) {
      writeFileSync(avatarPath, `${profile.avatar_url}\n`);
    }
  } catch (error) {
    // A read-only config dir must not break a worktree that could bind before
    // this backfill existed: cache writes are best-effort on the cached path.
    if (!cachedUid) throw error;
  }
  return uid;
}

// One policy for how a soul reaches the shared stores (#43): when the local
// daemon is authoritative, setup registers and ensures space through it so
// population and drives cannot diverge by invocation path. `prefer` falls back
// in-process only when the daemon is UNREACHABLE — a reachable daemon that
// refuses an operation is a real conflict (a space bound to another soul, a
// corrupt census) that the in-process path would hit too, so it propagates.
// `required` fails closed when the daemon is down.
export async function bindSoul({ agentId, policy, client, ensureLocal, worktree = null }) {
  if (policy !== 'off') {
    const available = await client.available();
    if (available) {
      const space = await client.ensureSpace(agentId);
      await client.registerSoul(agentId, space.path, { worktree });
      return { ...space, via: 'daemon' };
    }
    if (policy === 'required') {
      throw new Error('daemon preference is "required" but the daemon is not reachable — start it with `agent-bot daemon start`');
    }
  }
  return { ...ensureLocal(), via: 'in-process' };
}

export async function main({
  reconcileCredentials = reconcileAppCredentials,
  rewriteOrigins = rewriteOriginUrls,
  resolveBotUid = botUid,
  daemon = null,
} = {}) {
  const config = loadConfig();
  let gitDir;
  try {
    gitDir = git('rev-parse', '--absolute-git-dir');
  } catch {
    return; // not inside a git repository — nothing to do
  }
  const previousSlug = pinnedSlug();
  const resolvedSlug = resolveAgentSlug({ explicit: process.argv[2], config, detect: false });
  if (!resolvedSlug) return; // no bot identity stated for this checkout — human persona, nothing to do
  const slug = validateAppSlug(resolvedSlug);
  if (previousSlug && previousSlug !== slug) {
    const layout = territoryHarness();
    process.stderr.write(
      `setup-worktree: repinning ${previousSlug} to ${slug}${layout ? ` (${layout} worktree layout)` : ''}\n`,
    );
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
  // ready and live-verified. A credential failure leaves the checkout wholly
  // untouched.
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
  // The census row records the checkout it is pinned to, so doctor can name
  // an active soul no checkout references (#192). Null in a bare repository.
  let worktree = null;
  try {
    worktree = git('rev-parse', '--show-toplevel') || null;
  } catch {
    /* no working tree to record */
  }
  // Initialize and register before writing any worktree attribution. A missing,
  // corrupt, or mismatched space or census fails closed without leaving the
  // worktree partially bound.
  const space = await bindSoul({
    agentId: executionIdentity.id,
    policy: daemonPreference({ config }),
    client: daemon ?? daemonClient(),
    worktree,
    ensureLocal: () => {
      const local = initAgentSpace(executionIdentity.id);
      upsertIdentitySoul(executionIdentity.id, local.path, { worktree });
      return local;
    },
  });
  if (currentAgentId && currentAgentId !== executionIdentity.id) {
    // A rotation is deliberate (a new conversation, an App change, a repin),
    // but it leaves the previous soul active with no checkout: say so here,
    // and doctor keeps saying so until it is retired.
    process.stderr.write(
      `setup-worktree: ${currentAgentId} is no longer pinned here; doctor lists it as unreferenced until it is retired\n`,
    );
  }
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

  // Proof of place for the MCP bind flow (#94). Inert until surrendered to
  // the daemon; re-minting on a later checkout replaces the file and is a
  // no-op for identity. Best-effort like the token cache above: a sandboxed
  // harness that cannot write the (shared) private git dir still gets a fully
  // configured worktree — it simply cannot bind until a mint succeeds.
  let bindState = 'bind token minted';
  try {
    mintBindToken({ gitDir, worktree: worktree ?? git('rev-parse', '--show-toplevel'), agentId: executionIdentity.id });
  } catch {
    bindState = 'bind token unavailable';
  }

  const transcriptState = executionIdentity.transcript ? 'transcript bound' : 'transcript pending';
  const spaceState = `${space.created ? 'space created' : 'space ready'}${space.via === 'daemon' ? ' via daemon' : ''}`;
  process.stdout.write(
    `worktree configured for ${slug}[bot] as ${executionIdentity.id} (${transcriptState}, ${spaceState}, ${bindState})\n`,
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(`setup-worktree: ${err.message}`);
    process.exit(1);
  });
}
