import test from 'node:test';
import assert from 'node:assert/strict';

import { createColdWaker } from '../cold-wake.mjs';

const id = 'agent_12345678-1234-4123-8123-123456789abc';
const binding = { worktree: '/work/tree', file: '/work/tree/.git/agent-bindings/child.json' };
const githubIdentity = { harness: 'codex', github: { appSlug: 'you-codex-agent' } };

test('cold wake is opt-in and reports waiting while disabled', async () => {
  let calls = 0;
  const wake = createColdWaker({ executor: async () => { calls += 1; }, settings: {}, lookupBinding: async () => binding, identities: async () => githubIdentity, receipt() {} });
  assert.deepEqual(await wake({ agentId: id, count: 1, cursor: 'c', messageIds: ['m1'] }), { outcome: 'waiting', detail: 'cold wake is disabled' });
  assert.equal(calls, 0);
});

test('cold wake clearly reports no-App souls as unsupported without starting a turn', async () => {
  let calls = 0;
  const receipts = [];
  const wake = createColdWaker({ executor: async () => { calls += 1; }, settings: { [id]: true }, lookupBinding: async () => binding, identities: async () => ({ harness: 'codex' }), receipt: (entry) => receipts.push(entry) });
  assert.deepEqual(await wake({ agentId: id, count: 1, messageIds: ['m1'] }), { outcome: 'failed', detail: 'cold wake is unsupported without a GitHub App identity' });
  assert.equal(calls, 0);
  assert.deepEqual(receipts, [{ event: 'cold-wake', agentId: id, decision: 'unsupported' }]);
});

test('enabled cold wake supplies message IDs, worktree and binding, and records a secret-free receipt', async () => {
  let input;
  const receipts = [];
  const wake = createColdWaker({ executor: async (value) => { input = value; }, settings: { [id]: true }, lookupBinding: async () => binding, identities: async () => githubIdentity, receipt: (value) => receipts.push(value) });
  assert.equal((await wake({ agentId: id, count: 2, cursor: 'c', messageIds: ['m1', 'm2'] })).outcome, 'cold');
  await wake.idle();
  assert.equal(input.invocation.cwd, binding.worktree);
  assert.equal(input.env.AGENT_BOT_BINDING, binding.file);
  assert.match(input.message.text, /2 agent-comms messages waiting \(IDs: m1, m2\)/);
  assert.match(input.message.text, /agent-comms inbox --full, act, and ack/);
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
