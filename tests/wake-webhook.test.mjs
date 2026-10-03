import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { coldWakeCommand, readColdWakeSettings, setColdWake, wakeSetting } from '../cold-wake-settings.mjs';
import { createColdWaker } from '../cold-wake.mjs';
import { checkWebhook, createWebhookWaker, readWebhook, saveWebhook, webhookAsk, webhookFile } from '../wake-webhook.mjs';

const ID = 'agent_33433433-3343-4343-8343-334334334334';
const cli = fileURLToPath(new URL('../agent-bot.mjs', import.meta.url));
const URL_WITH_TOKEN = 'https://hooks.example.com/routines/r-123/secret-path-token';
const KEY = 'whk_abcdef0123456789';

async function withState(run) {
  const root = mkdtempSync(path.join(tmpdir(), 'wake-webhook-'));
  const env = { ...process.env, XDG_STATE_HOME: path.join(root, 'state'), HOME: root, GIT_CONFIG_COUNT: '0', GH_AGENT_APP: '' };
  try { return await run({ root, env }); } finally { rmSync(root, { recursive: true, force: true }); }
}

test('a webhook must be https, carry no URL credentials, and have a one-line key; errors never echo values', () => {
  const cases = [
    [{ url: 'http://hooks.example.com/x', key: KEY }, /must use https/],
    [{ url: 'https://user:pw@hooks.example.com/x', key: KEY }, /must not carry credentials/],
    [{ url: 'not a url secret-path-token', key: KEY }, /not a valid URL/],
    [{ url: URL_WITH_TOKEN, key: '' }, /key is empty/],
    [{ url: URL_WITH_TOKEN, key: `${KEY}\nInjected: header` }, /one line/],
  ];
  for (const [webhook, pattern] of cases) {
    assert.throws(() => checkWebhook(webhook), (error) => {
      assert.match(error.message, pattern);
      assert.ok(!error.message.includes('secret-path-token') && !error.message.includes(KEY));
      return true;
    });
  }
  assert.deepEqual(checkWebhook({ url: ` ${URL_WITH_TOKEN} `, key: ` ${KEY}\n` }), { url: URL_WITH_TOKEN, key: KEY });
});

test('a stored webhook is 0600 in a 0700 directory, and reads back', () => withState(({ env }) => {
  assert.equal(readWebhook(ID, { env }), null);
  assert.deepEqual(saveWebhook(ID, { url: URL_WITH_TOKEN, key: KEY }, { env }), { host: 'hooks.example.com' });
  const file = webhookFile(ID, { env });
  assert.equal(statSync(file).mode & 0o777, 0o600);
  assert.equal(statSync(path.dirname(file)).mode & 0o777, 0o700);
  assert.deepEqual(readWebhook(ID, { env }), { url: URL_WITH_TOKEN, key: KEY });
}));

test('the wake request carries the fixed ask and no message content, with a Bearer key', async () => {
  const calls = [];
  const fetchImpl = async (url, init) => { calls.push({ url, init }); return { status: 200 }; };
  const wake = createWebhookWaker({ read: () => ({ url: URL_WITH_TOKEN, key: KEY }), fetchImpl });
  assert.deepEqual(await wake({ agentId: ID, worktree: '/souls/grokbot' }), { status: 200 });
  const [{ url, init }] = calls;
  assert.equal(url, URL_WITH_TOKEN);
  assert.equal(init.method, 'POST');
  assert.equal(init.redirect, 'error');
  assert.equal(init.headers.authorization, `Bearer ${KEY}`);
  const body = JSON.parse(init.body);
  assert.deepEqual(Object.keys(body).sort(), ['agentId', 'ask', 'event']);
  assert.deepEqual([body.event, body.agentId, body.ask], ['wake', ID, webhookAsk('/souls/grokbot')]);
  assert.match(body.ask, /\/souls\/grokbot/);
  assert.match(body.ask, /agent-comms inbox read/);
  // A key stored with its scheme is not prefixed twice.
  calls.length = 0;
  await createWebhookWaker({ read: () => ({ url: URL_WITH_TOKEN, key: `Bearer ${KEY}` }), fetchImpl })({ agentId: ID, worktree: '/w' });
  assert.equal(calls[0].init.headers.authorization, `Bearer ${KEY}`);
});

test('a failed wake names the host and status, never the URL path or the key', async () => {
  const read = () => ({ url: URL_WITH_TOKEN, key: KEY });
  const leaks = (error) => error.message.includes('secret-path-token') || error.message.includes(KEY);
  await assert.rejects(createWebhookWaker({ read, fetchImpl: async () => ({ status: 401 }) })({ agentId: ID, worktree: '/w' }), (error) => {
    assert.equal(error.message, 'webhook at hooks.example.com answered 401');
    return !leaks(error);
  });
  await assert.rejects(createWebhookWaker({ read, fetchImpl: async () => { throw new Error(`fetch failed for ${URL_WITH_TOKEN}`); } })({ agentId: ID, worktree: '/w' }), (error) => {
    assert.equal(error.message, 'webhook at hooks.example.com could not be reached');
    return !leaks(error);
  });
  await assert.rejects(createWebhookWaker({ read: () => null, fetchImpl: async () => ({ status: 200 }) })({ agentId: ID, worktree: '/w' }), /no webhook is stored/);
});

test('a webhook soul is woken by its webhook alone: no relay, no turn, and only a worktree needed', async () => {
  const receipts = [];
  const wakes = [];
  const forbidden = () => { throw new Error('a webhook soul runs no turn and no relay here'); };
  const waker = (webhook) => createColdWaker({
    executor: forbidden,
    settings: { [ID]: { lane: 'webhook' } },
    lookupBinding: async () => ({ worktree: '/souls/grokbot' }),
    identities: forbidden,
    relay: { read: forbidden, reply: forbidden, ack: forbidden },
    webhook,
    receipt: (r) => receipts.push(r),
  });
  const ok = await waker(async (input) => { wakes.push(input); return { status: 200 }; })({ agentId: ID, messageIds: ['m1'] });
  assert.deepEqual(ok, { outcome: 'cold', detail: 'webhook accepted' });
  assert.deepEqual(wakes, [{ agentId: ID, worktree: '/souls/grokbot' }]);
  assert.deepEqual(receipts.at(-1), { event: 'cold-wake', agentId: ID, decision: 'webhook' });
  const failed = await waker(async () => { throw new Error('webhook at hooks.example.com answered 500'); })({ agentId: ID, messageIds: ['m2'] });
  assert.deepEqual(failed, { outcome: 'failed', detail: 'webhook at hooks.example.com answered 500' });
  const missing = await waker(null)({ agentId: ID, messageIds: ['m3'] });
  assert.equal(missing.outcome, 'failed');
  assert.match(missing.detail, /not available in this daemon/);
});

test('soul cold-wake webhook stores the files it is given, shows only the host, and off removes the secret', () => withState(async ({ root, env }) => {
  const urlFile = path.join(root, 'hook.url');
  writeFileSync(urlFile, `${URL_WITH_TOKEN}\n`, { mode: 0o600 });
  const invoke = (args, input) => spawnSync(process.execPath, [cli, 'soul', 'cold-wake', ID, ...args], { encoding: 'utf8', env, cwd: root, input });
  // Changes run in process with the owner gate injected, so no dialog is raised.
  const out = [];
  const gates = [];
  const change = (args, input = '') => coldWakeCommand([ID, ...args], { env, home: root, cwd: root,
    gate: async (action) => { gates.push(action); return { method: 'consent' }; }, readStdin: () => input, write: (text) => out.push(text) });
  await change(['webhook', '--url-file', urlFile, '--key-file', '-'], `${KEY}\n`);
  assert.deepEqual(out, [`${ID} cold wake webhook hooks.example.com\n`]);
  assert.deepEqual(gates, [`soul cold-wake ${ID} webhook`]);
  assert.ok(!out.join('').includes(KEY) && !out.join('').includes('secret-path-token'));
  assert.deepEqual(wakeSetting(readColdWakeSettings({ env })[ID]), { lane: 'webhook' });
  // Stdin carries the principal or a secret, never both.
  await assert.rejects(change(['webhook', '--url-file', urlFile, '--key-file', '-', '--principal-stdin'], KEY), /--principal-stdin uses stdin/);
  assert.equal(gates.length, 1);
  let result = invoke(['show']);
  assert.equal(result.stdout, 'webhook hooks.example.com\n');
  // An agent cannot set one.
  result = spawnSync(process.execPath, [cli, 'soul', 'cold-wake', ID, 'webhook', '--url-file', urlFile, '--key-file', '-'],
    { encoding: 'utf8', env: { ...env, GH_AGENT_APP: 'you-codex-agent' }, cwd: root, input: KEY });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /owner only/);
  // Both secrets from stdin, or a missing flag, is a usage error.
  assert.equal(invoke(['webhook', '--url-file', '-', '--key-file', '-'], KEY).status, 1);
  assert.equal(invoke(['webhook', '--url-file', urlFile]).status, 1);
  await change(['off']);
  assert.equal(existsSync(webhookFile(ID, { env })), false);
  assert.equal(readFileSync(path.join(root, 'state', 'agent-bot', 'cold-wake.json'), 'utf8').includes(KEY), false);
}));

test('moving a soul from webhook to resume drops its stored webhook', () => withState(({ env }) => {
  saveWebhook(ID, { url: URL_WITH_TOKEN, key: KEY }, { env });
  setColdWake(ID, { lane: 'webhook' }, { env });
  assert.ok(existsSync(webhookFile(ID, { env })));
  setColdWake(ID, { lane: 'resume', policy: 'read-only' }, { env });
  assert.equal(existsSync(webhookFile(ID, { env })), false);
}));
