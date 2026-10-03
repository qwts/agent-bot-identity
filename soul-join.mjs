#!/usr/bin/env node
// `agent-bot join`: the one supported way for an agent nobody launched (an
// unmanaged agent: a terminal, an IDE, a desktop app) to become a soul and
// join agent-comms, with or without a GitHub App (#382).
//
//   agent-bot join --name NAME --harness H [--template PATH] [--soul AGENT_ID] [--json]
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
import { execFile, execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { HARNESS_KEY_PATTERN } from './acp-registry.mjs';
import { mintBindToken, readBinding } from './agent-binding.mjs';
import { mintAgentIdentity, readAgentIdentity, stateDirectory, validateAgentId } from './agent-identity.mjs';
import { populationFile, recordSoulDisplayName, soulDirectory, upsertIdentitySoul } from './agent-population.mjs';
import { initAgentSpace } from './agent-space.mjs';
import { daemonPreference, loadConfig } from './config.mjs';
import { AGENT_ID_KEYS } from './resolve-agent.mjs';
import { ensureSoulDirectory } from './soul-home.mjs';
import { spawnSoulTemplate } from './soul-templates.mjs';
import { linkWorktree, soulWorktreePath } from './soul-worktrees.mjs';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const USAGE = 'usage: agent-bot join --name NAME --harness H [--template PATH] [--soul AGENT_ID] [--json]';
export const WORKSPACE_NAME = 'workspace';

/**
 * The Starter template this install ships, if any: AGENT_BOT_STARTER_TEMPLATE,
 * else GeniusBar's bundle layout (Resources/components/agent-bot next to
 * Resources/souls/starter.soul). Homebrew and source installs ship none.
 */
export function bundledStarter({ env = process.env, root = ROOT } = {}) {
  if (env.AGENT_BOT_STARTER_TEMPLATE) return path.resolve(env.AGENT_BOT_STARTER_TEMPLATE);
  const candidate = path.resolve(root, '..', '..', 'souls', 'starter.soul');
  return existsSync(path.join(candidate, 'soul.json')) ? candidate : null;
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
  name, harness, template, soul = null, cwd = process.cwd(),
  env = process.env, home = homedir(), config, daemon = null, comms = joinComms, spawn = spawnSoulTemplate,
} = {}) {
  if (typeof name !== 'string' || !name.trim()) throw new Error('--name must be a nonempty string');
  if (typeof harness !== 'string' || !HARNESS_KEY_PATTERN.test(harness)) throw new Error('--harness must be a harness key');
  const loaded = config === undefined ? loadConfig({ env, home }) : config;
  const options = { env, home, config: loaded };
  const stateDir = stateDirectory(options);
  const file = populationFile(options);

  // 1. The soul.
  let checkout = checkoutOf(cwd);
  const pinned = checkout ? pinnedSoul(checkout.worktree) : null;
  const binding = checkout ? readBinding({ env: {}, gitDir: checkout.gitDir }) : null;
  let agentId = soul === null ? null : validateAgentId(soul);
  for (const claim of [pinned, binding?.agentId]) {
    if (!claim || !activeIdentity(claim, stateDir)) continue;
    if (agentId && agentId !== claim) throw new Error(`this checkout is already pinned to ${claim}; join from another folder`);
    agentId = claim;
  }
  let created = false;
  if (agentId) {
    if (!activeIdentity(agentId, stateDir)) throw new Error(`${agentId} is not an active soul`);
  } else {
    const source = template === undefined ? bundledStarter({ env }) : template;
    if (source) {
      agentId = (await spawn(source, { ...options, stateDir, file, name, harness })).id;
    } else {
      agentId = mintAgentIdentity({ ...options, stateDir, appSlug: null, harness, useGithub: false }).id;
      upsertIdentitySoul(agentId, initAgentSpace(agentId, options).path, { file, stateDir });
    }
    created = true;
  }

  // 2. The place, and 3. the pin.
  if (!checkout) checkout = soulWorkspace(agentId, { ...options, file });
  const { worktree, gitDir } = checkout;
  gitIn(worktree, ['config', 'extensions.worktreeConfig', 'true']);
  gitIn(worktree, ['config', '--worktree', 'agentBot.agentId', agentId]);

  // 4. The record. Same daemon policy as setup-worktree, so the census and
  //    spaces never diverge by invocation path.
  const { bindSoul } = await import('./setup-worktree.mjs');
  const { daemonClient } = await import('./agent-daemon.mjs');
  await bindSoul({
    agentId,
    policy: daemonPreference({ env, home, config: loaded }),
    client: daemon ?? daemonClient({ env, home }),
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
  if (!readBinding({ env: {}, gitDir })) {
    try { mintBindToken({ gitDir, worktree: realpathSync(worktree), agentId }); bind = 'bind token minted'; }
    catch { bind = 'bind token unavailable'; }
  }

  // 5. agent-comms.
  const address = await comms({ agentId, worktree, name, harness }, { env });
  // The census now shows this name; every command shows the same one (#429).
  try { recordSoulDisplayName(agentId, name, { file }); }
  catch (error) { process.stderr.write(`agent-bot join: display name not recorded: ${error.message}\n`); }
  return { agentId, soulDir: soulDirectory(agentId, { ...options, file }), worktree, address, created, bind };
}

export function parseJoinArgs(argv) {
  const options = { json: false };
  const flags = { '--name': 'name', '--harness': 'harness', '--template': 'template', '--soul': 'soul' };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--json') { options.json = true; continue; }
    const key = flags[argv[i]];
    const value = argv[i + 1];
    if (!key || options[key] !== undefined || value === undefined || value.startsWith('--')) throw new Error(USAGE);
    options[key] = value;
    i++;
  }
  if (options.name === undefined || options.harness === undefined) throw new Error(USAGE);
  if (options.template !== undefined) options.template = path.resolve(options.template);
  return options;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const { json, ...options } = parseJoinArgs(process.argv.slice(2));
    const result = await joinSoul(options);
    if (json) process.stdout.write(`${JSON.stringify(result)}\n`);
    else {
      process.stdout.write(`joined agent-comms as ${result.address}${result.created ? ' (new soul)' : ''}\n`
        + `  soul:     ${result.soulDir}\n  checkout: ${result.worktree}\n`
        + `Run agent-comms from that checkout; it resolves this soul with no environment variable.\n`);
    }
  } catch (error) {
    process.stderr.write(`agent-bot join: ${error.message}\n`);
    process.exitCode = 1;
  }
}
