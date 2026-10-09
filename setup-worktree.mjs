#!/usr/bin/env node
// Configure only the session soul's repository work area. Identity is resolved
// before location is checked: a path is never an identity signal (ENG-0339).
import process from 'node:process';
import { execFileSync } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { existsSync, realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { resolveAgentSlug, pinnedSlug, AGENT_ID_KEYS } from './resolve-agent.mjs';
import { mintBindToken, readBinding } from './agent-binding.mjs';
import { loadConfig, isGateEnabled, apiBase, daemonPreference, githubHost } from './config.mjs';
import { daemonClient } from './agent-daemon.mjs';
import { reconcileAppCredentials } from './credential-reconciler.mjs';
import {
  discoverTranscript,
  readAgentIdentity,
} from './agent-identity.mjs';
import { ensureSoulSpace } from './soul-memory.mjs';
import { listSouls, showSoul, upsertIdentitySoul } from './agent-population.mjs';
import { readAppMetadata, writeAppMetadata } from './identity-app-store.mjs';
import { assertWorktreeArea, placeWorktree, soulWorktreePath } from './soul-worktrees.mjs';

const USAGE = `usage: agent-bot setup-worktree [app-slug] [--name NAME [--branch BRANCH]]

Check in first with agent-bot join --name NAME --harness HARNESS.
Configure an existing checkout in the session soul's worktrees/<name>, or a
checkout already linked from that soul. --name creates a linked git worktree
there if absent (branch defaults to NAME), then configures it.
Refuses primary checkouts outside the soul, arbitrary directories, conflicting
pins, and cross-device placement. No TMPDIR fallback. With no session soul it
leaves the checkout human and writes nothing (an error only with --name):
an agent checks in with agent-bot join first, whatever its harness.
`;

function parseArgs(argv) {
  const options = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--from-hook') options.hook = true;
    else if (arg === '--name' || arg === '--branch') {
      const value = argv[++i];
      if (!value || value.startsWith('-') || options[arg.slice(2)]) throw new Error(USAGE);
      options[arg.slice(2)] = value;
    } else if (!arg.startsWith('-') && !options.slug) options.slug = validateAppSlug(arg);
    else throw new Error(USAGE);
  }
  if (options.branch && !options.name) throw new Error('--branch requires --name');
  if (options.name && (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(options.name) || options.name.includes('..'))) {
    throw new Error('invalid worktree name: use 1–100 letters, numbers, dots, underscores or hyphens, starting with a letter or number');
  }
  return options;
}

// Never consult a checkout pin or directory to discover the session's soul.
function sessionIdentity() {
  const fromEnv = process.env.AGENT_BOT_ID || process.env.QWTS_AGENT_ID;
  const binding = process.env.AGENT_BOT_BINDING ? readBinding() : null;
  if (process.env.AGENT_BOT_BINDING && !binding) throw new Error('session binding is missing; check in again with agent-bot join');
  if (fromEnv && binding && fromEnv !== binding.agentId) throw new Error('session soul and binding disagree');
  const id = fromEnv ?? binding?.agentId;
  let identity = id ? readAgentIdentity(id) : null;
  if (!identity) {
    const transcript = discoverTranscript();
    if (!transcript) return null;
    const matches = listSouls().filter((soul) => soul.status !== 'retired').map((soul) => readAgentIdentity(soul.id))
      .filter((record) => record.transcript?.provider === transcript.provider && record.transcript.id === transcript.id);
    if (matches.length > 1) throw new Error('multiple souls match this session; supply AGENT_BOT_ID from agent-bot join');
    identity = matches[0];
  }
  if (!identity) return null;
  if (identity.status === 'retired' || showSoul(identity.id).status === 'retired') throw new Error('session soul is retired');
  return identity;
}

export function prepareWorktreeBinding(options) {
  if (readBinding({ env: {}, gitDir: options.gitDir })) return 'binding reused';
  mintBindToken(options);
  return 'bind token minted';
}

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
  env = process.env,
  fetchImpl = fetch,
} = {}) {
  const metadata = readAppMetadata(slug, { home, env });
  const cachedUid = metadata.botUid ?? null;
  const cachedAvatar = metadata.botAvatarUrl ?? null;
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
    writeAppMetadata(slug, { botUid: uid,
      ...(typeof profile.avatar_url === 'string' && /^https:\/\//.test(profile.avatar_url)
        ? { botAvatarUrl: profile.avatar_url } : {}) }, { home, env });
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

// Register the already-resolved soul; setup must never mint or rotate identity.
async function bindExecutionIdentity({ config, daemon, executionIdentity }) {
  // The census row records the checkout it is pinned to, so doctor can name
  // an active soul no checkout references (#192). Null in a bare repository.
  let worktree = null;
  try {
    worktree = git('rev-parse', '--show-toplevel') || null;
  } catch {
    /* no working tree to record */
  }
  const space = await bindSoul({
    agentId: executionIdentity.id,
    policy: daemonPreference({ config }),
    client: daemon ?? daemonClient(),
    worktree,
    ensureLocal: () => {
      const local = ensureSoulSpace(executionIdentity.id);
      upsertIdentitySoul(executionIdentity.id, local.path, { worktree });
      return local;
    },
  });
  git('config', 'extensions.worktreeConfig', 'true');
  return { executionIdentity, space, worktree };
}

function bindTokenState({ gitDir, worktree, agentId }) {
  try {
    return prepareWorktreeBinding({
      gitDir,
      worktree: worktree ?? git('rev-parse', '--show-toplevel'),
      agentId,
    });
  } catch {
    return 'bind token unavailable';
  }
}

async function configureSoulWithoutApp({ gitDir, config, daemon, identity }) {
  const { executionIdentity, space, worktree } = await bindExecutionIdentity({
    config,
    daemon,
    executionIdentity: identity,
  });
  // Remove only GitHub-specific worktree state installed by this command.
  // Preserve unrelated credential helpers and restore an earlier hooks path.
  const getConfig = (key) => {
    try { return git('config', '--worktree', '--get', key); } catch { return ''; }
  };
  const hooks = getConfig('agentBot.chainedHooksPath');
  if (hooks) git('config', '--worktree', 'core.hooksPath', hooks);
  for (const key of ['agentBot.app', 'agentBot.chainedHooksPath']) {
    try { git('config', '--worktree', '--unset-all', key); } catch { /* absent */ }
  }
  if (getConfig('user.name').endsWith('[bot]')) {
    for (const key of ['user.name', 'user.email']) {
      try { git('config', '--worktree', '--unset-all', key); } catch { /* absent */ }
    }
  }
  try {
    const helpers = git('config', '--worktree', '--get-all', 'credential.helper').split('\n');
    const isBotHelper = (value) => value.includes('git-credential-bot.mjs')
      || /(?:^|\/)agent-bot(?:'|\") credential /.test(value);
    const retained = helpers.filter((value) => !isBotHelper(value));
    git('config', '--worktree', '--unset-all', 'credential.helper');
    for (const helper of retained) git('config', '--worktree', '--add', 'credential.helper', helper);
  } catch { /* no worktree helpers */ }
  if (getConfig('commit.gpgsign') === 'false') {
    try { git('config', '--worktree', '--unset-all', 'commit.gpgsign'); } catch { /* absent */ }
  }
  // core.hooksPath is removed only when it points at our installed hooks.
  const hooksPath = getConfig('core.hooksPath');
  if (hooksPath.includes('/share/agent-bot/hooks')) {
    try { git('config', '--worktree', '--unset-all', 'core.hooksPath'); } catch { /* absent */ }
  }
  git('config', '--worktree', 'agentBot.agentId', executionIdentity.id);
  const bindState = bindTokenState({ gitDir, worktree, agentId: executionIdentity.id });
  const transcriptState = executionIdentity.transcript ? 'transcript bound' : 'transcript pending';
  const spaceState = `${space.created ? 'space created' : 'space ready'}${space.via === 'daemon' ? ' via daemon' : ''}`;
  process.stdout.write(
    `worktree configured as ${executionIdentity.id} (${transcriptState}, ${spaceState}, ${bindState})\n`,
  );
}

async function configure({ identity, options, config,
  reconcileCredentials = reconcileAppCredentials,
  rewriteOrigins = rewriteOriginUrls,
  resolveBotUid = botUid,
  daemon = null,
  gate: isEnabled = isGateEnabled,
} = {}) {
  const gitDir = git('rev-parse', '--absolute-git-dir');
  assertWorktreeArea(identity.id, git('rev-parse', '--show-toplevel'));
  for (const key of AGENT_ID_KEYS) {
    let pin;
    try { pin = git('config', '--worktree', '--get', key); } catch { continue; }
    if (pin && pin !== identity.id) throw new Error('checkout belongs to another soul; use a new worktree');
  }
  const binding = readBinding({ env: {}, gitDir });
  if (binding && binding.agentId !== identity.id) throw new Error('checkout binding belongs to another soul');
  if (!isEnabled('github-identity', { env: process.env, home: homedir(), config })) {
    await configureSoulWithoutApp({ gitDir, config, daemon, identity });
    return;
  }
  const resolvedSlug = resolveAgentSlug({ explicit: options.slug ?? identity.github?.appSlug, config, detect: false });
  if (!identity.github?.appSlug || !resolvedSlug) throw new Error('session soul has no GitHub App; re-run agent-bot join in this checkout to resolve its configured harness mapping');
  const slug = validateAppSlug(resolvedSlug);
  if (slug !== identity.github?.appSlug || (pinnedSlug() && pinnedSlug() !== slug)) {
    throw new Error('GitHub App does not match the session soul; use a new worktree');
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

  // Initialize and register before writing any worktree attribution. A missing,
  // corrupt, or mismatched space or census fails closed without leaving the
  // worktree partially bound.
  const { executionIdentity, space, worktree } = await bindExecutionIdentity({
    executionIdentity: identity,
    config,
    daemon,
  });
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
  const bindState = bindTokenState({ gitDir, worktree, agentId: executionIdentity.id });

  const transcriptState = executionIdentity.transcript ? 'transcript bound' : 'transcript pending';
  const spaceState = `${space.created ? 'space created' : 'space ready'}${space.via === 'daemon' ? ' via daemon' : ''}`;
  process.stdout.write(
    `worktree configured for ${slug}[bot] as ${executionIdentity.id} (${transcriptState}, ${spaceState}, ${bindState})\n`,
  );
}

export async function main(dependencies = {}) {
  const argv = process.argv.slice(2);
  if (argv.includes('--help') || argv.includes('-h')) {
    process.stdout.write(USAGE);
    return;
  }
  const options = parseArgs(argv);
  const identity = sessionIdentity();
  if (!identity) {
    // No session soul: a human's own session, or a harness nobody approved.
    // The harness startup script and git's post-checkout hook run setup
    // every session, so this stays a quiet no-op (the checkout is left
    // human); only an explicit request to create a worktree is an error.
    const hint = 'no session soul: this checkout stays human. An agent checks in with agent-bot join --name NAME --harness HARNESS and uses its AGENT_BOT_ID';
    if (options.name) throw new Error(hint);
    if (!options.hook && process.env.AGENT_BOT_SETUP_HINT === '1') process.stderr.write(`setup-worktree: ${hint}\n`);
    return;
  }
  const original = process.cwd();
  try {
    if (options.name) {
      const commonDir = realpathSync(git('rev-parse', '--path-format=absolute', '--git-common-dir'));
      const destination = soulWorktreePath(identity.id, options.name, { readOnly: true });
      if (!existsSync(destination)) {
        const branch = options.branch ?? options.name;
        git('check-ref-format', '--branch', branch);
        const placed = placeWorktree(identity.id, options.name, { repoCommonDir: commonDir });
        let branchExists = false;
        try { git('show-ref', '--verify', `refs/heads/${branch}`); branchExists = true; } catch { /* new branch */ }
        git('-c', 'core.hooksPath=/dev/null', 'worktree', 'add', ...(branchExists ? [] : ['-b', branch]), placed.path, ...(branchExists ? [branch] : []));
      }
      process.chdir(destination);
      if (realpathSync(git('rev-parse', '--show-toplevel')) !== realpathSync(destination)
          || realpathSync(git('rev-parse', '--path-format=absolute', '--git-common-dir')) !== commonDir) {
        throw new Error('named worktree is not a checkout of this repository');
      }
      if (options.branch && git('symbolic-ref', '--short', 'HEAD') !== options.branch) throw new Error('named worktree uses a different branch');
    }
    await configure({ ...dependencies, identity, options, config: loadConfig() });
  } finally { process.chdir(original); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(`setup-worktree: ${err.message}`);
    process.exit(1);
  });
}
