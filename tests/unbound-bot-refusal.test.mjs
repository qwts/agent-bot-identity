// No human fallback (#749, carried requirement 6 of #104). A session that
// stated a bot identity but whose worktree setup failed must not commit or
// push as the human; the delegate (ENG-0339, ENG-0375: agent context that
// stated nothing) and an ordinary human shell are unaffected.

import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { DIALECTS, encodeDecision, vendorEvent } from '../hook-dialects.mjs';
import { runHooks } from '../agent-hook.mjs';
import { renderConfig } from '../sync-hooks.mjs';
import { unboundBotSlug } from '../resolve-agent.mjs';
import { scanGitPublish } from '../git-publish-scan.mjs';
import { hermeticGitEnv } from './helpers/hermetic-git.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const SLUG = 'example-claude-agent';
const root = mkdtempSync(join(tmpdir(), 'unbound-bot-'));
after(() => rmSync(root, { recursive: true, force: true }));

// Everything that could state an identity or bind a session, stripped so a
// suite run inside a bound harness session cannot leak its own.
const AMBIENT = new Set([
  'CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT', 'AI_AGENT', 'GH_AGENT_APP',
  'CURSOR_AGENT', 'COPILOT_AGENT', 'DEVIN_AGENT', 'WINDSURF_AGENT',
  'MUSE_AGENT', 'AGENT_BOT_ACCOUNT', 'AGENT_BOT_ID', 'QWTS_AGENT_ID',
  'AGENT_BOT_BINDING', 'AGENT_BOT_PARENT_ID', 'QWTS_AGENT_PARENT_ID',
  'AGENT_BOT_STATE_HOME', 'AGENT_BOT_HOOKS_DIR', 'AGENT_BOT_HOOK_BIN',
  'AGENT_BOT_CONFIG', 'AGENT_BOT_UNMANAGED_AUTHORS',
]);

const home = join(root, 'home');
mkdirSync(home);
const config = join(root, 'config.json');
writeFileSync(config, JSON.stringify({ features: { 'github-identity': true }, apps: { claude: SLUG } }));
const gateOff = join(root, 'gate-off.json');
writeFileSync(gateOff, JSON.stringify({ features: { 'github-identity': false } }));
const globalConfig = join(root, 'gitconfig');
writeFileSync(globalConfig, `[core]\n\thooksPath = ${join(ROOT, 'hooks')}\n[commit]\n\tgpgsign = false\n[init]\n\tdefaultBranch = main\n`);

// `agent-bot` as the session-start hooks reach it: setup-worktree refuses
// the primary checkout, every other subcommand is a silent no-op.
const bin = join(root, 'bin');
mkdirSync(bin);
writeFileSync(join(bin, 'agent-bot'), '#!/bin/sh\nif [ "$1" = setup-worktree ]; then echo "agent-bot: refusing primary checkout" >&2; exit 1; fi\nexit 0\n');
chmodSync(join(bin, 'agent-bot'), 0o755);

// The installed runner: the real agent-hook.mjs over this repo's agent-hooks/.
const hookBin = join(root, 'agent-hook');
writeFileSync(hookBin, `#!/bin/sh\nAGENT_BOT_HOOKS_DIR='${join(ROOT, 'agent-hooks')}' exec node '${join(ROOT, 'agent-hook.mjs')}' "$@"\n`);
chmodSync(hookBin, 0o755);

function baseEnv(extra = {}) {
  const stripped = Object.fromEntries(Object.entries(process.env).filter(
    ([key]) => !key.startsWith('CODEX_') && !AMBIENT.has(key),
  ));
  return hermeticGitEnv(stripped, {
    HOME: home,
    PATH: `${bin}:${process.env.PATH}`,
    GIT_CONFIG_GLOBAL: globalConfig,
    AGENT_BOT_CONFIG: config,
    AGENT_BOT_HOOK_BIN: hookBin,
    AGENT_BOT_STATE_HOME: join(root, 'state'),
    ...extra,
  });
}

// The investigation's session: Claude Code told to be the bot.
const STATED = { CLAUDECODE: '1', GH_AGENT_APP: SLUG, AGENT_BOT_ACCOUNT: SLUG };
// The delegate: the same harness in the owner's account, stating nothing.
const DELEGATE = { CLAUDECODE: '1', AGENT_BOT_ACCOUNT: 'owner' };

let repoCount = 0;
function primaryCheckout(name = 'Owner Human') {
  const repo = join(root, `repo-${repoCount += 1}`);
  mkdirSync(repo);
  const env = baseEnv();
  const git = (...args) => execFileSync('git', args, { cwd: repo, env, encoding: 'utf8' }).trim();
  git('init', '--quiet');
  git('config', 'user.name', name);
  git('config', 'user.email', 'owner@example.com');
  writeFileSync(join(repo, 'README.md'), '# primary\n');
  git('add', 'README.md');
  git('-c', 'core.hooksPath=/dev/null', 'commit', '--quiet', '-m', 'initial');
  const remote = join(root, `remote-${repoCount}.git`);
  execFileSync('git', ['init', '--quiet', '--bare', remote], { env });
  git('remote', 'add', 'origin', remote);
  return { repo, git, remote };
}

function adapterCommand(dialectKey, event) {
  const row = DIALECTS.find((candidate) => candidate.key === dialectKey);
  const rendered = JSON.parse(renderConfig(row));
  const entry = rendered.hooks[vendorEvent(dialectKey, event).event].find((candidate) => (
    JSON.stringify(candidate).includes(`${dialectKey} --event ${event}`)
  ));
  return entry.command ?? entry.bash ?? entry.hooks?.[0]?.command;
}

function runAdapter(dialectKey, event, { cwd, env, payload }) {
  return spawnSync('sh', ['-c', adapterCommand(dialectKey, event)], {
    cwd, env, input: JSON.stringify(payload), encoding: 'utf8',
  });
}

function denied(dialectKey, run) {
  const deny = encodeDecision({ dialectKey, event: 'pre-command', decision: 'deny', reason: 'x' });
  assert.equal(run.status, deny.exitCode, `${dialectKey}: ${run.stderr}`);
  if (deny.stdout) {
    const out = JSON.parse(run.stdout);
    assert.equal(out.hookSpecificOutput?.permissionDecision ?? out.permissionDecision ?? out.permission, 'deny');
  }
  assert.match(`${run.stdout}\n${run.stderr}`, new RegExp(`stated bot identity ${SLUG}`));
}

function allowed(dialectKey, run) {
  const allow = encodeDecision({ dialectKey, event: 'pre-command', decision: 'allow' });
  assert.equal(run.status, 0, `${dialectKey}: ${run.stderr}`);
  assert.equal(run.stdout, allow.stdout, `${dialectKey}: allow shape`);
}

test('end to end: a stated bot whose setup failed in a primary checkout cannot commit or push as the human', () => {
  const { repo, git, remote } = primaryCheckout();
  const env = baseEnv(STATED);
  const head = git('rev-parse', 'HEAD');
  const before = git('config', '--local', '--list');

  // Session start runs the real adapter; setup-worktree is refused.
  const start = runAdapter('claude', 'session-start', {
    cwd: repo, env, payload: { session_id: 's1', cwd: repo, hook_event_name: 'SessionStart' },
  });
  assert.equal(start.status, 0, start.stderr);
  assert.match(start.stderr, /10-ensure-identity: .*refusing primary checkout/, 'setup-worktree ran and was refused');

  // The pre-command adapter refuses the commit and the push before they run.
  for (const command of ['git commit -m x', 'git push origin HEAD']) {
    denied('claude', runAdapter('claude', 'pre-command', {
      cwd: repo, env,
      payload: { session_id: 's1', cwd: repo, tool_name: 'Bash', tool_input: { command } },
    }));
  }

  // The git hooks refuse them too, for a command the harness never saw.
  writeFileSync(join(repo, 'work.txt'), 'agent work\n');
  git('add', 'work.txt');
  const commit = spawnSync('git', ['commit', '-m', 'x'], { cwd: repo, env, encoding: 'utf8' });
  assert.notEqual(commit.status, 0, 'the commit must be refused');
  assert.match(commit.stderr, new RegExp(`stated bot identity ${SLUG}.*\\n.*commit would be attributed to the human`));
  const push = spawnSync('git', ['push', 'origin', 'HEAD:main'], { cwd: repo, env, encoding: 'utf8' });
  assert.notEqual(push.status, 0, 'the push must be refused');
  assert.match(push.stderr, /push would be attributed to the human/);

  // Nothing was written: no commit, no identity configuration, no push.
  assert.equal(git('rev-parse', 'HEAD'), head);
  assert.equal(git('config', '--local', '--list'), before);
  assert.equal(spawnSync('git', ['rev-parse', '--verify', '--quiet', 'refs/heads/main'], { cwd: remote, env }).status, 1);
});

test('end to end: the delegate and an ordinary human shell still commit and push as the human', () => {
  for (const [name, extra] of [['delegate', DELEGATE], ['human', {}]]) {
    const { repo, git, remote } = primaryCheckout();
    const env = baseEnv(extra);
    allowed('claude', runAdapter('claude', 'pre-command', {
      cwd: repo, env,
      payload: { session_id: 's2', cwd: repo, tool_name: 'Bash', tool_input: { command: 'git commit -m x' } },
    }));
    writeFileSync(join(repo, 'work.txt'), `${name}\n`);
    git('add', 'work.txt');
    const commit = spawnSync('git', ['commit', '--quiet', '-m', name], { cwd: repo, env, encoding: 'utf8' });
    assert.equal(commit.status, 0, `${name}: ${commit.stderr}`);
    assert.equal(git('log', '-1', '--format=%an'), 'Owner Human');
    const push = spawnSync('git', ['push', '--quiet', 'origin', 'HEAD:main'], { cwd: repo, env, encoding: 'utf8' });
    assert.equal(push.status, 0, `${name}: ${push.stderr}`);
    assert.equal(
      execFileSync('git', ['rev-parse', 'main'], { cwd: remote, env, encoding: 'utf8' }).trim(),
      git('rev-parse', 'HEAD'),
    );
  }
});

test('every generated pre-command dialect refuses the stated unbound bot and allows the delegate and the human', () => {
  const { repo } = primaryCheckout();
  const dialects = DIALECTS.filter((row) => row.key !== 'git' && vendorEvent(row.key, 'pre-command'));
  assert.ok(dialects.length >= 5);
  for (const { key } of dialects) {
    const payload = {
      session_id: 's3', conversation_id: 's3', cwd: repo, workspace_root: repo,
      tool_name: 'Bash', tool_input: { command: 'git commit -m x' }, command: 'git commit -m x',
      toolArgs: { command: 'git commit -m x' }, tool_info: { command_line: 'git commit -m x' },
    };
    denied(key, runAdapter(key, 'pre-command', { cwd: repo, env: baseEnv(STATED), payload }));
    allowed(key, runAdapter(key, 'pre-command', { cwd: repo, env: baseEnv(DELEGATE), payload }));
    allowed(key, runAdapter(key, 'pre-command', { cwd: repo, env: baseEnv(), payload }));
  }
});

test('the runner check reads only git commit and push, and only from a stated bot', () => {
  const { repo } = primaryCheckout();
  const empty = join(root, 'no-hooks');
  mkdirSync(empty, { recursive: true });
  const run = (command, extra) => runHooks({
    dialectKey: 'claude', event: 'pre-command', dir: empty, env: baseEnv(extra),
    payload: { cwd: repo, tool_name: 'Bash', tool_input: { command } },
  }).decision;
  for (const command of ['git commit -m x', 'git -C . push', 'sh -c "git push origin HEAD"', 'echo "$(git commit -m y)"', 'git commit-tree HEAD^{tree}']) {
    assert.equal(scanGitPublish(command, { cwd: repo, env: {} }).publishes.length, 1, command);
    assert.equal(run(command, STATED), 'deny', command);
    assert.equal(run(command, DELEGATE), 'allow', command);
  }
  for (const command of ['git status', 'git add .', 'gh pr create --title x --body y', 'git log --grep=commit', 'git merge --abort']) {
    assert.equal(scanGitPublish(command, { cwd: repo, env: {} }).publishes.length, 0, command);
    assert.equal(run(command, STATED), 'allow', command);
  }
});

// Copilot review on #757: the check must follow the repository git writes,
// not the session's directory. From a bound worktree, `git -C <unbound>
// commit --no-verify` skips the unbound checkout's own hook.
test('a bound session cannot reach an unbound checkout through -C, --git-dir, GIT_DIR, cd or an alias', () => {
  const unbound = primaryCheckout();
  const bound = primaryCheckout(`${SLUG}[bot]`);
  const empty = join(root, 'no-hooks');
  mkdirSync(empty, { recursive: true });
  const run = (command, extra) => runHooks({
    dialectKey: 'claude', event: 'pre-command', dir: empty, env: baseEnv(extra),
    payload: { cwd: bound.repo, tool_name: 'Bash', tool_input: { command } },
  });
  unbound.git('config', 'alias.ci', 'commit');
  const u = unbound.repo;
  for (const command of [
    `git -C ${u} commit --no-verify -m x`,
    `git --git-dir=${u}/.git --work-tree=${u} commit --no-verify -m x`,
    `git --git-dir ${u}/.git push origin HEAD`,
    `GIT_DIR=${u}/.git git commit --no-verify -m x`,
    `cd ${u} && git commit --no-verify -m x`,
    `B=${u}; cd "$B"; git push`,
    `env -C ${u} git commit -n -m x`,
    `git -C ${u} ci --no-verify -m x`,
    `git -C ${u} -c alias.up='!git push' up`,
  ]) {
    const verdict = run(command, STATED);
    assert.equal(verdict.decision, 'deny', command);
    assert.match(verdict.reason, new RegExp(`stated bot identity ${SLUG}`), command);
  }
  // The bound worktree itself still publishes.
  for (const command of ['git commit -m x', `git -C ${bound.repo} push`, 'cd . && git commit -m x']) {
    assert.equal(run(command, STATED).decision, 'allow', command);
  }
  // A target no scan can place is refused for a stated bot, and only for one.
  for (const command of ['git -C "$UNSEEN_DIR" commit -m x', 'false && cd /tmp; git commit -m x', '(cd /tmp); git push']) {
    assert.match(run(command, STATED).reason ?? '', /cannot be proven/, command);
    assert.equal(run(command, DELEGATE).decision, 'allow', command);
    assert.equal(run(command, {}).decision, 'allow', command);
  }
  // The delegate and a human reach the unbound checkout as before.
  assert.equal(run(`git -C ${u} commit --no-verify -m x`, DELEGATE).decision, 'allow');
  assert.equal(run(`git -C ${u} commit --no-verify -m x`, {}).decision, 'allow');
});

// Cursor security review on #757: a `[bot]`-looking name is not a binding.
// Bound means author and committer are exactly `<slug>[bot]`, as git
// resolves them for this command, overrides included.
test('a decoy bot name or an identity override is not a binding', () => {
  const decoy = primaryCheckout('decoy[bot]');
  const bound = primaryCheckout(`${SLUG}[bot]`);
  const empty = join(root, 'no-hooks');
  mkdirSync(empty, { recursive: true });
  const run = (cwd, command, extra = STATED) => runHooks({
    dialectKey: 'claude', event: 'pre-command', dir: empty, env: baseEnv(extra),
    payload: { cwd, tool_name: 'Bash', tool_input: { command } },
  }).decision;
  assert.equal(run(decoy.repo, 'git commit -m x'), 'deny');
  assert.equal(run(decoy.repo, 'git push'), 'deny');
  for (const command of [
    "git -c user.name='Owner Human' -c user.email=o@x -c core.hooksPath=/dev/null commit -m x",
    "git -c author.name='Owner Human' commit -m x",
    'git commit --author "Owner Human <o@x>" -m x',
    'git commit --author=Owner -m x',
    "GIT_AUTHOR_NAME='Owner Human' git commit -m x",
    "GIT_COMMITTER_NAME='Owner Human' git commit -m x",
    'git --config-env=user.name=SOMEVAR commit -m x',
  ]) {
    assert.equal(run(bound.repo, command), 'deny', command);
    assert.equal(run(bound.repo, command, DELEGATE), 'allow', command);
  }
  assert.equal(run(bound.repo, `git commit --author "${SLUG}[bot] <b@x>" -m x`), 'allow');
  assert.equal(run(bound.repo, 'git commit -m x'), 'allow');

  // The git backstop resolves the same identity at commit time.
  const env = baseEnv(STATED);
  writeFileSync(join(bound.repo, 'decoy.txt'), 'x\n');
  bound.git('add', 'decoy.txt');
  const head = bound.git('rev-parse', 'HEAD');
  const commit = spawnSync('git', ['-c', 'user.name=Owner Human', 'commit', '-m', 'x'], { cwd: bound.repo, env, encoding: 'utf8' });
  assert.notEqual(commit.status, 0);
  assert.match(commit.stderr, new RegExp(`stated bot identity ${SLUG}`));
  assert.equal(bound.git('rev-parse', 'HEAD'), head);
});

// Copilot review on #757: shell escapes and quoting must not hide git from
// the detector. The scan unquotes the way sh does, and a command word it
// cannot read near git, commit or push is refused for a stated bot.
test('shell escapes, quoting and indirection do not hide a commit from a stated bot', () => {
  const { repo } = primaryCheckout();
  const empty = join(root, 'no-hooks');
  mkdirSync(empty, { recursive: true });
  const run = (command, extra) => runHooks({
    dialectKey: 'claude', event: 'pre-command', dir: empty, env: baseEnv(extra),
    payload: { cwd: repo, tool_name: 'Bash', tool_input: { command } },
  }).decision;
  for (const command of [
    'g\\it commit --no-verify -m x',
    '\\git commit --no-verify -m x',
    '"g"it commit --no-verify -m x',
    "g''it push",
    "$'git' commit -m x",
    "$'\\x67it' commit -m x",
    'G=git; $G commit -m x',
    '$(echo git) commit -m x',
    'g{i,}t commit -m x',
    'eval "git commit -m x"',
    'command git commit -m x',
    'nohup git push',
    'echo x | xargs git commit -m',
  ]) {
    assert.equal(run(command, STATED), 'deny', command);
    assert.equal(run(command, DELEGATE), 'allow', command);
    assert.equal(run(command, {}), 'allow', command);
  }
  // Here-document bodies are data, not commands.
  assert.equal(run('cat > notes.md <<EOF\ngit commit -m x\nEOF', STATED), 'allow');
});

// #749 follow-up: the git hooks are the backstop for git the pre-command
// scan cannot see, so a stated bot may not skip them, even where it is bound.
test('a stated bot cannot skip the git hooks with --no-verify, -n or a core.hooksPath override', () => {
  const bound = primaryCheckout(`${SLUG}[bot]`);
  bound.git('config', 'alias.ci', 'commit -n');
  bound.git('config', 'alias.up', '!git push');
  const empty = join(root, 'no-hooks');
  mkdirSync(empty, { recursive: true });
  const run = (command, extra) => runHooks({
    dialectKey: 'claude', event: 'pre-command', dir: empty, env: baseEnv(extra),
    payload: { cwd: bound.repo, tool_name: 'Bash', tool_input: { command } },
  });
  for (const command of [
    'git commit --no-verify -m x',
    'git commit --no-veri -m x',
    'git commit -n -m x',
    'git commit -anm x',
    'git push --no-verify origin HEAD',
    'git merge --no-verify topic',
    'git rebase --no-verify main',
    'git am --no-verify < patch.mbox',
    'git -c core.hooksPath=/dev/null commit -m x',
    'git -c CORE.HooksPath=/tmp/none push',
    'git --config-env=core.hooksPath=HOOKS commit -m x',
    "GIT_CONFIG_PARAMETERS=\"'core.hooksPath'='/dev/null'\" git commit -m x",
    'GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=core.hooksPath GIT_CONFIG_VALUE_0=/dev/null git commit -m x',
    'git config core.hooksPath /dev/null && git commit -m x',
    'git config --local --unset core.hooksPath',
    "git -c alias.x='commit --no-verify' x -m x",
    'git ci -m x',
    'git -c core.hooksPath=/dev/null up',
    "git rebase -x 'git commit --amend --no-verify --no-edit' main",
    'sh -c "git commit --no-verify -m x"',
  ]) {
    const verdict = run(command, STATED);
    assert.equal(verdict.decision, 'deny', command);
    assert.match(verdict.reason, new RegExp(`stated bot identity ${SLUG}.*skip the git hooks`), command);
    assert.equal(run(command, DELEGATE).decision, 'allow', command);
    assert.equal(run(command, {}).decision, 'allow', command);
  }
  // Not a bypass: `push -n` is --dry-run, `-m -n` is a message, a read of
  // core.hooksPath changes nothing, and -c on a command that writes no commit.
  for (const command of [
    'git push -n origin HEAD', 'git commit -m -n', 'git commit -mn', 'git config --get core.hooksPath',
    'git -c core.hooksPath=/dev/null status', 'git commit -m x', 'git push origin HEAD',
  ]) {
    assert.equal(run(command, STATED).decision, 'allow', command);
  }

  // Through the generated adapter, end to end.
  denied('claude', runAdapter('claude', 'pre-command', {
    cwd: bound.repo, env: baseEnv(STATED),
    payload: { session_id: 's4', cwd: bound.repo, tool_name: 'Bash', tool_input: { command: 'git commit --no-verify -m x' } },
  }));
  allowed('claude', runAdapter('claude', 'pre-command', {
    cwd: bound.repo, env: baseEnv(DELEGATE),
    payload: { session_id: 's4', cwd: bound.repo, tool_name: 'Bash', tool_input: { command: 'git commit --no-verify -m x' } },
  }));
});

test('merge, rebase, cherry-pick, revert, am and commit-tree get the bound-target check', () => {
  const unbound = primaryCheckout();
  const bound = primaryCheckout(`${SLUG}[bot]`);
  const empty = join(root, 'no-hooks');
  mkdirSync(empty, { recursive: true });
  const run = (command, extra) => runHooks({
    dialectKey: 'claude', event: 'pre-command', dir: empty, env: baseEnv(extra),
    payload: { cwd: bound.repo, tool_name: 'Bash', tool_input: { command } },
  });
  const u = unbound.repo;
  const subcommands = [
    'merge topic', 'rebase main', 'cherry-pick HEAD', 'revert HEAD', 'am patch.mbox', 'commit-tree HEAD^{tree} -m x',
    'rebase --continue',
  ];
  for (const sub of subcommands) {
    const command = `git -C ${u} ${sub}`;
    const verdict = run(command, STATED);
    assert.equal(verdict.decision, 'deny', command);
    assert.match(verdict.reason, /would be attributed to the human/, command);
    assert.equal(run(command, DELEGATE).decision, 'allow', command);
    assert.equal(run(command, {}).decision, 'allow', command);
    // The bound worktree itself still writes commits.
    assert.equal(run(`git ${sub}`, STATED).decision, 'allow', sub);
  }
  // Sequencer controls write no commit.
  for (const command of [`git -C ${u} rebase --abort`, `git -C ${u} merge --abort`, `git -C ${u} cherry-pick --quit`]) {
    assert.equal(run(command, STATED).decision, 'allow', command);
  }
  // cherry-pick runs no pre-commit hook, so the pre-command check is the guard.
  assert.equal(run(`cd ${u} && git cherry-pick HEAD`, STATED).decision, 'deny');
  assert.equal(scanGitPublish(`git -C ${u} commit-tree HEAD^{tree}`, { cwd: bound.repo, env: {} }).publishes[0].cwd, u);
});

test('unboundBotSlug: stated identities without a bot committer, and nothing else', () => {
  const human = primaryCheckout();
  const bot = primaryCheckout(`${SLUG}[bot]`);
  const slug = (cwd, extra) => unboundBotSlug({ cwd, env: baseEnv(extra) });

  assert.equal(slug(human.repo, { GH_AGENT_APP: SLUG }), SLUG);
  // An agent account is a stated identity with no env marker at all.
  assert.equal(slug(human.repo, { AGENT_BOT_ACCOUNT: SLUG }), SLUG);
  human.git('config', 'agentBot.app', SLUG);
  assert.equal(slug(human.repo, {}), SLUG, 'a pin with a human committer is unbound');
  human.git('config', '--unset', 'agentBot.app');

  // Bound: the committer is the bot setup-worktree configured.
  assert.equal(slug(bot.repo, { GH_AGENT_APP: SLUG }), null);
  // The delegate and the human state nothing.
  assert.equal(slug(human.repo, DELEGATE), null);
  assert.equal(slug(human.repo, {}), null);
  // With github-identity off there is no bot to bind.
  assert.equal(slug(human.repo, { GH_AGENT_APP: SLUG, AGENT_BOT_CONFIG: gateOff }), null);
});
