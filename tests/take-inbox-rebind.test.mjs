import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createServer } from 'node:http';

import { createMcpState, handleMcpMessage } from '../agent-mcp.mjs';
import { createBindingRegistry, readBinding } from '../agent-binding.mjs';

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
  git(root, 'config', 'extensions.worktreeConfig', 'true');
  git(root, 'config', '--worktree', 'agentBot.app', 'qwts-grok-agent');
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

// Background listener: a real inbox HTTP server on loopback, so the test
// exercises the same POST /inbox?app=&repo= path production uses.
async function startInboxListener(handler) {
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      handler(req, body, res);
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return { server, url: `http://127.0.0.1:${port}`, close: () => server.close() };
}

test('#299: take_inbox surfaces the inbox host and underlying cause with a stable code, never the token', async () => {
  const { root, secret } = boundFixture();
  const inboxToken = 'inbox-secret-value';
  const cause = Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:1'), { code: 'ECONNREFUSED' });
  const fetchImpl = async () => {
    throw Object.assign(new Error('fetch failed'), { cause });
  };
  const client = {
    async binding(s) {
      assert.equal(s, secret);
      return { agentId: AGENT_ID, worktree: root, transcript: { provider: 'claude', id: 's' } };
    },
  };
  const state = createMcpState({
    client,
    cwd: root,
    env: { GH_APP_HOOK_INBOX_URL: 'https://gh-app-hook.example.invalid', GH_APP_HOOK_INBOX_TOKEN: inboxToken },
    fetchImpl,
  });
  // Simulate already-bound server (no restart yet): secret held in memory.
  state.secret = secret;
  state.agentId = AGENT_ID;

  const { text, isError } = await callTakeInbox(state);
  assert.equal(isError, true);
  // Must NOT be the bare undici message.
  assert.notEqual(text, 'fetch failed');
  // Must name the host, the cause code/message, and a stable code, with recovery.
  assert.match(text, /gh-app-hook\.example\.invalid/);
  assert.match(text, /ECONNREFUSED/);
  assert.match(text, /connect ECONNREFUSED/);
  assert.match(text, /\[inbox-broker-unreachable\]/);
  assert.match(text, /GH_APP_HOOK_INBOX_URL|broker|doctor/i);
  // Never leak the bearer.
  assert.doesNotMatch(text, new RegExp(inboxToken));
});

test('#299: take_inbox sends a timeout so a hung broker cannot stall the tool', async () => {
  const { root, secret } = boundFixture();
  let seenSignal = null;
  const fetchImpl = async (url, options) => {
    seenSignal = options?.signal ?? null;
    return new Response(null, { status: 204 });
  };
  const client = {
    async binding() {
      return { agentId: AGENT_ID, worktree: root, transcript: { provider: 'claude', id: 's' } };
    },
  };
  const state = createMcpState({
    client,
    cwd: root,
    env: { GH_APP_HOOK_INBOX_URL: 'https://gh-app-hook.example.invalid', GH_APP_HOOK_INBOX_TOKEN: 'tok' },
    fetchImpl,
  });
  state.secret = secret;
  const { isError } = await callTakeInbox(state);
  assert.equal(isError, false);
  assert.ok(seenSignal, 'fetch must receive an AbortSignal timeout');
});

test('#299: take_inbox maps 401 to auth-expired with recovery, never the token', async () => {
  const { root } = boundFixture();
  const fetchImpl = async () => new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401 });
  const state = createMcpState({
    client: {
      async binding() {
        return { agentId: AGENT_ID, worktree: root, transcript: { provider: 'claude', id: 's' } };
      },
    },
    cwd: root,
    env: { GH_APP_HOOK_INBOX_URL: 'https://gh-app-hook.example.invalid', GH_APP_HOOK_INBOX_TOKEN: 'super-secret-bearer' },
    fetchImpl,
  });
  // Seed from the real binding file to isolate the 401 mapping.
  const existing = readBinding({ env: state.env, cwd: root });
  state.secret = existing.secret;
  const { text, isError } = await callTakeInbox(state);
  assert.equal(isError, true);
  assert.match(text, /\[inbox-auth-expired\]/);
  assert.match(text, /401/);
  assert.match(text, /GH_APP_HOOK_INBOX_TOKEN|expired|refresh/i);
  assert.doesNotMatch(text, /super-secret-bearer/);
});

test('#299: after an MCP restart, take_inbox re-binds from the existing binding without a new token', async () => {
  const { root } = boundFixture();
  const { server, url, close } = await startInboxListener((req, body, res) => {
    const u = new URL(req.url, url);
    if (req.method === 'POST' && u.pathname === '/inbox' && u.searchParams.get('app') === 'qwts-grok-agent') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ app: 'qwts-grok-agent', repo: 'qwts/example1', kind: 'mention' }));
    } else {
      res.writeHead(400);
      res.end('{}');
    }
  });
  try {
    // Simulate a restarted MCP server: fresh state, no in-memory secret,
    // no bind token (consumed on first bind), only the binding file on disk.
    const restarted = createMcpState({
      client: {
        async binding() {
          return { agentId: AGENT_ID, worktree: root, transcript: { provider: 'claude', id: 's' } };
        },
      },
      cwd: root,
      env: { GH_APP_HOOK_INBOX_URL: url, GH_APP_HOOK_INBOX_TOKEN: 'inbox-secret' },
      fetchImpl: globalThis.fetch,
    });
    assert.equal(restarted.secret, null);
    const { text, isError } = await callTakeInbox(restarted);
    assert.equal(isError, false, `restarted take_inbox must succeed without manual bind, got: ${text}`);
    assert.match(text, /qwts\/example1/);
    // The restarted server holding the secret proves re-bind happened.
    assert.ok(restarted.secret, 'restarted state must hold the rebound secret');
  } finally {
    close();
  }
});

test('#299: take_inbox names the daemon cause when the daemon cannot check the binding', async () => {
  const { root, secret } = boundFixture();
  const cause = Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:7777'), { code: 'ECONNREFUSED' });
  const client = {
    async binding() {
      throw Object.assign(new Error('fetch failed'), { cause });
    },
  };
  const state = createMcpState({
    client,
    cwd: root,
    env: { GH_APP_HOOK_INBOX_URL: 'https://gh-app-hook.example.invalid', GH_APP_HOOK_INBOX_TOKEN: 'tok' },
    fetchImpl: async () => { throw new Error('the inbox must not be called'); },
  });
  state.secret = secret;
  const { text, isError } = await callTakeInbox(state);
  assert.equal(isError, true);
  assert.match(text, /ECONNREFUSED: connect ECONNREFUSED 127\.0\.0\.1:7777/);
  assert.match(text, /\[inbox-daemon-unreachable\]/);
  assert.doesNotMatch(text, new RegExp(secret));
});

test('#299: take_inbox maps an unreadable 2xx body to inbox-unavailable, never the token', async () => {
  const { root, secret } = boundFixture();
  const inboxToken = 'inbox-secret-value';
  const client = {
    async binding() {
      return { agentId: AGENT_ID, worktree: root, transcript: { provider: 'claude', id: 's' } };
    },
  };
  const state = createMcpState({
    client,
    cwd: root,
    env: { GH_APP_HOOK_INBOX_URL: 'https://gh-app-hook.example.invalid', GH_APP_HOOK_INBOX_TOKEN: inboxToken },
    fetchImpl: async () => new Response('{not json', { status: 200, headers: { 'content-type': 'application/json' } }),
  });
  state.secret = secret;
  const { text, isError } = await callTakeInbox(state);
  assert.equal(isError, true);
  assert.match(text, /gh-app-hook\.example\.invalid/);
  assert.match(text, /unreadable response/);
  assert.match(text, /\[inbox-unavailable\]/);
  assert.doesNotMatch(text, new RegExp(inboxToken));
});
