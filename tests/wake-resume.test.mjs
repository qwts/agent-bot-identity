import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { coldWakeCommand, readColdWakeSettings, setColdWake, wakeSetting } from '../cold-wake-settings.mjs';
import { createColdWaker } from '../cold-wake.mjs';
import { laneExecutor, createWakePlane } from '../wake-plane.mjs';
import { RESUME_HARNESSES, createResumeExecutor, createWakeSessions, resumePath, runProcess, wakeSessionsFile } from '../wake-resume.mjs';

const ID = 'agent_32332332-3233-4233-8233-323323323323';
const cli = fileURLToPath(new URL('../agent-bot.mjs', import.meta.url));

// The resume lane runs the harness CLI its composed PATH selects (#617
// slice 3b), so each fixture puts an executable stand-in for every resume
// harness first on PATH; the `run` double never starts it.
const STUBS = mkdtempSync(path.join(tmpdir(), 'wake-resume-bin-'));
after(() => rmSync(STUBS, { recursive: true, force: true }));
for (const name of Object.keys(RESUME_HARNESSES)) writeFileSync(path.join(STUBS, RESUME_HARNESSES[name].command), '#!/bin/sh\n', { mode: 0o755 });
const stubbed = (env) => ({ ...env, PATH: [STUBS, env.PATH].filter(Boolean).join(path.delimiter) });

function withState(run) {
  const root = mkdtempSync(path.join(tmpdir(), 'wake-resume-'));
  const env = { ...process.env, XDG_STATE_HOME: path.join(root, 'state'), HOME: root, GIT_CONFIG_COUNT: '0', GH_AGENT_APP: '' };
  return Promise.resolve(run({ root, env })).finally(() => rmSync(root, { recursive: true, force: true }));
}

// Recorded from `codex exec --json` and `opencode run --format json` (#323).
const CODEX_OUTPUT = [
  '{"type":"thread.started","thread_id":"01a0fe81-0f35-73a2-9d5f-d48c92029d1c"}',
  '{"type":"turn.started"}',
  '{"type":"item.completed","item":{"id":"item_0","type":"agent_message","text":"working on it"}}',
  '{"type":"item.completed","item":{"id":"item_1","type":"command_execution","command":"ls"}}',
  '{"type":"item.completed","item":{"id":"item_2","type":"agent_message","text":"pong"}}',
  '{"type":"turn.completed","usage":{"input_tokens":1}}',
].join('\n');
const OPENCODE_OUTPUT = [
  '{"type":"step_start","sessionID":"ses_f017","part":{"type":"step-start"}}',
  '{"type":"text","sessionID":"ses_f017","part":{"type":"text","text":"looking"}}',
  '{"type":"tool_use","sessionID":"ses_f017","part":{"type":"tool"}}',
  '{"type":"text","sessionID":"ses_f017","part":{"type":"text","text":"pong"}}',
  '{"type":"step_finish","sessionID":"ses_f017","part":{"reason":"stop"}}',
].join('\n');

test('codex: a new turn and a resumed one never ask for approval, and the last message is the reply', () => {
  const codex = RESUME_HARNESSES.codex;
  const fresh = codex.plan({ sessionId: null, prompt: 'hi', policy: 'workspace' });
  assert.deepEqual(fresh.args.slice(0, 2), ['exec', '--json']);
  assert.ok(fresh.args.includes('approval_policy="never"'));
  assert.ok(fresh.args.includes('sandbox_mode="workspace-write"'));
  assert.equal(fresh.args.at(-1), '-');
  assert.equal(fresh.stdin, 'hi');
  const resumed = codex.plan({ sessionId: 'thread-1', prompt: 'hi', policy: 'read-only' });
  assert.deepEqual(resumed.args.slice(0, 3), ['exec', 'resume', 'thread-1']);
  assert.ok(resumed.args.includes('sandbox_mode="read-only"'));
  assert.ok(!resumed.args.some((arg) => arg.includes('network_access')));
  assert.deepEqual(codex.parse(CODEX_OUTPUT), { reply: 'pong', sessionId: '01a0fe81-0f35-73a2-9d5f-d48c92029d1c', failure: null });
  assert.equal(codex.parse('{"type":"turn.failed","error":{"message":"usage limit"}}').failure, 'usage limit');
});

test('opencode: no permission is left at ask, and text after the last tool call is the reply', () => {
  const opencode = RESUME_HARNESSES.opencode;
  for (const policy of ['workspace', 'read-only']) {
    const plan = opencode.plan({ sessionId: 'ses_1', prompt: '--looks-like-a-flag', policy });
    const permission = JSON.parse(plan.env.OPENCODE_PERMISSION);
    assert.ok(!JSON.stringify(permission).includes('"ask"'));
    assert.equal(permission.external_directory, 'deny');
    assert.deepEqual(plan.args.slice(-2), ['--', '--looks-like-a-flag']);
    assert.ok(plan.args.includes('ses_1'));
  }
  // Read-only denies edits, shell and subagents outright; it never trades
  // a denial for an agent that can still run commands.
  const readOnly = JSON.parse(opencode.plan({ prompt: 'x', policy: 'read-only' }).env.OPENCODE_PERMISSION);
  assert.deepEqual([readOnly.edit, readOnly.bash, readOnly.task], ['deny', 'deny', 'deny']);
  assert.ok(!('*' in readOnly));
  assert.ok(!opencode.plan({ prompt: 'x', policy: 'read-only' }).args.includes('--agent'));
  assert.deepEqual(opencode.parse(OPENCODE_OUTPUT), { reply: 'pong', sessionId: 'ses_f017', failure: null });
});

test('devin: the workspace policy runs sandboxed, and the session id comes from devin list in the worktree', () => {
  const devin = RESUME_HARNESSES.devin;
  const plan = devin.plan({ sessionId: 'rainbow-position', prompt: 'hi', policy: 'workspace' });
  assert.deepEqual(plan.args.slice(0, 2), ['--resume', 'rainbow-position']);
  assert.ok(plan.args.includes('--sandbox'));
  assert.ok(plan.args.includes('--print'));
  assert.equal(plan.stdin, 'hi');
  assert.ok(!devin.plan({ prompt: 'hi', policy: 'read-only' }).args.includes('--sandbox'));
  const listed = JSON.stringify([
    { id: 'elsewhere', working_directory: '/other' },
    { id: 'nowhere' },
    { id: 'blank', working_directory: '' },
    { id: 'older', working_directory: '/work' },
    { id: 'newest', working_directory: '/work' },
  ]);
  assert.deepEqual(devin.sessionsIn(listed, '/work'), ['older', 'newest']);
  assert.equal(devin.sessionsIn('not json', '/work'), null);
});

// Recorded from `grok -p --output-format json` (grok 1.0.46).
const GROK_OUTPUT = JSON.stringify({ text: 'pong', stopReason: 'end_turn', sessionId: '01a0febc-23aa-7c30-96c7-9c3599afed0c', num_turns: 1 }, null, 2);

test('grok: both policies run sandboxed, read-only denies edits and shell, and the JSON result is the reply', () => {
  const grok = RESUME_HARNESSES.grok;
  const workspace = grok.plan({ sessionId: 'g-1', prompt: 'hi', policy: 'workspace' });
  assert.deepEqual(workspace.args.slice(0, 2), ['--resume', 'g-1']);
  assert.deepEqual(workspace.args.slice(-3), ['--sandbox', 'workspace', '--always-approve']);
  assert.ok(workspace.args.includes('/dev/stdin'));
  assert.equal(workspace.stdin, 'hi');
  const readOnly = grok.plan({ sessionId: null, prompt: 'hi', policy: 'read-only' }).args;
  assert.ok(!readOnly.includes('--resume'));
  assert.ok(!readOnly.includes('--always-approve'));
  assert.equal(readOnly[readOnly.indexOf('--sandbox') + 1], 'read-only');
  assert.equal(readOnly[readOnly.indexOf('--permission-mode') + 1], 'dontAsk');
  for (const tool of ['Edit', 'Write', 'Bash']) assert.ok(readOnly.some((arg, i) => arg === tool && readOnly[i - 1] === '--deny'));
  assert.deepEqual(grok.parse(GROK_OUTPUT), { reply: 'pong', sessionId: '01a0febc-23aa-7c30-96c7-9c3599afed0c', failure: null });
  assert.equal(grok.parse(JSON.stringify({ text: '', stopReason: 'refusal', sessionId: 'g-1' })).failure, 'grok refused the turn');
  assert.equal(grok.parse('error: not logged in').failure, 'grok printed no JSON result');
});

test('a harness that fixes its policy at start begins a new session when the policy changes', () => withState(async ({ env, root }) => {
  const sessions = createWakeSessions({ file: wakeSessionsFile({ env }) });
  let next = 0;
  const calls = [];
  const run = async (command, args) => {
    calls.push(args);
    next += 1;
    return { code: 0, stdout: JSON.stringify({ text: 'pong', stopReason: 'end_turn', sessionId: `g-${next}` }), stderr: '' };
  };
  const execute = createResumeExecutor({ sessions, baseEnv: stubbed({}), home: root, run });
  const turn = (policy) => execute({ invocation: { agentId: ID, harness: 'grok', cwd: root }, message: 'm', policy });
  await turn('read-only');
  await turn('read-only');
  assert.deepEqual(calls[1].slice(0, 2), ['--resume', 'g-1']);
  await turn('workspace');
  assert.ok(!calls[2].includes('--resume'));
  assert.equal(sessions.get(ID, 'grok', 'workspace'), 'g-3');
  assert.equal(sessions.get(ID, 'grok', 'read-only'), null);
  // A harness whose policy is per turn keeps its session across a change.
  sessions.set(ID, 'codex', 'thread-1', 'read-only');
  assert.equal(sessions.get(ID, 'codex'), 'thread-1');
}));

test('the PATH keeps the host tool path first and adds the harness install dirs', () => {
  const dirs = resumePath({ PATH: '/bundle/tools:/usr/bin' }, '/Users/me').split(':');
  assert.equal(dirs[0], '/bundle/tools');
  assert.ok(dirs.includes('/Users/me/.local/bin'));
  assert.ok(dirs.includes('/opt/homebrew/bin'));
  assert.equal(new Set(dirs).size, dirs.length);
});

test('the first wake starts a session and every later wake resumes it', () => withState(async ({ env, root }) => {
  const sessions = createWakeSessions({ file: wakeSessionsFile({ env }) });
  const calls = [];
  const run = async (command, args, options) => {
    calls.push({ command, args, options });
    return { code: 0, stdout: CODEX_OUTPUT, stderr: '' };
  };
  const execute = createResumeExecutor({ sessions, baseEnv: stubbed({ PATH: '/usr/bin', SECRET_ELSEWHERE: 'kept', AGENT_BOT_BINDING: '/daemon/own/binding.json' }), home: root, run });
  const invocation = { agentId: ID, harness: 'codex', cwd: '/work/tree' };
  const first = await execute({ invocation, message: 'one', env: { AGENT_BOT_BINDING: '/work/tree/.git/b.json' }, policy: 'workspace' });
  assert.equal(first.reply, 'pong');
  assert.equal(calls[0].args[1], '--json');
  assert.equal(calls[0].options.cwd, '/work/tree');
  assert.equal(calls[0].options.env.AGENT_BOT_BINDING, '/work/tree/.git/b.json');
  assert.equal(calls[0].options.env.QWTS_AGENT_ID, ID);
  assert.equal(sessions.get(ID, 'codex'), '01a0fe81-0f35-73a2-9d5f-d48c92029d1c');
  assert.equal(statSync(wakeSessionsFile({ env })).mode & 0o777, 0o600);
  await execute({ invocation, message: 'two', env: {}, policy: 'workspace' });
  // A soul without a binding never inherits the daemon's.
  assert.ok(!('AGENT_BOT_BINDING' in calls[1].options.env));
  assert.deepEqual(calls[1].args.slice(0, 3), ['exec', 'resume', '01a0fe81-0f35-73a2-9d5f-d48c92029d1c']);
  // A session belongs to its harness: a soul moved to OpenCode starts fresh.
  assert.equal(sessions.get(ID, 'opencode'), null);
}));

// A relayed resume turn's sends stay in the woken message's thread (#392):
// the harness's reach server reads the key from the turn's environment.
test('a resume turn carries the woken message\'s thread key, and never an inherited one', () => withState(async ({ env, root }) => {
  const sessions = createWakeSessions({ file: wakeSessionsFile({ env }) });
  const calls = [];
  const run = async (command, args, options) => {
    calls.push(options.env);
    return { code: 0, stdout: CODEX_OUTPUT, stderr: '' };
  };
  const execute = createResumeExecutor({ sessions, baseEnv: stubbed({ AGENT_BOT_REACH_CORRELATION: 'msg_daemon' }), home: root, run });
  await execute({ invocation: { agentId: ID, harness: 'codex', cwd: '/work/tree', correlation: 'msg_starter' }, message: 'm', env: {}, policy: 'workspace' });
  assert.equal(calls.at(-1).AGENT_BOT_REACH_CORRELATION, 'msg_starter');
  await execute({ invocation: { agentId: ID, harness: 'codex', cwd: '/work/tree' }, message: 'm', env: {}, policy: 'workspace' });
  assert.ok(!('AGENT_BOT_REACH_CORRELATION' in calls.at(-1)));
  await execute({ invocation: { agentId: ID, harness: 'codex', cwd: '/work/tree', correlation: 'x'.repeat(129) }, message: 'm', env: {}, policy: 'workspace' });
  assert.ok(!('AGENT_BOT_REACH_CORRELATION' in calls.at(-1)));
}));

test('a failed turn throws with the harness detail and keeps the recorded session', () => withState(async ({ env, root }) => {
  const sessions = createWakeSessions({ file: wakeSessionsFile({ env }) });
  sessions.set(ID, 'devin', 'held-open');
  const run = async () => ({ code: 1, stdout: '', stderr: "Error: session 'held-open' is already open in another process (PID 1490)\n" });
  const execute = createResumeExecutor({ sessions, baseEnv: stubbed({}), home: root, run });
  await assert.rejects(execute({ invocation: { agentId: ID, harness: 'devin', cwd: root }, message: 'm', policy: 'workspace' }), /devin turn failed: .*already open in another process/);
  assert.equal(sessions.get(ID, 'devin'), 'held-open');
  await assert.rejects(execute({ invocation: { agentId: ID, harness: 'aider', cwd: root }, message: 'm', policy: 'workspace' }), /does not support the aider harness/);
  await assert.rejects(execute({ invocation: { agentId: ID, harness: 'codex', cwd: root }, message: 'm', policy: 'anything' }), /read-only or workspace policy/);
}));

test('devin records only the one session its fresh turn created in the worktree', () => withState(async ({ env, root }) => {
  const sessions = createWakeSessions({ file: wakeSessionsFile({ env }) });
  const listing = (ids) => ({ code: 0, stdout: JSON.stringify([
    // Rows from another directory or with none never count, even if newer.
    { id: 'other-project', working_directory: '/other', last_activity_at: 99 },
    { id: 'no-dir', last_activity_at: 98 },
    ...ids.map((id) => ({ id, working_directory: root })),
  ]), stderr: '' });
  const make = (after) => {
    let lists = 0;
    return async (_command, args) => (args[0] === 'list'
      ? listing(lists++ === 0 ? ['human-session'] : after)
      : { code: 0, stdout: 'pong\n', stderr: '' });
  };
  const turn = (run) => createResumeExecutor({ sessions, baseEnv: stubbed({}), home: root, run })({ invocation: { agentId: ID, harness: 'devin', cwd: root }, message: 'm', policy: 'read-only' });
  // Two new sessions appeared (a human started one meanwhile): adopt neither.
  assert.equal((await turn(make(['human-session', 'mine', 'theirs']))).reply, 'pong');
  assert.equal(sessions.get(ID, 'devin'), null);
  await turn(make(['human-session', 'visual-continent']));
  assert.equal(sessions.get(ID, 'devin'), 'visual-continent');
}));

test('runProcess feeds stdin, captures output, and reports the exit code', async () => {
  const result = await runProcess(process.execPath, ['-e', 'process.stdin.pipe(process.stdout); process.stdin.on("end", () => process.exit(3))'], { cwd: tmpdir(), env: process.env, stdin: 'hello', timeoutMs: 10_000 });
  assert.deepEqual({ code: result.code, stdout: result.stdout }, { code: 3, stdout: 'hello' });
  await assert.rejects(runProcess('/nonexistent/harness', [], { cwd: tmpdir(), env: process.env, timeoutMs: 1_000 }));
});

test('a resume setting is owner-set, shown, and audited; anything malformed is off', () => withState(async ({ env }) => {
  setColdWake(ID, { lane: 'resume', policy: 'workspace' }, { env, home: env.HOME });
  assert.deepEqual(wakeSetting(readColdWakeSettings({ env })[ID]), { lane: 'resume', policy: 'workspace' });
  assert.throws(() => setColdWake(ID, { lane: 'resume', policy: 'everything' }, { env, home: env.HOME }), /on, off, resume with a policy, or webhook/);
  assert.equal(wakeSetting({ lane: 'resume', policy: 'everything' }), null);
  assert.equal(wakeSetting('on'), null);
  assert.deepEqual(wakeSetting(true), { lane: 'acp' });
  const invoke = (...args) => spawnSync(process.execPath, [cli, 'soul', 'cold-wake', ID, ...args], { encoding: 'utf8', env, cwd: env.HOME });
  // The change runs in process with the owner gate injected: no dialog.
  const out = [];
  await coldWakeCommand([ID, 'resume', 'read-only'], { env, home: env.HOME, cwd: env.HOME,
    gate: async () => ({ method: 'consent' }), write: (text) => out.push(text) });
  assert.deepEqual(out, [`${ID} cold wake resume read-only\n`]);
  assert.equal(invoke('show').stdout, 'resume read-only\n');
  let result = invoke('resume');
  assert.equal(result.status, 1);
  assert.match(result.stderr, /usage: .*resume read-only\|workspace/);
  assert.equal(invoke('on', 'workspace').status, 1);
  result = spawnSync(process.execPath, [cli, 'soul', 'cold-wake', ID, 'resume', 'workspace'], { encoding: 'utf8', env: { ...env, GH_AGENT_APP: 'you-codex-agent' }, cwd: env.HOME });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /owner only/);
}));

test('the cold waker hands the resume lane its policy, and the lane executor routes by setting', async () => {
  const seen = [];
  const wake = createColdWaker({
    executor: laneExecutor({ acpTurn: () => assert.fail('the ACP lane must not run'), resumeTurn: async (input) => { seen.push(input); return { reply: 'done' }; } }),
    settings: { [ID]: { lane: 'resume', policy: 'workspace' } },
    lookupBinding: async () => ({ worktree: '/work/tree', file: '/work/tree/.git/b.json' }),
    identities: async () => ({ harness: 'opencode' }),
    receipt() {},
  });
  assert.equal((await wake({ agentId: ID, count: 1, messageIds: ['m1'] })).outcome, 'cold');
  await wake.idle();
  assert.equal(seen[0].policy, 'workspace');
  assert.equal(seen[0].invocation.harness, 'opencode');
  assert.throws(() => laneExecutor({})({ wake: { lane: 'resume', policy: 'workspace' } }), /resume wake is not available/);
  assert.throws(() => laneExecutor({})({ wake: { lane: 'acp' } }), /no executor is configured/);
});

test('a daemon with only the resume executor still wakes a resume soul cold', async () => {
  const reports = [];
  let turns = 0;
  const onWake = createWakePlane({
    pool: { has: () => false, send: () => 0 },
    settings: { [ID]: { lane: 'resume', policy: 'read-only' } },
    lookupSoul: () => ({ agentId: ID, worktree: '/w', file: '/w/.git/b.json' }),
    identities: () => ({ harness: 'codex' }),
    resumeExecutor: async () => { turns += 1; return { reply: '' }; },
    receipt() {},
  });
  await onWake({ event: 'wake', agentId: ID, count: 1, cursor: 1, messageIds: ['m1'] }, { report: async (fields) => reports.push(fields) });
  await onWake.idle();
  assert.equal(reports[0].outcome, 'cold');
  assert.equal(turns, 1);
});

test('a soul bound by its own session resolves to its recorded worktree, without a binding file', () => withState(async ({ root, env }) => {
  const { recordedWorktree } = await import('../agent-daemon.mjs');
  const { writeFileSync, mkdirSync } = await import('node:fs');
  const worktree = path.join(root, 'tree');
  mkdirSync(worktree);
  const git = (cwd, ...args) => spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8', env: { ...env, GIT_CONFIG_GLOBAL: '/dev/null' } });
  git(worktree, 'init', '-q');
  git(worktree, 'config', 'agentBot.agentId', ID);
  const OTHER = 'agent_42442442-4244-4244-8244-424424424424';
  const GONE = 'agent_52552552-5255-4255-8255-525525525525';
  const REPINNED = 'agent_72772772-7277-4277-8277-727727727727';
  const UNPINNED = 'agent_82882882-8288-4288-8288-828828828828';
  const bare = path.join(root, 'bare');
  mkdirSync(bare);
  git(bare, 'init', '-q');
  const record = (id, status, tree) => ({ id, status, spacePath: path.join(root, 'space', id), worktree: tree, worktrees: [tree], lastSeen: '2026-10-02T00:00:00.000Z' });
  const file = path.join(root, 'population.json');
  writeFileSync(file, JSON.stringify({ schemaVersion: 1, souls: {
    [ID]: record(ID, 'active', worktree),
    [OTHER]: record(OTHER, 'retired', worktree),
    [GONE]: record(GONE, 'active', path.join(root, 'deleted')),
    // The record still names a worktree that now pins another soul, or none.
    [REPINNED]: record(REPINNED, 'active', worktree),
    [UNPINNED]: record(UNPINNED, 'active', bare),
  } }));
  const options = { env: { ...env, AGENT_BOT_POPULATION_PATH: file }, home: root };
  assert.deepEqual(recordedWorktree(ID, options), { agentId: ID, worktree, file: null });
  assert.equal(recordedWorktree(OTHER, options), null);
  assert.equal(recordedWorktree(GONE, options), null);
  assert.equal(recordedWorktree(REPINNED, options), null);
  assert.equal(recordedWorktree(UNPINNED, options), null);
  assert.equal(recordedWorktree('agent_62662662-6266-4266-8266-626626626626', options), null);
}));

test('a soul with no usable recorded worktree falls back to its own soul directory, proven by its marker (#382)', () => withState(async ({ root, env }) => {
  const { recordedWorktree } = await import('../agent-daemon.mjs');
  const { writeFileSync, mkdirSync } = await import('node:fs');
  const SPAWNED = 'agent_92992992-9299-4299-8299-929929929929';
  const FOREIGN = 'agent_a2aa2aa2-a2aa-42aa-82aa-a2aaa2aaa2aa';
  const souls = path.join(root, 'souls');
  const dir = (name, owner) => {
    const directory = path.join(souls, `${name}.soul`);
    mkdirSync(path.join(directory, '.soul-state'), { recursive: true });
    writeFileSync(path.join(directory, '.soul-state', 'agent-id'), `${owner}\n`);
    return directory;
  };
  const record = (id, soulDir, worktree = null) => ({ id, status: 'active', spacePath: path.join(root, 'space', id), soulDir, worktree, worktrees: worktree ? [worktree] : [], lastSeen: '2026-10-02T00:00:00.000Z' });
  const spawned = dir('Dudles - Starter', SPAWNED);
  const file = path.join(root, 'population.json');
  writeFileSync(file, JSON.stringify({ schemaVersion: 1, souls: {
    // Spawned from a template and never joined from a checkout.
    [SPAWNED]: record(SPAWNED, spawned),
    // Its recorded directory is marked as another soul's.
    [FOREIGN]: record(FOREIGN, dir('Taken', SPAWNED)),
  } }));
  const options = { env: { ...env, AGENT_BOT_POPULATION_PATH: file, AGENT_BOT_SOULS_HOME: souls }, home: root };
  assert.deepEqual(recordedWorktree(SPAWNED, options), { agentId: SPAWNED, worktree: spawned, file: null });
  assert.equal(recordedWorktree(FOREIGN, options), null);
}));

test('only the resume lane runs without a binding file, and then presents none', async () => {
  const seen = [];
  const make = (setting) => createColdWaker({
    executor: async (input) => { seen.push(input); return { reply: '' }; },
    settings: { [ID]: setting },
    lookupBinding: async () => ({ agentId: ID, worktree: '/work/tree', file: null }),
    identities: async () => ({ harness: 'codex' }),
    receipt() {},
  });
  const acp = await make(true)({ agentId: ID, count: 1, messageIds: ['m1'] });
  assert.deepEqual(acp, { outcome: 'failed', detail: 'soul binding is unavailable' });
  const resume = make({ lane: 'resume', policy: 'read-only' });
  assert.equal((await resume({ agentId: ID, count: 1, messageIds: ['m1'] })).outcome, 'cold');
  await resume.idle();
  assert.equal(seen.length, 1);
  assert.ok(!('AGENT_BOT_BINDING' in seen[0].env));
});
