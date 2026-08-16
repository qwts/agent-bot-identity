import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync, spawnSync } from 'node:child_process';

import { CANONICAL_EVENTS, DIALECTS, encodeDecision, vendorEvent } from '../hook-dialects.mjs';
import { renderConfig } from '../sync-hooks.mjs';
import {
  UNINSTALLED_REASON,
  adapterFallback,
  isHumanAttributedPublish,
  parseUnmanagedAuthors,
  uninstalledDecision,
} from '../uninstalled-identity-hook.mjs';

const HUMAN = {
  GIT_AUTHOR_NAME: 'qwts',
  GIT_AUTHOR_EMAIL: 'qwts@users.noreply.github.com',
  GIT_COMMITTER_NAME: 'qwts',
  GIT_COMMITTER_EMAIL: 'qwts@users.noreply.github.com',
  GH_USER: 'qwts',
  GITHUB_USER: 'qwts',
  GITHUB_ACTOR: 'qwts',
};

const AI9D = {
  GIT_AUTHOR_NAME: 'ai9d',
  GIT_AUTHOR_EMAIL: 'ai9d@users.noreply.github.com',
  GIT_COMMITTER_NAME: 'ai9d',
  GIT_COMMITTER_EMAIL: 'ai9d@users.noreply.github.com',
  GH_USER: 'ai9d',
  GITHUB_USER: 'ai9d',
  GITHUB_ACTOR: 'ai9d',
};

const UNKNOWN = {
  GIT_AUTHOR_NAME: ' ',
  GIT_AUTHOR_EMAIL: ' ',
  GIT_COMMITTER_NAME: ' ',
  GIT_COMMITTER_EMAIL: ' ',
  GH_USER: ' ',
  GITHUB_USER: ' ',
  GITHUB_ACTOR: ' ',
};

function fakeGhPath(login) {
  const dir = mkdtempSync(join(tmpdir(), 'fake-gh-'));
  writeFileSync(join(dir, 'gh'), login
    ? `#!/bin/sh\nif [ "$1" = api ] && [ "$2" = user ]; then printf '%s\\n' "${login}"; exit 0; fi\nexit 1\n`
    : '#!/bin/sh\nexit 1\n', { mode: 0o755 });
  chmodSync(join(dir, 'gh'), 0o755);
  return dir;
}

function actorEnv(login, extra = {}) {
  return {
    ...extra,
    PATH: `${fakeGhPath(login)}:${extra.PATH ?? process.env.PATH}`,
  };
}

const DENY = [
  'git commit -m "wip"',
  'git -C /tmp commit --amend --no-edit',
  'GIT_EDITOR=true git commit',
  'command git push origin HEAD',
  'git status && git push',
  'gh pr create --title x --body y',
  'gh -R qwts/playbook-engineering pr merge 1',
  'gh issue create --title x',
  'gh api graphql -f query=mutation',
  'gh api repos/qwts/x/pulls -X POST',
  'gh api repos/o/r/issues/1/comments -f body=x',
  'gh repo create example',
  'gh workflow run ci.yml',
  'gh run cancel 123',
  'sh -c "git push origin HEAD"',
  'bash -lc "gh pr create --title x --body y"',
  'echo hi & git push',
  'echo "$(git commit -m hidden)"',
  'echo `git push origin HEAD`',
];

const ALLOW = [
  'git status',
  'git diff',
  'git add README.md',
  'git log --grep=commit',
  'git commit-tree HEAD^{tree}',
  'gh pr view 122',
  'gh pr list',
  'gh issue view 1',
  'gh api user',
  'gh api repos/qwts/x --method GET',
  'gh api user -f foo=bar -X GET',
  'gh run list',
  'gh workflow list',
  'node --test tests/uninstalled-identity-hook.test.mjs',
  'printf "hello" > /tmp/notes.md',
  "echo '$(git commit -m hidden)'",
];

function coldEnv(home, extra = {}) {
  return {
    ...process.env,
    HOME: home,
    AGENT_BOT_HOOK_BIN: join(home, 'no-such-hook'),
    ...extra,
  };
}

function runGenerated(dialectKey, event, { payload = {}, env = {}, home } = {}) {
  const row = DIALECTS.find((candidate) => candidate.key === dialectKey);
  const config = JSON.parse(renderConfig(row));
  const mapped = vendorEvent(dialectKey, event);
  const entry = config.hooks[mapped.event].find((candidate) => (
    JSON.stringify(candidate).includes(`${dialectKey} --event ${event}`)
  ));
  const command = entry.command ?? entry.bash ?? entry.hooks?.[0]?.command;
  return spawnSync('sh', ['-c', command], {
    input: JSON.stringify(payload),
    encoding: 'utf8',
    env: coldEnv(home, env),
  });
}

test('publish commands are denied and reads or uncommitted edits are allowed', () => {
  for (const command of DENY) {
    assert.equal(isHumanAttributedPublish(command), true, `should deny: ${command}`);
  }
  for (const command of ALLOW) {
    assert.equal(isHumanAttributedPublish(command), false, `should allow: ${command}`);
  }
});

test('uninstalled allowlist parses comma-separated authors and defaults to deny-all', () => {
  assert.deepEqual(parseUnmanagedAuthors({}), []);
  assert.deepEqual(parseUnmanagedAuthors({ AGENT_BOT_UNMANAGED_AUTHORS: '' }), []);
  assert.deepEqual(parseUnmanagedAuthors({ AGENT_BOT_UNMANAGED_AUTHORS: 'ai9d' }), ['ai9d']);
  assert.deepEqual(parseUnmanagedAuthors({ AGENT_BOT_UNMANAGED_AUTHORS: 'ai9d, Other' }), ['ai9d', 'other']);
});

test('uninstalled allowlist permits matching ai9d and refuses everyone else', () => {
  const allowed = actorEnv('ai9d', { AGENT_BOT_UNMANAGED_AUTHORS: 'ai9d', ...AI9D });
  const human = actorEnv('qwts', { AGENT_BOT_UNMANAGED_AUTHORS: 'ai9d', ...HUMAN });
  const missing = actorEnv('', { AGENT_BOT_UNMANAGED_AUTHORS: 'ai9d', ...UNKNOWN });
  const empty = actorEnv('ai9d', { AGENT_BOT_UNMANAGED_AUTHORS: '', ...AI9D });
  const emailOnly = {
    AGENT_BOT_UNMANAGED_AUTHORS: 'ai9d',
    ...UNKNOWN,
    GIT_AUTHOR_EMAIL: 'ai9d@users.noreply.github.com',
  };

  assert.deepEqual(uninstalledDecision({ event: 'pre-commit', env: allowed }), {
    decision: 'allow',
    reason: '',
  });
  assert.deepEqual(uninstalledDecision({ event: 'pre-push', env: allowed }), {
    decision: 'allow',
    reason: '',
  });
  assert.deepEqual(uninstalledDecision({
    event: 'pre-command',
    command: 'git commit -m x',
    env: allowed,
  }), { decision: 'allow', reason: '' });
  assert.deepEqual(uninstalledDecision({
    event: 'pre-command',
    command: 'gh pr create --title x --body y',
    env: allowed,
  }), { decision: 'allow', reason: '' });
  assert.deepEqual(uninstalledDecision({
    event: 'pre-command',
    command: 'git commit -m x',
    env: emailOnly,
  }), { decision: 'allow', reason: '' });

  assert.equal(uninstalledDecision({ event: 'pre-commit', env: human }).decision, 'deny');
  assert.equal(uninstalledDecision({ event: 'pre-push', env: human }).decision, 'deny');
  assert.equal(uninstalledDecision({
    event: 'pre-command',
    command: 'git commit -m x',
    env: human,
  }).decision, 'deny');
  assert.equal(uninstalledDecision({
    event: 'pre-command',
    command: 'gh pr create --title x',
    env: human,
  }).decision, 'deny');
  assert.equal(uninstalledDecision({
    event: 'pre-command',
    command: 'git commit -m x && git push',
    env: actorEnv('qwts', { AGENT_BOT_UNMANAGED_AUTHORS: 'ai9d', ...AI9D }),
  }).decision, 'deny');
  assert.equal(uninstalledDecision({
    event: 'pre-command',
    command: 'git commit --amend --no-edit',
    env: allowed,
  }).decision, 'deny');
  assert.equal(uninstalledDecision({
    event: 'pre-command',
    command: 'git commit -C HEAD',
    env: allowed,
  }).decision, 'deny');
  assert.equal(uninstalledDecision({
    event: 'pre-command',
    command: 'git commit --amend --reset-author --no-edit',
    env: allowed,
  }).decision, 'allow');
  assert.equal(uninstalledDecision({
    event: 'pre-command',
    command: 'GIT_COMMITTER_NAME=ai9d GIT_COMMITTER_EMAIL=ai9d@users.noreply.github.com git commit -m x',
    env: human,
  }).decision, 'deny');
  assert.equal(uninstalledDecision({
    event: 'pre-push',
    env: actorEnv('qwts', { AGENT_BOT_UNMANAGED_AUTHORS: 'ai9d', GH_USER: 'ai9d', GITHUB_ACTOR: 'ai9d' }),
  }).decision, 'deny');
  assert.equal(uninstalledDecision({ event: 'pre-commit', env: missing }).decision, 'deny');
  assert.equal(uninstalledDecision({ event: 'pre-push', env: missing }).decision, 'deny');
  assert.equal(uninstalledDecision({
    event: 'pre-command',
    command: 'git commit -m x',
    env: empty,
  }).decision, 'deny');
  assert.equal(uninstalledDecision({
    event: 'pre-command',
    command: 'git commit --author="qwts <human@example.com>" -m x',
    env: allowed,
  }).decision, 'deny');
  assert.equal(uninstalledDecision({
    event: 'pre-command',
    command: 'GIT_AUTHOR_NAME=qwts GIT_AUTHOR_EMAIL=human@example.com git commit -m x',
    env: allowed,
  }).decision, 'deny');
  assert.equal(uninstalledDecision({
    event: 'pre-command',
    command: 'echo "$(git commit -m hidden)"',
    env: human,
  }).decision, 'deny');
  assert.equal(uninstalledDecision({
    event: 'pre-command',
    command: 'echo "$(git commit -m hidden)"',
    env: allowed,
  }).decision, 'allow');
  assert.equal(uninstalledDecision({
    event: 'pre-command',
    command: "echo '$(git commit -m hidden)'",
    env: human,
  }).decision, 'allow');
});

test('uninstalled decisions deny only commit, push, and pre-command publishes', () => {
  assert.deepEqual(uninstalledDecision({ event: 'pre-commit' }), {
    decision: 'deny',
    reason: UNINSTALLED_REASON,
  });
  assert.deepEqual(uninstalledDecision({ event: 'pre-push' }), {
    decision: 'deny',
    reason: UNINSTALLED_REASON,
  });
  assert.deepEqual(uninstalledDecision({ event: 'pre-command', command: 'git commit -m x' }), {
    decision: 'deny',
    reason: UNINSTALLED_REASON,
  });
  assert.deepEqual(uninstalledDecision({ event: 'pre-command', command: 'git status' }), {
    decision: 'allow',
    reason: '',
  });
  assert.deepEqual(uninstalledDecision({ event: 'pre-file-write', command: 'git commit -m x' }), {
    decision: 'allow',
    reason: '',
  });
  assert.deepEqual(uninstalledDecision({ event: 'session-start' }), {
    decision: 'allow',
    reason: '',
  });
});

test('generated adapters on a cold home deny publish and allow file edits, in every dialect', () => {
  const home = mkdtempSync(join(tmpdir(), 'uninstalled-hook-'));
  try {
    for (const row of DIALECTS.filter((candidate) => candidate.file)) {
      const deny = runGenerated(row.key, 'pre-command', {
        home,
        payload: { command: 'git commit -m incident' },
        env: actorEnv('qwts', HUMAN),
      });
      const expectedDeny = encodeDecision({
        dialectKey: row.key,
        event: 'pre-command',
        decision: 'deny',
        reason: UNINSTALLED_REASON,
      });
      assert.equal(deny.status, expectedDeny.exitCode, `${row.key} deny exit`);
      if (expectedDeny.stdout) {
        assert.equal(deny.stdout, expectedDeny.stdout, `${row.key} deny stdout`);
      }

      const allow = runGenerated(row.key, 'pre-command', {
        home,
        payload: { tool_input: { command: 'git status' } },
      });
      const expectedAllow = encodeDecision({
        dialectKey: row.key,
        event: 'pre-command',
        decision: 'allow',
      });
      assert.equal(allow.status, expectedAllow.exitCode, `${row.key} allow exit`);
      assert.equal(allow.stdout, expectedAllow.stdout, `${row.key} allow stdout`);
    }

    const cursorWrite = runGenerated('cursor', 'pre-file-write', {
      home,
      payload: { tool_input: { path: 'README.md' } },
    });
    assert.equal(cursorWrite.status, 0);
    assert.equal(cursorWrite.stdout, '{}');

    const gitCommit = spawnSync('sh', ['-c', adapterFallback('git', 'pre-commit')], {
      encoding: 'utf8',
      env: coldEnv(home, { AGENT_BOT_UNMANAGED_AUTHORS: '', ...HUMAN }),
    });
    assert.equal(gitCommit.status, 2);
    assert.match(gitCommit.stderr, /uninstalled identity/);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('generated adapters allow unmanaged publish only as ai9d', () => {
  const home = mkdtempSync(join(tmpdir(), 'uninstalled-ai9d-'));
  try {
    for (const row of DIALECTS.filter((candidate) => candidate.file)) {
      const allow = runGenerated(row.key, 'pre-command', {
        home,
        payload: { command: 'git commit -m ship' },
        env: actorEnv('ai9d', AI9D),
      });
      const expectedAllow = encodeDecision({
        dialectKey: row.key,
        event: 'pre-command',
        decision: 'allow',
      });
      assert.equal(allow.status, expectedAllow.exitCode, `${row.key} ai9d commit exit`);
      assert.equal(allow.stdout, expectedAllow.stdout, `${row.key} ai9d commit stdout`);

      const push = runGenerated(row.key, 'pre-command', {
        home,
        payload: { command: 'gh pr create --title x --body y' },
        env: actorEnv('ai9d', AI9D),
      });
      assert.equal(push.status, expectedAllow.exitCode, `${row.key} ai9d gh write exit`);

      const human = runGenerated(row.key, 'pre-command', {
        home,
        payload: { command: 'git commit -m ship' },
        env: actorEnv('qwts', HUMAN),
      });
      const expectedDeny = encodeDecision({
        dialectKey: row.key,
        event: 'pre-command',
        decision: 'deny',
        reason: UNINSTALLED_REASON,
      });
      assert.equal(human.status, expectedDeny.exitCode, `${row.key} human commit exit`);
    }
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('installed agent-hook still wins over uninstalled mode', () => {
  const home = mkdtempSync(join(tmpdir(), 'installed-hook-'));
  try {
    const hook = join(home, 'agent-hook');
    writeFileSync(hook, '#!/bin/sh\nprintf %s installed-ran\nexit 0\n', { mode: 0o755 });
    chmodSync(hook, 0o755);
    const result = runGenerated('cursor', 'pre-command', {
      home,
      payload: { command: 'git commit -m x' },
      env: { AGENT_BOT_HOOK_BIN: hook },
    });
    assert.equal(result.status, 0);
    assert.equal(result.stdout, 'installed-ran');
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('source pre-push denies an agent when the installed hook is missing', () => {
  const home = mkdtempSync(join(tmpdir(), 'uninstalled-pre-push-'));
  const repo = join(home, 'repo');
  mkdirSync(repo);
  execFileSync('git', ['init', '--quiet', '--initial-branch=main'], { cwd: repo });
  const hook = join(dirname(dirname(fileURLToPath(import.meta.url))), 'hooks', 'pre-push');
  const AMBIENT = [
    'CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT', 'AI_AGENT', 'GH_AGENT_APP',
    'CURSOR_AGENT', 'COPILOT_AGENT', 'DEVIN_AGENT', 'WINDSURF_AGENT',
  ];
  const stripped = Object.fromEntries(
    Object.entries(coldEnv(home)).filter(
      ([key]) => !key.startsWith('CODEX_') && !AMBIENT.includes(key),
    ),
  );
  try {
    const agent = spawnSync(hook, ['origin', 'https://github.com/example/repo.git'], {
      cwd: repo,
      input: '',
      encoding: 'utf8',
      env: { ...stripped, CURSOR_AGENT: '1', ...actorEnv('') },
    });
    assert.equal(agent.status, 2);
    assert.match(agent.stderr, /uninstalled identity/);

    const unmanaged = spawnSync(hook, ['origin', 'https://github.com/example/repo.git'], {
      cwd: repo,
      input: '',
      encoding: 'utf8',
      env: { ...stripped, CURSOR_AGENT: '1', ...actorEnv('ai9d') },
    });
    assert.equal(unmanaged.status, 0, unmanaged.stderr);

    const spoofed = spawnSync(hook, ['origin', 'https://github.com/example/repo.git'], {
      cwd: repo,
      input: '',
      encoding: 'utf8',
      env: { ...stripped, CURSOR_AGENT: '1', GH_USER: 'ai9d', ...actorEnv('qwts') },
    });
    assert.equal(spoofed.status, 2);

    const humanActor = spawnSync(hook, ['origin', 'https://github.com/example/repo.git'], {
      cwd: repo,
      input: '',
      encoding: 'utf8',
      env: { ...stripped, CURSOR_AGENT: '1', ...actorEnv('qwts') },
    });
    assert.equal(humanActor.status, 2);

    const human = spawnSync(hook, ['origin', 'https://github.com/example/repo.git'], {
      cwd: repo,
      input: '',
      encoding: 'utf8',
      env: stripped,
    });
    assert.equal(human.status, 0, human.stderr);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('Cursor allow fallback prints {} so failClosed does not treat silence as deny', () => {
  for (const event of CANONICAL_EVENTS.filter((name) => name !== 'pre-command' && name !== 'pre-commit' && name !== 'pre-push')) {
    const fallback = adapterFallback('cursor', event);
    assert.match(fallback, /printf '%s' '\{\}'/);
  }
});
