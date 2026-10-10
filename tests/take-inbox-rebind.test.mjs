import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { createMcpState, handleMcpMessage } from '../agent-mcp.mjs';
import { createBindingRegistry } from '../agent-binding.mjs';

const AGENT_ID = 'agent_bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const roots = [];

after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

function git(cwd, ...args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function scratchRepo() {
  const root = mkdtempSync(path.join(tmpdir(), 'take-inbox-299-'));
  roots.push(root);
  git(root, 'init', '--quiet');
  git(root, 'remote', 'add', 'origin', 'https://github.com/qwts/example1.git');
  const gitDir = git(root, 'rev-parse', '--absolute-git-dir');
  return { root, gitDir };
}

function boundFixture() {
  const { root, gitDir } = scratchRepo();
  const registryFile = path.join(root, 'state', 'bindings.json');
  const registry = createBindingRegistry({ file: registryFile, account: 'test-account', now: () => new Date() });
  registry.rewrite('http://127.0.0.1:1234');
  const secret = registry.bind({ agentId: AGENT_ID, gitDir, worktree: root });
  return { root, gitDir, registry, secret };
}

function request(id, method, params = {}) {
  return { jsonrpc: '2.0', id, method, params };
}

async function callTakeInbox(state) {
  const response = await handleMcpMessage(state, request(9, 'tools/call', { name: 'take_inbox', arguments: {} }));
  const text = response.result.content[0].text;
  return { response, text, isError: response.result.isError === true };
}

function boundClient(root, takeInbox) {
  return {
    async binding() {
      return { agentId: AGENT_ID, worktree: root, transcript: { provider: 'claude', id: 's' } };
    },
    takeInbox,
  };
}

// The broker's own failures are mapped in the daemon (tests/inbox-take.test.mjs);
// take_inbox shows the daemon's sentence and code as is.
test('#299: take_inbox shows the daemon\'s inbox code and sentence, never the bearer', async () => {
  const { root, secret } = boundFixture();
  const sentence = 'take_inbox failed: inbox at gh-app-hook.example.invalid rejected the bearer (HTTP 401); update the pass-cli password field agent-bot.inbox/gh-app-hook-inbox-token to the current INBOX_TOKEN, then retry';
  const state = createMcpState({
    client: boundClient(root, async () => {
      throw Object.assign(new Error(`daemon POST /v0/inbox/take failed: ${sentence}`), { code: 'inbox-auth-expired', detail: sentence });
    }),
    cwd: root,
    env: {},
  });
  state.secret = secret;
  const { text, isError } = await callTakeInbox(state);
  assert.equal(isError, true);
  assert.equal(text, `${sentence} [inbox-auth-expired]`);
});

test('#299: take_inbox names the daemon cause when the daemon cannot take', async () => {
  const { root, secret } = boundFixture();
  const cause = Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:7777'), { code: 'ECONNREFUSED' });
  const state = createMcpState({
    client: boundClient(root, async () => { throw Object.assign(new Error('fetch failed'), { cause }); }),
    cwd: root,
    env: {},
  });
  state.secret = secret;
  const { text, isError } = await callTakeInbox(state);
  assert.equal(isError, true);
  assert.notEqual(text, 'fetch failed');
  assert.match(text, /ECONNREFUSED: connect ECONNREFUSED 127\.0\.0\.1:7777/);
  assert.match(text, /\[inbox-daemon-unreachable\]/);
  assert.doesNotMatch(text, new RegExp(secret));
});

test('#299: after an MCP restart, take_inbox re-binds from the existing binding without a new token', async () => {
  const { root, secret } = boundFixture();
  const seen = [];
  // Simulate a restarted MCP server: fresh state, no in-memory secret,
  // no bind token (consumed on first bind), only the binding file on disk.
  const restarted = createMcpState({
    client: boundClient(root, async (held) => {
      seen.push(held);
      return { schemaVersion: 1, event: { app: 'you-codex-agent', repo: 'qwts/example1', kind: 'mention' } };
    }),
    cwd: root,
    env: {},
  });
  assert.equal(restarted.secret, null);
  const { text, isError } = await callTakeInbox(restarted);
  assert.equal(isError, false, `restarted take_inbox must succeed without manual bind, got: ${text}`);
  assert.match(text, /qwts\/example1/);
  // The restarted server holding the secret proves re-bind happened.
  assert.equal(restarted.secret, secret);
  assert.deepEqual(seen, [secret]);
});

test('#299: take_inbox names the daemon cause when the daemon cannot check the binding', async () => {
  const { root, secret } = boundFixture();
  const cause = Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:7777'), { code: 'ECONNREFUSED' });
  const state = createMcpState({
    client: {
      async binding() {
        throw Object.assign(new Error('fetch failed'), { cause });
      },
      async takeInbox() { throw new Error('the inbox must not be called'); },
    },
    cwd: root,
    env: {},
  });
  state.secret = secret;
  const { text, isError } = await callTakeInbox(state);
  assert.equal(isError, true);
  assert.match(text, /ECONNREFUSED: connect ECONNREFUSED 127\.0\.0\.1:7777/);
  assert.match(text, /\[inbox-daemon-unreachable\]/);
  assert.doesNotMatch(text, new RegExp(secret));
});
