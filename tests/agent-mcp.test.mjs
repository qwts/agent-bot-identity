import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { createMcpState, handleMcpMessage } from '../agent-mcp.mjs';
import { mintBindToken, readBindToken } from '../agent-binding.mjs';

const AGENT_ID = 'agent_bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const roots = [];

after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

function git(cwd, ...args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function scratchRepo() {
  const root = mkdtempSync(path.join(tmpdir(), 'agent-mcp-'));
  roots.push(root);
  git(root, 'init', '--quiet');
  const gitDir = git(root, 'rev-parse', '--absolute-git-dir');
  return { root, gitDir };
}

function fakeClient(overrides = {}) {
  const calls = [];
  return {
    calls,
    async bind(args) {
      calls.push(['bind', args]);
      return {
        schemaVersion: 1,
        secret: 'a'.repeat(64),
        agentId: AGENT_ID,
        worktree: '/w',
        repinRequired: false,
        soul: { id: AGENT_ID },
        ...overrides.bindResult,
      };
    },
    async binding(secret) {
      calls.push(['binding', secret]);
      return { agentId: AGENT_ID, worktree: '/w', transcript: { provider: 'claude', id: 's' }, boundAt: 't' };
    },
    async population(filters) {
      calls.push(['population', filters]);
      return [{ id: AGENT_ID }];
    },
    async spacePath(agentId) {
      calls.push(['spacePath', agentId]);
      return { agentId, path: '/spaces/x' };
    },
    async credential(secret) {
      calls.push(['credential', secret]);
      return { agentId: AGENT_ID, appSlug: 'you-codex-agent', token: 'ghs_grant', expires_at: 't' };
    },
  };
}

function request(id, method, params = {}) {
  return { jsonrpc: '2.0', id, method, params };
}

async function callTool(state, name, args) {
  const response = await handleMcpMessage(state, request(9, 'tools/call', { name, arguments: args }));
  const text = response.result.content[0].text;
  return { response, text, isError: response.result.isError === true };
}

test('initialize advertises tools and instructs the agent to bind first', async () => {
  const state = createMcpState({ client: fakeClient() });
  const init = await handleMcpMessage(state, request(1, 'initialize', { protocolVersion: '2025-06-18' }));
  assert.equal(init.result.serverInfo.name, 'agent-bot');
  assert.match(init.result.instructions, /bind tool once at conversation start/);
  const list = await handleMcpMessage(state, request(2, 'tools/list'));
  assert.deepEqual(
    list.result.tools.map((tool) => tool.name),
    ['bind', 'whoami', 'population', 'space_path', 'credential'],
  );
});

test('notifications get no response; unknown methods get -32601', async () => {
  const state = createMcpState({ client: fakeClient() });
  assert.equal(await handleMcpMessage(state, { jsonrpc: '2.0', method: 'notifications/initialized' }), null);
  const unknown = await handleMcpMessage(state, request(3, 'no/such/method'));
  assert.equal(unknown.error.code, -32601);
  const invalid = await handleMcpMessage(state, { hello: 'there' });
  assert.equal(invalid.error.code, -32600);
});

test('bind reads the worktree token itself and never returns the secret', async () => {
  const { root, gitDir } = scratchRepo();
  const record = mintBindToken({ gitDir, worktree: root, agentId: AGENT_ID });
  const client = fakeClient();
  const state = createMcpState({ client, cwd: root, env: {} });
  const { text, isError } = await callTool(state, 'bind', { transcript_id: 'session-1' });
  assert.equal(isError, false);
  const [, args] = client.calls.find(([name]) => name === 'bind');
  assert.equal(args.gitDir, gitDir);
  assert.equal(args.token, record.token);
  assert.equal(args.transcript.id, 'session-1');
  // The conversation sees the identity, never the connection secret.
  assert.equal(text.includes('a'.repeat(64)), false);
  assert.match(text, new RegExp(AGENT_ID));
  assert.equal(state.secret, 'a'.repeat(64));
});

test('bind requires a transcript_id and a minted token', async () => {
  const { root } = scratchRepo();
  const state = createMcpState({ client: fakeClient(), cwd: root, env: {} });
  const missingId = await callTool(state, 'bind', {});
  assert.equal(missingId.isError, true);
  assert.match(missingId.text, /transcript_id/);
  const missingToken = await callTool(state, 'bind', { transcript_id: 's' });
  assert.equal(missingToken.isError, true);
  assert.match(missingToken.text, /setup-worktree/);
});

test('bind repins the worktree when the reuse policy resolved a fresh identity', async () => {
  const { root, gitDir } = scratchRepo();
  const freshId = 'agent_cccccccc-cccc-4ccc-8ccc-cccccccccccc';
  mintBindToken({ gitDir, worktree: root, agentId: AGENT_ID });
  const client = fakeClient({ bindResult: { agentId: freshId, repinRequired: true } });
  const state = createMcpState({ client, cwd: root, env: {} });
  const { isError } = await callTool(state, 'bind', { transcript_id: 'session-2' });
  assert.equal(isError, false);
  assert.equal(git(root, 'config', '--worktree', 'agentBot.agentId'), freshId);
});

test('whoami and space_path require a live binding and derive identity from it', async () => {
  const { root, gitDir } = scratchRepo();
  const client = fakeClient();
  const state = createMcpState({ client, cwd: root, env: {} });
  const unbound = await callTool(state, 'whoami', {});
  assert.equal(unbound.isError, true);
  assert.match(unbound.text, /not bound/);

  mintBindToken({ gitDir, worktree: root, agentId: AGENT_ID });
  await callTool(state, 'bind', { transcript_id: 'session-3' });
  const who = await callTool(state, 'whoami', {});
  assert.equal(who.isError, false);
  assert.match(who.text, new RegExp(AGENT_ID));

  const space = await callTool(state, 'space_path', {});
  assert.equal(space.isError, false);
  // space_path asked the daemon who we are, then asked for that soul's path —
  // it never passed a caller-chosen Agent ID.
  const spaceCall = client.calls.find(([name]) => name === 'spacePath');
  assert.equal(spaceCall[1], AGENT_ID);
});

test('credential requires a live binding and presents only the connection secret (#90)', async () => {
  const { root, gitDir } = scratchRepo();
  const client = fakeClient();
  const state = createMcpState({ client, cwd: root, env: {} });
  const unbound = await callTool(state, 'credential', {});
  assert.equal(unbound.isError, true);
  assert.match(unbound.text, /not bound/);

  mintBindToken({ gitDir, worktree: root, agentId: AGENT_ID });
  await callTool(state, 'bind', { transcript_id: 'session-5' });
  const grant = await callTool(state, 'credential', {});
  assert.equal(grant.isError, false);
  assert.match(grant.text, /ghs_grant/);
  // The request carried no Agent ID and no App — only the held secret.
  const credentialCall = client.calls.find(([name]) => name === 'credential');
  assert.equal(credentialCall[1], 'a'.repeat(64));
});

test('population forwards filters and works unbound', async () => {
  const client = fakeClient();
  const state = createMcpState({ client });
  const { isError } = await callTool(state, 'population', { status: 'active', app: 'qwts-claude-agent' });
  assert.equal(isError, false);
  const [, filters] = client.calls.find(([name]) => name === 'population');
  assert.deepEqual(filters, { status: 'active', app: 'qwts-claude-agent' });
});

test('the surrendered token is consumed by the daemon, not the MCP server', async () => {
  // The server reads the token; consumption is the daemon's side effect. When
  // the fake daemon succeeds without consuming, the file is still there —
  // proving the MCP layer holds no destructive authority of its own.
  const { root, gitDir } = scratchRepo();
  mintBindToken({ gitDir, worktree: root, agentId: AGENT_ID });
  const state = createMcpState({ client: fakeClient(), cwd: root, env: {} });
  await callTool(state, 'bind', { transcript_id: 'session-4' });
  assert.notEqual(readBindToken(gitDir), null);
});
