import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  credentialHelperCommand,
  httpsRemoteUrl,
  normalizeGitBashPath,
  validateAppSlug,
} from '../setup-worktree.mjs';
import { helperSlug } from '../worktree-token.mjs';
import { hermeticGitEnv } from './helpers/hermetic-git.mjs';

const SETUP = fileURLToPath(new URL('../setup-worktree.mjs', import.meta.url));

test('accepts shell-safe GitHub App slugs', () => {
  assert.equal(validateAppSlug('you-codex-agent'), 'you-codex-agent');
  assert.equal(validateAppSlug('App2'), 'App2');
});

test('rejects app slugs that could escape paths or inject shell syntax', () => {
  for (const slug of ['', '-leading', 'trailing-', '../escape', 'two words', 'app;echo-owned', "app'quoted"]) {
    assert.throws(() => validateAppSlug(slug), /invalid GitHub App slug/);
  }
});

test('normalizes and quotes a Windows credential-helper path for Git Bash', () => {
  const command = credentialHelperCommand(
    String.raw`C:\Users\Agent User\Code\agent-bot-identity\git-credential-bot.mjs`,
    'you-codex-agent',
  );

  assert.equal(
    command,
    "!node 'C:/Users/Agent User/Code/agent-bot-identity/git-credential-bot.mjs' you-codex-agent",
  );
  assert.equal(helperSlug(command), 'you-codex-agent');
});

test('normalizes Windows hook paths for Git Bash', () => {
  assert.equal(
    normalizeGitBashPath(
      String.raw`C:\Users\Agent User\Code\agent-bot-identity\hooks`,
    ),
    'C:/Users/Agent User/Code/agent-bot-identity/hooks',
  );
});

test('preserves Unix credential-helper paths, including spaces and apostrophes', () => {
  const command = credentialHelperCommand(
    "/Users/Agent O'Neil/Code/agent-bot-identity/git-credential-bot.mjs",
    'you-codex-agent',
  );

  assert.equal(
    command,
    "!node '/Users/Agent O'\"'\"'Neil/Code/agent-bot-identity/git-credential-bot.mjs' you-codex-agent",
  );
  assert.equal(helperSlug(command), 'you-codex-agent');
});

test('rewrites fetch and explicit push SSH URLs to HTTPS', () => {
  assert.equal(
    httpsRemoteUrl('git@github.com:example/repo.git'),
    'https://github.com/example/repo',
  );
  assert.equal(
    httpsRemoteUrl('ssh://git@github.example/example/repo.git'),
    'https://github.example/example/repo',
  );
  assert.equal(httpsRemoteUrl('https://github.com/example/repo.git'), 'https://github.com/example/repo.git');
  assert.throws(
    () => httpsRemoteUrl('ssh://github.com/example/repo.git'),
    /cannot safely rewrite SSH remote URL/,
  );
});

test('credential failure leaves the linked worktree and SSH remote untouched', () => {
  const root = mkdtempSync(join(tmpdir(), 'agent-setup-failure-'));
  const home = join(root, 'home');
  const repo = join(root, 'repo');
  const worktree = join(root, '.codex', 'worktrees', 'failure', 'repo');
  const globalConfig = join(root, 'gitconfig');
  const slug = 'test-codex-agent';
  mkdirSync(join(home, '.config', slug), { recursive: true });
  mkdirSync(join(home, '.config', 'agent-bot'), { recursive: true });
  mkdirSync(repo);
  writeFileSync(join(home, '.config', slug, 'app-id'), 'malformed\n');
  writeFileSync(join(home, '.config', slug, 'private-key.pem'), 'malformed\n');
  writeFileSync(join(home, '.config', 'agent-bot', 'config.json'), JSON.stringify({
    apps: { codex: slug },
  }));
  writeFileSync(globalConfig, '');
  const env = hermeticGitEnv(process.env, { HOME: home, GIT_CONFIG_GLOBAL: globalConfig });
  execFileSync('git', ['init', '--quiet', '--initial-branch=main'], { cwd: repo, env });
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: repo, env });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: repo, env });
  execFileSync('git', ['config', 'core.hooksPath', '/dev/null'], { cwd: repo, env });
  execFileSync('git', ['remote', 'add', 'origin', 'git@github.com:example/repo.git'], { cwd: repo, env });
  writeFileSync(join(repo, 'README.md'), '# fixture\n');
  execFileSync('git', ['add', 'README.md'], { cwd: repo, env });
  execFileSync('git', ['commit', '--quiet', '-m', 'initial'], { cwd: repo, env });
  mkdirSync(dirname(worktree), { recursive: true });
  execFileSync('git', ['worktree', 'add', '--quiet', '-b', 'failure', worktree], { cwd: repo, env });

  const result = spawnSync(process.execPath, [SETUP, slug], {
    cwd: worktree,
    env,
    encoding: 'utf8',
  });
  assert.notEqual(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stderr, /credential reconciliation failed/);
  assert.equal(
    execFileSync('git', ['remote', 'get-url', 'origin'], { cwd: worktree, env, encoding: 'utf8' }).trim(),
    'git@github.com:example/repo.git',
  );
  const pin = spawnSync('git', ['config', '--worktree', '--get', 'agentBot.app'], {
    cwd: worktree,
    env,
  });
  assert.notEqual(pin.status, 0);
});
