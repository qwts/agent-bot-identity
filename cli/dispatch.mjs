import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { GIT_HOOK_NAMES } from '../git-hooks.mjs';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const MODULES = new Map([
  ['bootstrap', 'bootstrap.mjs'],
  ['setup-worktree', 'setup-worktree.mjs'],
  ['join', 'soul-join.mjs'],
  ['mint-token', 'mint-token.mjs'],
  ['doctor', 'doctor.mjs'],
  ['identity', 'agent-identity.mjs'],
  ['space', 'agent-space.mjs'],
  ['population', 'agent-population.mjs'],
  ['principal', 'agent-principals.mjs'],
  ['binding', 'agent-binding.mjs'],
  ['soul', 'cold-wake-settings.mjs'],
  ['harness', 'harness-auth.mjs'],
  ['daemon', 'agent-daemon.mjs'],
  ['keyd', 'keyd-client.mjs'],
  ['approvals', 'agent-approvals.mjs'],
  ['audit', 'agent-audit.mjs'],
  ['mcp', 'agent-mcp.mjs'],
  ['reach-mcp', 'daemon-mcp.mjs'],
  ['wake', 'wake-listen.mjs'],
  ['web', 'agent-web.mjs'],
  ['telegram', 'telegram-adapter.mjs'],
  ['install', 'install.mjs'],
  ['update', 'update.mjs'],
  ['install-gh-shim', 'install-gh-shim.mjs'],
  ['ensure-private-key', 'ensure-private-key.mjs'],
  ['signed-commit', 'signed-commit.mjs'],
  ['secret', 'secret.mjs'],
  ['skill', 'skill.mjs'],
  ['sop', 'sop.mjs'],
  ['metrics', 'metrics.mjs'],
  ['credential', 'git-credential-bot.mjs'],
  ['worktree-token', 'worktree-token.mjs'],
  ['gh-inbox-query', 'gh-inbox-query.mjs'],
  ['gh-pr-view-json', 'gh-pr-view-json.mjs'],
  ['claude-worktree-create', 'claude-worktree-create.mjs'],
  ['agent-hook', 'agent-hook.mjs'],
]);

const HOOK_PATTERN = /^[a-z][a-z0-9-]*$/;

function run(executable, args, env = process.env) {
  const result = spawnSync(executable, args, { stdio: 'inherit', env });
  if (result.error) throw result.error;
  return result.status ?? 1;
}

// A following reader must remain interruptible while its child is running.
// The synchronous dispatcher used by finite commands cannot forward SIGINT.
function follow(executable, args) {
  const child = spawn(executable, args, { stdio: 'inherit' });
  const interrupt = () => child.kill('SIGINT');
  process.on('SIGINT', interrupt);
  child.once('error', (error) => {
    process.stderr.write(`agent-bot: ${error.message}\n`);
    process.exitCode = 1;
    process.off('SIGINT', interrupt);
  });
  child.once('exit', (code, signal) => {
    process.off('SIGINT', interrupt);
    process.exitCode = code ?? (signal === 'SIGINT' ? 130 : 1);
  });
  return 0;
}

export function dispatchAgentBot(parsed) {
  if (parsed.command === 'soul' && parsed.args[0] === 'stop') {
    return run(process.execPath, [join(ROOT, 'soul-stop.mjs'), ...parsed.args.slice(1)]);
  }
  if (parsed.command === 'soul' && ['pause', 'resume'].includes(parsed.args[0])) {
    return run(process.execPath, [join(ROOT, 'soul-pause.mjs'), ...parsed.args]);
  }
  if (parsed.command === 'soul' && parsed.args[0] === 'show') {
    return run(process.execPath, [join(ROOT, 'agent-population.mjs'), ...parsed.args]);
  }
  if (parsed.command === 'soul' && ['confinement', 'confinement-report'].includes(parsed.args[0])) {
    return run(process.execPath, [join(ROOT, 'confinement.mjs'), ...parsed.args]);
  }
  if (parsed.command === 'soul' && parsed.args[0] === 'spawn') {
    return run(process.execPath, [join(ROOT, 'soul-templates.mjs'), ...parsed.args.slice(1)]);
  }
  if (parsed.command === 'identity' && parsed.args[0] === 'migrate-credentials') {
    return run(process.execPath, [join(ROOT, 'soul-credentials.mjs'), ...parsed.args.slice(1)]);
  }
  if (parsed.command === 'hook') {
    if (!HOOK_PATTERN.test(parsed.hook)) throw new Error(`invalid hook name: ${parsed.hook}`);
    const hook = join(ROOT, 'hooks', parsed.hook);
    if (!GIT_HOOK_NAMES.includes(parsed.hook) || !existsSync(hook)) {
      throw new Error(`unsupported hook: ${parsed.hook}`);
    }
    return run(hook, parsed.args);
  }
  if (parsed.command === 'soul' && parsed.args[0] === 'dir') {
    return run(process.execPath, [join(ROOT, 'soul-dir.mjs'), ...parsed.args.slice(1)]);
  }
  if (parsed.command === 'soul' && parsed.args[0] === 'locate') {
    return run(process.execPath, [join(ROOT, 'soul-dir.mjs'), ...parsed.args]);
  }
  if (parsed.command === 'soul' && parsed.args[0] === 'build') {
    return run(process.execPath, [join(ROOT, 'soul-build.mjs'), ...parsed.args.slice(1)]);
  }
  if (parsed.command === 'soul' && parsed.args[0] === 'pack') {
    return run(process.execPath, [join(ROOT, 'soul-package.mjs'), ...parsed.args.slice(1)]);
  }
  if (parsed.command === 'soul' && parsed.args[0] === 'model') return run(process.execPath, [join(ROOT, 'soul-model.mjs'), ...parsed.args.slice(1)]);
  if (parsed.command === 'soul' && parsed.args[0] === 'mode') return run(process.execPath, [join(ROOT, 'soul-mode.mjs'), ...parsed.args.slice(1)]);
  if (parsed.command === 'soul' && parsed.args[0] === 'comms') {
    return run(process.execPath, [join(ROOT, 'soul-comms.mjs'), ...parsed.args.slice(1)]);
  }
  if (parsed.command === 'soul' && parsed.args[0] === 'asides') {
    return run(process.execPath, [join(ROOT, 'soul-asides.mjs'), ...parsed.args.slice(1)]);
  }
  if (parsed.command === 'soul' && parsed.args[0] === 'remove') {
    return run(process.execPath, [join(ROOT, 'soul-remove.mjs'), ...parsed.args.slice(1)]);
  }
  if (parsed.command === 'soul' && parsed.args[0] === 'fork') {
    return run(process.execPath, [join(ROOT, 'soul-fork.mjs'), ...parsed.args.slice(1)]);
  }
  if (parsed.command === 'soul' && parsed.args[0] === 'revision') {
    return run(process.execPath, [join(ROOT, 'soul-revisions.mjs'), ...parsed.args.slice(1)]);
  }
  const module = MODULES.get(parsed.command);
  if (!module) throw new Error(`unsupported command: ${parsed.command}`);
  if (parsed.command === 'audit' && parsed.args[0] === 'tail') {
    return follow(process.execPath, [join(ROOT, module), ...parsed.args]);
  }
  // A person (or a harness startup script) ran it by name, not a git hook:
  // setup-worktree may then say why it did nothing (#382).
  if (parsed.command === 'setup-worktree') {
    return run(process.execPath, [join(ROOT, module), ...parsed.args], { ...process.env, AGENT_BOT_SETUP_HINT: '1' });
  }
  const args = parsed.command === 'soul' && parsed.args[0] === 'cold-wake' ? parsed.args.slice(1) : parsed.args;
  if (parsed.command === 'soul' && parsed.args[0] !== 'cold-wake') throw new Error('usage: agent-bot soul cold-wake <agentId> [on|off|show|resume read-only|workspace|webhook --url-file PATH --key-file PATH|-] | soul build [PATH] [--check] | soul pack validate PATH | soul revision <command> | soul model <agentId|name> [show|set <modelId>|clear] [--json] [--principal-stdin] | soul mode <agentId|name> [show|safe|autopilot] [--json] [--principal-stdin] | soul stop <agentId|name> [--json] | soul pause|resume <agentId|name> [--json] | soul show <agentId|name> [--json] | soul comms <agentId|name> [show|on|off] [--json] [--principal-stdin] | soul remove <agentId|name> [--json] [--principal-stdin] | soul fork <copy-path> --name NAME [--harness H] [--json] [--principal-stdin] | soul asides <agentId|name> [--after ASIDE_ID] [--limit N] [--json] | soul dir AGENT_ID | soul locate PATH | soul spawn TEMPLATE_PATH --name NAME [--harness H] | soul confinement AGENT_ID off|warn|deny | soul confinement-report AGENT_ID [--json]');
  return run(process.execPath, [join(ROOT, module), ...args]);
}
