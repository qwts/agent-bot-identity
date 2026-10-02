// A soul's home (#297): a private git worktree under the state directory
// that the daemon binds when a launched soul has no live binding, such as
// a soul spawned from a package or one whose binding expired. A package
// spawn starts its home from a copy of the package, so the harness reads
// the soul's AGENTS.md and skills from its working directory, and installs
// the harnesses the package pins (ADR-0276).
import { execFile, execFileSync } from 'node:child_process';
import { appendFileSync, cpSync, existsSync, mkdirSync, realpathSync, rmSync } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { validateAgentId } from './agent-identity.mjs';

const run = promisify(execFile);
export const INSTALL_TIMEOUT_MS = 10 * 60_000;

export function soulHomePath(stateDir, agentId) {
  return path.join(stateDir, 'homes', validateAgentId(agentId));
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
export function createSoulHomes({ stateDir, bindings, install = installHarnesses }) {
  // One creation per home at a time: a second launch of the same new soul
  // waits for the first instead of racing it through copy and install.
  const creating = new Map();
  async function create(worktree, packagePath) {
    mkdirSync(worktree, { recursive: true, mode: 0o700 });
    try {
      if (packagePath) cpSync(packagePath, worktree, { recursive: true, verbatimSymlinks: true, force: false });
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
    const worktree = soulHomePath(stateDir, agentId);
    while (creating.has(worktree)) await creating.get(worktree).catch(() => {});
    if (!existsSync(path.join(worktree, '.git'))) {
      const made = create(worktree, packagePath);
      creating.set(worktree, made);
      try { await made; } finally { creating.delete(worktree); }
    }
    const gitDir = realpathSync(path.join(worktree, '.git'));
    bindings.bind({ agentId, worktree, gitDir, harness });
    const bound = bindings.findAgent(agentId);
    if (!bound?.file) throw new Error('soul home could not be bound');
    return bound;
  };
}
