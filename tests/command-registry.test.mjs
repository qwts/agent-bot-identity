// The agent-bot command registry (cli/command-registry.mjs, #1394; HQ plan
// Stage 0 row 9). This file checks the registry refuses what it does not know
// and resolves an invocation to help, a usage error, a run function or a
// module with its arguments.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { COMMAND_VISIBILITY, createCommandRegistry } from '../cli/command-registry.mjs';

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
