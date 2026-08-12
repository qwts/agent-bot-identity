import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  assertLoopbackHost,
  createDaemonServer,
  daemonClient,
  daemonStateFile,
  daemonStatus,
  isLoopbackPeer,
  startDaemon,
  stopDaemon,
} from '../agent-daemon.mjs';
import { ensureAgentIdentity, stateDirectory } from '../agent-identity.mjs';

const AGENT_ID = 'agent_33333333-3333-4333-8333-333333333333';
const roots = [];

after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

function scratchEnv() {
  const root = mkdtempSync(path.join(tmpdir(), 'agent-daemon-'));
  roots.push(root);
  const env = {
    XDG_STATE_HOME: path.join(root, 'state'),
    AGENT_BOT_SPACES_HOME: path.join(root, 'spaces'),
    AGENT_BOT_POPULATION_PATH: path.join(root, 'population.json'),
    AGENT_BOT_DAEMON_STATE_PATH: path.join(root, 'daemon.json'),
  };
  return { root, env };
}

function mintIdentity(env, { id = AGENT_ID } = {}) {
  return ensureAgentIdentity({
    appSlug: 'you-codex-agent',
    botUid: '308462948',
    harness: 'codex',
    transcript: { provider: 'codex', id: 'thread-daemon' },
    stateDir: stateDirectory({ env, home: '/nonexistent' }),
    idFactory: () => id,
    now: () => new Date('2026-08-12T08:00:00.000Z'),
  });
}

async function withServer(env, run) {
  const server = createDaemonServer({ env, home: '/nonexistent', config: {} });
  await new Promise((resolve) => { server.listen(0, '127.0.0.1', resolve); });
  const port = server.address().port;
  const call = (pathname, { method = 'GET', body, token = server.token } = {}) =>
    fetch(`http://127.0.0.1:${port}${pathname}`, {
      method,
      headers: {
        ...(token === null ? {} : { authorization: `Bearer ${token}` }),
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: typeof body === 'string' ? body : JSON.stringify(body) }),
    });
  try {
    await run({ call, port, server });
  } finally {
    await new Promise((resolve) => { server.close(resolve); });
  }
}

test('daemon state file follows explicit override, XDG state, then home default', () => {
  assert.equal(
    daemonStateFile({ env: { AGENT_BOT_DAEMON_STATE_PATH: '/tmp/custom-daemon.json' } }),
    '/tmp/custom-daemon.json',
  );
  assert.equal(
    daemonStateFile({ env: { XDG_STATE_HOME: '/tmp/state' }, home: '/home/test' }),
    '/tmp/state/agent-bot/daemon.json',
  );
  assert.equal(
    daemonStateFile({ env: {}, home: '/home/test' }),
    '/home/test/.local/state/agent-bot/daemon.json',
  );
});

test('the daemon refuses every non-loopback bind address', () => {
  assert.equal(assertLoopbackHost('127.0.0.1'), '127.0.0.1');
  assert.equal(assertLoopbackHost('::1'), '::1');
  for (const host of ['0.0.0.0', '::', '192.168.1.10', 'localhost', '', '10.0.0.1']) {
    assert.throws(() => assertLoopbackHost(host), /loopback literal/);
  }
});

test('only loopback peers are recognised', () => {
  assert.equal(isLoopbackPeer('127.0.0.1'), true);
  assert.equal(isLoopbackPeer('::1'), true);
  assert.equal(isLoopbackPeer('::ffff:127.0.0.1'), true);
  assert.equal(isLoopbackPeer('192.168.1.10'), false);
  assert.equal(isLoopbackPeer(undefined), false);
});

test('requests without the per-start token are refused', async () => {
  const { env } = scratchEnv();
  await withServer(env, async ({ call }) => {
    const missing = await call('/v0/health', { token: null });
    assert.equal(missing.status, 401);
    const wrong = await call('/v0/health', { token: 'not-the-token' });
    assert.equal(wrong.status, 401);
    const ok = await call('/v0/health');
    assert.equal(ok.status, 200);
    const body = await ok.json();
    assert.equal(body.status, 'ok');
    assert.equal(body.pid, process.pid);
  });
});

test('space ensure, space path, register, and population share the CLI stores', async () => {
  const { env } = scratchEnv();
  mintIdentity(env);
  await withServer(env, async ({ call }) => {
    const first = await call('/v0/space/ensure', { method: 'POST', body: { agentId: AGENT_ID } });
    assert.equal(first.status, 200);
    const created = await first.json();
    assert.equal(created.created, true);
    assert.equal(created.agentId, AGENT_ID);
    assert.ok(created.path.startsWith(env.AGENT_BOT_SPACES_HOME));

    const again = await call('/v0/space/ensure', { method: 'POST', body: { agentId: AGENT_ID } });
    assert.equal((await again.json()).created, false);

    const where = await call(`/v0/space/path?agentId=${AGENT_ID}`);
    assert.equal((await where.json()).path, created.path);

    const registered = await call('/v0/register', {
      method: 'POST',
      body: { agentId: AGENT_ID, spacePath: created.path },
    });
    assert.equal(registered.status, 200);
    const { soul } = await registered.json();
    assert.equal(soul.id, AGENT_ID);
    assert.equal(soul.appSlug, 'you-codex-agent');
    assert.equal(soul.spacePath, created.path);

    const population = await call('/v0/population');
    const { souls } = await population.json();
    assert.equal(souls.length, 1);
    assert.equal(souls[0].id, AGENT_ID);

    const filtered = await call('/v0/population?app=other-app');
    assert.equal((await filtered.json()).souls.length, 0);
  });
});

test('malformed requests get stable, non-reflecting errors', async () => {
  const { env } = scratchEnv();
  await withServer(env, async ({ call }) => {
    const badId = await call('/v0/space/ensure', {
      method: 'POST',
      body: { agentId: 'agent_../../../etc/passwd' },
    });
    assert.equal(badId.status, 400);
    assert.deepEqual(await badId.json(), { error: 'invalid Agent ID' });

    const badJson = await call('/v0/space/ensure', { method: 'POST', body: '{nope' });
    assert.equal(badJson.status, 400);
    assert.deepEqual(await badJson.json(), { error: 'request body is not valid JSON' });

    const relative = await call('/v0/register', {
      method: 'POST',
      body: { agentId: AGENT_ID, spacePath: 'relative/path' },
    });
    assert.equal(relative.status, 400);

    const unknown = await call('/v0/missing');
    assert.equal(unknown.status, 404);

    const oversized = await call('/v0/space/ensure', {
      method: 'POST',
      body: `{"agentId":"${'x'.repeat(70 * 1024)}"}`,
    });
    assert.equal(oversized.status, 413);
  });
});

test('registering an unknown soul is refused without corrupting the census', async () => {
  const { env } = scratchEnv();
  await withServer(env, async ({ call }) => {
    const response = await call('/v0/register', {
      method: 'POST',
      body: { agentId: AGENT_ID, spacePath: '/somewhere/absolute' },
    });
    assert.equal(response.status, 409);
    assert.equal(existsSync(env.AGENT_BOT_POPULATION_PATH), false);
  });
});

test('daemonStatus reports absent and stale state files distinctly', async () => {
  const { env } = scratchEnv();
  const none = await daemonStatus({ env, home: '/nonexistent' });
  assert.equal(none.running, false);
  assert.match(none.reason, /no daemon state file/);

  writeFileSync(env.AGENT_BOT_DAEMON_STATE_PATH, JSON.stringify({
    schemaVersion: 1,
    pid: 999999,
    port: 1,
    token: 'a'.repeat(64),
    startedAt: '2026-08-12T08:00:00.000Z',
  }));
  const stale = await daemonStatus({ env, home: '/nonexistent', timeoutMs: 200 });
  assert.equal(stale.running, false);
  assert.match(stale.reason, /stale/);
});

test('daemonClient reports unavailable without a running daemon', async () => {
  const { env } = scratchEnv();
  const client = daemonClient({ env, home: '/nonexistent', timeoutMs: 200 });
  assert.equal(await client.available(), false);
  await assert.rejects(client.ensureSpace(AGENT_ID), /daemon is not running/);
});

test('start, status, client operations, and stop round-trip through the real CLI daemon', async () => {
  const { env } = scratchEnv();
  mintIdentity(env);
  const childEnv = { ...process.env, ...env };
  const started = await startDaemon({ env: childEnv, home: '/nonexistent' });
  try {
    assert.equal(started.alreadyRunning, false);
    assert.ok(started.pid > 0);

    const status = await daemonStatus({ env: childEnv, home: '/nonexistent' });
    assert.equal(status.running, true);

    const again = await startDaemon({ env: childEnv, home: '/nonexistent' });
    assert.equal(again.alreadyRunning, true);

    const client = daemonClient({ env: childEnv, home: '/nonexistent' });
    assert.equal(await client.available(), true);
    const space = await client.ensureSpace(AGENT_ID);
    assert.equal(space.created, true);
    const soul = await client.registerSoul(AGENT_ID, space.path);
    assert.equal(soul.id, AGENT_ID);
    const souls = await client.population();
    assert.equal(souls.length, 1);
  } finally {
    const stopped = await stopDaemon({ env: childEnv, home: '/nonexistent' });
    assert.equal(stopped.stopped, true);
  }
  assert.equal(existsSync(env.AGENT_BOT_DAEMON_STATE_PATH), false);
});
