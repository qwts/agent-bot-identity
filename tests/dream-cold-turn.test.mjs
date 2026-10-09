import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { acpExecutorFor, coldTurnExecutor, createTurnRegistry } from '../wake-plane.mjs';
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
  const rejected = assert.rejects(done, { name: 'AbortError' });
  await Promise.resolve();
  assert.deepEqual(turns.busy(), [ID]);
  controller.abort();
  assert.equal(observedSignal.aborted, true); assert.equal(approvalSignal.aborted, true);
  assert.deepEqual(turns.busy(), [ID], 'abort is not proof of settlement');
  release(); await rejected;
  assert.deepEqual(turns.busy(), []);
  assert.equal(records[0].kind, 'dream'); assert.equal(records[0].id, RUN); assert.equal(records[0].outcome, 'cancelled');
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
