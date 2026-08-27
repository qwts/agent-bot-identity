import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  MAX_REPLY_TEXT_BYTES,
  REACH_AGENT_ID_ENV,
  REACH_INVOCATION_ENV,
  createReachState,
  handleMcpMessage,
  reachMcpServerEntry,
  resolveReachIdentity,
} from '../daemon-mcp.mjs';
import {
  appendEvent,
  createSession,
  readEvents,
  readInvocationPayload,
  submitInvocation,
  writeInvocationPayload,
} from '../agent-jobs.mjs';
import { createAcpExecutor } from '../acp-engine.mjs';
import { createInteractionService } from '../agent-interaction.mjs';
import {
  authorizeSouls,
  bindTransport,
  enrollPrincipal,
  setOperations,
} from '../agent-principals.mjs';
import { upsertSoul } from '../agent-population.mjs';

const AGENT_ID = 'agent_11111111-1111-4111-8111-111111111111';
const OTHER_ID = 'agent_22222222-2222-4222-8222-222222222222';
const PRINCIPAL_ID = 'principal_33333333-3333-4333-8333-333333333333';
const IDENTITY = { app: 'qwts-claude-agent', agentId: AGENT_ID };
const ALLOW_ALL = { version: 1, rules: [], fallback: 'allow' };
const REACH_FIXTURE = fileURLToPath(new URL('./fixtures/fake-reach-agent.mjs', import.meta.url));

const roots = [];
after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

function scratch() {
  const root = mkdtempSync(path.join(tmpdir(), 'daemon-mcp-'));
  roots.push(root);
  const env = {
    AGENT_BOT_INTERACTION_HOME: path.join(root, 'interaction'),
    AGENT_BOT_POPULATION_PATH: path.join(root, 'population.json'),
    AGENT_BOT_PRINCIPALS_PATH: path.join(root, 'principals.json'),
  };
  return { root, env };
}

const store = (env) => ({ env, home: '/nonexistent' });

// Seeds one session + invocation + payload straight into the store, the way
// the interaction service would have left them at dispatch time.
function seedInvocation(env, {
  agentId = AGENT_ID,
  message = 'what is the plan?',
  attachments = [],
} = {}) {
  const options = store(env);
  const session = createSession(
    { agentId, principalId: PRINCIPAL_ID, transport: 'web' },
    options,
  );
  const { invocation } = submitInvocation({
    sessionId: session.sessionId,
    agentId,
    principalId: PRINCIPAL_ID,
    transport: 'web',
    idempotencyKey: `seed-${Math.random().toString(36).slice(2)}`,
  }, options);
  writeInvocationPayload(invocation.invocationId, { message, attachments }, options);
  return { session, invocation };
}

function injectedState(env, invocationId, { agentId = AGENT_ID, extraEnv = {} } = {}) {
  return createReachState({
    env: {
      ...env,
      [REACH_INVOCATION_ENV]: invocationId,
      [REACH_AGENT_ID_ENV]: agentId,
      ...extraEnv,
    },
    home: '/nonexistent',
    cwd: tmpdir(),
  });
}

let nextRpcId = 0;
async function call(state, name, args = {}) {
  nextRpcId += 1;
  const response = await handleMcpMessage(state, {
    jsonrpc: '2.0',
    id: nextRpcId,
    method: 'tools/call',
    params: { name, arguments: args },
  });
  const text = response.result.content[0].text;
  if (response.result.isError) throw new Error(text);
  return JSON.parse(text);
}

// --- protocol ---------------------------------------------------------------

test('the reach server speaks the MCP handshake and lists its four tools', async () => {
  const state = createReachState({ env: {}, cwd: tmpdir() });
  const initialized = await handleMcpMessage(state, {
    jsonrpc: '2.0', id: 1, method: 'initialize', params: {},
  });
  assert.equal(initialized.result.serverInfo.name, 'agent-reach');
  assert.match(initialized.result.instructions, /post_reply/);
  const listed = await handleMcpMessage(state, { jsonrpc: '2.0', id: 2, method: 'tools/list' });
  assert.deepEqual(
    listed.result.tools.map((tool) => tool.name),
    ['fetch_context', 'post_reply', 'report_status', 'clock_in'],
  );
  const pinged = await handleMcpMessage(state, { jsonrpc: '2.0', id: 3, method: 'ping' });
  assert.deepEqual(pinged.result, {});
  const unknown = await handleMcpMessage(state, { jsonrpc: '2.0', id: 4, method: 'nope' });
  assert.equal(unknown.error.code, -32601);
  // Notifications — even malformed tool calls — never produce a response.
  assert.equal(await handleMcpMessage(state, { jsonrpc: '2.0', method: 'ping' }), null);
  assert.equal(
    await handleMcpMessage(state, {
      jsonrpc: '2.0', method: 'tools/call', params: { name: 'post_reply', arguments: {} },
    }),
    null,
  );
  const invalid = await handleMcpMessage(state, { hello: 'world' });
  assert.equal(invalid.error.code, -32600);
});

// --- fetch_context ----------------------------------------------------------

test('fetch_context returns the payload, resolves space refs, and bounds the thread', async () => {
  const { root, env } = scratch();
  const spaceRoot = path.join(root, 'space');
  mkdirSync(path.join(spaceRoot, 'notes'), { recursive: true });
  writeFileSync(path.join(spaceRoot, 'notes', 'brief.md'), 'the brief', { mode: 0o600 });
  upsertSoul({
    id: AGENT_ID,
    appSlug: IDENTITY.app,
    parentId: null,
    status: 'active',
    spacePath: spaceRoot,
    transcriptLocator: null,
    lastSeen: '2026-08-27T08:00:00.000Z',
  }, { file: env.AGENT_BOT_POPULATION_PATH });

  const { session, invocation } = seedInvocation(env, {
    message: 'read the brief',
    attachments: ['space://notes/brief.md', 'space://../escape', 'opaque-ref-1'],
  });
  const options = store(env);
  // An earlier exchange in the same session, already answered.
  const { invocation: earlier } = submitInvocation({
    sessionId: session.sessionId,
    agentId: AGENT_ID,
    principalId: PRINCIPAL_ID,
    transport: 'web',
    idempotencyKey: 'earlier-turn',
  }, options);
  writeInvocationPayload(earlier.invocationId, { message: 'first question' }, options);
  appendEvent(earlier.invocationId, 'reply', { agentId: AGENT_ID, text: 'first answer' }, options);

  const state = injectedState(env, invocation.invocationId);
  const context = await call(state, 'fetch_context', {});
  assert.equal(context.invocation.invocationId, invocation.invocationId);
  assert.equal(context.invocation.sessionId, session.sessionId);
  assert.equal(context.message, 'read the brief');
  assert.deepEqual(context.attachments[0], {
    ref: 'space://notes/brief.md',
    // realpath: macOS tmpdir lives behind the /var -> /private/var symlink.
    path: realpathSync(path.join(spaceRoot, 'notes', 'brief.md')),
  });
  // Traversal attempts and non-space refs stay opaque instead of failing.
  assert.equal(context.attachments[1].path, null);
  assert.equal(context.attachments[2].path, null);
  const [turn] = context.thread;
  assert.equal(turn.invocationId, earlier.invocationId);
  assert.equal(turn.message, 'first question');
  assert.equal(turn.reply, 'first answer');
});

// --- post_reply / report_status / clock_in ----------------------------------

test('post_reply lands a durable reply event stamped with the identity', async () => {
  const { env } = scratch();
  const { invocation } = seedInvocation(env);
  const state = injectedState(env, invocation.invocationId);
  const posted = await call(state, 'post_reply', { text: 'here is the plan' });
  assert.equal(posted.delivered, true);
  const events = readEvents(invocation.invocationId, {}, store(env));
  const reply = events.find((event) => event.type === 'reply');
  assert.deepEqual(reply.data, { agentId: AGENT_ID, text: 'here is the plan' });

  await assert.rejects(call(state, 'post_reply', { text: '' }), /non-empty/);
  await assert.rejects(
    call(state, 'post_reply', { text: 'x'.repeat(MAX_REPLY_TEXT_BYTES + 1) }),
    /at most/,
  );
});

test('report_status and clock_in append bounded progress and heartbeat events', async () => {
  const { env } = scratch();
  const { invocation } = seedInvocation(env);
  const state = injectedState(env, invocation.invocationId);
  await call(state, 'report_status', { note: 'halfway there' });
  const clockIn = await call(state, 'clock_in', {});
  assert.equal(clockIn.agentId, AGENT_ID);
  assert.equal(clockIn.placement, 'injected');
  assert.equal(clockIn.durable, true);
  const events = readEvents(invocation.invocationId, {}, store(env));
  assert.deepEqual(
    events.map((event) => event.type),
    ['agent-status', 'clock-in'],
  );
  assert.equal(events[0].data.note, 'halfway there');
  assert.equal(events[1].data.agentId, AGENT_ID);
  await assert.rejects(call(state, 'report_status', { note: 'x'.repeat(2048) }), /at most/);
});

// --- identity gate ----------------------------------------------------------

test('invocation-scoped tools fail closed on missing or mismatched identity', async () => {
  const { env } = scratch();
  const { invocation } = seedInvocation(env);

  // Stamped identity that does not own the invocation: refused.
  const mismatched = injectedState(env, invocation.invocationId, { agentId: OTHER_ID });
  await assert.rejects(call(mismatched, 'post_reply', { text: 'hi' }), /different agent identity/);
  await assert.rejects(call(mismatched, 'fetch_context', {}), /different agent identity/);

  // No stamped identity and no worktree pin: refused before any write.
  const anonymous = createReachState({
    env: { ...env, [REACH_INVOCATION_ENV]: invocation.invocationId },
    home: '/nonexistent',
    cwd: tmpdir(),
  });
  await assert.rejects(call(anonymous, 'post_reply', { text: 'hi' }), /no reach-back identity/);
  await assert.rejects(call(anonymous, 'clock_in', {}), /no reach-back identity/);

  // Unknown invocation: refused.
  const missing = injectedState(env, 'invocation_99999999-9999-4999-8999-999999999999');
  await assert.rejects(call(missing, 'fetch_context', {}), /unknown invocation/);

  // No invocation in scope at all: the error names both placements.
  const unscoped = createReachState({ env: { ...env }, home: '/nonexistent', cwd: tmpdir() });
  await assert.rejects(call(unscoped, 'fetch_context', {}), /no invocation in scope/);

  assert.equal(readEvents(invocation.invocationId, {}, store(env)).length, 0);
});

test('an injected server is pinned: explicit invocation_id may not address a sibling thread', async () => {
  const { env } = scratch();
  const { session, invocation } = seedInvocation(env);
  // A sibling invocation of the SAME soul in the same session — exactly what
  // fetch_context's thread history exposes to the session.
  const { invocation: sibling } = submitInvocation({
    sessionId: session.sessionId,
    agentId: AGENT_ID,
    principalId: PRINCIPAL_ID,
    transport: 'web',
    idempotencyKey: 'sibling-turn',
  }, store(env));
  writeInvocationPayload(sibling.invocationId, { message: 'sibling question' }, store(env));

  const state = injectedState(env, invocation.invocationId);
  await assert.rejects(
    call(state, 'post_reply', { text: 'crossed wires', invocation_id: sibling.invocationId }),
    /pinned to its own invocation/,
  );
  await assert.rejects(
    call(state, 'fetch_context', { invocation_id: sibling.invocationId }),
    /pinned to its own invocation/,
  );
  assert.equal(readEvents(sibling.invocationId, {}, store(env)).length, 0);

  // Restating the stamped invocation explicitly is fine — it names no other
  // thread, so a session echoing its own id keeps working.
  const posted = await call(state, 'post_reply', {
    text: 'right thread',
    invocation_id: invocation.invocationId,
  });
  assert.equal(posted.delivered, true);
});

test('a retry repairs a submit that crashed before persisting its payload', async () => {
  const { env } = scratch();
  upsertSoul({
    id: AGENT_ID,
    appSlug: IDENTITY.app,
    parentId: null,
    status: 'active',
    spacePath: `/spaces/${AGENT_ID}`,
    transcriptLocator: null,
    lastSeen: '2026-08-27T08:00:00.000Z',
  }, { file: env.AGENT_BOT_POPULATION_PATH });
  const principalOptions = { file: env.AGENT_BOT_PRINCIPALS_PATH, env, home: '/nonexistent' };
  const enrolled = enrollPrincipal({ label: 'owner' }, principalOptions);
  bindTransport(enrolled.principalId, { transport: 'web', providerId: 'owner-subject' }, principalOptions);
  authorizeSouls(enrolled.principalId, [AGENT_ID], principalOptions);
  const principal = setOperations(
    enrolled.principalId,
    ['message', 'observe', 'cancel', 'approve'],
    principalOptions,
  );
  const delivered = [];
  const interaction = createInteractionService({
    env,
    home: '/nonexistent',
    config: {},
    log: () => {},
    executor: async ({ message }) => { delivered.push(message); },
  });
  const { session } = interaction.createOrContinueSession({
    principal, transport: 'web', agentId: AGENT_ID,
  });
  // Simulate the crash window: the invocation and idempotency index are
  // committed, but the payload write and dispatch never happened.
  const { invocation: stuck } = submitInvocation({
    sessionId: session.sessionId,
    agentId: AGENT_ID,
    principalId: principal.principalId,
    transport: 'web',
    idempotencyKey: 'crashed-submit',
  }, store(env));
  assert.equal(readInvocationPayload(stuck.invocationId, store(env)), null);

  const retried = interaction.submitMessage({
    principal,
    transport: 'web',
    sessionId: session.sessionId,
    message: 'the original message',
    idempotencyKey: 'crashed-submit',
  });
  assert.equal(retried.duplicate, true);
  assert.equal(retried.invocation.invocationId, stuck.invocationId);
  assert.equal(
    readInvocationPayload(stuck.invocationId, store(env)).message,
    'the original message',
  );
  const deadline = Date.now() + 5_000;
  while (delivered.length === 0 && Date.now() < deadline) {
    await new Promise((resolve) => { setTimeout(resolve, 10); });
  }
  assert.deepEqual(delivered, ['the original message']);

  // A second retry is a plain duplicate: payload present, no re-dispatch.
  const again = interaction.submitMessage({
    principal,
    transport: 'web',
    sessionId: session.sessionId,
    message: 'the original message',
    idempotencyKey: 'crashed-submit',
  });
  assert.equal(again.duplicate, true);
  assert.equal(delivered.length, 1);
});

// --- registered placement ---------------------------------------------------

test('a registered server takes its identity from the worktree git config', async () => {
  const { root, env } = scratch();
  const worktree = path.join(root, 'worktree');
  mkdirSync(worktree, { recursive: true });
  execFileSync('git', ['init'], { cwd: worktree, stdio: 'ignore' });
  execFileSync('git', ['config', 'agentBot.agentId', AGENT_ID], { cwd: worktree, stdio: 'ignore' });

  const state = createReachState({ env: { ...env }, home: '/nonexistent', cwd: worktree });
  assert.deepEqual(resolveReachIdentity(state), { agentId: AGENT_ID, placement: 'registered' });

  // Without an injected invocation the clock-in is an ephemeral report...
  const idle = await call(state, 'clock_in', {});
  assert.equal(idle.agentId, AGENT_ID);
  assert.equal(idle.placement, 'registered');
  assert.equal(idle.durable, false);

  // ...and invocation-scoped tools address the thread explicitly.
  const { invocation } = seedInvocation(env);
  const posted = await call(state, 'post_reply', {
    text: 'from the desktop harness',
    invocation_id: invocation.invocationId,
  });
  assert.equal(posted.delivered, true);
  const reply = readEvents(invocation.invocationId, {}, store(env))
    .find((event) => event.type === 'reply');
  assert.equal(reply.data.agentId, AGENT_ID);
});

// --- injected entry ---------------------------------------------------------

test('reachMcpServerEntry stamps the invocation, identity, and store location', () => {
  const entry = reachMcpServerEntry({
    invocationId: 'invocation_44444444-4444-4444-8444-444444444444',
    agentId: AGENT_ID,
    env: { AGENT_BOT_INTERACTION_HOME: '/stores/interaction', HOME: '/home/bot', UNRELATED: 'no' },
  });
  assert.equal(entry.name, 'agent-reach');
  assert.equal(entry.command, process.execPath);
  assert.match(entry.args[0], /daemon-mcp\.mjs$/);
  const vars = Object.fromEntries(entry.env.map((pair) => [pair.name, pair.value]));
  assert.equal(vars[REACH_INVOCATION_ENV], 'invocation_44444444-4444-4444-8444-444444444444');
  assert.equal(vars[REACH_AGENT_ID_ENV], AGENT_ID);
  assert.equal(vars.AGENT_BOT_INTERACTION_HOME, '/stores/interaction');
  assert.equal(vars.HOME, '/home/bot');
  assert.equal('UNRELATED' in vars, false);
  assert.throws(() => reachMcpServerEntry({ invocationId: 'nope', agentId: AGENT_ID }), /invocation/i);
  assert.throws(
    () => reachMcpServerEntry({
      invocationId: 'invocation_44444444-4444-4444-8444-444444444444',
      agentId: 'nope',
    }),
    /Agent ID/,
  );
});

// --- the loop (#146 done-when) ----------------------------------------------

// Adapter thread → interaction service → drive engine → injected reach
// server → reply event back on the invocation stream. The fixture agent
// spawns the real daemon-mcp.mjs from the injected entry, so the reply text
// proves fetch_context and post_reply both crossed process boundaries.
test('a daemon-driven session fetches its context and lands its reply in the thread', async () => {
  const { env } = scratch();
  upsertSoul({
    id: AGENT_ID,
    appSlug: IDENTITY.app,
    parentId: null,
    status: 'active',
    spacePath: `/spaces/${AGENT_ID}`,
    transcriptLocator: null,
    lastSeen: '2026-08-27T08:00:00.000Z',
  }, { file: env.AGENT_BOT_POPULATION_PATH });
  const principalOptions = { file: env.AGENT_BOT_PRINCIPALS_PATH, env, home: '/nonexistent' };
  const enrolled = enrollPrincipal({ label: 'owner' }, principalOptions);
  bindTransport(enrolled.principalId, { transport: 'web', providerId: 'owner-subject' }, principalOptions);
  authorizeSouls(enrolled.principalId, [AGENT_ID], principalOptions);
  const principal = setOperations(
    enrolled.principalId,
    ['message', 'observe', 'cancel', 'approve'],
    principalOptions,
  );

  const executor = createAcpExecutor({
    harness: 'claude',
    identity: IDENTITY,
    policy: ALLOW_ALL,
    registry: {
      claude: {
        harness: 'claude',
        enabled: true,
        command: process.execPath,
        args: [REACH_FIXTURE],
        stripEnv: [],
      },
    },
    mcpServers: ({ invocation, identity }) => [reachMcpServerEntry({
      invocationId: invocation.invocationId,
      agentId: identity.agentId,
      env,
    })],
  });
  const interaction = createInteractionService({
    env, home: '/nonexistent', config: {}, executor, log: () => {},
  });

  const { session } = interaction.createOrContinueSession({
    principal, transport: 'web', agentId: AGENT_ID,
  });
  const { invocation } = interaction.submitMessage({
    principal,
    transport: 'web',
    sessionId: session.sessionId,
    message: 'summarize the incident',
    idempotencyKey: 'loop-1',
  });

  // The submit path persisted the payload the reach server will read.
  assert.equal(
    readInvocationPayload(invocation.invocationId, store(env)).message,
    'summarize the incident',
  );

  const deadline = Date.now() + 10_000;
  for (;;) {
    const { invocation: current } = interaction.getInvocation({
      principal, transport: 'web', invocationId: invocation.invocationId,
    });
    if (current.status === 'completed') break;
    if (current.status === 'failed') assert.fail(`invocation failed: ${current.error}`);
    if (Date.now() >= deadline) assert.fail('invocation did not complete in time');
    await new Promise((resolve) => { setTimeout(resolve, 25); });
  }

  const { events } = interaction.readEvents({
    principal, transport: 'web', invocationId: invocation.invocationId,
  });
  const types = events.map((event) => event.type);
  assert.ok(types.includes('clock-in'), `expected a clock-in event in ${types}`);
  assert.ok(types.includes('agent-status'), `expected an agent-status event in ${types}`);
  const reply = events.find((event) => event.type === 'reply');
  assert.equal(reply.data.text, `reach-echo:summarize the incident as:${AGENT_ID}`);
  assert.equal(reply.data.agentId, AGENT_ID);
});
