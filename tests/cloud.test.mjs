import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn as spawnChild } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { BASE, fakeServer, sandbox, sleep } from './helpers/fake-identity-server.mjs';
import { enroll } from '../identity/server-client.mjs';
import {
  cloudDown, cloudStateDir, cloudStatus, cloudUp, ensureDaemon, ensureGhShim, installHooks, main, parseCloudArgs, promptFromLog, resolveAppSlug, startBackgroundEnroll,
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
  const r = await cloudUp({ env, run: cli.run, verify: async () => ({ ok: true }), background: async () => assert.fail('no enrollment is started') });
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
  await cloudUp({ env, run: fakeCli().run, verify: async () => assert.fail('a revoked record needs no live check'), background: async (o) => { seen.push(o); return { state: 'pending', prompt: PROMPT }; } });
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
  assert.match(hook.hookSpecificOutput.additionalContext, /Tell the user to approve it: https:\/\/agent-bot\.test\/device\?user_code=ABCD-EFGH \(code ABCD-EFGH; public key thumbprint thumb, not a secret/);
  assert.match(hook.hookSpecificOutput.additionalContext, /run `agent-bot cloud status` \(read-only/, 'the session learns how to check later');

  const failing = { ...io, background: async () => { throw new Error('disk full'); } };
  assert.equal(await main(['up', '--hook'], failing), 0, 'a hook never blocks the session');
  assert.equal(await main(['up'], failing), 1);
  assert.match(err.pop(), /disk full/);
  assert.equal(await main(['down', '--hook'], { ...io, run: () => ({ status: 1, stdout: '', stderr: 'x' }) }), 0);
});

test('cloud up re-enrolls a device past its recorded expiry, or one the server refuses, and keeps one it cannot reach (#1423 review)', async () => {
  const env = { ...sandbox(), AGENT_BOT_SERVER: BASE, AGENT_BOT_SERVER_HARNESS: 'grok' };
  const srv = fakeServer();
  await enroll({ base: BASE, env, harnesses: ['grok'], fetchImpl: srv.fetch, sleep });
  const file = join(env.AGENT_BOT_SERVER_STATE, 'device.json');
  const device = JSON.parse(readFileSync(file, 'utf8'));
  const grant = async (o) => { grants.push(o); return { state: 'pending', prompt: PROMPT }; };
  let grants = [];

  writeFileSync(file, JSON.stringify({ ...device, expires_at: '2020-01-01T00:00:00Z' }));
  await cloudUp({ env, run: fakeCli().run, verify: async () => assert.fail('an expired record needs no live check'), background: grant });
  assert.deepEqual(grants.map((g) => g.force), [true], 'past its expires_at: forced re-enrollment');

  writeFileSync(file, JSON.stringify(device));
  grants = [];
  await cloudUp({ env, run: fakeCli().run, verify: async () => ({ ok: false, reason: 'invalid_grant' }), background: grant });
  assert.deepEqual(grants.map((g) => g.force), [true], 'refused by the server (idle expiry): forced re-enrollment');

  grants = [];
  const kept = await cloudUp({ env, run: fakeCli().run, verify: async () => ({ ok: true, unverified: 'fetch failed' }), background: grant });
  assert.equal(grants.length, 0, 'an unreachable server never throws the enrollment away');
  assert.equal(kept.enrollment.state, 'enrolled');
  assert.match(kept.warning, /could not confirm .*fetch failed/);

  // The real check against the fake server: refused once the server revoked it.
  srv.revokedDevice = device.device_id;
  const { verifyEnrollment } = await import('../cloud.mjs');
  assert.deepEqual(await verifyEnrollment({ base: BASE, env, fetchImpl: srv.fetch, readOnly: true }), { ok: false, reason: 'device-revoked' });
  assert.equal(JSON.parse(readFileSync(file, 'utf8')).revoked_at, undefined, 'a read-only check records nothing (#1431 review)');
  assert.deepEqual(await verifyEnrollment({ base: BASE, env, fetchImpl: srv.fetch }), { ok: false, reason: 'device-revoked' });
  assert.ok(JSON.parse(readFileSync(file, 'utf8')).revoked_at, 'cloud up records the revocation');
});

function detachedSleeper(t) {
  const child = spawnChild(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { detached: true, stdio: 'ignore' });
  child.unref();
  t.after(() => { try { process.kill(-child.pid, 'SIGKILL'); } catch { /* stopped */ } });
  child.exited = () => new Promise((resolve) => { if (child.exitCode !== null || child.signalCode) resolve(true); child.once('exit', () => resolve(true)); setTimeout(() => resolve(false), 2000); });
  return child;
}

test('a pending grant is reused only for the same App and server; another target stops it and starts anew (#1423 review)', async (t) => {
  const env = { ...sandbox(), AGENT_BOT_SERVER: BASE };
  const first = detachedSleeper(t);
  const second = detachedSleeper(t);
  const workers = [first, second];
  const spawned = [];
  const spawn = (cmd, args) => {
    spawned.push(args[args.indexOf('--harness') + 1]);
    writeFileSync(join(cloudStateDir({ env }), 'enroll.log'), `${JSON.stringify({ prompt: PROMPT })}\n`);
    return { pid: workers[spawned.length - 1].pid, unref() {} };
  };
  await startBackgroundEnroll({ slug: 'grok', force: false, env, spawn, sleep: async () => {} });
  assert.equal((await startBackgroundEnroll({ slug: 'grok', force: false, env, spawn, sleep: async () => {} })).reused, true);
  const other = await startBackgroundEnroll({ slug: 'claude', force: false, env, spawn, sleep: async () => {} });
  assert.equal(other.reused, false);
  assert.deepEqual(spawned, ['grok', 'claude']);
  assert.ok(await first.exited(), 'the grant for the old App was stopped');
  const pending = JSON.parse(readFileSync(join(cloudStateDir({ env }), 'enroll-pending.json'), 'utf8'));
  assert.deepEqual([pending.slug, pending.server, pending.pid], ['claude', BASE, second.pid]);
});

test('a worker that never shows a prompt is recorded at once, and stopped when the wait runs out (#1423 review)', async (t) => {
  const env = { ...sandbox(), AGENT_BOT_SERVER: BASE };
  const worker = detachedSleeper(t);
  let clock = 0;
  let recordedWhileWaiting = null;
  const result = await startBackgroundEnroll({
    slug: 'grok', force: false, env, wait: 50, now: () => clock,
    spawn: () => ({ pid: worker.pid, unref() {} }),
    sleep: async () => {
      recordedWhileWaiting ??= JSON.parse(readFileSync(join(cloudStateDir({ env }), 'enroll-pending.json'), 'utf8'));
      clock += 100;
    },
  });
  assert.equal(result.state, 'failed');
  assert.deepEqual([recordedWhileWaiting.pid, recordedWhileWaiting.slug, recordedWhileWaiting.prompt], [worker.pid, 'grok', null]);
  assert.ok(await worker.exited(), 'the silent worker group was stopped');
  assert.ok(!existsSync(join(cloudStateDir({ env }), 'enroll-pending.json')));
});

test('once enrolled, cloud up installs the gh shim bootstrap withheld, and only with github-identity on (#1430 review)', async () => {
  const env = { ...sandbox() };
  const cli = fakeCli();
  assert.deepEqual(ensureGhShim({ env, run: cli.run, gateOn: () => false }), { state: 'not-enabled' });
  assert.deepEqual(ensureGhShim({ env, run: cli.run, gateOn: () => true }), { state: 'installed' });
  assert.deepEqual(cli.calls, ['install-gh-shim']);
  mkdirSync(join(env.HOME, '.config', 'agent-bot', 'bin'), { recursive: true });
  writeFileSync(join(env.HOME, '.config', 'agent-bot', 'bin', 'gh'), '#!/bin/sh\n');
  assert.deepEqual(ensureGhShim({ env, run: cli.run, gateOn: () => true }), { state: 'present' });
  assert.equal(cli.calls.length, 1);
  const failing = fakeCli({ 'install-gh-shim': { status: 1, stdout: '', stderr: 'no gh on PATH\n' } });
  assert.deepEqual(ensureGhShim({ env: { ...sandbox() }, run: failing.run, gateOn: () => true }), { state: 'failed', detail: 'no gh on PATH' });

  // cloud up asks for it only once the device is enrolled, never while a grant is pending.
  const upEnv = { ...sandbox(), AGENT_BOT_SERVER: BASE, AGENT_BOT_SERVER_HARNESS: 'grok' };
  const shims = [];
  const pending = await cloudUp({ env: upEnv, run: fakeCli().run, shim: () => { shims.push('pending'); return { state: 'installed' }; }, background: async () => ({ state: 'pending', prompt: PROMPT }) });
  assert.equal(pending.shim, undefined);
  const srv = fakeServer();
  await enroll({ base: BASE, env: upEnv, harnesses: ['grok'], fetchImpl: srv.fetch, sleep });
  const enrolled = await cloudUp({ env: upEnv, run: fakeCli().run, verify: async () => ({ ok: true }), shim: () => { shims.push('enrolled'); return { state: 'installed' }; } });
  assert.deepEqual(enrolled.shim, { state: 'installed' });
  assert.deepEqual(shims, ['enrolled']);
});

test('cloud status reports enrollment, daemon, shim and a pending approval without changing anything', async (t) => {
  const env = { ...sandbox(), AGENT_BOT_SERVER: BASE, AGENT_BOT_SERVER_HARNESS: 'grok' };
  const running = { 'daemon status': { status: 0, stdout: 'running (pid 1, port 2)\n', stderr: '' } };
  const stopped = { 'daemon status': { status: 0, stdout: 'not running: daemon state file is stale\n', stderr: '' } };

  // Not enrolled, approval pending: the link is reported, nothing is started.
  const worker = spawnChild(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { detached: true, stdio: 'ignore' });
  worker.unref();
  t.after(() => { try { process.kill(-worker.pid, 'SIGKILL'); } catch { /* stopped */ } });
  mkdirSync(cloudStateDir({ env }), { recursive: true });
  writeFileSync(join(cloudStateDir({ env }), 'enroll-pending.json'), JSON.stringify({ pid: worker.pid, slug: 'grok', server: BASE, prompt: { ...PROMPT, expires_at: new Date(Date.now() + 600_000).toISOString() } }));
  const cli = fakeCli(stopped);
  const pending = await cloudStatus({ env, run: cli.run, verify: async () => assert.fail('nothing to confirm'), gateOn: () => true });
  assert.deepEqual(cli.calls, ['daemon status'], 'status only reads');
  assert.equal(pending.enrollment.state, 'none');
  assert.deepEqual(pending.pending, { url: PROMPT.verification_uri_complete, user_code: 'ABCD-EFGH', key_thumbprint: 'thumb', expires_at: pending.pending.expires_at });
  assert.equal(pending.shim.state, 'missing');
  assert.equal(pending.ready, false);
  // A grant for another App or server is not this status (#1431 review).
  assert.equal((await cloudStatus({ env: { ...env, AGENT_BOT_SERVER_HARNESS: 'other-app' }, run: fakeCli(stopped).run, gateOn: () => true })).pending, null);
  assert.equal((await cloudStatus({ env: { ...env, AGENT_BOT_SERVER: 'https://elsewhere.test' }, run: fakeCli(stopped).run, gateOn: () => true })).pending, null);

  // Enrolled and confirmed, daemon running: ready.
  const srv = fakeServer();
  await enroll({ base: BASE, env, harnesses: ['grok'], fetchImpl: srv.fetch, sleep });
  const ready = await cloudStatus({ env, run: fakeCli(running).run, verify: async (o) => { assert.equal(o.readOnly, true, 'status verifies read-only'); return { ok: true }; }, gateOn: () => false });
  assert.equal(ready.enrollment.state, 'enrolled');
  assert.equal(ready.daemon.state, 'running');
  assert.equal(ready.shim.state, 'not-enabled');
  assert.equal(ready.ready, true);

  // Refused by the server, or not reachable.
  assert.equal((await cloudStatus({ env, run: fakeCli(running).run, verify: async () => ({ ok: false, reason: 'invalid_grant' }) })).enrollment.state, 'expired');
  const unconfirmed = await cloudStatus({ env, run: fakeCli(running).run, verify: async () => ({ ok: true, unverified: 'fetch failed' }) });
  assert.deepEqual([unconfirmed.enrollment.state, unconfirmed.ready], ['enrolled-unconfirmed', false]);
  assert.equal((await cloudStatus({ env: { ...sandbox() }, run: fakeCli(running).run })).enrollment.state, 'server-mode-off');

  // The command: exit 0 only when ready.
  const out = [];
  const io = { env, out: { write: (s) => out.push(s) }, err: { write: () => {} }, run: fakeCli(stopped).run };
  assert.equal(await main(['status'], io), 1);
  assert.match(out.join(''), /daemon: {5}not-running/);
});
