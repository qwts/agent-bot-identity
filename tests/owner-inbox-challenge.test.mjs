// A cold turn's challenge delivered to its inbox, and the owner's signed
// reply there finishing the decision (#753, ADR-0753 section 4). A decide
// call that gets `owner-challenge-required` for a proposal an agent-comms
// message opened also sends the challenges to that message's sender, as the
// soul. A reply carrying a signed statement block is never a turn's prompt:
// its nonce finds the pending challenge, and the decision and scope recorded
// with it go through the same gate as a statement sent to a decision route,
// spent the same way. keyd is stood in as vouching for the pins, and owner
// presence is unavailable; nothing here can prompt.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { createDaemonServer } from '../agent-daemon.mjs';
import { createColdWaker } from '../cold-wake.mjs';
import { createChallengeLedger, decisionOwnerGate, ownerChallengeMessage } from '../owner-action.mjs';
import { upsertSoul } from '../agent-population.mjs';
import { coldTurnExecutor } from '../wake-plane.mjs';
import {
  SSHSIG_NAMESPACE, armorStatement, encodePayload, parseSshPublicKey, signChallenge, sshFingerprint, writeOwnerKeys,
} from '../owner-statement.mjs';

const AGENT_ID = 'agent_11111111-1111-4111-8111-111111111111';
const OWNER = 'principal_00000000-0000-4000-8000-0000000000aa';
const OPERATION = { permission: { toolName: 'Bash', input: { command: 'git push' } } };
const binding = { worktree: '/work/tree', file: '/work/tree/.git/agent-bindings/child.json' };
const roots = [];
const vouched = async () => ({ attested: true, generation: 1 });

const stateHome = mkdtempSync(path.join(tmpdir(), 'owner-inbox-state-'));
process.env.AGENT_BOT_STATE_HOME = stateHome;
roots.push(stateHome);
after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

function scratch() {
  const root = mkdtempSync(path.join(tmpdir(), 'owner-inbox-challenge-'));
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

// A FIDO sk-ssh-ed25519 owner key, signing the way OpenSSH's ssh-sk does.
function ownerKey(root, name = 'yubikey') {
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
    const counter = u32(7);
    const data = Buffer.concat([createHash('sha256').update(application).digest(), Buffer.from([0x01]), counter, createHash('sha256').update(signed).digest()]);
    const signature = Buffer.concat([str(type), str(sign(null, data, privateKey)), Buffer.from([0x01]), counter]);
    return Buffer.concat([Buffer.from('SSHSIG'), u32(1), str(blob), str(SSHSIG_NAMESPACE), str(''), str(hash), str(signature)]);
  };
  const pin = {
    name, store: 'ssh', alg: 'sshsig', publicKey: line, fingerprint: sshFingerprint(parseSshPublicKey(line).blob),
    verifyRequired: false, softwareKey: false, pinnedAt: '2026-10-09T21:00:00.000Z',
  };
  return { keyPath, pin, sign: (segment) => sshsig(Buffer.from(segment)) };
}

// The owner's signed reply block for `payload`, as `owner sign --challenge` prints it.
const reply = (payload, owner) => armorStatement(signChallenge(payload, owner.keyPath, { sign: owner.sign }).token);
// A signature over a payload no challenge asked for, made with the same key.
const forged = (payload, owner) => armorStatement(`s1.${encodePayload(payload)}.${owner.sign(encodePayload(payload)).toString('base64url')}`);

// An agent-comms mailbox standing in for the broker: what the soul has not
// acked, and what the daemon sent as the soul.
function mailbox() {
  const inbox = [];
  const sent = [];
  const acked = [];
  return {
    inbox, sent, acked,
    read: async () => inbox.filter((message) => !acked.includes(message.id)),
    ack: async (soul, ids) => { acked.push(...ids); return { ok: true }; },
    reply: async (soul, message) => { sent.push({ agentId: soul.agentId, ...message }); return { messageId: `sent_${sent.length}` }; },
  };
}

async function setup() {
  const { root, env } = scratch();
  const owner = ownerKey(root);
  writeOwnerKeys([owner.pin], { env });
  const clock = { at: Date.now() };
  const challengeLedger = createChallengeLedger({ attest: vouched, env, now: () => clock.at });
  const ownerGate = decisionOwnerGate({
    env, challenges: challengeLedger,
    presence: async () => { throw Object.assign(new Error('keyd is not running'), { code: 'presence-unavailable' }); },
    fallbackConsent: async () => { throw new Error('the dialog was reached'); },
  });
  const relay = mailbox();
  const server = createDaemonServer({ env, home: '/nonexistent', config: {}, challengeLedger, ownerGate, asideRelay: relay });
  await new Promise((resolve) => { server.listen(0, '127.0.0.1', resolve); });
  const port = server.address().port;
  const call = (pathname, body) => fetch(`http://127.0.0.1:${port}${pathname}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${server.token}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  // Each turn asks to run one tool and records the owner's answer; a turn
  // that saw an owner reply as its prompt would be recorded too.
  const prompts = [];
  const outcomes = [];
  const wake = createColdWaker({
    executor: async ({ message, source }) => {
      prompts.push(message);
      outcomes.push(await server.interaction.requestTurnApproval({ agentId: AGENT_ID, operation: OPERATION, summary: 'push', tool: 'Bash', source }));
      return { reply: 'pushed' };
    },
    settings: { [AGENT_ID]: true },
    lookupBinding: async () => binding,
    identities: async () => ({ harness: 'codex' }),
    receipt() {},
    relay,
    ownerReply: server.ownerReply,
    log() {},
  });
  let seq = 0;
  const deliver = async (body) => {
    seq += 1;
    relay.inbox.push({ id: `m${seq}`, from: { principal: OWNER }, body, correlation: 'thread-1' });
    await wake({ agentId: AGENT_ID, count: 1, messageIds: [`m${seq}`] });
    return `m${seq}`;
  };
  const open = () => server.interaction.listProposalsForOwner().proposals;
  const until = async (check) => {
    for (let i = 0; i < 200 && !check(); i += 1) await new Promise((resolve) => setTimeout(resolve, 5));
    assert.ok(check());
  };
  // A turn woken by the owner's message, then a decide call answered with
  // challenges, which also reach the owner's inbox.
  const challenged = async (decision = 'approve', scope = 'once') => {
    const asked = await deliver('please push');
    await until(() => open().length === 1);
    const [row] = open();
    const response = await call('/v0/approvals/decide', { proposalId: row.proposalId, decision, scope, digest: row.operationDigest });
    assert.equal(response.status, 409);
    const { challenges } = await response.json();
    const message = relay.sent.at(-1);
    assert.equal(message.agentId, AGENT_ID);
    assert.equal(message.to, OWNER);
    assert.equal(message.replyTo, asked);
    assert.equal(message.correlation, 'thread-1');
    assert.equal(message.body, ownerChallengeMessage(challenges));
    const [block] = [...message.body.matchAll(/```json\n(.*)\n```/g)].map((match) => JSON.parse(match[1]));
    assert.deepEqual(block, challenges[0].payload);
    return { row, payload: block };
  };
  const close = async () => {
    for (const row of open()) server.interaction.decideProposalAsOwner({ proposalId: row.proposalId, decision: 'deny', digest: row.operationDigest });
    await wake.idle();
    await new Promise((resolve) => { server.close(resolve); });
  };
  // The daemon's one-line answer to an owner reply, once it is sent.
  const answer = async (id) => {
    await until(() => relay.sent.some((message) => message.replyTo === id));
    return relay.sent.find((message) => message.replyTo === id).body;
  };
  return { owner, clock, relay, call, deliver, answer, open, until, challenged, prompts, outcomes, wake, close };
}

test('the owner\'s signed reply in the inbox finishes the decision the turn waits on', async () => {
  const t = await setup();
  try {
    const { row, payload } = await t.challenged();
    const answered = await t.deliver(reply(payload, t.owner));
    await t.wake.idle();
    assert.deepEqual(t.outcomes, [{ decision: 'approve' }]);
    assert.deepEqual(t.open(), []);
    assert.ok(t.relay.acked.includes(answered));
    // The reply never reached a turn as its prompt.
    assert.equal(t.prompts.length, 1);
    assert.equal(await t.answer(answered), 'The owner\'s signed reply approved the request.');
    assert.notEqual(row.proposalId, null);
  } finally {
    await t.close();
  }
});

test('a reply with the wrong nonce decides nothing and leaves the challenge pending', async () => {
  const t = await setup();
  try {
    const { payload } = await t.challenged();
    assert.match(await t.answer(await t.deliver(reply({ ...payload, nonce: 'A'.repeat(22) }, t.owner))), /^No owner challenge is pending/);
    assert.equal(t.open().length, 1);
    assert.equal(t.prompts.length, 1);
    // The real challenge was not spent by the stranger.
    await t.deliver(reply(payload, t.owner));
    await t.wake.idle();
    assert.deepEqual(t.outcomes, [{ decision: 'approve' }]);
  } finally {
    await t.close();
  }
});

test('a replayed reply decides nothing a second time', async () => {
  const t = await setup();
  try {
    const { payload } = await t.challenged();
    const token = reply(payload, t.owner);
    await t.deliver(token);
    await t.wake.idle();
    assert.deepEqual(t.outcomes, [{ decision: 'approve' }]);
    // A second turn waits on a new proposal; the old reply cannot decide it.
    await t.deliver('push again');
    await t.until(() => t.open().length === 1);
    const replayed = await t.deliver(token);
    assert.match(await t.answer(replayed), /^No owner challenge is pending/);
    await t.until(() => t.relay.acked.includes(replayed));
    assert.equal(t.open().length, 1);
    assert.deepEqual(t.outcomes, [{ decision: 'approve' }]);
    assert.equal(t.prompts.length, 2);
  } finally {
    await t.close();
  }
});

test('a reply signed for a different action or scope is refused and spends the challenge', async () => {
  for (const change of [
    { action: createHash('sha256').update('deny Bash for the soul: push', 'utf8').digest('hex') },
    { scope: { host: 'another-host' } },
  ]) {
    const t = await setup();
    try {
      const { payload } = await t.challenged();
      assert.match(await t.answer(await t.deliver(forged({ ...payload, ...change }, t.owner))), /^The signed reply did not decide the request: /);
      assert.equal(t.open().length, 1);
      assert.deepEqual(t.outcomes, []);
      // Checking it spent the challenge: its true answer now finds nothing.
      assert.match(await t.answer(await t.deliver(reply(payload, t.owner))), /^No owner challenge is pending/);
      assert.equal(t.open().length, 1);
    } finally {
      await t.close();
    }
  }
});

test('a reply that arrives after its challenge expired decides nothing', async () => {
  const t = await setup();
  try {
    const { payload } = await t.challenged();
    const late = reply(payload, t.owner);
    t.clock.at = (payload.exp + 1) * 1000;
    assert.match(await t.answer(await t.deliver(late)), /^No owner challenge is pending/);
    assert.equal(t.open().length, 1);
    assert.deepEqual(t.outcomes, []);
  } finally {
    await t.close();
  }
});

test('a challenge already spent on a decision route cannot be answered from the inbox', async () => {
  const t = await setup();
  try {
    const { row, payload } = await t.challenged();
    // A wrong statement sent to the route spends the pending challenge.
    const spent = await t.call('/v0/approvals/decide', {
      proposalId: row.proposalId, decision: 'approve', digest: row.operationDigest, statement: forged({ ...payload, text: 'something else' }, t.owner),
    });
    assert.equal(spent.status, 403);
    assert.match(await t.answer(await t.deliver(reply(payload, t.owner))), /^No owner challenge is pending/);
    assert.equal(t.open().length, 1);
    assert.deepEqual(t.outcomes, []);
  } finally {
    await t.close();
  }
});

test('a denial challenged from the route is finished as a denial', async () => {
  const t = await setup();
  try {
    const { payload } = await t.challenged('deny');
    const answered = await t.deliver(reply(payload, t.owner));
    await t.wake.idle();
    assert.deepEqual(t.outcomes, [{ decision: 'deny' }]);
    assert.equal(await t.answer(answered), 'The owner\'s signed reply denied the request.');
  } finally {
    await t.close();
  }
});

test('a cold turn passes the waking message to the approval it asks for', async () => {
  const asked = [];
  const run = coldTurnExecutor({
    executorFor: () => async ({ requestApproval }) => { await requestApproval({ operation: OPERATION, summary: 'push' }); return {}; },
    approvals: async (request) => { asked.push(request); return { decision: 'deny' }; },
  });
  const source = { soul: { agentId: AGENT_ID, binding }, to: OWNER, replyTo: 'm1', correlation: 'thread-1' };
  await run({ invocation: { agentId: AGENT_ID, harness: 'codex', cwd: binding.worktree }, message: 'hi', attachments: [], env: {}, source });
  await run({ invocation: { agentId: AGENT_ID, harness: 'codex', cwd: binding.worktree }, message: 'hi', attachments: [], env: {} });
  assert.deepEqual(asked.map((request) => request.source ?? null), [source, null]);
});

test('an owner reply read in the turn loop is taken before the batch runs, acked once, and never prompts a turn', async () => {
  const relay = mailbox();
  const block = armorStatement('s1.e30.AA');
  relay.inbox.push({ id: 'm1', from: { principal: OWNER }, body: 'please push' }, { id: 'm2', from: { principal: OWNER }, body: `here:\n${block}` });
  const taken = [];
  const prompts = [];
  const wake = createColdWaker({
    executor: async ({ message }) => { prompts.push(message); assert.deepEqual(taken, ['m2']); return { reply: 'ok' }; },
    settings: { [AGENT_ID]: true },
    lookupBinding: async () => binding,
    identities: async () => ({ harness: 'codex' }),
    receipt() {},
    relay,
    ownerReply: async (soul, message) => { taken.push(message.id); },
    log() {},
  });
  await wake({ agentId: AGENT_ID, count: 2, messageIds: ['m1', 'm2'] });
  await wake.idle();
  assert.deepEqual(taken, ['m2']);
  assert.equal(prompts.length, 1);
  assert.match(prompts[0], /please push/);
  assert.doesNotMatch(prompts[0], /OWNER STATEMENT/);
  assert.deepEqual(relay.acked.sort(), ['m1', 'm2']);
});
