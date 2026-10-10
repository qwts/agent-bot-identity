// take_inbox through the daemon (#229): the daemon holds the fleet-wide inbox
// bearer, read from pass-cli, and takes for the App and repository the
// caller's binding is. Callers present only their binding.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { createDaemonServer } from '../agent-daemon.mjs';
import { daemonClient } from '../daemon-client.mjs';
import { ensureAgentIdentity, stateDirectory } from '../agent-identity.mjs';
import { mintBindToken } from '../agent-binding.mjs';
import {
  INBOX_BEARER_TITLE,
  createInboxTaker,
  readInboxBearer,
  resolveInboxBearer,
  takeFromBroker,
} from '../inbox-take.mjs';

const AGENT_ID = 'agent_cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const BEARER = 'inbox-bearer-never-leaks';
const roots = [];

after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

function scratch() {
  const root = mkdtempSync(path.join(tmpdir(), 'inbox-take-'));
  roots.push(root);
  const env = {
    XDG_STATE_HOME: path.join(root, 'state'),
    AGENT_BOT_SPACES_HOME: path.join(root, 'spaces'),
    AGENT_BOT_POPULATION_PATH: path.join(root, 'population.json'),
    AGENT_BOT_DAEMON_STATE_PATH: path.join(root, 'daemon.json'),
    AGENT_BOT_PRINCIPALS_PATH: path.join(root, 'principals.json'),
    AGENT_BOT_INTERACTION_HOME: path.join(root, 'interaction'),
    GH_APP_HOOK_INBOX_URL: 'https://gh-app-hook.example.invalid',
  };
  ensureAgentIdentity({
    gate: () => true,
    appSlug: 'you-codex-agent',
    botUid: '308462948',
    harness: 'codex',
    transcript: { provider: 'codex', id: 'thread-inbox' },
    stateDir: stateDirectory({ env, home: '/nonexistent' }),
    idFactory: () => AGENT_ID,
    now: () => new Date('2026-10-09T08:00:00.000Z'),
  });
  const worktree = path.join(root, 'worktree');
  mkdirSync(worktree, { recursive: true });
  execFileSync('git', ['init', '-q', worktree]);
  execFileSync('git', ['-C', worktree, 'remote', 'add', 'origin', 'https://github.com/qwts/example1.git']);
  // A worktree config naming another App must not steer the take (#229).
  execFileSync('git', ['-C', worktree, 'config', 'extensions.worktreeConfig', 'true']);
  execFileSync('git', ['-C', worktree, 'config', '--worktree', 'agentBot.app', 'someone-elses-app']);
  const gitDir = path.join(worktree, '.git');
  const record = mintBindToken({ gitDir, worktree, agentId: AGENT_ID });
  return { root, env, worktree, gitDir, record };
}

async function withServer(env, options, run) {
  const server = createDaemonServer({
    env, home: '/nonexistent', config: { features: { 'github-identity': true } }, ...options,
  });
  await new Promise((resolve) => { server.listen(0, '127.0.0.1', resolve); });
  const port = server.address().port;
  const call = (pathname, { method = 'GET', body, token = server.token, headers = {} } = {}) =>
    fetch(`http://127.0.0.1:${port}${pathname}`, {
      method,
      headers: {
        ...(token === null ? {} : { authorization: `Bearer ${token}` }),
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        ...headers,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  try {
    await run({ call, server });
  } finally {
    await new Promise((resolve) => { server.close(resolve); });
  }
}

async function bind(call, { gitDir, record }) {
  const res = await call('/v0/bind', {
    method: 'POST',
    body: { gitDir, token: record.token, transcript: { provider: 'codex', id: 'thread-inbox' } },
  });
  assert.equal(res.status, 200);
  return res.json();
}

function receipts(env) {
  return readFileSync(path.join(env.AGENT_BOT_INTERACTION_HOME, 'audit.jsonl'), 'utf8')
    .trim().split('\n').map((line) => JSON.parse(line))
    .filter((receipt) => receipt.event === 'inbox-take');
}

// A broker that hands each record out once, but only if takes do not
// overlap: it reads, yields, then removes. Overlapping takes would both be
// given the head of the queue.
function racyBroker(records) {
  const queue = [...records];
  const seen = [];
  const fetchImpl = async (url, options) => {
    seen.push({ url: new URL(url), authorization: options.headers.authorization });
    const head = queue[0];
    await new Promise((resolve) => { setTimeout(resolve, 20); });
    if (!head) return new Response(null, { status: 204 });
    queue.shift();
    return new Response(JSON.stringify(head), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  return { fetchImpl, seen };
}

function bearerStore(value) {
  const reads = [];
  return {
    reads,
    read(title) {
      reads.push(title);
      if (value instanceof Error) throw value;
      return value;
    },
  };
}

test('the inbox bearer is one named pass-cli note (#229)', () => {
  assert.equal(INBOX_BEARER_TITLE, 'agent-bot.inbox/gh-app-hook-inbox-token');
  const store = bearerStore(`${BEARER}\n`);
  assert.equal(readInboxBearer({ store }), BEARER);
  assert.deepEqual(store.reads, [INBOX_BEARER_TITLE]);
});

test('a missing, empty or unreadable bearer is refused with a stable code and no secret', () => {
  const missing = Object.assign(new Error('pass-cli item not found'), { code: 'missing-item' });
  assert.throws(() => readInboxBearer({ store: bearerStore(missing) }), (error) => {
    assert.equal(error.code, 'inbox-credential-missing');
    assert.match(error.message, /agent-bot\.inbox\/gh-app-hook-inbox-token/);
    return true;
  });
  assert.throws(() => readInboxBearer({ store: bearerStore('  \n') }), { code: 'inbox-credential-missing' });
  const locked = Object.assign(new Error('pass-cli has no session'), { code: 'provider-session-required' });
  assert.throws(() => readInboxBearer({ store: bearerStore(locked) }), (error) => {
    assert.equal(error.code, 'inbox-credential-unavailable');
    assert.match(error.message, /no session/);
    return true;
  });
});

test('an explicit GH_APP_HOOK_INBOX_TOKEN in the daemon env wins over the pass-cli note (#229)', () => {
  let noteReads = 0;
  const readNote = () => { noteReads += 1; return 'from-the-note'; };
  assert.deepEqual(resolveInboxBearer({ env: { GH_APP_HOOK_INBOX_TOKEN: ` ${BEARER}\n` }, readNote }),
    { token: BEARER, source: 'env' });
  assert.equal(noteReads, 0);
  // Unset or blank falls through to the note.
  assert.deepEqual(resolveInboxBearer({ env: {}, readNote }), { token: 'from-the-note', source: 'pass-cli' });
  assert.deepEqual(resolveInboxBearer({ env: { GH_APP_HOOK_INBOX_TOKEN: '  ' }, readNote }), { token: 'from-the-note', source: 'pass-cli' });
  assert.equal(noteReads, 2);
});

test('/v0/inbox/take uses the env bearer, receipts its source and never the value', async () => {
  const fixture = scratch();
  const env = { ...fixture.env, GH_APP_HOOK_INBOX_TOKEN: BEARER };
  const broker = racyBroker([{ app: 'you-codex-agent', repo: 'qwts/example1', kind: 'mention' }]);
  const missing = Object.assign(new Error('pass-cli item not found'), { code: 'missing-item' });
  const inboxTake = createInboxTaker({
    env,
    readBearer: () => resolveInboxBearer({ env, readNote: () => readInboxBearer({ store: bearerStore(missing) }) }),
    fetchImpl: broker.fetchImpl,
  });
  await withServer(env, { inboxTake }, async ({ call }) => {
    const bound = await bind(call, { ...fixture, env });
    const res = await call('/v0/inbox/take', {
      method: 'POST', token: null, body: {}, headers: { 'x-agent-binding': bound.secret },
    });
    assert.equal(res.status, 200);
    assert.doesNotMatch(await res.text(), new RegExp(BEARER));
  });
  assert.equal(broker.seen[0].authorization, `Bearer ${BEARER}`);
  const [receipt] = receipts(env);
  assert.deepEqual([receipt.decision, receipt.reason, receipt.bearerSource], ['taken', 'event', 'env']);
  assert.doesNotMatch(readFileSync(path.join(env.AGENT_BOT_INTERACTION_HOME, 'audit.jsonl'), 'utf8'), new RegExp(BEARER));
});

test('a rejected env bearer names the env variable, not the note, and receipts the source', async () => {
  const take = createInboxTaker({
    env: { GH_APP_HOOK_INBOX_URL: 'https://gh-app-hook.example.invalid', GH_APP_HOOK_INBOX_TOKEN: BEARER },
    fetchImpl: async () => new Response('{}', { status: 401 }),
  });
  await assert.rejects(take({ app: 'you-codex-agent', repo: 'qwts/example1' }), (error) => {
    assert.equal(error.code, 'inbox-auth-expired');
    assert.equal(error.bearerSource, 'env');
    assert.match(error.message, /GH_APP_HOOK_INBOX_TOKEN/);
    assert.doesNotMatch(error.message, new RegExp(BEARER));
    return true;
  });
});

test('/v0/inbox/take refuses a caller with no live binding and receipts it', async () => {
  const { env } = scratch();
  let takes = 0;
  await withServer(env, { inboxTake: async () => { takes += 1; return { event: null }; } }, async ({ call }) => {
    const none = await call('/v0/inbox/take', { method: 'POST', body: {}, token: null });
    assert.equal(none.status, 401);
    const forged = await call('/v0/inbox/take', {
      method: 'POST', body: {}, token: null, headers: { 'x-agent-binding': 'x'.repeat(43) },
    });
    assert.equal(forged.status, 401);
    // The daemon's own bearer is not a binding either.
    const bearerOnly = await call('/v0/inbox/take', { method: 'POST', body: {} });
    assert.equal(bearerOnly.status, 401);
  });
  assert.equal(takes, 0);
  assert.deepEqual(receipts(env).map((receipt) => [receipt.decision, receipt.reason]),
    [['denied', 'no-live-binding'], ['denied', 'no-live-binding'], ['denied', 'no-live-binding']]);
});

test('/v0/inbox/take takes for the bound soul\'s App and worktree, never the request', async () => {
  const fixture = scratch();
  const { env } = fixture;
  const broker = racyBroker([{ app: 'you-codex-agent', repo: 'qwts/example1', kind: 'mention' }]);
  const inboxTake = createInboxTaker({ env, readBearer: () => BEARER, fetchImpl: broker.fetchImpl });
  await withServer(env, { inboxTake }, async ({ call }) => {
    const bound = await bind(call, fixture);
    const res = await call('/v0/inbox/take', {
      method: 'POST',
      token: null,
      body: { app: 'someone-elses-app', repo: 'qwts/other' },
      headers: { 'x-agent-binding': bound.secret },
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.event.kind, 'mention');
    assert.doesNotMatch(JSON.stringify(body), new RegExp(BEARER));
  });
  assert.equal(broker.seen.length, 1);
  assert.equal(broker.seen[0].url.pathname, '/inbox');
  assert.equal(broker.seen[0].url.searchParams.get('app'), 'you-codex-agent');
  assert.equal(broker.seen[0].url.searchParams.get('repo'), 'qwts/example1');
  assert.equal(broker.seen[0].authorization, `Bearer ${BEARER}`);
  const [receipt] = receipts(env);
  assert.deepEqual([receipt.decision, receipt.agentId, receipt.appSlug, receipt.reason, receipt.bearerSource],
    ['taken', AGENT_ID, 'you-codex-agent', 'event', 'pass-cli']);
  assert.doesNotMatch(readFileSync(path.join(env.AGENT_BOT_INTERACTION_HOME, 'audit.jsonl'), 'utf8'), new RegExp(BEARER));
});

test('a missing bearer is refused with inbox-credential-missing before the broker is called', async () => {
  const fixture = scratch();
  const { env } = fixture;
  const broker = racyBroker([{ kind: 'mention' }]);
  const missing = Object.assign(new Error('pass-cli item not found'), { code: 'missing-item' });
  const inboxTake = createInboxTaker({
    env, readBearer: () => readInboxBearer({ store: bearerStore(missing) }), fetchImpl: broker.fetchImpl,
  });
  await withServer(env, { inboxTake }, async ({ call }) => {
    const bound = await bind(call, fixture);
    const res = await call('/v0/inbox/take', {
      method: 'POST', token: null, body: {}, headers: { 'x-agent-binding': bound.secret },
    });
    assert.equal(res.status, 503);
    const body = await res.json();
    assert.equal(body.code, 'inbox-credential-missing');
    assert.match(body.error, /agent-bot\.inbox\/gh-app-hook-inbox-token/);
  });
  assert.equal(broker.seen.length, 0);
  assert.deepEqual(receipts(env).map((receipt) => [receipt.decision, receipt.reason]),
    [['failed', 'inbox-credential-missing']]);
});

test('a daemon with no inbox URL refuses before reading the bearer', async () => {
  let reads = 0;
  const take = createInboxTaker({ env: {}, readBearer: () => { reads += 1; return BEARER; }, fetchImpl: async () => { throw new Error('no call'); } });
  await assert.rejects(take({ app: 'you-codex-agent', repo: 'qwts/example1' }), { code: 'inbox-not-configured' });
  assert.equal(reads, 0);
});

test('each record is taken exactly once, even by concurrent takes on a broker that does not serialize', async () => {
  const fixture = scratch();
  const { env } = fixture;
  const broker = racyBroker([{ id: 'one' }, { id: 'two' }]);
  const inboxTake = createInboxTaker({ env, readBearer: () => BEARER, fetchImpl: broker.fetchImpl });
  await withServer(env, { inboxTake }, async ({ call }) => {
    const bound = await bind(call, fixture);
    const take = async () => (await call('/v0/inbox/take', {
      method: 'POST', token: null, body: {}, headers: { 'x-agent-binding': bound.secret },
    })).json();
    const results = await Promise.all([take(), take(), take()]);
    const ids = results.map((result) => result.event?.id ?? null).sort();
    assert.deepEqual(ids, [null, 'one', 'two'].sort());
  });
  assert.equal(broker.seen.length, 3);
});

test('the daemon client carries an inbox code and the daemon\'s own sentence', async () => {
  const fixture = scratch();
  const { env, worktree } = fixture;
  const broker = { fetchImpl: async () => new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401 }) };
  const inboxTake = createInboxTaker({ env, readBearer: () => BEARER, fetchImpl: broker.fetchImpl });
  await withServer(env, { inboxTake }, async ({ call }) => {
    const bound = await bind(call, fixture);
    // The worktree's binding file names this daemon; the client signs a
    // proof from it and never sends the secret itself.
    const client = daemonClient({ env, home: '/nonexistent', cwd: worktree });
    await assert.rejects(client.takeInbox(bound.secret), (error) => {
      assert.equal(error.code, 'inbox-auth-expired');
      assert.match(error.detail, /HTTP 401/);
      assert.match(error.detail, /agent-bot\.inbox\/gh-app-hook-inbox-token/);
      assert.doesNotMatch(error.detail, new RegExp(BEARER));
      return true;
    });
  });
});

// The broker mapping kept from #299, now run in the daemon.
test('#299: an unreachable broker names its host and cause, never the bearer', async () => {
  const cause = Object.assign(new Error(`connect ECONNREFUSED 127.0.0.1:1 ${BEARER}`), { code: 'ECONNREFUSED' });
  await assert.rejects(takeFromBroker({
    inboxUrl: 'https://gh-app-hook.example.invalid', token: BEARER, app: 'a', repo: 'o/r',
    fetchImpl: async () => { throw Object.assign(new Error('fetch failed'), { cause }); },
  }), (error) => {
    assert.equal(error.code, 'inbox-broker-unreachable');
    assert.match(error.message, /gh-app-hook\.example\.invalid/);
    assert.match(error.message, /ECONNREFUSED/);
    assert.doesNotMatch(error.message, new RegExp(BEARER));
    return true;
  });
});

test('#299: a take carries a timeout so a hung broker cannot stall the daemon', async () => {
  let signal = null;
  const result = await takeFromBroker({
    inboxUrl: 'https://gh-app-hook.example.invalid', token: BEARER, app: 'a', repo: 'o/r',
    fetchImpl: async (url, options) => { signal = options.signal; return new Response(null, { status: 204 }); },
  });
  assert.deepEqual(result, { event: null });
  assert.ok(signal, 'fetch must receive an AbortSignal timeout');
});

test('#299: 401 and an unreadable body map to stable codes, never the bearer', async () => {
  const base = { inboxUrl: 'https://gh-app-hook.example.invalid', token: BEARER, app: 'a', repo: 'o/r' };
  await assert.rejects(takeFromBroker({ ...base, fetchImpl: async () => new Response('{}', { status: 401 }) }), (error) => {
    assert.equal(error.code, 'inbox-auth-expired');
    assert.doesNotMatch(error.message, new RegExp(BEARER));
    return true;
  });
  await assert.rejects(takeFromBroker({
    ...base, fetchImpl: async () => new Response('{not json', { status: 200, headers: { 'content-type': 'application/json' } }),
  }), (error) => {
    assert.equal(error.code, 'inbox-unavailable');
    assert.match(error.message, /unreadable response/);
    return true;
  });
  await assert.rejects(takeFromBroker({ ...base, inboxUrl: 'ftp://inbox.example.invalid', fetchImpl: async () => { throw new Error('no call'); } }),
    { code: 'inbox-not-configured' });
});
