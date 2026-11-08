// Golden surface, slice 2 (#1379): every command's help and its usage error.
// For each public command, and each subcommand the dispatcher hands to a
// module of its own, this pins what `--help`, `-h` and an unknown flag print
// and the exit code. Many commands have no help branch and answer `--help`
// with their usage error; that is today's surface, and pinning it is the
// point. tests/helpers/golden.mjs says how to regenerate.
//
// Each module's help path was audited before it was run here, and every run
// is sealed and fenced (helpers/golden.mjs): a run the fence had to stop, or
// one that wrote to its HOME, fails the test instead of becoming a golden.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { PUBLIC_COMMANDS } from '../cli/parse.mjs';
import { cli, golden, inPool, readGolden, transcript } from './helpers/golden.mjs';

const UNKNOWN_FLAG = '--no-such-flag-golden';

// Subcommands cli/dispatch.mjs runs as modules of their own.
const SUBCOMMANDS = [
  'audit list', 'audit tail',
  'identity app', 'identity apps', 'identity addon', 'identity migrate-credentials',
  'sandbox export',
  'soul asides', 'soul build', 'soul cold-wake', 'soul comms', 'soul computer-use', 'soul confinement',
  'soul confinement-report', 'soul dir', 'soul env', 'soul env clean', 'soul env export', 'soul env history',
  'soul env import', 'soul env migrate', 'soul fork', 'soul mode', 'soul model', 'soul pack', 'soul pause',
  'soul profile', 'soul remove', 'soul resume', 'soul revision', 'soul runtimes', 'soul secret', 'soul show',
  'soul skill', 'soul spawn', 'soul stop', 'soul template', 'soul templates', 'soul tool-home',
].map((words) => words.split(' '));

// Runs that would do a command's work rather than describe it. Each is a bug
// in that command's help path, recorded here instead of being run.
const NOT_RUN = new Map([
  ['pair comms', 'runs account pairing (mints a vouch key, writes a pairing proof to the comms directory) whatever its arguments'],
  ['soul locate', 'locates its argument as a path, so every argument is work and the output is the sealed HOME'],
  ['soul asides -h', 'takes -h as a soul name, and the owner gate then runs git to look for soul markers'],
  // Not this repository's surface: agent-comms answers, and which agent-comms
  // runs depends on the machine (a bundled copy, a sibling checkout or PATH).
  [`broker ${UNKNOWN_FLAG}`, 'forwarded to agent-comms, whose surface agent-comms pins'],
]);

// Already pinned whole by slice 1.
const PINNED = new Map([['soul --help', 'soul-help.txt'], ['broker --help', 'broker-help.txt']]);

async function sections(commands) {
  const runs = commands.flatMap((words) => [['--help'], ['-h'], [UNKNOWN_FLAG]].map((flag) => [...words, ...flag]))
    .filter((args) => !NOT_RUN.has(args.slice(0, -1).join(' ')) && !NOT_RUN.has(args.join(' ')));
  const results = await inPool(runs, 8, (args) => cli(args));
  const byArgs = new Map(runs.map((args, index) => [args.join(' '), results[index]]));
  for (const [key, result] of byArgs) {
    assert.deepEqual(result.refused, [], `agent-bot ${key}: the fence stopped ${JSON.stringify(result.refused)}`);
    assert.deepEqual(result.home, [], `agent-bot ${key} wrote to HOME: ${result.home.join(', ')}`);
  }
  const out = [];
  for (const words of commands) {
    const name = words.join(' ');
    if (NOT_RUN.has(name)) {
      out.push(`$ agent-bot ${name} …\nnot run: ${NOT_RUN.get(name)}\n`);
      continue;
    }
    const help = byArgs.get(`${name} --help`);
    if (PINNED.has(`${name} --help`)) {
      assert.equal(help.stdout, readGolden(PINNED.get(`${name} --help`)));
      out.push(`$ agent-bot ${name} --help\nexit: ${help.status}\nstdout: see ${PINNED.get(`${name} --help`)}\nstderr:\n${help.stderr}`);
    } else {
      out.push(transcript([...words, '--help'], help));
    }
    for (const flag of ['-h', UNKNOWN_FLAG]) {
      const result = byArgs.get(`${name} ${flag}`);
      if (NOT_RUN.has(`${name} ${flag}`)) out.push(`$ agent-bot ${name} ${flag}\nnot run: ${NOT_RUN.get(`${name} ${flag}`)}\n`);
      else if (flag === '-h' && JSON.stringify(result) === JSON.stringify(help)) out.push(`$ agent-bot ${name} -h\nsame as --help\n`);
      else out.push(transcript([...words, flag], result));
    }
  }
  return `${out.join('\n')}`;
}

test('every public command: --help, -h and an unknown flag', async () => {
  golden('command-help.txt', await sections([...PUBLIC_COMMANDS].sort().map((command) => [command])));
});

test('every dispatched subcommand: --help, -h and an unknown flag', async () => {
  golden('subcommand-help.txt', await sections([...SUBCOMMANDS, ['pair', 'comms'], ['soul', 'locate']]
    .sort((a, b) => a.join(' ').localeCompare(b.join(' ')))));
});
