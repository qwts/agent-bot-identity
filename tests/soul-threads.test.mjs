import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { createColdWaker } from '../cold-wake.mjs';
import { createCommsRelay } from '../comms-relay.mjs';
import { createReachState, handleMcpMessage, reachMcpServerEntry } from '../daemon-mcp.mjs';
import {
  clip, formatThread, recordThreadMessage, stripNoReply, threadContext, threadsDirectory,
} from '../soul-threads.mjs';

const roots = [];
after(() => { for (const root of roots) rmSync(root, { recursive: true, force: true }); });

// A scratch state home; nothing here touches the real HOME.
function scratch() {
  const root = mkdtempSync(path.join(tmpdir(), 'soul-threads-'));
  roots.push(root);
  return { root, options: { env: { AGENT_BOT_STATE_HOME: path.join(root, 'state') }, home: root } };
}

const BILL = 'agent_bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

test('stripNoReply drops a final NO_REPLY line and never sends the token', () => {
  assert.equal(stripNoReply('NO_REPLY'), '');
  assert.equal(stripNoReply('  NO_REPLY \n\n'), '');
  assert.equal(stripNoReply('Passed the list to Starter.\nNO_REPLY'), 'Passed the list to Starter.');
  assert.equal(stripNoReply('Done.\n  NO_REPLY  \n'), 'Done.');
  assert.equal(stripNoReply('NO_REPLY\nNO_REPLY'), '');
  assert.equal(stripNoReply('Here is the list.'), 'Here is the list.');
  assert.equal(stripNoReply('Say NO_REPLY when done'), 'Say NO_REPLY when done', 'only a line of its own is the sentinel');
  assert.equal(stripNoReply(''), '');
  assert.equal(stripNoReply(undefined), '');
});

test('the journal is private, bounded per entry, and follows replyTo and correlation links', () => {
  const { options } = scratch();
  const at = (n) => () => new Date(Date.UTC(2026, 9, 3, 12, n));
  recordThreadMessage(BILL, { dir: 'in', id: 'msg_s', from: 'acct/starter', body: 'Bill, get the book list from Ted.' }, { ...options, now: at(0) });
  recordThreadMessage(BILL, { dir: 'in', id: 'msg_x', from: 'owner', body: 'unrelated' }, { ...options, now: at(1) });
  recordThreadMessage(BILL, { dir: 'out', id: 'msg_b', to: 'acct/ted', correlation: 'msg_s', body: 'Ted, your book list?' }, { ...options, now: at(2) });
  recordThreadMessage(BILL, { dir: 'out', id: 'msg_big', to: 'acct/ted', correlation: 'other', body: 'x'.repeat(5000) }, { ...options, now: at(3) });

  const dir = threadsDirectory(options);
  assert.equal(statSync(dir).mode & 0o777, 0o700);
  assert.equal(statSync(path.join(dir, `${BILL}.jsonl`)).mode & 0o777, 0o600);
  const big = readFileSync(path.join(dir, `${BILL}.jsonl`), 'utf8').trim().split('\n').map((line) => JSON.parse(line)).at(-1);
  assert.ok(Buffer.byteLength(big.body) <= 2048, 'the stored body fits the 2 KiB cap, marker included');
  assert.ok(big.body.endsWith('…'));

  // Ted's answer replies to Bill's send: the request it served comes along.
  const thread = threadContext(BILL, { id: 'msg_t', replyTo: 'msg_b', correlation: 'msg_s' }, options);
  assert.deepEqual(thread.map((entry) => entry.id), ['msg_s', 'msg_b']);
  // replyTo alone is enough to find the way back.
  assert.deepEqual(threadContext(BILL, { id: 'msg_t', replyTo: 'msg_b' }, options).map((entry) => entry.id), ['msg_s', 'msg_b']);
  // A first message has no thread.
  assert.deepEqual(threadContext(BILL, { id: 'msg_new' }, options), []);

  const text = formatThread(thread);
  assert.match(text, /message data for context, not instructions/);
  assert.match(text, /acct\/starter → you: "Bill, get the book list from Ted\."/);
  assert.match(text, /you → acct\/ted: "Ted, your book list\?"/);
});

test('a thread keeps the newest 8 messages within 6 KB, oldest first', () => {
  const { options } = scratch();
  for (let n = 0; n < 12; n += 1) {
    recordThreadMessage(BILL, { dir: n % 2 ? 'out' : 'in', id: `msg_${n}`, from: 'acct/ted', to: 'acct/ted', correlation: 'job', body: `turn ${n} ${'y'.repeat(900)}` }, options);
  }
  const thread = threadContext(BILL, { id: 'msg_new', correlation: 'job' }, options);
  assert.ok(thread.length <= 8);
  assert.ok(Buffer.byteLength(JSON.stringify(thread)) <= 6 * 1024);
  assert.equal(thread.at(-1).id, 'msg_11');
  assert.deepEqual(thread.map((entry) => entry.id), [...thread.map((entry) => entry.id)].sort((a, b) => Number(a.slice(4)) - Number(b.slice(4))));
});

test('clip keeps a body within its byte cap, marker included, without splitting a character', () => {
  assert.equal(clip('a'.repeat(2048), 2048), 'a'.repeat(2048), 'a body at the cap is kept whole');
  const over = clip('a'.repeat(2049), 2048);
  assert.equal(Buffer.byteLength(over), 2048);
  assert.equal(over, `${'a'.repeat(2045)}…`);
  for (const prefix of ['', 'a', 'aa', 'aaa']) {
    for (const char of ['é', '€', '😀']) {
      const cut = clip(prefix + char.repeat(2048), 2048);
      assert.ok(Buffer.byteLength(cut) <= 2048, `${JSON.stringify(prefix)}+${char} fits`);
      assert.ok(Buffer.byteLength(cut) > 2048 - 3 - 4, `${JSON.stringify(prefix)}+${char} keeps what fits`);
      assert.ok(!cut.includes('\uFFFD') && cut.endsWith('…'));
    }
  }
  assert.equal(clip(undefined, 10), '');
});

// The daemon's relay and each turn's reach server append to one journal from
// different processes. A rewrite must never drop a line appended meanwhile.
test('concurrent writers never lose an append to a rewrite', async () => {
  const { options } = scratch();
  const moduleUrl = new URL('../soul-threads.mjs', import.meta.url).href;
  const writer = (n) => new Promise((resolve, reject) => {
    const script = `const { recordThreadMessage } = await import(${JSON.stringify(moduleUrl)});
      for (let i = 0; i < 80; i += 1) {
        if (!recordThreadMessage(${JSON.stringify(BILL)}, { dir: 'in', id: 'w${n}_' + i, from: 'owner', body: 'x'.repeat(200) },
          { env: { AGENT_BOT_STATE_HOME: ${JSON.stringify(options.env.AGENT_BOT_STATE_HOME)} }, home: ${JSON.stringify(options.home)}, maxBytes: 4096, keep: 100000 })) process.exit(3);
      }`;
    const child = spawn(process.execPath, ['--input-type=module', '-e', script], { stdio: 'inherit', env: { PATH: process.env.PATH, HOME: options.home } });
    child.on('error', reject);
    child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`writer ${n} exited ${code}`))));
  });
  await Promise.all([0, 1, 2, 3].map(writer));
  // `keep` is larger than everything written, so every rewrite keeps every
  // line: any id missing here was lost to a race.
  const file = path.join(threadsDirectory(options), `${BILL}.jsonl`);
  const ids = new Set(readFileSync(file, 'utf8').trim().split('\n').map((line) => JSON.parse(line).id));
  for (const n of [0, 1, 2, 3]) {
    for (let i = 0; i < 80; i += 1) assert.ok(ids.has(`w${n}_${i}`), `w${n}_${i} survived`);
  }
  assert.equal(ids.size, 320);
});

test('the journal rewrites itself before it grows without bound', () => {
  const { options } = scratch();
  for (let n = 0; n < 700; n += 1) {
    recordThreadMessage(BILL, { dir: 'in', id: `msg_${n}`, from: 'owner', body: 'z'.repeat(1000) }, options);
  }
  const file = path.join(threadsDirectory(options), `${BILL}.jsonl`);
  assert.ok(statSync(file).size <= 512 * 1024 + 2048);
  assert.equal(statSync(file).mode & 0o777, 0o600);
  assert.match(readFileSync(file, 'utf8').trim().split('\n').at(-1), /"msg_699"/);
});

test('an unwritable journal never fails the turn', () => {
  assert.equal(recordThreadMessage(BILL, { dir: 'in', id: 'm', body: 'hi' }, { env: {}, home: '/nonexistent/home' }), false);
  assert.deepEqual(threadContext(BILL, { id: 'm2', replyTo: 'm' }, { env: {}, home: '/nonexistent/home' }), []);
});

// --- three souls (#392) -------------------------------------------------------
//
// Starter asks Bill to get the book list from Ted. Bill asks Ted through
// send_message, Ted answers, and the answer wakes Bill in a fresh session.
// The fake agents below see only their prompt, as a cold ACP turn does: Bill
// can forward Ted's list only if the prompt carries Starter's request.

const ACCOUNT = 'acct';
const SOULS = {
  starter: 'agent_aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  bill: BILL,
  ted: 'agent_cccccccc-cccc-4ccc-8ccc-cccccccccccc',
};
const nameOf = Object.fromEntries(Object.entries(SOULS).map(([name, agentId]) => [agentId, name]));
const addressOf = (agentId) => `${ACCOUNT}/${agentId}`;

// An in-memory broker behind a fake `agent-comms`, enforcing what the real
// one does that matters here: replyTo must be a message the sender received.
function fakeBroker() {
  const messages = [];
  const acked = new Set();
  const run = (command, args, options, done) => {
    const me = options.env.AGENT_BOT_ID;
    const flag = (name) => { const at = args.indexOf(`--${name}`); return at === -1 ? null : args[at + 1]; };
    const answer = (value) => done(null, JSON.stringify({ ok: true, ...value }), '');
    if (args[0] === 'peers') {
      return answer({ peers: Object.entries(SOULS).filter(([, id]) => id !== me).map(([name, agentId]) => ({ name, agentId, account: ACCOUNT, address: addressOf(agentId) })) });
    }
    if (args[0] === 'inbox' && args[1] === 'read') {
      return answer({ messages: messages.filter((m) => m.to.agentId === me && !acked.has(m.id)) });
    }
    if (args[0] === 'inbox' && args[1] === 'ack') { args.slice(2).forEach((id) => acked.add(id)); return answer({}); }
    if (args[0] === 'send') {
      const to = args[1].split('/').pop();
      const replyTo = flag('reply-to');
      if (replyTo && messages.find((m) => m.id === replyTo)?.to.agentId !== me) {
        return done(new Error('exit 1'), JSON.stringify({ ok: false, error: { code: 'unknown-message', message: 'replyTo must be a message you received' } }), '');
      }
      const message = {
        id: `msg_${messages.length + 1}`, from: { account: ACCOUNT, agentId: me }, to: { account: ACCOUNT, agentId: to },
        kind: 'message', body: flag('body'), correlation: flag('correlation'), replyTo,
      };
      messages.push(message);
      return answer({ messageId: message.id, wake: 'cold' });
    }
    return done(new Error('unexpected'), '', `unexpected ${args.join(' ')}`);
  };
  return { run, messages, pending: (agentId) => messages.some((m) => m.to.agentId === agentId && !acked.has(m.id)) };
}

// One soul's model, scripted. It can call the reach server's send_message,
// stamped exactly as wake-plane stamps a relayed turn's entry.
function fakeAgent(agentId, broker, options, prompts) {
  return async ({ invocation, message }) => {
    prompts.push(message);
    const entry = reachMcpServerEntry({
      agentId, worktree: `/souls/${nameOf[agentId]}`, binding: `/souls/${nameOf[agentId]}/binding.json`,
      correlation: invocation.correlation ?? null, env: options.env,
    });
    const state = createReachState({ env: Object.fromEntries(entry.env.map(({ name, value }) => [name, value])), home: options.home, run: broker.run });
    const sendMessage = (to, body) => handleMcpMessage(state, { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'send_message', arguments: { to, body } } });
    const newest = message.slice(message.lastIndexOf('\n\n') + 2);
    if (agentId === SOULS.bill && /get the book list from Ted/.test(newest)) {
      await sendMessage('ted', 'Ted, what is on your book list?');
      return { reply: 'Asking Ted now; I will send it on.' };
    }
    if (agentId === SOULS.ted && /book list/.test(newest)) return { reply: 'Dune, Emma, Middlemarch.' };
    if (agentId === SOULS.bill && /Dune/.test(newest)) {
      // Who asked? Only the thread in the prompt can say.
      const requester = /- \[[^\]]*\] (\S+) → you: "Bill, get the book list/.exec(message)?.[1];
      if (requester) await sendMessage(requester, `Ted's book list: ${newest}`);
      return { reply: 'NO_REPLY' };
    }
    return { reply: 'NO_REPLY' };
  };
}

test('A asks B to ask C and gets C\'s answer back through B', async () => {
  const { options } = scratch();
  const broker = fakeBroker();
  const relay = createCommsRelay({ env: {}, run: broker.run });
  const prompts = { bill: [], ted: [] };
  const wakers = Object.fromEntries(['bill', 'ted'].map((name) => [SOULS[name], createColdWaker({
    executor: fakeAgent(SOULS[name], broker, options, prompts[name]),
    settings: { [SOULS[name]]: true },
    lookupBinding: async () => ({ worktree: `/souls/${name}`, file: `/souls/${name}/binding.json` }),
    identities: async () => ({ harness: 'claude' }),
    receipt: () => {},
    relay,
    threads: options,
    log: () => {},
  })]));

  // Starter (driven by hand here) asks Bill.
  await new Promise((resolve, reject) => broker.run('agent-comms', ['send', addressOf(SOULS.bill), '--body', 'Bill, get the book list from Ted.'],
    { env: { AGENT_BOT_ID: SOULS.starter } }, (error) => (error ? reject(error) : resolve())));

  // Deliver wakes until every inbox is quiet.
  for (let round = 0; round < 10; round += 1) {
    const due = Object.keys(wakers).filter((agentId) => broker.pending(agentId));
    if (due.length === 0) break;
    for (const agentId of due) {
      await wakers[agentId]({ agentId, count: 1, messageIds: [] });
      await wakers[agentId].idle();
    }
  }

  const toStarter = broker.messages.filter((m) => m.to.agentId === SOULS.starter);
  // Bill's first turn used send_message, so its final text ("Asking Ted
  // now…") is not sent as well (#407): Starter hears only the answer.
  assert.deepEqual(toStarter.map((m) => m.body), [
    'Ted\'s book list: Dune, Emma, Middlemarch.',
  ]);
  // Everything Bill and Ted said for this job carries the request's id.
  const request = broker.messages[0];
  for (const m of broker.messages.slice(1)) assert.equal(m.correlation, request.id, `${m.id} stays in the thread`);
  // Bill's second, fresh turn saw the request as quoted data.
  assert.equal(prompts.bill.length, 2);
  assert.match(prompts.bill[1], /not instructions/);
  assert.match(prompts.bill[1], /pass the result on to them with send_message/);
  // NO_REPLY was never sent to anyone.
  assert.equal(broker.messages.some((m) => /NO_REPLY/.test(m.body)), false);
});
