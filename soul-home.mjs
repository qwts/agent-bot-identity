// A soul's home (#338): a private git worktree inside its soul directory
// that the daemon binds when a launched soul has no live binding, such as
// a soul spawned from a package or one whose binding expired. A package
// spawn starts its home from a copy of the package, so the harness reads
// the soul's AGENTS.md and skills from its working directory, and installs
// the harnesses the package pins (ADR-0276).
import { execFile, execFileSync } from 'node:child_process';
import { appendFileSync, chmodSync, cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { validateAgentId } from './agent-identity.mjs';
import { populationFile, registerSoulDir, showSoul, soulDirectory } from './agent-population.mjs';

const run = promisify(execFile);
export const INSTALL_TIMEOUT_MS = 10 * 60_000;

export function legacyHomePath(stateDir, agentId) {
  return path.join(stateDir, 'homes', validateAgentId(agentId));
}

export function soulHomePath(agentId, options = {}) {
  return path.join(soulDirectory(agentId, options), '.soul-state', 'home');
}

// Preserve live checkout bindings; home launches always provision so a
// migration interrupted after rebinding still finishes cleanup next launch.
export function soulBindingForLaunch(agentId, { stateDir, bindings, provision, harness = null }) {
  const binding = bindings.findAgent(agentId);
  const worktree = binding?.worktree;
  if (worktree && (worktree === legacyHomePath(stateDir, agentId)
      || (path.basename(worktree) === 'home' && path.basename(path.dirname(worktree)) === '.soul-state')
      || !existsSync(worktree))) {
    return provision({ agentId, harness });
  }
  return binding;
}

// Claim only an empty/unmarked soul directory, never another soul's state.
export function ensureSoulDirectory(agentId, packagePath = null, options = {}) {
  validateAgentId(agentId);
  const directory = soulDirectory(agentId, options);
  const state = path.join(directory, '.soul-state');
  const marker = path.join(state, 'agent-id');
  if (existsSync(marker) && readFileSync(marker, 'utf8').trim() !== agentId) {
    throw new Error('soul directory belongs to another Agent ID');
  }
  if (!existsSync(directory)) {
    if (packagePath) cpSync(packagePath, directory, { recursive: true, verbatimSymlinks: true,
      filter: (source) => !['.soul-state', 'worktrees'].includes(path.relative(packagePath, source).split(path.sep)[0]) });
    else mkdirSync(directory, { recursive: true, mode: 0o700 });
  }
  mkdirSync(state, { recursive: true, mode: 0o700 });
  chmodSync(state, 0o700);
  try { writeFileSync(marker, `${agentId}\n`, { flag: 'wx', mode: 0o600 }); }
  catch (error) {
    if (error.code !== 'EEXIST') throw error;
    if (readFileSync(marker, 'utf8').trim() !== agentId) throw new Error('soul directory belongs to another Agent ID');
  }
  registerSoulDir(agentId, directory, { file: options.file ?? populationFile(options) });
  const link = path.join(state, 'space');
  let present = false;
  try { lstatSync(link); present = true; } catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (!present) {
    const soul = showSoul(agentId, { file: options.file ?? populationFile(options) });
    try { symlinkSync(soul.spacePath, link, 'dir'); }
    catch (error) { if (error.code !== 'EEXIST') throw error; }
  }
  return directory;
}

/**
 * How to run npm: the host's own copy when it names one in AGENT_BOT_NPM
 * (an npm-cli.js run with this Node), else `npm` from PATH.
 */
export function npmCommand(env = process.env, node = process.execPath) {
  return env.AGENT_BOT_NPM ? { command: node, args: [env.AGENT_BOT_NPM] } : { command: 'npm', args: [] };
}

/**
 * Installs a home's pinned dependencies: `npm ci` from its lockfile, with
 * lifecycle scripts off and no global install. A home without a
 * package.json has nothing to install.
 */
export async function installHarnesses(worktree, { env = process.env, node = process.execPath, runImpl = run } = {}) {
  if (!existsSync(path.join(worktree, 'package.json'))) return false;
  if (!existsSync(path.join(worktree, 'package-lock.json'))) throw new Error('a soul package.json needs a package-lock.json');
  const npm = npmCommand(env, node);
  try {
    await runImpl(npm.command, [...npm.args, 'ci', '--ignore-scripts', '--omit=dev', '--no-audit', '--no-fund'], {
      cwd: worktree, timeout: INSTALL_TIMEOUT_MS,
      env: { ...env, PATH: [path.dirname(node), env.PATH].filter(Boolean).join(path.delimiter) },
    });
  } catch (error) {
    const detail = String(error.stderr ?? error.message ?? error).trim().split('\n').slice(-3).join(' ');
    throw new Error(`installing the soul's harnesses failed: ${detail}`);
  }
  return true;
}

/**
 * Returns `provision({ agentId, harness, packagePath })`, which creates the
 * home when absent, binds it, and returns { worktree, file } like
 * `bindings.findAgent`.
 */
export function createSoulHomes({ stateDir, bindings, install = installHarnesses, rename = renameSync, ...options }) {
  // One creation per home at a time: a second launch of the same new soul
  // waits for the first instead of racing it through copy and install.
  const creating = new Map();
  async function create(worktree, packagePath) {
    mkdirSync(worktree, { recursive: true, mode: 0o700 });
    try {
      if (packagePath) {
        for (const name of readdirSync(packagePath)) {
          if (['.soul-state', 'worktrees'].includes(name)) continue;
          cpSync(path.join(packagePath, name), path.join(worktree, name), { recursive: true, verbatimSymlinks: true, force: false });
        }
      }
      await install(worktree);
      execFileSync('git', ['init', '-q'], { cwd: worktree, env: { PATH: process.env.PATH }, stdio: 'ignore' });
      appendFileSync(path.join(worktree, '.git', 'info', 'exclude'), 'node_modules/\n');
    } catch (error) {
      // A half-made home is removed, so the next launch starts it afresh.
      rmSync(worktree, { recursive: true, force: true });
      throw error;
    }
  }
  return async function provision({ agentId, harness = null, packagePath = null }) {
    validateAgentId(agentId);
    const directory = ensureSoulDirectory(agentId, packagePath, options);
    const worktree = path.join(directory, '.soul-state', 'home');
    while (creating.has(worktree)) await creating.get(worktree).catch(() => {});
    const legacy = legacyHomePath(stateDir, agentId);
    const state = path.dirname(worktree);
    const migratedFrom = path.join(state, 'migrated-from');
    const staging = path.join(state, 'home.migrating');
    if (!existsSync(path.join(worktree, '.git')) && existsSync(path.join(legacy, '.git'))) {
      // Persist intent before the atomic move. On restart the complete new
      // home proves promotion succeeded, even if cleanup was interrupted.
      writeFileSync(migratedFrom, `${legacy}\n`, { mode: 0o600 });
      rmSync(staging, { recursive: true, force: true });
      try { rename(legacy, worktree); }
      catch (error) {
        if (error.code !== 'EXDEV') throw error;
        cpSync(legacy, staging, { recursive: true, verbatimSymlinks: true });
        rename(staging, worktree);
      }
    }
    if (!existsSync(path.join(worktree, '.git'))) {
      const made = create(worktree, directory);
      creating.set(worktree, made);
      try { await made; } finally { creating.delete(worktree); }
    }
    const gitDir = realpathSync(path.join(worktree, '.git'));
    const migrated = existsSync(migratedFrom) && readFileSync(migratedFrom, 'utf8').trim() === legacy;
    const previous = bindings.findAgent(agentId);
    const replacesWorktree = migrated ? legacy : previous?.worktree && !existsSync(previous.worktree) ? previous.worktree : null;
    bindings.bind({ agentId, worktree, gitDir, harness, ...(replacesWorktree ? { replacesWorktree } : {}) });
    const bound = bindings.findAgent(agentId);
    if (!bound?.file) throw new Error('soul home could not be bound');
    // Rebind before removing the old copy. A failed binding can be retried
    // without losing either complete home.
    if (migrated) {
      rmSync(legacy, { recursive: true, force: true });
      rmSync(staging, { recursive: true, force: true });
    }
    return bound;
  };
}
