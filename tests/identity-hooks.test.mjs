import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  mintAgentIdentity,
  readAgentIdentity,
} from '../agent-identity.mjs';

const root = mkdtempSync(path.join(tmpdir(), 'identity-hooks-'));
after(() => rmSync(root, { recursive: true, force: true }));

const agentBot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const hooks = path.join(agentBot, 'hooks');
const prepare = path.join(hooks, 'prepare-commit-msg');
const commitMsg = path.join(hooks, 'commit-msg');
const postCommit = path.join(hooks, 'post-commit');
const preCommit = path.join(hooks, 'pre-commit');

function fixture(name) {
  const repo = path.join(root, name);
  const stateDir = path.join(root, `${name}-state`);
  mkdirSync(repo);
  const git = (...args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim();
  git('init', '--quiet', '--initial-branch=main');
  git('config', 'user.name', 'you-codex-agent[bot]');
  git('config', 'user.email', '308462948+you-codex-agent[bot]@users.noreply.github.com');
  git('config', 'commit.gpgsign', 'false');
  git('config', 'core.hooksPath', '/dev/null');
  writeFileSync(path.join(repo, 'README.md'), '# fixture\n');
  git('add', 'README.md');
  git('commit', '--quiet', '-m', 'initial');
  const identity = mintAgentIdentity({
    appSlug: 'you-codex-agent',
    botUid: '308462948',
    harness: 'codex',
    transcript: { provider: 'codex', id: `${name}-thread` },
    stateDir,
  });
  git('config', 'agentBot.agentId', identity.id);
  const env = {
    ...process.env,
    AGENT_BOT_STATE_HOME: stateDir,
    CODEX_THREAD_ID: `${name}-thread`,
  };
  return { repo, stateDir, identity, git, env };
}

test('custom message hooks are chained and identity adds exactly one opaque trailer', () => {
  const { repo, identity, git, env } = fixture('prepare');
  const message = path.join(repo, 'message.txt');
  const customHooks = path.join(repo, '.custom-hooks');
  const customPrepare = path.join(customHooks, 'prepare-commit-msg');
  const customCommitMsg = path.join(customHooks, 'commit-msg');
  mkdirSync(customHooks);
  writeFileSync(customPrepare, '#!/bin/sh\nprintf "\\nCustom-Hook: ran\\n" >>"$1"\n');
  writeFileSync(customCommitMsg, '#!/bin/sh\nprintf "Commit-Msg-Hook: ran\\n" >>"$1"\n');
  chmodSync(customPrepare, 0o755);
  chmodSync(customCommitMsg, 0o755);
  git('config', 'extensions.worktreeConfig', 'true');
  git('config', '--worktree', 'agentBot.chainedHooksPath', '.custom-hooks');
  writeFileSync(message, 'explain why\n');

  execFileSync(prepare, [message, 'message'], { cwd: repo, env });
  execFileSync(prepare, [message, 'message'], { cwd: repo, env });
  execFileSync(commitMsg, [message], { cwd: repo, env });

  const body = readFileSync(message, 'utf8');
  assert.equal(body.match(/^Agent-Identity:/gm)?.length, 1);
  assert.match(body, new RegExp(`Agent-Identity: ${identity.id}$`, 'm'));
  assert.match(body, /^Custom-Hook: ran$/m);
  assert.match(body, /^Commit-Msg-Hook: ran$/m);
  assert.doesNotMatch(body, /thread|token|credential/i);
});

test('post-commit records the commit artifact in the private registry', () => {
  const { repo, stateDir, identity, git, env } = fixture('post');
  writeFileSync(path.join(repo, 'next.txt'), 'next\n');
  git('add', 'next.txt');
  git('commit', '--quiet', '--no-verify', '-m', 'next');
  const sha = git('rev-parse', 'HEAD');

  execFileSync(postCommit, { cwd: repo, env });

  assert.ok(readAgentIdentity(identity.id, { stateDir }).artifacts.includes(`commit:${sha}`));
});

test('pre-commit blocks a bot-attributed agent commit until its Agent ID resolves', () => {
  const { repo, stateDir, identity, git, env } = fixture('guard');
  git('remote', 'add', 'origin', 'https://github.com/example/repo.git');
  git('config', '--unset', 'agentBot.agentId');

  assert.throws(
    () => execFileSync(preCommit, { cwd: repo, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }),
    /Command failed/,
  );

  git('config', 'agentBot.agentId', identity.id);
  assert.doesNotThrow(() =>
    execFileSync(preCommit, {
      cwd: repo,
      env: { ...env, AGENT_BOT_STATE_HOME: stateDir },
      stdio: ['ignore', 'pipe', 'pipe'],
    }));
});

// CURSOR_AGENT and COPILOT_AGENT are the measured agent-session markers. Before
// they were listed here, a Cursor agent set none of the markers this guard knew
// about and committed as the human — the exact attribution the guard exists to
// prevent.
test('pre-commit recognizes explicit App and per-harness agent markers', () => {
  for (const [name, marker] of [
    ['app-marker', { GH_AGENT_APP: 'you-codex-agent' }],
    ['claude-entrypoint', { CLAUDE_CODE_ENTRYPOINT: 'cli' }],
    ['cursor-agent', { CURSOR_AGENT: '1' }],
    ['copilot-agent', { COPILOT_AGENT: '1' }],
    ['devin-agent', { DEVIN_AGENT: '1' }],
    ['windsurf-agent', { WINDSURF_AGENT: '1' }],
    ['muse-agent', { MUSE_AGENT: '1' }],
    // ENG-0339: an agent account is agent context with no env marker at all.
    ['agent-account', { AGENT_BOT_ACCOUNT: 'you-goose-agent' }],
    ['unmanaged-ai9d', { CURSOR_AGENT: '1' }],
  ]) {
    const { repo, git } = fixture(name);
    git('config', 'user.name', name === 'unmanaged-ai9d' ? 'ai9d' : 'Human Developer');
    git('config', 'user.email', name === 'unmanaged-ai9d' ? 'ai9d@users.noreply.github.com' : 'human@example.com');
    git('remote', 'add', 'origin', 'https://github.com/example/repo.git');
    // Every marker the guard knows must be stripped, not just the ones that
    // predate this test. Running the suite inside a Cursor or Copilot session
    // would otherwise leave an ambient marker that trips the guard on its own,
    // so the marker under test could stop working and this would still pass.
    const AMBIENT = [
      'CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT', 'AI_AGENT', 'GH_AGENT_APP',
      'CURSOR_AGENT', 'COPILOT_AGENT', 'DEVIN_AGENT', 'WINDSURF_AGENT',
      'MUSE_AGENT', 'AGENT_BOT_ACCOUNT',
    ];
    const env = Object.fromEntries(
      Object.entries(process.env).filter(
        ([key]) => !key.startsWith('CODEX_') && !AMBIENT.includes(key),
      ),
    );
    assert.throws(
      () => execFileSync(preCommit, {
        cwd: repo,
        env: { ...env, ...marker },
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      }),
      /Command failed/,
    );
  }
});
