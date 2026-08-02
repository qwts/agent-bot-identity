import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ensureAgentIdentity, readAgentIdentity } from '../agent-identity.mjs';
import { helperSlug } from '../worktree-token.mjs';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const STARTUP = join(ROOT, 'scripts', 'ensure-identity.sh');
const WORKTREE_TOKEN = join(ROOT, 'worktree-token.mjs');
const roots = [];
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })));

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
  for (const slug of [app, claudeApp]) mkdirSync(join(home, '.config', slug), { recursive: true });
  mkdirSync(join(home, '.config', 'agent-bot'), { recursive: true });
  mkdirSync(join(home, '.local', 'bin'), { recursive: true });
  mkdirSync(join(home, '.local', 'share', 'agent-bot', 'hooks'), { recursive: true });
  writeFileSync(join(home, '.config', app, 'bot-uid'), '123456\n');
  writeFileSync(join(home, '.config', app, 'private-key.pem'), '');
  writeFileSync(join(home, '.config', claudeApp, 'bot-uid'), '654321\n');
  writeFileSync(join(home, '.config', claudeApp, 'private-key.pem'), '');
  writeFileSync(join(home, '.config', 'agent-bot', 'config.json'), JSON.stringify({
    apps: { codex: app, claude: claudeApp },
  }));
  writeFileSync(join(home, '.local', 'bin', 'agent-bot'),
    `#!/bin/sh\nexec node ${JSON.stringify(join(ROOT, 'agent-bot.mjs'))} "$@"\n`, { mode: 0o755 });
  writeFileSync(join(home, '.local', 'share', 'agent-bot', 'hooks', 'prepare-commit-msg'),
    '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  writeFileSync(globalConfig, '');
  mkdirSync(repo);
  const env = {
    ...process.env,
    HOME: home,
    GIT_CONFIG_GLOBAL: globalConfig,
    AGENT_BOT_STATE_HOME: stateDir,
    PATH: `${join(home, '.local', 'bin')}:${process.env.PATH}`,
  };
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
  return { app, claudeApp, env, stateDir, worktree };
}

test('Codex startup repairs identity through the installed stable CLI', () => {
  const { app, env, stateDir, worktree } = fixture();
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

test('Codex startup evicts a Claude pin from Codex territory', () => {
  const { app, claudeApp, env, stateDir, worktree } = fixture();
  const previous = ensureAgentIdentity({
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
    env: { ...env, CLAUDECODE: '1', GH_AGENT_APP: claudeApp },
    encoding: 'utf8',
  }).trim();
  assert.equal(tokenSlug, app, 'token selection must not mint for the stale Claude pin');

  const result = execFileSync('bash', [STARTUP], {
    cwd: worktree,
    env: { ...env, CLAUDECODE: '1', GH_AGENT_APP: claudeApp, CODEX_THREAD_ID: 'thread-repaired' },
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const read = (key) => execFileSync('git', ['config', '--worktree', '--get', key], {
    cwd: worktree, env, encoding: 'utf8',
  }).trim();
  const repairedId = read('agentBot.agentId');
  assert.equal(read('agentBot.app'), app);
  assert.equal(read('user.name'), `${app}[bot]`);
  assert.notEqual(repairedId, previous.id);
  assert.equal(readAgentIdentity(repairedId, { stateDir }).github.appSlug, app);
  assert.equal(readAgentIdentity(repairedId, { stateDir }).harness, 'codex');
  assert.equal(readAgentIdentity(previous.id, { stateDir }).github.appSlug, claudeApp);
  assert.match(result, /agent identity: test-codex-agent\[bot\]/);
});
