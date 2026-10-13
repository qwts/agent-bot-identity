import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync, spawnSync } from 'node:child_process';


import { CANONICAL_EVENTS, DIALECTS, encodeDecision, vendorEvent } from '../hook-dialects.mjs';
import { renderConfig } from '../sync-hooks.mjs';
import { unmanagedAuthorsSnapshot } from '../config.mjs';
import {
  UNINSTALLED_OPAQUE_REASON,
  UNINSTALLED_REASON,
  adapterFallback,
  decideUninstalledHook,
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

// Not publishes. Opaque executors among them (`node --test ...`) are refused
// separately in uninstalled mode; see OPAQUE below (#1064).
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

function runGenerated(dialectKey, event, { payload = {}, env = {}, home, snapshot } = {}) {
  const row = DIALECTS.find((candidate) => candidate.key === dialectKey);
  const config = JSON.parse(renderConfig(row, '{}', snapshot));
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
  // Single quotes make the substitution a literal string, so it is not a
  // publish; but a `$` in the command still fails the structural allowlist,
  // which is the safe answer in fail-closed mode (#1064).
  assert.equal(uninstalledDecision({
    event: 'pre-command',
    command: "echo '$(git commit -m hidden)'",
    env: human,
  }).decision, 'deny');
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
  assert.deepEqual(uninstalledDecision({ event: 'pre-command', command: 'ls' }), {
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
        payload: { tool_input: { command: 'ls' } },
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

test('generated adapters allow unmanaged publish only for an explicitly listed author (#675)', () => {
  const home = mkdtempSync(join(tmpdir(), 'uninstalled-ai9d-'));
  const listed = { ...AI9D, AGENT_BOT_UNMANAGED_AUTHORS: 'ai9d' };
  try {
    for (const row of DIALECTS.filter((candidate) => candidate.file)) {
      const allow = runGenerated(row.key, 'pre-command', {
        home,
        payload: { command: 'git commit -m ship' },
        env: actorEnv('ai9d', listed),
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
        env: actorEnv('ai9d', listed),
      });
      assert.equal(push.status, expectedAllow.exitCode, `${row.key} ai9d gh write exit`);

      const human = runGenerated(row.key, 'pre-command', {
        home,
        payload: { command: 'git commit -m ship' },
        env: actorEnv('qwts', { ...HUMAN, AGENT_BOT_UNMANAGED_AUTHORS: 'ai9d' }),
      });
      const expectedDeny = encodeDecision({
        dialectKey: row.key,
        event: 'pre-command',
        decision: 'deny',
        reason: UNINSTALLED_REASON,
      });
      assert.equal(human.status, expectedDeny.exitCode, `${row.key} human commit exit`);

      // Nothing selected: the wrapper supplies no default, so ai9d is refused too.
      const unlisted = runGenerated(row.key, 'pre-command', {
        home,
        payload: { command: 'git commit -m ship' },
        env: actorEnv('ai9d', { ...AI9D, AGENT_BOT_UNMANAGED_AUTHORS: undefined }),
      });
      assert.equal(unlisted.status, expectedDeny.exitCode, `${row.key} unlisted ai9d commit exit`);
      assert.equal(unlisted.stdout, expectedDeny.stdout, `${row.key} unlisted ai9d commit stdout`);
    }
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

// Uninstalled pre-command fails CLOSED by structure (#1064): anything that is
// not a bare, simple, read-only command is denied. These are the security
// reviewer's bypass probes against a denylist — wrapper flags, grouping and
// control flow, escapes, aliases, `$VAR`, functions, `git -c`, PATH-relative
// names, other interpreters — plus the plain opaque commands. Every one denies.
const DENY_OPAQUE = [
  // plain interpreters and task runners
  'node x.js', 'node build.mjs', 'npm test', 'npx some-tool', 'make release',
  'pytest', 'python3.12 x.py', 'python3 publish.py', 'node2 x.js', 'node ./other.mjs',
  // wrapper binaries and flags
  'env node x.js', 'env -S "node x.js"', 'env -S node x.js', "env -S'node x.js'",
  'env -Snode x.js', 'env -iS node x.js', 'env -u FOO node x.js', 'env -- node x.js',
  'command node x.js', 'exec node x.js', 'nohup node x.js', 'time node x.js',
  'builtin command node x.js', 'command -p node x.js', 'exec -a foo node x.js',
  'command -p git push', 'exec -a x git push', 'env -- git push', 'env -S "git push"',
  'caffeinate node x.js', 'arch -arm64 node x.js', 'sandbox-exec -p x node x.js',
  'script -q /dev/null node x.js', 'launchctl submit -l x -- node x.js', 'ssh localhost ls',
  'nice node x.js', 'timeout 5 node x.js', 'xargs -n1 git push < remotes', 'stdbuf -o0 node x.js',
  // shells, here-strings, scripts, pipes
  'bash -c "node x.js"', "bash -c 'echo hi; node x.js'", "bash -lc 'node x.js'",
  'bash -c -- \'node x.js\'', "bash -o errexit -c 'node x.js'", 'bash -c -- \'git push\'',
  'bash <<< "node x.js"', 'bash <<<"git status"', 'sh -s <<< "node x.js"', 'bash < script.sh',
  'cat s.sh | bash', 'echo node x.js | sh', 'bash script.sh', 'sh ./s.sh', 'bash', 'sh -c "git status"',
  // grouping and control flow
  '{ node x.js; }', '(node x.js)', '(git push)', '{ git push; }',
  'if true; then node x.js; fi', 'if true; then git push; fi', 'for i in 1; do node x.js; done',
  // escapes, quotes-in-command-word, aliases, functions, variables
  '\\node x.js', '\\git push', 'n\\ode x.js', '"no"de x.js', "n''ode x.js",
  'alias n=node; n x.js', 'n x.js', 'NODE=node; $NODE x.js', 'PATH=.:$PATH a',
  'hash -p ./evil git; git status', 'function git { node x.js; }; git status', 'git(){ node x.js; }; git status',
  'trap "node x.js" EXIT', 'coproc node x.js', 'chmod +x a && a',
  // git config / alias / -c injection, and non-read-only git
  'git -c core.hooksPath=/dev/null commit -m x', 'git -c alias.p=!node\\ x.js p',
  'git -c core.sshCommand=./evil fetch', 'git config alias.x "!node x.js"', 'git x',
  'git -c core.editor=./e commit', 'git -c core.fsmonitor=./evil status', 'git -c diff.external=./evil diff',
  'git -c alias.p=!git\\ push p', "git -c alias.p='!git push' p", "git -c core.fsmonitor='git push' status",
  'git push', 'git commit -m x', 'git config alias.x y',
  // gh is never read-only enough to allow here
  'gh alias set x --shell "node x.js"', 'gh x', 'gh extension exec foo', 'gh pr view 122',
  // other interpreters a denylist forgets
  'swift x.swift', 'java -jar x.jar', 'awk \'BEGIN{system("echo hi")}\'', 'tclsh x',
  'Rscript x.R', "vim -c '!ls'", 'open x.command', 'at now <<< "ls"', 'osascript -e x',
  // explicit paths, redirects, substitutions
  './scripts/release.sh', '/usr/local/bin/release', 'printf "hello" > /tmp/notes.md',
  'echo "$(node build.mjs)"', 'source ./env.sh', '. ./env.sh', 'eval "$CMD"',
  'find . -name x -exec sh {} ;', 'find . -delete', 'find . -rm', 'find . -name x -rm',
  // globs expand after this check: with a file named `-exec` in the directory
  // these become `-exec` (re-review, #1064); quoted `';'` must not help either
  "find . -exe? sh -c 'touch PWNED' ';'", "find . [-]exec sh -c 'touch PWNED' ';'",
  "find . -exec* sh -c 'touch PWNED' ';'", "find . -exe? sh -c 'touch PWNED' {} +",
  'find . -de*', "find . -e'xec' sh -c 'touch PWNED' {} +", 'find . -e"xec" sh -c x {} +',
  "find . '-exec' sh -c 'touch PWNED' {} +", 'ls *', 'cat ?', 'ls [a]', 'grep x *',
  // diff -l / --paginate run `pr` from PATH; file -C / --compile writes
  'diff -l a b', 'diff --paginate a b', 'diff --pag a b', 'diff -rl a b', 'diff -lr a b',
  'diff -r -l a b', "diff '-l' a b", 'file -C', 'file -C -m ./magic', 'file --compile -m ./magic',
  'file --comp -m m', 'file -bC x', "file '-C' -m m",
  // the node-based bootstrap forms are gone: node is an interpreter
  'node bootstrap.mjs --x y', 'node bootstrap.mjs --require ./evil.js', 'node bootstrap.mjs --import=./evil.mjs',
  'NODE_OPTIONS=--require=./e.js node bootstrap.mjs', 'node bootstrap.mjs --eval x',
  'node bootstrap.mjs --profile /tmp/organization-profile.json --machine-only',
  // the source bootstrap launcher is content the agent can rewrite: refused
  './agent-bot bootstrap', './agent-bot bootstrap --x y', './agent-bot bootstrap --repair --machine-only',
  './agent-bot bootstrap; node x.mjs', './agent-bot bootstrap --profile $(node x.mjs)',
  './agent-bot doctor',
  // re-review (#1064): git and rg run code or write on their own, and
  // .git/config is agent-writable, so no git subcommand is read-only here
  "git grep -O'touch /tmp/pwned' x", "git grep --open-files-in-pager='touch /tmp/pwned' x",
  'git log --format=x --output=.git/config', 'git log --output=agent-bot', 'git diff --output=agent-bot',
  'git status', 'git log --oneline', 'git diff', 'git show HEAD', 'git rev-parse HEAD',
  'git diff --ext-diff', 'git log -p --textconv', 'git show --textconv HEAD',
  'git tag -s v1', 'git tag -a v1 -m x', 'git branch -f main HEAD', 'git branch --edit-description',
  'git remote add x https://example.invalid/x', 'git remote update', 'git symbolic-ref HEAD refs/heads/x',
  'git reflog expire --all', 'git branch', 'git tag',
  'rg --pre=sh x', 'rg --pre sh x', 'rg pattern', 'rg -z x',
  // grep takes short options only
  'grep --pre=sh x .', 'grep --include=x y .', 'egrep --color=always x f',
];

// Bare read-only commands the allowlist permits.
const ALLOW_SAFE = [
  'ls', 'ls -la', 'cat README.md', 'head -n 5 f', 'tail f', 'wc -l f', 'diff a b',
  'echo hi', 'pwd', 'which git', 'grep -rn node .', 'grep -i x f', 'egrep -v x f',
  'diff -r a b', 'diff -u a b', 'diff --to-file=a b', 'file -b f', 'file -m ./magic f',
  'find . -name x', 'find . -type f -newer f', "find . -name '*.js'", "grep 'a*b' f", 'ls "[x]"', 'stat f', 'file f',
];

test('uninstalled pre-command denies every denylist-bypass probe and allows bare read-only commands (#1064)', () => {
  for (const command of DENY_OPAQUE) {
    const d = uninstalledDecision({ event: 'pre-command', command, env: {}, authors: [] });
    assert.equal(d.decision, 'deny', `should deny: ${command}`);
  }
  for (const command of ALLOW_SAFE) {
    assert.deepEqual(uninstalledDecision({ event: 'pre-command', command, env: {}, authors: [] }),
      { decision: 'allow', reason: '' }, `should allow: ${command}`);
  }
  // Other events are not commands.
  assert.equal(uninstalledDecision({ event: 'pre-file-write', command: 'npm test', env: {}, authors: [] }).decision, 'allow');
});

test('the source bootstrap launcher is refused in uninstalled mode, genuine or modified, unless an unmanaged author runs it (#1064)', () => {
  // A launcher in the checkout is content the agent can rewrite (`git log
  // --output=agent-bot` did exactly that), so the hook does not exempt it.
  const root = mkdtempSync(join(tmpdir(), 'uninstalled-boot-'));
  try {
    writeFileSync(join(root, 'agent-bot'), '#!/bin/sh\nexec node bootstrap.mjs "$@"\n');
    chmodSync(join(root, 'agent-bot'), 0o755);
    const run = (command, env = {}, authors = []) => uninstalledDecision({ event: 'pre-command', command, env, authors }).decision;
    assert.equal(run('./agent-bot bootstrap'), 'deny', 'a genuine-looking launcher');
    writeFileSync(join(root, 'agent-bot'), '#!/bin/sh\ntouch /tmp/pwned\n');
    assert.equal(run('./agent-bot bootstrap'), 'deny', 'a modified launcher');
    assert.equal(run('./agent-bot bootstrap --machine-only'), 'deny');
    // An unmanaged author (both identities listed) may run it.
    assert.equal(run('./agent-bot bootstrap', actorEnv('ai9d', AI9D), ['ai9d']), 'allow');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('an unmanaged author runs anything, including the builds a repo needs; the human does not (#1064)', () => {
  // Both the git author and the gh actor must be listed.
  const both = uninstalledDecision({ event: 'pre-command', command: 'npm test', env: actorEnv('ai9d', AI9D), authors: ['ai9d'] });
  assert.deepEqual(both, { decision: 'allow', reason: '' });
  for (const command of ['node build.mjs', 'make', './scripts/x.sh', 'bash -c "npm run build"']) {
    assert.equal(uninstalledDecision({ event: 'pre-command', command, env: actorEnv('ai9d', AI9D), authors: ['ai9d'] }).decision, 'allow', command);
  }
  const humanGh = uninstalledDecision({ event: 'pre-command', command: 'npm test', env: actorEnv('qwts', AI9D), authors: ['ai9d'] });
  assert.deepEqual(humanGh, { decision: 'deny', reason: UNINSTALLED_OPAQUE_REASON });
  const humanGit = uninstalledDecision({ event: 'pre-command', command: 'npm test', env: actorEnv('ai9d', HUMAN), authors: ['ai9d'] });
  assert.deepEqual(humanGit, { decision: 'deny', reason: UNINSTALLED_OPAQUE_REASON });
});

test('generated adapters on a cold home deny opaque execution, git and the launcher, and allow ls, in every dialect (#1064)', () => {
  const home = mkdtempSync(join(tmpdir(), 'uninstalled-opaque-'));
  try {
    for (const row of DIALECTS.filter((candidate) => candidate.file)) {
      const run = runGenerated(row.key, 'pre-command', {
        home,
        payload: { command: 'node build.mjs' },
        env: actorEnv('qwts', { ...HUMAN, AGENT_BOT_UNMANAGED_AUTHORS: '' }),
      });
      const expected = encodeDecision({ dialectKey: row.key, event: 'pre-command', decision: 'deny', reason: UNINSTALLED_OPAQUE_REASON });
      assert.equal(run.status, expected.exitCode, `${row.key} opaque exit`);
      if (expected.stdout) assert.equal(run.stdout, expected.stdout, `${row.key} opaque stdout`);

      for (const command of ['./agent-bot bootstrap --machine-only', 'git status', 'rg --pre=sh x']) {
        const refused = runGenerated(row.key, 'pre-command', {
          home,
          payload: { command },
          env: actorEnv('qwts', { ...HUMAN, AGENT_BOT_UNMANAGED_AUTHORS: '' }),
        });
        assert.equal(refused.status, expected.exitCode, `${row.key} ${command} exit`);
        if (expected.stdout) assert.equal(refused.stdout, expected.stdout, `${row.key} ${command} stdout`);
      }

      const ls = runGenerated(row.key, 'pre-command', {
        home,
        payload: { command: 'ls' },
        env: actorEnv('qwts', { ...HUMAN, AGENT_BOT_UNMANAGED_AUTHORS: '' }),
      });
      const allow = encodeDecision({ dialectKey: row.key, event: 'pre-command', decision: 'allow' });
      assert.equal(ls.status, allow.exitCode, `${row.key} ls exit`);
      assert.equal(ls.stdout, allow.stdout, `${row.key} ls stdout`);
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

// The generated fallback grants what the shared resolver granted for the
// config bytes sync-hooks snapshotted (#675): the env when set (even empty),
// else that snapshot while the file is unchanged; anything else refuses.
test('generated adapters apply the snapshotted allowlist with env precedence and fail closed (#675)', () => {
  const home = mkdtempSync(join(tmpdir(), 'uninstalled-config-'));
  const write = (name, body) => { const file = join(home, name); writeFileSync(file, typeof body === 'string' ? body : JSON.stringify(body)); return file; };
  const listedConfig = { settings: { unmanagedAuthors: ['ai9d'] } };
  const listed = write('listed.json', listedConfig);
  const edited = write('edited.json', listedConfig);
  const files = {
    listed,
    edited,
    upper: write('upper.json', { settings: { unmanagedAuthors: ['AI9D'] } }),
    broken: write('broken.json', '{ "settings": '),
    'non-object settings': write('settings.json', { settings: ['ai9d'] }),
    'invalid feature': write('feature.json', { ...listedConfig, features: { 'github-identity': 'false' } }),
    'invalid daemonPreference': write('daemon.json', { settings: { ...listedConfig.settings, daemonPreference: 'invalid' } }),
    'invalid profile': write('profile.json', { ...listedConfig, profile: 'not-a-profile' }),
    absent: join(home, 'absent.json'),
  };
  const snapshots = Object.fromEntries(Object.entries(files).map(([name, file]) => [name, unmanagedAuthorsSnapshot({ env: { AGENT_BOT_CONFIG: file } })]));
  writeFileSync(edited, JSON.stringify({ ...listedConfig, owner: 'someone' })); // valid, but not the snapshotted bytes
  const cases = [
    ['config-only', 'listed', {}, 'allow'],
    ['empty env overrides config', 'listed', { AGENT_BOT_UNMANAGED_AUTHORS: '' }, 'deny'],
    ['other env overrides config', 'listed', { AGENT_BOT_UNMANAGED_AUTHORS: 'zed' }, 'deny'],
    ['env grants over a refused config', 'invalid feature', { AGENT_BOT_UNMANAGED_AUTHORS: 'ai9d' }, 'allow'],
    ['config edited after sync', 'edited', {}, 'deny'],
    ...['upper', 'broken', 'non-object settings', 'invalid feature', 'invalid daemonPreference', 'invalid profile', 'absent']
      .map((name) => [name, name, {}, 'deny']),
  ];
  try {
    for (const row of DIALECTS.filter((candidate) => candidate.file)) {
      for (const [label, name, policy, decision] of cases) {
        const env = actorEnv('ai9d', { ...AI9D, AGENT_BOT_UNMANAGED_AUTHORS: undefined, AGENT_BOT_CONFIG: files[name], ...policy });
        const expected = encodeDecision({ dialectKey: row.key, event: 'pre-command', decision, ...(decision === 'deny' ? { reason: UNINSTALLED_REASON } : {}) });
        const run = runGenerated(row.key, 'pre-command', { home, payload: { command: 'git commit -m ship' }, env, snapshot: snapshots[name] });
        assert.equal(run.status, expected.exitCode, `${row.key} ${label} exit`);
        assert.equal(run.stdout, expected.stdout, `${row.key} ${label} stdout`);
        // The in-process decision resolves through config.mjs directly.
        const inProcess = decideUninstalledHook({ dialectKey: row.key, event: 'pre-command', payload: { command: 'git commit -m ship' }, env: { ...coldEnv(home, env) } });
        assert.equal(inProcess.exitCode, label === 'config edited after sync' ? encodeDecision({ dialectKey: row.key, event: 'pre-command', decision: 'allow' }).exitCode : expected.exitCode, `${row.key} ${label} in-process exit`);
      }
      const human = runGenerated(row.key, 'pre-command', {
        home,
        payload: { command: 'git commit -m ship' },
        env: actorEnv('qwts', { ...HUMAN, AGENT_BOT_UNMANAGED_AUTHORS: undefined, AGENT_BOT_CONFIG: listed }),
        snapshot: snapshots.listed,
      });
      const deny = encodeDecision({ dialectKey: row.key, event: 'pre-command', decision: 'deny', reason: UNINSTALLED_REASON });
      assert.equal(human.status, deny.exitCode, `${row.key} config-listed policy still refuses a human`);
      assert.equal(human.stdout, deny.stdout, `${row.key} config-listed policy still refuses a human (stdout)`);
    }
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

// The in-process decision reads the supplied env's config, never the host's
// (#675 review): a differing process HOME must not lend its allowlist.
test('in-process decisions locate config from the supplied env, not the process home', () => {
  const host = mkdtempSync(join(tmpdir(), 'uninstalled-host-'));
  const other = mkdtempSync(join(tmpdir(), 'uninstalled-other-'));
  const saved = process.env.HOME;
  try {
    mkdirSync(join(host, '.config', 'agent-bot'), { recursive: true });
    writeFileSync(join(host, '.config', 'agent-bot', 'config.json'), JSON.stringify({ settings: { unmanagedAuthors: ['ai9d'] } }));
    process.env.HOME = host;
    const decide = (env) => decideUninstalledHook({ dialectKey: 'claude', event: 'pre-command', payload: { command: 'git commit -m ship' }, env: actorEnv('ai9d', { ...AI9D, ...env }) });
    const deny = encodeDecision({ dialectKey: 'claude', event: 'pre-command', decision: 'deny', reason: UNINSTALLED_REASON });
    const allow = encodeDecision({ dialectKey: 'claude', event: 'pre-command', decision: 'allow' });
    assert.deepEqual(decide({ HOME: other }), deny, 'another HOME without config grants nothing');
    assert.deepEqual(decide({}), deny, 'no HOME and no AGENT_BOT_CONFIG grants nothing');
    assert.deepEqual(decide({ HOME: host }), allow, 'the supplied HOME config still grants');
  } finally {
    if (saved === undefined) delete process.env.HOME; else process.env.HOME = saved;
    rmSync(host, { recursive: true, force: true });
    rmSync(other, { recursive: true, force: true });
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
    'MUSE_AGENT', 'AGENT_BOT_ACCOUNT',
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

    // ENG-0339: an agent account is agent context with no env marker at all.
    const accountOnly = spawnSync(hook, ['origin', 'https://github.com/example/repo.git'], {
      cwd: repo,
      input: '',
      encoding: 'utf8',
      env: { ...stripped, AGENT_BOT_ACCOUNT: 'you-goose-agent', ...actorEnv('') },
    });
    assert.equal(accountOnly.status, 2);
    assert.match(accountOnly.stderr, /uninstalled identity/);

    // Nothing selected refuses ai9d like anyone else (#675); the env or the
    // config (an organization profile projects into it) selects it.
    const pushAs = (extra) => spawnSync(hook, ['origin', 'https://github.com/example/repo.git'], {
      cwd: repo,
      input: '',
      encoding: 'utf8',
      env: { ...stripped, AGENT_BOT_UNMANAGED_AUTHORS: undefined, AGENT_BOT_CONFIG: join(home, 'no-config.json'), CURSOR_AGENT: '1', ...actorEnv('ai9d'), ...extra },
    });
    const unselected = pushAs({});
    assert.equal(unselected.status, 2);
    assert.match(unselected.stderr, /uninstalled identity/);
    assert.equal(pushAs({ AGENT_BOT_UNMANAGED_AUTHORS: 'ai9d' }).status, 0);
    const config = join(home, 'config.json');
    writeFileSync(config, JSON.stringify({ settings: { unmanagedAuthors: ['ai9d'] } }));
    const unmanaged = pushAs({ AGENT_BOT_CONFIG: config });
    assert.equal(unmanaged.status, 0, unmanaged.stderr);

    const spoofed = spawnSync(hook, ['origin', 'https://github.com/example/repo.git'], {
      cwd: repo,
      input: '',
      encoding: 'utf8',
      env: { ...stripped, CURSOR_AGENT: '1', AGENT_BOT_UNMANAGED_AUTHORS: 'ai9d', GH_USER: 'ai9d', ...actorEnv('qwts') },
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
