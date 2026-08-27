import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

import { ACP_SPAWN_REGISTRY } from '../acp-registry.mjs';
import { createAcpExecutor } from '../acp-engine.mjs';
import { HARNESS_SESSION_EVENT, STOP_EVENT, UPDATE_EVENT } from '../executor-contract.mjs';
import { createInteractionService } from '../agent-interaction.mjs';
import {
  authorizeSouls,
  bindTransport,
  enrollPrincipal,
  setOperations,
} from '../agent-principals.mjs';
import { upsertSoul } from '../agent-population.mjs';

const MUSE_ACP = fileURLToPath(new URL('../muse-acp.mjs', import.meta.url));
const FAKE_MUSE = fileURLToPath(new URL('./fixtures/fake-muse.mjs', import.meta.url));
const AGENT_ID = 'agent_11111111-1111-4111-8111-111111111111';
const MUSE_IDENTITY = { app: 'qwts-muse-agent', agentId: AGENT_ID };
const ALLOW_ALL = { version: 1, rules: [], fallback: 'allow' };
const PERSISTED_SESSION = '7e57c0de-0002-4bad-8bad-c0ffee000002';

const roots = [];
after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

function scratchDir(prefix) {
  const root = mkdtempSync(path.join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

// A Muse store containing one persisted session log, in the real shard
// layout (sessions/<Y>/<M>/<D>/<uuid>/session.jsonl) with the envelope
// shapes probed from Muse Code 0.2.1.
function seedMuseStore(sessionId = PERSISTED_SESSION) {
  const store = scratchDir('muse-store-');
  const dir = path.join(store, 'sessions', '2026', '08', '27', sessionId);
  mkdirSync(dir, { recursive: true });
  const record = (payload) => `${JSON.stringify({
    schema_version: 1,
    id: 'seed',
    stream: { kind: 'session', id: sessionId },
    sequence: 1,
    recorded_at: 0,
    record_type: 'event',
    durability: 'durable',
    causation_id: null,
    payload_type: 'runtime.session',
    payload_schema_version: 1,
    payload,
  })}\n`;
  writeFileSync(path.join(dir, 'session.jsonl'), [
    record({ kind: 'metadata', record: { provider_id: 'echo' } }),
    record({
      kind: 'run',
      run_id: 'run-1',
      event: { kind: 'started', prompt: 'earlier prompt' },
    }),
    record({
      kind: 'run',
      run_id: 'run-1',
      event: { kind: 'assistant_message_committed', message_id: 'm1', text: 'earlier reply' },
    }),
  ].join(''));
  return store;
}

function adapterEnv(store) {
  return {
    ...process.env,
    MUSE_ACP_MUSE_BIN: FAKE_MUSE,
    MUSE_ACP_STORE: store,
    MUSE_ACP_PROVIDER: 'echo',
  };
}

// --- adapter-level: drive muse-acp the way the engine does ------------------

function startAdapter(store) {
  const child = spawn(process.execPath, [MUSE_ACP], {
    env: adapterEnv(store),
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let nextId = 1;
  const pending = new Map();
  const notifications = [];
  const waiters = [];
  const lines = createInterface({ input: child.stdout });
  lines.on('line', (line) => {
    let payload;
    try {
      payload = JSON.parse(line);
    } catch {
      return;
    }
    if (payload.id !== undefined && payload.method === undefined) {
      const entry = pending.get(payload.id);
      if (!entry) return;
      pending.delete(payload.id);
      if (payload.error) entry.reject(new Error(payload.error.message));
      else entry.resolve(payload.result);
      return;
    }
    if (payload.method === 'session/update') {
      notifications.push(payload.params);
      for (const waiter of waiters.splice(0)) waiter();
    }
  });
  return {
    child,
    notifications,
    request(method, params) {
      return new Promise((resolve, reject) => {
        const id = nextId;
        nextId += 1;
        pending.set(id, { resolve, reject });
        child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
      });
    },
    notify(method, params) {
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`);
    },
    async waitForNotification(predicate) {
      for (;;) {
        if (notifications.some(predicate)) return;
        await new Promise((resolve) => waiters.push(resolve));
      }
    },
    stop() {
      child.kill('SIGKILL');
    },
  };
}

test('muse-acp initializes, mints uuid sessions, and forwards the exec argv contract', async () => {
  const adapter = startAdapter(seedMuseStore());
  try {
    const init = await adapter.request('initialize', { protocolVersion: 1 });
    assert.equal(init.protocolVersion, 1);
    assert.equal(init.agentCapabilities.loadSession, true);
    assert.equal(init.agentCapabilities.promptCapabilities.image, false);

    await assert.rejects(adapter.request('session/new', {}), /requires a cwd/);
    const cwd = scratchDir('muse-cwd-');
    const { sessionId } = await adapter.request('session/new', { cwd, mcpServers: [] });
    assert.match(sessionId, /^[0-9a-f-]{36}$/);

    const result = await adapter.request('session/prompt', {
      sessionId,
      prompt: [{ type: 'text', text: 'argv-probe' }],
    });
    assert.deepEqual(result, { stopReason: 'end_turn' });
    const probe = JSON.parse(adapter.notifications[0].update.content.text);
    assert.equal(probe.sessionId, sessionId);
    assert.equal(probe.workspace, cwd);
    assert.equal(probe.provider, 'echo');
    assert.equal(realpathSync(probe.cwd), realpathSync(cwd));
  } finally {
    adapter.stop();
  }
});

test('muse-acp translates deltas and task lifecycles, skipping model tasks', async () => {
  const adapter = startAdapter(seedMuseStore());
  try {
    await adapter.request('initialize', { protocolVersion: 1 });
    const { sessionId } = await adapter.request('session/new', { cwd: scratchDir('muse-cwd-') });
    const result = await adapter.request('session/prompt', {
      sessionId,
      prompt: [{ type: 'text', text: 'ping' }],
    });
    assert.deepEqual(result, { stopReason: 'end_turn' });
    const updates = adapter.notifications.map((n) => n.update);
    assert.deepEqual(updates.map((u) => u.sessionUpdate), [
      'agent_message_chunk',
      'tool_call',
      'tool_call_update',
    ]);
    assert.equal(updates[0].content.text, 'muse says: ping');
    assert.deepEqual(updates[1], {
      sessionUpdate: 'tool_call',
      toolCallId: 'task-tool',
      title: 'workspace.read_file',
      kind: 'other',
    });
    assert.deepEqual(updates[2], {
      sessionUpdate: 'tool_call_update',
      toolCallId: 'task-tool',
      status: 'completed',
    });
  } finally {
    adapter.stop();
  }
});

test('muse-acp surfaces failed and terminal-less runs as errors, cancel as cancelled', async () => {
  const adapter = startAdapter(seedMuseStore());
  try {
    await adapter.request('initialize', { protocolVersion: 1 });
    const cwd = scratchDir('muse-cwd-');
    const { sessionId } = await adapter.request('session/new', { cwd });
    await assert.rejects(
      adapter.request('session/prompt', { sessionId, prompt: [{ type: 'text', text: 'fail-run' }] }),
      /muse run failed: provider exploded/,
    );
    await assert.rejects(
      adapter.request('session/prompt', { sessionId, prompt: [{ type: 'text', text: 'no-terminal' }] }),
      /without a terminal event/,
    );

    const hanging = adapter.request('session/prompt', {
      sessionId,
      prompt: [{ type: 'text', text: 'hang' }],
    });
    await adapter.waitForNotification((n) => n.update?.content?.text === 'hanging now');
    adapter.notify('session/cancel', { sessionId });
    assert.deepEqual(await hanging, { stopReason: 'cancelled' });
  } finally {
    adapter.stop();
  }
});

test('muse-acp loads a persisted session from the muse store and replays it', async () => {
  const adapter = startAdapter(seedMuseStore());
  try {
    await adapter.request('initialize', { protocolVersion: 1 });
    const cwd = scratchDir('muse-cwd-');
    await assert.rejects(
      adapter.request('session/load', { sessionId: '00000000-0000-4000-8000-000000000000', cwd }),
      /no persisted muse session/,
    );
    await adapter.request('session/load', { sessionId: PERSISTED_SESSION, cwd });
    assert.equal(adapter.notifications.length, 1);
    assert.equal(adapter.notifications[0].sessionId, PERSISTED_SESSION);
    assert.equal(adapter.notifications[0].update.content.text, 'earlier reply');

    const result = await adapter.request('session/prompt', {
      sessionId: PERSISTED_SESSION,
      prompt: [{ type: 'text', text: 'ping' }],
    });
    assert.deepEqual(result, { stopReason: 'end_turn' });
  } finally {
    adapter.stop();
  }
});

// --- end-to-end: the #144 engine drives Muse with no engine changes ---------

function interactionFixture() {
  const root = scratchDir('muse-e2e-');
  const env = {
    AGENT_BOT_INTERACTION_HOME: path.join(root, 'interaction'),
    AGENT_BOT_POPULATION_PATH: path.join(root, 'population.json'),
    AGENT_BOT_PRINCIPALS_PATH: path.join(root, 'principals.json'),
  };
  upsertSoul({
    id: AGENT_ID,
    appSlug: MUSE_IDENTITY.app,
    parentId: null,
    status: 'active',
    spacePath: `/spaces/${AGENT_ID}`,
    transcriptLocator: null,
    lastSeen: '2026-08-27T08:00:00.000Z',
  }, { file: env.AGENT_BOT_POPULATION_PATH });
  const options = { file: env.AGENT_BOT_PRINCIPALS_PATH, env, home: '/nonexistent' };
  let principal = enrollPrincipal({ label: 'owner' }, options);
  bindTransport(principal.principalId, { transport: 'web', providerId: 'owner-subject' }, options);
  authorizeSouls(principal.principalId, [AGENT_ID], options);
  principal = setOperations(principal.principalId, ['message', 'observe', 'cancel', 'approve'], options);
  return { env, principal };
}

async function waitFor(probe, { timeoutMs = 10_000, intervalMs = 20 } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await probe();
    if (value) return value;
    if (Date.now() >= deadline) throw new Error('condition not reached in time');
    await new Promise((resolve) => { setTimeout(resolve, intervalMs); });
  }
}

async function engineTurn({ store, message, getHarnessSession = null }) {
  const { env, principal } = interactionFixture();
  const executor = createAcpExecutor({
    harness: 'muse',
    identity: MUSE_IDENTITY,
    policy: ALLOW_ALL,
    // The production muse row, untouched except for pointing the adapter's
    // muse binary at the scripted fake via env.
    registry: { muse: ACP_SPAWN_REGISTRY.muse },
    env: adapterEnv(store),
    cwd: scratchDir('muse-cwd-'),
    getHarnessSession,
  });
  const interaction = createInteractionService({
    env, home: '/nonexistent', config: {}, log: () => {}, executor,
  });
  const { session } = interaction.createOrContinueSession({
    principal,
    transport: 'web',
    agentId: AGENT_ID,
  });
  const { invocation } = interaction.submitMessage({
    principal,
    transport: 'web',
    sessionId: session.sessionId,
    message,
    idempotencyKey: `muse-${message}-${getHarnessSession === null ? 'new' : 'resume'}`,
  });
  const finished = await waitFor(() => {
    const { invocation: current } = interaction.getInvocation({
      principal,
      transport: 'web',
      invocationId: invocation.invocationId,
    });
    return ['completed', 'failed'].includes(current.status) ? current : null;
  });
  const { events } = interaction.readEvents({
    principal,
    transport: 'web',
    invocationId: invocation.invocationId,
  });
  return { finished, events };
}

test('the drive engine completes a full Muse turn through the production registry row', async () => {
  const { finished, events } = await engineTurn({ store: seedMuseStore(), message: 'ping' });
  assert.equal(finished.status, 'completed');
  const binding = events.find((event) => event.type === HARNESS_SESSION_EVENT);
  assert.equal(binding.data.harness, 'muse');
  assert.equal(binding.data.mode, 'new');
  assert.match(binding.data.harnessSessionId, /^[0-9a-f-]{36}$/);
  const kinds = events
    .filter((event) => event.type === UPDATE_EVENT)
    .map((event) => event.data.sessionUpdate);
  assert.deepEqual(kinds, ['agent_message_chunk', 'tool_call', 'tool_call_update']);
  const stop = events.find((event) => event.type === STOP_EVENT);
  assert.deepEqual(stop.data, { stopReason: 'end_turn' });
});

test('the drive engine resumes a persisted Muse session without re-recording history', async () => {
  const { finished, events } = await engineTurn({
    store: seedMuseStore(),
    message: 'ping',
    getHarnessSession: () => ({ harnessSessionId: PERSISTED_SESSION }),
  });
  assert.equal(finished.status, 'completed');
  const binding = events.find((event) => event.type === HARNESS_SESSION_EVENT);
  assert.deepEqual(binding.data, {
    harness: 'muse',
    mode: 'resume',
    harnessSessionId: PERSISTED_SESSION,
  });
  const texts = events
    .filter((event) => event.type === UPDATE_EVENT && event.data.sessionUpdate === 'agent_message_chunk')
    .map((event) => event.data.content.text);
  // 'earlier reply' is session/load replay — the engine must not re-record it.
  assert.deepEqual(texts, ['muse says: ping']);
});
