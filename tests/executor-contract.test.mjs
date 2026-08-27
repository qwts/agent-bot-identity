import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  BINDING_MODES,
  HARNESS_SESSION_EVENT,
  MAX_UPDATE_BYTES,
  STOP_EVENT,
  STOP_REASONS,
  UPDATE_EVENT,
  UPDATE_KINDS,
  createContractExecutor,
  decidePermission,
  validateAttachmentReference,
  validateExecutorIdentity,
  validateHarnessBinding,
  validatePermissionPolicy,
  validateStop,
  validateUpdate,
} from '../executor-contract.mjs';
import {
  UNCONFIGURED_EXECUTOR_ERROR,
  createInteractionService,
} from '../agent-interaction.mjs';
import {
  authorizeSouls,
  bindTransport,
  enrollPrincipal,
  setOperations,
} from '../agent-principals.mjs';
import { upsertSoul } from '../agent-population.mjs';

const AGENT_ID = 'agent_11111111-1111-4111-8111-111111111111';
const IDENTITY = { app: 'qwts-claude-agent', agentId: AGENT_ID };
const roots = [];

after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

function scratch() {
  const root = mkdtempSync(path.join(tmpdir(), 'executor-contract-'));
  roots.push(root);
  const env = {
    AGENT_BOT_INTERACTION_HOME: path.join(root, 'interaction'),
    AGENT_BOT_POPULATION_PATH: path.join(root, 'population.json'),
    AGENT_BOT_PRINCIPALS_PATH: path.join(root, 'principals.json'),
  };
  return { root, env };
}

function seedSoul(env) {
  return upsertSoul({
    id: AGENT_ID,
    appSlug: IDENTITY.app,
    parentId: null,
    status: 'active',
    spacePath: `/spaces/${AGENT_ID}`,
    transcriptLocator: null,
    lastSeen: '2026-08-27T08:00:00.000Z',
  }, { file: env.AGENT_BOT_POPULATION_PATH });
}

function seedPrincipal(env, { operations = ['message', 'observe', 'cancel', 'approve'] } = {}) {
  const options = { file: env.AGENT_BOT_PRINCIPALS_PATH, env, home: '/nonexistent' };
  const principal = enrollPrincipal({ label: 'owner' }, options);
  bindTransport(principal.principalId, { transport: 'web', providerId: 'owner-subject' }, options);
  authorizeSouls(principal.principalId, [AGENT_ID], options);
  return setOperations(principal.principalId, operations, options);
}

function service(env, overrides = {}) {
  return createInteractionService({ env, home: '/nonexistent', config: {}, log: () => {}, ...overrides });
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

function begin(interaction, principal) {
  const { session } = interaction.createOrContinueSession({
    principal,
    transport: 'web',
    agentId: AGENT_ID,
  });
  return session;
}

const ALLOW_ALL = { version: 1, rules: [], fallback: 'allow' };

// --- validators -----------------------------------------------------------

test('harness binding validates harness, mode, and opaque session id', () => {
  const binding = validateHarnessBinding({
    harness: 'claude',
    mode: 'resume',
    harnessSessionId: 'ses_fc04e3cffffeVBNZTDpslHu3YV',
  });
  assert.deepEqual(binding, { harness: 'claude', mode: 'resume', harnessSessionId: 'ses_fc04e3cffffeVBNZTDpslHu3YV' });
  assert.ok(Object.isFrozen(binding));
  for (const mode of BINDING_MODES) {
    validateHarnessBinding({ harness: 'muse', mode, harnessSessionId: 'x' });
  }
  assert.throws(() => validateHarnessBinding({ harness: 'Claude', mode: 'new', harnessSessionId: 'x' }));
  assert.throws(() => validateHarnessBinding({ harness: 'claude', mode: 'attach', harnessSessionId: 'x' }));
  assert.throws(() => validateHarnessBinding({ harness: 'claude', mode: 'new', harnessSessionId: '' }));
  assert.throws(() => validateHarnessBinding({ harness: 'claude', mode: 'new', harnessSessionId: 'a\x00b' }));
  assert.throws(() => validateHarnessBinding({ harness: 'claude', mode: 'new', harnessSessionId: 'x'.repeat(257) }));
});

test('updates accept the ACP vocabulary and reject everything else', () => {
  validateUpdate({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'hi' } });
  validateUpdate({ sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'hm' } });
  validateUpdate({ sessionUpdate: 'tool_call', toolCallId: 'call_1', title: 'read a file' });
  validateUpdate({ sessionUpdate: 'tool_call_update', toolCallId: 'call_1', status: 'completed' });
  validateUpdate({ sessionUpdate: 'plan', entries: [] });
  assert.deepEqual(
    [...UPDATE_KINDS].sort(),
    ['agent_message_chunk', 'agent_thought_chunk', 'plan', 'tool_call', 'tool_call_update'],
  );
  assert.throws(() => validateUpdate({ sessionUpdate: 'user_message_chunk', content: {} }));
  assert.throws(() => validateUpdate({ sessionUpdate: 'agent_message_chunk' }));
  assert.throws(() => validateUpdate({ sessionUpdate: 'tool_call' }));
  assert.throws(() => validateUpdate({ sessionUpdate: 'tool_call_update', toolCallId: 'call_1' }));
  assert.throws(() => validateUpdate({ sessionUpdate: 'plan' }));
  assert.throws(() => validateUpdate(null));
  assert.throws(() => validateUpdate({
    sessionUpdate: 'agent_message_chunk',
    content: { type: 'text', text: 'x'.repeat(MAX_UPDATE_BYTES) },
  }));
});

test('stop reasons are the ACP set and nothing else', () => {
  for (const stopReason of STOP_REASONS) validateStop({ stopReason });
  assert.throws(() => validateStop({ stopReason: 'done' }));
  assert.throws(() => validateStop({}));
});

test('attachment references stay bounded opaque strings', () => {
  assert.equal(validateAttachmentReference('space://inbox/item-1'), 'space://inbox/item-1');
  assert.throws(() => validateAttachmentReference(''));
  assert.throws(() => validateAttachmentReference('x'.repeat(257)));
  assert.throws(() => validateAttachmentReference('a\x01b'));
  assert.throws(() => validateAttachmentReference(42));
});

// --- permission policy ----------------------------------------------------

test('permission policy validates shape and decidePermission is first-match, fail-closed', () => {
  const policy = validatePermissionPolicy({
    version: 1,
    rules: [
      { tool: 'mcp__daemon__post_reply', outcome: 'allow' },
      { tool: 'mcp__daemon__*', outcome: 'approval' },
      { tool: 'Bash', outcome: 'deny' },
    ],
    fallback: 'deny',
  });
  assert.equal(decidePermission(policy, { toolName: 'mcp__daemon__post_reply' }), 'allow');
  assert.equal(decidePermission(policy, { toolName: 'mcp__daemon__wipe_all' }), 'approval');
  assert.equal(decidePermission(policy, { toolName: 'Bash' }), 'deny');
  assert.equal(decidePermission(policy, { toolName: 'Read' }), 'deny');
  // Malformed requests are denied, never thrown on.
  assert.equal(decidePermission(policy, {}), 'deny');
  assert.equal(decidePermission(policy, { toolName: 'has space' }), 'deny');
  assert.equal(decidePermission(policy, { toolName: 42 }), 'deny');

  assert.throws(() => validatePermissionPolicy(null));
  assert.throws(() => validatePermissionPolicy({ version: 2, rules: [], fallback: 'deny' }));
  assert.throws(() => validatePermissionPolicy({ version: 1, rules: [{ tool: 'x', outcome: 'maybe' }], fallback: 'deny' }));
  assert.throws(() => validatePermissionPolicy({ version: 1, rules: [], fallback: 'ask' }));
  assert.throws(() => validatePermissionPolicy({
    version: 1,
    rules: Array.from({ length: 257 }, () => ({ tool: 'x', outcome: 'deny' })),
    fallback: 'deny',
  }));
});

// --- fail-closed construction ---------------------------------------------

test('executor construction fails closed on identity, policy, harness, and run', () => {
  const good = {
    harness: 'claude',
    identity: IDENTITY,
    policy: ALLOW_ALL,
    run: async () => {},
  };
  createContractExecutor(good);
  assert.throws(() => createContractExecutor({ ...good, identity: { app: 'qwts-claude-agent' } }), /agentBot\.agentId/);
  assert.throws(() => createContractExecutor({ ...good, identity: { agentId: AGENT_ID } }), /agentBot\.app/);
  assert.throws(() => createContractExecutor({ ...good, identity: { app: 'Bad Slug', agentId: AGENT_ID } }), /agentBot\.app/);
  assert.throws(() => createContractExecutor({ ...good, identity: undefined }));
  assert.throws(() => createContractExecutor({ ...good, policy: { version: 1, rules: [], fallback: 'ask' } }));
  assert.throws(() => createContractExecutor({ ...good, policy: undefined }));
  assert.throws(() => createContractExecutor({ ...good, harness: 'Not A Slug' }));
  assert.throws(() => createContractExecutor({ ...good, run: undefined }));
  assert.equal(validateExecutorIdentity(IDENTITY).app, 'qwts-claude-agent');
});

// --- conformance: full lifecycle through the interaction service ----------

test('a conforming mock executor binds, streams, stops, and completes', async () => {
  const { env } = scratch();
  seedSoul(env);
  const principal = seedPrincipal(env);
  const executor = createContractExecutor({
    harness: 'claude',
    identity: IDENTITY,
    policy: ALLOW_ALL,
    run: async ({ message, identity, bindHarnessSession, emitUpdate, emitStop, requestPermission }) => {
      assert.equal(identity.app, IDENTITY.app);
      bindHarnessSession({ mode: 'new', harnessSessionId: 'harness-session-1' });
      emitUpdate({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: `pong: ${message}` } });
      const permission = await requestPermission({ toolName: 'mcp__daemon__post_reply' });
      assert.deepEqual(permission, { outcome: 'allow', decidedBy: 'policy' });
      emitStop({ stopReason: 'end_turn' });
    },
  });
  const interaction = service(env, { executor });
  const session = begin(interaction, principal);
  const { invocation } = interaction.submitMessage({
    principal,
    transport: 'web',
    sessionId: session.sessionId,
    message: 'ping',
    idempotencyKey: 'turn-1',
  });

  const finished = await waitFor(() => {
    const { invocation: current } = interaction.getInvocation({
      principal,
      transport: 'web',
      invocationId: invocation.invocationId,
    });
    return current.status === 'completed' ? current : null;
  });
  assert.equal(finished.status, 'completed');

  const { events } = interaction.readEvents({
    principal,
    transport: 'web',
    invocationId: invocation.invocationId,
  });
  const types = events.map((event) => event.type);
  assert.ok(types.indexOf(HARNESS_SESSION_EVENT) < types.indexOf(UPDATE_EVENT));
  assert.ok(types.indexOf(UPDATE_EVENT) < types.indexOf(STOP_EVENT));
  const binding = events.find((event) => event.type === HARNESS_SESSION_EVENT);
  assert.deepEqual(binding.data, { harness: 'claude', mode: 'new', harnessSessionId: 'harness-session-1' });
  const stop = events.find((event) => event.type === STOP_EVENT);
  assert.deepEqual(stop.data, { stopReason: 'end_turn' });
});

test('an approval-mapped permission parks the invocation behind a digest-bound proposal', async () => {
  const { env } = scratch();
  seedSoul(env);
  const principal = seedPrincipal(env);
  const outcomes = [];
  const executor = createContractExecutor({
    harness: 'claude',
    identity: IDENTITY,
    policy: { version: 1, rules: [{ tool: 'Bash', outcome: 'approval' }], fallback: 'deny' },
    run: async ({ emitStop, requestPermission }) => {
      outcomes.push(await requestPermission({ toolName: 'Bash', summary: 'run the build' }));
      outcomes.push(await requestPermission({ toolName: 'Read' }));
      emitStop({ stopReason: 'end_turn' });
    },
  });
  const interaction = service(env, { executor });
  const session = begin(interaction, principal);
  const { invocation } = interaction.submitMessage({
    principal,
    transport: 'web',
    sessionId: session.sessionId,
    message: 'do the thing',
    idempotencyKey: 'turn-approval',
  });

  const proposal = await waitFor(() => {
    const { proposals } = interaction.listProposals({ principal, transport: 'web' });
    return proposals.find((row) => row.invocationId === invocation.invocationId) ?? null;
  });
  assert.equal(proposal.summary, 'run the build');
  const parked = interaction.getInvocation({
    principal,
    transport: 'web',
    invocationId: invocation.invocationId,
  });
  assert.equal(parked.invocation.status, 'waiting-approval');

  // The decision must echo the recorded digest — the listing carries it.
  interaction.decideProposal({
    principal,
    transport: 'web',
    proposalId: proposal.proposalId,
    decision: 'approve',
    digest: proposal.operationDigest,
  });

  await waitFor(() => {
    const { invocation: current } = interaction.getInvocation({
      principal,
      transport: 'web',
      invocationId: invocation.invocationId,
    });
    return current.status === 'completed' ? current : null;
  });
  assert.deepEqual(outcomes, [
    { outcome: 'allow', decidedBy: 'approval' },
    { outcome: 'deny', decidedBy: 'policy' },
  ]);
});

test('cancellation aborts a running contract executor cooperatively', async () => {
  const { env } = scratch();
  seedSoul(env);
  const principal = seedPrincipal(env);
  let release;
  const started = new Promise((resolve) => { release = resolve; });
  const executor = createContractExecutor({
    harness: 'claude',
    identity: IDENTITY,
    policy: ALLOW_ALL,
    run: ({ signal }) => new Promise((resolve, reject) => {
      release();
      if (signal.aborted) reject(new Error('aborted before start'));
      signal.addEventListener('abort', () => reject(new Error('turn aborted')), { once: true });
    }),
  });
  const interaction = service(env, { executor });
  const session = begin(interaction, principal);
  const { invocation } = interaction.submitMessage({
    principal,
    transport: 'web',
    sessionId: session.sessionId,
    message: 'long turn',
    idempotencyKey: 'turn-cancel',
  });
  await started;
  const outcome = await interaction.cancelInvocation({
    principal,
    transport: 'web',
    invocationId: invocation.invocationId,
  });
  assert.equal(outcome.status, 'cancelled');
  assert.equal(outcome.stopped, true);
});

test('the daemon default stays fail-closed: no executor, stable refusal', async () => {
  const { env } = scratch();
  seedSoul(env);
  const principal = seedPrincipal(env);
  const interaction = service(env);
  const session = begin(interaction, principal);
  const { invocation } = interaction.submitMessage({
    principal,
    transport: 'web',
    sessionId: session.sessionId,
    message: 'anyone home?',
    idempotencyKey: 'turn-unconfigured',
  });
  const failed = await waitFor(() => {
    const { invocation: current } = interaction.getInvocation({
      principal,
      transport: 'web',
      invocationId: invocation.invocationId,
    });
    return current.status === 'failed' ? current : null;
  });
  assert.equal(failed.error, UNCONFIGURED_EXECUTOR_ERROR);
});
