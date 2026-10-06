import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createComputerUseActivity } from '../computer-use-activity.mjs';
import { createDaemonServer, daemonStateFile, daemonStatus, withPermissionReceipts } from '../agent-daemon.mjs';
import { createContractExecutor } from '../executor-contract.mjs';
import { auditFile } from '../agent-principals.mjs';

const AGENT = 'agent_11111111-1111-4111-8111-111111111111';
const OTHER = 'agent_22222222-2222-4222-8222-222222222222';
const TOOL = 'mcp__computer-use__left_click';
const AT = '2026-10-05T12:00:00.000Z';

function scratch(t) {
  const home = mkdtempSync(path.join(tmpdir(), 'computer-use-'));
  t.after(() => rmSync(home, { force: true, recursive: true }));
  const now = () => new Date(AT);
  return { home, now, computerUse: createComputerUseActivity({ now }), env: {
    HOME: home, XDG_STATE_HOME: path.join(home, 'state'),
    AGENT_BOT_INTERACTION_HOME: path.join(home, 'interaction'),
    AGENT_BOT_POPULATION_PATH: path.join(home, 'population.json'),
    AGENT_BOT_DAEMON_STATE_PATH: path.join(home, 'daemon.json'),
  } };
}

function execute(opts, { agentId = AGENT, policy = 'allow', decision = 'approve', controller = new AbortController(), during = () => {} } = {}) {
  let approvals = 0;
  return withPermissionReceipts(createContractExecutor({
    harness: 'claude', identity: { agentId, app: 'qwts-claude-agent' },
    policy: { version: 1, rules: [], fallback: policy },
    run: async ({ requestPermission, emitStop }) => {
      const result = await requestPermission({ toolName: TOOL });
      await during(result, requestPermission);
      emitStop({ stopReason: 'end_turn' });
    },
  }), opts)({ invocation: { agentId }, message: 'go', attachments: [],
    signal: controller.signal, appendEvent: () => ({}), addArtifact: () => ({}),
    requestApproval: async () => {
      if (approvals++ === 0) assert.deepEqual(opts.computerUse.list(), []);
      return { decision };
    },
  });
}

function activityReceipts(opts) {
  return readFileSync(auditFile(opts), 'utf8').trim().split('\n').map((line) => JSON.parse(line)).filter((row) => row.event === 'computer-use');
}

test('registry preserves first tool/time, independent agents and defensive snapshots', () => {
  const registry = createComputerUseActivity({ now: () => new Date(AT) });
  assert.equal(registry.stop(AGENT), null);
  assert.deepEqual(registry.start(AGENT, TOOL), { agentId: AGENT, tool: TOOL, since: AT });
  assert.equal(registry.start(AGENT, 'screenshot'), null);
  registry.start(OTHER, 'type');
  registry.list()[0].since = 'changed';
  assert.equal(registry.list()[0].since, AT);
  assert.equal(registry.stop(AGENT).tool, TOOL);
  assert.deepEqual(registry.list().map((row) => row.agentId), [OTHER]);
  registry.stop(OTHER);
  assert.deepEqual(registry.list(), []);
});

for (const policy of ['allow', 'approval']) {
  test(`${policy} starts activity during the turn and clears it after`, async (t) => {
    const opts = scratch(t);
    await execute(opts, { policy, during: async (_, requestPermission) => {
      assert.deepEqual(opts.computerUse.list(), [{ agentId: AGENT, tool: TOOL, since: AT }]);
      await requestPermission({ toolName: 'screenshot' });
    } });
    assert.deepEqual(opts.computerUse.list(), []);
    assert.deepEqual(activityReceipts(opts).map(({ operation, detail }) => ({ operation, detail })), [
      { operation: 'start', detail: TOOL }, { operation: 'stop', detail: TOOL },
    ]);
  });
}

for (const policy of ['deny', 'approval']) {
  test(`${policy} denial never starts activity`, async (t) => {
    const opts = scratch(t);
    await execute(opts, { policy, decision: 'deny', during: (result) => {
      assert.equal(result.outcome, 'deny');
      assert.deepEqual(opts.computerUse.list(), []);
    } });
    assert.deepEqual(opts.computerUse.list(), []);
    if (policy === 'deny') assert.deepEqual(activityReceipts(opts), []);
  });
}

test('throwing executors clear activity', async (t) => {
  const opts = scratch(t);
  await assert.rejects(execute(opts, { during: () => { throw new Error('turn failed'); } }), /turn failed/);
  assert.deepEqual(opts.computerUse.list(), []);
  assert.deepEqual(activityReceipts(opts).map((row) => row.operation), ['start', 'stop']);
});

test('abort clears immediately and later permission observations cannot restart activity', async (t) => {
  const opts = scratch(t);
  const controller = new AbortController();
  await execute(opts, { controller, during: async (_, requestPermission) => {
    controller.abort();
    assert.deepEqual(opts.computerUse.list(), []);
    await requestPermission({ toolName: TOOL });
    assert.deepEqual(opts.computerUse.list(), []);
  } });
  assert.deepEqual(activityReceipts(opts).map((row) => row.operation), ['start', 'stop']);
});

test('two agents and overlapping turns clear only their own activity', async (t) => {
  const opts = scratch(t);
  await execute(opts, { during: async () => {
    await execute(opts, { during: () => assert.equal(opts.computerUse.list().length, 1) });
    assert.equal(opts.computerUse.list().length, 1);
    await execute(opts, { agentId: OTHER, during: () => assert.equal(opts.computerUse.list().length, 2) });
    assert.deepEqual(opts.computerUse.list().map((row) => row.agentId), [AGENT]);
  } });
  assert.deepEqual(opts.computerUse.list(), []);
});

test('audit failures cannot change execution or cleanup', async (t) => {
  const opts = scratch(t);
  const blocked = path.join(opts.home, 'blocked');
  writeFileSync(blocked, 'not a directory');
  opts.env.AGENT_BOT_INTERACTION_HOME = blocked;
  await execute(opts, { during: (result) => {
    assert.equal(result.outcome, 'allow');
    assert.equal(opts.computerUse.list().length, 1);
  } });
  assert.deepEqual(opts.computerUse.list(), []);
});

test('health and daemon status expose only agent IDs and ISO start times', async (t) => {
  const opts = scratch(t);
  const token = 'test-only'.repeat(4);
  const server = createDaemonServer({ ...opts, config: {}, token });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const port = server.address().port;
  const health = async () => (await fetch(`http://127.0.0.1:${port}/v0/health`, {
    headers: { authorization: `Bearer ${token}` },
  })).json();
  writeFileSync(daemonStateFile(opts), JSON.stringify({ schemaVersion: 1, pid: process.pid, host: '127.0.0.1',
    port, token, startedAt: AT }), { mode: 0o600 });
  assert.deepEqual((await health()).computerUse, []);
  await execute(opts, { during: async () => {
    const expected = [{ agentId: AGENT, since: AT }];
    assert.deepEqual((await health()).computerUse, expected);
    assert.deepEqual((await daemonStatus(opts)).computerUse, expected);
    const { stdout } = await promisify(execFile)(process.execPath, ['agent-daemon.mjs', 'status', '--json'], { env: opts.env });
    assert.deepEqual(JSON.parse(stdout).computerUse, expected);
  } });
  assert.deepEqual((await health()).computerUse, []);
});
