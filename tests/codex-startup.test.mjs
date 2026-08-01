import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readAgentIdentity } from '../agent-identity.mjs';
import { helperSlug } from '../worktree-token.mjs';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const STARTUP = join(ROOT, 'scripts', 'ensure-identity.sh');
const roots = [];
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })));

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'agent-startup-'));
  roots.push(root);
  const home = join(root, 'home');
  const repo = join(root, 'repo');
  const worktree = join(root, 'worktree');
  const stateDir = join(root, 'state');
  const globalConfig = join(root, 'gitconfig');
  const app = 'test-codex-agent';
  mkdirSync(join(home, '.config', app), { recursive: true });
  mkdirSync(join(home, '.local', 'bin'), { recursive: true });
  mkdirSync(join(home, '.local', 'share', 'agent-bot', 'hooks'), { recursive: true });
  writeFileSync(join(home, '.config', app, 'bot-uid'), '123456\n');
  writeFileSync(join(home, '.config', app, 'private-key.pem'), '');
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
  writeFileSync(join(repo, 'README.md'), '# fixture\n');
  execFileSync('git', ['add', '.'], { cwd: repo, env });
  execFileSync('git', ['commit', '--quiet', '-m', 'initial'], { cwd: repo, env });
  execFileSync('git', ['worktree', 'add', '--quiet', '-b', 'topic', worktree], { cwd: repo, env });
  return { app, env, stateDir, worktree };
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
  assert.deepEqual(readAgentIdentity(id, { stateDir }).transcript, {
    provider: 'codex', id: 'thread-test-1', sha256: null,
  });
});
