import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  MAX_MESSAGE_BYTES,
  MAX_REPLY_TEXT_BYTES,
  REACH_AGENT_ID_ENV,
  REACH_COMMS_ENV,
  REACH_CORRELATION_ENV,
  REACH_INVOCATION_ENV,
  REACH_WORKTREE_ENV,
  reachPolicyRules,
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
import { recordThreadMessage, threadContext } from '../soul-threads.mjs';

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

test('the reach server speaks the MCP handshake and lists its six tools', async () => {
  const state = createReachState({ env: {}, cwd: tmpdir() });
  const initialized = await handleMcpMessage(state, {
    jsonrpc: '2.0', id: 1, method: 'initialize', params: {},
  });
  assert.equal(initialized.result.serverInfo.name, 'agent-reach');
  assert.match(initialized.result.instructions, /post_reply/);
  const listed = await handleMcpMessage(state, { jsonrpc: '2.0', id: 2, method: 'tools/list' });
  assert.deepEqual(
    listed.result.tools.map((tool) => tool.name),
    ['fetch_context', 'post_reply', 'report_status', 'clock_in', 'fleet', 'send_message', 'start_soul'],
  );
  assert.match(initialized.result.instructions, /fleet/);
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

test('reachMcpServerEntry without an invocation stamps the soul, its worktree, binding, and comms', () => {
  const entry = reachMcpServerEntry({
    agentId: AGENT_ID,
    env: { PATH: '/opt/bin:/usr/bin', HOME: '/home/bot' },
    worktree: '/souls/bill/worktree',
    binding: '/souls/bill/binding.json',
  });
  const vars = Object.fromEntries(entry.env.map((pair) => [pair.name, pair.value]));
  assert.equal(REACH_INVOCATION_ENV in vars, false);
  assert.equal(vars[REACH_AGENT_ID_ENV], AGENT_ID);
  assert.equal(vars[REACH_WORKTREE_ENV], '/souls/bill/worktree');
  assert.equal(vars.AGENT_BOT_BINDING, '/souls/bill/binding.json');
  assert.equal(vars.PATH, '/opt/bin:/usr/bin');
  assert.equal(REACH_COMMS_ENV in vars, false, 'comms is on by default');
  const off = reachMcpServerEntry({ agentId: AGENT_ID, env: {}, comms: false });
  assert.equal(Object.fromEntries(off.env.map((pair) => [pair.name, pair.value]))[REACH_COMMS_ENV], '0');
  assert.throws(() => reachMcpServerEntry({ agentId: AGENT_ID, worktree: 'relative' }), /absolute/);
});

test('the policy rules allow exactly this server\'s tools under Claude\'s MCP naming', () => {
  assert.deepEqual(reachPolicyRules().map((rule) => [rule.tool, rule.outcome]), [
    ['mcp__agent-reach__fetch_context', 'allow'],
    ['mcp__agent-reach__post_reply', 'allow'],
    ['mcp__agent-reach__report_status', 'allow'],
    ['mcp__agent-reach__clock_in', 'allow'],
    ['mcp__agent-reach__fleet', 'allow'],
    ['mcp__agent-reach__send_message', 'allow'],
    ['mcp__agent-reach__start_soul', 'allow'],
  ]);
});

// --- teammates (fleet, send_message) ----------------------------------------

const PEERS = [
  { address: 'acct/agent_aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', account: 'acct', agentId: 'agent_aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', name: 'Ted - Starter', harness: 'claude', parent: null, verification: 'claimed' },
  { address: 'acct/agent_bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', account: 'acct', agentId: 'agent_bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', name: 'Twin', harness: 'codex', parent: null, verification: 'claimed' },
  { address: 'acct/agent_cccccccc-cccc-4ccc-8ccc-cccccccccccc', account: 'acct', agentId: 'agent_cccccccc-cccc-4ccc-8ccc-cccccccccccc', name: 'Twin', harness: 'opencode', parent: null, verification: 'claimed' },
];

// A fake agent-comms: records each call and answers peers and send.
function fakeComms() {
  const calls = [];
  const run = (command, args, options, callback) => {
    calls.push({ command, args, cwd: options.cwd, env: options.env });
    if (args[0] === 'peers') return callback(null, JSON.stringify({ ok: true, peers: PEERS }), '');
    if (args[0] === 'send') {
      if (args[1] === 'nobody') return callback(Object.assign(new Error('exit 1')), JSON.stringify({ ok: false, error: { code: 'unknown-recipient', message: 'no soul you may message has that address' } }), '');
      return callback(null, JSON.stringify({ ok: true, messageId: 'msg_1', seq: 7, duplicate: false, wake: 'cold' }), '');
    }
    return callback(new Error('unexpected'), '', 'unexpected');
  };
  return { calls, run };
}

function injectedSoul(extraEnv = {}) {
  const comms = fakeComms();
  const state = createReachState({
    env: {
      [REACH_AGENT_ID_ENV]: AGENT_ID,
      [REACH_WORKTREE_ENV]: '/souls/bill/worktree',
      AGENT_BOT_BINDING: '/souls/bill/binding.json',
      PATH: '/opt/bin',
      ...extraEnv,
    },
    home: '/nonexistent',
    cwd: tmpdir(),
    run: comms.run,
  });
  return { state, calls: comms.calls };
}

test('fleet lists the teammates the broker lets this soul message, as the soul', async () => {
  const { state, calls } = injectedSoul();
  const fleet = await call(state, 'fleet');
  assert.equal(fleet.you, AGENT_ID);
  assert.deepEqual(fleet.teammates.map((peer) => [peer.name, peer.harness]), [['Ted - Starter', 'claude'], ['Twin', 'codex'], ['Twin', 'opencode']]);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].args, ['peers']);
  assert.equal(calls[0].command, 'agent-comms');
  assert.equal(calls[0].cwd, '/souls/bill/worktree');
  assert.equal(calls[0].env.AGENT_BOT_BINDING, '/souls/bill/binding.json');
  assert.equal(calls[0].env.AGENT_BOT_ID, AGENT_ID);
});

test('send_message resolves a teammate by name and sends as the soul', async () => {
  const { state, calls } = injectedSoul();
  const sent = await call(state, 'send_message', { to: 'ted - starter', body: 'Can you review the plan?\nThanks' });
  assert.deepEqual(sent, { sent: true, to: PEERS[0].address, messageId: 'msg_1', wake: 'cold',
    next: `${PEERS[0].address}'s reply will wake you in a later turn: do not wait for it or message it again, and send no progress notes to other agents.` });
  assert.deepEqual(calls.map((entry) => entry.args), [
    ['peers'],
    ['send', PEERS[0].address, '--body', 'Can you review the plan?\nThanks'],
  ]);
  // Addresses and Agent IDs go straight through, with an optional reply_to.
  await call(state, 'send_message', { to: PEERS[1].agentId, body: 'hi', reply_to: 'msg_0' });
  assert.deepEqual(calls.at(-1).args, ['send', PEERS[1].agentId, '--body', 'hi', '--reply-to', 'msg_0']);
  // A name no peer has may be a person: the broker decides.
  const toPerson = await call(state, 'send_message', { to: 'owner', body: 'done' });
  assert.deepEqual(calls.at(-1).args, ['send', 'owner', '--body', 'done']);
  assert.equal(toPerson.next, undefined, 'a person\'s answer wakes nothing');
});

// One message per teammate per thread until it answers (#427): a teammate
// still starting up is not pinged again, and each ping would wake it again.
test('send_message refuses a second message to a teammate that has not answered in this thread', async () => {
  const { root } = scratch();
  const stateHome = path.join(root, 'state');
  const { state, calls } = injectedSoul({ [REACH_CORRELATION_ENV]: 'msg_starter', AGENT_BOT_STATE_HOME: stateHome });
  await call(state, 'send_message', { to: PEERS[0].agentId, body: 'Ted, your book list?' });
  await assert.rejects(call(state, 'send_message', { to: 'Ted - Starter', body: 'Ted? Any news?' }),
    /has not answered your message from .* Do not message it again/);
  assert.equal(calls.filter((entry) => entry.args[0] === 'send').length, 1, 'the re-ping never reached the broker');
  // Other teammates and people are unaffected.
  await call(state, 'send_message', { to: PEERS[1].agentId, body: 'Twin, a second opinion?' });
  await call(state, 'send_message', { to: 'owner', body: 'Asked Ted and Twin.' });
  await call(state, 'send_message', { to: 'owner', body: 'Still on it.' });
  // Once Ted answers in this thread, the soul may write to Ted again.
  recordThreadMessage(AGENT_ID, { dir: 'in', id: 'msg_ted', from: PEERS[0].address, replyTo: 'msg_1', correlation: 'msg_starter', body: 'Three books.' },
    { env: state.env, home: '/nonexistent' });
  await call(state, 'send_message', { to: PEERS[0].agentId, body: 'Thanks, one more?' });
  // Another thread, or a turn with no thread, is not held.
  const other = injectedSoul({ [REACH_CORRELATION_ENV]: 'msg_other', AGENT_BOT_STATE_HOME: stateHome });
  await call(other.state, 'send_message', { to: PEERS[1].agentId, body: 'Twin, separate question.' });
  const unthreaded = injectedSoul({ AGENT_BOT_STATE_HOME: stateHome });
  await call(unthreaded.state, 'send_message', { to: PEERS[1].agentId, body: 'hi' });
  await call(unthreaded.state, 'send_message', { to: PEERS[1].agentId, body: 'hi again' });
});

// Two send_message calls in flight at once (#433): the check and the claim
// are one locked step, so only one reaches the broker; a failed send frees
// the teammate again.
test('concurrent send_message calls to one teammate reach the broker once', async () => {
  const { root } = scratch();
  const comms = fakeComms();
  let failNext = false;
  const run = (command, args, options, callback) => {
    if (args[0] !== 'send') return comms.run(command, args, options, callback);
    if (failNext) {
      failNext = false;
      comms.calls.push({ command, args });
      return setTimeout(() => callback(new Error('exit 1'), JSON.stringify({ ok: false, error: { code: 'unavailable', message: 'broker down' } }), ''), 20);
    }
    return setTimeout(() => comms.run(command, args, options, callback), 20);
  };
  const state = createReachState({
    env: {
      [REACH_AGENT_ID_ENV]: AGENT_ID, [REACH_WORKTREE_ENV]: '/souls/bill/worktree', AGENT_BOT_BINDING: '/souls/bill/binding.json',
      PATH: '/opt/bin', [REACH_CORRELATION_ENV]: 'msg_starter', AGENT_BOT_STATE_HOME: path.join(root, 'state'),
    },
    home: '/nonexistent', cwd: tmpdir(), run,
  });
  const sends = () => comms.calls.filter((entry) => entry.args[0] === 'send').length;
  failNext = true;
  await assert.rejects(call(state, 'send_message', { to: PEERS[0].agentId, body: 'Ted?' }));
  const results = await Promise.allSettled([
    call(state, 'send_message', { to: PEERS[0].agentId, body: 'Ted, your book list?' }),
    call(state, 'send_message', { to: 'Ted - Starter', body: 'Ted, also your films?' }),
  ]);
  assert.deepEqual(results.map((result) => result.status).sort(), ['fulfilled', 'rejected']);
  assert.match(results.find((result) => result.status === 'rejected').reason.message, /Do not message it again/);
  assert.equal(sends(), 2, 'the failed send, then exactly one of the two concurrent sends');
});

// A relayed turn's sends carry its thread key and are journaled, so the
// teammate's answer wakes this soul with the request still in view (#392).
test('send_message carries the turn\'s correlation and journals the send', async () => {
  const { root } = scratch();
  const { state, calls } = injectedSoul({ [REACH_CORRELATION_ENV]: 'msg_starter', AGENT_BOT_STATE_HOME: path.join(root, 'state') });
  await call(state, 'send_message', { to: PEERS[0].agentId, body: 'Ted, your book list?' });
  assert.deepEqual(calls.at(-1).args, ['send', PEERS[0].agentId, '--body', 'Ted, your book list?', '--correlation', 'msg_starter']);
  const thread = threadContext(AGENT_ID, { id: 'msg_ted', replyTo: 'msg_1', correlation: 'msg_starter' }, { env: state.env, home: '/nonexistent' });
  assert.deepEqual(thread.map((entry) => [entry.dir, entry.id, entry.to, entry.body]), [['out', 'msg_1', PEERS[0].agentId, 'Ted, your book list?']]);

  // An over-long key is ignored rather than refused by the broker.
  const long = injectedSoul({ [REACH_CORRELATION_ENV]: 'x'.repeat(129) });
  await call(long.state, 'send_message', { to: 'owner', body: 'hi' });
  assert.deepEqual(long.calls.at(-1).args, ['send', 'owner', '--body', 'hi']);
  assert.equal(reachMcpServerEntry({ agentId: AGENT_ID, env: {}, correlation: 'x'.repeat(129) }).env.some((pair) => pair.name === REACH_CORRELATION_ENV), false);
  assert.ok(reachMcpServerEntry({ agentId: AGENT_ID, env: { AGENT_BOT_STATE_HOME: '/state' }, correlation: 'msg_1' }).env
    .some((pair) => pair.name === 'AGENT_BOT_STATE_HOME'), 'the journal location travels with the entry');
});

test('send_message refuses ambiguous names, bad input, and reports broker refusals', async () => {
  const { state } = injectedSoul();
  await assert.rejects(call(state, 'send_message', { to: 'Twin', body: 'hi' }), /2 teammates are named Twin/);
  await assert.rejects(call(state, 'send_message', { to: '', body: 'hi' }), /to must be a non-empty string/);
  await assert.rejects(call(state, 'send_message', { to: 'a\nb', body: 'hi' }), /single line/);
  await assert.rejects(call(state, 'send_message', { to: 'owner', body: '   ' }), /body must be a non-empty/);
  await assert.rejects(call(state, 'send_message', { to: 'owner', body: 'x'.repeat(MAX_MESSAGE_BYTES + 1) }), /at most/);
  await assert.rejects(call(state, 'send_message', { to: 'nobody', body: 'hi' }), /no soul you may message/);
});

test('teammate tools need an identity, and comms off withholds them', async () => {
  const anonymous = createReachState({ env: {}, home: '/nonexistent', cwd: tmpdir(), run: fakeComms().run });
  await assert.rejects(call(anonymous, 'fleet'), /no reach-back identity/);

  const { state, calls } = injectedSoul({ [REACH_COMMS_ENV]: '0' });
  const listed = await handleMcpMessage(state, { jsonrpc: '2.0', id: 99, method: 'tools/list' });
  // A comms turn has no invocation, so only clock_in is left (#407).
  assert.deepEqual(listed.result.tools.map((tool) => tool.name), ['clock_in']);
  await assert.rejects(call(state, 'send_message', { to: 'owner', body: 'hi' }), /turned off/);
  assert.equal(calls.length, 0);
});

// --- start_soul (#377) -------------------------------------------------------

const CHILD_ID = 'agent_dddddddd-dddd-4ddd-8ddd-dddddddddddd';

// A binding file for the calling soul, as the daemon writes it: 0600, with
// the daemon URL and a 43-character secret that only signs proofs.
function bindingFile(root, agentId = AGENT_ID) {
  const file = path.join(root, 'agent-binding.json');
  writeFileSync(file, JSON.stringify({ v: 1, agentId, parent: null, account: 'acct',
    daemon: 'http://127.0.0.1:4555/', secret: 'S'.repeat(43) }), { mode: 0o600 });
  return file;
}

function fakeDaemon(reply = { status: 200, body: { agentId: CHILD_ID, name: 'Researcher', harness: 'claude', parent: AGENT_ID } }) {
  const requests = [];
  const fetch = async (url, init) => {
    requests.push({ url, method: init.method, headers: init.headers, body: JSON.parse(init.body) });
    return { ok: reply.status < 400, status: reply.status, json: async () => reply.body };
  };
  return { requests, fetch };
}

test('start_soul asks the daemon as the soul, with a proof and never the secret', async () => {
  const { root } = scratch();
  const comms = fakeComms();
  const daemon = fakeDaemon();
  const state = createReachState({
    env: { [REACH_AGENT_ID_ENV]: AGENT_ID, [REACH_WORKTREE_ENV]: root, AGENT_BOT_BINDING: bindingFile(root) },
    home: '/nonexistent', cwd: tmpdir(), run: comms.run, fetch: daemon.fetch,
  });
  const started = await call(state, 'start_soul', { name: ' Researcher ', harness: 'claude', brief: 'Survey ACP adapters.' });
  assert.deepEqual(started, { started: true, agentId: CHILD_ID, name: 'Researcher', harness: 'claude', parent: AGENT_ID,
    brief: { sent: true, messageId: 'msg_1' },
    next: 'Researcher\'s reply will wake you in a later turn: do not wait for it or message it again, and send no progress notes to other agents.' });
  assert.equal(daemon.requests.length, 1);
  const [request] = daemon.requests;
  assert.equal(request.url, 'http://127.0.0.1:4555/v0/team/start');
  assert.deepEqual(request.body, { name: 'Researcher', harness: 'claude' });
  assert.match(request.headers['x-agent-binding-proof'], /^v1\./);
  assert.equal(JSON.stringify(request).includes('S'.repeat(43)), false, 'the secret never travels');
  // The brief goes from the parent to the new soul, as the parent.
  assert.deepEqual(comms.calls.map((entry) => entry.args), [['send', CHILD_ID, '--body', 'Survey ACP adapters.']]);
  assert.equal(comms.calls[0].env.AGENT_BOT_ID, AGENT_ID);
});

test('start_soul reports daemon refusals, a foreign binding, and comms off', async () => {
  const { root } = scratch();
  const refused = fakeDaemon({ status: 429, body: { error: 'you already have 5 active teammates you started (limit 5)' } });
  const env = { [REACH_AGENT_ID_ENV]: AGENT_ID, [REACH_WORKTREE_ENV]: root, AGENT_BOT_BINDING: bindingFile(root) };
  const state = createReachState({ env, home: '/nonexistent', cwd: tmpdir(), run: fakeComms().run, fetch: refused.fetch });
  await assert.rejects(call(state, 'start_soul', { name: 'Six' }), /limit 5/);
  await assert.rejects(call(state, 'start_soul', { name: '' }), /name must be a non-empty string/);

  const other = mkdtempSync(path.join(root, 'other-'));
  const foreign = createReachState({ env: { ...env, AGENT_BOT_BINDING: bindingFile(other, OTHER_ID) },
    home: '/nonexistent', cwd: tmpdir(), run: fakeComms().run, fetch: fakeDaemon().fetch });
  await assert.rejects(call(foreign, 'start_soul', { name: 'X' }), /different soul/);

  const off = createReachState({ env: { ...env, [REACH_COMMS_ENV]: '0' }, home: '/nonexistent', cwd: tmpdir(),
    run: fakeComms().run, fetch: fakeDaemon().fetch });
  await assert.rejects(call(off, 'start_soul', { name: 'X' }), /turned off/);
});

test('fleet shows each teammate\'s parent, so a team reads under its lead', async () => {
  const { state } = injectedSoul();
  const fleet = await call(state, 'fleet');
  assert.equal(fleet.teammates.every((peer) => 'parent' in peer), true);
});

test('a registered server never presents an inherited binding to agent-comms', async () => {
  const { root, env } = scratch();
  const worktree = path.join(root, 'worktree');
  mkdirSync(worktree, { recursive: true });
  execFileSync('git', ['init'], { cwd: worktree, stdio: 'ignore' });
  execFileSync('git', ['config', 'agentBot.agentId', AGENT_ID], { cwd: worktree, stdio: 'ignore' });
  const comms = fakeComms();
  const state = createReachState({ env: { ...env, AGENT_BOT_BINDING: '/someone/else.json' }, home: '/nonexistent', cwd: worktree, run: comms.run });
  await call(state, 'fleet');
  assert.equal(comms.calls[0].cwd, worktree);
  assert.equal('AGENT_BOT_BINDING' in comms.calls[0].env, false);
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

// #407: a comms turn's injected server has no invocation, so it offers no
// fetch_context that can only fail, and says the prompt holds the message.
test('a comms turn leaves out the invocation tools and refuses them by name', async () => {
  const { state } = injectedSoul();
  const listed = await handleMcpMessage(state, { jsonrpc: '2.0', id: 1, method: 'tools/list' });
  assert.deepEqual(listed.result.tools.map((tool) => tool.name), ['clock_in', 'fleet', 'send_message', 'start_soul']);
  const init = await handleMcpMessage(state, { jsonrpc: '2.0', id: 2, method: 'initialize', params: {} });
  assert.doesNotMatch(init.result.instructions, /fetch_context/);
  assert.match(init.result.instructions, /already holds the message/);
  for (const name of ['fetch_context', 'post_reply', 'report_status']) {
    await assert.rejects(call(state, name, { text: 'x', invocation_id: 'invocation_44444444-4444-4444-8444-444444444444' }), /not available in this turn/);
  }
});
