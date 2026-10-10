import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { GIT_HOOK_NAMES } from '../git-hooks.mjs';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
export const MODULES = new Map([
  ['bootstrap', 'bootstrap.mjs'],
  ['setup-worktree', 'setup-worktree.mjs'],
  ['join', 'soul-join.mjs'],
  ['mint-token', 'cli/mint-token.mjs'],
  ['doctor', 'doctor.mjs'],
  ['identity', 'cli/identity.mjs'],
  ['space', 'agent-space.mjs'],
  ['population', 'agent-population.mjs'],
  ['principal', 'cli/principal.mjs'],
  ['binding', 'agent-binding.mjs'],
  ['soul', 'cold-wake-settings.mjs'],
  ['harness', 'harness-auth.mjs'],
  ['daemon', 'agent-daemon.mjs'],
  ['keyd', 'keyd-supervisor.mjs'],
  ['owner', 'cli/owner.mjs'],
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
  ['sandbox', 'sandbox.mjs'],
  ['metrics', 'metrics.mjs'],
  ['credential', 'git-credential-bot.mjs'],
  ['worktree-token', 'worktree-token.mjs'],
  ['gh-inbox-query', 'gh-inbox-query.mjs'],
  ['gh-pr-view-json', 'gh-pr-view-json.mjs'],
  ['claude-worktree-create', 'claude-worktree-create.mjs'],
  ['agent-hook', 'agent-hook.mjs'],
]);

const SOUL_USAGE = 'usage: agent-bot soul cold-wake <agentId> [on|off|show|resume read-only|workspace|webhook --url-file PATH --key-file PATH|-] | soul skill import PATH_OR_HTTPS_DOCUMENT|list|show UUID|verify UUID|check UUID [--json] | soul skill update UUID --check CHECK_ID [--apply --expected-accepted DIGEST --expected-local DIGEST] | soul skill update UUID --recover | soul skill learn UUID --soul AGENT_ID [--package STAGING --outcome FILE --reason TEXT] [--json] | soul skill install UUID|NAME --soul AGENT_ID [--json] [--principal-stdin] | soul skill uninstall NAME --soul AGENT_ID [--trash] [--json] [--principal-stdin] | soul skill dream --soul ID|NAME --schedule PT<N>H|--run-now|--pause|--unschedule|--cancel RUN_ID|--ack-notice NOTICE_ID|--status|--history [--json] [--principal-stdin] | soul build [PATH] [--check] [--json] | soul pack validate PATH | soul revision <command> | soul revision edit ID PATH REASON [--apply] [--json] [--principal-stdin] | soul revision prepare <agentId|name> [--json] [--dest PATH] | soul revision prepare --discard STAGING | soul model <agentId|name> [show|set <modelId>|clear] [--json] [--principal-stdin] | soul mode <agentId|name> [show|safe|autopilot] [--json] [--principal-stdin] | soul computer-use <agentId|name> [show|on|off] [--json] [--principal-stdin] | soul tool-home <harness> [soul|global] --soul <agentId|name> [--fresh-session] [--json] [--principal-stdin] | soul stop <agentId|name> [--json] | soul pause|resume <agentId|name> [--json] | soul show <agentId|name> [--json] | soul profile <agentId|name> [--json] [--file RELATIVE_PATH] | soul env <agentId|name> [--json] | soul env migrate <agentId|name> --adopt-host-signin [--harness NAME] | --space-into-soul | --template-name [--plan] | --harnesses-into-runtimes [--plan] | --complete [--plan] [--json] [--principal-stdin] | soul env clean <agentId|name> [--plan] [--component cache|temp|runtimes] [--json] [--principal-stdin] | soul env export <agentId|name> --to FILE [--plan] [--json] [--principal-stdin] | soul env import FILE [--fork] [--replace] [--name NAME] [--plan] [--json] [--principal-stdin] | soul env history <agentId|name> [--json] [--limit N] | soul runtimes <agentId|name> [--json] | soul runtimes install <agentId|name> [--json] [--runtime NAME] [--principal-stdin] | soul runtimes override <agentId|name> <node|npm|npx|go|gofmt|python3|uv|uvx> <absolute-executable>|--clear [--json] [--principal-stdin] | soul secret <agentId|name> set|clear <name> [--json] [--principal-stdin] | soul secret <agentId|name> status [--json] | soul comms <agentId|name> [show|on|off] [--json] [--principal-stdin] | soul remove <agentId|name> [--scope soul|team] [--plan] [--json] [--principal-stdin] | soul fork <copy-path> --name NAME [--harness H] [--json] [--principal-stdin] | soul asides <agentId|name> [--after ASIDE_ID] [--limit N] [--json] | soul dir AGENT_ID | soul locate PATH [--json] | soul templates [--json] | soul spawn TEMPLATE_PATH --name NAME [--harness H] | soul template refresh <agentId|name> [--from TEMPLATE_PATH] [--plan] [--json] [--principal-stdin] | soul confinement AGENT_ID off|warn|deny | soul confinement-report AGENT_ID [--json]';

// Wording from README.md, docs/soul-templates.md, and docs/joining.md.
const SOUL_HELP = `${SOUL_USAGE.replaceAll(' | soul ', '\n  agent-bot soul ')}

Create independent tailored agents from one package with agent-bot soul spawn.
Spawning creates an instance and returns JSON with its Agent ID, soulDir,
displayName, and current revision. It does not launch a harness.
Listing reads local packages without network or secret access.

The account-local population census records each soul's absolute soulDir;
its default directory is <soulsRoot>/<census-name>.soul. Named template
instances use their manifest display name instead.

Cold wake is owner only.
soul remove turns cold wake off, leaves agent-comms as the soul, retires it
(there is no un-retire), and moves every folder carrying its marker to
<souls root>/.archive/<UTC stamp>-<folder>. --scope soul (default) lets the
souls it leads stand on their own; --scope team removes every active soul it
leads too, deepest first. --plan prints the exact souls a scope would
archive, make independent or leave unchanged, changing nothing and asking
nobody. Nothing restores or deletes an archived soul.

soul env reads the soul's environment descriptor (where its definition,
generated output, workspaces, home, memory and history live, what is
installed, and what is not ready); it never provisions. soul env migrate
--adopt-host-signin copies the host's harness sign-in files (never the
keychain) into the soul's own tool home once (owner only); soul env migrate
--space-into-soul moves a linked Agent Space into .soul-state/space (copied,
verified, the census updated, the source renamed .retired-<date>; owner
only, never while the soul runs); soul env migrate --template-name renames
an instance that kept its template's name when the bundled template now
goes by another name (one package revision and the census display name;
a name the owner chose is never changed; owner only, --plan reads only);
soul env migrate --harnesses-into-runtimes moves a joined soul's legacy
.soul-state/harnesses adapter install under .soul-state/runtimes/harnesses
with an install stamp (owner only, never while the soul runs, --plan reads
only); soul env migrate --complete finishes every migration step the
descriptor lists as pending, interrupted or failed through the same
mechanisms (owner only, never while the soul runs, --plan reads only).
soul env clean removes
only what the contract classifies reconstructible or disposable (the cache,
temporary files, runtime caches, leftover install stagings), never the
definition, home, tool state, credentials, memory, history or a workspace
(owner only, never while the soul runs, --plan lists paths and sizes).
a name the owner chose is never changed; owner only, --plan reads only).
soul env export writes the soul's life as one archive (definition, home,
tool state minus sign-in files, memory, history, settings, revision journal,
soul-owned workspaces whole, linked ones as a pointer with patch and
untracked files; never credentials, secrets, sign-ins, runtimes or caches;
owner only, never while the soul runs, --plan prints the manifest). soul env
import restores one keeping its Agent ID (a moved life); --fork mints a new
one; an active local ID is refused unless --replace, which moves the
existing root aside, never deletes it (owner only, --plan reads only).
soul env history lists the soul's history mirror (.soul-state/runs: turns
and revisions, facts only, never a prompt or an output), newest first, at
most --limit per file (1..500, default 50); read-only, no gate.
soul template refresh brings the paths a template declares as maintained
(its soul.json "maintained" prefixes) up to the bundled template in one
package revision, leaving AGENTS.md edits, memory and history alone
(owner only, --plan reads only). soul revision
prepare stages the editable definition under .soul-state/tmp for a host to
edit and apply. soul runtimes reports the runtimes (node, python, go) and
non-npm harnesses a soul declares against what is installed under its
.soul-state/runtimes; soul runtimes install provisions what is missing
(owner only; a launch does the same). soul runtimes override sets or clears
one owner-managed executable path for this soul (POSIX only); the launch uses
a one-name shim and reports the selection as unverified external. soul secret stores, clears or reports
the provider secrets a soul declares (credentials.secrets) for its
harnesses' providers; set and clear are owner only and the value arrives on
stdin, never on argv; status says present or missing, never the value.

See docs/soul-homes.md, docs/soul-environment.md, docs/soul-tool-homes.md, docs/soul-memory-history.md, docs/soul-runtimes.md, docs/soul-providers.md, docs/soul-templates.md,
docs/joining.md, docs/soul-revisions.md, and README.md for the subcommands
and their effects.
`;

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
  if (parsed.command === 'soul' && ['--help', '-h'].includes(parsed.args[0])) {
    process.stdout.write(SOUL_HELP);
    return 0;
  }
  if (parsed.command === 'soul' && parsed.args[0] === 'stop') {
    return run(process.execPath, [join(ROOT, 'soul-stop.mjs'), ...parsed.args.slice(1)]);
  }
  if (parsed.command === 'soul' && ['pause', 'resume'].includes(parsed.args[0])) {
    return run(process.execPath, [join(ROOT, 'soul-pause.mjs'), ...parsed.args]);
  }
  if (parsed.command === 'soul' && parsed.args[0] === 'show') {
    return run(process.execPath, [join(ROOT, 'agent-population.mjs'), ...parsed.args]);
  }
  if (parsed.command === 'soul' && parsed.args[0] === 'profile') {
    return run(process.execPath, [join(ROOT, 'soul-profile.mjs'), ...parsed.args.slice(1)]);
  }
  if (parsed.command === 'soul' && parsed.args[0] === 'env' && parsed.args[1] === 'migrate') {
    return run(process.execPath, [join(ROOT, 'soul-env-migrate.mjs'), ...parsed.args.slice(2)]);
  }
  if (parsed.command === 'soul' && parsed.args[0] === 'env' && parsed.args[1] === 'clean') {
    return run(process.execPath, [join(ROOT, 'soul-env-clean.mjs'), ...parsed.args.slice(2)]);
  }
  if (parsed.command === 'soul' && parsed.args[0] === 'env' && parsed.args[1] === 'history') {
    return run(process.execPath, [join(ROOT, 'soul-env-history.mjs'), ...parsed.args.slice(2)]);
  }
  if (parsed.command === 'soul' && parsed.args[0] === 'env' && ['export', 'import'].includes(parsed.args[1])) {
    return run(process.execPath, [join(ROOT, 'cli', 'soul-env-transfer.mjs'), ...parsed.args.slice(1)]);
  }
  if (parsed.command === 'soul' && parsed.args[0] === 'env') {
    return run(process.execPath, [join(ROOT, 'soul-env.mjs'), ...parsed.args.slice(1)]);
  }
  if (parsed.command === 'soul' && parsed.args[0] === 'runtimes') {
    return run(process.execPath, [join(ROOT, 'soul-runtimes.mjs'), ...parsed.args.slice(1)]);
  }
  if (parsed.command === 'soul' && parsed.args[0] === 'secret') {
    return run(process.execPath, [join(ROOT, 'soul-secrets.mjs'), ...parsed.args.slice(1)]);
  }
  if (parsed.command === 'soul' && ['confinement', 'confinement-report'].includes(parsed.args[0])) {
    return run(process.execPath, [join(ROOT, 'confinement.mjs'), ...parsed.args]);
  }
  if (parsed.command === 'soul' && parsed.args[0] === 'templates') {
    return run(process.execPath, [join(ROOT, 'soul-templates.mjs'), '--list', ...parsed.args.slice(1)]);
  }
  if (parsed.command === 'soul' && parsed.args[0] === 'spawn') {
    return run(process.execPath, [join(ROOT, 'soul-templates.mjs'), '--spawn', ...parsed.args.slice(1)]);
  }
  if (parsed.command === 'soul' && parsed.args[0] === 'template') {
    return run(process.execPath, [join(ROOT, 'soul-template-refresh.mjs'), ...parsed.args.slice(1)]);
  }
  if (parsed.command === 'identity' && ['app', 'apps', 'addon'].includes(parsed.args[0])) {
    return run(process.execPath, [join(ROOT, 'cli', 'identity-apps.mjs'), ...parsed.args]);
  }
  if (parsed.command === 'identity' && parsed.args[0] === 'migrate-credentials') {
    return run(process.execPath, [join(ROOT, 'cli', 'migrate-credentials.mjs'), ...parsed.args.slice(1)]);
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
  if (parsed.command === 'soul' && parsed.args[0] === 'computer-use') return run(process.execPath, [join(ROOT, 'soul-computer-use.mjs'), ...parsed.args.slice(1)]);
  if (parsed.command === 'soul' && parsed.args[0] === 'mode') return run(process.execPath, [join(ROOT, 'soul-mode.mjs'), ...parsed.args.slice(1)]);
  if (parsed.command === 'soul' && parsed.args[0] === 'tool-home') return run(process.execPath, [join(ROOT, 'soul-tool-home.mjs'), ...parsed.args.slice(1)]);
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
  if (parsed.command === 'soul' && parsed.args[0] === 'skill') return run(process.execPath, [join(ROOT, 'cli/soul-skill.mjs'), ...parsed.args.slice(1)]);
  if (parsed.command === 'sandbox' && parsed.args[0] === 'export') return run(process.execPath, [join(ROOT, 'cli/sandbox-export.mjs'), ...parsed.args.slice(1)]);
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
  if (parsed.command === 'soul' && parsed.args[0] !== 'cold-wake') throw new Error(SOUL_USAGE);
  return run(process.execPath, [join(ROOT, module), ...args]);
}
