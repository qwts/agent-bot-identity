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

// An installed agent-hook that allows everything, so the guard under test is
// the only thing that can refuse, and no test reaches `gh api user`.
function allowingAgentHook() {
  const bin = path.join(root, `allow-hook-${Math.random().toString(16).slice(2)}`);
  writeFileSync(bin, '#!/bin/sh\nexit 0\n');
  chmodSync(bin, 0o755);
  return bin;
}

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

// CURSOR_AGENT and COPILOT_AGENT are the measured agent-session markers. Every
// marker must still be recognized as agent context, because that is what
// makes a bot-attributed commit answer for its Agent ID. Under ENG-0339 the
// same context no longer refuses a human-attributed commit: in the owner's
// account that is the human's delegate at work, wherever the checkout sits.
test('pre-commit recognizes agent markers for bot attribution and lets the delegate commit as the human', () => {
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
    const run = () => execFileSync(preCommit, {
      cwd: repo,
      env: { ...env, ...marker, AGENT_BOT_HOOK_BIN: allowingAgentHook() },
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    // Human-attributed: delegate work, never refused, no directory rule.
    assert.doesNotThrow(run, `${name}: a human-attributed commit is the delegate's own`);
    // Bot-attributed with no Agent ID: the marker must still be seen as agent
    // context, or this would slip through as an unidentified bot commit.
    git('config', 'user.name', 'you-codex-agent[bot]');
    git('config', '--unset', 'agentBot.agentId');
    assert.throws(run, (error) => /no resolvable Agent-Identity/.test(error.stderr), `${name}: agent context recognized`);
  }
});

// The markers the guards read, stripped so a suite run inside a harness
// cannot carry an ambient marker that trips a guard on its own.
const GUARD_MARKERS = [
  'CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT', 'AI_AGENT', 'GH_AGENT_APP',
  'CURSOR_AGENT', 'COPILOT_AGENT', 'DEVIN_AGENT', 'WINDSURF_AGENT',
  'MUSE_AGENT', 'AGENT_BOT_ACCOUNT',
];

function humanEnv(extra = {}) {
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      ([key]) => !key.startsWith('CODEX_') && !GUARD_MARKERS.includes(key),
    ),
  );
  return { ...env, ...extra };
}

const prePush = path.join(hooks, 'pre-push');
const pushLine = 'refs/heads/main 0000000000000000000000000000000000000001 refs/heads/main 0000000000000000000000000000000000000000\n';

// ENG-0339 supersedes the #175 push rule: a human-attributed push from a
// harness in the owner's account is delegate work, and no guard confines it
// to `.<tool>/worktrees/<repo>`. The installed runner still sees every push.
test('pre-push lets a human-attributed push from agent context reach GitHub', () => {
  const { repo, git } = fixture('push-guard');
  git('config', 'user.name', 'Human Developer');
  git('config', 'user.email', 'human@example.com');
  git('remote', 'add', 'origin', 'https://github.com/example/repo.git');
  const hookBin = allowingAgentHook();
  const run = (env, args = ['origin', 'https://github.com/example/repo.git']) =>
    execFileSync(prePush, args, {
      cwd: repo,
      env: { ...env, AGENT_BOT_HOOK_BIN: hookBin },
      input: pushLine,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });

  for (const marker of [{ CLAUDECODE: '1' }, { CURSOR_AGENT: '1' }, { AGENT_BOT_ACCOUNT: 'you-goose-agent' }]) {
    assert.doesNotThrow(() => run(humanEnv(marker)));
  }
  // A bare `git push` hands the hook no URL; nothing about it is refused either.
  assert.doesNotThrow(() => run(humanEnv({ CLAUDECODE: '1' }), []));
  // A human shell is never evaluated.
  assert.doesNotThrow(() => run(humanEnv()));
  // Bot attribution passes too (the Agent ID is pre-commit's job).
  git('config', 'user.name', 'you-codex-agent[bot]');
  assert.doesNotThrow(() => run(humanEnv({ CLAUDECODE: '1' })));
});

test('pre-push lets an agent push to a remote that does not reach GitHub', () => {
  const { repo, git } = fixture('push-local');
  git('config', 'user.name', 'Human Developer');
  const bare = path.join(root, 'push-local-bare.git');
  execFileSync('git', ['init', '--quiet', '--bare', bare]);
  git('remote', 'add', 'scratch', bare);
  assert.doesNotThrow(() => execFileSync(prePush, ['scratch', bare], {
    cwd: repo,
    env: { ...humanEnv({ CLAUDECODE: '1' }), AGENT_BOT_HOOK_BIN: allowingAgentHook() },
    input: pushLine,
    stdio: ['pipe', 'pipe', 'pipe'],
  }));
});

// A local clone of a GitHub-backed checkout, a remoteless scratch repo, and a
// clone of one: none of them is a place the delegate may not commit. The
// remote graph used to decide GitHub-boundness for the retired territory
// rule; it decides nothing for a human-attributed commit now.
test('pre-commit never confines a human-attributed commit by remote or directory', () => {
  const upstream = fixture('local-upstream');
  upstream.git('remote', 'add', 'origin', 'git@github.com:example/repo.git');
  const { repo, git } = fixture('local-clone');
  git('config', 'user.name', 'Human Developer');
  git('config', 'user.email', 'human@example.com');
  git('remote', 'add', 'origin', upstream.repo);
  const hookBin = allowingAgentHook();
  assert.doesNotThrow(() => execFileSync(preCommit, {
    cwd: repo,
    env: { ...humanEnv({ CLAUDECODE: '1' }), AGENT_BOT_HOOK_BIN: hookBin },
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }));
  git('remote', 'remove', 'origin');
  assert.doesNotThrow(() => execFileSync(preCommit, {
    cwd: repo,
    env: { ...humanEnv({ CLAUDECODE: '1' }), AGENT_BOT_HOOK_BIN: hookBin },
    stdio: ['ignore', 'pipe', 'pipe'],
  }));
  const scratch = fixture('local-scratch');
  git('remote', 'add', 'origin', scratch.repo);
  assert.doesNotThrow(() => execFileSync(preCommit, {
    cwd: repo,
    env: { ...humanEnv({ CLAUDECODE: '1' }), AGENT_BOT_HOOK_BIN: hookBin },
    stdio: ['ignore', 'pipe', 'pipe'],
  }));
});
