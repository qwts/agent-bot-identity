// Golden surface, slice 3 (#1379): the `--json` shapes and exit codes of the
// read-only commands, against fixture state. The fixture is one sealed HOME
// with one soul spawned, through the real CLI, from a minimal template. Each
// read-only command then runs against it, and once against a soul that does
// not exist, so both the answer and the refusal are pinned.
//
// The records the fixture leaves are pinned the same way (records.json): where
// state lives under HOME, the Agent ID record, the census entry and the soul's
// marker, and the two files a binding writes (#1379, plan section 8.1).
//
// A shape is the JSON with every value replaced by its type and keys sorted;
// an array shows each distinct element shape once, and a key that is an Agent
// ID reads <agent-id>. Agent IDs, paths and times differ on every run, so
// values are not pinned; field names, nesting, types and exit codes are.
// tests/helpers/golden.mjs says how to regenerate.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { createBindingRegistry } from '../agent-binding.mjs';
import { computePackageRevision, PACKAGE_IGNORE_LIST } from '../soul-package.mjs';
import { golden, inPool, sealedBox } from './helpers/golden.mjs';
import { hermeticGitEnv } from './helpers/hermetic-git.mjs';

// Read-only commands whose answer needs nothing outside the sealed box. Left
// out, because the answer depends on the machine or on another program:
//   identity show|current, sop, workflow, skill path, soul build, approvals
//   list, soul asides, soul skill status, soul cold-wake show (git: the
//   worktree's binding and pins); machine status (Homebrew's prefix); sandbox
//   status|plan (macOS accounts); doctor, start, server status, notices,
//   events (network or a live daemon).
const SOUL = [
  ['soul', 'show', '<agent-id>', '--json'],
  ['soul', 'env', '<agent-id>', '--json'],
  ['soul', 'env', 'history', '<agent-id>', '--json'],
  ['soul', 'profile', '<agent-id>', '--json'],
  ['soul', 'runtimes', '<agent-id>', '--json'],
  ['soul', 'model', '<agent-id>', 'show', '--json'],
  ['soul', 'mode', '<agent-id>', 'show', '--json'],
  ['soul', 'computer-use', '<agent-id>', 'show', '--json'],
  ['soul', 'comms', '<agent-id>', 'show', '--json'],
  ['soul', 'secret', '<agent-id>', 'status', '--json'],
  ['soul', 'tool-home', 'codex', '--soul', '<agent-id>', '--json'],
  ['soul', 'confinement-report', '<agent-id>', '--json'],
  ['soul', 'revision', 'list', '<agent-id>', '--json'],
  ['soul', 'dir', '<agent-id>'],
  ['space', 'show', '<agent-id>', '--json'],
  ['space', 'path', '<agent-id>', '--json'],
];
const MACHINE = [
  ['population', 'list', '--json'],
  ['soul', 'templates', '--json'],
  ['soul', 'skill', 'list', '--json'],
  ['principal', 'list', '--json'],
  ['audit', 'list', '--json'],
  ['metrics', 'show', '--json'],
  ['identity', 'apps', 'list', '--json'],
  ['daemon', 'status', '--json'],
  ['keyd', 'status', '--json'],
  ['telegram', 'status', '--json'],
  ['diagnostics', 'export', '--preview'],
];
// A well-formed Agent ID nobody has.
const MISSING = 'agent_00000000-0000-8000-8000-000000000000';

function shape(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) {
    const distinct = new Map(value.map((item) => { const s = shape(item); return [JSON.stringify(s), s]; }));
    return [...distinct].sort(([a], [b]) => a.localeCompare(b)).map(([, s]) => s);
  }
  if (typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [/^agent_[0-9a-f-]{36}$/.test(key) ? '<agent-id>' : key, shape(value[key])]));
  }
  return typeof value;
}

function template(box) {
  const dir = path.join(box, 'Golden.soul');
  mkdirSync(dir, { recursive: true });
  const manifest = { formatVersion: 2, ignore: PACKAGE_IGNORE_LIST, name: 'Golden', description: 'Golden surface fixture',
    displaySeed: 'golden', template: true, preferredHarnesses: ['codex'], revision: `sha256:${'0'.repeat(64)}`, parentRevision: null };
  writeFileSync(path.join(dir, 'soul.json'), JSON.stringify(manifest));
  writeFileSync(path.join(dir, 'AGENTS.md'), 'Golden surface fixture\n');
  manifest.revision = computePackageRevision(dir);
  writeFileSync(path.join(dir, 'soul.json'), JSON.stringify(manifest));
  return dir;
}

// Empty stand-ins for the host tools `soul env` locates. Nothing runs them:
// the fence lets no program but node start.
function hostTools(box) {
  const dir = path.join(box, 'tools');
  mkdirSync(dir);
  for (const name of ['agent-comms', 'git']) writeFileSync(path.join(dir, name), '', { mode: 0o755 });
  return dir;
}

test('read-only --json shapes and exit codes against fixture state', async (t) => {
  // The bundled-template lookup reads two directories above the checkout;
  // naming the fixture as the Starter keeps `soul templates` to the box.
  // `soul env` reports where the host tools it names sit, searching
  // AGENT_BOT_TOOL_PATH before PATH; empty stand-ins in the box make that
  // answer the same whether or not this machine has them installed.
  const sealed = sealedBox((box) => ({
    AGENT_BOT_STARTER_TEMPLATE: path.join(box, 'Golden.soul'),
    AGENT_BOT_TOOL_PATH: hostTools(box),
  }));
  t.after(() => sealed.cleanup());
  const fixture = template(sealed.box);

  const spawned = await sealed.run(['soul', 'spawn', fixture, '--name', 'golden']);
  assert.equal(spawned.status, 0, spawned.stderr);
  assert.deepEqual(spawned.refused, []);
  const id = JSON.parse(spawned.stdout).id;

  const runs = [
    ...SOUL.map((args) => ({ key: args.join(' '), args: args.map((a) => (a === '<agent-id>' ? id : a)) })),
    ...SOUL.map((args) => ({ key: args.join(' ').replace('<agent-id>', '<missing-agent-id>'), args: args.map((a) => (a === '<agent-id>' ? MISSING : a)) })),
    ...MACHINE.map((args) => ({ key: args.join(' '), args })),
  ];
  // Read-only means HOME is the same afterwards, file for file.
  const before = sealed.homeTree();
  const results = await inPool(runs, 8, ({ args }) => sealed.run(args));
  assert.deepEqual(sealed.homeTree(), before, 'a read-only command changed the fixture HOME');

  const shapes = {};
  runs.forEach(({ key }, index) => {
    const { status, stdout, stderr, refused } = results[index];
    assert.deepEqual(refused, [], `agent-bot ${key}: the fence stopped ${JSON.stringify(refused)}`);
    let json;
    try { json = JSON.parse(stdout); } catch { json = undefined; }
    shapes[`agent-bot ${key}`] = { exit: status, stdout: json === undefined ? (stdout === '' ? 'empty' : 'not JSON') : shape(json), stderr: stderr === '' ? 'empty' : 'text' };
  });
  golden('json-shapes.json', shapes);

  const generic = (text) => text.replaceAll(id, '<agent-id>').replace(/\b[0-9a-f]{64}\b/g, '<sha256>').replace(/\b\d{10}\.json\b/, '<sequence>.json');
  const layout = [...new Set(before.map((line) => generic(line.replace(/ \d+$/, ''))))]
    .filter((line) => !line.includes('/.soul-state/space/'));
  const read = (relative) => JSON.parse(readFileSync(path.join(sealed.home, relative), 'utf8'));
  const soulDir = JSON.parse(spawned.stdout).soulDir.replace('<home>', sealed.home);

  // A binding, made the way the daemon makes one, in a worktree of its own.
  const worktree = path.join(sealed.box, 'worktree');
  execFileSync('git', ['init', '-q', worktree], { env: hermeticGitEnv(process.env, { HOME: sealed.home }) });
  const registryFile = path.join(sealed.box, 'bindings.json');
  const registry = createBindingRegistry({ file: registryFile, account: 'golden', now: () => new Date('2026-11-08T00:00:00Z') });
  registry.rewrite('http://127.0.0.1:1');
  registry.bind({ agentId: id, parent: null, app: 'golden-app', gitDir: path.join(worktree, '.git'), worktree });

  golden('records.json', {
    layout,
    agentIdRecord: shape(read(`.local/state/agent-bot/agent-identities/${id}.json`)),
    population: shape(read('.local/state/agent-bot/population.json')),
    soulMarker: generic(readFileSync(path.join(soulDir, '.soul-state', 'agent-id'), 'utf8')),
    binding: {
      worktreeFile: '<git-dir>/agent-binding.json',
      worktreeRecord: shape(JSON.parse(readFileSync(path.join(worktree, '.git', 'agent-binding.json'), 'utf8'))),
      registryEntry: shape(Object.values(JSON.parse(readFileSync(registryFile, 'utf8')))),
    },
  });
});
