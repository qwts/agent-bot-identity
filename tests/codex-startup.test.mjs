import { worktreeSoul } from './helpers/worktree-soul.mjs';
import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ensureAgentIdentity, readAgentIdentity } from '../agent-identity.mjs';
import { helperSlug } from '../worktree-token.mjs';
import { startMockGitHubApp } from './helpers/mock-github-app.mjs';
import { hermeticGitEnv } from './helpers/hermetic-git.mjs';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const STARTUP = join(ROOT, 'scripts', 'ensure-identity.sh');
const WORKTREE_TOKEN = join(ROOT, 'worktree-token.mjs');
const roots = [];
const servers = [];
afterEach(() => {
  servers.splice(0).forEach((server) => server.stop());
  roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true }));
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'agent-startup-'));
  roots.push(root);
  const home = join(root, 'home');
  const repo = join(root, 'repo');
  const worktree = join(root, '.codex', 'worktrees', 'session', 'repo');
  const stateDir = join(root, 'state');
  const globalConfig = join(root, 'gitconfig');
  const app = 'test-codex-agent';
  const claudeApp = 'test-claude-agent';
  const github = startMockGitHubApp(root);
  servers.push(github);
  for (const slug of [app, claudeApp]) mkdirSync(join(home, '.config', slug), { recursive: true });
  mkdirSync(join(home, '.config', 'agent-bot'), { recursive: true });
  mkdirSync(join(home, '.local', 'bin'), { recursive: true });
  mkdirSync(join(home, '.local', 'share', 'agent-bot', 'hooks'), { recursive: true });
  writeFileSync(join(home, '.config', app, 'bot-uid'), '123456\n');
  writeFileSync(join(home, '.config', app, 'app-id'), '12345\n');
  writeFileSync(join(home, '.config', app, 'private-key.pem'), github.privateKeyPem);
  writeFileSync(join(home, '.config', claudeApp, 'bot-uid'), '654321\n');
  writeFileSync(join(home, '.config', claudeApp, 'app-id'), '12346\n');
  writeFileSync(join(home, '.config', claudeApp, 'private-key.pem'), github.privateKeyPem);
  writeFileSync(join(home, '.config', 'agent-bot', 'config.json'), JSON.stringify({
    apps: { codex: app, claude: claudeApp },
    apiBase: github.apiBase,
    owner: 'test-owner',
    features: { 'github-identity': true },
  }));
  writeFileSync(join(home, '.local', 'bin', 'agent-bot'),
    `#!/bin/sh\nexec node ${JSON.stringify(join(ROOT, 'agent-bot.mjs'))} "$@"\n`, { mode: 0o755 });
  writeFileSync(join(home, '.local', 'share', 'agent-bot', 'hooks', 'prepare-commit-msg'),
    '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  writeFileSync(globalConfig, '');
  mkdirSync(repo);
  const env = hermeticGitEnv(process.env, {
    HOME: home,
    GIT_CONFIG_GLOBAL: globalConfig,
    AGENT_BOT_STATE_HOME: stateDir,
    PATH: `${join(home, '.local', 'bin')}:${process.env.PATH}`,
  });
  for (const key of Object.keys(env)) {
    if (/^(CODEX|CLAUDE|AI_AGENT|QWTS_AGENT|GH_AGENT_APP)/.test(key)) delete env[key];
  }
  env.AGENT_BOT_STATE_HOME = stateDir;
  execFileSync('git', ['init', '--quiet', '--initial-branch=main'], { cwd: repo, env });
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: repo, env });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: repo, env });
  execFileSync('git', ['config', 'core.hooksPath', '/dev/null'], { cwd: repo, env });
  execFileSync('git', ['remote', 'add', 'origin', 'git@github.com:example/repo.git'], { cwd: repo, env });
  execFileSync('git', ['config', '--add', 'remote.origin.pushurl', 'git@github.com:example/repo.git'], { cwd: repo, env });
  execFileSync('git', ['config', '--add', 'remote.origin.pushurl', 'ssh://git@github.example/example/repo.git'], { cwd: repo, env });
  writeFileSync(join(repo, 'README.md'), '# fixture\n');
  execFileSync('git', ['add', '.'], { cwd: repo, env });
  execFileSync('git', ['commit', '--quiet', '-m', 'initial'], { cwd: repo, env });
  mkdirSync(dirname(worktree), { recursive: true });
  execFileSync('git', ['worktree', 'add', '--quiet', '-b', 'topic', worktree], { cwd: repo, env });
  return { app, claudeApp, env, repo, stateDir, worktree };
}

test('Codex startup repairs identity through the installed stable CLI', () => {
  const { app, env, stateDir, worktree } = fixture();
  worktreeSoul(env, worktree, { appSlug: app, transcript: { provider: 'codex', id: 'thread-test-1' } });
  execFileSync('bash', [STARTUP], {
    cwd: worktree,
    env: { ...env, CODEX_THREAD_ID: 'thread-test-1', GH_AGENT_APP: app },
  });
  const read = (key) => execFileSync('git', ['config', '--worktree', '--get', key], {
    cwd: worktree, env, encoding: 'utf8',
  }).trim();
  const id = read('agentBot.agentId');
  assert.equal(read('agentBot.app'), app);
  assert.equal(read('user.name'), `${app}[bot]`);
  const helpers = execFileSync('git', ['config', '--get-all', 'credential.helper'], {
    cwd: worktree, env, encoding: 'utf8',
  }).trim();
  assert.equal(helperSlug(helpers), app);
  assert.match(helpers, /\.local\/bin\/agent-bot.*credential/);
  assert.equal(read('core.hooksPath'), join(env.HOME, '.local', 'share', 'agent-bot', 'hooks'));
  assert.equal(
    execFileSync('git', ['remote', 'get-url', 'origin'], { cwd: worktree, env, encoding: 'utf8' }).trim(),
    'https://github.com/example/repo',
  );
  assert.deepEqual(
    execFileSync('git', ['remote', 'get-url', '--push', '--all', 'origin'], {
      cwd: worktree, env, encoding: 'utf8',
    }).trim().split('\n'),
    ['https://github.com/example/repo', 'https://github.example/example/repo'],
  );
  assert.deepEqual(readAgentIdentity(id, { stateDir }).transcript, {
    provider: 'codex', id: 'thread-test-1', sha256: null,
  });
});

// ENG-0339: the directory is not a signal, so nothing about `.codex/worktrees`
// evicts the pin. Setup refuses to configure another soul's checkout.
test('Codex startup refuses another soul pin despite the launcher-stated App', () => {
  const { app, claudeApp, env, stateDir, worktree } = fixture();
  const previous = ensureAgentIdentity({
    useGithub: true,
    appSlug: claudeApp,
    botUid: '654321',
    harness: 'claude-code',
    transcript: { provider: 'claude', id: 'old-session' },
    stateDir,
  });
  execFileSync('git', ['config', 'extensions.worktreeConfig', 'true'], { cwd: worktree, env });
  execFileSync('git', ['config', '--worktree', 'agentBot.app', claudeApp], { cwd: worktree, env });
  execFileSync('git', ['config', '--worktree', 'agentBot.agentId', previous.id], { cwd: worktree, env });
  execFileSync('git', ['config', '--worktree', 'user.name', `${claudeApp}[bot]`], { cwd: worktree, env });

  const tokenSlug = execFileSync('node', [WORKTREE_TOKEN, '--slug'], {
    cwd: worktree,
    env: { ...env, CLAUDECODE: '1', GH_AGENT_APP: app },
    encoding: 'utf8',
  }).trim();
  assert.equal(tokenSlug, app, 'GH_AGENT_APP outranks the stale pin for token selection too');

  worktreeSoul(env, worktree, { appSlug: app });
  const result = spawnSync('bash', [STARTUP], {
    cwd: worktree,
    env: { ...env, CLAUDECODE: '1', GH_AGENT_APP: app, CODEX_THREAD_ID: 'thread-repaired' },
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const read = (key) => execFileSync('git', ['config', '--worktree', '--get', key], {
    cwd: worktree, env, encoding: 'utf8',
  }).trim();
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /another soul/);
  assert.equal(read('agentBot.agentId'), previous.id);
  assert.equal(read('agentBot.app'), claudeApp);
  assert.equal(read('user.name'), `${claudeApp}[bot]`);

});

// ENG-0339 acceptance (a): in the owner's account, an unpinned checkout with
// no GH_AGENT_APP is the human's delegate. Startup reports that and exits
// cleanly instead of refusing a primary checkout.
test('Codex startup without a session soul reports the human persona and leaves the owner checkout unchanged', () => {
  const { env, repo } = fixture();
  const result = spawnSync('bash', [STARTUP], {
    cwd: repo,
    env: { ...env, AGENT_BOT_ACCOUNT: 'user', CODEX_THREAD_ID: 'thread-delegate' },
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /human persona/);
  const read = (key) => execFileSync('git', ['config', '--get', key], {
    cwd: repo, env, encoding: 'utf8',
  }).trim();
  assert.equal(read('user.name'), 'Test');
  assert.throws(() => read('agentBot.app'));
});

// Account-based App resolution does not exempt a checkout from the work area.
test('Codex startup refuses a primary checkout even in an agent account', () => {
  const { app, env, repo } = fixture();
  worktreeSoul(env, null, { appSlug: app });
  const result = spawnSync('bash', [STARTUP], {
    cwd: repo, env: { ...env, AGENT_BOT_ACCOUNT: app }, encoding: 'utf8',
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /refusing primary checkout/);
  assert.equal(execFileSync('git', ['config', '--get', 'user.name'], { cwd: repo, env, encoding: 'utf8' }).trim(), 'Test');
  assert.equal(execFileSync('node', [WORKTREE_TOKEN, '--slug'], {
    cwd: repo, env: { ...env, AGENT_BOT_ACCOUNT: app }, encoding: 'utf8',
  }).trim(), app, 'the area check never changes App resolution');
});

// agent-sop#186 requirement 2 (#104): with no runtime anywhere, startup must
// route to the organization bootstrap (`./agent-bot bootstrap`), not a bare
// CLI install that skips the profile and credentials, and must write nothing.
test('Codex startup without an installed runtime routes to bootstrap and writes no identity', () => {
  const { env, worktree } = fixture();
  rmSync(join(env.HOME, '.local', 'bin', 'agent-bot'));
  const bin = join(dirname(env.HOME), 'bin');
  mkdirSync(bin);
  const which = (name) => execFileSync('/usr/bin/which', [name], { env, encoding: 'utf8' }).trim();
  symlinkSync(which('git'), join(bin, 'git'));
  symlinkSync(process.execPath, join(bin, 'node'));
  const bare = { ...env, PATH: `${bin}:/usr/bin:/bin:/usr/sbin:/sbin` };
  delete bare.AGENT_BOT_HOME;
  delete bare.PLAYBOOK_HOME;
  assert.equal(spawnSync('/bin/sh', ['-c', 'command -v agent-bot'], { env: bare }).status, 1,
    'agent-bot must be absent from the sanitized PATH');

  const result = spawnSync('bash', [STARTUP], {
    cwd: worktree,
    env: { ...bare, CODEX_THREAD_ID: 'thread-uninstalled' },
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /agent-bot is not installed/);
  assert.match(result.stderr, /\.\/agent-bot bootstrap/);
  assert.doesNotMatch(result.stderr, /install\.mjs/);
  assert.equal(spawnSync('git', ['config', '--get-regexp', '^agentbot\\.'], { cwd: worktree, env }).status, 1);
  assert.equal(spawnSync('git', ['config', '--get', 'extensions.worktreeConfig'], { cwd: worktree, env }).status, 1);
  assert.equal(execFileSync('git', ['config', '--get', 'user.name'], {
    cwd: worktree, env, encoding: 'utf8',
  }).trim(), 'Test');
});
