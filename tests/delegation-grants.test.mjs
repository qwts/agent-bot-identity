import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { getProposal, operationDigest } from '../agent-jobs.mjs';
import { auditFile } from '../agent-principals.mjs';
import { GRANT_OPERATIONS, createGrantLedger, grantOperation, grantPresenceAction } from '../delegation-grants.mjs';
import { actionDigest, keydPresence } from '../owner-presence.mjs';

const SOUL = 'agent_11111111-1111-4111-8111-111111111111';
const OTHER = 'agent_22222222-2222-4222-8222-222222222222';
const START = Date.parse('2026-10-09T12:00:00.000Z');
const COMMENT = { operation: 'issue-comment', repo: 'qwts/agent-bot-identity', number: 108, body: 'Thanks, closing the loop here.' };
const roots = [];

after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

function scratch({ presence } = {}) {
  const root = mkdtempSync(path.join(tmpdir(), 'delegation-grants-'));
  roots.push(root);
  const env = { AGENT_BOT_INTERACTION_HOME: path.join(root, 'interaction') };
  const clock = { at: START };
  const asked = [];
  const ledger = createGrantLedger({
    env,
    home: '/nonexistent',
    now: () => new Date(clock.at),
    presence: presence ?? (async (action) => { asked.push(action); return { method: 'presence', via: 'agent-bot-keyd' }; }),
  });
  const receipts = () => {
    try {
      return readFileSync(auditFile({ env, home: '/nonexistent' }), 'utf8').trim().split('\n').map((line) => JSON.parse(line))
        .filter((row) => row.event === 'delegation-grant');
    } catch { return []; }
  };
  return { env, clock, asked, ledger, receipts };
}

function performer() {
  const done = [];
  return { done, perform: async (operation) => { done.push(operation); } };
}

test('only the named operations can be granted; approve and merge are refused', () => {
  assert.deepEqual(GRANT_OPERATIONS, ['issue-comment', 'issue-state', 'review-request']);
  for (const operation of ['pr-approve', 'pr-merge', 'approve', 'merge', undefined]) {
    assert.throws(() => grantOperation({ ...COMMENT, operation }), { code: 'grant-refused' });
  }
  assert.throws(() => grantOperation({ ...COMMENT, event: 'APPROVE' }), { code: 'grant-refused' });
  assert.throws(() => grantOperation({ operation: 'issue-state', repo: 'qwts/x', number: 1, state: 'merged' }), { code: 'grant-refused' });
  assert.deepEqual(grantOperation({ operation: 'review-request', repo: 'qwts/x', number: 2, reviewers: ['octocat'] }),
    { operation: 'review-request', repo: 'qwts/x', number: 2, reviewers: ['octocat'] });

  const { ledger, receipts } = scratch();
  assert.throws(() => ledger.request({ agentId: SOUL, operation: { ...COMMENT, operation: 'pr-merge' } }), { code: 'grant-refused' });
  assert.equal(receipts().at(-1).decision, 'refused');
});

test('a grant is an ordinary proposal: one operation, its digest and an expiry', () => {
  const { env, ledger, receipts } = scratch();
  const grant = ledger.request({ agentId: SOUL, operation: COMMENT });
  assert.equal(grant.tool, 'grant:issue-comment');
  assert.equal(grant.operationDigest, operationDigest(COMMENT));
  assert.equal(grant.status, 'open');
  assert.equal(Date.parse(grant.expiresAt) - START, 15 * 60_000);
  assert.deepEqual(getProposal(grant.proposalId, { env, home: '/nonexistent' }), grant);
  assert.match(receipts().at(-1).detail, new RegExp(grant.operationDigest));
  assert.throws(() => ledger.request({ agentId: SOUL, operation: COMMENT, ttlMs: 60 * 60_000 }), { code: 'grant-refused' });
});

test('an approved grant is spent exactly once, with a receipt', async () => {
  const { ledger, asked, receipts } = scratch();
  const grant = ledger.request({ agentId: SOUL, operation: COMMENT });
  const approved = await ledger.approve(grant.proposalId, { digest: grant.operationDigest });
  assert.equal(approved.status, 'approved');
  assert.equal(approved.decidedBy, 'owner');
  assert.equal(asked.length, 1);
  assert.ok(asked[0].includes(grant.operationDigest), 'the presence prompt carries the digest');

  const { done, perform } = performer();
  const [first, second] = await Promise.allSettled([
    ledger.spend(grant.proposalId, { agentId: SOUL, operation: COMMENT }, perform),
    ledger.spend(grant.proposalId, { agentId: SOUL, operation: COMMENT }, perform),
  ]);
  assert.equal(first.status, 'fulfilled');
  assert.equal(first.value.status, 'spent');
  assert.equal(first.value.receipt.decision, 'spent');
  assert.equal(second.status, 'rejected');
  assert.equal(second.reason.code, 'grant-unavailable');
  await assert.rejects(ledger.spend(grant.proposalId, { agentId: SOUL, operation: COMMENT }, perform), { code: 'grant-unavailable' });
  assert.deepEqual(done, [COMMENT]);

  const spends = receipts().filter((row) => row.operation === 'spend');
  assert.deepEqual(spends.map((row) => row.decision).sort(), ['refused', 'refused', 'spent']);
  assert.ok(spends.every((row) => row.agentId === SOUL));
  // A second approval cannot reopen a spent grant.
  await assert.rejects(ledger.approve(grant.proposalId, { digest: grant.operationDigest }), { code: 'grant-closed' });
});

test('a failed act still spends the grant, and its error stays out of the receipt', async () => {
  const { ledger, receipts } = scratch();
  const grant = ledger.request({ agentId: SOUL, operation: COMMENT });
  await ledger.approve(grant.proposalId, { digest: grant.operationDigest });
  await assert.rejects(ledger.spend(grant.proposalId, { agentId: SOUL, operation: COMMENT },
    async () => { throw new Error('token ghs_secret rejected'); }), { code: 'grant-act-failed' });
  await assert.rejects(ledger.spend(grant.proposalId, { agentId: SOUL, operation: COMMENT }, async () => {}), { code: 'grant-unavailable' });
  assert.ok(!JSON.stringify(receipts()).includes('ghs_secret'));
});

test('a wrong operation, or another soul, is refused and leaves the grant unspent', async () => {
  const { ledger, receipts } = scratch();
  const grant = ledger.request({ agentId: SOUL, operation: COMMENT });
  await ledger.approve(grant.proposalId, { digest: grant.operationDigest });
  const { done, perform } = performer();
  const refused = [
    { agentId: SOUL, operation: { ...COMMENT, body: 'Something else.' } },
    { agentId: SOUL, operation: { ...COMMENT, number: 109 } },
    { agentId: SOUL, operation: { operation: 'issue-state', repo: COMMENT.repo, number: 108, state: 'closed' } },
    { agentId: SOUL, operation: { ...COMMENT, operation: 'pr-merge' } },
    { agentId: OTHER, operation: COMMENT },
  ];
  for (const attempt of refused) {
    await assert.rejects(ledger.spend(grant.proposalId, attempt, perform), (error) => ['grant-mismatch', 'grant-refused', 'grant-unavailable'].includes(error.code));
  }
  assert.deepEqual(done, []);
  assert.equal((await ledger.spend(grant.proposalId, { agentId: SOUL, operation: COMMENT }, perform)).status, 'spent');
  assert.equal(receipts().filter((row) => row.operation === 'spend' && row.decision === 'refused').length, refused.length);

  // The owner's approval must echo the grant's own digest.
  const next = ledger.request({ agentId: SOUL, operation: COMMENT });
  await assert.rejects(ledger.approve(next.proposalId, { digest: operationDigest({ ...COMMENT, body: 'x' }) }), { code: 'grant-mismatch' });
});

test('an expired grant can be neither approved nor spent', async () => {
  const { ledger, clock, asked, env } = scratch();
  const late = ledger.request({ agentId: SOUL, operation: COMMENT, ttlMs: 60_000 });
  clock.at += 61_000;
  await assert.rejects(ledger.approve(late.proposalId, { digest: late.operationDigest }), { code: 'grant-expired' });
  assert.equal(asked.length, 0, 'nobody is asked about an expired grant');
  assert.equal(getProposal(late.proposalId, { env, home: '/nonexistent' }).status, 'expired');

  const spentLate = ledger.request({ agentId: SOUL, operation: COMMENT, ttlMs: 60_000 });
  await ledger.approve(spentLate.proposalId, { digest: spentLate.operationDigest });
  clock.at += 61_000;
  const { done, perform } = performer();
  await assert.rejects(ledger.spend(spentLate.proposalId, { agentId: SOUL, operation: COMMENT }, perform), { code: 'grant-expired' });
  assert.deepEqual(done, []);
});

test('missing owner presence is refused, with no fallback ceremony', async () => {
  for (const [code, expected] of [['presence-unavailable', 'presence-required'], ['owner-declined', 'owner-declined'], ['presence-invalid', 'presence-invalid']]) {
    const { ledger, env, receipts } = scratch({ presence: async () => { throw Object.assign(new Error('no'), { code }); } });
    const grant = ledger.request({ agentId: SOUL, operation: COMMENT });
    await assert.rejects(ledger.approve(grant.proposalId, { digest: grant.operationDigest }), { code: expected });
    assert.equal(getProposal(grant.proposalId, { env, home: '/nonexistent' }).status, 'open');
    await assert.rejects(ledger.spend(grant.proposalId, { agentId: SOUL, operation: COMMENT }, async () => {}), { code: 'grant-unavailable' });
    assert.equal(receipts().find((row) => row.operation === 'approve').decision, 'refused');
  }
});

test("keyd's assertion is bound to the grant's digest", async () => {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const raw = Buffer.from(publicKey.export({ format: 'jwk' }).x, 'base64url').toString('base64');
  const seconds = Math.floor(START / 1000);
  const assertion = (action, nonce) => {
    const segment = Buffer.from(JSON.stringify({ v: 1, aud: 'agent-bot-owner', kind: 'presence',
      action: actionDigest(action), nonce, iat: seconds, exp: seconds + 60 })).toString('base64url');
    return `p1.${segment}.${sign(null, Buffer.from(segment), privateKey).toString('base64url')}`;
  };
  // keyd signs whatever action line it is asked about; `signed` swaps it.
  const viaKeyd = (signed) => (action, options) => keydPresence(action, {
    ...options, pinned: () => raw, now: () => START,
    request: async (socket, method, params) => ({ assertion: assertion(signed(params.action), params.nonce) }),
  });

  const honest = scratch({ presence: viaKeyd((action) => action) });
  const grant = honest.ledger.request({ agentId: SOUL, operation: COMMENT });
  assert.equal((await honest.ledger.approve(grant.proposalId, { digest: grant.operationDigest })).status, 'approved');

  // An assertion for another grant's action line does not approve this one.
  const other = scratch({ presence: viaKeyd(() => grantPresenceAction({ agentId: SOUL, summary: 'comment', operationDigest: '0'.repeat(64) })) });
  const target = other.ledger.request({ agentId: SOUL, operation: COMMENT });
  await assert.rejects(other.ledger.approve(target.proposalId, { digest: target.operationDigest }), { code: 'presence-invalid' });
});
