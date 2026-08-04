import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { CANONICAL_EVENTS } from '../hook-dialects.mjs';
import {
  combine, discoverHooks, hooksDir as resolveHooksDir, readVerdict, runHooks,
} from '../agent-hook.mjs';

const root = mkdtempSync(path.join(tmpdir(), 'agent-hook-'));
after(() => rmSync(root, { recursive: true, force: true }));

const repo = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const runner = path.join(repo, 'agent-hook.mjs');

let seq = 0;
function hooksDir(files = {}) {
  const dir = path.join(root, `h${(seq += 1)}`);
  for (const [rel, body] of Object.entries(files)) {
    const file = path.join(dir, rel);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, body);
    chmodSync(file, 0o755);
  }
  return dir;
}

const ALLOW = '#!/bin/sh\nexit 0\n';
const DENY = '#!/bin/sh\necho "blocked by policy" >&2\nexit 2\n';
const CRASH = '#!/bin/sh\necho boom >&2\nexit 7\n';

// End-to-end through the real CLI, the way a generated config invokes it.
function invoke(dir, { dialect, event, payload = {} }) {
  const run = spawnSync(process.execPath, [runner, '--dialect', dialect, '--event', event], {
    input: JSON.stringify(payload),
    encoding: 'utf8',
    env: { ...process.env, AGENT_BOT_HOOKS_DIR: dir },
  });
  return { status: run.status, stdout: run.stdout, stderr: run.stderr };
}

test('an empty folder allows, so every event can be wired unconditionally', () => {
  const result = invoke(hooksDir(), { dialect: 'claude', event: 'pre-command' });
  assert.equal(result.status, 0);
  assert.equal(result.stdout, '');
});

test('a denying hook blocks, in each dialect its own way', () => {
  const dir = hooksDir({ 'pre-command/50-deny': DENY });

  const claude = invoke(dir, { dialect: 'claude', event: 'pre-command' });
  assert.equal(JSON.parse(claude.stdout).hookSpecificOutput.permissionDecision, 'deny');
  assert.match(JSON.parse(claude.stdout).hookSpecificOutput.permissionDecisionReason, /blocked by policy/);

  assert.equal(JSON.parse(invoke(dir, { dialect: 'cursor', event: 'pre-command' }).stdout).permission, 'deny');
  assert.equal(
    JSON.parse(invoke(dir, { dialect: 'copilot', event: 'pre-command' }).stdout).permissionDecision,
    'deny',
  );

  // Exit-code-only dialects: the status IS the answer.
  assert.equal(invoke(dir, { dialect: 'devin-desktop', event: 'pre-command' }).status, 2);
});

// The common hook is five lines of sh that reads the env mirror and exits
// without ever touching stdin. Writing the envelope into a pipe nobody is
// reading raises EPIPE on Linux (macOS buffers it away). If that is treated as
// a hook failure, every such hook reports an internal error instead of its own
// reason. The payload here is deliberately large enough to overflow the pipe
// buffer, so the race is forced rather than hoped for.
test('a hook that never reads stdin still reports its own reason', () => {
  const dir = hooksDir({ 'pre-command/50-deny': DENY });
  const result = invoke(dir, {
    dialect: 'claude',
    event: 'pre-command',
    payload: { bulk: 'x'.repeat(1024 * 1024) },
  });
  const reason = JSON.parse(result.stdout).hookSpecificOutput.permissionDecisionReason;
  assert.match(reason, /blocked by policy/);
  assert.doesNotMatch(reason, /EPIPE/);
});

test('hooks run in lexicographic order and the first denial wins', () => {
  const dir = hooksDir({
    'pre-command/10-allow': ALLOW,
    'pre-command/20-deny': '#!/bin/sh\necho first >&2\nexit 2\n',
    'pre-command/30-deny': '#!/bin/sh\necho second >&2\nexit 2\n',
  });
  const out = JSON.parse(invoke(dir, { dialect: 'claude', event: 'pre-command' }).stdout);
  assert.match(out.hookSpecificOutput.permissionDecisionReason, /20-deny: first/);
  assert.doesNotMatch(out.hookSpecificOutput.permissionDecisionReason, /second/);
});

// The event decides the fail mode, which is why a hook needs no manifest.
test('a crashing hook denies on a blocking event and only warns on an advisory one', () => {
  const dir = hooksDir({ 'pre-command/50-crash': CRASH, 'post-tool-use/50-crash': CRASH });

  const blocking = invoke(dir, { dialect: 'claude', event: 'pre-command' });
  assert.equal(JSON.parse(blocking.stdout).hookSpecificOutput.permissionDecision, 'deny');

  const advisory = invoke(dir, { dialect: 'claude', event: 'post-tool-use' });
  assert.equal(advisory.status, 0);
  assert.equal(advisory.stdout, '');
  assert.match(advisory.stderr, /50-crash/);
});

test('unparseable hook output is an error, never an allow', () => {
  const dir = hooksDir({
    'pre-command/50-garbage': '#!/bin/sh\necho "agent-hook: {not json"\nexit 0\n',
  });
  const out = JSON.parse(invoke(dir, { dialect: 'claude', event: 'pre-command' }).stdout);
  assert.equal(out.hookSpecificOutput.permissionDecision, 'deny');
});

test('a hook that hangs is denied on our clock, not the vendor timeout', () => {
  // Copilot's preToolUse fails OPEN when the vendor timer fires, so ours must
  // fire first. Codex's session-end cap is the tightest, at ~3s.
  const dir = hooksDir({ 'session-end/50-hang': '#!/bin/sh\nsleep 30\n' });
  const started = process.hrtime.bigint();
  const result = invoke(dir, { dialect: 'codex', event: 'session-end' });
  const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
  assert.ok(elapsedMs < 6000, `runner waited ${elapsedMs}ms, past the vendor cap`);
  // session-end is advisory: a hang must not wedge the session shutdown.
  assert.equal(result.status, 0);
});

test('a hanging hook on a blocking event denies', () => {
  const dir = hooksDir({ 'pre-command/50-hang': '#!/bin/sh\nsleep 30\n' });
  const result = spawnSync(
    process.execPath,
    [runner, '--dialect', 'codex', '--event', 'pre-command'],
    {
      input: '{}',
      encoding: 'utf8',
      timeout: 20000,
      env: { ...process.env, AGENT_BOT_HOOKS_DIR: dir, AGENT_HOOK_TIMEOUT_MS: '800' },
    },
  );
  assert.equal(JSON.parse(result.stdout).hookSpecificOutput.permissionDecision, 'deny');
});

test('the normalized env reaches the hook whatever the dialect called the field', () => {
  const dir = hooksDir({
    'pre-command/50-echo': '#!/bin/sh\n[ "$AGENT_HOOK_TOOL_COMMAND" = "git push --force" ] || exit 0\necho "saw: $AGENT_HOOK_HARNESS/$AGENT_HOOK_SESSION_ID" >&2\nexit 2\n',
  });
  const cursor = invoke(dir, {
    dialect: 'cursor',
    event: 'pre-command',
    payload: { conversation_id: 'c1', tool_input: { command: 'git push --force' } },
  });
  assert.match(JSON.parse(cursor.stdout).agent_message, /saw: cursor\/c1/);

  const desktop = invoke(dir, {
    dialect: 'devin-desktop',
    event: 'pre-command',
    payload: { trajectory_id: 't1', tool_info: { command_line: 'git push --force' } },
  });
  assert.equal(desktop.status, 2);
  assert.match(desktop.stderr, /saw: devin-desktop\/t1/);
});

test('a hook can ask, and a dialect without an ask channel closes instead', () => {
  const dir = hooksDir({
    'pre-command/50-ask': '#!/bin/sh\necho \'agent-hook: {"decision":"ask","reason":"needs a human"}\'\nexit 0\n',
  });
  assert.equal(
    JSON.parse(invoke(dir, { dialect: 'claude', event: 'pre-command' }).stdout)
      .hookSpecificOutput.permissionDecision,
    'ask',
  );
  assert.equal(invoke(dir, { dialect: 'devin-desktop', event: 'pre-command' }).status, 2);
});

test('non-executable files never run', () => {
  const dir = hooksDir({ 'pre-command/50-deny': DENY });
  writeFileSync(path.join(dir, 'pre-command', 'README.md'), 'not a hook\n');
  writeFileSync(path.join(dir, 'pre-command', '60-draft'), '#!/bin/sh\nexit 2\n');
  chmodSync(path.join(dir, 'pre-command', '60-draft'), 0o644);
  assert.deepEqual(
    discoverHooks(dir, 'pre-command').map((f) => path.basename(f)),
    ['50-deny'],
  );
});

test('a malformed vendor payload does not deny — the harness sent it, not the hook', () => {
  const dir = hooksDir({ 'pre-command/50-allow': ALLOW });
  const run = spawnSync(process.execPath, [runner, '--dialect', 'claude', '--event', 'pre-command'], {
    input: 'not json at all',
    encoding: 'utf8',
    env: { ...process.env, AGENT_BOT_HOOKS_DIR: dir },
  });
  assert.equal(run.status, 0);
});

test('a bad invocation never blocks the agent', () => {
  const run = spawnSync(process.execPath, [runner, '--dialect', 'claude', '--event', 'nonsense'], {
    input: '{}', encoding: 'utf8', env: { ...process.env, AGENT_BOT_HOOKS_DIR: hooksDir() },
  });
  assert.equal(run.status, 0);
  assert.match(run.stderr, /unknown event/);
});

// A hook that prints allow and then dies has not allowed anything — a failing
// cleanup step or a `set -e` trap after the verdict must not be readable as
// success. The exit status outranks the printed line, always.
test('a printed allow cannot soften a nonzero exit', () => {
  const dir = hooksDir({
    'pre-command/50-liar': '#!/bin/sh\necho \'agent-hook: {"decision":"allow"}\'\necho "cleanup failed" >&2\nexit 7\n',
    'pre-command/60-deny-after-allow': '#!/bin/sh\nexit 0\n',
  });
  const out = JSON.parse(invoke(dir, { dialect: 'claude', event: 'pre-command' }).stdout);
  assert.equal(out.hookSpecificOutput.permissionDecision, 'deny');
  assert.match(out.hookSpecificOutput.permissionDecisionReason, /exited 7/);
});

test('a printed allow alongside exit 2 is still a deny', () => {
  const dir = hooksDir({
    'pre-command/50-confused': '#!/bin/sh\necho \'agent-hook: {"decision":"allow","reason":"r"}\'\nexit 2\n',
  });
  const out = JSON.parse(invoke(dir, { dialect: 'claude', event: 'pre-command' }).stdout);
  assert.equal(out.hookSpecificOutput.permissionDecision, 'deny');
});

// One budget for the whole run, not one per hook: n slow hooks must not take
// n × budget and sail past the vendor's own timer into its fail-open path.
test('the timeout budget covers the whole run, not each hook', () => {
  const slow = '#!/bin/sh\nsleep 30\n';
  const dir = hooksDir({
    'pre-command/10-slow': slow,
    'pre-command/20-slow': slow,
    'pre-command/30-slow': slow,
  });
  const started = process.hrtime.bigint();
  const result = spawnSync(
    process.execPath,
    [runner, '--dialect', 'copilot', '--event', 'pre-command'],
    {
      input: '{}',
      encoding: 'utf8',
      timeout: 20000,
      env: { ...process.env, AGENT_BOT_HOOKS_DIR: dir, AGENT_HOOK_TIMEOUT_MS: '1200' },
    },
  );
  const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
  // Three hooks under a per-hook budget would take ~3.6s; one shared deadline
  // keeps the whole run inside it.
  assert.ok(elapsedMs < 2600, `run took ${elapsedMs}ms — budget is not shared`);
  assert.equal(JSON.parse(result.stdout).permissionDecision, 'deny');
});

test('an unknown dialect is refused at parse time, and never blocks', () => {
  const run = spawnSync(process.execPath, [runner, '--dialect', 'nonesuch', '--event', 'pre-command'], {
    input: '{}', encoding: 'utf8', env: { ...process.env, AGENT_BOT_HOOKS_DIR: hooksDir() },
  });
  assert.equal(run.status, 0);
  assert.equal(run.stdout, '');
  assert.match(run.stderr, /unknown dialect/);
});

test('verdict reading maps the exit codes a hook author actually uses', () => {
  assert.deepEqual(readVerdict({ status: 0 }), { decision: 'allow', reason: '' });
  assert.equal(readVerdict({ status: 2, stderr: 'why' }).decision, 'deny');
  assert.equal(readVerdict({ status: 2, stderr: 'why' }).reason, 'why');
  assert.equal(readVerdict({ status: 1 }).decision, 'error');
  assert.equal(readVerdict({ status: 0, stdout: 'agent-hook: {"decision":"nope"}' }).decision, 'error');
  const ALLOW_LINE = 'agent-hook: {"decision":"allow"}';
  assert.equal(readVerdict({ status: 0, stdout: ALLOW_LINE }).decision, 'allow');
  assert.equal(readVerdict({ status: 2, stdout: ALLOW_LINE }).decision, 'deny');
  assert.equal(readVerdict({ status: 1, stdout: ALLOW_LINE }).decision, 'error');
});

// agent-bot is normally a ~/.local/bin symlink into one clone, so resolving
// relative to the module would look inside the toolkit and silently find
// nothing when the project carries its own agent-hooks/.
test('hooks are found in the working repo, not only beside the module', () => {
  const repo = path.join(root, `proj${(seq += 1)}`);
  mkdirSync(path.join(repo, 'agent-hooks', 'pre-command'), { recursive: true });
  execFileSync('git', ['init', '--quiet'], { cwd: repo });
  const hook = path.join(repo, 'agent-hooks', 'pre-command', '50-deny');
  writeFileSync(hook, DENY);
  chmodSync(hook, 0o755);

  const env = { ...process.env };
  delete env.AGENT_BOT_HOOKS_DIR;
  // git rev-parse returns the realpath, and on macOS the temp dir arrives via
  // the /var -> /private/var symlink.
  assert.equal(resolveHooksDir(env, repo), path.join(realpathSync(repo), 'agent-hooks'));

  const run = spawnSync(process.execPath, [runner, '--dialect', 'claude', '--event', 'pre-command'], {
    input: '{}', encoding: 'utf8', cwd: repo, env,
  });
  assert.equal(JSON.parse(run.stdout).hookSpecificOutput.permissionDecision, 'deny');
});

test('combine short-circuits on deny and keeps ask below it', () => {
  assert.equal(combine([{ name: 'a', decision: 'allow' }], 'pre-command').decision, 'allow');
  assert.equal(
    combine([{ name: 'a', decision: 'ask' }, { name: 'b', decision: 'deny', reason: 'x' }], 'pre-command')
      .decision,
    'deny',
  );
  assert.equal(combine([{ name: 'a', decision: 'ask', reason: 'x' }], 'pre-command').decision, 'ask');
});

test('runHooks is callable in-process for every canonical event', () => {
  const dir = hooksDir();
  for (const event of CANONICAL_EVENTS) {
    assert.equal(runHooks({ dialectKey: 'claude', event, payload: {}, dir }).decision, 'allow');
  }
});

test('the git pre-push backstop rejects rewrites and allows fast-forwards', () => {
  const work = path.join(root, `git-push${(seq += 1)}`);
  mkdirSync(work, { recursive: true });
  execFileSync('git', ['init', '--quiet'], { cwd: work });
  execFileSync('git', ['config', 'user.name', 'test-agent[bot]'], { cwd: work });
  execFileSync('git', ['config', 'user.email', 'test-agent@users.noreply.github.com'], { cwd: work });
  writeFileSync(path.join(work, 'a'), 'one\n');
  execFileSync('git', ['add', 'a'], { cwd: work });
  execFileSync('git', ['-c', 'core.hooksPath=/dev/null', 'commit', '--quiet', '-m', 'one'], { cwd: work });
  const first = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: work, encoding: 'utf8' }).trim();
  writeFileSync(path.join(work, 'a'), 'two\n');
  execFileSync('git', ['-c', 'core.hooksPath=/dev/null', 'commit', '--quiet', '-am', 'two'], { cwd: work });
  const second = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: work, encoding: 'utf8' }).trim();
  const line = (local, remote) => `refs/heads/main ${local} refs/heads/main ${remote}\n`;
  const run = (input) => spawnSync(
    process.execPath,
    [runner, '--dialect', 'git', '--event', 'pre-push'],
    {
      cwd: work,
      input,
      encoding: 'utf8',
      env: { ...process.env, AGENT_BOT_HOOKS_DIR: path.join(repo, 'agent-hooks') },
    },
  );

  assert.equal(run(line(second, first)).status, 0, 'fast-forward push was rejected');
  const rewrite = run(line(first, second));
  assert.equal(rewrite.status, 2);
  assert.match(rewrite.stderr, /may not rewrite/);
});
