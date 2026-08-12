import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { createDaemonServer } from '../agent-daemon.mjs';
import { getInvocation, interactionHome } from '../agent-jobs.mjs';
import {
  authorizeSouls,
  bindTransport,
  enrollPrincipal,
  setDefaultSoul,
  setOperations,
} from '../agent-principals.mjs';
import { upsertSoul } from '../agent-population.mjs';
import {
  NO_ACTIVE_INVOCATION,
  NO_SOUL_SELECTED,
  REFUSAL_ATTACHMENT,
  REFUSAL_CONTROL,
  REFUSAL_NOT_ENROLLED,
  REFUSAL_OVERSIZE,
  REFUSAL_SOUL,
  botTokenConfigured,
  createTelegramAdapter,
  redactBotToken,
  resolveBotToken,
  telegramStateFile,
} from '../telegram-adapter.mjs';

const AGENT_ID = 'agent_11111111-1111-4111-8111-111111111111';
const OTHER_ID = 'agent_22222222-2222-4222-8222-222222222222';
const TOKEN = '123456:TEsT-Telegram-Token-00000001';
const OWNER_TELEGRAM_ID = 424242;
const CHAT_ID = 700100;

const roots = [];
after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

function scratch() {
  const root = mkdtempSync(path.join(tmpdir(), 'telegram-adapter-'));
  roots.push(root);
  const env = {
    XDG_STATE_HOME: path.join(root, 'state'),
    AGENT_BOT_POPULATION_PATH: path.join(root, 'population.json'),
    AGENT_BOT_PRINCIPALS_PATH: path.join(root, 'principals.json'),
    AGENT_BOT_INTERACTION_HOME: path.join(root, 'interaction'),
    AGENT_BOT_DAEMON_STATE_PATH: path.join(root, 'daemon.json'),
    AGENT_BOT_TELEGRAM_STATE_PATH: path.join(root, 'telegram-state.json'),
  };
  return { root, env };
}

function seedSoul(env, { id = AGENT_ID, status = 'active' } = {}) {
  return upsertSoul({
    id,
    appSlug: 'you-codex-agent',
    parentId: null,
    status,
    spacePath: `/spaces/${id}`,
    transcriptLocator: null,
    lastSeen: '2026-08-12T08:00:00.000Z',
  }, { file: env.AGENT_BOT_POPULATION_PATH });
}

function seedPrincipal(env, {
  souls = [AGENT_ID],
  operations = ['message', 'observe', 'cancel'],
  providerId = String(OWNER_TELEGRAM_ID),
  defaultSoul = null,
} = {}) {
  const options = { file: env.AGENT_BOT_PRINCIPALS_PATH, env, home: '/nonexistent' };
  const principal = enrollPrincipal({ label: 'owner' }, options);
  bindTransport(principal.principalId, { transport: 'telegram', providerId }, options);
  if (souls.length > 0) authorizeSouls(principal.principalId, souls, options);
  let updated = setOperations(principal.principalId, operations, options);
  if (defaultSoul) updated = setDefaultSoul(principal.principalId, defaultSoul, options);
  return updated;
}

async function readAll(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

// Local mock of the Telegram Bot API: queued getUpdates batches, scripted
// one-shot failures, and persistent failures per method.
async function startMockBotApi(token = TOKEN) {
  const calls = { getUpdates: [], sendMessage: [], editMessageText: [] };
  const batches = [];
  const scripted = { getUpdates: [], sendMessage: [], editMessageText: [] };
  const persistentFailures = {};
  let nextMessageId = 9000;
  const server = createServer(async (req, res) => {
    let body = {};
    try {
      body = JSON.parse((await readAll(req)) || '{}');
    } catch {
      body = {};
    }
    const respond = (status, payload) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(payload));
    };
    const match = (req.url ?? '').match(/^\/bot([^/]+)\/([A-Za-z]+)$/);
    if (!match || match[1] !== token || !(match[2] in calls)) {
      respond(404, { ok: false, error_code: 404 });
      return;
    }
    const method = match[2];
    calls[method].push(body);
    const failure = scripted[method].shift() ?? persistentFailures[method];
    if (failure) {
      respond(failure.status, failure.body ?? { ok: false, error_code: failure.status });
      return;
    }
    if (method === 'getUpdates') {
      respond(200, { ok: true, result: batches.shift() ?? [] });
      return;
    }
    if (method === 'sendMessage') {
      respond(200, { ok: true, result: { message_id: nextMessageId++, chat: { id: body.chat_id } } });
      return;
    }
    respond(200, { ok: true, result: true });
  });
  await new Promise((resolve) => { server.listen(0, '127.0.0.1', resolve); });
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    calls,
    batches,
    scripted,
    persistentFailures,
    close: () => new Promise((resolve) => { server.close(resolve); }),
  };
}

// A real in-process daemon over the real stores; the daemonClient inside the
// adapter reads this state file exactly like production.
async function withDaemon(env, executor, run) {
  const server = createDaemonServer({ env, home: '/nonexistent', config: {}, executor });
  await new Promise((resolve) => { server.listen(0, '127.0.0.1', resolve); });
  writeFileSync(env.AGENT_BOT_DAEMON_STATE_PATH, `${JSON.stringify({
    schemaVersion: 1,
    pid: process.pid,
    port: server.address().port,
    token: server.token,
    startedAt: new Date().toISOString(),
  })}\n`);
  try {
    await run(server);
  } finally {
    await new Promise((resolve) => { server.close(resolve); });
  }
}

const quickExecutor = async ({ appendEvent }) => { appendEvent('progress', { step: 1 }); };
const slowExecutor = ({ signal }) => new Promise((resolve, reject) => {
  const timer = setTimeout(resolve, 30_000);
  signal.addEventListener('abort', () => {
    clearTimeout(timer);
    reject(new Error('aborted'));
  });
});

function makeAdapter(env, mock, overrides = {}) {
  const sleeps = [];
  const stderrChunks = [];
  const adapter = createTelegramAdapter({
    env,
    home: '/nonexistent',
    config: {},
    token: TOKEN,
    baseUrl: mock.url,
    longPollSeconds: 0,
    projectionIntervalMs: 2,
    sleep: async (ms) => { sleeps.push(ms); },
    stderr: { write: (chunk) => { stderrChunks.push(String(chunk)); return true; } },
    ...overrides,
  });
  return { adapter, sleeps, stderrText: () => stderrChunks.join('') };
}

function textUpdate(updateId, text, {
  chatId = CHAT_ID,
  fromId = OWNER_TELEGRAM_ID,
  chatType = 'private',
  username = 'owner',
} = {}) {
  return {
    update_id: updateId,
    message: {
      message_id: updateId,
      chat: { id: chatId, type: chatType },
      from: { id: fromId, username },
      text,
    },
  };
}

function invocations(env) {
  const file = path.join(env.AGENT_BOT_INTERACTION_HOME, 'jobs.json');
  if (!existsSync(file)) return [];
  return Object.values(JSON.parse(readFileSync(file, 'utf8')).invocations);
}

function sentTexts(mock) {
  return mock.calls.sendMessage.map((call) => call.text);
}

async function waitFor(probe, { timeoutMs = 5_000, intervalMs = 10 } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await probe();
    if (value) return value;
    if (Date.now() >= deadline) throw new Error('condition not reached in time');
    await new Promise((resolve) => { setTimeout(resolve, intervalMs); });
  }
}

test('state file path and token resolution follow the reviewed paths only', () => {
  assert.equal(
    telegramStateFile({ env: { AGENT_BOT_TELEGRAM_STATE_PATH: '/tmp/tg.json' } }),
    '/tmp/tg.json',
  );
  assert.equal(
    telegramStateFile({ env: { XDG_STATE_HOME: '/tmp/state' }, home: '/home/test' }),
    '/tmp/state/agent-bot/telegram/state.json',
  );
  assert.equal(
    telegramStateFile({ env: {}, home: '/home/test' }),
    '/home/test/.local/state/agent-bot/telegram/state.json',
  );

  assert.equal(resolveBotToken({ env: { AGENT_BOT_TELEGRAM_TOKEN: TOKEN }, config: {} }), TOKEN);
  assert.throws(
    () => resolveBotToken({ env: { AGENT_BOT_TELEGRAM_TOKEN: 'not a telegram token' }, config: {} }),
    /unsupported shape/,
  );
  assert.throws(() => resolveBotToken({ env: {}, config: {} }), /no Telegram bot token/);
  // The secure-store flow goes through the injected reader; the selector
  // itself never carries the secret.
  const selector = { provider: 'proton-pass', collection: 'Agents', item: 'bot', field: 'token' };
  const config = { settings: { telegram: { tokenSecret: selector } } };
  const seen = [];
  const resolved = resolveBotToken({
    env: {},
    config,
    secretReader: (wanted) => { seen.push(wanted); return TOKEN; },
  });
  assert.equal(resolved, TOKEN);
  assert.deepEqual(seen, [selector]);
  // Configuration probing never reads the secret.
  assert.equal(botTokenConfigured({ env: {}, config }), true);
  assert.equal(botTokenConfigured({ env: {}, config: {} }), false);

  assert.equal(redactBotToken(`oops ${TOKEN} in a URL`, TOKEN).includes(TOKEN), false);
  assert.match(redactBotToken(`oops ${TOKEN}`, TOKEN), /\[redacted-bot-token\]/);
});

test('authorized end-to-end: text update becomes a daemon invocation and a projected completion', async () => {
  const { env } = scratch();
  seedSoul(env);
  seedPrincipal(env, { defaultSoul: AGENT_ID });
  const mock = await startMockBotApi();
  try {
    await withDaemon(env, quickExecutor, async () => {
      const { adapter } = makeAdapter(env, mock);
      mock.batches.push([textUpdate(500, 'hello soul')]);
      await adapter.pollOnce();
      await adapter.drain();

      const jobs = invocations(env);
      assert.equal(jobs.length, 1);
      assert.equal(jobs[0].status, 'completed');
      assert.equal(jobs[0].agentId, AGENT_ID);
      assert.equal(jobs[0].idempotencyKey, 'telegram:500');
      assert.equal(adapter.offset, 501);

      // One status message, then edits that land on the terminal status.
      assert.ok(mock.calls.sendMessage.length >= 1);
      const finalEdit = mock.calls.editMessageText.at(-1);
      assert.match(finalEdit.text, /completed/);
      assert.match(finalEdit.text, new RegExp(jobs[0].invocationId));

      // /status projects the same daemon record on demand.
      mock.batches.push([textUpdate(501, '/status')]);
      await adapter.pollOnce();
      await adapter.drain();
      assert.match(sentTexts(mock).at(-1), /completed/);

      // A second message reuses the same daemon session for this
      // (principal, soul) pair.
      mock.batches.push([textUpdate(502, 'hello again')]);
      await adapter.pollOnce();
      await adapter.drain();
      const twice = invocations(env);
      assert.equal(twice.length, 2);
      assert.equal(new Set(twice.map((job) => job.sessionId)).size, 1);

      // The adapter state file holds only projection state.
      const state = JSON.parse(readFileSync(env.AGENT_BOT_TELEGRAM_STATE_PATH, 'utf8'));
      assert.equal(state.offset, 503);
      assert.equal(Object.keys(state.sessions).length, 1);
    });
  } finally {
    await mock.close();
  }
});

test('unauthorized senders are refused before any job exists; only the immutable ID matters', async () => {
  const { env } = scratch();
  seedSoul(env);
  seedPrincipal(env, { defaultSoul: AGENT_ID });
  const mock = await startMockBotApi();
  try {
    await withDaemon(env, quickExecutor, async () => {
      const { adapter } = makeAdapter(env, mock);
      // Same username as the owner, different immutable ID: refused.
      mock.batches.push([textUpdate(600, 'let me in', { fromId: 777, username: 'owner' })]);
      await adapter.pollOnce();
      await adapter.drain();
      assert.equal(sentTexts(mock).at(-1), REFUSAL_NOT_ENROLLED);
      assert.equal(invocations(env).length, 0);
      const audit = readFileSync(
        path.join(interactionHome({ env, home: '/nonexistent' }), 'audit.jsonl'),
        'utf8',
      );
      assert.match(audit, /"event":"denied-request"/);
      assert.equal(audit.includes('777'), false);
      assert.equal(audit.includes('owner'), false);

      // Changed username on the enrolled ID: still authorized.
      mock.batches.push([textUpdate(601, 'hello', { username: 'freshly-renamed' })]);
      await adapter.pollOnce();
      await adapter.drain();
      assert.equal(invocations(env).length, 1);
      assert.equal(invocations(env)[0].status, 'completed');
    });
  } finally {
    await mock.close();
  }
});

test('duplicate update_id maps to one idempotency key and one invocation', async () => {
  const { env } = scratch();
  seedSoul(env);
  seedPrincipal(env, { defaultSoul: AGENT_ID });
  const mock = await startMockBotApi();
  try {
    await withDaemon(env, quickExecutor, async () => {
      const { adapter } = makeAdapter(env, mock);
      const update = textUpdate(700, 'do the thing');
      mock.batches.push([update]);
      await adapter.pollOnce();
      await adapter.drain();
      // Telegram replays the same update (e.g. an unacknowledged batch).
      mock.batches.push([update]);
      await adapter.pollOnce();
      await adapter.drain();

      const jobs = invocations(env);
      assert.equal(jobs.length, 1);
      assert.equal(jobs[0].idempotencyKey, 'telegram:700');
      assert.match(sentTexts(mock).at(-1), /already submitted/);
    });
  } finally {
    await mock.close();
  }
});

test('restart resumes from the persisted offset and daemon state is intact', async () => {
  const { env } = scratch();
  seedSoul(env);
  seedPrincipal(env, { defaultSoul: AGENT_ID });
  const mock = await startMockBotApi();
  try {
    let invocationId;
    await withDaemon(env, quickExecutor, async () => {
      const { adapter } = makeAdapter(env, mock);
      mock.batches.push([textUpdate(800, 'before restart')]);
      await adapter.pollOnce();
      await adapter.drain();
      invocationId = invocations(env)[0].invocationId;
    });

    // A fresh adapter (new process, same state path) resumes at 801 and the
    // daemon record survives untouched.
    await withDaemon(env, quickExecutor, async () => {
      const { adapter } = makeAdapter(env, mock);
      mock.batches.push([]);
      await adapter.pollOnce();
      assert.equal(mock.calls.getUpdates.at(-1).offset, 801);
      const survived = getInvocation(invocationId, { env, home: '/nonexistent' });
      assert.equal(survived.status, 'completed');
    });
  } finally {
    await mock.close();
  }
});

test('telegram 429 rate limiting is honored with the reported retry_after', async () => {
  const { env } = scratch();
  seedSoul(env);
  const mock = await startMockBotApi();
  try {
    await withDaemon(env, quickExecutor, async () => {
      const { adapter, sleeps } = makeAdapter(env, mock);
      mock.scripted.sendMessage.push({
        status: 429,
        body: { ok: false, error_code: 429, parameters: { retry_after: 2 } },
      });
      mock.batches.push([textUpdate(900, 'hi', { fromId: 31337 })]);
      await adapter.pollOnce();
      await adapter.drain();
      // The refusal reply was retried after the hinted 2 seconds.
      assert.ok(sleeps.includes(2000));
      assert.equal(mock.calls.sendMessage.length, 2);
      assert.equal(sentTexts(mock).at(-1), REFUSAL_NOT_ENROLLED);
    });
  } finally {
    await mock.close();
  }
});

test('failed sends never lose daemon-owned state', async () => {
  const { env } = scratch();
  seedSoul(env);
  seedPrincipal(env, { defaultSoul: AGENT_ID });
  const mock = await startMockBotApi();
  try {
    await withDaemon(env, quickExecutor, async () => {
      const { adapter, stderrText } = makeAdapter(env, mock);
      mock.persistentFailures.sendMessage = { status: 500 };
      mock.persistentFailures.editMessageText = { status: 500 };
      mock.batches.push([textUpdate(1000, 'send failures ahead')]);
      await adapter.pollOnce();
      await adapter.drain();

      const jobs = invocations(env);
      assert.equal(jobs.length, 1);
      assert.equal(jobs[0].status, 'completed');
      assert.equal(adapter.offset, 1001);
      assert.match(stderrText(), /sendMessage failed \(daemon state unaffected\)/);
    });
  } finally {
    await mock.close();
  }
});

test('/cancel cancels the active invocation through the daemon', async () => {
  const { env } = scratch();
  seedSoul(env);
  seedPrincipal(env, { defaultSoul: AGENT_ID });
  const mock = await startMockBotApi();
  try {
    await withDaemon(env, slowExecutor, async () => {
      const { adapter } = makeAdapter(env, mock);
      mock.batches.push([textUpdate(1100, 'long task')]);
      await adapter.pollOnce();
      await waitFor(() => invocations(env)[0]?.status === 'running');

      mock.batches.push([textUpdate(1101, '/cancel')]);
      await adapter.pollOnce();
      await adapter.drain();

      const job = invocations(env)[0];
      assert.equal(job.status, 'cancelled');
      assert.match(sentTexts(mock).join('\n'), new RegExp(`${job.invocationId}: cancelled`));
    });
  } finally {
    await mock.close();
  }
});

test('/souls and /use expose only the principal ACL; unauthorized souls are refused', async () => {
  const { env } = scratch();
  seedSoul(env);
  seedSoul(env, { id: OTHER_ID });
  seedPrincipal(env, { souls: [AGENT_ID] });
  const mock = await startMockBotApi();
  try {
    await withDaemon(env, quickExecutor, async () => {
      const { adapter } = makeAdapter(env, mock);
      mock.batches.push([textUpdate(1200, '/souls')]);
      await adapter.pollOnce();
      const listing = sentTexts(mock).at(-1);
      assert.match(listing, new RegExp(AGENT_ID));
      assert.equal(listing.includes(OTHER_ID), false);

      // Unauthorized soul: refused, and no selection is recorded.
      mock.batches.push([textUpdate(1201, `/use ${OTHER_ID}`)]);
      await adapter.pollOnce();
      assert.equal(sentTexts(mock).at(-1), REFUSAL_SOUL);
      mock.batches.push([textUpdate(1202, 'talk to the wrong soul')]);
      await adapter.pollOnce();
      await adapter.drain();
      assert.equal(sentTexts(mock).at(-1), NO_SOUL_SELECTED);
      assert.equal(invocations(env).length, 0);

      // Authorized soul: selected and messaged.
      mock.batches.push([textUpdate(1203, `/use ${AGENT_ID}`)]);
      await adapter.pollOnce();
      assert.match(sentTexts(mock).at(-1), new RegExp(`Selected soul ${AGENT_ID}`));
      mock.batches.push([textUpdate(1204, 'now talk')]);
      await adapter.pollOnce();
      await adapter.drain();
      const jobs = invocations(env);
      assert.equal(jobs.length, 1);
      assert.equal(jobs[0].agentId, AGENT_ID);
    });
  } finally {
    await mock.close();
  }
});

test('attachments and hostile filenames are refused with a static message', async () => {
  const { env } = scratch();
  seedSoul(env);
  seedPrincipal(env, { defaultSoul: AGENT_ID });
  const mock = await startMockBotApi();
  try {
    await withDaemon(env, quickExecutor, async () => {
      const { adapter } = makeAdapter(env, mock);
      mock.batches.push([{
        update_id: 1300,
        message: {
          message_id: 1300,
          chat: { id: CHAT_ID, type: 'private' },
          from: { id: OWNER_TELEGRAM_ID },
          document: { file_id: 'abc123', file_name: '../../../etc/passwd' },
          caption: 'run this',
        },
      }]);
      await adapter.pollOnce();
      await adapter.drain();
      const reply = sentTexts(mock).at(-1);
      assert.equal(reply, REFUSAL_ATTACHMENT);
      // The hostile filename is never reflected or interpreted.
      assert.equal(reply.includes('passwd'), false);
      assert.equal(invocations(env).length, 0);
      assert.equal(adapter.offset, 1301);
    });
  } finally {
    await mock.close();
  }
});

test('oversized and control-character messages are politely refused', async () => {
  const { env } = scratch();
  seedSoul(env);
  seedPrincipal(env, { defaultSoul: AGENT_ID });
  const mock = await startMockBotApi();
  try {
    await withDaemon(env, quickExecutor, async () => {
      const { adapter } = makeAdapter(env, mock);
      mock.batches.push([
        textUpdate(1400, 'x'.repeat(33 * 1024)),
        textUpdate(1401, 'bell\x07noise'),
      ]);
      await adapter.pollOnce();
      await adapter.drain();
      const texts = sentTexts(mock);
      assert.equal(texts.at(-2), REFUSAL_OVERSIZE);
      assert.equal(texts.at(-1), REFUSAL_CONTROL);
      assert.equal(invocations(env).length, 0);
    });
  } finally {
    await mock.close();
  }
});

test('malformed updates are skipped with a note and the offset still advances', async () => {
  const { env } = scratch();
  seedSoul(env);
  seedPrincipal(env, { defaultSoul: AGENT_ID });
  const mock = await startMockBotApi();
  try {
    await withDaemon(env, quickExecutor, async () => {
      const { adapter, stderrText } = makeAdapter(env, mock);
      mock.batches.push([
        42,
        { update_id: 7 },
        { update_id: 8, message: { chat: { id: CHAT_ID }, from: { id: OWNER_TELEGRAM_ID } } },
        textUpdate(9, '/status'),
      ]);
      await adapter.pollOnce();
      await adapter.drain();
      assert.equal(adapter.offset, 10);
      assert.match(stderrText(), /no update_id/);
      assert.match(stderrText(), /no message/);
      assert.match(stderrText(), /missing chat or sender/);
      assert.equal(sentTexts(mock).at(-1), NO_ACTIVE_INVOCATION);
      assert.equal(invocations(env).length, 0);
    });
  } finally {
    await mock.close();
  }
});

test('group chats are silently ignored unless the reviewed opt-in is set', async () => {
  const { env } = scratch();
  seedSoul(env);
  seedPrincipal(env, { defaultSoul: AGENT_ID });
  const mock = await startMockBotApi();
  try {
    await withDaemon(env, quickExecutor, async () => {
      const { adapter } = makeAdapter(env, mock);
      mock.batches.push([textUpdate(1500, 'hello from a group', { chatType: 'group', chatId: -1500 })]);
      await adapter.pollOnce();
      await adapter.drain();
      assert.equal(mock.calls.sendMessage.length, 0);
      assert.equal(invocations(env).length, 0);
      assert.equal(adapter.offset, 1501);

      // Explicit opt-in makes group updates first-class.
      const groupEnv = { ...env, AGENT_BOT_TELEGRAM_ALLOW_GROUPS: '1' };
      const { adapter: groupAdapter } = makeAdapter(groupEnv, mock);
      mock.batches.push([textUpdate(1501, 'hello again', { chatType: 'group', chatId: -1500 })]);
      await groupAdapter.pollOnce();
      await groupAdapter.drain();
      assert.equal(invocations(env).length, 1);
    });
  } finally {
    await mock.close();
  }
});

test('the bot token never reaches state files, stores, logs, or error text', async () => {
  const { env } = scratch();
  seedSoul(env);
  seedPrincipal(env, { defaultSoul: AGENT_ID });
  const mock = await startMockBotApi();
  try {
    await withDaemon(env, quickExecutor, async () => {
      // A hostile lower layer plants the token inside an error message.
      let planted = false;
      const fetchImpl = async (url, init) => {
        if (!planted) {
          planted = true;
          throw new Error(`connect failed: ${TOKEN} at ${url}`);
        }
        return fetch(url, init);
      };
      const { adapter, stderrText } = makeAdapter(env, mock, { fetchImpl });
      await adapter.pollOnce(); // fails; must log redacted
      mock.batches.push([textUpdate(1600, 'full round trip')]);
      await adapter.pollOnce();
      await adapter.drain();
      assert.equal(invocations(env)[0].status, 'completed');

      const logs = stderrText();
      assert.match(logs, /\[redacted-bot-token\]/);
      assert.equal(logs.includes(TOKEN), false);

      const artifacts = [
        env.AGENT_BOT_TELEGRAM_STATE_PATH,
        path.join(env.AGENT_BOT_INTERACTION_HOME, 'jobs.json'),
        path.join(env.AGENT_BOT_INTERACTION_HOME, 'sessions.json'),
        path.join(env.AGENT_BOT_INTERACTION_HOME, 'audit.jsonl'),
        env.AGENT_BOT_PRINCIPALS_PATH,
      ];
      for (const file of artifacts) {
        if (!existsSync(file)) continue;
        assert.equal(readFileSync(file, 'utf8').includes(TOKEN), false, `token leaked into ${file}`);
      }
    });
  } finally {
    await mock.close();
  }
});
