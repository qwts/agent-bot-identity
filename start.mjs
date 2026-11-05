#!/usr/bin/env node
// `agent-bot start`: one-command session check-in and worktree startup (#1345).
//
// Resolves the active harness's canonical soul, creates or reuses a linked
// soul worktree on the target branch (branched from origin/HEAD or origin/main
// when creating a new branch), binds this conversation at the daemon (`session
// bind`), and verifies GitHub identity readiness (including server mode).
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';
import { listSouls, locateSoulDir, populationFile, setSoulAppThen, showSoul, soulDirectory } from './agent-population.mjs';
import { isGateEnabled, loadConfig, slugForHarness, soulOwnsAppSlug } from './config.mjs';
import { daemonClient, identityOp } from './daemon-client.mjs';
import { detectAgentHarness, detectHarness } from './detect-harness.mjs';
import { readBinding, reconcileAppCredentials, repoFromCheckout, resolveAgentSlug, serverUrl } from './identity-cli.mjs';
import { AGENT_ID_KEYS, validateAgentId } from './identity-format.mjs';
import { findTranscript, sessionBind } from './session-bind.mjs';
import { clearInheritedPin, configureWorktree } from './setup-worktree.mjs';
import { joinSoul } from './soul-join.mjs';
import { placeWorktree, sanitizeWorktreeName, soulWorktreePath } from './soul-worktrees.mjs';
import { stateDirectory } from './state-paths.mjs';

export const START_USAGE = `usage: agent-bot start [--branch <branch>|-b <branch>] [--base <ref>] [--repo <path|owner/name>] [--name <worktree-name>] [--harness <harness>] [--soul <agent-id|name>] [--transcript-id <id>] [--provider <name>] [--json]

Check in this agent session for a task: resolve the active harness's canonical
soul, create or reuse a linked soul worktree on the target branch, bind this
conversation (\`session bind\`), and verify GitHub identity readiness.

What \`agent-bot start\` is NOT:
  - Not machine/owner bootstrap (\`agent-bot bootstrap --profile ...\`)
  - Not daemon process startup (\`agent-bot daemon start\`)
  - Not project dependency or build setup (\`npm install\`, dev servers)

Options:
  -b, --branch <branch>     Create or switch to this task branch in a linked
                            soul worktree (new branches start from --base, else
                            origin/<branch>, origin/HEAD, or origin/main)
  --base <ref>              Base git ref when creating a new branch
  --repo <path|owner/name>  Target repository path or owner/name (default: cwd)
  --name <worktree-name>    Worktree directory name under <soulDir>/worktrees/
                            (default: <repo>-<branch> or <repo>)
  --harness <harness>       Harness key override (default: auto-detected)
  --soul <agent-id|name>    Soul Agent ID or census name override
  --transcript-id <id>      Conversation/session ID override
  --provider <name>         Transcript provider override
  --json                    Print structured JSON receipt
  -h, --help                Show this help and change nothing
`;

const VALUE_FLAGS = new Map([
  ['-b', 'branch'],
  ['--branch', 'branch'],
  ['--base', 'base'],
  ['--repo', 'repo'],
  ['--name', 'name'],
  ['--harness', 'harness'],
  ['--soul', 'soul'],
  ['--transcript-id', 'transcriptId'],
  ['--provider', 'provider'],
]);

export function parseStartArgs(argv = process.argv.slice(2)) {
  const options = {
    help: false,
    json: false,
    branch: null,
    base: null,
    repo: null,
    name: null,
    harness: null,
    soul: null,
    transcriptId: null,
    provider: null,
  };
  if (argv.includes('--help') || argv.includes('-h')) {
    options.help = true;
    return options;
  }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--json') {
      options.json = true;
    } else if (VALUE_FLAGS.has(arg)) {
      const key = VALUE_FLAGS.get(arg);
      const value = argv[i + 1];
      if (!value || value.startsWith('-')) throw new Error(`${arg} requires a value`);
      if (options[key] !== null) throw new Error(`${arg} may be passed only once`);
      options[key] = value;
      i += 1;
    } else {
      throw new Error(`unknown option: ${arg}`);
    }
  }
  if (options.name && (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(options.name) || options.name.includes('..'))) {
    throw new Error('invalid worktree name: use 1–100 letters, numbers, dots, underscores or hyphens, starting with a letter or number');
  }
  return options;
}

function gitIn(cwd, args, env = process.env) {
  return execFileSync('git', ['-C', cwd, ...args], {
    env,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 15_000,
  }).trim();
}

function tryGit(cwd, args, env = process.env) {
  try {
    return gitIn(cwd, args, env);
  } catch {
    return null;
  }
}

function resolveTargetRepo({ repo, cwd, home, env, popOptions }) {
  let candidate = cwd;
  if (repo) {
    const expanded = repo.startsWith('~/') && home ? path.join(home, repo.slice(2)) : repo;
    if (existsSync(path.resolve(cwd, expanded))) {
      candidate = path.resolve(cwd, expanded);
    } else if (/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo)) {
      const wanted = repo.toLowerCase();
      const matchesOrigin = (dir) => {
        if (!dir || !existsSync(dir)) return false;
        const slug = repoFromCheckout(dir, env);
        return typeof slug === 'string' && slug.toLowerCase() === wanted;
      };
      const repoShort = repo.split('/')[1];
      const searchDirs = [
        cwd,
        ...(home ? [path.join(home, 'Code', repoShort)] : []),
        path.resolve(cwd, '..', repoShort),
        ...listSouls(popOptions).map((s) => s.worktree).filter(Boolean),
      ];
      const found = searchDirs.find(matchesOrigin);
      if (!found) {
        throw Object.assign(
          new Error(`could not find a local checkout for ${repo} (checked origin remote); clone it first or pass --repo <path>`),
          { code: 'start-repo-not-found' },
        );
      }
      candidate = found;
    } else {
      throw Object.assign(
        new Error(`repository path does not exist: ${repo}`),
        { code: 'start-repo-not-found' },
      );
    }
  }
  const toplevel = tryGit(candidate, ['rev-parse', '--show-toplevel'], env);
  if (!toplevel) {
    throw new Error('not a git repository (pass --repo <path|owner/name> or run inside a repository checkout)');
  }
  const commonDir = realpathSync(gitIn(toplevel, ['rev-parse', '--path-format=absolute', '--git-common-dir'], env));
  const originSlug = repoFromCheckout(toplevel, env) ?? null;
  const repoName = originSlug
    ? originSlug.split('/')[1]
    : path.basename(path.basename(commonDir) === '.git' ? path.dirname(commonDir) : toplevel);
  return { toplevel: realpathSync(toplevel), commonDir, originSlug, repoName };
}

function defaultBaseRef(toplevel, targetBranch, env) {
  if (targetBranch && tryGit(toplevel, ['rev-parse', '--verify', '-q', `refs/remotes/origin/${targetBranch}`], env)) {
    return `origin/${targetBranch}`;
  }
  const sym = tryGit(toplevel, ['symbolic-ref', '-q', '--short', 'refs/remotes/origin/HEAD'], env);
  if (sym && tryGit(toplevel, ['rev-parse', '--verify', '-q', sym], env)) return sym;
  for (const ref of ['origin/main', 'origin/master', 'main', 'HEAD']) {
    if (tryGit(toplevel, ['rev-parse', '--verify', '-q', ref], env)) return ref;
  }
  return 'HEAD';
}

function branchCheckedOutElsewhere(toplevel, branch, destination, env) {
  const out = tryGit(toplevel, ['worktree', 'list', '--porcelain'], env);
  if (!out) return null;
  const destReal = existsSync(destination) ? realpathSync(destination) : path.resolve(destination);
  let currentWt = null;
  for (const line of out.split('\n')) {
    if (line.startsWith('worktree ')) {
      const p = line.slice('worktree '.length).trim();
      try { currentWt = realpathSync(p); } catch { currentWt = path.resolve(p); }
    } else if (line === `branch refs/heads/${branch}` && currentWt && currentWt !== destReal) {
      return currentWt;
    } else if (line === '') {
      currentWt = null;
    }
  }
  return null;
}

function insideSoulWorktree(checkoutPath, popOptions = {}) {
  try {
    const here = realpathSync(checkoutPath);
    for (let cur = here; ;) {
      const parent = path.dirname(cur);
      if (parent === cur) break;
      if (path.basename(cur) === 'worktrees') {
        const located = locateSoulDir(parent, popOptions);
        if (located?.status === 'installed' && located.agentId && located.path) {
          const worktreesDir = realpathSync(path.join(located.path, 'worktrees'));
          if (here.startsWith(`${worktreesDir}${path.sep}`)) return located.agentId;
        }
      }
      cur = parent;
    }
  } catch { /* not inside a soul worktrees dir */ }
  return null;
}

function activeIdentity(id, stateDir) {
  try {
    const record = identityOp('read', { id, stateDir });
    return record?.status === 'active' ? record : null;
  } catch {
    return null;
  }
}

function serverDeviceState({ env, home, server }) {
  const stateBase = env.AGENT_BOT_SERVER_STATE
    ? path.resolve(env.AGENT_BOT_SERVER_STATE)
    : path.join(env.XDG_STATE_HOME ? path.resolve(env.XDG_STATE_HOME) : path.join(home, '.local', 'state'), 'agent-bot', 'server');
  try {
    const dev = JSON.parse(readFileSync(path.join(stateBase, 'device.json'), 'utf8'));
    if (!dev || typeof dev !== 'object' || Array.isArray(dev)) return null;
    if (dev.server && dev.server !== server) return null;
    return dev;
  } catch {
    return null;
  }
}

function slugMatchesDeviceScope(slug, harnesses, config) {
  if (!slug || !Array.isArray(harnesses) || harnesses.length === 0) return false;
  if (harnesses.includes(slug)) return true;
  for (const [h, mapped] of Object.entries(config?.apps ?? {})) {
    if (mapped === slug && (harnesses.includes(h) || (h === 'claude-code' && harnesses.includes('claude')))) return true;
  }
  const m = /^[a-z0-9-]+?-([a-z0-9]+(?:-[a-z0-9]+)*)-agent$/i.exec(slug);
  if (m && (harnesses.includes(m[1]) || (m[1] === 'claude-code' && harnesses.includes('claude')))) return true;
  return false;
}

// Pure read-only lookup of an existing active soul for this session/harness.
// Never creates a soul or mutates state so validation checks can run first.
function lookupExistingSoul({
  explicitSoul,
  harness,
  toplevel,
  env,
  home,
  config,
  stateDir,
  popOptions,
}) {
  const souls = listSouls(popOptions).filter((s) => s.status !== 'retired');
  if (explicitSoul) {
    const match = souls.find((s) => s.id === explicitSoul || s.name === explicitSoul || s.displayName === explicitSoul);
    const id = match ? match.id : validateAgentId(explicitSoul);
    const identity = activeIdentity(id, stateDir);
    if (!identity) throw new Error(`${explicitSoul} is not an active soul`);
    const row = showSoul(id, popOptions);
    return { identity, row, soulResolution: 'explicit' };
  }

  const fromEnv = env.AGENT_BOT_ID || env.QWTS_AGENT_ID || null;
  const binding = readBinding({ env, cwd: toplevel });
  const areaOwner = insideSoulWorktree(toplevel, popOptions);
  let pinned = null;
  if (areaOwner) {
    for (const key of AGENT_ID_KEYS) {
      const val = tryGit(toplevel, ['config', '--worktree', '--get', key], env);
      if (val) { pinned = val; break; }
    }
  }
  for (const candidate of [fromEnv, binding?.agentId, areaOwner, pinned]) {
    if (!candidate) continue;
    const identity = activeIdentity(candidate, stateDir);
    if (identity) {
      const row = showSoul(identity.id, popOptions);
      if (row.status !== 'retired') {
        return { identity, row, soulResolution: 'reused-bound' };
      }
    }
  }

  if (!harness) {
    throw new Error('could not detect agent harness from environment; pass --harness <harness> or --soul <agent-id>');
  }

  const githubOn = isGateEnabled('github-identity', { env, home, config });
  const targetSlug = githubOn
    ? (resolveAgentSlug({ env, cwd: toplevel, config, harness }) ?? slugForHarness(harness, config))
    : null;

  const candidates = souls.filter((s) => {
    if (targetSlug && (s.appSlug === targetSlug || soulOwnsAppSlug({ id: s.id, harness: s.harness, github: { appSlug: s.appSlug } }, targetSlug, config, { env, home }))) {
      return true;
    }
    return s.harness === harness;
  });

  candidates.sort((a, b) => {
    const aInstalled = existsSync(soulDirectory(a.id, { ...popOptions, readOnly: true })) ? 1 : 0;
    const bInstalled = existsSync(soulDirectory(b.id, { ...popOptions, readOnly: true })) ? 1 : 0;
    if (aInstalled !== bInstalled) return bInstalled - aInstalled;
    return String(b.lastSeen ?? '').localeCompare(String(a.lastSeen ?? ''));
  });

  for (const candidate of candidates) {
    const identity = activeIdentity(candidate.id, stateDir);
    if (identity) {
      return { identity, row: candidate, soulResolution: `auto-resolved: ${harness}` };
    }
  }

  return null;
}

function shellSingleQuote(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}

export function formatStartReceipt(receipt) {
  const soulName = receipt.soul.name ? `${receipt.soul.name} (${receipt.soul.id})` : receipt.soul.id;
  const lines = [
    `soul:     ${soulName} [${receipt.soul.resolution}]`,
    `session:  ${receipt.session.provider}:${receipt.session.id} (${receipt.session.source})`,
    `repo:     ${receipt.repo.name}${receipt.repo.base ? ` (base: ${receipt.repo.base})` : ''}`,
    `identity: ${receipt.identity.bot ?? 'none'}${receipt.identity.server ? ` (server: ${receipt.identity.server})` : ` (${receipt.identity.mode})`}`,
    `worktree: ${receipt.worktree.path} (branch: ${receipt.worktree.branch}, ${receipt.worktree.created ? 'created' : 'ready'})`,
    `binding:  live session binding ${receipt.binding.alreadyBound ? 'present' : 'established'}`,
  ];
  if (receipt.next) {
    lines.push(`next:     ${receipt.next}`);
  }
  return `${lines.join('\n')}\n`;
}

export async function startTask({
  branch = null,
  base = null,
  repo = null,
  name = null,
  harness: explicitHarness = null,
  soul: explicitSoul = null,
  transcriptId = null,
  provider = null,
  cwd = process.cwd(),
  env = process.env,
  home = env.HOME ?? homedir(),
  config: providedConfig,
  comms,
  clientFactory,
  reconcileCredentials,
  resolveBotUid,
  fetchImpl,
  findTranscriptImpl = findTranscript,
} = {}) {
  const config = providedConfig ?? loadConfig({ env, home });
  const popOptions = { env, home, config, file: populationFile({ env, home, config }) };
  const stateDir = stateDirectory(popOptions);
  const harness = explicitHarness ?? detectHarness(env) ?? detectAgentHarness(env);

  // 1. Resolve target repository checkout (read-only).
  const targetRepo = resolveTargetRepo({ repo, cwd, home, env, popOptions });

  // 2. Look up existing canonical soul for this harness/session (read-only).
  const existingSoul = lookupExistingSoul({
    explicitSoul,
    harness,
    toplevel: targetRepo.toplevel,
    env,
    home,
    config,
    stateDir,
    popOptions,
  });
  const effectiveHarness = harness ?? existingSoul?.identity?.harness ?? existingSoul?.row?.harness ?? 'custom';

  // 3. Verify server-mode readiness (read-only, before any soul or worktree creation).
  const githubOn = isGateEnabled('github-identity', { env, home, config });
  let server = null;
  try { server = serverUrl({ env, config }); } catch { server = null; }
  const appSlug = githubOn
    ? (existingSoul?.identity?.github?.appSlug ?? resolveAgentSlug({ env, cwd: targetRepo.toplevel, config, harness: effectiveHarness }) ?? slugForHarness(effectiveHarness, config))
    : null;
  if (githubOn && server && appSlug && !reconcileCredentials) {
    const dev = serverDeviceState({ env, home, server });
    if (!dev) {
      throw Object.assign(
        new Error(`this machine is not enrolled with ${server}; run: agent-bot server enroll --add-harness ${appSlug}`),
        { code: 'server-device-not-enrolled' },
      );
    }
    const scope = Array.isArray(dev.harnesses) ? dev.harnesses : [];
    if (!slugMatchesDeviceScope(appSlug, scope, config)) {
      throw Object.assign(
        new Error(`this device is not enrolled for ${appSlug} (enrolled: ${scope.join(', ') || 'none'}); run: agent-bot server enroll --add-harness ${appSlug}`),
        { code: 'server-harness-not-enrolled' },
      );
    }
  }

  // 4. Resolve conversation / transcript locator (read-only).
  //    Reuse `identity.transcript` ONLY when the caller checkout or target
  //    worktree already holds a live binding for this soul.
  const callerBinding = readBinding({ env, cwd: targetRepo.toplevel });
  let transcript = null;
  if (transcriptId) {
    transcript = { provider: provider ?? effectiveHarness, id: transcriptId, source: 'explicit' };
  } else {
    const discovered = await findTranscriptImpl({ env, cwd: targetRepo.toplevel, home });
    if (discovered) {
      transcript = {
        provider: provider ?? discovered.provider ?? effectiveHarness,
        id: discovered.id,
        source: 'auto-detected',
      };
    } else if (existingSoul?.identity?.transcript?.id && callerBinding?.agentId === existingSoul.identity.id) {
      transcript = {
        provider: provider ?? existingSoul.identity.transcript.provider ?? effectiveHarness,
        id: existingSoul.identity.transcript.id,
        source: 'reused-session',
      };
    }
  }

  // 5. Validate target worktree and branch plan before mutating anything.
  const currentAreaOwner = insideSoulWorktree(targetRepo.toplevel, popOptions);
  const currentBranch = tryGit(targetRepo.toplevel, ['symbolic-ref', '--short', 'HEAD'], env);
  const reuseInPlace = Boolean(
    existingSoul
    && currentAreaOwner === existingSoul.identity.id
    && (!name || path.basename(targetRepo.toplevel) === sanitizeWorktreeName(name))
    && (!branch || currentBranch === branch),
  );

  const worktreeName = name
    ? sanitizeWorktreeName(name)
    : sanitizeWorktreeName(branch ? `${targetRepo.repoName}-${branch}` : targetRepo.repoName);
  let targetBranch = reuseInPlace
    ? (currentBranch ?? branch ?? 'HEAD')
    : (branch ?? (name ? worktreeName : `worktree/${worktreeName}`));

  if (!reuseInPlace) {
    if (targetBranch.startsWith('@') || tryGit(targetRepo.toplevel, ['check-ref-format', `refs/heads/${targetBranch}`], env) === null) {
      throw Object.assign(
        new Error(`invalid branch name: ${targetBranch}`),
        { code: 'start-invalid-branch' },
      );
    }
  }

  const preExistingDest = existingSoul && !reuseInPlace
    ? soulWorktreePath(existingSoul.identity.id, worktreeName, { ...popOptions, readOnly: true })
    : null;
  const destBinding = reuseInPlace
    ? callerBinding
    : (preExistingDest && existsSync(preExistingDest) ? readBinding({ env, cwd: preExistingDest }) : null);

  if (!transcript && destBinding?.agentId === existingSoul?.identity?.id && existingSoul?.identity?.transcript?.id) {
    transcript = {
      provider: provider ?? existingSoul.identity.transcript.provider ?? effectiveHarness,
      id: existingSoul.identity.transcript.id,
      source: 'reused-session',
    };
  }
  if (!transcript && !destBinding) {
    throw Object.assign(
      new Error('no session transcript id was found for this conversation; pass --transcript-id <session-id>'),
      { code: 'start-transcript-required' },
    );
  }

  if (preExistingDest && existsSync(preExistingDest)) {
    const destToplevel = tryGit(preExistingDest, ['rev-parse', '--show-toplevel'], env);
    const destCommon = destToplevel
      ? tryGit(preExistingDest, ['rev-parse', '--path-format=absolute', '--git-common-dir'], env)
      : null;
    if (!destToplevel || !destCommon || realpathSync(destToplevel) !== realpathSync(preExistingDest) || realpathSync(destCommon) !== targetRepo.commonDir) {
      throw Object.assign(
        new Error(`worktree ${preExistingDest} already exists and is not a checkout of ${targetRepo.originSlug ?? targetRepo.repoName}`),
        { code: 'start-worktree-conflict' },
      );
    }
    const destBranch = tryGit(preExistingDest, ['symbolic-ref', '--short', 'HEAD'], env);
    if (branch && destBranch !== branch) {
      throw Object.assign(
        new Error(`worktree ${preExistingDest} is on branch ${destBranch}, not ${branch}; pass --name <worktree-name> for a separate worktree`),
        { code: 'start-worktree-branch-mismatch' },
      );
    }
  } else if (!reuseInPlace) {
    const branchExists = Boolean(tryGit(targetRepo.toplevel, ['show-ref', '--verify', `refs/heads/${targetBranch}`], env));
    if (branchExists && base) {
      throw Object.assign(
        new Error(`branch ${targetBranch} already exists locally; omit --base to check it out or pass a new --branch`),
        { code: 'start-base-on-existing-branch' },
      );
    }
    if (branchExists) {
      const occupiedBy = branchCheckedOutElsewhere(targetRepo.toplevel, targetBranch, preExistingDest ?? '', env);
      if (occupiedBy) {
        throw Object.assign(
          new Error(`branch ${targetBranch} is already checked out at ${occupiedBy}; pass a new --branch <branch>`),
          { code: 'start-branch-in-use' },
        );
      }
    }
  }

  // 6. All read-only preconditions passed: validate base ref if creating a new
  //    branch, create soul if none existed, create/reuse worktree, backfill
  //    appSlug if needed, configure attribution, and bind session.
  let usedBase = null;
  if (!reuseInPlace && !(preExistingDest && existsSync(preExistingDest))) {
    const branchExists = Boolean(tryGit(targetRepo.toplevel, ['show-ref', '--verify', `refs/heads/${targetBranch}`], env));
    if (!branchExists) {
      usedBase = base ?? defaultBaseRef(targetRepo.toplevel, targetBranch, env);
      if (tryGit(targetRepo.toplevel, ['rev-parse', '--verify', '-q', `${usedBase}^{commit}`], env) === null) {
        throw Object.assign(
          new Error(`base ref does not resolve to a commit: ${usedBase}`),
          { code: 'start-invalid-base' },
        );
      }
    }
  }

  let identity;
  let row;
  let soulResolution;
  if (existingSoul) {
    ({ identity, row, soulResolution } = existingSoul);
  } else {
    const joined = await joinSoul({
      name: harness,
      harness,
      ownWorkspace: true,
      env,
      home,
      config,
      ...(comms ? { comms } : {}),
    });
    identity = activeIdentity(joined.agentId, stateDir);
    row = showSoul(joined.agentId, popOptions);
    soulResolution = 'created';
  }

  let targetWorktree;
  let createdWorktree = false;

  if (reuseInPlace) {
    targetWorktree = targetRepo.toplevel;
  } else {
    const destination = soulWorktreePath(identity.id, worktreeName, { ...popOptions, readOnly: true });
    if (existsSync(destination)) {
      const destBranch = tryGit(destination, ['symbolic-ref', '--short', 'HEAD'], env);
      targetWorktree = realpathSync(destination);
      targetBranch = destBranch ?? targetBranch;
    } else {
      usedBase = usedBase ?? base ?? defaultBaseRef(targetRepo.toplevel, targetBranch, env);
      const placed = placeWorktree(identity.id, worktreeName, { ...popOptions, repoCommonDir: targetRepo.commonDir });
      const branchExists = Boolean(tryGit(targetRepo.toplevel, ['show-ref', '--verify', `refs/heads/${targetBranch}`], env));
      if (branchExists) {
        gitIn(targetRepo.toplevel, ['-c', 'core.hooksPath=/dev/null', 'worktree', 'add', placed.path, targetBranch], env);
      } else {
        gitIn(targetRepo.toplevel, ['-c', 'core.hooksPath=/dev/null', 'worktree', 'add', '--no-track', '-b', targetBranch, placed.path, usedBase], env);
      }
      clearInheritedPin(identity.id, { cwd: placed.path });
      targetWorktree = realpathSync(placed.path);
      createdWorktree = true;
    }
  }

  if (githubOn && !identity.github?.appSlug && appSlug) {
    const opEnv = { ...env, ...(home ? { HOME: home, USERPROFILE: home } : {}) };
    setSoulAppThen(
      identity.id,
      appSlug,
      { file: popOptions.file },
      () => identityOp('initialize-app', { id: identity.id, appSlug, stateDir, config }, { env: opEnv, cwd: targetRepo.toplevel }),
    );
    identity = activeIdentity(identity.id, stateDir) ?? identity;
    row = showSoul(identity.id, popOptions);
  }

  const effectiveReconcile = reconcileCredentials ?? (server && appSlug
    ? async () => [{ slug: appSlug, local: { status: 'ready' } }]
    : reconcileAppCredentials);

  const originalCwd = process.cwd();
  let configured;
  try {
    process.chdir(targetWorktree);
    configured = await configureWorktree({
      identity,
      options: { fetchImpl },
      config,
      reconcileCredentials: effectiveReconcile,
      ...(resolveBotUid ? { resolveBotUid } : {}),
      daemon: clientFactory ? await clientFactory({ env, home, cwd: targetWorktree }) : daemonClient({ env, home, cwd: targetWorktree }),
      env: { ...env, AGENT_BOT_ID: identity.id },
      home,
      stateDir,
      quiet: true,
    });
  } finally {
    process.chdir(originalCwd);
  }

  const bindResult = await sessionBind({
    cwd: targetWorktree,
    env: { ...env, AGENT_BOT_ID: identity.id },
    transcriptId: transcript?.id ?? null,
    provider: transcript?.provider ?? null,
    ...(clientFactory ? { clientFactory } : {}),
  });

  if (!transcript) {
    const updated = activeIdentity(identity.id, stateDir);
    transcript = {
      provider: updated?.transcript?.provider ?? effectiveHarness,
      id: updated?.transcript?.id ?? 'bound',
      source: 'reused-session',
    };
  }

  const callerReal = (() => {
    try { return realpathSync(cwd); } catch { return path.resolve(cwd); }
  })();
  const needsCd = callerReal !== targetWorktree;

  return {
    schema_version: 1,
    command: 'start',
    soul: {
      id: identity.id,
      name: row?.displayName ?? row?.name ?? null,
      harness: effectiveHarness,
      resolution: soulResolution,
    },
    session: {
      provider: transcript.provider,
      id: transcript.id,
      source: transcript.source,
    },
    repo: {
      name: targetRepo.originSlug ?? targetRepo.repoName,
      toplevel: targetRepo.toplevel,
      base: usedBase,
    },
    identity: {
      enabled: githubOn,
      appSlug: configured.appSlug,
      bot: configured.appSlug ? `${configured.appSlug}[bot]` : null,
      mode: server ? 'server' : (githubOn ? 'local' : 'off'),
      server,
    },
    worktree: {
      path: targetWorktree,
      branch: targetBranch,
      created: createdWorktree,
    },
    binding: {
      status: bindResult.status,
      alreadyBound: Boolean(bindResult.alreadyBound),
    },
    next: needsCd ? `cd ${shellSingleQuote(targetWorktree)}` : null,
  };
}

export async function main(argv = process.argv.slice(2)) {
  const options = parseStartArgs(argv);
  if (options.help) {
    process.stdout.write(START_USAGE);
    return;
  }
  const receipt = await startTask(options);
  if (options.json) {
    process.stdout.write(`${JSON.stringify(receipt)}\n`);
  } else {
    process.stdout.write(formatStartReceipt(receipt));
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(`start: ${error.message}\n`);
    process.exit(1);
  });
}
