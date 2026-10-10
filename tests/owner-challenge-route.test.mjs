// A decision route answered with a signed owner challenge (ADR-0753 section
// 4, #753): where presence is unavailable and an SSH owner key is pinned,
// the daemon issues challenges, records them, and accepts each signed reply
// once, for that decision only.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { approvalsCommand } from '../agent-approvals.mjs';
import { createDaemonServer } from '../agent-daemon.mjs';
import { confirmOwnerPresence, createChallengeLedger } from '../owner-action.mjs';
import { authorizeSouls, bindTransport, enrollPrincipal, setOperations } from '../agent-principals.mjs';
import { upsertSoul } from '../agent-population.mjs';
import { armorStatement, parseSshPublicKey, signChallenge, sshFingerprint, writeOwnerKeys } from '../owner-statement.mjs';

const AGENT_ID = 'agent_11111111-1111-4111-8111-111111111111';
const OPERATION = { permission: { toolName: 'Bash', input: { command: 'git push' } } };
const HAS_SSH_KEYGEN = spawnSync('ssh-keygen', ['-?'], { stdio: 'ignore' }).error === undefined;
const NO_KEYGEN = !HAS_SSH_KEYGEN && 'ssh-keygen is not installed';
const roots = [];

after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

function scratch() {
  const root = mkdtempSync(path.join(tmpdir(), 'owner-challenge-route-'));
  roots.push(root);
  const env = {
    HOME: root,
    AGENT_BOT_INTERACTION_HOME: path.join(root, 'interaction'),
    AGENT_BOT_POPULATION_PATH: path.join(root, 'population.json'),
    AGENT_BOT_PRINCIPALS_PATH: path.join(root, 'principals.json'),
  };
  upsertSoul({
    id: AGENT_ID, appSlug: 'you-codex-agent', parentId: null, status: 'active',
    spacePath: `/spaces/${AGENT_ID}`, transcriptLocator: null, lastSeen: '2026-08-12T08:00:00.000Z',
  }, { file: env.AGENT_BOT_POPULATION_PATH });
  return { root, env };
}

// A software ed25519 key from ssh-keygen, pinned as the owner's.
function ownerKey(root, env, name = 'laptop') {
  const keyPath = path.join(root, `id_${name}`);
  execFileSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-C', name, '-f', keyPath], { stdio: 'ignore' });
  const line = readFileSync(`${keyPath}.pub`, 'utf8').trim();
  const pin = {
    name, store: 'ssh', alg: 'sshsig', publicKey: line, fingerprint: sshFingerprint(parseSshPublicKey(line).blob),
    verifyRequired: false, softwareKey: true, pinnedAt: '2026-10-09T21:00:00.000Z',
  };
  return { keyPath, pin };
}

const code = async (promise) => {
  try { await promise; } catch (error) { return error.code; }
  return 'accepted';
};

// Throws what the hook throws, so the challenges can be read off it.
async function challengesFrom(hook, action, summary = 'approve Bash for the soul') {
  const error = await hook(action, { summary }).then(() => null, (thrown) => thrown);
  assert.equal(error?.code, 'owner-challenge-required');
  return error.challenges;
}

test('a ledger hook is silent without pins and unreachable with only keyd pins', async () => {
  const { env } = scratch();
  const ledger = createChallengeLedger({ env });
  assert.equal(await ledger.hook({ request: 'p1' })('approve x', { summary: 'approve x' }), null);
  const line = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOmoHG3qbkHRhjuhLC3xq3DwBX6nqEKXz6WnSZAvXx9M';
  writeOwnerKeys([{
    name: 'mac', store: 'keyd', alg: 'ed25519', publicKey: line, fingerprint: sshFingerprint(parseSshPublicKey(line).blob),
    verifyRequired: false, softwareKey: false, pinnedAt: '2026-10-09T21:00:00.000Z',
  }], { env });
  assert.equal(await code(ledger.hook({ request: 'p1' })('approve x', { summary: 'approve x' })), 'owner-unreachable');
  assert.equal(ledger.size, 0);
});

test('a signed reply answers its own challenge once, for that request and action only', { skip: NO_KEYGEN }, async () => {
  const { root, env } = scratch();
  const { keyPath, pin } = ownerKey(root, env);
  writeOwnerKeys([pin], { env });
  const ledger = createChallengeLedger({ env });
  const action = 'approve Bash for soul once: push';

  const [challenge] = await challengesFrom(ledger.hook({ request: 'p1' }), action);
  assert.deepEqual([challenge.name, challenge.fingerprint, challenge.payload.kind], ['laptop', pin.fingerprint, 'challenge']);
  assert.equal(ledger.size, 1);
  const { token } = signChallenge(challenge.payload, keyPath);

  // Another request or another action is not what was challenged.
  assert.equal(await code(ledger.hook({ request: 'p2', statement: token })(action, { summary: 'x' })), 'statement-scope-mismatch');
  assert.equal(await code(ledger.hook({ request: 'p1', statement: token })(`deny${action.slice(7)}`, { summary: 'x' })), 'statement-scope-mismatch');
  assert.equal(ledger.size, 1);

  // The armored block is accepted as well as the bare token.
  const proof = await ledger.hook({ request: 'p1', statement: armorStatement(token) })(action, { summary: 'x' });
  assert.deepEqual(proof, { method: 'statement', via: 'ssh', key: 'laptop', fingerprint: pin.fingerprint });
  assert.equal(ledger.size, 0);
  // Replaying the same reply finds nothing pending.
  assert.equal(await code(ledger.hook({ request: 'p1', statement: token })(action, { summary: 'x' })), 'statement-scope-mismatch');
});

test('a failed reply spends the challenge, and a fresh challenge replaces an older one', { skip: NO_KEYGEN }, async () => {
  const { root, env } = scratch();
  const { keyPath, pin } = ownerKey(root, env);
  writeOwnerKeys([pin], { env });
  const ledger = createChallengeLedger({ env });
  const action = 'approve Bash for soul once: push';

  const [first] = await challengesFrom(ledger.hook({ request: 'p1' }), action);
  const [second] = await challengesFrom(ledger.hook({ request: 'p1' }), action);
  assert.notEqual(first.payload.nonce, second.payload.nonce);
  assert.equal(ledger.size, 1);
  // The superseded challenge's reply is refused, and that spends the new one too.
  const stale = signChallenge(first.payload, keyPath).token;
  assert.equal(await code(ledger.hook({ request: 'p1', statement: stale })(action, { summary: 'x' })), 'statement-scope-mismatch');
  const fresh = signChallenge(second.payload, keyPath).token;
  assert.equal(await code(ledger.hook({ request: 'p1', statement: fresh })(action, { summary: 'x' })), 'statement-scope-mismatch');

  assert.equal(await code(ledger.hook({ request: 'p1', statement: 'not a token' })(action, { summary: 'x' })), 'statement-scope-mismatch');
  assert.equal(await code(ledger.hook({ request: 'p1', statement: 7 })(action, { summary: 'x' })), 'statement-invalid');
});

test('a reply is checked against the pins as they are now, and challenges expire', { skip: NO_KEYGEN }, async () => {
  const { root, env } = scratch();
  const { keyPath, pin } = ownerKey(root, env);
  writeOwnerKeys([pin], { env });
  let clock = Date.now();
  const ledger = createChallengeLedger({ env, now: () => clock });
  const action = 'approve Bash for soul once: push';

  const [challenge] = await challengesFrom(ledger.hook({ request: 'p1' }), action);
  const { token } = signChallenge(challenge.payload, keyPath, { now: clock });
  const other = ownerKey(root, env, 'other');
  writeOwnerKeys([other.pin], { env });
  assert.equal(await code(ledger.hook({ request: 'p1', statement: token })(action, { summary: 'x' })), 'owner-unreachable');

  writeOwnerKeys([pin], { env });
  const [late] = await challengesFrom(ledger.hook({ request: 'p1' }), action);
  const lateToken = signChallenge(late.payload, keyPath, { now: clock }).token;
  clock += 16 * 60 * 1000;
  assert.equal(ledger.size, 0);
  assert.equal(await code(ledger.hook({ request: 'p1', statement: lateToken })(action, { summary: 'x' })), 'statement-scope-mismatch');
});

test('the ledger holds a bounded number of pending decisions', { skip: NO_KEYGEN }, async () => {
  const { root, env } = scratch();
  writeOwnerKeys([ownerKey(root, env).pin], { env });
  const ledger = createChallengeLedger({ env, limit: 3 });
  for (const request of ['p1', 'p2', 'p3', 'p4']) await challengesFrom(ledger.hook({ request }), 'approve x');
  assert.equal(ledger.size, 3);
});

async function daemonFor(env) {
  const ledger = createChallengeLedger({ env });
  // keyd cannot ask and the dialog must never be reached while a key is pinned.
  const ownerGate = (action, { principal, request = null, statement = null }) => confirmOwnerPresence(action, {
    env, principal,
    presence: async () => { throw Object.assign(new Error('keyd is not running'), { code: 'presence-unavailable' }); },
    fallbackConsent: async () => { throw new Error('the dialog was reached'); },
    ...(request === null ? {} : { challenge: ledger.hook({ request, statement }) }),
  });
  const server = createDaemonServer({ env, home: '/nonexistent', config: {}, ownerGate });
  await new Promise((resolve) => { server.listen(0, '127.0.0.1', resolve); });
  const port = server.address().port;
  const call = (pathname, { method = 'GET', body } = {}) => fetch(`http://127.0.0.1:${port}${pathname}`, {
    method,
    headers: { authorization: `Bearer ${server.token}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const close = () => {
    for (const row of server.interaction.listProposalsForOwner().proposals) {
      server.interaction.decideProposalAsOwner({ proposalId: row.proposalId, decision: 'deny', digest: row.operationDigest });
    }
    return new Promise((resolve) => { server.close(resolve); });
  };
  return { server, call, close };
}

function audits(env) {
  try {
    return readFileSync(path.join(env.AGENT_BOT_INTERACTION_HOME, 'audit.jsonl'), 'utf8').trim().split('\n').map((line) => JSON.parse(line));
  } catch {
    return [];
  }
}

test('both decision routes answer with challenges and accept each signed reply once', { skip: NO_KEYGEN }, async () => {
  const { root, env } = scratch();
  const { keyPath, pin } = ownerKey(root, env);
  writeOwnerKeys([pin], { env });
  const options = { file: env.AGENT_BOT_PRINCIPALS_PATH, env, home: '/nonexistent' };
  const principal = enrollPrincipal({ label: 'phone' }, options);
  bindTransport(principal.principalId, { transport: 'web', providerId: 'owner-subject' }, options);
  authorizeSouls(principal.principalId, [AGENT_ID], options);
  setOperations(principal.principalId, ['observe', 'approve'], options);
  const { server, call, close } = await daemonFor(env);
  try {
    // /v0, the daemon token's route.
    const waiting = server.interaction.requestTurnApproval({ agentId: AGENT_ID, operation: OPERATION, summary: 'push', tool: 'Bash' });
    const [row] = (await (await call('/v0/approvals')).json()).proposals;
    const decide = (extra = {}) => call('/v0/approvals/decide', {
      method: 'POST', body: { proposalId: row.proposalId, decision: 'approve', digest: row.operationDigest, ...extra },
    });
    const asked = await decide();
    assert.equal(asked.status, 409);
    const body = await asked.json();
    assert.equal(body.code, 'owner-challenge-required');
    assert.equal(body.challenges.length, 1);
    assert.equal(body.challenges[0].fingerprint, pin.fingerprint);
    assert.match(body.challenges[0].payload.text, /approve Bash/);
    assert.deepEqual((await (await call('/v0/approvals')).json()).proposals.map((p) => p.status), ['open']);
    assert.equal(audits(env).filter((receipt) => receipt.decision === 'owner-challenged').length, 1);

    const { token } = signChallenge(body.challenges[0].payload, keyPath);
    // The reply to an approval cannot deny.
    const crossed = await call('/v0/approvals/decide', {
      method: 'POST', body: { proposalId: row.proposalId, decision: 'deny', digest: row.operationDigest, statement: token },
    });
    assert.equal(crossed.status, 403);
    const approved = await decide({ statement: token });
    assert.equal(approved.status, 200);
    assert.equal((await approved.json()).proposal.status, 'approved');
    assert.deepEqual(await waiting, { decision: 'approve' });

    // /v1, a principal's route.
    const second = server.interaction.requestTurnApproval({ agentId: AGENT_ID, operation: OPERATION, summary: 'push again', tool: 'Bash' });
    const [next] = (await (await call('/v0/approvals')).json()).proposals;
    const viaPrincipal = (extra = {}) => call(`/v1/proposals/${next.proposalId}/decision`, {
      method: 'POST', body: { transport: 'web', providerId: 'owner-subject', decision: 'approve', digest: next.operationDigest, ...extra },
    });
    const challenged = await viaPrincipal();
    assert.equal(challenged.status, 409);
    const [nextChallenge] = (await challenged.json()).challenges;
    // The first decision's reply cannot answer this one, and trying spends it.
    assert.equal((await viaPrincipal({ statement: token })).status, 403);
    const spent = signChallenge(nextChallenge.payload, keyPath).token;
    assert.equal((await viaPrincipal({ statement: spent })).status, 403);
    const fresh = await (await viaPrincipal()).json();
    const answer = signChallenge(fresh.challenges[0].payload, keyPath).token;
    assert.equal((await viaPrincipal({ statement: answer })).status, 200);
    assert.deepEqual(await second, { decision: 'approve' });
    assert.equal(audits(env).filter((receipt) => receipt.decision === 'owner-challenged').length, 3);
  } finally {
    await close();
  }
});

function fakeClient({ challenges = null, seen = [] } = {}) {
  const proposal = { proposalId: 'p1', agentId: AGENT_ID, tool: 'Bash', summary: 'push', operationDigest: 'a'.repeat(64), status: 'open' };
  return {
    approvals: async () => ({ proposals: [proposal] }),
    decideApproval: async (request) => {
      seen.push(request);
      if (challenges && !request.statement) {
        throw Object.assign(new Error('owner presence is unavailable'), { code: 'owner-challenge-required', challenges });
      }
      return { proposal: { ...proposal, status: 'approved' } };
    },
  };
}

test('agent-bot approvals prints the challenges to sign and passes a signed statement back', async () => {
  const { env, root } = scratch();
  const challenges = [{ name: 'laptop', fingerprint: 'SHA256:abc', payload: { kind: 'challenge', text: "approve the soul's push" } }];
  const out = [];
  const seen = [];
  const run = (argv, write = (text) => out.push(text)) => approvalsCommand(argv, {
    env: { HOME: env.HOME }, home: root, cwd: root, write, client: fakeClient({ challenges, seen }),
  });

  const result = await run(['approve', 'p1', '--scope', 'session']);
  assert.equal(result.status, 'owner-challenge-required');
  const text = out.join('');
  assert.match(text, /owner presence is unavailable/);
  assert.ok(text.includes(`agent-bot owner sign --challenge '{"kind":"challenge","text":"approve the soul'\\''s push"}' --key PATH`), text);
  assert.match(text, /agent-bot approvals approve p1 --scope session --statement <signed token>/);

  const json = [];
  await run(['deny', 'p1', '--json'], (line) => json.push(line));
  assert.deepEqual(JSON.parse(json.join('')).challenges, challenges);

  const token = 's1.eyJ2IjoxfQ.c2ln';
  const decided = await run(['approve', 'p1', '--statement', armorStatement(token)]);
  assert.equal(decided.status, 'approved');
  assert.equal(seen.at(-1).statement, token);
  assert.equal(seen[0].statement, undefined);

  await assert.rejects(run(['approve', 'p1', '--statement', 'the owner said yes']), /usage/);
  await assert.rejects(run(['approve', 'p1', '--statement']), /usage/);
  await assert.rejects(run(['list', '--statement', token]), /usage/);
});
