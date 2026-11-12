import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn as spawnChild } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { BASE, fakeServer, sandbox, sleep } from './helpers/fake-identity-server.mjs';
import { enroll } from '../identity/server-client.mjs';
import {
  cloudDown, cloudStateDir, cloudUp, ensureDaemon, installHooks, main, parseCloudArgs, promptFromLog, resolveAppSlug, startBackgroundEnroll,
} from '../cloud.mjs';

const PROMPT = { user_code: 'ABCD-EFGH', verification_uri: `${BASE}/device`, verification_uri_complete: `${BASE}/device?user_code=ABCD-EFGH`, expires_in: 900, jkt: 'thumb' };

// A recorded stand-in for this runtime's own CLI.
function fakeCli(answers = {}) {
  const calls = [];
  const run = (args) => {
    calls.push(args.join(' '));
    const answer = answers[args.join(' ')] ?? answers[args[0]];
    return typeof answer === 'function' ? answer(args) : (answer ?? { status: 0, stdout: '', stderr: '' });
  };
  return { run, calls };
}

test('parseCloudArgs knows up, down and install-hooks and refuses anything else', () => {
  assert.deepEqual(parseCloudArgs(['up', '--harness', 'trueline-claude-agent', '--hook']), { sub: 'up', hook: true, json: false, harness: 'trueline-claude-agent', settings: null });
  assert.equal(parseCloudArgs(['install-hooks', '--settings', '/x.json']).settings, '/x.json');
  assert.throws(() => parseCloudArgs(['sideways']), /unknown cloud command/);
  assert.throws(() => parseCloudArgs(['up', '--force']), /unknown option/);
});

test('the App comes from --harness, then AGENT_BOT_SERVER_HARNESS, then the detected harness mapped through config', () => {
  assert.equal(resolveAppSlug({ flag: 'a-slug', env: { AGENT_BOT_SERVER_HARNESS: 'other' } }), 'a-slug');
  assert.equal(resolveAppSlug({ env: { AGENT_BOT_SERVER_HARNESS: 'env-slug' } }), 'env-slug');
  assert.equal(resolveAppSlug({ env: { CLAUDECODE: '1' }, config: { apps: { claude: 'org-claude-agent' } } }), 'org-claude-agent');
  assert.equal(resolveAppSlug({ env: {}, config: {} }), null);
});

test('ensureDaemon leaves a running daemon alone and starts a stopped one', () => {
  const up = fakeCli({ 'daemon status': { status: 0, stdout: 'running (pid 1, port 2)\n', stderr: '' } });
  assert.deepEqual(ensureDaemon({ run: up.run }), { state: 'running' });
  assert.deepEqual(up.calls, ['daemon status']);
  const down = fakeCli({ 'daemon status': { status: 0, stdout: 'not running: daemon state file is stale\n', stderr: '' }, 'daemon start': { status: 0, stdout: 'daemon started (pid 9, port 3)\n', stderr: '' } });
  assert.deepEqual(ensureDaemon({ run: down.run }), { state: 'started', detail: 'daemon started (pid 9, port 3)' });
  const broken = fakeCli({ 'daemon status': { status: 1, stdout: '', stderr: '' }, 'daemon start': { status: 1, stdout: '', stderr: 'boom\n' } });
  assert.equal(ensureDaemon({ run: broken.run }).state, 'failed');
});

test('cloud up on an enrolled device only repairs the daemon', async () => {
  const env = { ...sandbox(), AGENT_BOT_SERVER: BASE, AGENT_BOT_SERVER_HARNESS: 'grok' };
  const srv = fakeServer();
  await enroll({ base: BASE, env, harnesses: ['grok'], fetchImpl: srv.fetch, sleep });
  const cli = fakeCli({ 'daemon status': { status: 0, stdout: 'not running\n', stderr: '' } });
  const r = await cloudUp({ env, run: cli.run, background: async () => assert.fail('no enrollment is started') });
  assert.equal(r.enrollment.state, 'enrolled');
  assert.equal(r.app, 'grok');
  assert.equal(r.daemon.state, 'started');
  assert.ok(!cli.calls.some((c) => c.startsWith('server')), 'nothing is enrolled again');
});

test('cloud up enrolls with AGENT_BOT_ENROLL_TOKEN in the foreground, else starts the device grant in the background', async () => {
  const env = { ...sandbox(), AGENT_BOT_SERVER: BASE, AGENT_BOT_SERVER_HARNESS: 'grok' };
  const token = fakeCli();
  const r1 = await cloudUp({ env: { ...env, AGENT_BOT_ENROLL_TOKEN: 'et_x' }, run: token.run, background: async () => assert.fail('no background grant with a token') });
  assert.ok(token.calls.includes('server enroll --harness grok --tag cloud'));
  assert.equal(r1.enrollment.via, 'token');

  const grant = fakeCli();
  const seen = [];
  const r2 = await cloudUp({ env, run: grant.run, background: async (o) => { seen.push(o); return { state: 'pending', prompt: PROMPT }; } });
  assert.equal(r2.enrollment.state, 'pending');
  assert.equal(seen[0].slug, 'grok');
  assert.equal(seen[0].force, false);
  assert.equal(seen[0].env.AGENT_BOT_SERVER, BASE);
});

test('cloud up re-enrolls with --force a device the server revoked, and reports when server mode is off', async () => {
  const env = { ...sandbox(), AGENT_BOT_SERVER: BASE, AGENT_BOT_SERVER_HARNESS: 'grok' };
  const srv = fakeServer();
  await enroll({ base: BASE, env, harnesses: ['grok'], fetchImpl: srv.fetch, sleep });
  const device = JSON.parse(readFileSync(join(env.AGENT_BOT_SERVER_STATE, 'device.json'), 'utf8'));
  writeFileSync(join(env.AGENT_BOT_SERVER_STATE, 'device.json'), JSON.stringify({ ...device, revoked_at: '2026-01-01T00:00:00Z' }));
  const seen = [];
  await cloudUp({ env, run: fakeCli().run, background: async (o) => { seen.push(o); return { state: 'pending', prompt: PROMPT }; } });
  assert.equal(seen[0].force, true);

  const off = await cloudUp({ env: { ...sandbox() }, run: fakeCli().run });
  assert.equal(off.enrollment.state, 'failed');
  assert.match(off.enrollment.detail, /AGENT_BOT_SERVER/);
});

test('the background grant returns the logged prompt at once, reuses a live pending one, and cloud down stops its whole group', async (t) => {
  const env = { ...sandbox() };
  let spawned = 0;
  // A real detached process stands in for the worker, so the process-group
  // checks run against a real group leader.
  const worker = spawnChild(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { detached: true, stdio: 'ignore' });
  worker.unref();
  t.after(() => { try { process.kill(-worker.pid, 'SIGKILL'); } catch { /* stopped */ } });
  const spawn = (cmd, args, options) => {
    spawned += 1;
    // The worker streams the prompt line into the log it was handed.
    writeFileSync(join(cloudStateDir({ env }), 'enroll.log'), `${JSON.stringify({ prompt: PROMPT })}\n`);
    assert.equal(options.detached, true);
    assert.ok(args.includes('__enroll-worker') && args.includes('grok'));
    return { pid: worker.pid, unref() {} };
  };
  const first = await startBackgroundEnroll({ slug: 'grok', force: false, env, spawn, sleep: async () => {} });
  assert.equal(first.state, 'pending');
  assert.equal(first.prompt.user_code, 'ABCD-EFGH');
  const again = await startBackgroundEnroll({ slug: 'grok', force: false, env, spawn, sleep: async () => {} });
  assert.equal(again.reused, true, 'a live worker with an unexpired prompt is reused');
  assert.equal(spawned, 1);
  cloudDown({ env, run: fakeCli().run });
  const exited = await new Promise((resolve) => { if (worker.exitCode !== null || worker.signalCode) resolve(true); worker.once('exit', () => resolve(true)); setTimeout(() => resolve(false), 2000); });
  assert.ok(exited, 'cloud down stopped the pending worker group');
  assert.ok(!existsSync(join(cloudStateDir({ env }), 'enroll-pending.json')));

  let clock = 0;
  const silent = await startBackgroundEnroll({ slug: 'grok', force: false, env: { ...sandbox() }, spawn: () => ({ pid: 999999, unref() {} }), wait: 10, sleep: async () => { clock += 20; }, now: () => clock });
  assert.equal(silent.state, 'failed');
  assert.deepEqual(promptFromLog('noise\n{"prompt":{"verification_uri_complete":"u"}}\n'), { verification_uri_complete: 'u' });
});

test('cloud down stops the daemon and unenrolls through server logout', () => {
  const env = { ...sandbox() };
  const cli = fakeCli({ 'server logout --json': { status: 0, stdout: '{"device":"dev_1","server":"x","remote":"revoked"}\n', stderr: '' } });
  assert.deepEqual(cloudDown({ env, run: cli.run }), { daemon: 'stopped', enrollment: 'revoked' });
  assert.deepEqual(cli.calls, ['daemon stop', 'server logout --json']);
  const failing = fakeCli({ 'server logout --json': { status: 1, stdout: '{"remote":"failed"}\n', stderr: 'agent-bot server: could not revoke\n' } });
  assert.equal(cloudDown({ env, run: failing.run }).enrollment, 'failed');
});

test('install-hooks adds SessionStart and SessionEnd once and keeps every other setting', () => {
  const settingsPath = join(sandbox().HOME, '.claude', 'settings.json');
  mkdirSync(dirname(settingsPath), { recursive: true });
  writeFileSync(settingsPath, JSON.stringify({ model: 'x', hooks: { SessionStart: [{ hooks: [{ type: 'command', command: 'echo hi' }] }] } }));
  const exe = "/home/o'neil/.local/bin/agent-bot";
  assert.deepEqual(installHooks({ settingsPath, executable: exe }).added, ['SessionStart', 'SessionEnd']);
  const s = JSON.parse(readFileSync(settingsPath, 'utf8'));
  assert.equal(s.model, 'x');
  assert.equal(s.hooks.SessionStart.length, 2);
  assert.equal(s.hooks.SessionStart[1].hooks[0].command, "'/home/o'\\''neil/.local/bin/agent-bot' cloud up --hook");
  assert.equal(s.hooks.SessionEnd[0].hooks[0].command, "'/home/o'\\''neil/.local/bin/agent-bot' cloud down --hook");
  assert.deepEqual(installHooks({ settingsPath, executable: exe }).added, [], 'a second run changes nothing');
  const fresh = join(sandbox().HOME, 'new', 'settings.json');
  assert.deepEqual(installHooks({ settingsPath: fresh, executable: '/a/agent-bot' }).added, ['SessionStart', 'SessionEnd']);
  assert.ok(existsSync(fresh));
});

test('--hook prints Claude Code hook JSON carrying the approval link and never fails the session', async () => {
  const env = { ...sandbox(), AGENT_BOT_SERVER: BASE, AGENT_BOT_SERVER_HARNESS: 'grok' };
  const out = []; const err = [];
  const io = { env, out: { write: (s) => out.push(s) }, err: { write: (s) => err.push(s) }, run: fakeCli().run, background: async () => ({ state: 'pending', prompt: PROMPT }) };
  assert.equal(await main(['up', '--hook'], io), 0);
  const hook = JSON.parse(out.pop());
  assert.equal(hook.hookSpecificOutput.hookEventName, 'SessionStart');
  assert.match(hook.hookSpecificOutput.additionalContext, /Tell the user to approve it: https:\/\/agent-bot\.test\/device\?user_code=ABCD-EFGH \(code ABCD-EFGH, key thumb\)/);

  const failing = { ...io, background: async () => { throw new Error('disk full'); } };
  assert.equal(await main(['up', '--hook'], failing), 0, 'a hook never blocks the session');
  assert.equal(await main(['up'], failing), 1);
  assert.match(err.pop(), /disk full/);
  assert.equal(await main(['down', '--hook'], { ...io, run: () => ({ status: 1, stdout: '', stderr: 'x' }) }), 0);
});
