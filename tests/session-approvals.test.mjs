import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createSessionGrants } from '../session-approvals.mjs';
import { createContractExecutor } from '../executor-contract.mjs';
import { createDaemonServer, withPermissionReceipts } from '../agent-daemon.mjs';
import { coldTurnExecutor, createTurnRegistry } from '../wake-plane.mjs';
import { upsertSoul } from '../agent-population.mjs';

const ID = 'agent_11111111-1111-4111-8111-111111111111';
const OTHER = 'agent_22222222-2222-4222-8222-222222222222';
const approved = async () => ({ decision: 'approve', scope: 'session' });
function port(overrides = {}) {
  return { invocation: { agentId: ID }, message: 'go', attachments: [],
    appendEvent: () => ({}), addArtifact: () => ({}), signal: new AbortController().signal,
    requestApproval: approved, ...overrides };
}
function executor({ agentId = ID, session = 'one', tools = ['Bash'], mode = 'safe', fallback = 'approval', afterBind = () => {} } = {}) {
  return createContractExecutor({ harness: 'claude', identity: { agentId }, mode,
    policy: { version: 1, rules: [], fallback },
    run: async ({ bindHarnessSession, requestPermission, emitStop }) => {
      if (session) bindHarnessSession({ mode: 'resume', harnessSessionId: session });
      await afterBind();
      const decisions = [];
      for (const toolName of tools) decisions.push(await requestPermission({ toolName }));
      emitStop({ stopReason: 'end_turn' });
      return { decisions };
    } });
}
const sources = (result) => result.decisions.map((row) => row.decidedBy);

test('session grants span turns, isolate exact tools and souls, and clear on every session change', async () => {
  const sessionGrants = createSessionGrants();
  let proposals = 0;
  const input = port({ sessionGrants, requestApproval: async () => { proposals++; return approved(); } });
  assert.deepEqual(sources(await executor({ tools: ['Bash', 'Bash'] })(input)), ['approval', 'turn']);
  assert.deepEqual(sources(await executor({ tools: ['Bash', 'WebFetch'] })(input)), ['session', 'approval']);
  assert.deepEqual(sources(await executor({ agentId: OTHER })({ ...input, invocation: { agentId: OTHER } })), ['approval']);
  assert.deepEqual(sources(await executor({ session: 'two' })(input)), ['approval']);
  assert.deepEqual(sources(await executor()(input)), ['approval'], 'returning to an old session must not restore grants');
  assert.equal(proposals, 5);
  assert.deepEqual(sources(await executor()({ ...input, sessionGrants: createSessionGrants() })), ['approval'], 'restart has no grants');
});

test('once, denials, expired/cancelled approvals and unbound turns never grant a session', async () => {
  for (const decision of [{ decision: 'approve' }, { decision: 'deny' }, { decision: 'deny', expired: true }, { decision: 'deny', cancelled: true }]) {
    const sessionGrants = createSessionGrants();
    await executor()(port({ sessionGrants, requestApproval: async () => decision }));
    assert.deepEqual(sources(await executor()(port({ sessionGrants }))), ['approval']);
  }
  const sessionGrants = createSessionGrants();
  await executor({ session: null })(port({ sessionGrants }));
  assert.deepEqual(sources(await executor()(port({ sessionGrants }))), ['approval']);
});

test('computer-use, policy, autopilot, risk and turn decisions precede session grants', async () => {
  const sessionGrants = createSessionGrants();
  const grant = sessionGrants.bind(ID, 'one');
  for (const tool of ['Bash', 'Read', 'mcp__computer-use__click']) grant.add(tool);
  const input = port({ sessionGrants, requestApproval: () => assert.fail('must not propose') });
  for (const fallback of ['allow', 'deny']) {
    assert.deepEqual((await executor({ fallback })(input)).decisions, [{ outcome: fallback, decidedBy: 'policy' }]);
  }
  assert.deepEqual(sources(await executor({ mode: 'autopilot' })(input)), ['autopilot']);
  assert.deepEqual(sources(await executor({ tools: ['Read'] })(input)), ['risk']);
  assert.deepEqual((await executor({ tools: ['mcp__computer-use__click'], fallback: 'allow', mode: 'autopilot' })({ ...input, computerUseEnabled: () => false })).decisions,
    [{ outcome: 'deny', decidedBy: 'computer-use' }]);
});

test('late approvals cannot restore grants after clearing, session replacement, or cancellation', async () => {
  for (const invalidate of ['clear', 'replace', 'abort']) {
    const sessionGrants = createSessionGrants();
    const controller = new AbortController();
    await executor()(port({ sessionGrants, signal: controller.signal, requestApproval: async () => {
      if (invalidate === 'clear') sessionGrants.clear(ID);
      if (invalidate === 'replace') sessionGrants.bind(ID, 'two');
      if (invalidate === 'abort') controller.abort();
      return approved();
    } }));
    assert.deepEqual(sources(await executor()(port({ sessionGrants }))), ['approval']);
  }
});

test('cold turns share daemon grants, write session receipts, and stop/pause clear idle grants', async (t) => {
  const home = mkdtempSync(path.join(tmpdir(), 'session-approvals-'));
  const env = { HOME: home, AGENT_BOT_INTERACTION_HOME: path.join(home, 'interaction'), AGENT_BOT_POPULATION_PATH: path.join(home, 'population.json') };
  upsertSoul({ id: ID, name: 'session-soul', status: 'active', spacePath: home }, { file: env.AGENT_BOT_POPULATION_PATH });
  const turns = createTurnRegistry();
  const server = createDaemonServer({ env, home, config: {}, turns, ownerGate: async () => {}, settingGate: async () => {} });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await new Promise((resolve) => server.close(resolve)); rmSync(home, { recursive: true, force: true }); });
  const call = async (route, body) => {
    const response = await fetch(`http://127.0.0.1:${server.address().port}${route}`, { method: 'POST',
      headers: { authorization: `Bearer ${server.token}`, 'content-type': 'application/json' }, body: JSON.stringify(body) });
    assert.equal(response.status, 200);
    return response.json();
  };
  let proposals = 0;
  const execute = coldTurnExecutor({ turns, executorFor: () => withPermissionReceipts(executor(), { env, home }),
    approvals: async (request) => {
      proposals++;
      const waiting = server.interaction.requestTurnApproval(request);
      const [proposal] = server.interaction.listProposalsForOwner().proposals;
      await call('/v0/approvals/decide', { proposalId: proposal.proposalId, digest: proposal.operationDigest, decision: 'approve', scope: 'session' });
      return waiting;
    } });
  const input = { invocation: { agentId: ID, harness: 'claude', cwd: home }, message: 'go', attachments: [], env };
  assert.deepEqual(sources(await execute(input)), ['approval']);
  assert.deepEqual(sources(await execute(input)), ['session']);
  assert.equal(proposals, 1);
  const receipts = readFileSync(path.join(env.AGENT_BOT_INTERACTION_HOME, 'audit.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.ok(receipts.some((row) => row.event === 'permission' && row.operation === 'session:Bash' && row.decision === 'allow'));
  assert.deepEqual(await call('/v0/soul/stop', { agentId: ID }), { agentId: ID, stopped: false, reason: 'idle' });
  assert.deepEqual(sources(await execute(input)), ['approval']);
  await call('/v0/soul/pause', { agentId: ID });
  await call('/v0/soul/resume', { agentId: ID });
  assert.deepEqual(sources(await execute(input)), ['approval']);
  assert.equal(proposals, 3);
});
