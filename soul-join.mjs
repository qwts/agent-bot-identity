#!/usr/bin/env node
// `agent-bot join`: the one supported way for an agent nobody launched (an
// unmanaged agent: a terminal, an IDE, a desktop app) to become a soul and
// join agent-comms, with or without a GitHub App (#382).
//
//   agent-bot join --name NAME --harness H [--template PATH] [--soul AGENT_ID]
//                  [--wake resume:read-only|resume:workspace|acp] [--principal-stdin] [--json]
//
// 1. Soul: the one already pinned in this checkout, else --soul, else a new
//    instance of --template (default: a bundled Starter template when this
//    install ships one), else a new soul with no package.
// 2. Place: the current git checkout. Outside one, the soul's own
//    `worktrees/workspace` checkout, created on first join. A soul's folder
//    itself is never turned into a git repository: its files are the
//    soul's shareable package, and `worktrees/` is already excluded from it.
// 3. Pin: `agentBot.agentId` in that checkout's worktree config — the same pin
//    setup-worktree writes — so a plain `agent-comms` run there resolves the
//    soul with no environment variable. No GitHub attribution is written.
// 4. Record: the census row records the checkout, so a resume or webhook
//    wake runs there (#323, #334); the checkout is linked into the soul
//    (ADR-0332 decision 6); a bind token makes the MCP `bind` tool work.
// 5. Join: `agent-comms join --name NAME --harness H` as the soul.
// 6. Wake (#410): with --wake, new messages wake the soul. Cold wake is owner
//    only (#293), so the owner gate runs first, before anything is created:
//    a presented principal (GeniusBar, --principal-stdin) or the consent
//    dialog. Without --wake the soul's wake state is reported, so a caller
//    can tell it will not wake.
import { execFile, execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { ACP_SPAWN_REGISTRY, HARNESS_KEY_PATTERN, resolveSpawn } from './acp-registry.mjs';
import { mintBindToken, readBinding } from './agent-binding.mjs';
import { mintAgentIdentity, readAgentIdentity, stateDirectory, validateAgentId } from './agent-identity.mjs';
import { archiveSoulDirs, listSouls, populationFile, recordSoulDisplayName, retireIdentityWithPopulation, soulDirectory, upsertIdentitySoul } from './agent-population.mjs';
import { describeSetting, ownerGate, readColdWakeSettings, setColdWake, wakeSetting } from './cold-wake-settings.mjs';
import { initAgentSpace } from './agent-space.mjs';
import { daemonPreference, loadConfig } from './config.mjs';
import { AGENT_ID_KEYS } from './resolve-agent.mjs';
import { ensureSoulDirectory, installSoulHarnesses, soulHarnessesPath } from './soul-home.mjs';
import { bundledStarter, spawnSoulTemplate } from './soul-templates.mjs';
export { bundledStarter } from './soul-templates.mjs';
import { linkWorktree, soulWorktreePath } from './soul-worktrees.mjs';
import { resumeHarnessSupported } from './wake-resume.mjs';

const USAGE = 'usage: agent-bot join --name NAME --harness H [--template PATH] [--soul AGENT_ID] [--wake resume:read-only|resume:workspace|acp] [--principal-stdin] [--json]';
/** `--wake` values: a resume policy (#323) or an ACP turn (#259). A webhook needs its URL and key; use `soul cold-wake`. */
export const JOIN_WAKES = { 'resume:read-only': { lane: 'resume', policy: 'read-only' }, 'resume:workspace': { lane: 'resume', policy: 'workspace' }, acp: true };
export const WORKSPACE_NAME = 'workspace';

// The npm package a registry row runs through `npx -p PACKAGE` (version dropped).
function rowPackage(row) {
  const spec = row.args?.[row.args.indexOf('-p') + 1];
  if (row.args?.indexOf('-p') < 0 || typeof spec !== 'string') return null;
  const at = spec.lastIndexOf('@');
  return at > 0 ? spec.slice(0, at) : spec;
}

/**
 * An ACP wake runs the harness's adapter. A soul home installs it; a joined
 * checkout is someone's repository and does not, and a launchd daemon has
 * no npx on PATH. So the adapter goes in the soul's own harness directory
 * (#417), pinned by the soul's package if it declares it, else by the
 * bundled Starter. Returns how the wake will find its adapter.
 */
export async function ensureAcpHarness(agentId, harness, worktree, { env, options, installHarness = installSoulHarnesses }) {
  const row = ACP_SPAWN_REGISTRY[harness];
  if (!row?.soulBin) return 'not needed';
  const has = (dir) => existsSync(path.join(dir, 'node_modules', '.bin', row.soulBin));
  if (has(worktree)) return 'in checkout';
  const own = soulHarnessesPath(agentId, options);
  if (has(own)) return 'installed';
  const wanted = row.adapter?.package ?? rowPackage(row);
  const declares = (dir) => {
    try { return Boolean(dir && wanted && JSON.parse(readFileSync(path.join(dir, 'package.json'), 'utf8')).dependencies?.[wanted]); }
    catch { return false; }
  };
  const source = [soulDirectory(agentId, options), bundledStarter({ env })].find(declares);
  // An adapter row never falls back to npx (#418), so a wake with no pinned
  // adapter to install could never run: refuse it rather than report it on.
  const missing = () => new Error(`--wake acp needs the ${harness} adapter ${row.adapter.package}@${row.adapter.version}, `
    + 'which neither this soul\'s package nor the bundled Starter pins');
  if (!source) { if (row.adapter) throw missing(); return 'registry command'; }
  try { await installHarness(agentId, source, { ...options, harness }); }
  catch (error) { throw new Error(`--wake acp could not install the ${harness} adapter: ${error.message}`); }
  if (has(own)) return 'installed';
  if (row.adapter) throw missing();
  return 'registry command';
}

function gitIn(cwd, args) {
  return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 10_000 }).trim();
}

function checkoutOf(cwd) {
  try {
    return { worktree: gitIn(cwd, ['rev-parse', '--show-toplevel']), gitDir: gitIn(cwd, ['rev-parse', '--absolute-git-dir']) };
  } catch { return null; }
}

function pinnedSoul(worktree) {
  for (const key of AGENT_ID_KEYS) {
    try { const id = gitIn(worktree, ['config', '--get', key]); if (id) return id; } catch { /* next key */ }
  }
  return null;
}

function activeIdentity(id, stateDir) {
  try { return readAgentIdentity(id, { stateDir }).status === 'active'; } catch { return false; }
}

// The soul's own checkout for agents that start outside any repository.
function soulWorkspace(agentId, options) {
  ensureSoulDirectory(agentId, null, options);
  const worktree = soulWorktreePath(agentId, WORKSPACE_NAME, options);
  if (!existsSync(path.join(worktree, '.git'))) {
    mkdirSync(worktree, { recursive: true, mode: 0o700 });
    execFileSync('git', ['init', '-q', worktree], { stdio: 'ignore', timeout: 10_000 });
  }
  return checkoutOf(worktree);
}

/**
 * Runs `agent-comms join` as the soul in its checkout. The tools path a
 * GeniusBar install names (AGENT_BOT_TOOL_PATH) comes first, so the bundled
 * agent-comms answers even when a stale copy is on PATH.
 */
export function joinComms({ agentId, worktree, name, harness }, { env = process.env, run = execFile } = {}) {
  const { AGENT_BOT_BINDING: _ignored, ...hostEnv } = env;
  const tools = env.AGENT_BOT_TOOL_PATH && path.isAbsolute(env.AGENT_BOT_TOOL_PATH) ? env.AGENT_BOT_TOOL_PATH : null;
  const soulEnv = { ...hostEnv, ...(tools ? { PATH: [tools, env.PATH].filter(Boolean).join(path.delimiter) } : {}),
    AGENT_BOT_ID: agentId, QWTS_AGENT_ID: agentId };
  return new Promise((resolve, reject) => {
    run('agent-comms', ['join', '--name', name, '--harness', harness], { cwd: worktree, env: soulEnv, timeout: 30_000 },
      (error, stdout = '', stderr = '') => {
        let result = null;
        try { result = JSON.parse(String(stdout)); } catch { /* not JSON */ }
        if (!error && result?.ok !== false && typeof result?.address === 'string') return resolve(result.address);
        const detail = result?.error?.message ?? (String(stderr).trim().split('\n').pop() || error?.message || 'no result');
        reject(new Error(`agent-comms join failed: ${detail}`));
      });
  });
}

export async function joinSoul({
  name, harness, template, soul = null, cwd = process.cwd(), ownWorkspace = false, wake = null, principal = null,
  env = process.env, home = homedir(), config, daemon = null, comms = joinComms, spawn = spawnSoulTemplate, gate = ownerGate,
  installHarness = installSoulHarnesses, leave = null,
} = {}) {
  if (typeof name !== 'string' || !name.trim()) throw new Error('--name must be a nonempty string');
  if (typeof harness !== 'string' || !HARNESS_KEY_PATTERN.test(harness)) throw new Error('--harness must be a harness key');
  if (wake !== null && !Object.hasOwn(JOIN_WAKES, wake)) throw new Error(`--wake must be one of ${Object.keys(JOIN_WAKES).join(', ')}`);
  const loaded = config === undefined ? loadConfig({ env, home }) : config;
  const options = { env, home, config: loaded };
  const stateDir = stateDirectory(options);
  const file = populationFile(options);

  // 1. The soul. Resolving it changes nothing, so the checks and the
  //    owner's consent below can name the soul that is actually affected.
  // `ownWorkspace` (soul fork) joins in the soul's own workspace, never a
  // checkout the caller happens to stand in.
  let checkout = ownWorkspace ? null : checkoutOf(cwd);
  const pinned = checkout ? pinnedSoul(checkout.worktree) : null;
  const binding = checkout ? readBinding({ env: {}, gitDir: checkout.gitDir }) : null;
  let agentId = soul === null ? null : validateAgentId(soul);
  for (const claim of [pinned, binding?.agentId]) {
    if (!claim || !activeIdentity(claim, stateDir)) continue;
    if (agentId && agentId !== claim) throw new Error(`this checkout is already pinned to ${claim}; join from another folder`);
    agentId = claim;
  }
  if (agentId && !activeIdentity(agentId, stateDir)) throw new Error(`${agentId} is not an active soul`);
  // A wake runs the soul's stored harness, not --harness: an existing soul
  // must be joined with its own harness before it can wake.
  const existing = agentId ? readAgentIdentity(agentId, { stateDir }) : null;
  if (wake !== null && existing?.harness && existing.harness !== harness) {
    throw new Error(`${agentId} runs ${existing.harness}; join it with --harness ${existing.harness} to set its wake`);
  }
  if (wake === 'acp') {
    try { resolveSpawn(ACP_SPAWN_REGISTRY, harness); }
    catch { throw new Error(`${harness} has no ACP lane; use --wake resume:… or agent-bot soul cold-wake ... webhook`); }
  }
  if (wake?.startsWith('resume:') && !resumeHarnessSupported(harness)) throw new Error(`${harness} sessions cannot be resumed; use --wake acp or agent-bot soul cold-wake ... webhook`);
  // 6. The owner's consent comes before any change, so a refusal changes
  //    nothing. It names the existing soul being changed, or says it is new.
  let known = null;
  if (existing) {
    try {
      const record = listSouls({ file }).find((soul) => soul.id === agentId);
      known = record ? record.displayName ?? record.name : null; // the census name (#429)
    } catch { /* unnamed */ }
  }
  const authorization = wake === null ? null
    : await gate(existing
      ? `wake the existing soul ${known ?? 'unnamed'} (${agentId}) on new messages (${wake})`
      : `create a new soul ${name} and wake it on new messages (${wake})`, { principal, env, cwd });

  let created = false;
  if (!agentId) {
    const source = template === undefined ? bundledStarter({ env }) : template;
    if (source) {
      agentId = (await spawn(source, { ...options, stateDir, file, name, harness })).id;
    } else {
      agentId = mintAgentIdentity({ ...options, stateDir, appSlug: null, harness, useGithub: false }).id;
      upsertIdentitySoul(agentId, initAgentSpace(agentId, options).path, { file, stateDir });
    }
    created = true;
  }

  // Everything after soul creation is wrapped so a failure on a newly
  // created soul rolls back exactly like the failed-launch path (#421):
  // leave agent-comms, retire the soul, archive its folder (#435).
  let joined = false;
  try {
  // 2. The place, and 3. the pin.
  if (!checkout) checkout = soulWorkspace(agentId, { ...options, file });
  const { worktree, gitDir } = checkout;
  gitIn(worktree, ['config', 'extensions.worktreeConfig', 'true']);
  gitIn(worktree, ['config', '--worktree', 'agentBot.agentId', agentId]);

  // 4. The record. Same daemon policy as setup-worktree, so the census and
  //    spaces never diverge by invocation path.
  const { bindSoul } = await import('./setup-worktree.mjs');
  const { daemonClient } = await import('./agent-daemon.mjs');
  const client = daemon ?? daemonClient({ env, home });
  await bindSoul({
    agentId,
    policy: daemonPreference({ env, home, config: loaded }),
    client,
    worktree,
    ensureLocal: () => {
      const local = initAgentSpace(agentId, options);
      upsertIdentitySoul(agentId, local.path, { file, stateDir, worktree });
      return local;
    },
  });
  try { linkWorktree(agentId, worktree, { ...options, file }); }
  catch (error) { process.stderr.write(`agent-bot join: checkout not linked into its soul: ${error.message}\n`); }
  let bind = 'binding reused';
  let token = null;
  if (!readBinding({ env: {}, gitDir })) {
    try { token = mintBindToken({ gitDir, worktree: realpathSync(worktree), agentId }).token; bind = 'bind token minted'; }
    catch { bind = 'bind token unavailable'; }
  }
  // An ACP wake runs the soul through its daemon binding (#417), which a
  // bind token alone does not make: spend the token now. A soul that has a
  // conversation on record keeps it; one with none is bound to its join.
  if (wake === 'acp' && !readBinding({ env: {}, gitDir })) {
    if (!token) throw new Error('--wake acp needs a daemon binding, and no bind token could be minted in this checkout');
    const identity = readAgentIdentity(agentId, { stateDir });
    let bound;
    try {
      bound = await client.bind({ gitDir, token, harness: identity.harness ?? harness,
        transcript: identity.transcript ?? { provider: 'agent-bot-join', id: agentId } });
    } catch (error) {
      throw new Error(`--wake acp needs the agent-bot daemon to bind this checkout: ${error.message}`);
    }
    if (bound?.agentId !== agentId) throw new Error('the daemon bound this checkout to a different soul; wake was not turned on');
    bind = 'bound';
  }
  const adapter = wake === 'acp'
    ? await ensureAcpHarness(agentId, readAgentIdentity(agentId, { stateDir }).harness ?? harness, worktree, { env, options: { ...options, file }, installHarness })
    : null;

  // 6. Wake, turned on before agent-comms registers the soul: a message
  //    delivered during registration must find the wake already on. A
  //    failed registration puts the previous setting back.
  const previous = readColdWakeSettings({ env, home })[agentId];
  if (wake !== null) setColdWake(agentId, JOIN_WAKES[wake], { env, home });

  // 5. agent-comms.
  let address;
  try {
    address = await comms({ agentId, worktree, name, harness }, { env });
    joined = true;
  } catch (error) {
    if (wake !== null) {
      // A webhook's key is gone once another lane is set, so it is not restored.
      const restore = wakeSetting(previous);
      setColdWake(agentId, restore === null || restore.lane === 'webhook' ? false : restore.lane === 'acp' ? true : restore, { env, home });
    }
    throw error;
  }
  // The census now shows this name; every command shows the same one (#429).
  try { recordSoulDisplayName(agentId, name, { file }); }
  catch (error) { process.stderr.write(`agent-bot join: display name not recorded: ${error.message}\n`); }
  const state = describeSetting(readColdWakeSettings({ env, home })[agentId]);
  return { agentId, soulDir: soulDirectory(agentId, { ...options, file }), worktree, address, created, bind,
    wake: state, ...(adapter ? { adapter } : {}), ...(authorization ? { authorization: authorization.method } : {}) };
  } catch (error) {
    // Roll back a newly created soul on any failure after creation (#435),
    // exactly like the failed-launch path from #421.
    if (created) {
      try {
        if (joined) {
          const { leaveLaunchedSoul } = await import('./agent-daemon.mjs');
          const leaveFn = leave ?? ((soul) => leaveLaunchedSoul(soul, { env }));
          try { await leaveFn({ agentId }); } catch { /* best effort */ }
        }
        retireIdentityWithPopulation(agentId, { file, stateDir });
        archiveSoulDirs(agentId, { ...options, file });
      } catch { /* the join's own error is the one reported */ }
    }
    throw error;
  }
}

export function parseJoinArgs(argv) {
  const options = { json: false, principalStdin: false };
  const flags = { '--name': 'name', '--harness': 'harness', '--template': 'template', '--soul': 'soul', '--wake': 'wake' };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--json') { options.json = true; continue; }
    if (argv[i] === '--principal-stdin') { options.principalStdin = true; continue; }
    const key = flags[argv[i]];
    const value = argv[i + 1];
    if (!key || options[key] !== undefined || value === undefined || value.startsWith('--')) throw new Error(USAGE);
    options[key] = value;
    i++;
  }
  if (options.name === undefined || options.harness === undefined) throw new Error(USAGE);
  if (options.template !== undefined) options.template = path.resolve(options.template);
  if (options.wake !== undefined && !Object.hasOwn(JOIN_WAKES, options.wake)) throw new Error(USAGE);
  if (options.principalStdin && options.wake === undefined) throw new Error('--principal-stdin is only for --wake');
  return options;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const { json, principalStdin, name, harness, template, soul, wake } = parseJoinArgs(process.argv.slice(2));
    let principal = null;
    if (principalStdin) {
      try { principal = JSON.parse(readFileSync(0, 'utf8')); }
      catch { throw new Error('--principal-stdin needs the principal credential as JSON on stdin'); }
    }
    // Only the parsed flags reach joinSoul; its env stays process.env.
    const result = await joinSoul({ name, harness, template, soul, wake, principal });
    if (json) process.stdout.write(`${JSON.stringify(result)}\n`);
    else {
      process.stdout.write(`joined agent-comms as ${result.address}${result.created ? ' (new soul)' : ''}\n`
        + `  soul:     ${result.soulDir}\n  checkout: ${result.worktree}\n  wake:     ${result.wake}`
        + `${result.wake === 'off' ? ' (new messages wait in its inbox; add --wake to wake it)' : ''}\n`
        + `Run agent-comms from that checkout; it resolves this soul with no environment variable.\n`);
    }
  } catch (error) {
    process.stderr.write(`agent-bot join: ${error.message}\n`);
    process.exitCode = 1;
  }
}
