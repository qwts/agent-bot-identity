// A decision route answered with a signed owner challenge (ADR-0753 section
// 4, #753): where presence is unavailable and an SSH security key is pinned,
// the daemon issues challenges, records them, and accepts each signed reply
// once, for that decision only. A software SSH key, which a soul in the
// owner's account could read, never answers a decision route. The daemon
// keeps all of this off by default (`signedChallengeRoutes`) until owner
// pins are integrity-protected; these tests turn it on through
// decisionOwnerGate with a ledger, and check the default stays on the dialog.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { approvalsCommand } from '../agent-approvals.mjs';
import { createDaemonServer } from '../agent-daemon.mjs';
import { createChallengeLedger, decisionOwnerGate } from '../owner-action.mjs';
import { authorizeSouls, bindTransport, enrollPrincipal, setOperations } from '../agent-principals.mjs';
import { upsertSoul } from '../agent-population.mjs';
import {
  SSHSIG_NAMESPACE, armorStatement, createOwnerChallenges, ownerKeysPath, parseSshPublicKey, signChallenge, sshFingerprint, writeOwnerKeys,
} from '../owner-statement.mjs';

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

const u32 = (n) => { const b = Buffer.alloc(4); b.writeUInt32BE(n); return b; };
const str = (value) => { const b = Buffer.isBuffer(value) ? value : Buffer.from(value); return Buffer.concat([u32(b.length), b]); };
const pinOf = (name, line, softwareKey) => ({
  name, store: 'ssh', alg: 'sshsig', publicKey: line, fingerprint: sshFingerprint(parseSshPublicKey(line).blob),
  verifyRequired: false, softwareKey, pinnedAt: '2026-10-09T21:00:00.000Z',
});

// A FIDO sk-ssh-ed25519 key pinned as the owner's: its `.pub` on disk, as
// `ssh-keygen -t ed25519-sk` leaves it, and a signer standing in for the
// hardware the way OpenSSH's ssh-sk signs (PROTOCOL.u2f).
function ownerKey(root, env, name = 'yubikey') {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const raw = Buffer.from(publicKey.export({ format: 'jwk' }).x, 'base64url');
  const type = 'sk-ssh-ed25519@openssh.com';
  const application = 'ssh:';
  const blob = Buffer.concat([str(type), str(raw), str(application)]);
  const line = `${type} ${blob.toString('base64')}`;
  const keyPath = path.join(root, `id_${name}_sk`);
  writeFileSync(`${keyPath}.pub`, `${line} ${name}\n`);
  const sshsig = (segment) => {
    const hash = 'sha512';
    const signed = Buffer.concat([Buffer.from('SSHSIG'), str(SSHSIG_NAMESPACE), str(''), str(hash), str(createHash(hash).update(segment).digest())]);
    const flags = 0x01;
    const counter = u32(7);
    const data = Buffer.concat([createHash('sha256').update(application).digest(), Buffer.from([flags]), counter, createHash('sha256').update(signed).digest()]);
    const signature = Buffer.concat([str(type), str(sign(null, data, privateKey)), Buffer.from([flags]), counter]);
    return Buffer.concat([Buffer.from('SSHSIG'), u32(1), str(blob), str(SSHSIG_NAMESPACE), str(''), str(hash), str(signature)]);
  };
  return { keyPath, pin: pinOf(name, line, false), sign: (segment) => sshsig(Buffer.from(segment)) };
}

// A software ed25519 key from ssh-keygen, pinned with --allow-software-key:
// anything running as the owner can read it.
function softwareKey(root, name = 'laptop') {
  const keyPath = path.join(root, `id_${name}`);
  execFileSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-C', name, '-f', keyPath], { stdio: 'ignore' });
  return { keyPath, pin: pinOf(name, readFileSync(`${keyPath}.pub`, 'utf8').trim(), true) };
}

const signed = (payload, key, options = {}) => signChallenge(payload, key.keyPath, { sign: key.sign, ...options }).token;

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

test('a ledger hook is silent without pins or with only software keys, and unreachable with only keyd pins', { skip: NO_KEYGEN }, async () => {
  const { env } = scratch();
  const ledger = createChallengeLedger({ env });
  assert.equal(await ledger.hook({ request: 'p1' })('approve x', { summary: 'approve x' }), null);
  const line = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOmoHG3qbkHRhjuhLC3xq3DwBX6nqEKXz6WnSZAvXx9M';
  writeOwnerKeys([{
    name: 'mac', store: 'keyd', alg: 'ed25519', publicKey: line, fingerprint: sshFingerprint(parseSshPublicKey(line).blob),
    verifyRequired: false, softwareKey: false, pinnedAt: '2026-10-09T21:00:00.000Z',
  }], { env });
  assert.equal(await code(ledger.hook({ request: 'p1' })('approve x', { summary: 'approve x' })), 'owner-unreachable');
  // A software key falls back to the dialog, statement or not.
  const { root } = scratch();
  const software = softwareKey(root);
  writeOwnerKeys([software.pin], { env });
  assert.equal(await ledger.hook({ request: 'p1' })('approve x', { summary: 'approve x' }), null);
  const [forged] = createOwnerChallenges('approve x', 'approve x', [software.pin]);
  const token = signChallenge(forged.payload, software.keyPath).token;
  assert.equal(await ledger.hook({ request: 'p1', statement: token })('approve x', { summary: 'approve x' }), null);
  assert.equal(ledger.size, 0);
});

test('a signed reply answers its own challenge once, for that request and action only', async () => {
  const { root, env } = scratch();
  const owner = ownerKey(root, env);
  const { pin } = owner;
  writeOwnerKeys([pin], { env });
  const ledger = createChallengeLedger({ env });
  const action = 'approve Bash for soul once: push';

  const [challenge] = await challengesFrom(ledger.hook({ request: 'p1' }), action);
  assert.deepEqual([challenge.name, challenge.fingerprint, challenge.payload.kind], ['yubikey', pin.fingerprint, 'challenge']);
  assert.equal(ledger.size, 1);
  const token = signed(challenge.payload, owner);

  // Another request is not what was challenged, and leaves this one pending.
  assert.equal(await code(ledger.hook({ request: 'p2', statement: token })(action, { summary: 'x' })), 'statement-scope-mismatch');
  assert.equal(ledger.size, 1);

  // The armored block is accepted as well as the bare token.
  const proof = await ledger.hook({ request: 'p1', statement: armorStatement(token) })(action, { summary: 'x' });
  assert.deepEqual(proof, { method: 'statement', via: 'ssh', key: 'yubikey', fingerprint: pin.fingerprint });
  assert.equal(ledger.size, 0);
  // Replaying the same reply finds nothing pending.
  assert.equal(await code(ledger.hook({ request: 'p1', statement: token })(action, { summary: 'x' })), 'statement-scope-mismatch');

  // Another action on the same request is refused and spends the challenge.
  const [again] = await challengesFrom(ledger.hook({ request: 'p1' }), action);
  const answer = signed(again.payload, owner);
  assert.equal(await code(ledger.hook({ request: 'p1', statement: answer })(`deny${action.slice(7)}`, { summary: 'x' })), 'statement-scope-mismatch');
  assert.equal(await code(ledger.hook({ request: 'p1', statement: answer })(action, { summary: 'x' })), 'statement-scope-mismatch');
});

test('a failed reply spends the challenge, and a fresh challenge replaces an older one', async () => {
  const { root, env } = scratch();
  const owner = ownerKey(root, env);
  const { pin } = owner;
  writeOwnerKeys([pin], { env });
  const ledger = createChallengeLedger({ env });
  const action = 'approve Bash for soul once: push';

  const [first] = await challengesFrom(ledger.hook({ request: 'p1' }), action);
  const [second] = await challengesFrom(ledger.hook({ request: 'p1' }), action);
  assert.notEqual(first.payload.nonce, second.payload.nonce);
  assert.equal(ledger.size, 1);
  // The superseded challenge's reply is refused, and that spends the new one too.
  const stale = signed(first.payload, owner);
  assert.equal(await code(ledger.hook({ request: 'p1', statement: stale })(action, { summary: 'x' })), 'statement-scope-mismatch');
  const fresh = signed(second.payload, owner);
  assert.equal(await code(ledger.hook({ request: 'p1', statement: fresh })(action, { summary: 'x' })), 'statement-scope-mismatch');

  assert.equal(await code(ledger.hook({ request: 'p1', statement: 'not a token' })(action, { summary: 'x' })), 'statement-scope-mismatch');
  // A reply that is not even a token spends the challenge too.
  await challengesFrom(ledger.hook({ request: 'p1' }), action);
  assert.equal(ledger.size, 1);
  assert.equal(await code(ledger.hook({ request: 'p1', statement: 7 })(action, { summary: 'x' })), 'statement-invalid');
  assert.equal(ledger.size, 0);
});

test('a reply is checked against the pins as they are now, and challenges expire', async () => {
  const { root, env } = scratch();
  const owner = ownerKey(root, env);
  const { pin } = owner;
  writeOwnerKeys([pin], { env });
  let clock = Date.now();
  const ledger = createChallengeLedger({ env, now: () => clock });
  const action = 'approve Bash for soul once: push';

  const [challenge] = await challengesFrom(ledger.hook({ request: 'p1' }), action);
  const token = signed(challenge.payload, owner, { now: clock });
  const other = ownerKey(root, env, 'other');
  writeOwnerKeys([other.pin], { env });
  assert.equal(await code(ledger.hook({ request: 'p1', statement: token })(action, { summary: 'x' })), 'owner-unreachable');

  writeOwnerKeys([pin], { env });
  const [late] = await challengesFrom(ledger.hook({ request: 'p1' }), action);
  const lateToken = signed(late.payload, owner, { now: clock });
  clock += 16 * 60 * 1000;
  assert.equal(ledger.size, 0);
  assert.equal(await code(ledger.hook({ request: 'p1', statement: lateToken })(action, { summary: 'x' })), 'statement-scope-mismatch');
});

test('the ledger holds a bounded number of pending decisions', async () => {
  const { root, env } = scratch();
  writeOwnerKeys([ownerKey(root, env).pin], { env });
  const ledger = createChallengeLedger({ env, limit: 3 });
  for (const request of ['p1', 'p2', 'p3', 'p4']) await challengesFrom(ledger.hook({ request }), 'approve x');
  assert.equal(ledger.size, 3);
});

// keyd cannot ask, and the dialog refuses unless a test lets it answer.
async function daemonFor(env, { challenges = createChallengeLedger({ env }), dialog = async () => { throw new Error('the dialog was reached'); } } = {}) {
  const ownerGate = decisionOwnerGate({
    env, challenges,
    presence: async () => { throw Object.assign(new Error('keyd is not running'), { code: 'presence-unavailable' }); },
    fallbackConsent: dialog,
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

test('both decision routes answer with challenges and accept each signed reply once', async () => {
  const { root, env } = scratch();
  const owner = ownerKey(root, env);
  const { pin } = owner;
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

    const token = signed(body.challenges[0].payload, owner);
    // The reply to an approval cannot deny, and trying spends it.
    const crossed = await call('/v0/approvals/decide', {
      method: 'POST', body: { proposalId: row.proposalId, decision: 'deny', digest: row.operationDigest, statement: token },
    });
    assert.equal(crossed.status, 403);
    assert.equal((await decide({ statement: token })).status, 403);
    const renewed = await (await decide()).json();
    const approved = await decide({ statement: signed(renewed.challenges[0].payload, owner) });
    assert.equal(approved.status, 200);
    assert.equal((await approved.json()).proposal.status, 'approved');
    assert.deepEqual(await waiting, { decision: 'approve' });
    // The receipt says how the owner authorized it.
    const [receipt] = audits(env).filter((entry) => entry.event === 'approval-decision' && entry.decision === 'approved');
    assert.equal(receipt.detail, 'risk: external; authorized: statement yubikey');

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
    const spent = signed(nextChallenge.payload, owner);
    assert.equal((await viaPrincipal({ statement: spent })).status, 403);
    const fresh = await (await viaPrincipal()).json();
    const answer = signed(fresh.challenges[0].payload, owner);
    assert.equal((await viaPrincipal({ statement: answer })).status, 200);
    assert.deepEqual(await second, { decision: 'approve' });
    assert.equal(audits(env).filter((receipt) => receipt.decision === 'owner-challenged').length, 4);
  } finally {
    await close();
  }
});

// A soul runs in the owner's account, so it holds the daemon token and can
// read a software key. With only a software key pinned the routes ask the
// dialog, which a soul cannot answer; with a security key pinned, the soul
// can fetch a challenge but cannot sign it.
test('a soul holding the daemon token and a software key cannot approve its own proposal', { skip: NO_KEYGEN }, async () => {
  const { root, env } = scratch();
  const software = softwareKey(root);
  writeOwnerKeys([software.pin], { env });
  const { server, call, close } = await daemonFor(env);
  try {
    const waiting = server.interaction.requestTurnApproval({ agentId: AGENT_ID, operation: OPERATION, summary: 'push', tool: 'Bash' });
    const [row] = (await (await call('/v0/approvals')).json()).proposals;
    const decide = (extra = {}) => call('/v0/approvals/decide', {
      method: 'POST', body: { proposalId: row.proposalId, decision: 'approve', digest: row.operationDigest, ...extra },
    });
    const asked = await decide();
    assert.equal(asked.status, 403);
    const refusal = await asked.json();
    assert.match(refusal.error, /the dialog was reached/);
    assert.equal(refusal.challenges, undefined);
    // A challenge the soul made up and signed with the software key.
    const action = `approve Bash for ${AGENT_ID}: push`;
    const [forged] = createOwnerChallenges(action, action, [software.pin]);
    const viaStatement = await decide({ statement: signChallenge(forged.payload, software.keyPath).token });
    assert.equal(viaStatement.status, 403);
    assert.match((await viaStatement.json()).error, /the dialog was reached/);

    // With a security key pinned as well, the soul's key still cannot answer.
    writeOwnerKeys([software.pin, ownerKey(root, env).pin], { env });
    const challenged = await decide();
    assert.equal(challenged.status, 409);
    const { challenges } = await challenged.json();
    assert.equal(challenges.length, 1);
    assert.equal(challenges[0].name, 'yubikey');
    assert.throws(() => signChallenge(challenges[0].payload, software.keyPath), { code: 'owner-key-mismatch' });
    const resigned = signChallenge({ ...challenges[0].payload, key: software.pin.fingerprint }, software.keyPath).token;
    assert.equal((await decide({ statement: resigned })).status, 403);
    assert.deepEqual((await (await call('/v0/approvals')).json()).proposals.map((p) => p.status), ['open']);
    await assert.rejects(Promise.race([waiting, new Promise((_, reject) => { setTimeout(() => reject(new Error('not settled')), 50); })]), /not settled/);
  } finally {
    await close();
  }
});

// The default: no ledger. A pin the soul wrote into the pin file itself, a
// security key made in software, signs a reply; the route never reads it
// and asks the dialog.
test('with signed challenges off, a decision route asks only keyd or the dialog', async () => {
  const { root, env } = scratch();
  const forged = ownerKey(root, env, 'forged');
  writeOwnerKeys([forged.pin], { env });
  const asked = [];
  const { server, call, close } = await daemonFor(env, { challenges: null, dialog: async (action) => { asked.push(action); return { method: 'consent' }; } });
  try {
    const waiting = server.interaction.requestTurnApproval({ agentId: AGENT_ID, operation: OPERATION, summary: 'push', tool: 'Bash' });
    const [row] = (await (await call('/v0/approvals')).json()).proposals;
    const action = `approve Bash for ${AGENT_ID}: push`;
    const [challenge] = createOwnerChallenges(action, action, [forged.pin]);
    const response = await call('/v0/approvals/decide', {
      method: 'POST', body: { proposalId: row.proposalId, decision: 'approve', digest: row.operationDigest, statement: signed(challenge.payload, forged) },
    });
    assert.equal(response.status, 200);
    assert.equal(asked.length, 1);
    assert.deepEqual(await waiting, { decision: 'approve' });
    const [receipt] = audits(env).filter((entry) => entry.event === 'approval-decision' && entry.decision === 'approved');
    assert.equal(receipt.detail, 'risk: external; authorized: consent');
    assert.equal(audits(env).some((entry) => entry.decision === 'owner-challenged'), false);
  } finally {
    await close();
  }
});

test('a malformed pin file never blocks a decision: the dialog asks', async () => {
  for (const challenges of [null, 'ledger']) {
    const { env } = scratch();
    const file = ownerKeysPath({ env });
    mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    writeFileSync(file, '{ not json', { mode: 0o600 });
    const asked = [];
    const { server, call, close } = await daemonFor(env, {
      challenges: challenges && createChallengeLedger({ env }),
      dialog: async (action) => { asked.push(action); return { method: 'consent' }; },
    });
    try {
      const waiting = server.interaction.requestTurnApproval({ agentId: AGENT_ID, operation: OPERATION, summary: 'push', tool: 'Bash' });
      const [row] = (await (await call('/v0/approvals')).json()).proposals;
      const response = await call('/v0/approvals/decide', {
        method: 'POST', body: { proposalId: row.proposalId, decision: 'deny', digest: row.operationDigest },
      });
      assert.equal(response.status, 200, String(challenges));
      assert.equal(asked.length, 1);
      assert.deepEqual(await waiting, { decision: 'deny' });
    } finally {
      await close();
    }
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
