import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { GIT_HOOK_NAMES } from '../git-hooks.mjs';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const MODULES = new Map([
  ['bootstrap', 'bootstrap.mjs'],
  ['setup-worktree', 'setup-worktree.mjs'],
  ['mint-token', 'mint-token.mjs'],
  ['doctor', 'doctor.mjs'],
  ['identity', 'agent-identity.mjs'],
  ['space', 'agent-space.mjs'],
  ['population', 'agent-population.mjs'],
  ['install', 'install.mjs'],
  ['update', 'update.mjs'],
  ['install-gh-shim', 'install-gh-shim.mjs'],
  ['ensure-private-key', 'ensure-private-key.mjs'],
  ['signed-commit', 'signed-commit.mjs'],
  ['secret', 'secret.mjs'],
  ['credential', 'git-credential-bot.mjs'],
  ['worktree-token', 'worktree-token.mjs'],
  ['gh-inbox-query', 'gh-inbox-query.mjs'],
  ['gh-pr-view-json', 'gh-pr-view-json.mjs'],
  ['claude-worktree-create', 'claude-worktree-create.mjs'],
  ['agent-hook', 'agent-hook.mjs'],
]);

const HOOK_PATTERN = /^[a-z][a-z0-9-]*$/;

function run(executable, args) {
  const result = spawnSync(executable, args, { stdio: 'inherit', env: process.env });
  if (result.error) throw result.error;
  return result.status ?? 1;
}

export function dispatchAgentBot(parsed) {
  if (parsed.command === 'hook') {
    if (!HOOK_PATTERN.test(parsed.hook)) throw new Error(`invalid hook name: ${parsed.hook}`);
    const hook = join(ROOT, 'hooks', parsed.hook);
    if (!GIT_HOOK_NAMES.includes(parsed.hook) || !existsSync(hook)) {
      throw new Error(`unsupported hook: ${parsed.hook}`);
    }
    return run(hook, parsed.args);
  }
  const module = MODULES.get(parsed.command);
  if (!module) throw new Error(`unsupported command: ${parsed.command}`);
  return run(process.execPath, [join(ROOT, module), ...parsed.args]);
}
