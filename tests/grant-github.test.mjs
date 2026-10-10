// Delegation grants spent as the owner's account (#108 slice 2): the daemon
// reads the owner's narrow token from pass-cli, checks GitHub names the
// configured login, performs the one approved write and receipts the
// account. keyd, pass-cli and GitHub are fakes; the token never appears in a
// receipt, an answer or an error.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { createDaemonServer } from '../agent-daemon.mjs';
import { createMcpState, handleMcpMessage } from '../agent-mcp.mjs';
import { ensureAgentIdentity, stateDirectory } from '../agent-identity.mjs';
import { mintBindToken } from '../agent-binding.mjs';
import { humanTokenItem, itemTitle } from '../credential-names.mjs';
import { createGrantLedger } from '../delegation-grants.mjs';
import { GRANT_ACTS, createGrantActor, humanTokenTitle, readHumanToken } from '../grant-github.mjs';
import { supervisorEnvironment } from '../daemon-supervisor.mjs';

const AGENT_ID = 'agent_dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const TOKEN = 'github_pat_never-leaks-0123456789';
const COMMENT = { operation: 'issue-comment', repo: 'qwts/agent-bot-identity', number: 108, body: 'Thanks, picked up.' };
const REVIEW = { operation: 'review-request', repo: 'qwts/agent-bot-identity', number: 801, reviewers: ['octocat'] };
const roots = [];

after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

function scratch(extra = {}) {
  const root = mkdtempSync(path.join(tmpdir(), 'grant-github-'));
  roots.push(root);
  const env = {
    XDG_STATE_HOME: path.join(root, 'state'),
    AGENT_BOT_SPACES_HOME: path.join(root, 'spaces'),
    AGENT_BOT_POPULATION_PATH: path.join(root, 'population.json'),
    AGENT_BOT_DAEMON_STATE_PATH: path.join(root, 'daemon.json'),
    AGENT_BOT_PRINCIPALS_PATH: path.join(root, 'principals.json'),
    AGENT_BOT_INTERACTION_HOME: path.join(root, 'interaction'),
    AGENT_BOT_HUMAN_LOGIN: 'qwts',
    ...extra,
  };
  return { root, env };
}

// A pass-cli store holding `notes` by title; a title not there is missing.
function noteStore(notes) {
  const reads = [];
  return {
    reads,
    read(title) {
      reads.push(title);
      if (notes[title] instanceof Error) throw notes[title];
      if (!(title in notes)) throw Object.assign(new Error(`no item ${title}`), { code: 'missing-item' });
      return notes[title];
    },
  };
}

// GitHub: GET /user answers `login`; writes answer `writeStatus`. A failed
// write echoes the request, token included, as a careless server might.
function fakeGitHub({ login = 'qwts', writeStatus = 201 } = {}) {
  const calls = [];
  const fetchImpl = async (url, options) => {
    const target = new URL(url);
    calls.push({ method: options.method, path: target.pathname, authorization: options.headers.authorization, body: options.body ? JSON.parse(options.body) : null });
    if (target.pathname === '/user') return Response.json({ login });
    if (writeStatus >= 400) return new Response(`bad request with ${options.headers.authorization}`, { status: writeStatus });
    return Response.json({ id: 1 }, { status: writeStatus });
  };
  return { calls, fetchImpl };
}

function ledgerFor(env) {
  const asked = [];
  const ledger = createGrantLedger({
    env, home: '/nonexistent', presence: async (action) => { asked.push(action); return { method: 'presence' }; },
  });
  return { ledger, asked };
}

function auditText(env) {
  try { return readFileSync(path.join(env.AGENT_BOT_INTERACTION_HOME, 'audit.jsonl'), 'utf8'); } catch { return ''; }
}

function grantReceipts(env) {
  return auditText(env).trim().split('\n').filter(Boolean).map((line) => JSON.parse(line))
    .filter((row) => row.event === 'delegation-grant');
}

async function approved(ledger, operation) {
  const grant = ledger.request({ agentId: AGENT_ID, operation });
  await ledger.approve(grant.proposalId, { digest: grant.operationDigest });
  return grant;
}

test('the human token note is named in credential-names and follows the host namespace', () => {
  assert.equal(itemTitle(humanTokenItem('qwts', { namespace: 'agent-bot' })), 'agent-bot.human/qwts-github-token');
  assert.equal(humanTokenTitle('qwts', {}), 'agent-bot.human/qwts-github-token');
  assert.equal(humanTokenTitle('qwts', { AGENT_BOT_CREDENTIAL_NAMESPACE: 'acme-bot' }), 'acme-bot.human/qwts-github-token');
  assert.throws(() => humanTokenItem('not/a login'), /invalid GitHub login/);
  // The vault is the store's: a host vault the store refuses is unavailable, not missing.
  assert.throws(() => readHumanToken({ env: { AGENT_BOT_CREDENTIAL_VAULT: ' bad' }, login: 'qwts' }), { code: 'human-token-unavailable' });
});

test('a missing note refuses with human-token-missing and leaves the grant to spend once stored', async () => {
  const { env } = scratch();
  const { ledger } = ledgerFor(env);
  const notes = {};
  const github = fakeGitHub();
  const actor = createGrantActor({ env, store: noteStore(notes), fetchImpl: github.fetchImpl });
  const grant = await approved(ledger, COMMENT);

  await assert.rejects(ledger.spend(grant.proposalId, { agentId: AGENT_ID, operation: COMMENT }, actor.perform, { prepare: actor.prepare }),
    (error) => {
      assert.equal(error.code, 'human-token-missing');
      assert.match(error.message, /agent-bot\.human\/qwts-github-token/);
      return true;
    });
  assert.equal(github.calls.length, 0);

  notes['agent-bot.human/qwts-github-token'] = `${TOKEN}\n`;
  const spent = await ledger.spend(grant.proposalId, { agentId: AGENT_ID, operation: COMMENT }, actor.perform, { prepare: actor.prepare });
  assert.equal(spent.status, 'spent');
  assert.match(spent.receipt.detail, / as qwts$/);
  assert.deepEqual(github.calls.map((call) => [call.method, call.path]), [
    ['GET', '/user'],
    ['POST', '/repos/qwts/agent-bot-identity/issues/108/comments'],
  ]);
  assert.deepEqual(github.calls[1].body, { body: COMMENT.body });
  assert.ok(github.calls.every((call) => call.authorization === `Bearer ${TOKEN}`));

  // Spent once: a second spend finds nothing, and GitHub is not called again.
  await assert.rejects(ledger.spend(grant.proposalId, { agentId: AGENT_ID, operation: COMMENT }, actor.perform, { prepare: actor.prepare }),
    { code: 'grant-unavailable' });
  assert.equal(github.calls.length, 2);
  assert.deepEqual(grantReceipts(env).filter((row) => row.operation === 'spend').map((row) => [row.decision, row.reason ?? null]),
    [['refused', 'human-token-missing'], ['spent', null], ['refused', 'grant-unavailable']]);
  assert.doesNotMatch(auditText(env), new RegExp(TOKEN));
});

test('a token for another account or an unset login refuses without spending', async () => {
  const { env } = scratch();
  const { ledger } = ledgerFor(env);
  const store = noteStore({ 'agent-bot.human/qwts-github-token': TOKEN });
  const grant = await approved(ledger, COMMENT);
  const spend = (actor) => ledger.spend(grant.proposalId, { agentId: AGENT_ID, operation: COMMENT }, actor.perform, { prepare: actor.prepare });

  const stranger = fakeGitHub({ login: 'someone-else' });
  await assert.rejects(spend(createGrantActor({ env, store, fetchImpl: stranger.fetchImpl })), { code: 'human-login-mismatch' });
  assert.deepEqual(stranger.calls.map((call) => call.path), ['/user']);

  const unset = fakeGitHub();
  await assert.rejects(spend(createGrantActor({ env: { ...env, AGENT_BOT_HUMAN_LOGIN: '' }, store, fetchImpl: unset.fetchImpl })),
    { code: 'human-login-unconfigured' });
  assert.equal(unset.calls.length, 0);

  const down = { fetchImpl: async () => { throw new Error(`connect failed with ${TOKEN}`); } };
  await assert.rejects(spend(createGrantActor({ env, store, fetchImpl: down.fetchImpl })), (error) => {
    assert.equal(error.code, 'human-check-failed');
    assert.doesNotMatch(error.message, new RegExp(TOKEN));
    return true;
  });

  // GitHub logins are case-insensitive; the receipt names the account GitHub reported.
  const cased = fakeGitHub({ login: 'QWTS' });
  const spent = await spend(createGrantActor({ env, store, fetchImpl: cased.fetchImpl }));
  assert.match(spent.receipt.detail, / as QWTS$/);

  assert.doesNotMatch(auditText(env), new RegExp(TOKEN));
});

test('an issue-state grant closes or reopens the issue as the owner', async () => {
  const { env } = scratch();
  const { ledger } = ledgerFor(env);
  const store = noteStore({ 'agent-bot.human/qwts-github-token': TOKEN });
  const github = fakeGitHub({ writeStatus: 200 });
  const actor = createGrantActor({ env, store, fetchImpl: github.fetchImpl });
  for (const state of ['closed', 'open']) {
    const operation = { operation: 'issue-state', repo: 'qwts/agent-bot-identity', number: 108, state };
    const grant = await approved(ledger, operation);
    const spent = await ledger.spend(grant.proposalId, { agentId: AGENT_ID, operation }, actor.perform, { prepare: actor.prepare });
    assert.match(spent.receipt.detail, / as qwts$/);
    assert.deepEqual(github.calls.at(-1), {
      method: 'PATCH', path: '/repos/qwts/agent-bot-identity/issues/108', authorization: `Bearer ${TOKEN}`, body: { state },
    });
  }
  assert.doesNotMatch(auditText(env), new RegExp(TOKEN));
});

test('an operation the actor does not perform refuses before anything is read', async () => {
  const github = fakeGitHub();
  const store = noteStore({ 'agent-bot.human/qwts-github-token': TOKEN });
  const actor = createGrantActor({ env: scratch().env, store, fetchImpl: github.fetchImpl });
  await assert.rejects(actor.prepare({ operation: 'pr-approve', repo: 'qwts/x', number: 1 }), { code: 'grant-unsupported' });
  assert.equal(github.calls.length, 0);
  assert.equal(store.reads.length, 0);
});

test('a review request posts the reviewers; a failed write spends the grant and leaks nothing', async () => {
  const { env } = scratch();
  const { ledger } = ledgerFor(env);
  const store = noteStore({ 'agent-bot.human/qwts-github-token': TOKEN });
  const github = fakeGitHub();
  const actor = createGrantActor({ env, store, fetchImpl: github.fetchImpl });
  const review = await approved(ledger, REVIEW);
  await ledger.spend(review.proposalId, { agentId: AGENT_ID, operation: REVIEW }, actor.perform, { prepare: actor.prepare });
  assert.deepEqual(github.calls.at(-1), {
    method: 'POST', path: '/repos/qwts/agent-bot-identity/pulls/801/requested_reviewers', authorization: `Bearer ${TOKEN}`, body: { reviewers: ['octocat'] },
  });

  const failing = fakeGitHub({ writeStatus: 422 });
  const broken = createGrantActor({ env, store, fetchImpl: failing.fetchImpl });
  const comment = await approved(ledger, COMMENT);
  await assert.rejects(ledger.spend(comment.proposalId, { agentId: AGENT_ID, operation: COMMENT }, broken.perform, { prepare: broken.prepare }),
    (error) => {
      assert.equal(error.code, 'grant-act-failed');
      assert.doesNotMatch(error.message, new RegExp(TOKEN));
      return true;
    });
  const failed = grantReceipts(env).at(-1);
  assert.deepEqual([failed.decision, failed.reason], ['failed', 'github-http-422']);
  assert.match(failed.detail, / as qwts$/);
  await assert.rejects(ledger.spend(comment.proposalId, { agentId: AGENT_ID, operation: COMMENT }, broken.perform, { prepare: broken.prepare }),
    { code: 'grant-unavailable' });
  assert.doesNotMatch(auditText(env), new RegExp(TOKEN));
});

test('concurrent spends of one grant perform once, even across an awaited prepare', async () => {
  const { env } = scratch();
  const { ledger } = ledgerFor(env);
  const store = noteStore({ 'agent-bot.human/qwts-github-token': TOKEN });
  const github = fakeGitHub();
  const actor = createGrantActor({ env, store, fetchImpl: github.fetchImpl });
  const grant = await approved(ledger, COMMENT);
  const results = await Promise.allSettled([1, 2, 3].map(() =>
    ledger.spend(grant.proposalId, { agentId: AGENT_ID, operation: COMMENT }, actor.perform, { prepare: actor.prepare })));
  assert.deepEqual(results.map((result) => result.status).sort(), ['fulfilled', 'rejected', 'rejected']);
  assert.ok(results.filter((result) => result.status === 'rejected').every((result) => result.reason.code === 'grant-unavailable'));
  assert.equal(github.calls.filter((call) => call.method === 'POST').length, 1);
});

test('the daemon unit carries a valid human login and drops a malformed one', () => {
  assert.equal(supervisorEnvironment({ env: { AGENT_BOT_HUMAN_LOGIN: 'qwts' }, home: '/nonexistent' }).AGENT_BOT_HUMAN_LOGIN, 'qwts');
  assert.equal(supervisorEnvironment({ env: { AGENT_BOT_HUMAN_LOGIN: 'bad login"' }, home: '/nonexistent' }).AGENT_BOT_HUMAN_LOGIN, undefined);
});

function boundWorktree(root, env) {
  ensureAgentIdentity({
    gate: () => true,
    appSlug: 'you-codex-agent',
    botUid: '308462948',
    harness: 'codex',
    transcript: { provider: 'codex', id: 'thread-grant' },
    stateDir: stateDirectory({ env, home: '/nonexistent' }),
    idFactory: () => AGENT_ID,
    now: () => new Date('2026-10-09T08:00:00.000Z'),
  });
  const worktree = path.join(root, 'worktree');
  mkdirSync(worktree, { recursive: true });
  execFileSync('git', ['init', '-q', worktree]);
  const gitDir = path.join(worktree, '.git');
  return { gitDir, record: mintBindToken({ gitDir, worktree, agentId: AGENT_ID }) };
}

async function withServer(env, options, run) {
  const server = createDaemonServer({ env, home: '/nonexistent', config: { features: { 'github-identity': true } }, ...options });
  await new Promise((resolve) => { server.listen(0, '127.0.0.1', resolve); });
  const port = server.address().port;
  const call = (pathname, { body, secret = null, token = null } = {}) => fetch(`http://127.0.0.1:${port}${pathname}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(secret ? { 'x-agent-binding': secret } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body ?? {}),
  });
  try {
    await run({ call, server });
  } finally {
    await new Promise((resolve) => { server.close(resolve); });
  }
}

test('the daemon routes request with owner presence and spend once for the bound soul', async () => {
  const { root, env } = scratch();
  const fixture = boundWorktree(root, env);
  const { ledger, asked } = ledgerFor(env);
  const notes = {};
  const github = fakeGitHub();
  const grantActor = createGrantActor({ env, store: noteStore(notes), fetchImpl: github.fetchImpl });
  await withServer(env, { grantLedger: ledger, grantActor }, async ({ call, server }) => {
    // No binding, or only the daemon bearer, is refused.
    assert.equal((await call('/v0/grants/request', { body: { operation: COMMENT } })).status, 401);
    assert.equal((await call('/v0/grants/request', { body: { operation: COMMENT }, token: server.token })).status, 401);
    assert.equal((await call('/v0/grants/spend', { body: { proposalId: 'x', operation: COMMENT } })).status, 401);
    assert.deepEqual(grantReceipts(env).map((row) => [row.operation, row.decision, row.reason]), [
      ['request', 'denied', 'no-live-binding'], ['request', 'denied', 'no-live-binding'], ['spend', 'denied', 'no-live-binding'],
    ]);

    const bind = await call('/v0/bind', {
      token: server.token,
      body: { gitDir: fixture.gitDir, token: fixture.record.token, transcript: { provider: 'codex', id: 'thread-grant' } },
    });
    assert.equal(bind.status, 200);
    const { secret } = await bind.json();

    const merge = await call('/v0/grants/request', { secret, body: { operation: { ...COMMENT, operation: 'pr-merge' } } });
    assert.equal(merge.status, 400);
    assert.equal((await merge.json()).code, 'grant-refused');

    const requested = await call('/v0/grants/request', { secret, body: { operation: COMMENT } });
    assert.equal(requested.status, 200);
    const { grant } = await requested.json();
    assert.equal(grant.status, 'approved');
    assert.equal(asked.length, 1);
    assert.match(asked[0], new RegExp(`^let ${AGENT_ID} comment on qwts/agent-bot-identity#108`));

    const missing = await call('/v0/grants/spend', { secret, body: { proposalId: grant.proposalId, operation: COMMENT } });
    assert.equal(missing.status, 503);
    assert.equal((await missing.json()).code, 'human-token-missing');

    notes['agent-bot.human/qwts-github-token'] = TOKEN;
    const spent = await call('/v0/grants/spend', { secret, body: { proposalId: grant.proposalId, operation: COMMENT } });
    assert.equal(spent.status, 200);
    const answer = await spent.json();
    assert.equal(answer.status, 'spent');
    assert.match(answer.receipt.detail, / as qwts$/);
    assert.doesNotMatch(JSON.stringify(answer), new RegExp(TOKEN));

    const again = await call('/v0/grants/spend', { secret, body: { proposalId: grant.proposalId, operation: COMMENT } });
    assert.equal(again.status, 404);
    assert.equal((await again.json()).code, 'grant-unavailable');
  });
  assert.equal(github.calls.filter((call) => call.method === 'POST').length, 1);
  assert.doesNotMatch(auditText(env), new RegExp(TOKEN));
});

test('the MCP grant tools need a binding and show the daemon\'s sentence and code', async () => {
  const sent = [];
  const client = {
    async requestGrant(secret, operation) { sent.push(['request', secret, operation]); return { grant: { proposalId: 'p', status: 'approved' } }; },
    async spendGrant(secret, proposalId, operation) {
      sent.push(['spend', secret, proposalId, operation]);
      throw Object.assign(new Error('daemon POST /v0/grants/spend failed'), { code: 'human-token-missing', detail: 'the human GitHub token is not stored' });
    },
  };
  const state = createMcpState({ env: {}, home: '/nonexistent', cwd: '/nonexistent', client });
  const tool = async (name, args) => (await handleMcpMessage(state, { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } })).result;
  const tools = (await handleMcpMessage(state, { jsonrpc: '2.0', id: 2, method: 'tools/list' })).result.tools;
  const listed = tools.map((entry) => entry.name);
  assert.ok(listed.includes('request_grant') && listed.includes('spend_grant'));
  // Every operation the daemon performs is discoverable from the tool schema.
  const shapes = tools.find((entry) => entry.name === 'request_grant').inputSchema.properties.operation.description;
  for (const operation of GRANT_ACTS) assert.match(shapes, new RegExp(`"${operation}"`));

  const unbound = await tool('request_grant', { operation: COMMENT });
  assert.equal(unbound.isError, true);
  assert.match(unbound.content[0].text, /not bound/);
  assert.equal(sent.length, 0);

  state.secret = 'held-secret';
  const asked = await tool('request_grant', { operation: COMMENT });
  assert.notEqual(asked.isError, true);
  const refused = await tool('spend_grant', { proposal_id: 'p', operation: COMMENT });
  assert.equal(refused.isError, true);
  assert.equal(refused.content[0].text, 'the human GitHub token is not stored [human-token-missing]');
  assert.deepEqual(sent, [['request', 'held-secret', COMMENT], ['spend', 'held-secret', 'p', COMMENT]]);
});
