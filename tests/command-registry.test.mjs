// The agent-bot command registry (cli/command-registry.mjs, #1394; HQ plan
// Stage 0 row 9). Every command registers once in cli/dispatch.mjs, and the
// parser and the dispatcher read the registry. This file checks the registry
// refuses what it does not know, keeps the public commands equal to the ones
// `agent-bot --help` lists, and pins the command modules and subcommand
// routes the dispatcher had before the registry.
// tests/golden-surface.test.mjs pins the help, the public list and the map.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { COMMAND_VISIBILITY, createCommandRegistry } from '../cli/command-registry.mjs';
import { COMMANDS, MODULES } from '../cli/dispatch.mjs';
import { helpText } from '../cli/output.mjs';
import { PUBLIC_COMMANDS } from '../cli/parse.mjs';

const run = () => 0;
const invalid = (declaration) => assert.throws(() => createCommandRegistry().register(declaration),
  (error) => error.code === 'command-registry-invalid', JSON.stringify(declaration));

test('a command needs a name, a visibility, and a module or a run function', () => {
  assert.deepEqual(COMMAND_VISIBILITY, ['public', 'internal']);
  for (const declaration of [
    null, [], 'start',
    { visibility: 'public', module: 'a.mjs' },
    { name: 'Bad', visibility: 'public', module: 'a.mjs' },
    { name: '-x', visibility: 'public', module: 'a.mjs' },
    { name: 'a', module: 'a.mjs' },
    { name: 'a', visibility: 'hidden', module: 'a.mjs' },
    { name: 'a', visibility: 'public' },
    { name: 'a', visibility: 'public', module: 'a.mjs', run },
    { name: 'a', visibility: 'public', run: 'a.mjs' },
    { name: 'a', visibility: 'public', module: '../a.mjs' },
    { name: 'a', visibility: 'public', module: '/abs/a.mjs' },
    { name: 'a', visibility: 'public', module: 'a.js' },
    { name: 'a', visibility: 'public', module: 'a.mjs', summary: 'x' },
    { name: 'a', visibility: 'public', run, help: 'help' },
    { name: 'a', visibility: 'public', run, subcommands: [{ words: ['x'], module: 'x.mjs' }] },
    { name: 'a', visibility: 'public', module: 'a.mjs', help: '' },
    { name: 'a', visibility: 'public', module: 'a.mjs', usage: 'usage' },
    { name: 'a', visibility: 'public', module: 'a.mjs', prepend: [] },
    { name: 'a', visibility: 'public', module: 'a.mjs', prepend: [''] },
    { name: 'a', visibility: 'public', module: 'a.mjs', env: {} },
    { name: 'a', visibility: 'public', module: 'a.mjs', env: { lower: '1' } },
    { name: 'a', visibility: 'public', module: 'a.mjs', env: { A: 1 } },
    { name: 'a', visibility: 'public', module: 'a.mjs', follow: true },
    { name: 'a', visibility: 'public', module: 'a.mjs', subcommands: [] },
  ]) invalid(declaration);
});

test('a subcommand needs words and a module, and only the fields it allows', () => {
  const command = (subcommand) => ({ name: 'a', visibility: 'public', module: 'a.mjs', subcommands: [subcommand] });
  for (const subcommand of [
    null, { module: 'x.mjs' }, { words: [], module: 'x.mjs' }, { words: ['X'], module: 'x.mjs' }, { words: ['--x'], module: 'x.mjs' },
    { words: ['x'] }, { words: ['x'], module: 'x' },
    { words: ['x'], module: 'x.mjs', drop: 2 }, { words: ['x'], module: 'x.mjs', drop: -1 }, { words: ['x'], module: 'x.mjs', drop: 0.5 },
    { words: ['x'], module: 'x.mjs', follow: false }, { words: ['x'], module: 'x.mjs', prepend: '--list' },
    { words: ['x'], module: 'x.mjs', env: { A: true } }, { words: ['x'], module: 'x.mjs', help: 'x' },
  ]) invalid(command(subcommand));
  invalid({ name: 'a', visibility: 'public', module: 'a.mjs',
    subcommands: [{ words: ['x'], module: 'x.mjs' }, { words: ['x'], module: 'y.mjs' }] });
});

test('a name is registered once, and registration closes', () => {
  const commands = createCommandRegistry();
  commands.register({ name: 'a', visibility: 'public', module: 'a.mjs' });
  assert.throws(() => commands.register({ name: 'a', visibility: 'internal', run }), /a is already registered/);
  commands.register({ name: 'b', visibility: 'internal', run });
  commands.close();
  assert.throws(() => commands.register({ name: 'c', visibility: 'public', module: 'c.mjs' }), /c: registration is closed/);
  assert.deepEqual(commands.names(), ['a', 'b']);
  assert.deepEqual(commands.names('public'), ['a']);
  assert.deepEqual(commands.names('internal'), ['b']);
  assert.deepEqual([...commands.modules()], [['a', 'a.mjs']]);
  assert.equal(commands.get('c'), null);
  assert.ok(Object.isFrozen(commands.get('a')));
});

test('resolve: help, then the longest subcommand, then usage or the command module', () => {
  const commands = createCommandRegistry();
  commands.register({ name: 's', visibility: 'public', module: 's.mjs', help: 'HELP', usage: 'USAGE', subcommands: [
    { words: ['env'], module: 'env.mjs', drop: 1 },
    { words: ['env', 'migrate'], module: 'migrate.mjs', drop: 2 },
    { words: ['list'], module: 'list.mjs', drop: 1, prepend: ['--list'] },
    { words: ['show'], module: 'show.mjs' },
    { words: ['tail'], module: 'tail.mjs', follow: true, env: { HINT: '1' } },
  ] });
  commands.register({ name: 'p', visibility: 'public', module: 'p.mjs', prepend: ['p'], env: { HINT: '1' } });
  commands.register({ name: 'r', visibility: 'internal', run });
  const module = (name, args, follow = false, env = null) => ({ kind: 'module', module: name, args, follow, env });
  assert.deepEqual(commands.resolve('s', ['--help', 'env']), { kind: 'help', text: 'HELP' });
  assert.deepEqual(commands.resolve('s', ['-h']), { kind: 'help', text: 'HELP' });
  assert.deepEqual(commands.resolve('s', ['env', 'migrate', 'A', '--plan']), module('migrate.mjs', ['A', '--plan']));
  assert.deepEqual(commands.resolve('s', ['env', 'A']), module('env.mjs', ['A']));
  assert.deepEqual(commands.resolve('s', ['env']), module('env.mjs', []));
  assert.deepEqual(commands.resolve('s', ['list', '--json']), module('list.mjs', ['--list', '--json']));
  assert.deepEqual(commands.resolve('s', ['show', 'A']), module('show.mjs', ['show', 'A']));
  assert.deepEqual(commands.resolve('s', ['tail']), module('tail.mjs', ['tail'], true, { HINT: '1' }));
  assert.deepEqual(commands.resolve('s', ['nope']), { kind: 'usage', text: 'USAGE' });
  assert.deepEqual(commands.resolve('s', []), { kind: 'usage', text: 'USAGE' });
  assert.deepEqual(commands.resolve('p', ['x']), module('p.mjs', ['p', 'x'], false, { HINT: '1' }));
  assert.deepEqual(commands.resolve('r', ['--help']), { kind: 'run', run });
  assert.equal(commands.resolve('nope', []), null);
});

test('agent-bot: the public commands are exactly the ones --help lists, and the rest are internal', () => {
  const help = helpText();
  const section = help.slice(help.indexOf('\nCommands:\n'), help.indexOf('\n\n', help.indexOf('\nCommands:\n') + 1));
  const listed = section.split('\n').map((line) => /^ {2}([a-z][a-z-]*)\s/.exec(line)?.[1]).filter(Boolean);
  assert.equal(new Set(listed).size, listed.length, 'help lists each command once');
  assert.deepEqual([...COMMANDS.names('public')].sort(), [...listed].sort());
  assert.deepEqual([...PUBLIC_COMMANDS], COMMANDS.names('public'));
  assert.deepEqual(COMMANDS.names('internal'),
    ['credential', 'worktree-token', 'gh-inbox-query', 'gh-pr-view-json', 'claude-worktree-create', 'hook', 'agent-hook']);
  assert.throws(() => COMMANDS.register({ name: 'late', visibility: 'public', module: 'late.mjs' }), /registration is closed/);
});

// The command -> module map cli/dispatch.mjs had before the registry, in its
// order. broker and hook ran no module of their own and still do not.
const MODULES_BEFORE = [
  ['start', 'start.mjs'], ['bootstrap', 'bootstrap.mjs'], ['setup-worktree', 'setup-worktree.mjs'], ['join', 'soul-join.mjs'],
  ['mint-token', 'cli/mint-token.mjs'], ['events', 'events.mjs'], ['doctor', 'doctor.mjs'], ['identity', 'cli/identity.mjs'],
  ['space', 'agent-space.mjs'], ['population', 'agent-population.mjs'], ['principal', 'cli/principal.mjs'],
  ['binding', 'agent-binding.mjs'], ['session', 'session-bind.mjs'], ['soul', 'cold-wake-settings.mjs'],
  ['harness', 'harness-auth.mjs'], ['daemon', 'agent-daemon.mjs'], ['keyd', 'keyd-supervisor.mjs'], ['owner', 'cli/owner.mjs'],
  ['approvals', 'agent-approvals.mjs'], ['audit', 'agent-audit.mjs'], ['mcp', 'agent-mcp.mjs'], ['machine', 'cli/machine.mjs'],
  ['pair', 'cli/machine.mjs'], ['unpair', 'cli/machine.mjs'], ['reach-mcp', 'daemon-mcp.mjs'], ['wake', 'wake-listen.mjs'],
  ['web', 'agent-web.mjs'], ['telegram', 'telegram-adapter.mjs'], ['install', 'install.mjs'], ['update', 'update.mjs'],
  ['install-gh-shim', 'install-gh-shim.mjs'], ['ensure-private-key', 'ensure-private-key.mjs'],
  ['signed-commit', 'signed-commit.mjs'], ['secret', 'secret.mjs'], ['skill', 'skill.mjs'], ['sop', 'sop.mjs'],
  ['workflow', 'workflow.mjs'], ['sandbox', 'sandbox.mjs'], ['metrics', 'metrics.mjs'], ['diagnostics', 'diagnostics-cli.mjs'],
  ['server', 'identity/server-client.mjs'], ['notices', 'identity/server-notices.mjs'], ['credential', 'git-credential-bot.mjs'],
  ['worktree-token', 'worktree-token.mjs'], ['gh-inbox-query', 'gh-inbox-query.mjs'], ['gh-pr-view-json', 'gh-pr-view-json.mjs'],
  ['claude-worktree-create', 'claude-worktree-create.mjs'], ['agent-hook', 'agent-hook.mjs'],
];

test('agent-bot: every command keeps the module it ran', () => {
  assert.deepEqual([...MODULES], MODULES_BEFORE);
  assert.equal(COMMANDS.get('broker').run.name, 'runBroker');
  assert.equal(COMMANDS.get('hook').run.name, 'runHook');
});

// Every branch cli/dispatch.mjs had before the registry: an invocation, the
// module it ran and that module's arguments, and whether the dispatcher
// followed the child (stayed interruptible) or added to its environment.
const ROUTES_BEFORE = [
  ['soul cold-wake A on', 'cold-wake-settings.mjs', 'A on'],
  ['soul stop A --json', 'soul-stop.mjs', 'A --json'],
  ['soul pause A', 'soul-pause.mjs', 'pause A'],
  ['soul resume A', 'soul-pause.mjs', 'resume A'],
  ['soul show A', 'agent-population.mjs', 'show A'],
  ['soul profile A', 'soul-profile.mjs', 'A'],
  ['soul env migrate A --complete', 'soul-env-migrate.mjs', 'A --complete'],
  ['soul env clean A --plan', 'soul-env-clean.mjs', 'A --plan'],
  ['soul env history A', 'soul-env-history.mjs', 'A'],
  ['soul env export A --to F', 'cli/soul-env-transfer.mjs', 'export A --to F'],
  ['soul env import F', 'cli/soul-env-transfer.mjs', 'import F'],
  ['soul env A --json', 'soul-env.mjs', 'A --json'],
  ['soul runtimes install A', 'soul-runtimes.mjs', 'install A'],
  ['soul secret A status', 'soul-secrets.mjs', 'A status'],
  ['soul confinement A deny', 'confinement.mjs', 'confinement A deny'],
  ['soul confinement-report A', 'confinement.mjs', 'confinement-report A'],
  ['soul templates --json', 'soul-templates.mjs', '--list --json'],
  ['soul spawn T --name N', 'soul-templates.mjs', '--spawn T --name N'],
  ['soul template refresh A', 'soul-template-refresh.mjs', 'refresh A'],
  ['soul dir A', 'soul-dir.mjs', 'A'],
  ['soul locate P', 'soul-dir.mjs', 'locate P'],
  ['soul build P --check', 'soul-build.mjs', 'P --check'],
  ['soul pack validate P', 'soul-package.mjs', 'validate P'],
  ['soul model A show', 'soul-model.mjs', 'A show'],
  ['soul computer-use A on', 'soul-computer-use.mjs', 'A on'],
  ['soul mode A safe', 'soul-mode.mjs', 'A safe'],
  ['soul tool-home claude soul --soul A', 'soul-tool-home.mjs', 'claude soul --soul A'],
  ['soul comms A off', 'soul-comms.mjs', 'A off'],
  ['soul asides A', 'soul-asides.mjs', 'A'],
  ['soul remove A --plan', 'soul-remove.mjs', 'A --plan'],
  ['soul fork C --name N', 'soul-fork.mjs', 'C --name N'],
  ['soul skill list --json', 'cli/soul-skill.mjs', 'list --json'],
  ['soul revision prepare A', 'soul-revisions.mjs', 'prepare A'],
  ['identity app create', 'cli/identity-apps.mjs', 'app create'],
  ['identity apps list', 'cli/identity-apps.mjs', 'apps list'],
  ['identity addon github-identity on', 'cli/identity-apps.mjs', 'addon github-identity on'],
  ['identity migrate-credentials --all', 'cli/migrate-credentials.mjs', '--all'],
  ['identity show', 'cli/identity.mjs', 'show'],
  ['sandbox export --for O', 'cli/sandbox-export.mjs', '--for O'],
  ['sandbox status', 'sandbox.mjs', 'status'],
  ['audit tail --json', 'agent-audit.mjs', 'tail --json', { follow: true }],
  ['audit list', 'agent-audit.mjs', 'list'],
  ['setup-worktree app', 'setup-worktree.mjs', 'app', { env: { AGENT_BOT_SETUP_HINT: '1' } }],
  ['pair comms --broker B', 'agent-daemon.mjs', 'pair-comms --broker B'],
  ['pair --repin', 'cli/machine.mjs', 'pair --repin'],
  ['unpair', 'cli/machine.mjs', 'unpair'],
  ['machine status', 'cli/machine.mjs', 'status'],
  ['mcp', 'agent-mcp.mjs', ''],
];

test('agent-bot: every subcommand runs the module and arguments it did', () => {
  for (const [invocation, module, args, { follow = false, env = null } = {}] of ROUTES_BEFORE) {
    const [command, ...rest] = invocation.split(' ');
    assert.deepEqual(COMMANDS.resolve(command, rest), { kind: 'module', module, args: args ? args.split(' ') : [], follow, env }, invocation);
  }
  const routed = COMMANDS.entries().flatMap((command) => command.subcommands.map((entry) => `${command.name} ${entry.words.join(' ')}`));
  const pinned = new Set(ROUTES_BEFORE.map(([invocation]) => invocation));
  assert.deepEqual(routed.filter((route) => ![...pinned].some((invocation) => `${invocation} `.startsWith(`${route} `))), [],
    'every registered subcommand has a pinned invocation');
  assert.deepEqual(COMMANDS.resolve('soul', ['--help']).kind, 'help');
  assert.deepEqual(COMMANDS.resolve('soul', ['nope']).kind, 'usage');
  assert.deepEqual(COMMANDS.resolve('soul', []).kind, 'usage');
});
