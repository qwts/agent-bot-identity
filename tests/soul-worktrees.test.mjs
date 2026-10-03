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
  assert.equal(readlinkSync(path.join(soulDir, '.soul-state', 'space')), path.join(options.home, 'space'));
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

test('cross-device fallback selects TMPDIR and links the created checkout', (t) => {
  const options = fixture(t);
  const repo = path.dirname(options.repoCommonDir);
  const env = hermeticGitEnv({}, { PATH: process.env.PATH, HOME: options.home, TMPDIR: options.env.TMPDIR });
  const git = (cwd, ...args) => execFileSync('git', args, { cwd, env, encoding: 'utf8' }).trim();
  git(repo, 'init', '-q', '-b', 'main');
  git(repo, 'config', 'user.name', 'Test');
  git(repo, 'config', 'user.email', 'test@example.com');
  git(repo, 'config', 'core.hooksPath', '/dev/null');
  git(repo, 'commit', '--allow-empty', '-q', '-m', 'initial');
  const calls = [];
  const placed = placeWorktree(agentId, 'topic', { ...options, stat: (directory) => {
    calls.push(directory);
    return { dev: directory === options.repoCommonDir ? 2 : 1 };
  } });
  assert.deepEqual(calls, [path.dirname(path.dirname(soulWorktreePath(agentId, 'topic', options))), options.repoCommonDir]);
  assert.deepEqual(placed, { path: path.join(options.env.TMPDIR, 'agent-bot', agentId, 'topic'), linked: true });
  git(repo, 'worktree', 'add', '-q', '-b', 'topic', placed.path);
  const link = linkWorktree(agentId, placed.path, { ...options, name: 'topic' });
  assert.equal(link, soulWorktreePath(agentId, 'topic', options));
  assert.ok(lstatSync(link).isSymbolicLink());
  assert.equal(realpathSync(link), realpathSync(placed.path));
  assert.equal(git(link, 'rev-parse', '--show-toplevel'), realpathSync(placed.path));
  assert.equal(git(link, 'symbolic-ref', '--short', 'HEAD'), 'topic');
});

test('long-path fallback selects TMPDIR on the same device', (t) => {
  const options = fixture(t);
  const length = soulWorktreePath(agentId, 'topic', options).length;
  assert.equal(placeWorktree(agentId, 'topic', { ...options, maxPathLength: length }).linked, false);
  const placed = placeWorktree(agentId, 'topic', { ...options, maxPathLength: length - 1 });
  assert.equal(placed.linked, true);
  mkdirSync(placed.path);
  assert.equal(realpathSync(linkWorktree(agentId, placed.path, options)), realpathSync(placed.path));
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
