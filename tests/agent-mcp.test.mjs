import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';

import { createMcpState, handleMcpMessage, runMcpServer } from '../agent-mcp.mjs';
import { SKILL_REFERENCES } from '../cli/skill-references.mjs';
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
  assert.match(init.result.instructions, /call_write_tool/);
  const list = await handleMcpMessage(state, request(2, 'tools/list'));
  assert.deepEqual(
    list.result.tools.map((tool) => tool.name),
    ['search_tools', 'describe_tool', 'call_tool', 'call_write_tool'],
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

test('a notification for a KNOWN method is also silent — no id:null reply', async () => {
  const state = createMcpState({ client: fakeClient() });
  // JSON-RPC: any request without an id is a notification, even when the
  // method is one the server answers; an id:null response would read to the
  // client as an unmatched reply.
  assert.equal(await handleMcpMessage(state, { jsonrpc: '2.0', method: 'ping' }), null);
  assert.equal(await handleMcpMessage(state, { jsonrpc: '2.0', method: 'tools/list' }), null);
  assert.equal(await handleMcpMessage(state, { jsonrpc: '2.0', method: 'initialize', params: {} }), null);
});

test('connection close preserves the binding', async () => {
  const { root, gitDir } = scratchRepo();
  mintBindToken({ gitDir, worktree: root, agentId: AGENT_ID });
  const released = [];
  const client = fakeClient();
  client.releaseBinding = async (secret) => { released.push(secret); return { released: true }; };
  const state = createMcpState({ client, cwd: root, env: {} });

  const input = new PassThrough();
  const output = new PassThrough();
  const server = runMcpServer({ state, input, output });
  const firstResponse = new Promise((resolve) => output.once('data', resolve));
  input.write(`${JSON.stringify(request(1, 'tools/call', { name: 'bind', arguments: { transcript_id: 'session-5' } }))}\n`);
  await firstResponse;
  input.end();
  await server;

  assert.deepEqual(released, []);
  assert.equal(state.secret, 'a'.repeat(64));
  assert.equal(state.agentId, AGENT_ID);
});

test('close waits for an in-flight bind and preserves its binding', async () => {
  const { root, gitDir } = scratchRepo();
  mintBindToken({ gitDir, worktree: root, agentId: AGENT_ID });
  const released = [];
  const client = fakeClient();
  const daemonBind = client.bind.bind(client);
  // A slow daemon: EOF arrives while the bind round-trip is still in flight.
  client.bind = async (args) => {
    await new Promise((resolve) => setTimeout(resolve, 25));
    return daemonBind(args);
  };
  client.releaseBinding = async (secret) => { released.push(secret); return { released: true }; };
  const state = createMcpState({ client, cwd: root, env: {} });

  const input = new PassThrough();
  const output = new PassThrough();
  output.resume();
  const server = runMcpServer({ state, input, output });
  input.write(`${JSON.stringify(request(1, 'tools/call', { name: 'bind', arguments: { transcript_id: 'session-6' } }))}\n`);
  // No waiting: the close must drain the handler before deciding whether a
  // binding exists, or the late bind would leak its registry slot.
  input.end();
  await server;

  assert.deepEqual(released, []);
  assert.equal(state.secret, 'a'.repeat(64));
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
  // Members get the reference, never the token (#1184 goal).
  assert.doesNotMatch(grant.text, /ghs_grant/);
  assert.match(grant.text, /credential_ref/);
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

test('take_inbox asks the daemon on the held binding and sends no App, repository or bearer (#229)', async () => {
  const { root, gitDir } = scratchRepo();
  git(root, 'remote', 'add', 'origin', 'https://github.com/qwts/example1.git');
  mintBindToken({ gitDir, worktree: root, agentId: AGENT_ID });
  const client = fakeClient();
  client.binding = async (secret) => {
    client.calls.push(['binding', secret]);
    return { agentId: AGENT_ID, worktree: root, transcript: { provider: 'claude', id: 's' } };
  };
  client.takeInbox = async (...args) => {
    client.calls.push(['takeInbox', ...args]);
    return { schemaVersion: 1, event: { app: 'you-codex-agent', repo: 'qwts/example1', kind: 'mention' } };
  };
  // A bearer left in this process's environment is no longer read.
  const state = createMcpState({ client, cwd: root, env: { GH_APP_HOOK_INBOX_TOKEN: 'inbox-secret' } });
  const unbound = await callTool(state, 'take_inbox', { app: 'qwts-claude-agent', repo: 'qwts/example2' });
  assert.equal(unbound.isError, true);
  assert.match(unbound.text, /not bound/);
  assert.equal(client.calls.some(([name]) => name === 'takeInbox'), false);

  await callTool(state, 'bind', { transcript_id: 'session-inbox' });
  const taken = await callTool(state, 'take_inbox', { app: 'qwts-claude-agent', repo: 'qwts/example2' });
  assert.equal(taken.isError, false);
  assert.match(taken.text, /qwts\/example1/);
  assert.doesNotMatch(taken.text, /inbox-secret/);
  const take = client.calls.find(([name]) => name === 'takeInbox');
  // Only the connection secret, which the client turns into a proof.
  assert.deepEqual(take, ['takeInbox', 'a'.repeat(64)]);
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

// #107: the session's stated App (GH_AGENT_APP) is sent as a claim, and a
// reconcile the daemon reports moves the checkout's App pin with it.
function claimEnv(root) {
  const config = path.join(root, 'config.json');
  writeFileSync(config, '{}\n');
  return { HOME: root, AGENT_BOT_CONFIG: config, GH_AGENT_APP: 'you-codex-agent' };
}

const RECONCILED = { status: 'reconciled', recorded: 'you-grok-agent', claimed: 'you-codex-agent', reason: 'org-mapping-agrees' };

test('a first bind sends the stated App and repins after a reconcile (#107)', async () => {
  const { root, gitDir } = scratchRepo();
  mintBindToken({ gitDir, worktree: root, agentId: AGENT_ID });
  const client = fakeClient({ bindResult: { app: RECONCILED } });
  const state = createMcpState({ client, cwd: root, env: claimEnv(root) });
  const { text, isError } = await callTool(state, 'bind', { transcript_id: 'session-app' });
  assert.equal(isError, false);
  const [, args] = client.calls.find(([name]) => name === 'bind');
  assert.equal(args.app, 'you-codex-agent');
  assert.equal(git(root, 'config', '--worktree', 'agentBot.app'), 'you-codex-agent');
  assert.match(text, /setup-worktree/);
});

test('a session on an existing binding states its App too, and repins after a reconcile (#107)', async () => {
  const { root, gitDir } = scratchRepo();
  const secret = 'b'.repeat(43);
  writeFileSync(path.join(gitDir, 'agent-binding.json'), JSON.stringify({
    v: 1, agentId: AGENT_ID, parent: null, account: 'you', daemon: 'http://127.0.0.1:1/', secret,
  }), { mode: 0o600 });
  const client = fakeClient();
  client.reconcileApp = async (presented, app) => { client.calls.push(['reconcileApp', presented, app]); return { agentId: AGENT_ID, app: RECONCILED }; };
  const state = createMcpState({ client, cwd: root, env: claimEnv(root) });
  const { isError } = await callTool(state, 'bind', { transcript_id: 'session-later' });
  assert.equal(isError, false);
  assert.deepEqual(client.calls.find(([name]) => name === 'reconcileApp'), ['reconcileApp', secret, 'you-codex-agent']);
  assert.equal(git(root, 'config', '--worktree', 'agentBot.app'), 'you-codex-agent');

  // A daemon that cannot reconcile leaves the live binding usable.
  client.reconcileApp = async () => { throw new Error('daemon POST /v0/binding/app failed: HTTP 404'); };
  const again = await callTool(createMcpState({ client, cwd: root, env: claimEnv(root) }), 'bind', { transcript_id: 'session-later' });
  assert.equal(again.isError, false);
});

test('tools/list returns exactly the four meta-tools', async () => {
  const state = createMcpState({ client: fakeClient() });
  const listed = await handleMcpMessage(state, request(2, 'tools/list'));
  const names = listed.result.tools.map((t) => t.name);
  assert.deepEqual(names, ['search_tools', 'describe_tool', 'call_tool', 'call_write_tool']);
});

test('search_tools ranks a matching tool and returns one-line descriptions only', async () => {
  const state = createMcpState({ client: fakeClient() });
  const { text } = await callTool(state, 'search_tools', { query: 'who am i' });
  const hits = JSON.parse(text);
  assert.equal(hits[0].name, 'whoami');
  for (const hit of hits) {
    assert.deepEqual(Object.keys(hit), ['name', 'desc']);
    assert.ok(!hit.desc.includes('\n'));
  }
  const all = JSON.parse((await callTool(state, 'search_tools', {})).text);
  assert.ok(all.some((h) => h.name === 'bind') && all.some((h) => h.name === 'doctor'));
});

test('describe_tool returns schema and class; unknown names fail', async () => {
  const state = createMcpState({ client: fakeClient() });
  const who = JSON.parse((await callTool(state, 'describe_tool', { name: 'whoami' })).text);
  assert.equal(who.class, 'read');
  assert.equal(who.inputSchema.type, 'object');
  const bind = JSON.parse((await callTool(state, 'describe_tool', { name: 'bind' })).text);
  assert.equal(bind.class, 'write');
  const bad = await callTool(state, 'describe_tool', { name: 'nope' });
  assert.equal(bad.isError, true);
  assert.match(bad.text, /unknown-tool/);
});

test('call_tool runs a read tool; whoami reports unbound as before', async () => {
  const { root } = scratchRepo();
  const state = createMcpState({ client: fakeClient(), cwd: root });
  const { text } = await callTool(state, 'call_tool', { name: 'whoami' });
  assert.match(text, /not bound|binding/);
});

test('call_tool refuses a write tool without consuming the bind token', async () => {
  const { root, gitDir } = scratchRepo();
  mintBindToken({ gitDir, worktree: root, agentId: AGENT_ID });
  const state = createMcpState({ client: fakeClient(), cwd: root });
  const refused = await callTool(state, 'call_tool', { name: 'bind', arguments: { transcript_id: 'x' } });
  assert.equal(refused.isError, true);
  assert.match(refused.text, /use-call-write-tool/);
  assert.ok(readBindToken(gitDir), 'bind token must still be in place');
});

test('call_write_tool refuses a read tool', async () => {
  const state = createMcpState({ client: fakeClient() });
  const refused = await callTool(state, 'call_write_tool', { name: 'whoami' });
  assert.equal(refused.isError, true);
  assert.match(refused.text, /use-call-tool/);
});

test('call_write_tool runs bind; a legacy direct tools/call still works', async () => {
  const { root, gitDir } = scratchRepo();
  mintBindToken({ gitDir, worktree: root, agentId: AGENT_ID });
  const state = createMcpState({ client: fakeClient(), cwd: root });
  const via = await callTool(state, 'call_write_tool', { name: 'bind', arguments: { transcript_id: 's1' } });
  assert.equal(via.isError, false);
  assert.match(via.text, /agentId/);
  const state2 = createMcpState({ client: fakeClient(), cwd: root });
  mintBindToken({ gitDir, worktree: root, agentId: AGENT_ID });
  const legacy = await callTool(state2, 'bind', { transcript_id: 's2' });
  assert.equal(legacy.isError, false);
});

test('initialize instructions name the version and the write caller', async () => {
  const state = createMcpState({ client: fakeClient() });
  const init = await handleMcpMessage(state, request(1, 'initialize', { protocolVersion: '2025-06-18' }));
  const pkg = JSON.parse(execFileSync('node', ['-e', 'process.stdout.write(require("fs").readFileSync("package.json","utf8"))'], { encoding: 'utf8' }));
  assert.match(init.result.instructions, new RegExp(pkg.version.replace(/\./g, '\\.')));
  assert.match(init.result.instructions, /call_write_tool/);
});

test('doctor and server_status return JSON without secret material', async () => {
  const { root } = scratchRepo();
  const stateDir = path.join(root, 'state');
  writeFileSync(path.join(root, 'cfg.json'), '{}\n');
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(path.join(stateDir, 'device.json'), JSON.stringify({ device_id: 'dev-1', device_name: 'studio-mac', harnesses: ['claude'] }));
  const env = { PATH: process.env.PATH, HOME: root, AGENT_BOT_SERVER: 'https://agents.true-line.ai', AGENT_BOT_SERVER_STATE: stateDir };
  const state = createMcpState({ client: fakeClient(), cwd: root, home: root, env });
  const status = await callTool(state, 'server_status');
  const report = JSON.parse(status.text);
  assert.equal(report.server_mode, true);
  assert.equal(report.enrolled, true);
  assert.equal(report.device_id, 'dev-1');
  assert.equal(report.device_name, 'studio-mac');
  // doctor.mjs exits non-zero on a not-ready machine yet still prints JSON;
  // a real subprocess is the coverage — the tool must read stdout, not throw.
  const doc = await callTool(state, 'call_tool', { name: 'doctor' });
  assert.equal(doc.isError, false, doc.text);
  const dreport = JSON.parse(doc.text);
  assert.equal(dreport.ready, false);
  assert.ok(dreport.first_actionable_failure, 'a not-ready fixture must name a failing check');
  for (const text of [status.text, doc.text]) {
    // No secret-shaped material: key material, PEM blocks, or credential
    // values. Field names and prose may say "token"/"secret" legitimately.
    assert.doesNotMatch(text, /ghs_|ghp_|github_pat|BEGIN [A-Z ]*PRIVATE KEY|private_key|\.pem/i);
    for (const key of text.match(/"([a-z_]+)":/gi) ?? []) {
      assert.doesNotMatch(key, /token|secret|private|pem/i);
    }
  }
});

test('guide resolves topics through the same map the CLI --for uses', async () => {
  const state = createMcpState({ client: fakeClient() });
  const def = JSON.parse((await callTool(state, 'call_tool', { name: 'guide' })).text);
  assert.match(def.text, /Route the request/);
  for (const topic of Object.keys(SKILL_REFERENCES)) {
    const hit = JSON.parse((await callTool(state, 'call_tool', { name: 'guide', arguments: { topic } })).text);
    assert.equal(hit.reference, SKILL_REFERENCES[topic], topic);
  }
  const bad = await callTool(state, 'call_tool', { name: 'guide', arguments: { topic: 'join' } });
  assert.equal(bad.isError, true);
  assert.match(bad.text, /unknown-topic/);
});
