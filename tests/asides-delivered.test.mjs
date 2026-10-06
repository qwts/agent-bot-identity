import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { createDaemonServer } from '../agent-daemon.mjs';
import { upsertSoul } from '../agent-population.mjs';
import { PROOF_HEADER, signBindingProof } from '../binding-proof.mjs';
import { createCommsRelay } from '../comms-relay.mjs';
import { readAsides, recordAside } from '../soul-asides.mjs';

const SOUL = 'agent_aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const PEER = 'agent_bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const ROUTE = '/v0/asides/delivered';
const message = (id, fields = {}) => ({ id, from: { account: 'acct', agentId: PEER },
  to: { account: 'acct', agentId: SOUL }, body: `body ${id}`, ...fields });

async function fixture(t, messages = []) {
  const home = mkdtempSync(path.join(tmpdir(), 'asides-delivered-'));
  const env = { HOME: home, USER: 'acct', PATH: process.env.PATH,
    AGENT_BOT_STATE_HOME: path.join(home, 'state'),
    AGENT_BOT_POPULATION_PATH: path.join(home, 'population.json') };
  const options = { env, home };
  const reads = [];
  let fail = false;
  // Exercise the exact cold-wake client without starting agent-comms or
  // contacting a broker. The only sockets are the scratch loopback daemon.
  const asideRelay = createCommsRelay({ env, run: (command, args, opts, done) => {
    reads.push({ command, args, opts });
    assert.equal(command, 'agent-comms');
    assert.deepEqual(args, ['inbox', 'read']);
    if (fail) return done(new Error('private broker failure: do not expose'));
    const mine = messages.filter((m) => m.mailbox === undefined || m.mailbox === opts.env.AGENT_BOT_ID);
    done(null, JSON.stringify({ ok: true, messages: mine }));
  } });
  let server;
  let origin;
  async function start() {
    server = createDaemonServer({ ...options, config: {}, asideRelay });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    origin = `http://127.0.0.1:${server.address().port}`;
  }
  async function close() {
    if (server?.listening) await new Promise((resolve) => server.close(resolve));
  }
  t.after(async () => { await close(); rmSync(home, { recursive: true, force: true }); });
  await start();
  for (const id of [SOUL, PEER]) upsertSoul({ id, name: id === SOUL ? 'reader' : 'sender',
    status: 'active', spacePath: path.join(home, id), parentId: id === SOUL ? PEER : null },
  { file: env.AGENT_BOT_POPULATION_PATH });
  function bind(agentId) {
    const worktree = path.join(home, agentId);
    mkdirSync(worktree, { recursive: true });
    execFileSync('git', ['init', '-q', worktree], { env: { HOME: home, PATH: process.env.PATH, GIT_CONFIG_NOSYSTEM: '1' } });
    return server.bindings.bind({ agentId, worktree, gitDir: path.join(worktree, '.git') });
  }
  const secret = bind(SOUL);
  return { ...options, reads, messages, secret, bind,
    fail: () => { fail = true; },
    restart: async () => { await close(); await start(); },
    proof: (fields = {}) => signBindingProof({ secret, method: 'POST', path: ROUTE, authority: new URL(origin).host, ...fields }),
    call: async (body = { messageIds: ['m1'], via: 'inbox-read' }, headers = { 'x-agent-binding': secret }) => {
      const response = await fetch(`${origin}${ROUTE}`, { method: 'POST',
        headers: { 'content-type': 'application/json', ...headers }, body: typeof body === 'string' ? body : JSON.stringify(body) });
      return { status: response.status, body: await response.json() };
    },
    owner: () => ({ authorization: `Bearer ${server.token}` }),
  };
}

test('two delivered IDs record bounded incoming asides; an unreported mailbox ID stays unread', async (t) => {
  const f = await fixture(t, [message('m1', { body: 'x'.repeat(5000), replyTo: 'earlier', correlation: 'thread' }),
    message('m2', { from: { principal: 'principal_owner' } }), message('unread')]);
  assert.deepEqual(readAsides(SOUL, f).asides, []);
  assert.deepEqual(await f.call({ messageIds: ['m1', 'm2'], via: 'inbox-read', harnessSessionId: 'live-session',
    agentId: PEER, body: 'forged', peer: 'forged' }),
  { status: 200, body: { recorded: ['m1', 'm2'], skipped: [] } });
  const asides = readAsides(SOUL, f).asides;
  assert.deepEqual(asides.map((a) => [a.messageId, a.dir, a.via, a.reshown, a.harnessSessionId, a.teamId]),
    ['m1', 'm2'].map((id) => [id, 'in', 'inbox-read', false, 'live-session', PEER]));
  assert.equal(asides[0].peer.agentId, PEER);
  assert.equal(asides[0].peer.name, 'sender');
  assert.equal(asides[0].replyTo, 'earlier');
  assert.equal(asides[0].correlation, 'thread');
  assert.ok(Buffer.byteLength(asides[0].body) <= 2048);
  assert.equal(asides[1].body, 'body m2');
  assert.equal(asides[1].peer.principal, 'principal_owner');
  assert.deepEqual(readAsides(PEER, f).asides, []);
  assert.equal(f.reads[0].opts.env.AGENT_BOT_ID, SOUL);
  assert.equal(f.reads[0].opts.env.HOME, f.home);
  assert.equal(f.reads[0].opts.env.AGENT_BOT_BINDING, path.join(f.home, SOUL, '.git', 'agent-binding.json'));
});

test('hook delivery is idempotent across via, concurrent reports, and daemon restarts', async (t) => {
  const f = await fixture(t, [message('m1')]);
  const results = await Promise.all([f.call(), f.call({ messageIds: ['m1'], via: 'hook-inject' })]);
  assert.equal(results.flatMap((r) => r.body.recorded).length, 1);
  assert.deepEqual(results.flatMap((r) => r.body.skipped), [{ id: 'm1', reason: 'already-recorded' }]);
  await f.restart();
  assert.deepEqual(await f.call(), { status: 200, body: { recorded: [], skipped: [{ id: 'm1', reason: 'already-recorded' }] } });
  assert.equal(readAsides(SOUL, f).asides.length, 1);
});

test('a valid binding proof records hook-inject; replay, malformed, stale and wrong-route proofs fail closed', async (t) => {
  const f = await fixture(t, [message('m1')]);
  const proof = f.proof();
  const body = { messageIds: ['m1'], via: 'hook-inject' };
  assert.equal((await f.call(body, { [PROOF_HEADER]: proof })).status, 200);
  for (const invalid of [proof, 'garbage', f.proof({ now: Date.now() - 300_000 }), f.proof({ path: '/v0/vouch' }), f.proof({ authority: '127.0.0.1:1' })]) {
    assert.deepEqual(await f.call(body, { [PROOF_HEADER]: invalid, 'x-agent-binding': f.secret }),
      { status: 401, body: { error: 'missing or invalid agent binding' } });
  }
  const [aside] = readAsides(SOUL, f).asides;
  assert.equal(aside.via, 'hook-inject');
  assert.equal(aside.reshown, false);
  assert.equal(aside.harnessSessionId, null);
  assert.equal(f.reads.length, 1);
});

test('unbound, invalid binding, and owner-bearer callers cannot report delivery', async (t) => {
  const f = await fixture(t, [message('m1')]);
  for (const headers of [{}, f.owner(), { 'x-agent-binding': 'wrong' }, { ...f.owner(), 'x-agent-binding': '' }]) {
    assert.deepEqual(await f.call(undefined, headers), { status: 401, body: { error: 'missing or invalid agent binding' } });
  }
  assert.equal(f.reads.length, 0);
  assert.deepEqual(readAsides(SOUL, f).asides, []);
});

test('mailbox scope and recipient checks prevent reporting another soul\'s messages', async (t) => {
  const f = await fixture(t, [message('other-mailbox', { mailbox: PEER, to: { account: 'acct', agentId: PEER } }),
    message('wrong-recipient', { to: { account: 'acct', agentId: PEER } }),
    message('no-recipient', { to: null }), message('m1')]);
  assert.deepEqual(await f.call({ messageIds: ['other-mailbox', 'wrong-recipient', 'no-recipient', 'missing', 'm1'], via: 'inbox-read' }), {
    status: 200, body: { recorded: ['m1'], skipped: [
      { id: 'other-mailbox', reason: 'not-in-mailbox' }, { id: 'wrong-recipient', reason: 'not-addressed-to-soul' },
      { id: 'no-recipient', reason: 'not-addressed-to-soul' }, { id: 'missing', reason: 'not-in-mailbox' },
    ] },
  });
  const peerSecret = f.bind(PEER);
  assert.deepEqual(await f.call({ messageIds: ['other-mailbox'], via: 'inbox-read' }, { 'x-agent-binding': peerSecret }),
    { status: 200, body: { recorded: ['other-mailbox'], skipped: [] } });
  assert.deepEqual(readAsides(SOUL, f).asides.map((a) => a.messageId), ['m1']);
  assert.deepEqual(readAsides(PEER, f).asides.map((a) => a.messageId), ['other-mailbox']);
});

test('bad delivery bodies fail before broker access', async (t) => {
  const f = await fixture(t);
  for (const body of ['{bad', 'null', '[]', {}, { messageIds: [], via: 'inbox-read' },
    { messageIds: ['m1', 'm1'], via: 'inbox-read' }, { messageIds: Array.from({ length: 201 }, (_, n) => `m${n}`), via: 'inbox-read' },
    ...[null, 5, '', ' '].map((id) => ({ messageIds: [id], via: 'inbox-read' })),
    ...['relay-prompt', 'thread-context', undefined].map((via) => ({ messageIds: ['m1'], via })),
    ...[null, 4, '', ' '].map((harnessSessionId) => ({ messageIds: ['m1'], via: 'inbox-read', harnessSessionId }))]) {
    assert.equal((await f.call(body)).status, 400, JSON.stringify(body));
  }
  assert.equal(f.reads.length, 0);
});

test('200 IDs are accepted; broker failures disclose no details or asides', async (t) => {
  const f = await fixture(t);
  const ids = Array.from({ length: 200 }, (_, n) => `m${n}`);
  const result = await f.call({ messageIds: ids, via: 'inbox-read' });
  assert.equal(result.status, 200);
  assert.equal(result.body.skipped.length, 200);
  f.fail();
  assert.deepEqual(await f.call(), { status: 502, body: { error: 'could not read soul mailbox' } });
  assert.deepEqual(readAsides(SOUL, f).asides, []);
});

test('malformed broker messages are skipped without blocking valid IDs', async (t) => {
  const f = await fixture(t, [message('bad-sender', { from: null }), message('bad-body', { body: null }), message('m1')]);
  const result = await f.call({ messageIds: ['bad-sender', 'bad-body', 'm1'], via: 'inbox-read' });
  assert.deepEqual(result.body, { recorded: ['m1'], skipped: [
    { id: 'bad-sender', reason: 'invalid-message' }, { id: 'bad-body', reason: 'invalid-message' },
  ] });
});

test('cold-wake delivery deduplicates, while reshown thread context does not consume live delivery', async (t) => {
  const f = await fixture(t, [message('cold'), message('reshown')]);
  recordAside(SOUL, { via: 'relay-prompt', dir: 'in', messageId: 'cold', body: 'cold' }, f);
  recordAside(SOUL, { via: 'thread-context', dir: 'in', messageId: 'reshown', body: 'context' }, f);
  const result = await f.call({ messageIds: ['cold', 'reshown'], via: 'inbox-read' });
  assert.deepEqual(result.body, { recorded: ['reshown'], skipped: [{ id: 'cold', reason: 'already-recorded' }] });
});
