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
import { listSouls, locateSoulDir, populationFile, setSoulAppThen, showSoul } from './agent-population.mjs';
import { isGateEnabled, loadConfig, slugForHarness, soulOwnsAppSlug } from './config.mjs';
import { daemonClient, identityOp } from './daemon-client.mjs';
import { accountHarness, accountName, detectAiAgentHarness, detectExplicitHarnessAgent, detectProcessTreeHarness, hasOpencodeExperimentalEnv, isOpencodeDirectEnv } from './detect-harness.mjs';
import { enroll, readBinding, reconcileAppCredentials, repoFromCheckout, resolveAgentSlug, serverUrl } from './identity-cli.mjs';
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
                            origin/HEAD or origin/main)
  --base <ref>              Base git ref when creating a new branch
  --repo <path|owner/name>  Target repository path or owner/name (default: cwd)
  --name <worktree-name>    Worktree directory name under <soulDir>/worktrees/
                            (default: <repo>-<branch> or <repo>; aliases:
                            --worktree, --worktree-dir)
  --harness <harness>       Harness key override (default: auto-detected)
  --soul <agent-id|name>    Soul Agent ID or census name override
  --transcript-id <id>      Conversation/session ID override
  --provider <name>         Transcript provider override
  --no-enroll               Do not initiate device-grant enrollment when the
                            device or harness is not yet enrolled in server mode
  --json                    Print structured JSON receipt
  -h, --help                Show this help and change nothing
`;

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
    noEnroll: false,
  };
  if (argv.includes('--help') || argv.includes('-h')) {
    options.help = true;
    return options;
  }
  const takeValue = (arg, next, current) => {
    if (!next || next.startsWith('-')) throw new Error(`${arg} requires a value`);
    if (current !== null) throw new Error(`${arg} may be passed only once`);
    return next;
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--json') {
      options.json = true;
    } else if (arg === '-b' || arg === '--branch') {
      options.branch = takeValue(arg, argv[i + 1], options.branch);
      i += 1;
    } else if (arg === '--base') {
      options.base = takeValue(arg, argv[i + 1], options.base);
      i += 1;
    } else if (arg === '--repo') {
      options.repo = takeValue(arg, argv[i + 1], options.repo);
      i += 1;
    } else if (arg === '--name') {
      options.name = takeValue(arg, argv[i + 1], options.name);
      i += 1;
    } else if (arg === '--worktree' || arg === '--worktree-dir') {
      const raw = takeValue(arg, argv[i + 1], options.name);
      const trimmed = raw.replace(/[\\/]+$/, '');
      if (
        !trimmed
        || trimmed.startsWith('/')
        || trimmed.startsWith('\\')
        || trimmed.split(/[\\/]+/).includes('..')
      ) {
        throw new Error('invalid worktree name: use 1–100 letters, numbers, dots, underscores or hyphens, starting with a letter or number');
      }
      const stripped = trimmed.replace(/^(?:\.worktrees|worktrees)[\\/]+/, '');
      if (stripped.includes('/') || stripped.includes('\\')) {
        throw new Error('invalid worktree name: use 1–100 letters, numbers, dots, underscores or hyphens, starting with a letter or number');
      }
      options.name = sanitizeWorktreeName(stripped);
      i += 1;
    } else if (arg === '--no-enroll') {
      options.noEnroll = true;
    } else if (arg === '--harness') {
      options.harness = takeValue(arg, argv[i + 1], options.harness);
      i += 1;
    } else if (arg === '--soul') {
      options.soul = takeValue(arg, argv[i + 1], options.soul);
      i += 1;
    } else if (arg === '--transcript-id') {
      options.transcriptId = takeValue(arg, argv[i + 1], options.transcriptId);
      i += 1;
    } else if (arg === '--provider') {
      options.provider = takeValue(arg, argv[i + 1], options.provider);
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

// Detect only agent-session markers (CLAUDECODE=1, CODEX_*, QWEN_CODE=1,
// <HARNESS>_AGENT=1, AI_AGENT, process ancestry, or an agent OS account).
// Deliberately excludes ambient editor markers (VSCODE_*, CURSOR_TRACE_ID,
// TERM_PROGRAM=vscode) so a human's editor terminal is never auto-attributed
// to a bot without an explicit --harness or --soul flag.
function detectAgentHarnessKey(env = process.env, config = null) {
  const acctKey = config ? accountHarness(config, accountName(env)) : null;
  if (acctKey) return acctKey;
  const aiAgent = typeof env?.AI_AGENT === 'string' ? env.AI_AGENT.toLowerCase() : '';
  if (
    env?.CLAUDECODE === '1'
    || (typeof env?.CLAUDE_CODE_ENTRYPOINT === 'string' && env.CLAUDE_CODE_ENTRYPOINT !== '')
    || env?.CLAUDE_AGENT === '1'
    || aiAgent.startsWith('claude')
    || /(?:^|[^a-z0-9])claude(?:[^a-z0-9]|$)/i.test(aiAgent)
  ) {
    return 'claude';
  }
  if (
    Object.keys(env ?? {}).some((k) => k.startsWith('CODEX_'))
    || env?.CODEX_AGENT === '1'
    || /(?:^|[^a-z0-9])codex(?:[^a-z0-9]|$)/i.test(aiAgent)
  ) {
    return 'codex';
  }
  if (
    env?.QWEN_CODE === '1'
    || env?.QWEN_AGENT === '1'
    || /(?:^|[^a-z0-9])qwen(?:[^a-z0-9]|$)/i.test(aiAgent)
  ) {
    return 'qwen';
  }
  if (
    isOpencodeDirectEnv(env)
    || /(?:^|[^a-z0-9])opencode(?:[^a-z0-9]|$)/i.test(aiAgent)
  ) {
    return 'opencode';
  }
  const explicit = detectExplicitHarnessAgent(env);
  if (explicit) return explicit;
  if (hasOpencodeExperimentalEnv(env)) return 'opencode';
  const aiHarness = detectAiAgentHarness(env?.AI_AGENT);
  if (aiHarness && aiHarness !== 'vscode') return aiHarness;
  return detectProcessTreeHarness({ env }) ?? aiHarness ?? null;
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

function originSlugFromGit(dir, env) {
  return repoFromCheckout(dir, { ...env, AGENT_BOT_SERVER_REPO: '' });
}

function isExplicitPathInput(repo) {
  return (
    repo.startsWith('/')
    || repo.startsWith('./')
    || repo.startsWith('../')
    || repo.startsWith('~/')
    || repo === '.'
    || repo === '..'
    || repo.includes('\\')
    || /^[A-Za-z]:[\\/]/.test(repo)
  );
}

function resolveTargetRepo({ repo, cwd, home, env, popOptions }) {
  let candidate = cwd;
  if (repo) {
    const expanded = repo.startsWith('~/') && home ? path.join(home, repo.slice(2)) : repo;
    if (!isExplicitPathInput(repo) && /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo)) {
      const wanted = repo.toLowerCase();
      const matchesOrigin = (dir) => {
        if (!dir || !existsSync(dir)) return false;
        const slug = originSlugFromGit(dir, env);
        return typeof slug === 'string' && slug.toLowerCase() === wanted;
      };
      const repoShort = repo.split('/')[1];
      const searchDirs = [
        cwd,
        path.resolve(cwd, expanded),
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
    } else if (existsSync(path.resolve(cwd, expanded))) {
      candidate = path.resolve(cwd, expanded);
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
  const originSlug = originSlugFromGit(toplevel, env) ?? null;
  const repoName = originSlug
    ? originSlug.split('/')[1]
    : path.basename(path.basename(commonDir) === '.git' ? path.dirname(commonDir) : toplevel);
  return { toplevel: realpathSync(toplevel), commonDir, originSlug, repoName };
}

function defaultBaseRef(toplevel, env) {
  const sym = tryGit(toplevel, ['symbolic-ref', '-q', '--short', 'refs/remotes/origin/HEAD'], env);
  if (sym && tryGit(toplevel, ['rev-parse', '--verify', '-q', sym], env)) return sym;
  for (const ref of ['origin/main', 'origin/master', 'main']) {
    if (tryGit(toplevel, ['rev-parse', '--verify', '-q', ref], env)) return ref;
  }
  throw Object.assign(
    new Error('could not resolve a default base branch (checked origin/HEAD, origin/main, origin/master, main); pass --base <ref>'),
    { code: 'start-invalid-base' },
  );
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

function normalizeServerOrigin(url) {
  return typeof url === 'string' ? url.trim().replace(/\/+$/, '') : '';
}

function serverDeviceState({ env, home, server }) {
  const stateBase = env.AGENT_BOT_SERVER_STATE
    ? path.resolve(env.AGENT_BOT_SERVER_STATE)
    : path.join(env.XDG_STATE_HOME ? path.resolve(env.XDG_STATE_HOME) : path.join(home, '.local', 'state'), 'agent-bot', 'server');
  try {
    const dev = JSON.parse(readFileSync(path.join(stateBase, 'device.json'), 'utf8'));
    if (!dev || typeof dev !== 'object' || Array.isArray(dev)) return null;
    if (dev.server && normalizeServerOrigin(dev.server) !== normalizeServerOrigin(server)) return null;
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
  explicitHarness,
  harness,
  toplevel,
  env,
  home,
  config,
  stateDir,
  popOptions,
}) {
  const souls = listSouls(popOptions).filter((s) => s.status !== 'retired');

  // Check caller's bound/ambient soul markers first so --soul and --harness
  // cannot silently cross into another soul's identity.
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
  let boundSoul = null;
  for (const candidate of [fromEnv, binding?.agentId, areaOwner, pinned]) {
    if (!candidate) continue;
    const identity = activeIdentity(candidate, stateDir);
    if (identity) {
      const row = showSoul(identity.id, popOptions);
      if (row.status !== 'retired') {
        boundSoul = { identity, row, soulResolution: 'reused-bound' };
        break;
      }
    }
  }

  if (explicitSoul) {
    const matches = souls.filter((s) => s.id === explicitSoul || s.name === explicitSoul || s.displayName === explicitSoul);
    if (matches.length > 1) {
      throw Object.assign(
        new Error(`multiple active souls match "${explicitSoul}" (${matches.map((s) => s.id).join(', ')}); pass the exact agent_... ID`),
        { code: 'start-ambiguous-soul' },
      );
    }
    const id = matches.length === 1 ? matches[0].id : validateAgentId(explicitSoul);
    const identity = activeIdentity(id, stateDir);
    if (!identity) throw new Error(`${explicitSoul} is not an active soul`);
    const row = showSoul(id, popOptions);
    if (boundSoul && boundSoul.identity.id !== identity.id) {
      throw Object.assign(
        new Error(`this session/checkout is already bound to soul ${boundSoul.identity.id}; refusing --soul ${explicitSoul}`),
        { code: 'start-soul-mismatch' },
      );
    }
    const soulHarness = identity.harness ?? row?.harness ?? null;
    if (harness && soulHarness && soulHarness !== harness) {
      throw Object.assign(
        new Error(`soul ${identity.id} belongs to harness ${soulHarness}; refusing harness ${harness}`),
        { code: 'start-harness-mismatch' },
      );
    }
    return { identity, row, soulResolution: 'explicit' };
  }

  if (boundSoul) {
    const boundHarness = boundSoul.identity.harness ?? boundSoul.row?.harness ?? null;
    if (explicitHarness && boundHarness && boundHarness !== explicitHarness) {
      throw Object.assign(
        new Error(`this session/checkout is already bound to soul ${boundSoul.identity.id} (harness ${boundHarness}); refusing --harness ${explicitHarness}`),
        { code: 'start-harness-mismatch' },
      );
    }
    return boundSoul;
  }

  if (!harness) {
    throw new Error('could not detect agent harness from environment; pass --harness <harness> or --soul <agent-id>');
  }

  const githubOn = isGateEnabled('github-identity', { env, home, config });
  const targetSlug = githubOn
    ? (resolveAgentSlug({ env, cwd: toplevel, config, harness }) ?? slugForHarness(harness, config))
    : null;

  const candidates = souls.filter((s) => {
    if (targetSlug) {
      if (s.appSlug === targetSlug || soulOwnsAppSlug({ id: s.id, harness: s.harness, github: { appSlug: s.appSlug } }, targetSlug, config, { env, home })) {
        return true;
      }
      return !s.appSlug && s.harness === harness;
    }
    return s.harness === harness;
  });

  const activeCandidates = [];
  for (const candidate of candidates) {
    const identity = activeIdentity(candidate.id, stateDir);
    if (identity) {
      activeCandidates.push({ identity, row: candidate });
    }
  }
  if (activeCandidates.length === 0) return null;
  if (activeCandidates.length > 1) {
    throw Object.assign(
      new Error(`multiple active souls match harness ${harness} (${activeCandidates.map((c) => c.identity.id).join(', ')}); pass --soul <agent-id>`),
      { code: 'start-ambiguous-soul' },
    );
  }
  return { identity: activeCandidates[0].identity, row: activeCandidates[0].row, soulResolution: `auto-resolved: ${harness}` };
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
  autoEnroll = false,
  enrollImpl = null,
  onEnrollPrompt = null,
} = {}) {
  const config = providedConfig ?? loadConfig({ env, home });
  const popOptions = { env, home, config, file: populationFile({ env, home, config }) };
  const stateDir = stateDirectory(popOptions);
  const harness = explicitHarness ?? detectAgentHarnessKey(env, config);

  // 1. Resolve target repository checkout (read-only).
  const targetRepo = resolveTargetRepo({ repo, cwd, home, env, popOptions });

  // 2. Look up existing canonical soul for this harness/session (read-only).
  const existingSoul = lookupExistingSoul({
    explicitSoul,
    explicitHarness,
    harness,
    toplevel: targetRepo.toplevel,
    env,
    home,
    config,
    stateDir,
    popOptions,
  });
  const effectiveHarness = harness ?? existingSoul?.identity?.harness ?? existingSoul?.row?.harness ?? 'custom';

  // 3. Verify server-mode readiness (and stage --add-harness device enrollment
  //    when autoEnroll / enrollImpl is active, before any soul or worktree creation).
  const githubOn = isGateEnabled('github-identity', { env, home, config });
  let server = null;
  try { server = serverUrl({ env, config }); } catch { server = null; }
  const appSlug = githubOn
    ? (existingSoul?.identity?.github?.appSlug ?? resolveAgentSlug({ env, cwd: targetRepo.toplevel, config, harness: effectiveHarness }) ?? slugForHarness(effectiveHarness, config))
    : null;
  if (githubOn && server) {
    let dev = serverDeviceState({ env, home, server });
    if (dev && !appSlug) {
      throw Object.assign(
        new Error(`no GitHub App slug is configured for harness ${effectiveHarness}`),
        { code: 'start-no-app-slug' },
      );
    }
    const scope = Array.isArray(dev?.harnesses) ? dev.harnesses : [];
    const needsEnroll = !dev || !slugMatchesDeviceScope(appSlug, scope, config);
    if (needsEnroll && (autoEnroll || typeof enrollImpl === 'function')) {
      if (!appSlug) {
        throw Object.assign(
          new Error(`no GitHub App slug is configured for harness ${effectiveHarness}`),
          { code: 'start-no-app-slug' },
        );
      }
      const hadDev = Boolean(dev);
      const runEnroll = typeof enrollImpl === 'function'
        ? enrollImpl
        : enroll;
      const defaultPrompt = (p) => {
        process.stderr.write(
          `Device scope expansion required for ${appSlug}:\n`
          + `Approve this device at ${p.verification_uri_complete}\n`
          + `  code: ${p.user_code}\n`
          + `  key:  ${p.jkt}\n`
          + 'Waiting for approval…\n',
        );
      };
      try {
        await runEnroll({
          base: server,
          env,
          home,
          addHarnesses: [appSlug],
          ...(fetchImpl ? { fetchImpl } : {}),
          onPrompt: onEnrollPrompt ?? defaultPrompt,
        });
      } catch (err) {
        const fallbackCmd = `agent-bot server enroll --add-harness ${appSlug}`;
        throw Object.assign(
          new Error(
            hadDev
              ? `this device is not enrolled for ${appSlug} (enrolled: ${scope.join(', ') || 'none'}) and automatic enrollment failed (${err.message}); run: ${fallbackCmd}`
              : `this machine is not enrolled with ${server} and automatic enrollment failed (${err.message}); run: ${fallbackCmd}`,
          ),
          { code: hadDev ? 'server-harness-not-enrolled' : 'server-device-not-enrolled', cause: err },
        );
      }
      dev = serverDeviceState({ env, home, server });
    }
    if (!dev) {
      throw Object.assign(
        new Error(`this machine is not enrolled with ${server}; run: agent-bot server enroll${appSlug ? ` --add-harness ${appSlug}` : ''}`),
        { code: 'server-device-not-enrolled' },
      );
    }
    if (!appSlug) {
      throw Object.assign(
        new Error(`no GitHub App slug is configured for harness ${effectiveHarness}`),
        { code: 'start-no-app-slug' },
      );
    }
    const updatedScope = Array.isArray(dev.harnesses) ? dev.harnesses : [];
    if (!slugMatchesDeviceScope(appSlug, updatedScope, config)) {
      throw Object.assign(
        new Error(`this device is not enrolled for ${appSlug} (enrolled: ${updatedScope.join(', ') || 'none'}); run: agent-bot server enroll --add-harness ${appSlug}`),
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
    const discovered = (await findTranscriptImpl({ env, cwd, home }))
      ?? (cwd !== targetRepo.toplevel ? await findTranscriptImpl({ env, cwd: targetRepo.toplevel, home }) : null);
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

  const branchExistsLocally = Boolean(tryGit(targetRepo.toplevel, ['show-ref', '--verify', `refs/heads/${targetBranch}`], env));
  if (base && (reuseInPlace || (preExistingDest && existsSync(preExistingDest)) || branchExistsLocally)) {
    throw Object.assign(
      new Error(`branch ${targetBranch} already exists locally; omit --base to check it out or pass a new --branch`),
      { code: 'start-base-on-existing-branch' },
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
  } else if (!reuseInPlace && branchExistsLocally) {
    const occupiedBy = branchCheckedOutElsewhere(targetRepo.toplevel, targetBranch, preExistingDest ?? '', env);
    if (occupiedBy) {
      throw Object.assign(
        new Error(`branch ${targetBranch} is already checked out at ${occupiedBy}; pass a new --branch <branch>`),
        { code: 'start-branch-in-use' },
      );
    }
  }

  // 6. All read-only preconditions passed: validate base ref if creating a new
  //    branch, create soul if none existed, create/reuse worktree, backfill
  //    appSlug if needed, configure attribution, and bind session.
  let usedBase = null;
  if (!reuseInPlace && !(preExistingDest && existsSync(preExistingDest)) && !branchExistsLocally) {
    usedBase = base ?? defaultBaseRef(targetRepo.toplevel, env);
    if (tryGit(targetRepo.toplevel, ['rev-parse', '--verify', '-q', `${usedBase}^{commit}`], env) === null) {
      throw Object.assign(
        new Error(`base ref does not resolve to a commit: ${usedBase}`),
        { code: 'start-invalid-base' },
      );
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
      usedBase = usedBase ?? base ?? defaultBaseRef(targetRepo.toplevel, env);
      const placed = placeWorktree(identity.id, worktreeName, { ...popOptions, repoCommonDir: targetRepo.commonDir });
      if (branchExistsLocally) {
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

  const effectiveReconcile = reconcileCredentials ?? ((opts) => reconcileAppCredentials({
    ...opts,
    config,
    ...(fetchImpl ? { fetchImpl } : {}),
  }));

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
  const receipt = await startTask({
    branch: options.branch,
    base: options.base,
    repo: options.repo,
    name: options.name,
    harness: options.harness,
    soul: options.soul,
    transcriptId: options.transcriptId,
    provider: options.provider,
    autoEnroll: !options.noEnroll,
  });
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
