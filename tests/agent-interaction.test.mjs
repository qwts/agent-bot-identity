import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  MAX_MESSAGE_BYTES,
  UNCONFIGURED_EXECUTOR_ERROR,
  createInteractionService,
} from '../agent-interaction.mjs';
import { createDaemonServer } from '../agent-daemon.mjs';
import { getInvocation, interactionHome } from '../agent-jobs.mjs';
import {
  authorizeSouls,
  bindTransport,
  enrollPrincipal,
  setOperations,
} from '../agent-principals.mjs';
import { updateSoulStatus, upsertSoul } from '../agent-population.mjs';

const AGENT_ID = 'agent_11111111-1111-4111-8111-111111111111';
const OTHER_ID = 'agent_22222222-2222-4222-8222-222222222222';
const roots = [];

after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

function scratch() {
  const root = mkdtempSync(path.join(tmpdir(), 'agent-interaction-'));
  roots.push(root);
  const env = {
    AGENT_BOT_INTERACTION_HOME: path.join(root, 'interaction'),
    AGENT_BOT_POPULATION_PATH: path.join(root, 'population.json'),
    AGENT_BOT_PRINCIPALS_PATH: path.join(root, 'principals.json'),
  };
  return { root, env };
}

function seedSoul(env, { id = AGENT_ID, status = 'active' } = {}) {
  return upsertSoul({
    id,
    appSlug: 'you-codex-agent',
    parentId: null,
    status,
    spacePath: `/spaces/${id}`,
    transcriptLocator: null,
    lastSeen: '2026-08-12T08:00:00.000Z',
  }, { file: env.AGENT_BOT_POPULATION_PATH });
}

function seedPrincipal(env, {
  souls = [AGENT_ID],
  operations = ['message', 'observe', 'cancel'],
  transport = 'web',
  providerId = 'owner-subject',
} = {}) {
  const options = { file: env.AGENT_BOT_PRINCIPALS_PATH, env, home: '/nonexistent' };
  const principal = enrollPrincipal({ label: 'owner' }, options);
  bindTransport(principal.principalId, { transport, providerId }, options);
  authorizeSouls(principal.principalId, souls, options);
  return setOperations(principal.principalId, operations, options);
}

function service(env, overrides = {}) {
  return createInteractionService({ env, home: '/nonexistent', config: {}, ...overrides });
}

async function waitFor(probe, { timeoutMs = 5_000, intervalMs = 15 } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await probe();
    if (value) return value;
    if (Date.now() >= deadline) throw new Error('condition not reached in time');
    await new Promise((resolve) => { setTimeout(resolve, intervalMs); });
  }
}

test('unknown, retired, and unauthorized souls are rejected before any job exists', () => {
  const { env } = scratch();
  seedSoul(env);
  seedSoul(env, { id: OTHER_ID, status: 'retired' });
  const principal = seedPrincipal(env, { souls: [AGENT_ID, OTHER_ID] });
  const interaction = service(env);

  assert.throws(
    () => interaction.createOrContinueSession({
      principal,
      transport: 'web',
      agentId: 'agent_33333333-3333-4333-8333-333333333333',
    }),
    (error) => error.statusCode === 403 && /not authorized/.test(error.message),
  );
  assert.throws(
    () => interaction.createOrContinueSession({ principal, transport: 'web', agentId: OTHER_ID }),
    (error) => error.statusCode === 409 && /not available for interaction/.test(error.message),
  );

  const limited = seedPrincipal(env, {
    souls: [],
    transport: 'telegram',
    providerId: '42',
  });
  assert.throws(
    () => interaction.createOrContinueSession({ principal: limited, transport: 'telegram', agentId: AGENT_ID }),
    (error) => error.statusCode === 403,
  );

  // Authorization and resolution failures never created a session or a job.
  assert.equal(existsSync(path.join(interactionHome({ env, home: '/nonexistent' }), 'sessions.json')), false);
  assert.equal(existsSync(path.join(interactionHome({ env, home: '/nonexistent' }), 'jobs.json')), false);

  // An unknown soul that IS inside a wildcard authorization still fails
  // closed at population resolution.
  const wildcard = seedPrincipal(env, {
    souls: ['*'],
    transport: 'cli',
    providerId: 'local',
  });
  assert.throws(
    () => interaction.createOrContinueSession({
      principal: wildcard,
      transport: 'cli',
      agentId: 'agent_44444444-4444-4444-8444-444444444444',
    }),
    (error) => error.statusCode === 404 && /unknown soul/.test(error.message),
  );
});

test('sessions continue only for the same principal, soul, and transport', () => {
  const { env } = scratch();
  seedSoul(env);
  const principal = seedPrincipal(env);
  const interaction = service(env);

  const first = interaction.createOrContinueSession({ principal, transport: 'web', agentId: AGENT_ID });
  assert.equal(first.created, true);
  const resumed = interaction.createOrContinueSession({
    principal,
    transport: 'web',
    agentId: AGENT_ID,
    sessionId: first.session.sessionId,
  });
  assert.equal(resumed.created, false);
  assert.equal(resumed.session.sessionId, first.session.sessionId);

  const stranger = seedPrincipal(env, { transport: 'telegram', providerId: '42' });
  assert.throws(
    () => interaction.createOrContinueSession({
      principal: stranger,
      transport: 'telegram',
      agentId: AGENT_ID,
      sessionId: first.session.sessionId,
    }),
    (error) => error.statusCode === 404 && /unknown session/.test(error.message),
  );
});

test('identity domains stay distinct and transport identity is never persisted', () => {
  const { env } = scratch();
  seedSoul(env);
  const principal = seedPrincipal(env);
  const interaction = service(env);
  const { session } = interaction.createOrContinueSession({ principal, transport: 'web', agentId: AGENT_ID });
  const { invocation } = interaction.submitMessage({
    principal,
    transport: 'web',
    sessionId: session.sessionId,
    message: 'hello',
    idempotencyKey: 'domain-check',
  });

  assert.match(principal.principalId, /^principal_/);
  assert.match(session.sessionId, /^session_/);
  assert.match(session.agentId, /^agent_/);
  assert.match(invocation.invocationId, /^invocation_/);
  for (const record of [session, invocation]) {
    assert.equal('providerId' in record, false);
    assert.equal('label' in record, false);
  }
  // The provider-side identity lives only in the principal binding; the
  // durable interaction store never sees it.
  const stores = ['sessions.json', 'jobs.json'].map((name) => (
    readFileSync(path.join(interactionHome({ env, home: '/nonexistent' }), name), 'utf8')
  ));
  for (const raw of stores) assert.equal(raw.includes('owner-subject'), false);
});

test('the unconfigured executor fails invocations with a stable documented error', async () => {
  const { env } = scratch();
  seedSoul(env);
  const principal = seedPrincipal(env);
  const interaction = service(env);
  const { session } = interaction.createOrContinueSession({ principal, transport: 'web', agentId: AGENT_ID });
  const { invocation, duplicate } = interaction.submitMessage({
    principal,
    transport: 'web',
    sessionId: session.sessionId,
    message: 'do something',
    idempotencyKey: 'first-try',
  });
  assert.equal(duplicate, false);
  assert.equal(invocation.status, 'queued');

  const failed = await waitFor(() => {
    const current = getInvocation(invocation.invocationId, { env, home: '/nonexistent' });
    return current.status === 'failed' ? current : null;
  });
  assert.equal(failed.error, UNCONFIGURED_EXECUTOR_ERROR);

  const { events } = interaction.readEvents({
    principal,
    transport: 'web',
    invocationId: invocation.invocationId,
  });
  assert.deepEqual(
    events.map((event) => event.type),
    ['status', 'status', 'executor-unconfigured', 'status'],
  );
  assert.deepEqual(events.at(-1).data, { status: 'failed', error: UNCONFIGURED_EXECUTOR_ERROR });

  // Retried delivery returns the same invocation without new work or events.
  const retry = interaction.submitMessage({
    principal,
    transport: 'web',
    sessionId: session.sessionId,
    message: 'do something',
    idempotencyKey: 'first-try',
  });
  assert.equal(retry.duplicate, true);
  assert.equal(retry.invocation.invocationId, invocation.invocationId);
  const after = interaction.readEvents({
    principal,
    transport: 'web',
    invocationId: invocation.invocationId,
  });
  assert.equal(after.events.length, events.length);
  // Resumable cursor: only events after the supplied seq come back.
  const tail = interaction.readEvents({
    principal,
    transport: 'web',
    invocationId: invocation.invocationId,
    afterSeq: events.at(-2).seq,
  });
  assert.deepEqual(tail.events.map((event) => event.seq), [events.at(-1).seq]);
});

test('cooperative cancellation stops a running executor and reports stopped: true', async () => {
  const { env } = scratch();
  seedSoul(env);
  const principal = seedPrincipal(env);
  const interaction = service(env, {
    executor: ({ signal }) => new Promise((resolve, reject) => {
      const timer = setTimeout(resolve, 30_000);
      signal.addEventListener('abort', () => {
        clearTimeout(timer);
        reject(new Error('aborted'));
      });
    }),
  });
  const { session } = interaction.createOrContinueSession({ principal, transport: 'web', agentId: AGENT_ID });
  const { invocation } = interaction.submitMessage({
    principal,
    transport: 'web',
    sessionId: session.sessionId,
    message: 'long task',
    idempotencyKey: 'slow-1',
  });
  await waitFor(() => (
    getInvocation(invocation.invocationId, { env, home: '/nonexistent' }).status === 'running'
  ));

  const outcome = await interaction.cancelInvocation({
    principal,
    transport: 'web',
    invocationId: invocation.invocationId,
  });
  assert.deepEqual(outcome, {
    invocationId: invocation.invocationId,
    status: 'cancelled',
    stopped: true,
    alreadyFinished: false,
  });
  const { events } = interaction.readEvents({
    principal,
    transport: 'web',
    invocationId: invocation.invocationId,
  });
  assert.deepEqual(
    events.map((event) => event.data.status),
    ['queued', 'running', 'cancel-requested', 'cancelled'],
  );
});

test('cancelling finished work is a truthful no-op', async () => {
  const { env } = scratch();
  seedSoul(env);
  const principal = seedPrincipal(env);
  const interaction = service(env, { executor: async () => {} });
  const { session } = interaction.createOrContinueSession({ principal, transport: 'web', agentId: AGENT_ID });
  const { invocation } = interaction.submitMessage({
    principal,
    transport: 'web',
    sessionId: session.sessionId,
    message: 'quick task',
    idempotencyKey: 'quick-1',
  });
  await waitFor(() => (
    getInvocation(invocation.invocationId, { env, home: '/nonexistent' }).status === 'completed'
  ));

  const outcome = await interaction.cancelInvocation({
    principal,
    transport: 'web',
    invocationId: invocation.invocationId,
  });
  assert.deepEqual(outcome, {
    invocationId: invocation.invocationId,
    status: 'completed',
    stopped: false,
    alreadyFinished: true,
  });
});

test('message schema validation is strict, bounded, and non-reflecting', () => {
  const { env } = scratch();
  seedSoul(env);
  const principal = seedPrincipal(env);
  const interaction = service(env);
  const { session } = interaction.createOrContinueSession({ principal, transport: 'web', agentId: AGENT_ID });
  const base = { principal, transport: 'web', sessionId: session.sessionId, idempotencyKey: 'valid-key' };

  const cases = [
    [{ ...base, message: '' }, /non-empty string/],
    [{ ...base, message: 42 }, /non-empty string/],
    [{ ...base, message: 'x'.repeat(MAX_MESSAGE_BYTES + 1) }, /bounded message size/],
    [{ ...base, message: 'bell\x07noise' }, /control characters/],
    [{ ...base, message: 'ok', idempotencyKey: 'has space' }, /invalid idempotency key/],
    [{ ...base, message: 'ok', idempotencyKey: undefined }, /invalid idempotency key/],
    [{ ...base, message: 'ok', attachments: ['ok', 42] }, /opaque references/],
    [{ ...base, message: 'ok', attachments: new Array(17).fill('r') }, /opaque references/],
    [{ ...base, message: 'ok', sessionId: 'session_ffffffff-ffff-4fff-8fff-ffffffffffff' }, /unknown session/],
  ];
  for (const [request, expected] of cases) {
    assert.throws(() => interaction.submitMessage(request), expected);
  }
  // Multiline text is legitimate message content.
  const ok = interaction.submitMessage({ ...base, message: 'line one\nline two\ttabbed' });
  assert.equal(ok.duplicate, false);
});

async function withServer(env, executor, run) {
  const server = createDaemonServer({ env, home: '/nonexistent', config: {}, executor });
  await new Promise((resolve) => { server.listen(0, '127.0.0.1', resolve); });
  const port = server.address().port;
  const call = (pathname, { method = 'GET', body, token = server.token } = {}) =>
    fetch(`http://127.0.0.1:${port}${pathname}`, {
      method,
      headers: {
        ...(token === null ? {} : { authorization: `Bearer ${token}` }),
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  try {
    await run({ call });
  } finally {
    await new Promise((resolve) => { server.close(resolve); });
  }
}

const REQUESTER = { transport: 'web', providerId: 'owner-subject' };

test('daemon /v1 requires the bearer token and an enrolled principal', async () => {
  const { env } = scratch();
  seedSoul(env);
  seedPrincipal(env);
  await withServer(env, undefined, async ({ call }) => {
    const missing = await call('/v1/sessions', {
      method: 'POST',
      body: { ...REQUESTER, agentId: AGENT_ID },
      token: null,
    });
    assert.equal(missing.status, 401);

    const malformed = await call('/v1/sessions', {
      method: 'POST',
      body: { transport: 'Not Valid', providerId: 'owner-subject', agentId: AGENT_ID },
    });
    assert.equal(malformed.status, 400);
    assert.deepEqual(await malformed.json(), { error: 'invalid transport principal' });

    const unknown = await call('/v1/sessions', {
      method: 'POST',
      body: { transport: 'web', providerId: 'stranger', agentId: AGENT_ID },
    });
    assert.equal(unknown.status, 403);
    assert.deepEqual(await unknown.json(), { error: 'principal is not authorized for this operation' });

    // The refusal left a secret-free denial receipt.
    const audit = readFileSync(
      path.join(interactionHome({ env, home: '/nonexistent' }), 'audit.jsonl'),
      'utf8',
    );
    assert.match(audit, /"event":"denied-request"/);
    assert.equal(audit.includes('stranger'), false);

    const route = await call('/v1/unknown', { method: 'POST', body: { ...REQUESTER } });
    assert.equal(route.status, 404);
  });
});

test('daemon /v1 round trip: session, message, events, cancel, artifacts', async () => {
  const { env } = scratch();
  seedSoul(env);
  seedPrincipal(env);
  await withServer(env, undefined, async ({ call }) => {
    const created = await call('/v1/sessions', {
      method: 'POST',
      body: { ...REQUESTER, agentId: AGENT_ID },
    });
    assert.equal(created.status, 200);
    const { session } = await created.json();
    assert.match(session.sessionId, /^session_/);

    const submitted = await call(`/v1/sessions/${session.sessionId}/messages`, {
      method: 'POST',
      body: { ...REQUESTER, message: 'hello daemon', idempotencyKey: 'round-1' },
    });
    assert.equal(submitted.status, 200);
    const { invocation } = await submitted.json();

    const query = new URLSearchParams(REQUESTER).toString();
    const failed = await waitFor(async () => {
      const res = await call(`/v1/invocations/${invocation.invocationId}?${query}`);
      const body = await res.json();
      return body.invocation.status === 'failed' ? body.invocation : null;
    });
    assert.equal(failed.error, UNCONFIGURED_EXECUTOR_ERROR);

    const events = await call(`/v1/invocations/${invocation.invocationId}/events?${query}&after=0`);
    const eventBody = await events.json();
    assert.equal(eventBody.events.at(-1).data.status, 'failed');
    const resumed = await call(
      `/v1/invocations/${invocation.invocationId}/events?${query}&after=${eventBody.events.at(-1).seq}`,
    );
    assert.deepEqual(await resumed.json(), { events: [] });

    const duplicate = await call(`/v1/sessions/${session.sessionId}/messages`, {
      method: 'POST',
      body: { ...REQUESTER, message: 'hello daemon', idempotencyKey: 'round-1' },
    });
    const duplicateBody = await duplicate.json();
    assert.equal(duplicateBody.duplicate, true);
    assert.equal(duplicateBody.invocation.invocationId, invocation.invocationId);

    const cancelled = await call(`/v1/invocations/${invocation.invocationId}/cancel`, {
      method: 'POST',
      body: { ...REQUESTER },
    });
    const cancelBody = await cancelled.json();
    assert.equal(cancelBody.alreadyFinished, true);
    assert.equal(cancelBody.stopped, false);

    const artifacts = await call(`/v1/invocations/${invocation.invocationId}/artifacts?${query}`);
    assert.deepEqual(await artifacts.json(), { artifacts: [] });
  });
});

test('daemon /v1 cancels running work and rejects malformed or foreign input', async () => {
  const { env } = scratch();
  seedSoul(env);
  seedPrincipal(env, { souls: [AGENT_ID] });
  const executor = ({ signal }) => new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, 30_000);
    signal.addEventListener('abort', () => {
      clearTimeout(timer);
      reject(new Error('aborted'));
    });
  });
  await withServer(env, executor, async ({ call }) => {
    const badAgent = await call('/v1/sessions', {
      method: 'POST',
      body: { ...REQUESTER, agentId: 'agent_../../etc' },
    });
    assert.equal(badAgent.status, 400);
    assert.deepEqual(await badAgent.json(), { error: 'invalid Agent ID' });

    const foreign = await call('/v1/sessions', {
      method: 'POST',
      body: { ...REQUESTER, agentId: OTHER_ID },
    });
    assert.equal(foreign.status, 403);

    const { session } = await (await call('/v1/sessions', {
      method: 'POST',
      body: { ...REQUESTER, agentId: AGENT_ID },
    })).json();
    const oversized = await call(`/v1/sessions/${session.sessionId}/messages`, {
      method: 'POST',
      body: { ...REQUESTER, message: 'x'.repeat(MAX_MESSAGE_BYTES + 1), idempotencyKey: 'big' },
    });
    assert.equal(oversized.status, 400);
    assert.deepEqual(await oversized.json(), { error: 'message exceeds the bounded message size' });

    const { invocation } = await (await call(`/v1/sessions/${session.sessionId}/messages`, {
      method: 'POST',
      body: { ...REQUESTER, message: 'long task', idempotencyKey: 'slow-daemon' },
    })).json();
    await waitFor(() => (
      getInvocation(invocation.invocationId, { env, home: '/nonexistent' }).status === 'running'
    ));
    const cancelled = await call(`/v1/invocations/${invocation.invocationId}/cancel`, {
      method: 'POST',
      body: { ...REQUESTER },
    });
    const cancelBody = await cancelled.json();
    assert.equal(cancelBody.status, 'cancelled');
    assert.equal(cancelBody.stopped, true);
  });
});
