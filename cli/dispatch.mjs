import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { commsSharedDirInfo } from '../comms-client.mjs';
import { bundledCommsEntry } from '../state-paths.mjs';
import { GIT_HOOK_NAMES } from '../identity-format.mjs';
import { windowsGitShell, gitShellEnvironment } from '../windows-git-shell.mjs';
import { createCommandRegistry } from './command-registry.mjs';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

const SOUL_USAGE = 'usage: agent-bot soul cold-wake <agentId> [on|off|show|resume read-only|workspace|webhook --url-file PATH --key-file PATH|-] | soul skill import PATH_OR_HTTPS_DOCUMENT|list|show UUID|verify UUID|check UUID [--json] | soul skill update UUID --check CHECK_ID [--apply --expected-accepted DIGEST --expected-local DIGEST] | soul skill update UUID --recover | soul skill learn UUID --soul AGENT_ID [--package STAGING --outcome FILE --reason TEXT] [--json] | soul skill install UUID|NAME --soul AGENT_ID [--json] [--principal-stdin] | soul skill uninstall NAME --soul AGENT_ID [--trash] [--json] [--principal-stdin] | soul skill status --soul AGENT_ID [--json] | soul skill search --soul AGENT_ID QUERY [--json] | soul skill dream --soul ID|NAME --schedule PT<N>H|--run-now|--pause|--unschedule|--cancel RUN_ID|--ack-notice NOTICE_ID|--status|--history [--json] [--principal-stdin] | soul build [PATH] [--check] [--json] | soul pack validate PATH | soul revision <command> | soul revision edit ID PATH REASON [--apply] [--json] [--principal-stdin] | soul revision prepare <agentId|name> [--json] [--dest PATH] | soul revision prepare --discard STAGING | soul model <agentId|name> [show|set <modelId>|clear] [--json] [--principal-stdin] | soul mode <agentId|name> [show|safe|autopilot] [--json] [--principal-stdin] | soul computer-use <agentId|name> [show|on|off] [--json] [--principal-stdin] | soul tool-home <harness> [soul|global] --soul <agentId|name> [--fresh-session] [--json] [--principal-stdin] | soul stop <agentId|name> [--json] | soul pause|resume <agentId|name> [--json] | soul show <agentId|name> [--json] | soul profile <agentId|name> [--json] [--file RELATIVE_PATH] | soul env <agentId|name> [--json] | soul env migrate <agentId|name> --adopt-host-signin [--harness NAME] | --space-into-soul | --template-name [--plan] | --harnesses-into-runtimes [--plan] | --complete [--plan] [--json] [--principal-stdin] | soul env clean <agentId|name> [--plan] [--component cache|temp|runtimes] [--json] [--principal-stdin] | soul env export <agentId|name> --to FILE [--plan] [--json] [--principal-stdin] | soul env import FILE [--fork] [--replace] [--name NAME] [--plan] [--json] [--principal-stdin] | soul env history <agentId|name> [--json] [--limit N] | soul runtimes <agentId|name> [--json] | soul runtimes install <agentId|name> [--json] [--runtime NAME] [--principal-stdin] | soul runtimes upgrade <agentId|name> [--runtime NAME] [--apply] [--json] [--principal-stdin] | soul runtimes override <agentId|name> <node|npm|npx|go|gofmt|python3|uv|uvx> <absolute-executable>|--clear [--json] [--principal-stdin] | soul secret <agentId|name> set|clear <name> [--json] [--principal-stdin] | soul secret <agentId|name> status [--json] | soul comms <agentId|name> [show|on|off] [--json] [--principal-stdin] | soul remove <agentId|name> [--scope soul|team] [--plan] [--json] [--principal-stdin] | soul fork <copy-path> --name NAME [--harness H] [--json] [--principal-stdin] | soul asides <agentId|name> [--after ASIDE_ID] [--limit N] [--json] | soul dir AGENT_ID | soul locate PATH [--json] | soul templates [--json] | soul spawn TEMPLATE_PATH --name NAME [--harness H] | soul template refresh <agentId|name> [--from TEMPLATE_PATH] [--plan] [--json] [--principal-stdin] | soul confinement AGENT_ID off|warn|deny | soul confinement-report AGENT_ID [--json]';

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
(owner only; a launch does the same). soul runtimes upgrade shows how each
pinned runtime would move to the newest catalog pin; --apply (owner only)
moves and installs them. soul runtimes override sets or clears
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
const BROKER_USAGE = `usage: agent-bot broker <run [--single-account]|status|...> [options]

Run or inspect the local agent-comms broker with a platform-appropriate
AGENT_COMMS_SHARED_DIR default (macOS: /Users/Shared/Public/agent-comms;
Linux: \${XDG_STATE_HOME:-~/.local/state}/agent-comms).
`;

function resolveBundledCommsEntry(env = process.env) {
  return bundledCommsEntry({ env, root: ROOT });
}

function run(executable, args, env = process.env) {
  const result = spawnSync(executable, args, { stdio: 'inherit', env });
  if (result.error) throw result.error;
  return result.status ?? 1;
}

// A following reader must remain interruptible while its child is running.
// The synchronous dispatcher used by finite commands cannot forward SIGINT.
function follow(executable, args, env = process.env) {
  const child = spawn(executable, args, { stdio: 'inherit', env });
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

function runBroker(parsed) {
  if (parsed.args.length === 0 || ['--help', '-h'].includes(parsed.args[0])) {
    process.stdout.write(BROKER_USAGE);
    return 0;
  }
  const { sharedDir } = commsSharedDirInfo({ env: process.env });
  const brokerEnv = { ...process.env, AGENT_COMMS_SHARED_DIR: sharedDir };
  const entry = resolveBundledCommsEntry(process.env);
  const executable = entry ? process.execPath : 'agent-comms';
  const brokerArgs = entry ? [entry, 'broker', ...parsed.args] : ['broker', ...parsed.args];
  if (parsed.args[0] === 'run') {
    return follow(executable, brokerArgs, brokerEnv);
  }
  return run(executable, brokerArgs, brokerEnv);
}

function runHook(parsed) {
  if (!HOOK_PATTERN.test(parsed.hook)) throw new Error(`invalid hook name: ${parsed.hook}`);
  const hook = join(ROOT, 'hooks', parsed.hook);
  if (!GIT_HOOK_NAMES.includes(parsed.hook) || !existsSync(hook)) {
    throw new Error(`unsupported hook: ${parsed.hook}`);
  }
  if (process.platform === 'win32') {
    const shell = windowsGitShell();
    return run(shell, [hook.replaceAll('\\', '/'), ...parsed.args], gitShellEnvironment(shell));
  }
  return run(hook, parsed.args);
}

// Every agent-bot command, in the order the parser and help have always
// listed them: public first, then internal (#1394, HQ plan Stage 0 row 9).
// Each registers through cli/command-registry.mjs, the in-place form of
// `ctx.commands.register` (plan section 4.2). The registry says what an
// invocation runs; dispatchAgentBot runs it.
const SOUL_SUBCOMMANDS = [
  { words: ['cold-wake'], module: 'cold-wake-settings.mjs', drop: 1 },
  { words: ['stop'], module: 'soul-stop.mjs', drop: 1 },
  { words: ['pause'], module: 'soul-pause.mjs' },
  { words: ['resume'], module: 'soul-pause.mjs' },
  { words: ['show'], module: 'agent-population.mjs' },
  { words: ['profile'], module: 'soul-profile.mjs', drop: 1 },
  { words: ['env', 'migrate'], module: 'soul-env-migrate.mjs', drop: 2 },
  { words: ['env', 'clean'], module: 'soul-env-clean.mjs', drop: 2 },
  { words: ['env', 'history'], module: 'soul-env-history.mjs', drop: 2 },
  { words: ['env', 'export'], module: 'cli/soul-env-transfer.mjs', drop: 1 },
  { words: ['env', 'import'], module: 'cli/soul-env-transfer.mjs', drop: 1 },
  { words: ['env'], module: 'soul-env.mjs', drop: 1 },
  { words: ['runtimes'], module: 'soul-runtimes.mjs', drop: 1 },
  { words: ['secret'], module: 'soul-secrets.mjs', drop: 1 },
  { words: ['confinement'], module: 'confinement.mjs' },
  { words: ['confinement-report'], module: 'confinement.mjs' },
  { words: ['templates'], module: 'soul-templates.mjs', drop: 1, prepend: ['--list'] },
  { words: ['spawn'], module: 'soul-templates.mjs', drop: 1, prepend: ['--spawn'] },
  { words: ['template'], module: 'soul-template-refresh.mjs', drop: 1 },
  { words: ['dir'], module: 'soul-dir.mjs', drop: 1 },
  { words: ['locate'], module: 'soul-dir.mjs' },
  { words: ['build'], module: 'soul-build.mjs', drop: 1 },
  { words: ['pack'], module: 'soul-package.mjs', drop: 1 },
  { words: ['model'], module: 'soul-model.mjs', drop: 1 },
  { words: ['computer-use'], module: 'soul-computer-use.mjs', drop: 1 },
  { words: ['mode'], module: 'soul-mode.mjs', drop: 1 },
  { words: ['tool-home'], module: 'soul-tool-home.mjs', drop: 1 },
  { words: ['comms'], module: 'soul-comms.mjs', drop: 1 },
  { words: ['asides'], module: 'soul-asides.mjs', drop: 1 },
  { words: ['remove'], module: 'soul-remove.mjs', drop: 1 },
  { words: ['fork'], module: 'soul-fork.mjs', drop: 1 },
  { words: ['skill'], module: 'cli/soul-skill.mjs', drop: 1 },
  { words: ['revision'], module: 'soul-revisions.mjs', drop: 1 },
];

export const COMMANDS = createCommandRegistry();
for (const command of [
  { name: 'start', visibility: 'public', module: 'start.mjs' },
  { name: 'bootstrap', visibility: 'public', module: 'bootstrap.mjs' },
  // A person (or a harness startup script) ran it by name, not a git hook:
  // setup-worktree may then say why it did nothing (#382).
  { name: 'setup-worktree', visibility: 'public', module: 'setup-worktree.mjs', env: { AGENT_BOT_SETUP_HINT: '1' } },
  { name: 'join', visibility: 'public', module: 'soul-join.mjs' },
  { name: 'mint-token', visibility: 'public', module: 'cli/mint-token.mjs' },
  { name: 'events', visibility: 'public', module: 'events.mjs' },
  { name: 'doctor', visibility: 'public', module: 'doctor.mjs' },
  { name: 'identity', visibility: 'public', module: 'cli/identity.mjs', subcommands: [
    { words: ['app'], module: 'cli/identity-apps.mjs' },
    { words: ['apps'], module: 'cli/identity-apps.mjs' },
    { words: ['addon'], module: 'cli/identity-apps.mjs' },
    { words: ['migrate-credentials'], module: 'cli/migrate-credentials.mjs', drop: 1 },
  ] },
  { name: 'space', visibility: 'public', module: 'agent-space.mjs' },
  { name: 'population', visibility: 'public', module: 'agent-population.mjs' },
  { name: 'principal', visibility: 'public', module: 'cli/principal.mjs' },
  { name: 'binding', visibility: 'public', module: 'agent-binding.mjs' },
  { name: 'session', visibility: 'public', module: 'session-bind.mjs' },
  // Only `soul cold-wake` reaches the command's own module; any other
  // subcommand it does not register is a usage error.
  { name: 'soul', visibility: 'public', module: 'cold-wake-settings.mjs', help: SOUL_HELP, usage: SOUL_USAGE, subcommands: SOUL_SUBCOMMANDS },
  { name: 'harness', visibility: 'public', module: 'harness-auth.mjs' },
  { name: 'daemon', visibility: 'public', module: 'agent-daemon.mjs' },
  { name: 'broker', visibility: 'public', run: runBroker },
  { name: 'keyd', visibility: 'public', module: 'keyd-supervisor.mjs' },
  { name: 'owner', visibility: 'public', module: 'cli/owner.mjs' },
  { name: 'approvals', visibility: 'public', module: 'agent-approvals.mjs' },
  { name: 'audit', visibility: 'public', module: 'agent-audit.mjs', subcommands: [
    { words: ['tail'], module: 'agent-audit.mjs', follow: true },
  ] },
  { name: 'mcp', visibility: 'public', module: 'agent-mcp.mjs' },
  { name: 'machine', visibility: 'public', module: 'cli/machine.mjs' },
  { name: 'pair', visibility: 'public', module: 'cli/machine.mjs', prepend: ['pair'], subcommands: [
    { words: ['comms'], module: 'agent-daemon.mjs', drop: 1, prepend: ['pair-comms'] },
  ] },
  { name: 'unpair', visibility: 'public', module: 'cli/machine.mjs', prepend: ['unpair'] },
  { name: 'reach-mcp', visibility: 'public', module: 'daemon-mcp.mjs' },
  { name: 'wake', visibility: 'public', module: 'wake-listen.mjs' },
  { name: 'web', visibility: 'public', module: 'agent-web.mjs' },
  { name: 'telegram', visibility: 'public', module: 'telegram-adapter.mjs' },
  { name: 'install', visibility: 'public', module: 'install.mjs' },
  { name: 'update', visibility: 'public', module: 'update.mjs' },
  { name: 'install-gh-shim', visibility: 'public', module: 'install-gh-shim.mjs' },
  { name: 'ensure-private-key', visibility: 'public', module: 'ensure-private-key.mjs' },
  { name: 'signed-commit', visibility: 'public', module: 'signed-commit.mjs' },
  { name: 'secret', visibility: 'public', module: 'secret.mjs' },
  { name: 'skill', visibility: 'public', module: 'skill.mjs' },
  { name: 'sop', visibility: 'public', module: 'sop.mjs' },
  { name: 'workflow', visibility: 'public', module: 'workflow.mjs' },
  { name: 'sandbox', visibility: 'public', module: 'sandbox.mjs', subcommands: [
    { words: ['export'], module: 'cli/sandbox-export.mjs', drop: 1 },
  ] },
  { name: 'metrics', visibility: 'public', module: 'metrics.mjs' },
  { name: 'diagnostics', visibility: 'public', module: 'diagnostics-cli.mjs' },
  { name: 'server', visibility: 'public', module: 'identity/server-client.mjs' },
  { name: 'notices', visibility: 'public', module: 'identity/server-notices.mjs' },
  { name: 'credential', visibility: 'internal', module: 'git-credential-bot.mjs' },
  { name: 'worktree-token', visibility: 'internal', module: 'worktree-token.mjs' },
  { name: 'gh-inbox-query', visibility: 'internal', module: 'gh-inbox-query.mjs' },
  { name: 'gh-pr-view-json', visibility: 'internal', module: 'gh-pr-view-json.mjs' },
  { name: 'claude-worktree-create', visibility: 'internal', module: 'claude-worktree-create.mjs' },
  { name: 'hook', visibility: 'internal', run: runHook },
  // Called by every harness's generated hook config, never by a person.
  { name: 'agent-hook', visibility: 'internal', module: 'agent-hook.mjs' },
]) COMMANDS.register(command);
COMMANDS.close();

// Command name -> the module it runs, for the commands that run one.
export const MODULES = COMMANDS.modules();

export function dispatchAgentBot(parsed) {
  const route = COMMANDS.resolve(parsed.command, parsed.args);
  if (!route) throw new Error(`unsupported command: ${parsed.command}`);
  if (route.kind === 'help') {
    process.stdout.write(route.text);
    return 0;
  }
  if (route.kind === 'usage') throw new Error(route.text);
  if (route.kind === 'run') return route.run(parsed);
  const args = [join(ROOT, route.module), ...route.args];
  const env = route.env ? { ...process.env, ...route.env } : process.env;
  if (route.follow) return follow(process.execPath, args, env);
  return run(process.execPath, args, env);
}
