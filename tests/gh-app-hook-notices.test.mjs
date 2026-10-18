import { test } from 'node:test';
import assert from 'node:assert/strict';
import { acceptDelivery, buildDeliveryEnvelope, createMailbox, handleHookRequest, signBody } from '../gh-app-hook.mjs';

const APP = 'qwts-codex-agent';
const REPO = 'qwts/example';
const SECRET = 'test-webhook-secret';
const options = { webhookSecrets: { [APP]: SECRET }, inboxToken: 'test-inbox-token' };
const issue = { number: 12, title: 'Example issue', state: 'closed', html_url: `https://github.com/${REPO}/issues/12` };
const pr = { ...issue, html_url: `https://github.com/${REPO}/pull/12`, head: { sha: 'abc123' }, merged: true };

function payload(fields) {
  return { repository: { full_name: REPO }, sender: { login: 'qwts' }, ...fields };
}

async function deliver(mailbox, event, data, validSignature = true) {
  const body = JSON.stringify(data);
  const request = new Request(`https://hook.invalid/github/${APP}`, {
    method: 'POST',
    headers: {
      'x-github-event': event,
      'x-hub-signature-256': validSignature ? await signBody(SECRET, body) : 'sha256=wrong',
    },
    body,
  });
  return handleHookRequest(request, mailbox, options);
}

async function take(mailbox, repo = REPO) {
  return handleHookRequest(new Request(`https://hook.invalid/inbox?app=${APP}&repo=${repo}`, {
    method: 'POST', headers: { authorization: 'Bearer test-inbox-token' },
  }), mailbox, options);
}

const notices = [
  ['discussion', 'answered', { discussion: { ...issue, html_url: `https://github.com/${REPO}/discussions/12` } }],
  ['issues', 'closed', { issue }],
  ['issue_comment', 'created', { issue, comment: { body: 'No mention needed', html_url: `${issue.html_url}#issuecomment-1` } }],
  ['pull_request', 'closed', { pull_request: pr }],
  ['pull_request_review', 'submitted', { pull_request: pr, review: { body: 'Approved', state: 'approved', html_url: `${pr.html_url}#pullrequestreview-1` } }],
  ['pull_request_review_comment', 'edited', { pull_request: pr, comment: { body: 'Updated feedback', html_url: `${pr.html_url}#discussion_r1` } }],
  ['pull_request_review_thread', 'resolved', { pull_request: pr, thread: { id: 1 } }],
];

for (const [event, action, fields] of notices) {
  test(`${event}.${action} is signed, stored and retrieved with context without a mention`, async () => {
    const mailbox = createMailbox();
    const response = await deliver(mailbox, event, payload({ action, ...fields }));
    assert.deepEqual(await response.json(), { stored: true });
    assert.equal((await take(mailbox, 'qwts/other')).status, 204);
    const record = await (await take(mailbox)).json();
    assert.equal(record.kind, `${event}.${action}`);
    assert.equal(record.event, event);
    assert.equal(record.action, action);
    assert.equal(record.number, 12);
    assert.equal(record.title, issue.title);
    assert.equal(record.actor, 'qwts');
    assert.ok(record.url.startsWith(`https://github.com/${REPO}/`));
    assert.equal((await take(mailbox)).status, 204);
    if (event === 'pull_request') assert.equal(record.merged, true);
    if (event === 'pull_request_review') assert.equal(record.reviewState, 'approved');
  });
}

test('PR close and merge notices remain distinguishable, including on the App own PR', () => {
  const closed = acceptDelivery(APP, payload({ action: 'closed', pull_request: { ...pr, merged: false } }), 'pull_request');
  const merged = acceptDelivery(APP, payload({ action: 'closed', pull_request: { ...pr, user: { login: `${APP}[bot]` } } }), 'pull_request');
  assert.equal(closed.merged, false);
  assert.equal(merged.merged, true);
  assert.equal(merged.headSha, 'abc123');
});

test('all subscribed action names are retained, including edits, labels and reopenings', () => {
  for (const action of ['opened', 'edited', 'labeled', 'unlabeled', 'reopened', 'deleted', 'assigned']) {
    assert.equal(acceptDelivery(APP, payload({ action, issue }), 'issues').kind, `issues.${action}`);
  }
});

test('legacy mention and targeted-review kinds survive with the event metadata', () => {
  const mention = acceptDelivery(APP, payload({ action: 'created', issue, comment: { body: `Please check @${APP}` } }), 'issue_comment');
  assert.equal(mention.kind, 'mention');
  assert.equal(mention.event, 'issue_comment');
  const request = payload({ action: 'review_requested', pull_request: pr, requested_reviewer: { login: `${APP}[bot]` } });
  assert.equal(acceptDelivery(APP, request, 'pull_request').kind, 'review_requested');
  assert.equal(acceptDelivery(APP, { ...request, requested_reviewer: { login: 'someone-else' } }, 'pull_request').kind, 'pull_request.review_requested');
  assert.equal(acceptDelivery(APP, { ...request, pull_request: { ...pr, user: { login: APP } } }, 'pull_request'), null);
});

test('App-authored comments stay suppressed for both comment families and all actions', () => {
  for (const event of ['issue_comment', 'pull_request_review_comment']) {
    for (const action of ['created', 'edited', 'deleted']) {
      const record = acceptDelivery(APP, payload({ action, issue, comment: { body: `@${APP}`, user: { login: `${APP.toUpperCase()}[bot]` } } }), event);
      assert.equal(record, null);
    }
  }
});

test('unsupported event headers and malformed payloads cannot enter the mailbox', async () => {
  const mailbox = createMailbox();
  for (const event of ['push', 'check_suite', 'ping', 'discussion_comment']) {
    const response = await deliver(mailbox, event, payload({ action: 'created', issue, comment: { body: `@${APP}` } }));
    assert.deepEqual(await response.json(), { stored: false });
  }
  for (const data of [null, {}, payload({ action: 'closed' }), payload({ action: 'closed', issue: [] }), payload({ action: 'closed', issue, repository: { full_name: 'short' } }), payload({ action: '<invalid>', issue })]) {
    assert.equal(acceptDelivery(APP, data, 'issues'), null);
  }
  assert.equal(acceptDelivery(APP, payload({ action: 'created', comment: { body: 'No parent issue' } }), 'issue_comment'), null);
  assert.equal(acceptDelivery(APP, payload({ action: 'submitted', review: { state: 'approved' } }), 'pull_request_review'), null);
  assert.equal(acceptDelivery(APP, payload({ action: 'closed', issue: { ...issue, number: '12' } }), 'issues'), null);
  const rejected = await deliver(mailbox, 'pull_request', payload({ action: 'closed', pull_request: pr }), false);
  assert.equal(rejected.status, 401);
  assert.equal(await mailbox.size(), 0);
});

test('push envelope includes notice metadata without copying comment text or raw payload', () => {
  const record = acceptDelivery(APP, payload({ action: 'submitted', pull_request: pr, review: { body: 'Private review text', state: 'changes_requested' } }), 'pull_request_review');
  const envelope = buildDeliveryEnvelope(record);
  assert.equal(envelope.event, 'pull_request_review');
  assert.equal(envelope.action, 'submitted');
  assert.equal(envelope.title, issue.title);
  assert.equal(envelope.reviewState, 'changes_requested');
  assert.equal(envelope.text, undefined);
  assert.equal(envelope.pull_request, undefined);
});
