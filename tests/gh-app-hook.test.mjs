import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createMailbox, handleHookRequest } from '../gh-app-hook.mjs';

const SECRET = 'hook-secret';
const TOKEN = 'inbox-token';
const secrets = { webhookSecrets: { 'qwts-grok-agent': SECRET }, inboxToken: TOKEN };

async function sign(body) {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(SECRET),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const mac = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(body)));
  return `sha256=${[...mac].map((byte) => byte.toString(16).padStart(2, '0')).join('')}`;
}

function delivery(body, signature = null) {
  return new Request('https://gh-app-hook.qwts.org/github/qwts-grok-agent', {
    method: 'POST',
    headers: signature ? { 'x-hub-signature-256': signature } : {},
    body,
  });
}

function mention(repo, text, login = 'qwts') {
  return {
    action: 'created',
    repository: { full_name: repo },
    comment: { body: text, html_url: `https://github.com/${repo}/issues/1#issuecomment-1`, user: { login } },
    issue: { html_url: `https://github.com/${repo}/issues/1` },
  };
}

async function take(mailbox, repo, { token = TOKEN, app = 'qwts-grok-agent' } = {}) {
  const headers = {};
  if (token != null) headers.authorization = `Bearer ${token}`;
  const request = new Request(
    `https://gh-app-hook.qwts.org/inbox?app=${encodeURIComponent(app)}&repo=${encodeURIComponent(repo)}`,
    { method: 'POST', headers },
  );
  return handleHookRequest(request, mailbox, secrets);
}

test('a mention in example1 is returned only to that repo and then cleared', async () => {
  const mailbox = createMailbox();
  const body = JSON.stringify(mention('qwts/example1', 'please look @qwts-grok-agent'));
  const stored = await handleHookRequest(delivery(body, await sign(body)), mailbox, secrets);
  assert.equal(stored.status, 200);
  assert.equal((await stored.json()).stored, true);

  const other = await take(mailbox, 'qwts/example2');
  assert.equal(other.status, 204);
  assert.equal(await mailbox.size(), 1);

  const taken = await take(mailbox, 'qwts/example1');
  assert.equal(taken.status, 200);
  const event = await taken.json();
  assert.equal(event.repo, 'qwts/example1');
  assert.equal(event.kind, 'mention');
  assert.match(event.text, /@qwts-grok-agent/);

  const again = await take(mailbox, 'qwts/example1');
  assert.equal(again.status, 204);
  assert.equal(await mailbox.size(), 0);
});

test('an unauthenticated take is rejected and does not clear', async () => {
  const mailbox = createMailbox();
  const body = JSON.stringify(mention('qwts/example1', '@qwts-grok-agent'));
  await handleHookRequest(delivery(body, await sign(body)), mailbox, secrets);
  const rejected = await take(mailbox, 'qwts/example1', { token: null });
  assert.equal(rejected.status, 401);
  assert.equal(await mailbox.size(), 1);
  const wrong = await take(mailbox, 'qwts/example1', { token: 'nope' });
  assert.equal(wrong.status, 401);
  assert.equal(await mailbox.size(), 1);
});

test('a short repo name and a bad signature store nothing', async () => {
  const mailbox = createMailbox();
  const body = JSON.stringify(mention('qwts/example1', '@qwts-grok-agent'));
  const bad = await handleHookRequest(delivery(body, 'sha256=dead'), mailbox, secrets);
  assert.equal(bad.status, 401);
  assert.equal(await mailbox.size(), 0);

  const signed = await sign(body);
  await handleHookRequest(delivery(body, signed), mailbox, secrets);
  const short = await take(mailbox, 'example1');
  assert.equal(short.status, 400);
  assert.equal(await mailbox.size(), 1);
});

test('a comment authored by the App is not stored', async () => {
  const mailbox = createMailbox();
  const body = JSON.stringify(mention('qwts/example1', '@qwts-grok-agent', 'qwts-grok-agent[bot]'));
  const response = await handleHookRequest(delivery(body, await sign(body)), mailbox, secrets);
  assert.equal((await response.json()).stored, false);
  assert.equal(await mailbox.size(), 0);
});

test('a review request for the App is stored and one for someone else is not', async () => {
  const mailbox = createMailbox();
  const mine = {
    action: 'review_requested',
    repository: { full_name: 'qwts/example1' },
    requested_reviewer: { login: 'qwts-grok-agent[bot]' },
    pull_request: { html_url: 'https://github.com/qwts/example1/pull/3' },
  };
  const other = {
    ...mine,
    requested_reviewer: { login: 'qwts' },
  };
  await handleHookRequest(delivery(JSON.stringify(other), await sign(JSON.stringify(other))), mailbox, secrets);
  assert.equal(await mailbox.size(), 0);
  const raw = JSON.stringify(mine);
  await handleHookRequest(delivery(raw, await sign(raw)), mailbox, secrets);
  const taken = await take(mailbox, 'qwts/example1');
  const event = await taken.json();
  assert.equal(event.kind, 'review_requested');
  assert.equal(event.url, 'https://github.com/qwts/example1/pull/3');
});
