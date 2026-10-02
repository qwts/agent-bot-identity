import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createSoulHomes, installHarnesses, npmCommand, soulHomePath } from '../soul-home.mjs';

const agentId = 'agent_33333333-3333-4333-8333-333333333333';

function fakeBindings() {
  const bound = [];
  return { bound, bind: (entry) => { bound.push(entry); return 'secret'; },
    findAgent: (id) => { const entry = bound.findLast((b) => b.agentId === id);
      return entry ? { agentId: id, worktree: entry.worktree, file: path.join(entry.gitDir, 'agent-binding.json') } : null; } };
}

test('provisions a git home from the package once, then rebinds it', async (t) => {
  const root = mkdtempSync(path.join(tmpdir(), 'soul-home-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const pkg = path.join(root, 'pkg');
  mkdirSync(path.join(pkg, 'skills', 'hello'), { recursive: true });
  writeFileSync(path.join(pkg, 'AGENTS.md'), 'be kind\n');
  writeFileSync(path.join(pkg, 'skills', 'hello', 'SKILL.md'), 'hi\n');
  const bindings = fakeBindings();
  const installs = [];
  const provision = createSoulHomes({ stateDir: path.join(root, 'state'), bindings, install: async (dir) => { installs.push(dir); } });
  const home = soulHomePath(path.join(root, 'state'), agentId);
  const first = await provision({ agentId, harness: 'claude', packagePath: pkg });
  assert.equal(first.worktree, home);
  assert.equal(readFileSync(path.join(home, 'AGENTS.md'), 'utf8'), 'be kind\n');
  assert.equal(readFileSync(path.join(home, 'skills', 'hello', 'SKILL.md'), 'utf8'), 'hi\n');
  assert.equal(bindings.bound[0].gitDir, realpathSync(path.join(home, '.git')));
  writeFileSync(path.join(home, 'AGENTS.md'), 'grown\n');
  await provision({ agentId, harness: 'claude', packagePath: pkg });
  assert.deepEqual(installs, [home], 'harnesses install once, when the home is made');
  assert.equal(readFileSync(path.join(home, 'AGENTS.md'), 'utf8'), 'grown\n', 'an existing home is never overwritten');
  assert.equal(bindings.bound.length, 2);
});

test('rejects an invalid agent ID before touching the disk', () => {
  assert.throws(() => soulHomePath('/state', '../x'));
});

test('a failed harness install removes the half-made home', async (t) => {
  const root = mkdtempSync(path.join(tmpdir(), 'soul-home-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const provision = createSoulHomes({ stateDir: root, bindings: fakeBindings(), install: async () => { throw new Error('npm said no'); } });
  await assert.rejects(provision({ agentId }), /npm said no/);
  assert.equal(existsSync(soulHomePath(root, agentId)), false);
});

test('installs pinned harnesses with npm ci, scripts off, using the host npm', async (t) => {
  const root = mkdtempSync(path.join(tmpdir(), 'soul-home-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const calls = [];
  const runImpl = async (command, args, options) => { calls.push({ command, args, cwd: options.cwd }); };
  assert.equal(await installHarnesses(root, { runImpl }), false, 'no package.json, nothing to install');
  writeFileSync(path.join(root, 'package.json'), '{}');
  await assert.rejects(installHarnesses(root, { runImpl }), /package-lock/);
  writeFileSync(path.join(root, 'package-lock.json'), '{}');
  assert.equal(await installHarnesses(root, { runImpl, node: '/app/node', env: { AGENT_BOT_NPM: '/app/npm/bin/npm-cli.js' } }), true);
  assert.deepEqual(calls, [{ command: '/app/node', args: ['/app/npm/bin/npm-cli.js', 'ci', '--ignore-scripts', '--omit=dev', '--no-audit', '--no-fund'], cwd: root }]);
  assert.deepEqual(npmCommand({}), { command: 'npm', args: [] });
});

test('two launches of the same new soul share one creation', async (t) => {
  const root = mkdtempSync(path.join(tmpdir(), 'soul-home-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  let installs = 0;
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const bindings = fakeBindings();
  const provision = createSoulHomes({ stateDir: root, bindings, install: async () => { installs += 1; await gate; } });
  const first = provision({ agentId });
  const second = provision({ agentId });
  release();
  const [a, b] = await Promise.all([first, second]);
  assert.equal(installs, 1);
  assert.equal(a.worktree, b.worktree);
  assert.equal(existsSync(path.join(a.worktree, '.git')), true);
});
