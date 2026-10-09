import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { acpExecutorFor, coldTurnExecutor, createTurnRegistry } from '../wake-plane.mjs';
import { createDreamScheduler } from '../skill-dream-scheduler.mjs';
import { createAcpExecutor } from '../acp-engine.mjs';
import { createSoulHistory, readSoulHistory } from '../soul-history.mjs';

const ID = 'agent_66666666-6666-4666-8666-666666666666';
const RUN = '12345678-1234-4234-8234-123456789abc';
function fixture(t, { fallback = 'deny', approvals = null } = {}) {
  const root = mkdtempSync(path.join(realpathSync(tmpdir()), 'dream-cold-turn-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(path.join(root, '.soul-state'));
  const env = { HOME: root, PATH: process.env.PATH, AGENT_BOT_CONFIG: path.join(root, 'no-config') };
  const history = createSoulHistory({ soulDirFor: () => root });
  const turns = createTurnRegistry({ history });
  const registry = { codex: { harness: 'codex', enabled: true, command: process.execPath,
    args: [fileURLToPath(new URL('./fixtures/fake-acp-agent.mjs', import.meta.url))], stripEnv: [] } };
  const factory = acpExecutorFor({ identities: () => ({ github: null }), baseEnv: env,
    policy: { version: 1, rules: [], fallback },
    runtimeEnvFor: () => ({ FAKE_KEEP: 'runtime-selected' }),
    toolHomeEnvFor: () => ({ CODEX_HOME: path.join(root, 'tool-home') }),
    providerEnvFor: () => ({ env: { FAKE_SET: 'provider-canary' }, envKey: 'FAKE_SET' }),
    createExecutor: options => createAcpExecutor({ ...options, registry }),
  });
  return { root, turns, run: coldTurnExecutor({ executorFor: factory, turns, approvals, turnTimeoutMs: 5_000 }),
    input: { invocation: { agentId: ID, harness: 'codex', cwd: root }, env: {}, attachments: [], kind: 'dream', historyId: RUN } };
}

test('a pre-aborted maintenance caller never resolves the executor or provider credentials', async () => {
  let built = false;
  const controller = new AbortController(); controller.abort();
  const run = coldTurnExecutor({ executorFor: () => { built = true; throw new Error('must not build'); } });
  await assert.rejects(run({ invocation: { agentId: ID }, signal: controller.signal, kind: 'dream', historyId: RUN }), { name: 'AbortError' });
  assert.equal(built, false);
});

test('external cancellation reaches approvals and keeps the shared turn busy until execution settles', async () => {
  const records = [], turns = createTurnRegistry({ history: { turn: (_id, record) => records.push(record) } });
  const controller = new AbortController();
  let release, observedSignal, approvalSignal;
  const run = coldTurnExecutor({ turns, approvals: async request => { approvalSignal = request.signal; return { decision: 'deny' }; },
    executorFor: () => async input => {
      observedSignal = input.signal;
      await input.requestApproval({ operation: { permission: { toolName: 'Bash' } }, summary: 'fixture' });
      await new Promise(resolve => { release = resolve; });
    },
  });
  const done = run({ invocation: { agentId: ID }, message: 'CANARY', kind: 'dream', historyId: RUN, signal: controller.signal });
  await Promise.resolve();
  assert.deepEqual(turns.busy(), [ID]);
  controller.abort();
  assert.equal(observedSignal.aborted, true); assert.equal(approvalSignal.aborted, true);
  assert.deepEqual(turns.busy(), [ID], 'abort is not proof of settlement');
  release(); await done;
  assert.deepEqual(turns.busy(), []);
  assert.equal(records[0].kind, 'dream'); assert.equal(records[0].id, RUN); assert.equal(records[0].outcome, 'ok');
  assert.equal(JSON.stringify(records).includes('CANARY'), false);
});

test('dream turns use the real configured ACP factory and mirror facts without invented interaction or broker IDs', async t => {
  const f = fixture(t);
  const result = await f.run({ ...f.input, message: 'env-probe' });
  const seen = JSON.parse(result.reply);
  assert.equal(seen.cwd, f.root);
  assert.equal(seen.FAKE_KEEP, 'runtime-selected');
  assert.equal(seen.FAKE_SET, 'provider-canary');
  const mcp = JSON.stringify(seen.mcpServers);
  assert.ok(mcp.includes(path.join(f.root, 'tool-home')));
  assert.equal(mcp.includes('provider-canary'), false);
  assert.equal(mcp.includes('AGENT_BOT_REACH_INVOCATION'), false);
  assert.equal(mcp.includes(RUN), false, 'facts-only history ID grants no reach or broker context');
  assert.equal(Object.hasOwn(f.input.invocation, 'invocationId'), false);
  assert.equal(Object.hasOwn(f.input.invocation, 'sessionId'), false);
  const [record] = readSoulHistory(f.root).turns.records;
  assert.equal(record.id, RUN); assert.equal(record.kind, 'dream'); assert.equal(record.outcome, 'ok');
  assert.deepEqual(Object.keys(record), ['id', 'kind', 'startedAt', 'endedAt', 'harness', 'outcome']);
  assert.equal(JSON.stringify(record).includes('provider-canary'), false);
  const { kind, historyId, ...wake } = f.input;
  await f.run({ ...wake, message: 'hello' });
  const [latest] = readSoulHistory(f.root).turns.records;
  assert.equal(latest.kind, 'wake'); assert.equal(latest.id, null, 'ordinary wake defaults are unchanged');
});

test('a real maintenance harness receives caller abort and shared stop, then records settled cancellation', async t => {
  for (const mode of ['caller', 'shared-stop']) await t.test(mode, async t => {
    const f = fixture(t), controller = new AbortController();
    let bound;
    const ready = new Promise(resolve => { bound = resolve; });
    const done = f.run({ ...f.input, signal: controller.signal, message: 'hang', onSession: bound });
    const rejected = assert.rejects(done, { name: 'AbortError' });
    await Promise.race([ready, done.then(() => { throw new Error('fixture ended before binding'); })]);
    assert.deepEqual(f.turns.busy(), [ID]);
    if (mode === 'caller') controller.abort();
    else assert.equal(f.turns.stop(ID), true);
    await rejected;
    assert.deepEqual(f.turns.busy(), []);
    assert.equal(readSoulHistory(f.root).turns.records[0].outcome, 'cancelled');
  });
});

test('dream tool requests keep the configured deny/approval behavior through the actual engine', async t => {
  for (const mode of ['deny', 'approval-without-owner-port', 'approval-allowed']) await t.test(mode, async t => {
    const requests = [];
    const f = fixture(t, { fallback: mode === 'deny' ? 'deny' : 'approval', approvals: mode === 'approval-allowed'
      ? async request => { requests.push(request); return { decision: 'approve', scope: 'once' }; } : null });
    const result = await f.run({ ...f.input, message: 'need-permission' });
    assert.match(result.reply, mode === 'approval-allowed' ? /opt-allow/ : /opt-reject/);
    assert.equal(requests.length, mode === 'approval-allowed' ? 1 : 0);
    if (requests.length) { assert.equal(requests[0].agentId, ID); assert.equal(requests[0].tool, 'Bash'); }
  });
});

test('ordinary wake calls still reject a resolved executor after cancellation', async () => {
  const controller = new AbortController(), records = [];
  const turns = createTurnRegistry({ history: { turn: (_id, record) => records.push(record) } });
  const run = coldTurnExecutor({ turns, executorFor: () => async () => { controller.abort(); return {}; } });
  await assert.rejects(run({ invocation: { agentId: ID }, signal: controller.signal }), { name: 'AbortError' });
  assert.equal(records[0].kind, 'wake'); assert.equal(records[0].outcome, 'cancelled');
});

test('cold calls reject invalid deadlines before resolving runtime or credentials', async () => {
  let built = 0;
  const run = coldTurnExecutor({ executorFor: () => { built++; throw new Error('must not resolve'); } });
  for (const timeoutMs of [null, 0, -1, 1.5, '1000', Infinity, 0x80000000]) {
    await assert.rejects(run({ invocation: { agentId: ID }, kind: 'dream', timeoutMs }), /timeout must be/);
  }
  assert.equal(built, 0);
});

test('the shorter caller or host deadline aborts execution without prematurely releasing the turn', async t => {
  for (const mode of ['caller', 'host']) await t.test(mode, async t => {
    const turns = createTurnRegistry();
    let settle;
    const run = coldTurnExecutor({ turns, turnTimeoutMs: mode === 'host' ? 10 : 5_000,
      executorFor: () => input => new Promise((resolve, reject) => {
        input.signal.addEventListener('abort', () => { settle = () => reject(input.signal.reason); }, { once: true });
      }),
    });
    const done = run({ invocation: { agentId: ID }, kind: 'dream', timeoutMs: mode === 'caller' ? 10 : 5_000 });
    const rejected = assert.rejects(done, { name: 'AbortError' });
    // Keep the event loop alive for AbortSignal.timeout's unref'ed timer.
    const limit = Date.now() + 2_000;
    while (!settle && Date.now() < limit) await new Promise(resolve => setTimeout(resolve, 5));
    assert.ok(settle, 'the shorter deadline reached the executor');
    assert.deepEqual(turns.busy(), [ID], 'a timeout requests cancellation, not settlement');
    settle(); await rejected;
    assert.deepEqual(turns.busy(), []);
  });
});

test('the scheduler and shared cold registry preserve actual settlement and durable cancellation facts', async t => {
  for (const reason of ['owner', 'timeout']) for (const resolves of [true, false]) await t.test(`${reason}/${resolves ? 'resolved' : 'rejected'}`, async () => {
    let state = null, settle, observedSignal, timer;
    const records = [], events = [];
    const turns = createTurnRegistry({ history: { turn: (_id, record) => records.push(record) } });
    const runCold = coldTurnExecutor({ turns, executorFor: () => input => {
      observedSignal = input.signal;
      return new Promise((resolve, reject) => { settle = () => resolves ? resolve({}) : reject(new Error('executor stopped')); });
    } });
    const scheduler = createDreamScheduler({
      store: { read: () => structuredClone(state), commit(change) {
        if ((state?.revision ?? 0) !== change.expectedRevision) return false;
        state = structuredClone(change.state); events.push(...structuredClone(change.events)); return true;
      } },
      soulDirectory: () => path.join(realpathSync(tmpdir()), 'dream-settlement-fixture'),
      isBusy: id => turns.busy().includes(id),
      execute: ({ run, signal, timeoutMs }) => runCold({ invocation: { agentId: run.agentId }, kind: 'dream', historyId: run.runId, signal, timeoutMs }),
      setTimer: callback => { timer = callback; return 1; }, clearTimer: () => {},
    });
    scheduler.register(ID, 'PT1H');
    const started = scheduler.runNow(ID);
    await Promise.resolve();
    assert.ok(settle);
    if (reason === 'owner') scheduler.cancel(started.runId); else timer();
    assert.equal(observedSignal.aborted, true);
    assert.deepEqual(turns.busy(), [ID]);
    assert.equal(scheduler.runNow(ID).status, 'deferred');
    assert.equal(state.flights[0].status, 'cancelling');
    settle();
    const receipt = await started.done;
    assert.equal(receipt.status, resolves ? 'completed' : reason === 'owner' ? 'cancelled' : 'timed-out');
    assert.equal(receipt.cancelReason, reason); assert.ok(receipt.cancelRequestedAt);
    assert.equal(records[0].outcome, resolves ? 'ok' : 'cancelled');
    assert.equal(records[0].id, started.runId);
    assert.deepEqual(state.flights, []); assert.deepEqual(turns.busy(), []);
    assert.deepEqual(state.registrations[0].lastRun, receipt);
    assert.deepEqual(events.at(-1).run, receipt);
  });
});
