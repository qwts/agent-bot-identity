import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { withPermissionReceipts } from '../agent-daemon.mjs';
import { auditFile } from '../agent-principals.mjs';
import { createContractExecutor } from '../executor-contract.mjs';
import { coldTurnExecutor } from '../wake-plane.mjs';

const AGENT_ID = 'agent_11111111-1111-4111-8111-111111111111';
const LONG_TOOL = `mcp__daemon__${'long_tool_'.repeat(9)}`;
const AT = '2026-10-05T10:00:00.000Z';

function scratch(t) {
  const home = mkdtempSync(path.join(tmpdir(), 'permission-receipts-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  return { home, env: { HOME: home, AGENT_BOT_INTERACTION_HOME: path.join(home, 'interaction') }, now: () => new Date(AT) };
}

function port(overrides = {}) {
  return {
    invocation: { agentId: AGENT_ID }, message: 'go', attachments: [],
    appendEvent: () => ({}), addArtifact: () => ({}),
    requestApproval: async () => ({ decision: 'approve' }),
    signal: new AbortController().signal, ...overrides,
  };
}

function executor(requests, opts) {
  const contract = createContractExecutor({
    harness: 'claude', identity: { app: 'qwts-claude-agent', agentId: AGENT_ID },
    policy: { version: 1, rules: [
      { tool: 'Read', outcome: 'allow' }, { tool: LONG_TOOL, outcome: 'allow' },
      { tool: 'WebFetch', outcome: 'approval' },
    ], fallback: 'deny' },
    run: async ({ bindHarnessSession, requestPermission, emitStop }) => {
      bindHarnessSession({ mode: 'new', harnessSessionId: 'receipt-session' });
      const results = [];
      for (const request of requests) results.push(await requestPermission(request));
      emitStop({ stopReason: 'end_turn' });
      return { results };
    },
  });
  return withPermissionReceipts(contract, opts);
}

function receipts(opts) {
  return readFileSync(auditFile(opts), 'utf8').trim().split('\n').map((line) => JSON.parse(line));
}

test('policy allow and deny write bounded, sanitized receipts and preserve observers', async (t) => {
  const opts = scratch(t);
  const seen = [];
  const run = executor([
    { toolName: 'Read', summary: 'inspect\nhttps://private.example/token\tthen read', operation: { privateInput: 'must not be recorded' } },
    { toolName: 'Bash', summary: 'run build' },
    { toolName: LONG_TOOL, summary: 'long summary '.repeat(40) },
  ], opts);
  const { results } = await run(port({ onPermission: (record) => seen.push(record) }));
  assert.deepEqual(results, [
    { outcome: 'allow', decidedBy: 'policy' }, { outcome: 'deny', decidedBy: 'policy' },
    { outcome: 'allow', decidedBy: 'policy' },
  ]);
  const rows = receipts(opts);
  assert.equal(rows.length, 3);
  assert.deepEqual(rows.map((row) => row.decision), ['allow', 'deny', 'allow']);
  assert.deepEqual(rows.map((row) => row.operation), ['Read', 'Bash', `${LONG_TOOL.slice(0, 39)}…`]);
  assert.equal(rows[0].detail, 'Read: inspect <url> then read');
  assert.equal(rows[1].detail, 'Bash: run build');
  assert.ok(rows[2].detail.startsWith(`${LONG_TOOL}: long summary`));
  assert.equal(rows[2].detail.length, 200);
  assert.ok(rows[2].detail.endsWith('…'));
  for (const row of rows) {
    assert.equal(row.event, 'permission');
    assert.equal(row.agentId, AGENT_ID);
    assert.equal(row.at, AT);
    assert.ok(row.operation.length <= 40);
    assert.ok(row.detail.length <= 200);
    assert.doesNotMatch(row.detail, /[\r\n\t]|https?:\/\//);
  }
  assert.equal(JSON.stringify(rows).includes('must not be recorded'), false);
  assert.equal(seen.length, 3);
  assert.equal(seen[0].summary, 'inspect\nhttps://private.example/token\tthen read');
});

test('cold turns write policy receipts without duplicating approval decisions', async (t) => {
  const opts = scratch(t);
  let approvals = 0;
  const run = coldTurnExecutor({
    executorFor: () => executor([{ toolName: 'Read' }, { toolName: 'Bash' }, { toolName: 'WebFetch' }], opts),
    approvals: async () => { approvals += 1; return { decision: 'deny' }; },
    turnTimeoutMs: 1000,
  });
  const result = await run({
    invocation: { agentId: AGENT_ID, harness: 'claude', cwd: opts.home },
    message: 'go', attachments: [], env: opts.env,
  });
  assert.deepEqual(result.denied, ['Bash', 'WebFetch']);
  assert.equal(approvals, 1);
  assert.equal(result.results[2].decidedBy, 'approval');
  assert.deepEqual(receipts(opts).map((row) => row.operation), ['Read', 'Bash']);
  // An approval that allows the tool is also excluded from policy receipts.
  await executor([{ toolName: 'WebFetch' }], opts)(port());
  assert.equal(receipts(opts).length, 2);
});

test('a maximum-length tool keeps its full name within the detail budget', async (t) => {
  const opts = scratch(t);
  const toolName = 'x'.repeat(200);
  const result = await executor([{ toolName, summary: 'no room for this summary' }], opts)(port());
  assert.equal(result.results[0].outcome, 'deny');
  const [row] = receipts(opts);
  assert.equal(row.operation, `${toolName.slice(0, 39)}…`);
  assert.equal(row.detail, toolName);
});

test('malformed tool requests remain denied and receipt failures do not change decisions', async (t) => {
  const opts = scratch(t);
  const requests = [{}, { toolName: 42 }, { toolName: 'bad\ntool' }];
  const { results } = await executor(requests, opts)(port());
  assert.ok(results.every((record) => record.outcome === 'deny'));
  const rows = receipts(opts);
  assert.equal(rows.length, 3);
  assert.ok(rows.every((record) => record.operation === undefined));
  assert.equal(rows[2].detail, 'bad tool');
  const blocked = path.join(opts.home, 'not-a-directory');
  writeFileSync(blocked, 'blocked');
  const seen = [];
  const result = await executor([{ toolName: 'Read' }], {
    ...opts, env: { ...opts.env, AGENT_BOT_INTERACTION_HOME: blocked },
  })(port({ onPermission: (record) => seen.push(record) }));
  assert.equal(result.results[0].outcome, 'allow');
  assert.equal(seen.length, 1);
});

for (const mode of ['safe', 'autopilot']) {
  test(`${mode} decisions leave permission receipts with bounded deciders`, async (t) => {
    const opts = scratch(t);
    const contract = createContractExecutor({ harness: 'claude', identity: { agentId: AGENT_ID }, mode,
      policy: { version: 1, rules: [], fallback: 'approval' },
      run: async ({ requestPermission, emitStop }) => {
        for (const toolName of ['Read', 'Bash', 'Bash', LONG_TOOL, LONG_TOOL]) await requestPermission({ toolName, summary: 'request summary' });
        emitStop({ stopReason: 'end_turn' });
      } });
    let approvals = 0;
    await withPermissionReceipts(contract, opts)(port({ requestApproval: async () => { approvals += 1; return { decision: 'approve' }; } }));
    const rows = receipts(opts);
    assert.equal(approvals, mode === 'safe' ? 2 : 0);
    assert.deepEqual(rows.map((row) => row.operation), mode === 'safe'
      ? ['risk:Read', 'turn:Bash', `${LONG_TOOL.slice(0, 39)}…`]
      : ['autopilot:Read', 'autopilot:Bash', 'autopilot:Bash', `${LONG_TOOL.slice(0, 39)}…`, `${LONG_TOOL.slice(0, 39)}…`]);
    assert.ok(rows.every((row) => row.event === 'permission' && row.decision === 'allow'));
    assert.equal(rows[0].detail, 'Read: request summary');
    assert.equal(rows[1].detail, 'Bash: request summary');
    assert.ok(rows.every((row) => row.operation.length <= 40 && row.detail.length <= 200));
  });
}
