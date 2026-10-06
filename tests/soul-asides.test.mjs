import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { createColdWaker } from '../cold-wake.mjs';
import { REACH_AGENT_ID_ENV, REACH_TURN_ENV, REACH_WORKTREE_ENV, createReachState, handleMcpMessage, reachMcpServerEntry } from '../daemon-mcp.mjs';
import { createInteractionService } from '../agent-interaction.mjs';
import { upsertSoul } from '../agent-population.mjs';
import { ASIDE_VIA, asidesDirectory, bindTurnSession, readAsides, recordAside, recordDeliveredAside, soulAsidesCommand, teamOf, turnSession } from '../soul-asides.mjs';

// Everything lives under a scratch root; nothing here touches the real HOME.
const root = mkdtempSync(path.join(tmpdir(), 'soul-asides-'));
after(() => rmSync(root, { recursive: true, force: true }));
let next = 0;
function scratch() {
  next += 1;
  const home = path.join(root, `h${next}`);
  mkdirSync(home, { recursive: true });
  const env = {
    AGENT_BOT_STATE_HOME: path.join(home, 'state'),
    AGENT_BOT_POPULATION_PATH: path.join(home, 'population.json'),
  };
  return { home, env, options: { env, home } };
}

const BILL = 'agent_aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const TED = 'agent_bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const SCOUT = 'agent_cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const LONER = 'agent_dddddddd-dddd-4ddd-8ddd-dddddddddddd';

function writeCensus(env, rows) {
  for (const row of rows) {
    upsertSoul({ id: row.id, appSlug: null, status: 'active', name: row.name.toLowerCase(), parentId: row.parentId ?? null, spacePath: `/spaces/${row.id}` },
      { file: env.AGENT_BOT_POPULATION_PATH });
  }
}

const binding = { worktree: '/work/tree', file: '/work/tree/.git/agent-bindings/soul.json' };

// A relay over one shared broker: each soul reads its own mailbox, and a
// reply lands in the recipient's.
function broker() {
  const boxes = new Map();
  let seq = 0;
  const box = (agentId) => { if (!boxes.has(agentId)) boxes.set(agentId, []); return boxes.get(agentId); };
  const deliver = (to, message) => box(to.split('/').pop()).push(message);
  return {
    deliver,
    pending: (agentId) => box(agentId).filter((message) => !message.acked),
    relay: {
      read: async (soul) => box(soul.agentId).filter((message) => !message.acked),
      reply: async (soul, reply) => {
        seq += 1;
        const messageId = `msg_reply_${seq}`;
        deliver(reply.to, { id: messageId, from: { account: 'acct', agentId: soul.agentId }, body: reply.body, replyTo: reply.replyTo, correlation: reply.correlation });
        return { messageId };
      },
      ack: async (soul, ids) => { for (const message of box(soul.agentId)) if (ids.includes(message.id)) message.acked = true; },
    },
  };
}

function waker(relay, options, executor) {
  return createColdWaker({
    executor, settings: { [BILL]: true, [TED]: true, [SCOUT]: true }, lookupBinding: async () => binding,
    identities: async () => ({ harness: 'claude' }), receipt: () => {}, relay, threads: options,
  });
}

const shape = (aside) => [aside.dir, aside.via, aside.peer.agentId ?? aside.peer.address, aside.body];

test('recordAside writes a private, bounded journal and never records a NO_REPLY final answer', () => {
  const { env, options } = scratch();
  writeCensus(env, [{ id: BILL, name: 'Bill' }, { id: TED, name: 'Ted' }]);
  const aside = recordAside(BILL, { dir: 'out', via: 'send_message', peer: `acct/${TED}`, messageId: 'm1', body: 'x'.repeat(5000) }, options);
  assert.equal(aside.peer.name, 'ted');
  assert.equal(aside.peer.agentId, TED);
  assert.ok(Buffer.byteLength(aside.body) <= 2048);
  assert.equal(recordAside(BILL, { dir: 'out', via: 'final-reply', peer: TED, body: ' NO_REPLY ' }, options), null);
  assert.equal(recordAside(BILL, { dir: 'in', via: 'mailbox', peer: TED, body: 'unknown via' }, options), null);
  assert.equal(statSync(asidesDirectory(options)).mode & 0o777, 0o700);
  assert.equal(statSync(path.join(asidesDirectory(options), `${BILL}.jsonl`)).mode & 0o777, 0o600);
  assert.deepEqual(readAsides(BILL, options).asides.map((entry) => entry.messageId), ['m1']);
});

test('a real message whose body is NO_REPLY is still an aside', () => {
  const { env, options } = scratch();
  writeCensus(env, [{ id: BILL, name: 'Bill' }, { id: TED, name: 'Ted' }]);
  assert.ok(recordAside(BILL, { dir: 'out', via: 'send_message', peer: TED, messageId: 's1', body: 'NO_REPLY' }, options));
  assert.ok(recordAside(TED, { dir: 'in', via: 'relay-prompt', peer: BILL, messageId: 's1', body: 'NO_REPLY' }, options));
  assert.equal(recordAside(TED, { dir: 'out', via: 'final-reply', peer: BILL, body: 'NO_REPLY' }, options), null);
  assert.deepEqual(readAsides(BILL, options).asides.map((entry) => entry.body), ['NO_REPLY']);
  assert.deepEqual(readAsides(TED, options).asides.map((entry) => entry.via), ['relay-prompt']);
});

test('live delivery vias are accepted by recordAside without marking them reshown', () => {
  const { options } = scratch();
  for (const via of ['inbox-read', 'hook-inject']) {
    assert.ok(ASIDE_VIA.includes(via));
    const aside = recordAside(BILL, { dir: 'in', via, body: 'NO_REPLY' }, options);
    assert.equal(aside.via, via);
    assert.equal(aside.reshown, false);
    assert.equal(aside.body, 'NO_REPLY');
  }
});

test('delivery deduplication scans beyond the first journal page and remains per soul', () => {
  const { options } = scratch();
  for (let i = 0; i < 205; i += 1) {
    recordAside(BILL, { dir: 'in', via: 'relay-prompt', messageId: `m${i}`, body: 'hi' }, options);
  }
  const entry = { via: 'inbox-read', messageId: 'm204', body: 'hi' };
  assert.equal(recordDeliveredAside(BILL, entry, options).recorded, false);
  assert.equal(recordDeliveredAside(TED, entry, options).recorded, true);
  assert.equal(readAsides(BILL, { ...options, limit: 1000 }).asides.length, 205);
});

test('a trim keeps the newest asides within both the count and half the byte limit', () => {
  const { env, options } = scratch();
  writeCensus(env, [{ id: BILL, name: 'Bill' }, { id: TED, name: 'Ted' }]);
  const file = path.join(asidesDirectory(options), `${BILL}.jsonl`);
  const maxBytes = 20_000;
  let trims = 0;
  let last = 0;
  for (let index = 0; index < 60; index += 1) {
    recordAside(BILL, { dir: 'out', via: 'send_message', peer: TED, messageId: `m${index}`, body: 'y'.repeat(1500) }, { ...options, maxBytes, keep: 1000, rows: [] });
    const size = statSync(file).size;
    assert.ok(size <= maxBytes, `journal ${size} bytes exceeds ${maxBytes}`);
    if (size < last) trims += 1;
    last = size;
  }
  // Byte-bounded: after a trim the file is at most half the limit, so the
  // next appends do not rewrite it again straight away.
  assert.ok(trims >= 1 && trims <= 10, `trimmed ${trims} times`);
  const ids = readAsides(BILL, options).asides.map((entry) => entry.messageId);
  assert.equal(ids.at(-1), 'm59');
  assert.ok(ids.length < 60);
  // Count-bounded too: a trim with room for many keeps only `keep`.
  for (let index = 0; index < 5; index += 1) {
    recordAside(TED, { dir: 'out', via: 'send_message', peer: BILL, messageId: `k${index}`, body: 'z' }, { ...options, rows: [] });
  }
  const tedFile = path.join(asidesDirectory(options), `${TED}.jsonl`);
  recordAside(TED, { dir: 'out', via: 'send_message', peer: BILL, messageId: 'k5', body: 'z' }, { ...options, maxBytes: statSync(tedFile).size, keep: 2, rows: [] });
  assert.deepEqual(readAsides(TED, options).asides.map((entry) => entry.messageId), ['k4', 'k5']);
});

test('a reach-server send names its turn\'s harness session once the turn bound it', () => {
  const { env, options } = scratch();
  writeCensus(env, [{ id: BILL, name: 'Bill' }, { id: TED, name: 'Ted' }]);
  const turn = 'turn_22222222-2222-4222-8222-222222222222';
  assert.equal(turnSession(BILL, turn, options), null);
  assert.equal(bindTurnSession(BILL, turn, 'sess-bill', options), true);
  assert.equal(bindTurnSession(BILL, null, 'sess-x', options), false);
  assert.equal(turnSession(BILL, turn, options), 'sess-bill');
  const aside = recordAside(BILL, { dir: 'out', via: 'send_message', peer: TED, messageId: 'm1', body: 'hi', turnId: turn }, options);
  assert.equal(aside.harnessSessionId, 'sess-bill');
  const other = recordAside(BILL, { dir: 'out', via: 'send_message', peer: TED, messageId: 'm2', body: 'hi', turnId: 'turn_33333333-3333-4333-8333-333333333333' }, options);
  assert.equal(other.harnessSessionId, null);
  assert.equal(statSync(path.join(asidesDirectory(options), `${BILL}.turns.json`)).mode & 0o777, 0o600);
});

test('a peer is named by its soul.json name when its folder is known', () => {
  const { env, home, options } = scratch();
  const soulDir = path.join(home, 'Ted - Starter.soul');
  mkdirSync(soulDir);
  writeFileSync(path.join(soulDir, 'soul.json'), JSON.stringify({ name: 'Ted - Starter' }));
  upsertSoul({ id: TED, appSlug: null, status: 'active', name: 'ted', spacePath: `/spaces/${TED}`, soulDir }, { file: env.AGENT_BOT_POPULATION_PATH });
  assert.equal(recordAside(BILL, { dir: 'out', via: 'send_message', peer: TED, body: 'hi' }, options).peer.name, 'Ted - Starter');
});

test('readAsides pages with an aside-id cursor', () => {
  const { options } = scratch();
  const ids = [];
  for (let index = 0; index < 5; index += 1) ids.push(recordAside(BILL, { dir: 'in', via: 'relay-prompt', peer: TED, body: `n${index}` }, options).id);
  const first = readAsides(BILL, { ...options, limit: 2 });
  assert.deepEqual(first.asides.map((entry) => entry.body), ['n0', 'n1']);
  assert.equal(first.next, ids[1]);
  const rest = readAsides(BILL, { ...options, after: first.next, limit: 10 });
  assert.deepEqual(rest.asides.map((entry) => entry.body), ['n2', 'n3', 'n4']);
  assert.equal(rest.next, null);
});

test('teamOf names the root of a started team for every member, and null off a team', () => {
  const rows = [{ id: BILL, parentId: null }, { id: SCOUT, parentId: BILL }, { id: TED, parentId: null }];
  assert.equal(teamOf(BILL, rows), BILL);
  assert.equal(teamOf(SCOUT, rows), BILL);
  assert.equal(teamOf(TED, rows), null);
});

// Bill asks Ted with send_message during his turn; Ted's cold turn answers,
// the relay sends that answer back, and Bill's next cold turn receives it.
test('a cold-wake relay A→B with a reply leaves mirrored asides linked by correlation', async () => {
  const { env, options } = scratch();
  writeCensus(env, [{ id: BILL, name: 'Bill' }, { id: TED, name: 'Ted' }]);
  const net = broker();
  // Bill's send from inside a turn goes through the reach server.
  const sends = [];
  const run = (command, args, opts, callback) => {
    if (args[0] === 'send') {
      sends.push(args);
      const correlation = args.includes('--correlation') ? args[args.indexOf('--correlation') + 1] : null;
      net.deliver(args[1], { id: 'msg_ask', from: { account: 'acct', agentId: BILL }, body: args[3], correlation });
      return callback(null, JSON.stringify({ ok: true, messageId: 'msg_ask', wake: 'cold' }), '');
    }
    return callback(new Error('unexpected'), '', '');
  };
  const reach = createReachState({
    env: { ...env, [REACH_AGENT_ID_ENV]: BILL, [REACH_WORKTREE_ENV]: '/work/tree', AGENT_BOT_BINDING: '/work/tree/b.json', [REACH_TURN_ENV]: 'turn_11111111-1111-4111-8111-111111111111' },
    home: options.home, cwd: tmpdir(), run,
  });
  const response = await handleMcpMessage(reach, { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'send_message', arguments: { to: TED, body: 'Ted, a tip?' } } });
  assert.equal(response.result.isError, undefined);

  const sessions = { [TED]: 'sess-ted', [BILL]: 'sess-bill' };
  const turns = {};
  const wake = waker(net.relay, options, async ({ invocation, onSession }) => {
    onSession(sessions[invocation.agentId]);
    assert.match(invocation.turnId, /^turn_/);
    turns[invocation.agentId] = invocation.turnId;
    return { reply: invocation.agentId === TED ? 'Use small commits.' : 'NO_REPLY' };
  });
  await wake({ agentId: TED, count: 1, messageIds: ['msg_ask'] });
  await wake.idle();
  await wake({ agentId: BILL, count: 1, messageIds: ['msg_reply_1'] });
  await wake.idle();

  const bill = readAsides(BILL, options).asides;
  const ted = readAsides(TED, options).asides;
  assert.deepEqual(ted.map(shape), [
    ['in', 'relay-prompt', BILL, 'Ted, a tip?'],
    ['out', 'final-reply', BILL, 'Use small commits.'],
  ]);
  assert.deepEqual(bill.map(shape), [
    ['out', 'send_message', TED, 'Ted, a tip?'],
    // Bill's second turn re-shows his own ask as thread context, then the reply.
    ['out', 'thread-context', TED, 'Ted, a tip?'],
    ['in', 'relay-prompt', TED, 'Use small commits.'],
  ]);
  assert.equal(bill[0].turnId, 'turn_11111111-1111-4111-8111-111111111111');
  assert.equal(bill[1].reshown, true);
  assert.equal(bill[2].reshown, false);
  assert.equal(bill[2].harnessSessionId, 'sess-bill');
  assert.equal(ted[0].harnessSessionId, 'sess-ted');
  assert.equal(ted[0].turnId, ted[1].turnId);
  assert.equal(ted[0].peer.name, 'bill');
  // One conversation: every aside on both sides carries the ask's thread key.
  const key = ted[0].correlation ?? ted[0].messageId;
  for (const aside of [...ted.slice(1), bill[2]]) assert.equal(aside.correlation, key);
  // Bill's NO_REPLY sent nothing and recorded nothing outbound.
  assert.equal(bill.filter((aside) => aside.via === 'final-reply').length, 0);
  // A send Bill's woken turn made through its reach server names that
  // turn's harness session (bound when the session started).
  const later = createReachState({
    env: { ...env, [REACH_AGENT_ID_ENV]: BILL, [REACH_WORKTREE_ENV]: '/work/tree', AGENT_BOT_BINDING: '/work/tree/b.json', [REACH_TURN_ENV]: turns[BILL] },
    home: options.home, cwd: tmpdir(), run,
  });
  await handleMcpMessage(later, { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'send_message', arguments: { to: TED, body: 'Thanks' } } });
  const sent = readAsides(BILL, options).asides.at(-1);
  assert.equal(sent.via, 'send_message');
  assert.equal(sent.turnId, turns[BILL]);
  assert.equal(sent.harnessSessionId, 'sess-bill');
});

test('an unread message, and a turn that fails before its session, leave no aside', async () => {
  const { env, options } = scratch();
  writeCensus(env, [{ id: BILL, name: 'Bill' }, { id: TED, name: 'Ted' }, { id: LONER, name: 'Loner' }]);
  const net = broker();
  net.deliver(LONER, { id: 'msg_unread', from: { account: 'acct', agentId: BILL }, body: 'never woken' });
  net.deliver(TED, { id: 'msg_fail', from: { account: 'acct', agentId: BILL }, body: 'turn fails' });
  // Loner has cold wake off: the message stays in the mailbox.
  const off = createColdWaker({ executor: async () => ({}), settings: {}, lookupBinding: async () => binding, identities: async () => ({ harness: 'claude' }), receipt: () => {}, relay: net.relay, threads: options });
  assert.equal((await off({ agentId: LONER, count: 1, messageIds: ['msg_unread'] })).outcome, 'waiting');
  const failing = waker(net.relay, options, async () => { throw new Error('harness would not start'); });
  await failing({ agentId: TED, count: 1, messageIds: ['msg_fail'] });
  await failing.idle();
  assert.deepEqual(readAsides(LONER, options).asides, []);
  assert.deepEqual(readAsides(TED, options).asides, []);
  assert.equal(net.pending(LONER).length, 1);
});

test('asides on a started team carry the team id on both members', async () => {
  const { env, options } = scratch();
  writeCensus(env, [{ id: BILL, name: 'Bill' }, { id: SCOUT, name: 'Scout', parentId: BILL }]);
  const net = broker();
  net.deliver(SCOUT, { id: 'msg_brief', from: { account: 'acct', agentId: BILL }, body: 'Research X.' });
  const wake = waker(net.relay, options, async () => ({ reply: 'X is Y.' }));
  await wake({ agentId: SCOUT, count: 1, messageIds: ['msg_brief'] });
  await wake.idle();
  await wake({ agentId: BILL, count: 1, messageIds: ['msg_reply_1'] });
  await wake.idle();
  const scout = readAsides(SCOUT, options).asides;
  const bill = readAsides(BILL, options).asides;
  assert.ok(scout.length === 2 && bill.length >= 1);
  for (const aside of [...scout, ...bill]) assert.equal(aside.teamId, BILL);
});

test('a lane that names no session still records what its turn received', async () => {
  const { env, options } = scratch();
  writeCensus(env, [{ id: BILL, name: 'Bill' }, { id: TED, name: 'Ted' }]);
  const net = broker();
  net.deliver(TED, { id: 'msg_resume', from: { account: 'acct', agentId: BILL }, body: 'resume lane' });
  const wake = waker(net.relay, options, async () => ({ reply: '' }));
  await wake({ agentId: TED, count: 1, messageIds: ['msg_resume'] });
  await wake.idle();
  const ted = readAsides(TED, options).asides;
  assert.deepEqual(ted.map(shape), [['in', 'relay-prompt', BILL, 'resume lane']]);
  assert.equal(ted[0].harnessSessionId, null);
});

test('the reach entry stamps only a well-formed turn id', () => {
  const stamped = (turnId) => reachMcpServerEntry({ agentId: BILL, env: {}, turnId }).env.find((pair) => pair.name === REACH_TURN_ENV)?.value ?? null;
  assert.equal(stamped('turn_11111111-1111-4111-8111-111111111111'), 'turn_11111111-1111-4111-8111-111111111111');
  assert.equal(stamped('turn_x; rm -rf'), null);
  assert.equal(stamped(null), null);
});

test('agent-bot soul asides refuses a caller with a soul marker and reads by name for the owner', async () => {
  const { env, options } = scratch();
  writeCensus(env, [{ id: BILL, name: 'Bill' }, { id: TED, name: 'Ted' }]);
  recordAside(BILL, { dir: 'in', via: 'relay-prompt', peer: TED, body: 'hello' }, options);
  let out = '';
  const result = await soulAsidesCommand(['bill', '--json'], { env, home: options.home, write: (text) => { out += text; }, markers: async () => [] });
  assert.equal(result.agentId, BILL);
  assert.deepEqual(JSON.parse(out).asides.map((aside) => aside.body), ['hello']);
  await assert.rejects(
    soulAsidesCommand([BILL, '--json'], { env, home: options.home, write: () => {}, markers: async () => ['Agent ID'] }),
    (error) => error.code === 'not-owner',
  );
  await assert.rejects(soulAsidesCommand([BILL, '--after'], { env, home: options.home, write: () => {}, markers: async () => [] }), /usage/);
});

test('the daemon route lists asides only for a principal allowed to observe the soul', () => {
  const { env, options } = scratch();
  writeCensus(env, [{ id: BILL, name: 'Bill' }, { id: TED, name: 'Ted' }]);
  recordAside(BILL, { dir: 'in', via: 'relay-prompt', peer: TED, body: 'hello' }, options);
  const service = createInteractionService({ env, home: options.home });
  const principal = (souls, operations = ['observe']) => ({ principalId: 'principal_11111111-1111-4111-8111-111111111111', status: 'active', authorizations: { souls, operations } });
  const observer = principal([BILL]);
  const listed = service.listAsides({ principal: observer, transport: 'web', agentId: BILL });
  assert.deepEqual(listed.asides.map((aside) => aside.body), ['hello']);
  assert.throws(() => service.listAsides({ principal: principal([TED]), transport: 'web', agentId: BILL }), (error) => error.statusCode === 403);
  assert.throws(() => service.listAsides({ principal: principal([BILL], ['send']), transport: 'web', agentId: BILL }), (error) => error.statusCode === 403);
  assert.throws(() => service.listAsides({ principal: observer, transport: 'web', agentId: BILL, after: '../x' }), (error) => error.statusCode === 400);
});
