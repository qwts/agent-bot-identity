// A soul's home (#297): a private git worktree under the state directory
// that the daemon binds when a launched soul has no live binding, such as
// a soul spawned from a package or one whose binding expired. A package
// spawn starts its home from a copy of the package, so the harness reads
// the soul's AGENTS.md and skills from its working directory.
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { validateAgentId } from './agent-identity.mjs';

export function soulHomePath(stateDir, agentId) {
  return path.join(stateDir, 'homes', validateAgentId(agentId));
}

/**
 * Returns `provision({ agentId, harness, packagePath })`, which creates the
 * home when absent, binds it, and returns { worktree, file } like
 * `bindings.findAgent`.
 */
export function createSoulHomes({ stateDir, bindings }) {
  return function provision({ agentId, harness = null, packagePath = null }) {
    const worktree = soulHomePath(stateDir, agentId);
    if (!existsSync(path.join(worktree, '.git'))) {
      mkdirSync(worktree, { recursive: true, mode: 0o700 });
      if (packagePath) cpSync(packagePath, worktree, { recursive: true, verbatimSymlinks: true, force: false });
      execFileSync('git', ['init', '-q'], { cwd: worktree, env: { PATH: process.env.PATH }, stdio: 'ignore' });
    }
    const gitDir = realpathSync(path.join(worktree, '.git'));
    bindings.bind({ agentId, worktree, gitDir, harness });
    const bound = bindings.findAgent(agentId);
    if (!bound?.file) throw new Error('soul home could not be bound');
    return bound;
  };
}
