import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { approvalsCommand } from '../agent-approvals.mjs';
import { createInteractionService } from '../agent-interaction.mjs';
import { createDaemonServer } from '../agent-daemon.mjs';
import { createProposal, decideProposal, getProposal, interactionHome } from '../agent-jobs.mjs';
import { authorizeSouls, bindTransport, enrollPrincipal, setOperations } from '../agent-principals.mjs';
import { upsertSoul } from '../agent-population.mjs';
import { coldTurnExecutor } from '../wake-plane.mjs';

const AGENT_ID = 'agent_11111111-1111-4111-8111-111111111111';
const OTHER_ID = 'agent_22222222-2222-4222-8222-222222222222';
const OPERATION = { permission: { toolName: 'Bash', input: { command: 'git push' } } };
const roots = [];

after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

function scratch() {
  const root = mkdtempSync(path.join(tmpdir(), 'agent-approvals-'));
  roots.push(root);
  const env = {
    HOME: root,
    AGENT_BOT_INTERACTION_HOME: path.join(root, 'interaction'),
    AGENT_BOT_POPULATION_PATH: path.join(root, 'population.json'),
    AGENT_BOT_PRINCIPALS_PATH: path.join(root, 'principals.json'),
  };
  for (const id of [AGENT_ID, OTHER_ID]) {
    upsertSoul({
      id,
      appSlug: 'you-codex-agent',
      parentId: null,
      status: 'active',
      spacePath: `/spaces/${id}`,
      transcriptLocator: null,
      lastSeen: '2026-08-12T08:00:00.000Z',
    }, { file: env.AGENT_BOT_POPULATION_PATH });
  }
  return { root, env };
}

function principalFor(env, { souls = [AGENT_ID], operations = ['observe', 'approve'] } = {}) {
  const options = { file: env.AGENT_BOT_PRINCIPALS_PATH, env, home: '/nonexistent' };
  const principal = enrollPrincipal({ label: 'phone' }, options);
  bindTransport(principal.principalId, { transport: 'web', providerId: 'owner-subject' }, options);
  authorizeSouls(principal.principalId, souls, options);
  return setOperations(principal.principalId, operations, options);
}

function service(env, overrides = {}) {
  return createInteractionService({ env, home: '/nonexistent', config: {}, ...overrides });
}

async function settledSoon(promise, ms = 2_000) {
  return Promise.race([promise, new Promise((_, reject) => { setTimeout(() => reject(new Error('not settled')), ms); })]);
}

test('a proposal may belong to a soul instead of an invocation, and the owner may decide it', () => {
  const { env } = scratch();
  const options = { env, home: '/nonexistent' };
  assert.throws(() => createProposal({ operationDigest: 'a'.repeat(64), summary: 'x' }, options),
    /needs an invocation or a soul/);
  assert.throws(() => createProposal({ agentId: 'nope', operationDigest: 'a'.repeat(64), summary: 'x' }, options));
  const proposal = createProposal({ agentId: AGENT_ID, tool: 'Bash', operationDigest: 'a'.repeat(64), summary: 'push' }, options);
  assert.equal(proposal.invocationId, null);
  assert.equal(proposal.agentId, AGENT_ID);
  assert.equal(proposal.tool, 'Bash');
  const decided = decideProposal(proposal.proposalId, { decision: 'approved', decidedBy: 'owner' }, options);
  assert.equal(decided.decidedBy, 'owner');
  assert.equal(getProposal(proposal.proposalId, options).status, 'approved');
  assert.throws(() => decideProposal(proposal.proposalId, { decision: 'denied', decidedBy: 'owner' }, options));
  const other = createProposal({ agentId: AGENT_ID, operationDigest: 'b'.repeat(64), summary: 'y' }, options);
  assert.throws(() => decideProposal(other.proposalId, { decision: 'approved', decidedBy: 'someone' }, options));
});

test('a daemon turn waits on the owner, who sees soul, tool, summary and expiry', async () => {
  const { env } = scratch();
  const interaction = service(env);
  const waiting = interaction.requestTurnApproval({ agentId: AGENT_ID, operation: OPERATION, summary: 'git push', tool: 'Bash' });
  const { proposals } = interaction.listProposalsForOwner();
  assert.equal(proposals.length, 1);
  const [row] = proposals;
  assert.equal(row.agentId, AGENT_ID);
  assert.equal(row.tool, 'Bash');
  assert.equal(row.summary, 'git push');
  assert.equal(row.invocationId, null);
  assert.ok(Date.parse(row.expiresAt) > Date.parse(row.createdAt));

  assert.throws(() => interaction.decideProposalAsOwner({ proposalId: row.proposalId, decision: 'approve', digest: 'f'.repeat(64) }),
    (error) => error.statusCode === 409 && /digest/.test(error.message));
  assert.throws(() => interaction.decideProposalAsOwner({ proposalId: row.proposalId, decision: 'maybe', digest: row.operationDigest }),
    (error) => error.statusCode === 400);

  const decided = interaction.decideProposalAsOwner({ proposalId: row.proposalId, decision: 'approve', digest: row.operationDigest });
  assert.equal(decided.proposal.status, 'approved');
  assert.deepEqual(await settledSoon(waiting), { decision: 'approve' });
  assert.deepEqual(interaction.listProposalsForOwner(), { proposals: [] });
  assert.throws(() => interaction.decideProposalAsOwner({ proposalId: row.proposalId, decision: 'deny', digest: row.operationDigest }),
    (error) => error.statusCode === 409);

  const audit = readFileSync(path.join(interactionHome({ env, home: '/nonexistent' }), 'audit.jsonl'), 'utf8');
  assert.match(audit, /"event":"approval-requested"/);
  assert.match(audit, /"event":"approval-decision".*"decision":"approved"/);
  assert.equal(audit.includes('git push'), false);
});

test('a denied, expired or aborted turn approval resolves as a deny', async () => {
  const { env } = scratch();
  const interaction = service(env);

  const denied = interaction.requestTurnApproval({ agentId: AGENT_ID, operation: OPERATION, summary: 'one' });
  const [first] = interaction.listProposalsForOwner().proposals;
  interaction.decideProposalAsOwner({ proposalId: first.proposalId, decision: 'deny', digest: first.operationDigest });
  assert.deepEqual(await settledSoon(denied), { decision: 'deny' });

  const expired = interaction.requestTurnApproval({ agentId: AGENT_ID, operation: OPERATION, summary: 'two', ttlMs: 20 });
  assert.deepEqual(await settledSoon(expired), { decision: 'deny', expired: true });

  const controller = new AbortController();
  const aborted = interaction.requestTurnApproval({ agentId: AGENT_ID, operation: OPERATION, summary: 'three', signal: controller.signal });
  const [third] = interaction.listProposalsForOwner().proposals;
  controller.abort();
  assert.deepEqual(await settledSoon(aborted), { decision: 'deny', cancelled: true });
  assert.equal(getProposal(third.proposalId, { env, home: '/nonexistent' }).status, 'expired');
  assert.deepEqual(interaction.listProposalsForOwner(), { proposals: [] });
});

test('a turn proposal outlives no daemon: a restarted service does not list it', () => {
  const { env } = scratch();
  service(env).requestTurnApproval({ agentId: AGENT_ID, operation: OPERATION, summary: 'orphan', ttlMs: 60_000 });
  assert.deepEqual(service(env).listProposalsForOwner(), { proposals: [] });
});

test('a principal sees and decides only the souls it may approve for', async () => {
  const { env } = scratch();
  const interaction = service(env);
  const principal = principalFor(env);
  const mine = interaction.requestTurnApproval({ agentId: AGENT_ID, operation: OPERATION, summary: 'mine' });
  const theirs = interaction.requestTurnApproval({ agentId: OTHER_ID, operation: OPERATION, summary: 'theirs', ttlMs: 50 });
  const { proposals } = interaction.listProposals({ principal, transport: 'web' });
  assert.deepEqual(proposals.map((row) => row.agentId), [AGENT_ID]);
  const other = interaction.listProposalsForOwner().proposals.find((row) => row.agentId === OTHER_ID);
  assert.throws(() => interaction.decideProposal({
    principal, transport: 'web', proposalId: other.proposalId, decision: 'approve', digest: other.operationDigest,
  }), (error) => error.statusCode === 403);
  const decided = interaction.decideProposal({
    principal, transport: 'web', proposalId: proposals[0].proposalId, decision: 'approve', digest: proposals[0].operationDigest,
  });
  assert.equal(decided.proposal.status, 'approved');
  assert.deepEqual(await settledSoon(mine), { decision: 'approve' });
  assert.deepEqual(await settledSoon(theirs), { decision: 'deny', expired: true });
});

test('a cold turn asks the approvals port with the soul, the tool and its own signal', async () => {
  const asked = [];
  const run = coldTurnExecutor({
    turnTimeoutMs: 1_000,
    approvals: async (request) => { asked.push(request); return { decision: 'approve' }; },
    executorFor: () => async ({ requestApproval }) => ({ answer: await requestApproval({ operation: OPERATION, summary: 'push' }) }),
  });
  const result = await run({ invocation: { agentId: AGENT_ID, harness: 'codex', cwd: '/w' }, message: 'hi', attachments: [], env: {} });
  assert.deepEqual(result.answer, { decision: 'approve' });
  assert.equal(asked.length, 1);
  assert.equal(asked[0].agentId, AGENT_ID);
  assert.equal(asked[0].tool, 'Bash');
  assert.equal(asked[0].summary, 'push');
  assert.ok(asked[0].signal instanceof AbortSignal);
});

test('daemon /v0/approvals needs the daemon token; /v1/proposals needs an approving principal', async () => {
  const { env } = scratch();
  principalFor(env);
  const server = createDaemonServer({ env, home: '/nonexistent', config: {} });
  await new Promise((resolve) => { server.listen(0, '127.0.0.1', resolve); });
  const port = server.address().port;
  const call = (pathname, { method = 'GET', body, token = server.token } = {}) => fetch(`http://127.0.0.1:${port}${pathname}`, {
    method,
    headers: {
      ...(token === null ? {} : { authorization: `Bearer ${token}` }),
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  try {
    assert.equal((await call('/v0/approvals', { token: null })).status, 401);
    assert.equal((await call('/v0/approvals/decide', { method: 'POST', body: {}, token: 'wrong' })).status, 401);

    const waiting = server.interaction.requestTurnApproval({ agentId: AGENT_ID, operation: OPERATION, summary: 'push', tool: 'Bash' });
    const listed = await (await call('/v0/approvals')).json();
    assert.equal(listed.proposals.length, 1);
    const [row] = listed.proposals;
    assert.equal(row.tool, 'Bash');

    const viaPrincipal = await (await call('/v1/proposals?transport=web&providerId=owner-subject')).json();
    assert.deepEqual(viaPrincipal.proposals.map((proposal) => proposal.proposalId), [row.proposalId]);

    const mismatch = await call('/v0/approvals/decide', { method: 'POST', body: { proposalId: row.proposalId, decision: 'approve', digest: '0'.repeat(64) } });
    assert.equal(mismatch.status, 409);
    const decided = await call(`/v1/proposals/${row.proposalId}/decision`, {
      method: 'POST',
      body: { transport: 'web', providerId: 'owner-subject', decision: 'deny', digest: row.operationDigest },
    });
    assert.equal(decided.status, 200);
    assert.equal((await decided.json()).proposal.status, 'denied');
    assert.deepEqual(await settledSoon(waiting), { decision: 'deny' });
  } finally {
    await new Promise((resolve) => { server.close(resolve); });
  }
});

function fakeClient(proposals) {
  const decisions = [];
  return {
    decisions,
    async approvals() { return { proposals }; },
    async decideApproval(request) {
      decisions.push(request);
      const row = proposals.find((proposal) => proposal.proposalId === request.proposalId);
      return { proposal: { ...row, status: request.decision === 'approve' ? 'approved' : 'denied' } };
    },
  };
}

const ROW = {
  proposalId: 'proposal_33333333-3333-4333-8333-333333333333',
  invocationId: null,
  agentId: AGENT_ID,
  tool: 'Bash',
  operationDigest: 'c'.repeat(64),
  summary: 'git push',
  createdAt: '2026-10-03T10:00:00.000Z',
  expiresAt: '2026-10-03T10:15:00.000Z',
  status: 'open',
};

test('approvals list --json names the soul, tool, summary and expiry', async () => {
  const { env, root } = scratch();
  let out = '';
  const rows = await approvalsCommand(['list', '--json'], {
    env, home: root, cwd: root, client: fakeClient([ROW]), write: (text) => { out += text; }, gate: () => { throw new Error('no gate'); },
  });
  const parsed = JSON.parse(out);
  assert.deepEqual(parsed, { approvals: rows });
  assert.equal(rows[0].agentId, AGENT_ID);
  assert.equal(rows[0].tool, 'Bash');
  assert.equal(rows[0].summary, 'git push');
  assert.equal(rows[0].expiresAt, ROW.expiresAt);
  assert.equal('soul' in rows[0], true);
});

test('approvals approve gates on the owner and echoes the proposal digest', async () => {
  const { env, root } = scratch();
  const client = fakeClient([ROW]);
  const gated = [];
  const decided = await approvalsCommand(['approve', ROW.proposalId, '--json'], {
    env, home: root, cwd: root, client, write: () => {},
    gate: async (action, { principal }) => { gated.push({ action, principal }); },
  });
  assert.equal(decided.status, 'approved');
  assert.match(gated[0].action, /^approve Bash for .*agent_11111111.*: git push$/);
  assert.equal(gated[0].principal, null);
  assert.deepEqual(client.decisions, [{ proposalId: ROW.proposalId, decision: 'approve', digest: ROW.operationDigest }]);
});

test('a refused gate decides nothing; unknown proposals and soul callers are refused', async () => {
  const { env, root } = scratch();
  const client = fakeClient([ROW]);
  await assert.rejects(approvalsCommand(['deny', ROW.proposalId], {
    env, home: root, cwd: root, client, write: () => {}, gate: async () => { throw new Error('owner declined'); },
  }), /owner declined/);
  assert.deepEqual(client.decisions, []);
  await assert.rejects(approvalsCommand(['deny', 'proposal_44444444-4444-4444-8444-444444444444'], {
    env, home: root, cwd: root, client, write: () => {}, gate: async () => {},
  }), (error) => error.code === 'not-open');
  await assert.rejects(approvalsCommand(['list'], {
    env: { ...env, AGENT_BOT_ID: AGENT_ID }, home: root, cwd: root, client, write: () => {},
  }), (error) => error.code === 'not-owner');
  await assert.rejects(approvalsCommand(['approve'], { env, home: root, cwd: root, client, write: () => {} }), /usage/);
});
