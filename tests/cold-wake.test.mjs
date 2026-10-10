import test, { after } from 'node:test';
import assert from 'node:assert/strict';

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { createColdWaker, deniedNotice } from '../cold-wake.mjs';
import { recordThreadMessage } from '../soul-threads.mjs';
import { readAsides } from '../soul-asides.mjs';

// Relayed turns journal their thread (#392) under the identity state home.
const stateHome = mkdtempSync(path.join(tmpdir(), 'cold-wake-state-'));
process.env.AGENT_BOT_STATE_HOME = stateHome;
after(() => rmSync(stateHome, { recursive: true, force: true }));

const id = 'agent_12345678-1234-4123-8123-123456789abc';
const binding = { worktree: '/work/tree', file: '/work/tree/.git/agent-bindings/child.json' };
const githubIdentity = { harness: 'codex', github: { appSlug: 'you-codex-agent' } };

test('cold wake is opt-in and reports waiting while disabled', async () => {
  let calls = 0;
  const wake = createColdWaker({ executor: async () => { calls += 1; }, settings: {}, lookupBinding: async () => binding, identities: async () => githubIdentity, receipt() {} });
  assert.deepEqual(await wake({ agentId: id, count: 1, cursor: 'c', messageIds: ['m1'] }), { outcome: 'waiting', detail: 'cold wake is disabled' });
  assert.equal(calls, 0);
});

test('cold wake starts a turn for a soul without a GitHub App (#297)', async () => {
  let calls = 0;
  const receipts = [];
  const wake = createColdWaker({ executor: async () => { calls += 1; }, settings: { [id]: true }, lookupBinding: async () => binding, identities: async () => ({ harness: 'codex' }), receipt: (entry) => receipts.push(entry) });
  assert.deepEqual(await wake({ agentId: id, count: 1, messageIds: ['m1'] }), { outcome: 'cold', detail: 'turn started' });
  await wake.idle();
  assert.equal(calls, 1);
  assert.deepEqual(receipts.map((entry) => entry.decision), ['started', 'finished']);
});

test('enabled cold wake supplies message IDs, worktree and binding, and records a secret-free receipt', async () => {
  let input;
  const receipts = [];
  const wake = createColdWaker({ executor: async (value) => { input = value; }, settings: { [id]: true }, lookupBinding: async () => binding, identities: async () => githubIdentity, receipt: (value) => receipts.push(value) });
  assert.equal((await wake({ agentId: id, count: 2, cursor: 'c', messageIds: ['m1', 'm2'] })).outcome, 'cold');
  await wake.idle();
  assert.equal(input.invocation.cwd, binding.worktree);
  assert.equal(input.env.AGENT_BOT_BINDING, binding.file);
  assert.match(input.message, /2 agent-comms messages waiting \(IDs: m1, m2\)/);
  assert.match(input.message, /agent-comms inbox read, act, and ack them with agent-comms inbox ack/);
  assert.deepEqual(receipts, [
    { event: 'cold-wake', agentId: id, decision: 'started' },
    { event: 'cold-wake', agentId: id, decision: 'finished' },
  ]);
});

test('cold wake reports failures and single-flights concurrent wakes per soul', async () => {
  let finish;
  let calls = 0;
  const wake = createColdWaker({ executor: async () => { calls += 1; await new Promise((resolve) => { finish = resolve; }); }, settings: { [id]: true }, lookupBinding: async () => binding, identities: async () => githubIdentity, receipt() {} });
  const first = wake({ agentId: id, count: 1, messageIds: ['m1'] });
  await new Promise((resolve) => setImmediate(resolve));
  const second = await wake({ agentId: id, count: 1, messageIds: ['m2'] });
  assert.equal(second.outcome, 'cold');
  assert.equal(calls, 1);
  finish();
  assert.equal((await first).outcome, 'cold');

  await wake.idle();

  // A turn that fails after starting was still reported cold; the failure
  // lands in the receipt and frees the soul for the next wake.
  const receipts = [];
  const failed = createColdWaker({ executor: async () => { throw new Error('launch failed'); }, settings: { [id]: true }, lookupBinding: async () => binding, identities: async () => githubIdentity, receipt: (value) => receipts.push(value.decision) });
  assert.equal((await failed({ agentId: id, count: 1, messageIds: ['m3'] })).outcome, 'cold');
  await failed.idle();
  assert.deepEqual(receipts, ['started', 'failed']);
  assert.equal((await failed({ agentId: id, count: 1, messageIds: ['m4'] })).detail, 'turn started');

  const unbound = createColdWaker({ executor: async () => {}, settings: { [id]: true }, lookupBinding: async () => null, identities: async () => githubIdentity, receipt() {} });
  assert.deepEqual(await unbound({ agentId: id, count: 1, messageIds: ['m5'] }), { outcome: 'failed', detail: 'soul binding is unavailable' });
});

test('a failed turn leaves its error code and a bounded message in the daemon log, never in the receipt', async () => {
  const logs = [];
  const receipts = [];
  const spawnFailure = Object.assign(new Error('spawn opencode ENOENT'), { code: 'ENOENT' });
  const wake = createColdWaker({ executor: async () => { throw spawnFailure; }, settings: { [id]: true }, lookupBinding: async () => binding, identities: async () => githubIdentity, receipt: (value) => receipts.push(value), log: (line) => logs.push(line) });
  await wake({ agentId: id, count: 1, messageIds: ['m1'] });
  await wake.idle();
  assert.deepEqual(receipts.at(-1), { event: 'cold-wake', agentId: id, decision: 'failed', detail: 'cold wake turn failed' });
  assert.deepEqual(logs, [`cold wake turn for ${id} failed: ENOENT: spawn opencode ENOENT`]);

  // Without a code the class names the error; a long or multi-line message
  // (one that could quote the model) is cut to a single bounded line.
  logs.length = 0;
  const noisy = createColdWaker({ executor: async () => { throw new TypeError(`${'x'.repeat(300)}\nsecond line`); }, settings: { [id]: true }, lookupBinding: async () => binding, identities: async () => githubIdentity, receipt() {}, log: (line) => logs.push(line) });
  await noisy({ agentId: id, count: 1, messageIds: ['m2'] });
  await noisy.idle();
  assert.equal(logs.length, 1);
  assert.match(logs[0], new RegExp(`^cold wake turn for ${id} failed: TypeError: x{200}…$`));
});

test('cold waker reads the current setting for each wake', async () => {
  let enabled = true;
  let calls = 0;
  const wake = createColdWaker({ executor: async () => { calls += 1; }, settings: () => ({ [id]: enabled }), lookupBinding: async () => binding, identities: async () => githubIdentity, receipt() {} });
  assert.equal((await wake({ agentId: id, count: 1, messageIds: ['m1'] })).outcome, 'cold');
  enabled = false;
  assert.deepEqual(await wake({ agentId: id, count: 1, messageIds: ['m2'] }), { outcome: 'waiting', detail: 'cold wake is disabled' });
  assert.equal(calls, 1);
});

test('a launch that throws synchronously is a failed wake and frees the soul', async () => {
  const receipts = [];
  let calls = 0;
  const wake = createColdWaker({
    executor: () => { calls += 1; if (calls === 1) throw new Error('spawn EACCES'); return Promise.resolve(); },
    settings: { [id]: true },
    lookupBinding: async () => binding,
    identities: async () => githubIdentity,
    receipt: (value) => receipts.push(value.decision),
  });
  assert.deepEqual(await wake({ agentId: id, count: 1, messageIds: ['m1'] }), { outcome: 'failed', detail: 'cold wake turn could not start' });
  assert.deepEqual(receipts, ['failed']);
  assert.equal((await wake({ agentId: id, count: 1, messageIds: ['m2'] })).outcome, 'cold');
  await wake.idle();
  assert.deepEqual(receipts, ['failed', 'started', 'finished']);
});

test('idle covers a wake that is still resolving its binding', async () => {
  let release;
  let started = false;
  const wake = createColdWaker({
    executor: async () => { started = true; },
    settings: { [id]: true },
    lookupBinding: () => new Promise((resolve) => { release = () => resolve(binding); }),
    identities: async () => githubIdentity,
    receipt() {},
  });
  const pending = wake({ agentId: id, count: 1, messageIds: ['m1'] });
  await new Promise((resolve) => setImmediate(resolve));
  let idle = false;
  const idled = wake.idle().then(() => { idle = true; });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(idle, false);
  release();
  assert.equal((await pending).outcome, 'cold');
  await idled;
  assert.equal(started, true);
});

test('with a relay, each waiting message gets its own turn, and the answer goes back as the reply', async () => {
  const inbox = [
    { id: 'm1', from: { principal: 'owner' }, body: 'hello' },
    { id: 'm2', from: { account: 'acct', agentId: 'agent_peer' }, body: 'ping' },
  ];
  const sent = [];
  const acked = [];
  const relay = {
    read: async (soul) => { assert.deepEqual(soul, { agentId: id, binding }); return inbox.filter((m) => !acked.includes(m.id)); },
    reply: async (soul, reply) => { sent.push(reply); },
    ack: async (soul, ids) => { acked.push(...ids); },
  };
  const prompts = [];
  const executor = async ({ message }) => { prompts.push(message); return { reply: prompts.length === 1 ? '  hi there \n' : '' }; };
  const receipts = [];
  const wake = createColdWaker({ executor, settings: { [id]: true }, lookupBinding: async () => binding, identities: async () => githubIdentity, receipt: (r) => receipts.push(r.decision), relay });
  assert.equal((await wake({ agentId: id, count: 2, messageIds: ['m1', 'm2'] })).outcome, 'cold');
  await wake.idle();
  assert.equal(prompts.length, 2);
  assert.match(prompts[0], /from owner\. Your final answer is sent back/);
  assert.doesNotMatch(prompts[0], /NO_REPLY/, 'a person always gets the answer');
  assert.match(prompts[0], /\n\nhello$/);
  assert.match(prompts[1], /from acct\/agent_peer/);
  // An empty answer sends nothing but still acks the message.
  assert.deepEqual(sent, [{ to: 'owner', replyTo: 'm1', body: 'hi there', correlation: 'm1' }]);
  assert.deepEqual(acked, ['m1', 'm2']);
  assert.deepEqual(receipts, ['started', 'finished']);
});

// Bill messages Ted through send_message; Ted's cold turn answers, and the
// relay sends that answer back to Bill as a reply, exactly as it does for a
// person. A teammate's message that needs no answer ends with NO_REPLY, so
// two souls do not trade acknowledgements to the reply-depth limit.
test('a teammate\'s message is relayed like a person\'s, and NO_REPLY ends the exchange', async () => {
  const bill = { account: 'acct', agentId: 'agent_aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' };
  const inbox = [
    { id: 'm1', from: bill, body: 'Ted, can you review the plan?' },
    { id: 'm2', from: bill, body: 'Thanks!' },
  ];
  const sent = [];
  const acked = [];
  const relay = {
    read: async () => inbox.filter((m) => !acked.includes(m.id)),
    reply: async (soul, reply) => { sent.push(reply); },
    ack: async (soul, ids) => { acked.push(...ids); },
  };
  const prompts = [];
  const answers = ['Reviewed: looks good, one gap in step 3.', ' NO_REPLY \n'];
  const executor = async ({ message }) => { prompts.push(message); return { reply: answers[prompts.length - 1] }; };
  const wake = createColdWaker({ executor, settings: { [id]: true }, lookupBinding: async () => binding, identities: async () => githubIdentity, receipt: () => {}, relay });
  await wake({ agentId: id, count: 2, messageIds: ['m1', 'm2'] });
  await wake.idle();
  assert.match(prompts[0], new RegExp(`from acct/${bill.agentId}, another agent`));
  assert.match(prompts[0], /exactly NO_REPLY/);
  assert.match(prompts[0], /send_message/);
  assert.deepEqual(sent, [{ to: `acct/${bill.agentId}`, replyTo: 'm1', body: 'Reviewed: looks good, one gap in step 3.', correlation: 'm1' }]);
  assert.deepEqual(acked, ['m1', 'm2']);
});

test('with a relay, a failed reply leaves the message unacked and fails the wake', async () => {
  const acked = [];
  const relay = {
    read: async () => [{ id: 'm1', from: { principal: 'owner' }, body: 'hello' }],
    reply: async () => { throw Object.assign(new Error('agent-comms send failed: broker unreachable'), { code: 'broker-unavailable' }); },
    ack: async (soul, ids) => { acked.push(...ids); },
  };
  const receipts = [];
  const wake = createColdWaker({ executor: async () => ({ reply: 'hi' }), settings: { [id]: true }, lookupBinding: async () => binding, identities: async () => githubIdentity, receipt: (r) => receipts.push(r.decision), relay });
  await wake({ agentId: id, count: 1, messageIds: ['m1'] });
  await wake.idle();
  assert.deepEqual(acked, []);
  assert.deepEqual(receipts, ['started', 'failed']);
});

test('with a relay, a reply the broker refuses for good is acked unanswered', async () => {
  for (const code of ['reply-depth-exceeded', 'unknown-recipient']) {
    const inbox = [{ id: 'm1', from: { principal: 'owner' }, body: 'hello' }];
    const acked = [];
    const relay = {
      read: async () => inbox.filter((m) => !acked.includes(m.id)),
      reply: async () => { throw Object.assign(new Error(`agent-comms send failed: ${code}`), { code }); },
      ack: async (soul, ids) => { acked.push(...ids); },
    };
    const receipts = [];
    const wake = createColdWaker({ executor: async () => ({ reply: 'hi' }), settings: { [id]: true }, lookupBinding: async () => binding, identities: async () => githubIdentity, receipt: (r) => receipts.push(r.decision), relay });
    await wake({ agentId: id, count: 1, messageIds: ['m1'] });
    await wake.idle();
    assert.deepEqual(acked, ['m1'], code);
    assert.deepEqual(receipts, ['started', 'finished'], code);
  }
});

test('task events use briefs, report linked execution and never send replies', async () => {
  for (const brief of [null, { turn: false }, { turn: true, linked: false, prompt: 'review' }, { turn: true, linked: true, taskId: 'task_aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', prompt: 'criteria' }]) {
    let pending = true;
    const turns = [];
    const reports = [];
    const relay = {
      read: async () => pending ? [{ id: 'task-message', kind: 'task-event', body: '{}' }] : [],
      brief: async () => brief,
      ack: async (soul, ids) => { assert.deepEqual(ids, ['task-message']); pending = false; },
      reply: async () => assert.fail('task events never receive replies'),
    };
    const wake = createColdWaker({ executor: async (input) => { turns.push(input); return { reply: 'never send this' }; }, settings: { [id]: true }, lookupBinding: async () => binding, identities: async () => githubIdentity, receipt() {}, relay,
      taskReporter: { started(invocation) { reports.push(['started', invocation]); }, ended(invocation, outcome) { reports.push(['ended', invocation, outcome]); } },
    });
    await wake({ agentId: id, messageIds: ['task-message'] });
    await wake.idle();
    assert.equal(pending, false);
    assert.equal(turns.length, brief?.turn ? 1 : 0);
    if (brief?.turn) assert.equal(turns[0].message, brief.prompt);
    assert.equal(reports.length, brief?.linked ? 2 : 0);
    if (brief?.linked) {
      assert.equal(reports[1][2], 'completed');
      assert.equal(reports[0][1].taskId, brief.taskId);
      assert.match(reports[0][1].invocationId, /^invocation_[0-9a-f-]{36}$/);
    }
  }
});

test('failed task turns report failure and acknowledge without replying', async () => {
  const reports = [];
  let acked = false;
  const relay = {
    read: async () => [{ id: 'task-message', kind: 'task-event' }],
    brief: async () => ({ turn: true, linked: true, taskId: 'task_aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', prompt: 'work' }),
    ack: async () => { acked = true; },
    reply: async () => assert.fail('task events never receive replies'),
  };
  const logs = [];
  const wake = createColdWaker({ executor: async () => { throw new Error('failed'); }, settings: { [id]: true }, lookupBinding: async () => binding, identities: async () => githubIdentity, receipt() {}, relay,
    taskReporter: { started() { reports.push('started'); }, ended(invocation, outcome) { reports.push(outcome); } }, log: (line) => logs.push(line),
  });
  await wake({ agentId: id });
  await wake.idle();
  assert.deepEqual(reports, ['started', 'failed']);
  assert.equal(acked, true);
  // The log names the task that failed, then the wake it failed.
  assert.deepEqual(logs, [
    `task task_aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa turn for ${id} failed: Error: failed`,
    `cold wake turn for ${id} failed: Error: failed`,
  ]);
});

// #617: a refusal about the recorded resume session is fixed by the owner
// or the soul, so its task event stays unacked to run again.
test('a task turn refused for its recorded resume session leaves the event unacked', async () => {
  for (const code of ['resume-session-store-moved', 'wake-session-record-invalid']) {
    const reports = [];
    let acked = false;
    const relay = {
      read: async () => [{ id: 'task-message', kind: 'task-event' }],
      brief: async () => ({ turn: true, linked: true, taskId: 'task_aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', prompt: 'work' }),
      ack: async () => { acked = true; },
      reply: async () => assert.fail('task events never receive replies'),
    };
    const wake = createColdWaker({ executor: async () => { throw Object.assign(new Error('refused'), { code }); }, settings: { [id]: true }, lookupBinding: async () => binding, identities: async () => githubIdentity, receipt() {}, relay,
      taskReporter: { started() { reports.push('started'); }, ended(invocation, outcome) { reports.push(outcome); } }, log() {},
    });
    await wake({ agentId: id });
    await wake.idle();
    assert.equal(acked, false, code);
    assert.deepEqual(reports, ['started', 'failed'], code);
  }
});

test('task reporting errors do not fail a cold turn; cancellation is reported without a reply', async () => {
  for (const cancelled of [false, true]) {
    let pending = true;
    const outcomes = [];
    const logs = [];
    const relay = {
      read: async () => pending ? [{ id: 'event', kind: 'task-event' }] : [],
      brief: async () => ({ turn: true, linked: true, taskId: 'task_aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', prompt: 'work' }),
      ack: async () => { pending = false; },
      reply: async () => assert.fail('task events never receive replies'),
    };
    const wake = createColdWaker({ executor: async () => ({ cancelled, reply: 'unused' }), settings: { [id]: true }, lookupBinding: async () => binding, identities: async () => githubIdentity, receipt() {}, relay,
      taskReporter: { started() { throw new Error('offline'); }, ended(invocation, outcome) { outcomes.push(outcome); throw new Error('offline'); } }, log: (line) => logs.push(line),
    });
    await wake({ agentId: id });
    await wake.idle();
    assert.equal(pending, false);
    assert.deepEqual(outcomes, [cancelled ? 'cancelled' : 'completed']);
    assert.equal(logs.length, 2);
  }
});

// A relay that serves `inbox` once and records what the waker sends.
function oneShotRelay(inbox) {
  const sent = [];
  const acked = [];
  return {
    sent,
    acked,
    read: async () => inbox.filter((m) => !acked.includes(m.id)),
    reply: async (soul, reply) => { sent.push(reply); return { messageId: `r-${sent.length}` }; },
    ack: async (soul, ids) => { acked.push(...ids); },
  };
}

// What the reach server journals when the turn calls send_message.
function sendDuringTurn(to, correlation, body = 'sent by the turn') {
  recordThreadMessage(id, { dir: 'out', id: `s-${Math.random()}`, to, correlation, body });
}

function relayWaker(relay, executor) {
  return createColdWaker({ executor, settings: { [id]: true }, lookupBinding: async () => binding, identities: async () => githubIdentity, receipt: () => {}, relay });
}

// #407: Bill, woken by Starter, asks Ted with send_message; his final text
// is narration ("Message sent to Ted…") and must not reach Starter.
test('a turn woken by a soul that used send_message sends no final text', async () => {
  const starter = { account: 'acct', agentId: 'agent_bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' };
  const relay = oneShotRelay([{ id: 'n407a', from: starter, body: 'Bill, ask Ted for a tip.' }]);
  const prompts = [];
  const wake = relayWaker(relay, async ({ message, invocation }) => {
    prompts.push(message);
    sendDuringTurn('acct/agent_cccccccc-cccc-4ccc-8ccc-cccccccccccc', invocation.correlation);
    return { reply: "Message sent to Ted. I'll wait for his reply." };
  });
  await wake({ agentId: id, count: 1, messageIds: ['n407a'] });
  await wake.idle();
  assert.match(prompts[0], /If you use send_message in this turn, your final answer is not sent at all/);
  assert.match(prompts[0], /skip thanks, acknowledgements and progress notes/);
  assert.deepEqual(relay.sent, []);
  assert.deepEqual(relay.acked, ['n407a']);
});

// A send under another thread, or one from before the turn, is not this
// turn speaking for itself.
test('sends outside the turn\'s thread do not hold back its reply', async () => {
  const peer = { account: 'acct', agentId: 'agent_dddddddd-dddd-4ddd-8ddd-dddddddddddd' };
  sendDuringTurn(`acct/${peer.agentId}`, 'n407b', 'an earlier send in this thread');
  const relay = oneShotRelay([{ id: 'n407b', from: peer, body: 'What is 2+2?' }]);
  const wake = relayWaker(relay, async () => {
    sendDuringTurn(`acct/${peer.agentId}`, 'some-other-thread');
    return { reply: '4' };
  });
  await wake({ agentId: id, count: 1, messageIds: ['n407b'] });
  await wake.idle();
  assert.deepEqual(relay.sent.map((m) => m.body), ['4']);
});

// A start_soul brief briefs the teammate; the soul that asked still gets the
// final answer (#407 review).
test('a start_soul brief to a teammate does not hold back the reply', async () => {
  const starter = { account: 'acct', agentId: 'agent_bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' };
  const relay = oneShotRelay([{ id: 'n407e', from: starter, body: 'Start a scout and tell me its name.' }]);
  const prompts = [];
  const wake = relayWaker(relay, async ({ message, invocation }) => {
    prompts.push(message);
    recordThreadMessage(id, { dir: 'out', id: 's-brief', to: 'agent_eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee', correlation: invocation.correlation, kind: 'brief', body: 'Scout the repo.' });
    return { reply: 'Started Scout.' };
  });
  await wake({ agentId: id, count: 1, messageIds: ['n407e'] });
  await wake.idle();
  assert.match(prompts[0], /A start_soul brief does not count/);
  assert.deepEqual(relay.sent.map((m) => m.body), ['Started Scout.']);
});

// #427: woken by one teammate's answer while another is still waking, the
// soul is told who it is still waiting on, so it neither re-pings nor sends
// progress notes; a person's message gets the same notice without NO_REPLY.
test('the prompt names the teammates the soul is still waiting on in this thread', async () => {
  const ted = { account: 'acct', agentId: 'agent_aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' };
  const twin = 'acct/agent_cccccccc-cccc-4ccc-8ccc-cccccccccccc';
  recordThreadMessage(id, { dir: 'out', id: 'w427-ted', to: `acct/${ted.agentId}`, correlation: 'c427', body: 'Ted, a tip?' });
  recordThreadMessage(id, { dir: 'out', id: 'w427-twin', to: twin, correlation: 'c427', kind: 'brief', body: 'Twin, scout.' });
  const relay = oneShotRelay([
    { id: 'n427a', from: ted, replyTo: 'w427-ted', correlation: 'c427', body: 'Tip: small commits.' },
    { id: 'n427b', from: { principal: 'owner' }, correlation: 'c427', body: 'Any news?' },
  ]);
  const prompts = [];
  const wake = relayWaker(relay, async ({ message }) => { prompts.push(message); return { reply: 'NO_REPLY' }; });
  await wake({ agentId: id, count: 2, messageIds: ['n427a', 'n427b'] });
  await wake.idle();
  assert.match(prompts[0], new RegExp(`still waiting on ${twin} in this conversation; its reply wakes you`));
  assert.doesNotMatch(prompts[0], /waiting on acct\/agent_aaaa/, 'Ted just answered');
  assert.match(prompts[0], /make your final answer exactly NO_REPLY\./);
  assert.match(prompts[1], /still waiting on acct\/agent_cccc/);
  assert.doesNotMatch(prompts[1], /NO_REPLY/, 'a person always gets the answer');
});

// A person still gets the final text after the turn messaged someone else,
// but not a second copy of an answer the turn already sent them.
test('a person gets the final text unless the turn already messaged them', async () => {
  const relay = oneShotRelay([
    { id: 'n407c', from: { principal: 'owner' }, body: 'Ask Ted, then tell me.' },
    { id: 'n407d', from: { principal: 'owner' }, body: 'Tell me when done.' },
  ]);
  let turn = 0;
  const wake = relayWaker(relay, async ({ invocation }) => {
    turn += 1;
    if (turn === 1) {
      sendDuringTurn('acct/agent_cccccccc-cccc-4ccc-8ccc-cccccccccccc', invocation.correlation);
      return { reply: 'Asked Ted; I will tell you what he says.' };
    }
    sendDuringTurn('owner', invocation.correlation, 'Done.');
    return { reply: 'Done.' };
  });
  await wake({ agentId: id, count: 2, messageIds: ['n407c', 'n407d'] });
  await wake.idle();
  assert.deepEqual(relay.sent.map((m) => [m.replyTo, m.body]), [['n407c', 'Asked Ted; I will tell you what he says.']]);
  assert.deepEqual(relay.acked, ['n407c', 'n407d']);
});

// #408: a turn the policy stopped, having said nothing, answers with the
// refused tools instead of silence; NO_REPLY and a real answer still win.
test('a turn stopped by the policy with nothing said gets a notice', async () => {
  const peer = { account: 'acct', agentId: 'agent_eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee' };
  const relay = oneShotRelay([
    { id: 'n408a', from: peer, body: 'Count your files.' },
    { id: 'n408b', from: peer, body: 'Thanks!' },
    { id: 'n408c', from: { principal: 'owner' }, body: 'List the folder.' },
  ]);
  const results = [
    { reply: '', denied: ['Bash'] },
    { reply: 'NO_REPLY', denied: ['Bash'] },
    { reply: 'I could not list it: shell use is not allowed for me.', denied: ['Bash'] },
  ];
  let turn = 0;
  const wake = relayWaker(relay, async () => results[turn++]);
  await wake({ agentId: id, count: 3, messageIds: ['n408a', 'n408b', 'n408c'] });
  await wake.idle();
  assert.deepEqual(relay.sent.map((m) => [m.replyTo, m.body]), [
    ['n408a', "I couldn't finish this: Bash is not allowed for me here (my owner's policy for this agent)."],
    ['n408c', 'I could not list it: shell use is not allowed for me.'],
  ]);
});

test('the denial notice names at most three tools and nothing else', () => {
  assert.equal(deniedNotice([]), null);
  assert.equal(deniedNotice(undefined), null);
  assert.equal(deniedNotice(['Bash', 'Bash']), "I couldn't finish this: Bash is not allowed for me here (my owner's policy for this agent).");
  assert.equal(
    deniedNotice(['Bash', 'Edit', 'mcp__x__y', 'WebFetch', 'Wri\nte']),
    "I couldn't finish this: Bash, Edit, mcp__x__y and 2 more are not allowed for me here (my owner's policy for this agent).",
  );
});

// #84: a turn whose harness is signed out marks the soul, tells each sender
// once, and leaves the messages for the turn after the owner signs in.
test('a signed-out harness is recorded once per outage and each sender is told once', async () => {
  const peer = { account: 'acct', agentId: 'agent_eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee' };
  const relay = oneShotRelay([
    { id: 'n84a', from: peer, body: 'Count your files.' },
    { id: 'n84b', from: { principal: 'owner' }, body: 'Hello?' },
  ]);
  const statuses = [];
  const receipts = [];
  let signedIn = false;
  let turns = 0;
  const wake = createColdWaker({
    executor: async () => {
      turns += 1;
      if (!signedIn) throw new Error('acp engine: agent error for session/prompt: OAuth access token has expired [agent stderr tail: refresh me]');
      return { reply: 'Done.' };
    },
    settings: { [id]: true },
    lookupBinding: async () => binding,
    identities: async () => ({ harness: 'claude' }),
    receipt: (entry) => receipts.push(entry),
    relay,
    authStatus: {
      failed: (agentId, status) => statuses.push(['failed', agentId, status]),
      cleared: (agentId) => statuses.push(['cleared', agentId]),
    },
  });
  await wake({ agentId: id, count: 2, messageIds: ['n84a', 'n84b'] });
  await wake.idle();
  // One harness attempt; the rest of the batch is told without running.
  assert.equal(turns, 1);
  const notice = "I couldn't answer this: my Claude sign-in has expired. My owner needs to sign me in again before I can work on it.";
  assert.deepEqual(relay.sent.map((m) => [m.replyTo, m.body]), [['n84a', notice], ['n84b', notice]]);
  assert.deepEqual(relay.acked, []);
  assert.deepEqual(statuses, [['failed', id, { status: 'expired', harness: 'claude' }]]);
  assert.deepEqual(receipts.at(-1), { event: 'cold-wake', agentId: id, decision: 'failed', detail: 'harness expired' });
  assert.equal(JSON.stringify(receipts).includes('refresh me'), false);
  // A signed-out harness never read the prompt, and the notice is the
  // daemon's, not the soul's: no aside for either (#404).
  const touched = (entry) => ['n84a', 'n84b'].includes(entry.messageId) || ['n84a', 'n84b'].includes(entry.replyTo);
  assert.deepEqual(readAsides(id, { limit: 500 }).asides.filter(touched), []);

  // A second wake in the same outage does not tell the same senders again.
  await wake({ agentId: id, count: 1, messageIds: ['n84a'] });
  await wake.idle();
  assert.equal(relay.sent.length, 2);

  signedIn = true;
  await wake({ agentId: id, count: 2, messageIds: ['n84a', 'n84b'] });
  await wake.idle();
  assert.deepEqual(relay.acked, ['n84a', 'n84b']);
  assert.deepEqual(statuses.at(-1), ['cleared', id]);
  // Once signed in, the turn's prompt and answer are asides as usual.
  assert.equal(readAsides(id, { limit: 500 }).asides.filter(touched).length > 0, true);
});

test('other turn failures are not sign-in failures', async () => {
  const relay = oneShotRelay([{ id: 'n84c', from: { principal: 'owner' }, body: 'Hi' }]);
  const statuses = [];
  const wake = createColdWaker({
    executor: async () => { throw new Error('acp engine: agent process exited before the turn finished'); },
    settings: { [id]: true },
    lookupBinding: async () => binding,
    identities: async () => githubIdentity,
    receipt: () => {},
    relay,
    authStatus: { failed: (...args) => statuses.push(args), cleared: (...args) => statuses.push(args) },
  });
  await wake({ agentId: id, count: 1, messageIds: ['n84c'] });
  await wake.idle();
  assert.deepEqual(statuses, []);
  assert.deepEqual(relay.sent, []);
});

// #596: a client that sends unlinked messages (GeniusBar's composer sends
// `{ to, body }`) gets a cold turn with no native session to resume, so the
// prior conversation must come from the soul's journal. That journal is on
// disk, so a rebuilt waker (a daemon restart) still finds it; another soul
// or another principal does not. The /v1 native-resume path is covered in
// interaction-continuity.test.mjs.
test('a cold relayed turn after a restart gets its principal\'s prior conversation, and no one else\'s', async () => {
  const soul = 'agent_59659659-5965-4965-8965-596596596596';
  const otherSoul = 'agent_59659659-5965-4965-8965-596596596597';
  const owner = 'principal_59659659-5965-4965-8965-596596596596';
  const stranger = 'principal_59659659-5965-4965-8965-596596596597';
  let replies = 0;
  const turnFor = (agentId, inbox, answer) => {
    const relay = { ...oneShotRelay(inbox), reply: async () => ({ messageId: `r596-${++replies}` }) };
    const seen = [];
    const wake = createColdWaker({
      executor: async (input) => { seen.push(input); return { reply: answer }; },
      settings: { [agentId]: true }, lookupBinding: async () => binding, identities: async () => githubIdentity, receipt: () => {}, relay,
    });
    return async () => {
      await wake({ agentId, count: inbox.length, messageIds: inbox.map((m) => m.id) });
      await wake.idle();
      assert.deepEqual(relay.acked, inbox.map((m) => m.id));
      return seen;
    };
  };
  await turnFor(soul, [{ id: 'm596-1', from: { principal: owner }, body: 'Remember the codeword cerulean-596.' }], 'Noted: cerulean-596.')();

  // A fresh waker over the same journal is the daemon after a restart.
  const [resumed] = await turnFor(soul, [{ id: 'm596-2', from: { principal: owner }, body: 'What was the codeword?' }], 'cerulean-596')();
  assert.equal(resumed.invocation.sessionId, undefined, 'a cold turn carries no /v1 session to resume');
  assert.match(resumed.message, /This session does not remember earlier turns, so the conversation so far is below\./);
  assert.match(resumed.message, /Remember the codeword cerulean-596\.[\s\S]*Noted: cerulean-596\.[\s\S]*The new message:\n\nWhat was the codeword\?$/);

  for (const [agentId, principal] of [[soul, stranger], [otherSoul, owner]]) {
    const [isolated] = await turnFor(agentId, [{ id: `m596-${agentId.slice(-1)}-${principal.slice(-1)}`, from: { principal }, body: 'What was the codeword?' }], 'none')();
    assert.doesNotMatch(isolated.message, /cerulean|does not remember earlier turns/);
    assert.match(isolated.message, /\n\nWhat was the codeword\?$/);
  }
});
