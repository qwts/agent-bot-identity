import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { showSoul, upsertSoul } from '../agent-population.mjs';
import { linkWorktree, placeWorktree, soulWorktreePath } from '../soul-worktrees.mjs';
import { hermeticGitEnv } from './helpers/hermetic-git.mjs';

const agentId = 'agent_33333333-3333-4333-8333-333333333333';
function fixture(t) {
  const home = mkdtempSync(path.join(tmpdir(), 'soul-worktrees-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const options = { home, env: { AGENT_BOT_SOULS_HOME: path.join(home, 'souls'), TMPDIR: path.join(home, 'tmp') },
    config: {}, file: path.join(home, 'population.json') };
  upsertSoul({ id: agentId, name: 'test-soul', status: 'active', spacePath: path.join(home, 'space') }, options);
  const repoCommonDir = path.join(home, 'repo', '.git');
  mkdirSync(repoCommonDir, { recursive: true });
  return { ...options, repoCommonDir };
}

test('selects the soul path and provisions private worktrees and the soul marker', (t) => {
  const options = fixture(t);
  const expected = path.join(options.env.AGENT_BOT_SOULS_HOME, 'test-soul.soul', 'worktrees', 'topic');
  assert.equal(soulWorktreePath(agentId, 'topic', options), expected);
  assert.equal(existsSync(path.dirname(expected)), false, 'path lookup does not provision');
  assert.deepEqual(placeWorktree(agentId, 'topic', options), { path: expected, linked: false });
  assert.equal(statSync(path.dirname(expected)).mode & 0o777, 0o700);
  const soulDir = showSoul(agentId, options).soulDir;
  assert.equal(readFileSync(path.join(soulDir, '.soul-state', 'agent-id'), 'utf8'), `${agentId}\n`);
  assert.equal(statSync(path.join(soulDir, '.soul-state', 'agent-id')).mode & 0o777, 0o600);
  // A census space that does not exist yet is contained: a directory inside, the census following it (#583 slice 5).
  assert.equal(lstatSync(path.join(soulDir, '.soul-state', 'space')).isDirectory(), true);
  assert.equal(showSoul(agentId, options).spacePath, path.join(soulDir, '.soul-state', 'space'));
});

test('sanitizes separators, leading dots, empty names, and length', (t) => {
  const options = fixture(t);
  for (const name of ['../outside\\checkout', '.', '', '.hidden', 'a'.repeat(200), 'nul\0']) {
    const destination = soulWorktreePath(agentId, name, options);
    assert.equal(path.dirname(destination), path.dirname(soulWorktreePath(agentId, 'topic', options)));
    assert.ok(path.basename(destination).length <= 100);
    assert.ok(!path.basename(destination).startsWith('.'));
  }
  assert.throws(() => soulWorktreePath(agentId, 'topic', { ...options, file: path.join(options.home, 'missing') }), /no population record/);
  assert.throws(() => soulWorktreePath('../escape', 'topic', options), /Agent ID/);
});

test('cross-device placement refuses without creating a TMPDIR fallback', (t) => {
  const options = fixture(t);
  assert.throws(() => placeWorktree(agentId, 'topic', { ...options,
    stat: (directory) => ({ dev: directory === options.repoCommonDir ? 2 : 1 }),
  }), /different devices.*durable linked git worktree.*No TMPDIR fallback/);
  assert.equal(existsSync(options.env.TMPDIR), false);
  assert.equal(existsSync(path.dirname(soulWorktreePath(agentId, 'topic', options))), false);
});

test('long paths refuse instead of selecting TMPDIR', (t) => {
  const options = fixture(t);
  const length = soulWorktreePath(agentId, 'topic', options).length;
  assert.equal(placeWorktree(agentId, 'topic', { ...options, maxPathLength: length }).linked, false);
  assert.throws(() => placeWorktree(agentId, 'topic', { ...options, maxPathLength: length - 1 }), /path is too long/);
  assert.equal(existsSync(options.env.TMPDIR), false);
});

test('foreign checkout links are idempotent and clashes get numbered suffixes', (t) => {
  const options = fixture(t);
  const checkout = path.join(options.home, '.devin', 'worktrees', 'x');
  mkdirSync(checkout, { recursive: true });
  writeFileSync(path.join(checkout, 'content'), 'keep me');
  const first = linkWorktree(agentId, checkout, options);
  assert.equal(first, soulWorktreePath(agentId, 'x', options));
  assert.equal(linkWorktree(agentId, checkout, options), first);
  const other = path.join(options.home, 'other', 'x');
  mkdirSync(other, { recursive: true });
  const second = linkWorktree(agentId, other, options);
  assert.equal(second, `${first}-2`);
  assert.equal(linkWorktree(agentId, other, options), second);
  assert.equal(readFileSync(path.join(checkout, 'content'), 'utf8'), 'keep me');
  assert.equal(realpathSync(first), realpathSync(checkout));
  assert.equal(realpathSync(second), realpathSync(other));
  const dangling = soulWorktreePath(agentId, 'clash', options);
  symlinkSync(path.join(options.home, 'gone'), dangling);
  mkdirSync(`${dangling}-2`);
  assert.equal(linkWorktree(agentId, checkout, { ...options, name: 'clash' }), `${dangling}-3`);
});

test('a checkout already in the soul gets no redundant link', (t) => {
  const options = fixture(t);
  const placed = placeWorktree(agentId, 'topic', options);
  mkdirSync(placed.path);
  assert.equal(linkWorktree(agentId, placed.path, options), realpathSync(placed.path));
  assert.equal(lstatSync(placed.path).isSymbolicLink(), false);
  assert.equal(existsSync(`${placed.path}-2`), false);
});
