import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync, chmodSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { hermeticGitEnv } from './helpers/hermetic-git.mjs';
import { worktreeSoul } from './helpers/worktree-soul.mjs';
import { placeWorktree, linkWorktree } from '../soul-worktrees.mjs';
import { installHookWrappers, installationPaths } from '../install.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
function fixture(t, harness = 'codex') {
  const home = mkdtempSync(join(tmpdir(), 'setup-area-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const env = hermeticGitEnv({}, { HOME: home, PATH: process.env.PATH, AGENT_BOT_ACCOUNT: 'owner',
    AGENT_BOT_CONFIG: join(home, 'config.json'), AGENT_BOT_STATE_HOME: join(home, 'state'),
    AGENT_BOT_POPULATION_PATH: join(home, 'population.json'), AGENT_BOT_SOULS_HOME: join(home, 'souls'),
    AGENT_BOT_SPACES_HOME: join(home, 'spaces') });
  writeFileSync(env.AGENT_BOT_CONFIG, JSON.stringify({ settings: { daemonPreference: 'off' } }));
  const repo = join(home, 'repo');
  mkdirSync(repo);
  const git = (cwd, ...args) => execFileSync('git', args, { cwd, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  git(repo, 'init', '-q', '-b', 'main');
  git(repo, 'config', 'user.name', 'Test');
  git(repo, 'config', 'user.email', 'test@example.com');
  git(repo, 'config', 'core.hooksPath', '/dev/null');
  git(repo, 'commit', '--allow-empty', '-q', '-m', 'init');
  git(repo, 'config', 'extensions.worktreeConfig', 'true');
  git(repo, 'config', '--worktree', 'agentBot.app', 'old-grok-agent');
  const { identity, options } = worktreeSoul(env, null, { harness });
  const run = (cwd, args = [], extra = {}) => spawnSync(process.execPath, [join(root, 'agent-bot.mjs'), 'setup-worktree', ...args], { cwd, env: { ...env, ...extra }, encoding: 'utf8' });
  const add = (destination) => { mkdirSync(dirname(destination), { recursive: true }); git(repo, 'worktree', 'add', '-q', '-b', 'topic', destination); return destination; };
  return { home, env, repo, git, identity, options, run, add };
}
function unchanged(f, cwd, operation) {
  const gitDir = f.git(cwd, 'rev-parse', '--absolute-git-dir');
  const files = [join(f.repo, '.git', 'config'), join(gitDir, 'config.worktree')];
  const before = files.map((file) => existsSync(file) ? readFileSync(file) : null);
  const result = operation();
  files.forEach((file, i) => assert.deepEqual(existsSync(file) ? readFileSync(file) : null, before[i]));
  assert.equal(existsSync(join(gitDir, 'agent-bind-token.json')), false);
  return result;
}

test('primary checkout refuses without changing config.worktree or shared config', (t) => {
  const f = fixture(t);
  const result = unchanged(f, f.repo, () => f.run(f.repo, ['test-codex-agent']));
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /refusing primary checkout/);
});

test('arbitrary linked checkout refuses before credentials or config writes', (t) => {
  const f = fixture(t);
  const checkout = f.add(join(f.home, 'arbitrary'));
  const result = unchanged(f, checkout, () => f.run(checkout));
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /outside.*work area/);
});

for (const harness of ['claude', 'gemini', 'codex', 'opencode', 'cursor', 'copilot', 'devin', 'muse', 'grokbot', 'qwen']) {
  test(`${harness}: soul worktree succeeds with the session identity`, (t) => {
    const f = fixture(t, harness);
    const checkout = f.add(placeWorktree(f.identity.id, 'topic', { ...f.options, repoCommonDir: join(f.repo, '.git') }).path);
    const result = f.run(checkout);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(f.git(checkout, 'config', '--worktree', '--get', 'agentBot.agentId'), f.identity.id);
  });
}

test('existing durable link from the session soul succeeds without moving checkout', (t) => {
  const f = fixture(t);
  const checkout = f.add(join(f.home, 'durable'));
  linkWorktree(f.identity.id, checkout, f.options);
  assert.equal(f.run(checkout).status, 0);
});

test('a sibling soul and a nested checkout cannot borrow the work area', (t) => {
  const f = fixture(t);
  const checkout = f.add(placeWorktree(f.identity.id, 'topic', { ...f.options, repoCommonDir: join(f.repo, '.git') }).path);
  const other = worktreeSoul({ ...f.env });
  assert.notEqual(f.run(checkout, [], { AGENT_BOT_ID: other.identity.id }).status, 0);
  const nested = join(checkout, 'nested');
  mkdirSync(nested);
  f.git(nested, 'init', '-q');
  assert.notEqual(f.run(nested).status, 0);
});

test('name creates and configures once; branch selection is honored; primary stays untouched', (t) => {
  const f = fixture(t);
  const before = readFileSync(join(f.repo, '.git', 'config.worktree'));
  const first = f.run(f.repo, ['--name', 'change', '--branch', 'feature/change']);
  assert.equal(first.status, 0, first.stderr);
  const path = placeWorktree(f.identity.id, 'change', { ...f.options, repoCommonDir: join(f.repo, '.git') }).path;
  assert.equal(f.git(path, 'symbolic-ref', '--short', 'HEAD'), 'feature/change');
  assert.equal(f.run(f.repo, ['--name', 'change']).status, 0);
  assert.deepEqual(readFileSync(join(f.repo, '.git', 'config.worktree')), before);
});

test('a session without a soul is told to join, keeps the checkout human and never uses a stale pin', (t) => {
  const f = fixture(t);
  // Run by name (the CLI sets the hint): a quiet success that names the way in,
  // so the harness startup script and a human's own session keep working.
  const result = unchanged(f, f.repo, () => f.run(f.repo, ['test-kiro-agent'], { AGENT_BOT_ID: '', AI_AGENT: 'kiro', AGENT_BOT_SETUP_HINT: '1' }));
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, /no session soul.*checks in with agent-bot join --name NAME --harness HARNESS/);
  assert.doesNotMatch(result.stderr, /approval/);
  // Asked to create a worktree, it is an error: there is no soul to put it under.
  const named = unchanged(f, f.repo, () => f.run(f.repo, ['--name', 'feature'], { AGENT_BOT_ID: '', AI_AGENT: 'kiro' }));
  assert.notEqual(named.status, 0);
  assert.match(named.stderr, /no session soul/);
});

test('help succeeds outside git without reading config', (t) => {
  const f = fixture(t);
  writeFileSync(join(f.home, 'invalid-config'), 'invalid json');
  const result = f.run(f.home, ['--help'], { AGENT_BOT_CONFIG: join(f.home, 'invalid-config') });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /usage:.*setup-worktree/);
  assert.match(result.stdout, /primary checkouts/);
  assert.match(result.stdout, /cross-device/);
});

test('post-checkout with no session soul is silent and writes nothing; with a soul primary still refuses', (t) => {
  const f = fixture(t);
  for (const id of ['', f.identity.id]) {
    const result = unchanged(f, f.repo, () => spawnSync(join(root, 'hooks', 'post-checkout'), [], {
      cwd: f.repo, env: { ...f.env, AGENT_BOT_ID: id }, encoding: 'utf8',
    }));
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, '');
    if (!id) assert.equal(result.stderr, '');
  }
});

test('hook cannot reuse another soul pin in an otherwise allowed worktree', (t) => {
  const f = fixture(t);
  const checkout = f.add(placeWorktree(f.identity.id, 'topic', { ...f.options, repoCommonDir: join(f.repo, '.git') }).path);
  const other = worktreeSoul({ ...f.env });
  f.git(checkout, 'config', '--worktree', 'agentBot.agentId', other.identity.id);
  const result = unchanged(f, checkout, () => f.run(checkout, ['--from-hook']));
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /another soul/);
});

test('install refreshes an already-installed checkout hook through the existing wrapper installer', (t) => {
  const f = fixture(t);
  const hooks = installationPaths(f.home).hooksDir;
  mkdirSync(hooks, { recursive: true });
  const hook = join(hooks, 'post-checkout');
  writeFileSync(hook, '#!/bin/sh\n# stale setup hook\nexit 98\n');
  chmodSync(hook, 0o600);
  installHookWrappers({ home: f.home });
  assert.match(readFileSync(hook, 'utf8'), /agent-bot" hook post-checkout/);
  assert.equal(statSync(hook).mode & 0o777, 0o755);
});


test('existing branch creation, invalid names, and occupied names are handled without repurposing a checkout', (t) => {
  const f = fixture(t);
  f.git(f.repo, 'branch', 'existing');
  assert.equal(f.run(f.repo, ['--name', 'existing']).status, 0);
  const before = f.git(f.repo, 'worktree', 'list', '--porcelain');
  for (const name of ['../escape', 'bad/name', '-leading', 'a..b']) {
    assert.notEqual(f.run(f.repo, ['--name', name]).status, 0);
  }
  assert.notEqual(f.run(f.repo, ['--name', 'existing', '--branch', 'wrong']).status, 0);
  assert.equal(f.git(f.repo, 'worktree', 'list', '--porcelain'), before);
});

test('an external checkout linked from another soul is refused until this soul explicitly links it', (t) => {
  const f = fixture(t);
  const checkout = f.add(join(f.home, 'external'));
  const other = worktreeSoul({ ...f.env }, checkout);
  const result = unchanged(f, checkout, () => f.run(checkout));
  assert.notEqual(result.status, 0);
  linkWorktree(f.identity.id, checkout, f.options);
  assert.equal(f.run(checkout).status, 0);
  assert.notEqual(f.run(checkout, [], { AGENT_BOT_ID: other.identity.id }).status, 0, 'an existing different soul pin cannot be overwritten');
});
