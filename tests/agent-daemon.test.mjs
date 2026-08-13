import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
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
import { mintBindToken } from '../agent-binding.mjs';
import {
  authorizeSouls,
  bindTransport,
  enrollPrincipal,
  setOperations,
} from '../agent-principals.mjs';

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
    AGENT_BOT_PRINCIPALS_PATH: path.join(root, 'principals.json'),
    AGENT_BOT_INTERACTION_HOME: path.join(root, 'interaction'),
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
  const call = (pathname, { method = 'GET', body, token = server.token, headers = {} } = {}) =>
    fetch(`http://127.0.0.1:${port}${pathname}`, {
      method,
      headers: {
        ...(token === null ? {} : { authorization: `Bearer ${token}` }),
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        ...headers,
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

    // v1 interaction contract through the same daemon: enroll locally, then
    // create a session, submit a message, and watch it fail on the
    // documented unconfigured executor.
    const principalOptions = { file: env.AGENT_BOT_PRINCIPALS_PATH, env, home: '/nonexistent' };
    const principal = enrollPrincipal({ label: 'owner' }, principalOptions);
    bindTransport(principal.principalId, { transport: 'cli', providerId: 'owner-local' }, principalOptions);
    authorizeSouls(principal.principalId, [AGENT_ID], principalOptions);
    setOperations(principal.principalId, ['message', 'observe', 'cancel'], principalOptions);

    const requester = { transport: 'cli', providerId: 'owner-local' };
    const { session } = await client.createSession({ ...requester, agentId: AGENT_ID });
    assert.match(session.sessionId, /^session_/);
    const { invocation } = await client.submitMessage(session.sessionId, {
      ...requester,
      message: 'hello from the client',
      idempotencyKey: 'client-1',
    });
    const deadline = Date.now() + 5_000;
    let final = null;
    while (Date.now() < deadline) {
      const { invocation: current } = await client.invocation(invocation.invocationId, requester);
      if (current.status === 'failed') { final = current; break; }
      await new Promise((resolve) => { setTimeout(resolve, 50); });
    }
    assert.equal(final?.error, 'no executor is configured for this daemon');
    const { events } = await client.events(invocation.invocationId, { ...requester, afterSeq: 0 });
    assert.equal(events.at(-1).data.status, 'failed');
    const cancelled = await client.cancel(invocation.invocationId, requester);
    assert.equal(cancelled.alreadyFinished, true);
    const { artifacts } = await client.artifacts(invocation.invocationId, requester);
    assert.deepEqual(artifacts, []);
  } finally {
    const stopped = await stopDaemon({ env: childEnv, home: '/nonexistent' });
    assert.equal(stopped.stopped, true);
  }
  assert.equal(existsSync(env.AGENT_BOT_DAEMON_STATE_PATH), false);
});

test('stop refuses to signal a recorded PID that fails the authenticated probe', async () => {
  const { env } = scratchEnv();
  // Simulate PID reuse after a crash: the record names a live process (this
  // test process) that is not the daemon. stop must remove the stale record
  // without sending it a signal.
  writeFileSync(env.AGENT_BOT_DAEMON_STATE_PATH, JSON.stringify({
    schemaVersion: 1,
    pid: process.pid,
    port: 1,
    token: 'a'.repeat(64),
    startedAt: '2026-08-12T08:00:00.000Z',
  }));
  const result = await stopDaemon({ env, home: '/nonexistent' });
  assert.equal(result.stopped, false);
  assert.match(result.reason, /health probe.*removed stale state/);
  assert.equal(existsSync(env.AGENT_BOT_DAEMON_STATE_PATH), false);
});

test('probes and clients dial the loopback host recorded in the state file', async () => {
  const { env } = scratchEnv();
  const server = createDaemonServer({ env, home: '/nonexistent', config: {} });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '::1', resolve);
  });
  try {
    writeFileSync(env.AGENT_BOT_DAEMON_STATE_PATH, JSON.stringify({
      schemaVersion: 1,
      pid: process.pid,
      host: '::1',
      port: server.address().port,
      token: server.token,
      startedAt: '2026-08-12T08:00:00.000Z',
    }));
    const status = await daemonStatus({ env, home: '/nonexistent' });
    assert.equal(status.running, true);
    const client = daemonClient({ env, home: '/nonexistent' });
    assert.equal(await client.available(), true);
  } finally {
    await new Promise((resolve) => { server.close(resolve); });
  }
});

test('a non-loopback host in the state file is refused as unsupported', async () => {
  const { env } = scratchEnv();
  writeFileSync(env.AGENT_BOT_DAEMON_STATE_PATH, JSON.stringify({
    schemaVersion: 1,
    pid: process.pid,
    host: '192.168.1.10',
    port: 80,
    token: 'a'.repeat(64),
    startedAt: '2026-08-12T08:00:00.000Z',
  }));
  const status = await daemonStatus({ env, home: '/nonexistent' });
  assert.equal(status.running, false);
  assert.match(status.reason, /unsupported shape/);
});

test('the client follows a daemon restart to its new port and token', async () => {
  const { env } = scratchEnv();
  const client = daemonClient({ env, home: '/nonexistent' });

  async function serve() {
    const server = createDaemonServer({ env, home: '/nonexistent', config: {} });
    await new Promise((resolve) => { server.listen(0, '127.0.0.1', resolve); });
    writeFileSync(env.AGENT_BOT_DAEMON_STATE_PATH, JSON.stringify({
      schemaVersion: 1,
      pid: process.pid,
      host: '127.0.0.1',
      port: server.address().port,
      token: server.token,
      startedAt: '2026-08-12T08:00:00.000Z',
    }));
    return server;
  }

  const first = await serve();
  assert.equal(await client.available(), true);
  const before = await client.population();
  assert.deepEqual(before, []);
  await new Promise((resolve) => { first.close(resolve); });

  // New daemon, new port, new per-start token — same long-lived client.
  const second = await serve();
  try {
    assert.equal(await client.available(), true);
    const after = await client.population();
    assert.deepEqual(after, []);
  } finally {
    await new Promise((resolve) => { second.close(resolve); });
  }
});

// --- surrender-and-enforce binding (#94) ---

function mintWorktreeToken(env, root, { id = AGENT_ID } = {}) {
  const identity = mintIdentity(env, { id });
  const gitDir = path.join(root, 'gitdir');
  mkdirSync(gitDir, { recursive: true });
  const worktree = path.join(root, 'worktree');
  const record = mintBindToken({ gitDir, worktree, agentId: identity.id });
  return { identity, gitDir, worktree, record };
}

test('bind consumes the worktree token and exchanges it for a live binding', async () => {
  const { root, env } = scratchEnv();
  const { gitDir, worktree, record } = mintWorktreeToken(env, root);
  await withServer(env, async ({ call }) => {
    const res = await call('/v0/bind', {
      method: 'POST',
      body: {
        gitDir,
        token: record.token,
        transcript: { provider: 'codex', id: 'thread-daemon' },
      },
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.agentId, AGENT_ID);
    assert.equal(body.worktree, worktree);
    assert.equal(body.repinRequired, false);
    assert.match(body.secret, /^[0-9a-f]{64}$/);
    // Consumed: the file is gone and a replay finds nothing to present.
    assert.equal(existsSync(path.join(gitDir, 'agent-bind-token.json')), false);
    const replay = await call('/v0/bind', {
      method: 'POST',
      body: { gitDir, token: record.token, transcript: { provider: 'codex', id: 'thread-daemon' } },
    });
    assert.equal(replay.status, 403);
  });
});

test('binding whoami answers only to the connection secret', async () => {
  const { root, env } = scratchEnv();
  const { gitDir, worktree, record } = mintWorktreeToken(env, root);
  await withServer(env, async ({ call }) => {
    const bound = await (await call('/v0/bind', {
      method: 'POST',
      body: { gitDir, token: record.token, transcript: { provider: 'codex', id: 'thread-daemon' } },
    })).json();

    const anonymous = await call('/v0/binding');
    assert.equal(anonymous.status, 401);

    const forged = await call('/v0/binding', { headers: { 'x-agent-binding': 'f'.repeat(64) } });
    assert.equal(forged.status, 401);

    const who = await call('/v0/binding', { headers: { 'x-agent-binding': bound.secret } });
    assert.equal(who.status, 200);
    const { binding } = await who.json();
    assert.equal(binding.agentId, AGENT_ID);
    assert.equal(binding.worktree, worktree);
    assert.equal(binding.transcript.id, 'thread-daemon');
  });
});

test('bind refuses a wrong token and leaves the minted token in place', async () => {
  const { root, env } = scratchEnv();
  const { gitDir } = mintWorktreeToken(env, root);
  await withServer(env, async ({ call }) => {
    const res = await call('/v0/bind', {
      method: 'POST',
      body: { gitDir, token: 'f'.repeat(64), transcript: { provider: 'codex', id: 't' } },
    });
    assert.equal(res.status, 403);
    assert.equal(existsSync(path.join(gitDir, 'agent-bind-token.json')), true);
  });
});

test('bind requires a transcript locator — the conversation half is not optional', async () => {
  const { root, env } = scratchEnv();
  const { gitDir, record } = mintWorktreeToken(env, root);
  await withServer(env, async ({ call }) => {
    const res = await call('/v0/bind', {
      method: 'POST',
      body: { gitDir, token: record.token },
    });
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.match(body.error, /transcript locator/);
    // Refusal happens after consumption would be wrong; the token must survive
    // a rejected bind so the conversation can retry with a locator.
    assert.equal(existsSync(path.join(gitDir, 'agent-bind-token.json')), true);
  });
});

test('bind records provenance on the census row (#91)', async () => {
  const { root, env } = scratchEnv();
  const parentId = 'agent_22222222-2222-4222-8222-222222222222';
  mintIdentity(env, { id: parentId });
  const { gitDir, record } = mintWorktreeToken(env, root);
  await withServer(env, async ({ call }) => {
    const bound = await (await call('/v0/bind', {
      method: 'POST',
      body: {
        gitDir,
        token: record.token,
        transcript: { provider: 'codex', id: 'thread-daemon' },
        parentId,
      },
    })).json();
    assert.equal(bound.soul.transcriptLocator.provider, 'codex');
    assert.equal(bound.soul.transcriptLocator.id, 'thread-daemon');
    assert.equal(bound.soul.parentId, parentId);
  });
});

test('bind refuses to rewrite recorded lineage', async () => {
  const { root, env } = scratchEnv();
  const parentId = 'agent_22222222-2222-4222-8222-222222222222';
  const otherParent = 'agent_44444444-4444-4444-8444-444444444444';
  mintIdentity(env, { id: parentId });
  mintIdentity(env, { id: otherParent });
  const { gitDir, record } = mintWorktreeToken(env, root);
  await withServer(env, async ({ call }) => {
    await call('/v0/bind', {
      method: 'POST',
      body: {
        gitDir,
        token: record.token,
        transcript: { provider: 'codex', id: 'thread-daemon' },
        parentId,
      },
    });
    // Fresh mint, same worktree, different asserted parent: refused.
    const again = mintBindToken({ gitDir, worktree: path.join(root, 'worktree'), agentId: AGENT_ID });
    const res = await call('/v0/bind', {
      method: 'POST',
      body: {
        gitDir,
        token: again.token,
        transcript: { provider: 'codex', id: 'thread-daemon' },
        parentId: otherParent,
      },
    });
    assert.equal(res.status, 409);
  });
});

test('a new conversation reusing the worktree binds a fresh identity and asks for a repin', async () => {
  const { root, env } = scratchEnv();
  const { gitDir, worktree, record } = mintWorktreeToken(env, root);
  await withServer(env, async ({ call }) => {
    await call('/v0/bind', {
      method: 'POST',
      body: { gitDir, token: record.token, transcript: { provider: 'codex', id: 'thread-daemon' } },
    });
    const again = mintBindToken({ gitDir, worktree, agentId: AGENT_ID });
    const res = await call('/v0/bind', {
      method: 'POST',
      body: { gitDir, token: again.token, transcript: { provider: 'codex', id: 'thread-later' } },
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.notEqual(body.agentId, AGENT_ID);
    assert.equal(body.repinRequired, true);
    assert.equal(body.soul.transcriptLocator.id, 'thread-later');
  });
});

test('tier-1 credential minting answers only a live binding and receipts both outcomes (#90)', async () => {
  const { root, env } = scratchEnv();
  const { gitDir, record } = mintWorktreeToken(env, root);
  const minted = [];
  const server = createDaemonServer({
    env,
    home: '/nonexistent',
    config: {},
    mintImpl: async ({ slug }) => {
      minted.push(slug);
      return { token: 'ghs_test-grant', expires_at: '2026-08-12T09:00:00.000Z' };
    },
  });
  await new Promise((resolve) => { server.listen(0, '127.0.0.1', resolve); });
  const port = server.address().port;
  const call = (pathname, options = {}) =>
    fetch(`http://127.0.0.1:${port}${pathname}`, {
      method: options.method ?? 'GET',
      headers: {
        authorization: `Bearer ${server.token}`,
        ...(options.body === undefined ? {} : { 'content-type': 'application/json' }),
        ...(options.headers ?? {}),
      },
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
    });
  try {
    // No binding, no credential — and the refusal is receipted.
    const denied = await call('/v0/credential', { method: 'POST', body: {} });
    assert.equal(denied.status, 401);
    assert.equal(minted.length, 0);

    const bound = await (await call('/v0/bind', {
      method: 'POST',
      body: { gitDir, token: record.token, transcript: { provider: 'codex', id: 'thread-daemon' } },
    })).json();
    const granted = await call('/v0/credential', {
      method: 'POST',
      body: {},
      headers: { 'x-agent-binding': bound.secret },
    });
    assert.equal(granted.status, 200);
    const grant = await granted.json();
    // The App and identity derive from the binding; the request named neither.
    assert.equal(grant.agentId, AGENT_ID);
    assert.equal(grant.appSlug, 'you-codex-agent');
    assert.equal(grant.token, 'ghs_test-grant');
    assert.deepEqual(minted, ['you-codex-agent']);

    const receipts = readFileSync(path.join(env.AGENT_BOT_INTERACTION_HOME, 'audit.jsonl'), 'utf8')
      .trim().split('\n').map((line) => JSON.parse(line))
      .filter((receipt) => receipt.event === 'credential-mint');
    assert.deepEqual(receipts.map((receipt) => receipt.decision), ['denied', 'granted']);
    assert.equal(receipts[1].agentId, AGENT_ID);
    // The receipt records who and what — never the credential itself.
    assert.doesNotMatch(JSON.stringify(receipts), /ghs_test-grant/);
  } finally {
    await new Promise((resolve) => { server.close(resolve); });
  }
});

test('a daemon restart drops every binding — re-binding takes a fresh mint', async () => {
  const { root, env } = scratchEnv();
  const { gitDir, worktree, record } = mintWorktreeToken(env, root);
  let secret;
  await withServer(env, async ({ call }) => {
    const bound = await (await call('/v0/bind', {
      method: 'POST',
      body: { gitDir, token: record.token, transcript: { provider: 'codex', id: 'thread-daemon' } },
    })).json();
    secret = bound.secret;
  });
  await withServer(env, async ({ call }) => {
    const stale = await call('/v0/binding', { headers: { 'x-agent-binding': secret } });
    assert.equal(stale.status, 401);
    // Fresh mint from the same worktree re-establishes the binding.
    const again = mintBindToken({ gitDir, worktree, agentId: AGENT_ID });
    const rebound = await call('/v0/bind', {
      method: 'POST',
      body: { gitDir, token: again.token, transcript: { provider: 'codex', id: 'thread-daemon' } },
    });
    assert.equal(rebound.status, 200);
    assert.equal((await rebound.json()).agentId, AGENT_ID);
  });
});
