import test from 'node:test';
import assert from 'node:assert/strict';

import { coldTurnExecutor, createWakePlane } from '../wake-plane.mjs';

const ID = 'agent_66666666-6666-4666-8666-666666666666';
const soul = { agentId: ID, worktree: '/work/tree', gitDir: '/work/tree/.git', file: '/work/tree/.git/agent-binding.json' };
const coldPool = { has: () => false, send: () => 0 };

function plane({ pool = coldPool, settings = { [ID]: true }, executorFor = null, receipts = [] } = {}) {
  return createWakePlane({
    pool,
    settings,
    lookupSoul: () => soul,
    identities: () => ({ harness: 'codex' }),
    executorFor,
    receipt: (record) => receipts.push(record),
  });
}

function wake(messageIds = ['m1']) {
  return { event: 'wake', agentId: ID, count: messageIds.length, cursor: 1, messageIds };
}

test('a warm socket takes the wake and the broker hears warm', async () => {
  const frames = [];
  const reports = [];
  const onWake = plane({ pool: { has: () => true, send: (_id, frame) => { frames.push(frame); return 1; } } });
  await onWake(wake(), { report: async (fields) => reports.push(fields) });
  assert.equal(frames.length, 1);
  assert.equal(reports[0].outcome, 'warm');
  assert.deepEqual(reports[0].messageIds, ['m1']);
});

test('without an executor, or with cold wake off, a cold soul waits', async () => {
  const reports = [];
  const report = async (fields) => reports.push(fields);
  await plane()(wake(), { report });
  let started = 0;
  await plane({ settings: {}, executorFor: () => async () => { started += 1; } })(wake(), { report });
  assert.deepEqual(reports.map((r) => r.outcome), ['waiting', 'waiting']);
  assert.equal(started, 0);
});

test('with cold wake on, one turn starts in the worktree with the soul\'s binding', async () => {
  const reports = [];
  const receipts = [];
  let built;
  let input;
  let finish;
  const onWake = plane({
    receipts,
    executorFor: (options) => {
      built = options;
      return async (value) => { input = value; await new Promise((resolve) => { finish = resolve; }); };
    },
  });
  const report = async (fields) => reports.push(fields);
  await onWake(wake(['m1', 'm2']), { report });
  await onWake(wake(['m3']), { report });
  assert.deepEqual(reports.map((r) => r.outcome), ['cold', 'cold']);
  assert.deepEqual(built, { agentId: ID, harness: 'codex', cwd: soul.worktree, env: { AGENT_BOT_BINDING: soul.file } });
  assert.match(input.message.text, /IDs: m1, m2/);
  // A cold turn has nobody to approve anything.
  assert.deepEqual(await input.requestApproval({ operation: {}, summary: 'x' }), { decision: 'deny' });
  finish();
  await onWake.idle();
  assert.ok(receipts.some((r) => r.event === 'cold-wake' && r.decision === 'finished'));
  assert.ok(receipts.every((r) => !('messageIds' in r)));
});

test('the cold turn executor supplies the contract ports and a turn deadline', async () => {
  let seen;
  const run = coldTurnExecutor({ executorFor: () => async (value) => { seen = value; }, turnTimeoutMs: 1_000 });
  await run({ invocation: { agentId: ID, harness: 'codex', cwd: '/w' }, message: { text: 'hi' }, attachments: [], env: {} });
  assert.equal(typeof seen.appendEvent, 'function');
  assert.equal(typeof seen.addArtifact, 'function');
  assert.equal(seen.signal.aborted, false);
});
