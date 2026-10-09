#!/usr/bin/env node
// Claude Code `WorktreeCreate` hook — create the worktree, then land the bot
// identity in it before the session starts (ENG-0016, ENG-0339).
//
// Why a harness hook at all, when git's own post-checkout hook already runs
// setup-worktree.mjs on `git worktree add`: Claude Code creates its worktrees
// from a sandboxed process, and a sandbox that cannot write the *shared* git
// directory drops the `config.worktree` the identity lives in. The checkout
// still succeeds, so nothing looks wrong until the first commit is attributed
// to the human (the pre-commit guard catches it — loudly, after the work).
// This hook is run by Claude Code itself, outside that sandbox, so the write
// lands. It is the same remedy the reference doc gives for husky repos, minus
// the human step.
//
// Contract (Claude Code): the hook *replaces* worktree creation. It receives
// `{cwd: <base repo>, name: <worktree name>, session_id}` as JSON on stdin,
// and must print the absolute path of a directory it created. Empty output or
// a non-zero exit fails worktree creation — there is no fallback to git.
//
// A resolved soul owns new checkouts under its worktrees/ directory. Without
// one, keep Claude's `<worktree root>/<repo>/<name>` layout. Branches are
// `claude/<name>`, fresh from the default branch. Two built-in behaviors are NOT
// reproduced: the `worktree.symlinkDirectories` and `worktree.sparsePaths`
// settings. Remove the hook if a repo needs those.

import process from 'node:process';
import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { ensureAgentIdentity, readAgentIdentity, stateDirectory, withLock } from './agent-identity.mjs';
import { daemonPreference, harnessForSlug, isGateEnabled, loadConfig } from './config.mjs';
import { configuredAccountIdentity } from './detect-harness.mjs';
import { AGENT_ID_KEYS, resolveAgentSlug } from './resolve-agent.mjs';
import { ensureSoulSpace } from './soul-memory.mjs';
import { showSoul, upsertIdentitySoul } from './agent-population.mjs';
import { bindSoul } from './setup-worktree.mjs';
import { daemonClient } from './daemon-client.mjs';
import { linkWorktree, placeWorktree, sanitizeWorktreeName, soulWorktreePath } from './soul-worktrees.mjs';

const SETUP = join(dirname(fileURLToPath(import.meta.url)), 'setup-worktree.mjs');

function git(args, cwd, env = process.env) {
  return execFileSync('git', args, { cwd, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

// Claude Code generates names like `add-oauth-3f9c1a`. Anything outside this
// shape is refused rather than sanitized: the name becomes a path segment and
// a branch name, and a leading `-` would reach git as an option.
export function validateWorktreeName(name) {
  if (typeof name !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name) || name.includes('..')) {
    throw new Error(`invalid worktree name: ${JSON.stringify(name)}`);
  }
  return name;
}

export function parseHookInput(text) {
  let payload;
  try {
    payload = JSON.parse(text);
  } catch {
    throw new Error('hook input was not valid JSON');
  }
  const baseRepo = payload?.cwd;
  if (typeof baseRepo !== 'string' || baseRepo === '') throw new Error('hook input carried no cwd');
  const sessionId = payload?.session_id;
  if (typeof sessionId !== 'string' || sessionId === '' || /[\u0000-\u001f\u007f]/.test(sessionId)) {
    throw new Error('hook input carried no valid session_id');
  }
  return { baseRepo, name: validateWorktreeName(payload?.name), sessionId };
}

export function claudeTranscriptEnvironment(sessionId, env = process.env) {
  const {
    QWTS_AGENT_TRANSCRIPT_PROVIDER: _legacyProvider,
    QWTS_AGENT_TRANSCRIPT_ID: _legacyId,
    ...canonicalEnv
  } = env;
  return {
    ...canonicalEnv,
    AGENT_BOT_TRANSCRIPT_PROVIDER: 'claude',
    AGENT_BOT_TRANSCRIPT_ID: sessionId,
  };
}

// Where the desktop app records a relocated worktree directory. Reading it
// keeps hook-created worktrees in the same place the app's own listing and
// cleanup look for them.
export function desktopConfigPath(home = homedir(), platform = process.platform, env = process.env) {
  if (platform === 'darwin') return join(home, 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json');
  if (platform === 'win32') return join(env.APPDATA ?? join(home, 'AppData', 'Roaming'), 'Claude', 'claude_desktop_config.json');
  return join(env.XDG_CONFIG_HOME ?? join(home, '.config'), 'Claude', 'claude_desktop_config.json');
}

// Default is Claude's worktree layout — `~/.claude/worktrees`. Layout only:
// under ENG-0339 the account, not the directory, decides identity.
//
// Always absolute: Claude Code rejects a relative path outright, and neither
// source of an override is guaranteed to give one. A `~` or a relative value
// anchors at the home directory, the only base a user preference can mean.
export function worktreeRoot({ home = homedir(), desktopConfig = null, env = process.env } = {}) {
  const absolute = (value) => resolve(home, value.replace(/^~(?=$|[/\\])/, home));
  if (env.AGENT_WORKTREE_ROOT) return absolute(env.AGENT_WORKTREE_ROOT);
  try {
    const custom = JSON.parse(desktopConfig).preferences?.chillingSlothLocation?.customPath;
    if (typeof custom === 'string' && custom !== '') return absolute(custom);
  } catch {
    /* no readable desktop config — the layout default stands */
  }
  return join(home, '.claude', 'worktrees');
}

export function worktreePath(root, baseRepo, name) {
  const repo = basename(baseRepo);
  // The app sidesteps the collision when the repo itself sits at <root>/<repo>;
  // mirror it so both creators agree on the path.
  const parent = resolve(join(root, repo)) === resolve(baseRepo) ? join(root, `${repo}-worktrees`) : join(root, repo);
  return join(parent, name);
}

export function branchName(name) {
  return `claude/${name}`;
}

// Claude Code's default `worktree.baseRef` is "fresh": branch from the remote
// default branch, not from whatever the human left checked out.
export function pickBaseRef({ originHead = null, exists = () => false }) {
  for (const ref of [originHead, 'origin/main', 'origin/master'].filter(Boolean)) {
    if (exists(ref)) return ref;
  }
  return 'HEAD';
}

function readStdin() {
  try {
    return readFileSync(0, 'utf8');
  } catch {
    return '';
  }
}

function refExists(repo, ref) {
  try {
    git(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], repo);
    return true;
  } catch {
    return false;
  }
}

function resolveBaseRef(repo) {
  let originHead = null;
  try {
    originHead = git(['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'], repo);
  } catch {
    /* no origin/HEAD — the candidates below still apply */
  }
  return pickBaseRef({ originHead, exists: (ref) => refExists(repo, ref) });
}

function canReuseWorktree(path, { commonDir, branch, sessionId, app }) {
  try {
    if (realpathSync(git(['rev-parse', '--show-toplevel'], path)) !== realpathSync(path)) return false;
    if (realpathSync(git(['rev-parse', '--path-format=absolute', '--git-common-dir'], path)) !== commonDir) return false;
    if (git(['symbolic-ref', 'HEAD'], path) !== `refs/heads/${branch}`) return false;
    const id = git(['config', '--worktree', '--get', 'agentBot.agentId'], path);
    const identity = readAgentIdentity(id, { stateDir: stateDirectory() });
    return identity.id === id && identity.status !== 'retired'
      && identity.transcript?.provider === 'claude' && identity.transcript.id === sessionId
      && (!app || (identity.github?.appSlug === app
        && git(['config', '--worktree', '--get', 'agentBot.app'], path) === app));
  } catch {
    return false;
  }
}

function withCreationLock(commonDir, name, operation) {
  const label = `Claude worktree ${name}`;
  for (let attempt = 0; ; attempt++) {
    let started = false;
    try {
      return withLock(join(commonDir, `agent-bot-claude-${name}.lock`), label, () => {
        started = true;
        return operation();
      }, { keepLiveOwners: true });
    } catch (error) {
      if (started || attempt >= 59 || error.message !== `timed out waiting for ${label}`) throw error;
    }
  }
}

async function main() {
  const { baseRepo, name, sessionId } = parseHookInput(readStdin());

  // A linked worktree's common dir points at the primary checkout.
  const commonDir = realpathSync(git(['rev-parse', '--path-format=absolute', '--git-common-dir'], baseRepo));
  const mainRepo = dirname(commonDir);
  const config = loadConfig();
  const app = resolveAgentSlug({ cwd: baseRepo, config, detect: false })
    || configuredAccountIdentity(config)?.slug;
  const useGithub = isGateEnabled('github-identity', { config });
  const reuseApp = useGithub ? app : null;
  const env = claudeTranscriptEnvironment(sessionId, { ...process.env, ...(app ? { GH_AGENT_APP: app } : {}) });

  let desktopConfig = null;
  try {
    desktopConfig = readFileSync(desktopConfigPath(), 'utf8');
  } catch {
    /* no desktop config on this machine */
  }
  const legacyPath = worktreePath(worktreeRoot({ desktopConfig }), mainRepo, name);
  const branch = branchName(name);
  let path = legacyPath;
  let agentId = null;

  // Old checkouts stay put, including ones made before soul placement. Find
  // the branch through git rather than guessing its soul or harness directory.
  const findExisting = () => git(['worktree', 'list', '--porcelain', '-z'], mainRepo).split('\0\0')
    .map((entry) => entry.split('\0'))
    .find((fields) => fields.includes(`branch refs/heads/${branch}`))
    ?.find((field) => field.startsWith('worktree '))?.slice('worktree '.length);
  // Runs under the creation lock, so a concurrent creator that made the
  // branch first is reused instead of reported as a collision.
  const reuse = (existingPath) => {
    path = existingPath;
    if (!canReuseWorktree(path, { commonDir, branch, sessionId, app: reuseApp })) {
      throw new Error(`refusing to reuse an existing path: ${path}`);
    }
    // A checkout from before soul placement may carry no pin; it is reused
    // as is. Linking is a convenience and never fails the hook.
    let id = null;
    try { id = git(['config', '--worktree', '--get', 'agentBot.agentId'], path); } catch { return; }
    try {
      const soulPath = soulWorktreePath(id, name);
      const temporaryPath = resolve(process.env.TMPDIR ?? tmpdir(), 'agent-bot', id, sanitizeWorktreeName(name));
      // Git lists canonical paths. Preserve the path printed at creation when
      // HOME/TMPDIR is reached through an alias (e.g. /var on macOS).
      for (const candidate of [legacyPath, temporaryPath, soulPath]) {
        if (existsSync(candidate) && !lstatSync(candidate).isSymbolicLink()
            && realpathSync(candidate) === realpathSync(path)) {
          path = candidate;
          break;
        }
      }
      linkWorktree(id, path, { name });
    } catch (error) { process.stderr.write(`worktree not linked into its soul: ${error.message}\n`); }
  };
  const existing = findExisting();
  if (existing || existsSync(legacyPath)) {
    withCreationLock(commonDir, name, () => reuse(existing ?? legacyPath));
    process.stdout.write(`${path}\n`);
    return;
  }

  let currentId = process.env.AGENT_BOT_ID ?? process.env.QWTS_AGENT_ID ?? null;
  for (const key of AGENT_ID_KEYS) {
    if (currentId) break;
    try { currentId = git(['config', '--worktree', '--get', key], baseRepo); } catch { /* no pin */ }
  }
  if (app || currentId) try {
    const identity = ensureAgentIdentity({ currentId, appSlug: app,
      harness: app ? harnessForSlug(app, config) : 'claude',
      transcript: { provider: 'claude', id: sessionId },
      useGithub,
    });
    agentId = identity.id;
    // Honor the same daemon policy as setup before asking the census for a
    // directory. No checkout is recorded until git has actually created it.
    let registered = false;
    try {
      if (showSoul(agentId).status === 'retired') throw new Error(`soul ${agentId} is retired in the population census`);
      registered = true;
    }
    catch (error) { if (!error.message.startsWith('no population record for ')) throw error; }
    if (!registered) {
      await bindSoul({ agentId, policy: daemonPreference({ config }), client: daemonClient(), sighted: true,
        ensureLocal: () => {
          const space = ensureSoulSpace(agentId);
          upsertIdentitySoul(agentId, space.path, { sighted: true });
          return space;
        },
      });
    }
  } catch (error) {
    // Without a soul the hook keeps Claude's own layout rather than failing.
    process.stderr.write(`worktree placed outside its soul: ${error.message}\n`);
    agentId = null;
    path = legacyPath;
  }

  // Placement failures must not fall back to a temporary or legacy work area.
  if (agentId) {
    path = placeWorktree(agentId, name, { repoCommonDir: commonDir }).path;
    env.AGENT_BOT_ID = agentId;
  }

  withCreationLock(commonDir, name, () => {
    const raced = findExisting();
    if (raced) { reuse(raced); return; }
    if (existsSync(path)) {
      if (canReuseWorktree(path, { commonDir, branch, sessionId, app: reuseApp })) return;
      throw new Error(`refusing to reuse an existing path: ${path}`);
    }
    if (refExists(mainRepo, `refs/heads/${branch}`)) throw new Error(`branch ${branch} already exists`);

    try {
      git(['fetch', '--quiet', 'origin'], mainRepo);
    } catch {
      /* offline, or no origin — branch from what is already local */
    }

    mkdirSync(dirname(path), { recursive: true });
    git(['worktree', 'add', '--no-track', '-b', branch, path, resolveBaseRef(mainRepo)], mainRepo, env);
    if (agentId) {
      try { linkWorktree(agentId, path, { name }); }
      catch (error) { process.stderr.write(`worktree not linked into its soul: ${error.message}\n`); }
    }

    // The identity step. Failing it does not fail the worktree. The governed
    // hook runs this only inside an agent account (ENG-0339), where the gh shim
    // and token minting resolve the account's App with or without a pin, and
    // pre-commit still refuses a bot-attributed commit that has no Agent ID —
    // so a loud warning plus a usable workspace beats leaving the agent with
    // none. Setup still validates the session soul's work area before writes.
    try {
      execFileSync(process.execPath, [SETUP], {
        cwd: path,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        env,
      });
    } catch (err) {
      process.stderr.write(`bot identity not applied to ${path}: ${err.message}\n`);
    }
  });

  process.stdout.write(`${path}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(`claude-worktree-create: ${err.message}`);
    process.exit(1);
  });
}
