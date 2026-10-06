import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createDaemonServer, daemonClient, withPermissionReceipts } from '../agent-daemon.mjs';
import { createTurnRegistry, createWakePlane } from '../wake-plane.mjs';
import { createAcpExecutor } from '../acp-engine.mjs';
import { createLaunchHandler } from '../daemon-launch.mjs';
import { upsertSoul } from '../agent-population.mjs';
import { appendAuditReceipt, enrollPrincipal, bindTransport, authorizeSouls, setOperations } from '../agent-principals.mjs';
import { soulStopCommand } from '../soul-stop.mjs';
import { parseAgentBotArgs } from '../cli/parse.mjs';
import { createResumeExecutor, runProcess } from '../wake-resume.mjs';

const ID = 'agent_66666666-6666-4666-8666-666666666666';
const OTHER = 'agent_77777777-7777-4777-8777-777777777777';
const fake = fileURLToPath(new URL('./fixtures/fake-acp-agent.mjs', import.meta.url));
const cli = fileURLToPath(new URL('../agent-bot.mjs', import.meta.url));
const delay = () => new Promise((resolve) => setTimeout(resolve, 10));
async function until(check) {
  const deadline = Date.now() + 10_000;
  while (!await check()) {
    assert.ok(Date.now() < deadline, 'timed out waiting for turn');
    await delay();
  }
}

async function fixture(t) {
  const home = mkdtempSync(path.join(tmpdir(), 'soul-stop-'));
  const env = { HOME: home, PATH: process.env.PATH, XDG_STATE_HOME: path.join(home, 'state'),
    AGENT_BOT_POPULATION_PATH: path.join(home, 'population.json'), AGENT_BOT_INTERACTION_HOME: path.join(home, 'interaction'),
    AGENT_BOT_PRINCIPALS_PATH: path.join(home, 'principals.json'), AGENT_BOT_DAEMON_STATE_PATH: path.join(home, 'daemon.json'),
    FAKE_CANCEL_FILE: path.join(home, 'cancelled') };
  upsertSoul({ id: ID, name: 'stop-me', status: 'active', spacePath: home }, { file: env.AGENT_BOT_POPULATION_PATH });
  const turns = createTurnRegistry();
  let ready = 0;
  const engine = createAcpExecutor({ harness: 'claude', identity: { agentId: ID }, cwd: home, env,
    policy: { version: 1, rules: [], fallback: 'deny' },
    registry: { claude: { harness: 'claude', enabled: true, command: process.execPath, args: [fake], stripEnv: [] } } });
  const executor = withPermissionReceipts((input) => engine({ ...input, appendEvent: (type, data) => {
    if (data?.content?.text?.startsWith('pid:')) ready += 1;
    return input.appendEvent(type, data);
  } }), { env, home });
  const server = createDaemonServer({ env, home, config: {}, turns, executor,
    ownerGate: () => { assert.fail('stop must not ask for owner presence'); } });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  writeFileSync(env.AGENT_BOT_DAEMON_STATE_PATH, JSON.stringify({ schemaVersion: 1, pid: process.pid,
    host: '127.0.0.1', port: server.address().port, token: server.token, startedAt: new Date().toISOString() }));
  const url = `http://127.0.0.1:${server.address().port}`;
  const client = daemonClient({ env, home, cwd: home });
  t.after(async () => {
    turns.stop(ID);
    await until(() => !turns.busy().length);
    await new Promise((resolve) => server.close(resolve));
    rmSync(home, { recursive: true, force: true });
  });
  const receipts = () => readFileSync(path.join(env.AGENT_BOT_INTERACTION_HOME, 'audit.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  return { home, env, turns, executor, server, url, client, receipts, ready: () => ready };
}

test('stop cold wake reaches fake ACP cancel, records cancellation, clears busy, and allows another wake', async (t) => {
  const f = await fixture(t);
  let first = true;
  const plane = createWakePlane({ turns: f.turns, pool: { has: () => false, send: () => 0 }, settings: { [ID]: true },
    lookupSoul: () => ({ worktree: f.home, file: path.join(f.home, 'binding.json') }), identities: () => ({ harness: 'claude' }),
    executorFor: () => (input) => { const message = first ? 'hang' : 'ping'; first = false; return f.executor({ ...input, message }); },
    receipt: (record) => appendAuditReceipt(record, f) });
  f.server.wakePlane = plane;
  const wake = { event: 'wake', agentId: ID, count: 1, cursor: 1, messageIds: ['m1'] };
  const ports = { report: async () => {} };
  await plane(wake, ports);
  await until(() => f.ready() === 1);
  assert.deepEqual(plane.busy(), [ID]);
  assert.deepEqual(await f.client.stopSoul(ID), { agentId: ID, stopped: true });
  await plane.idle();
  assert.equal(readFileSync(f.env.FAKE_CANCEL_FILE, 'utf8'), 'cancelled\n');
  assert.deepEqual(plane.busy(), []);
  assert.ok(f.receipts().some((r) => r.event === 'cold-wake' && r.decision === 'cancelled'));
  assert.ok(f.receipts().some((r) => r.event === 'stop' && r.agentId === ID && r.transport === 'owner' && r.decision === 'stopped'));
  assert.deepEqual(await f.client.stopSoul(ID), { agentId: ID, stopped: false, reason: 'idle' });
  await plane({ ...wake, cursor: 2, messageIds: ['m2'] }, ports);
  await plane.idle();
  assert.ok(f.receipts().some((r) => r.event === 'cold-wake' && r.decision === 'finished'));
  assert.deepEqual(plane.busy(), []);
});

test('stop launch uses the shared registry after session readiness', async (t) => {
  const f = await fixture(t);
  const launch = createLaunchHandler({ file: path.join(f.home, 'launch.json'), turns: f.turns,
    identities: () => ({ id: ID }), lookupBinding: () => ({ worktree: f.home, file: path.join(f.home, 'binding.json') }),
    executorFor: () => (input) => f.executor({ ...input, message: 'hang' }) });
  await launch({ requestId: 'r1', account: 'owner', soul: ID, harness: 'claude' }, { account: 'owner', report: async () => {} });
  await until(() => f.ready() === 1);
  const health = await fetch(`${f.url}/v0/health`, { headers: { authorization: `Bearer ${f.server.token}` } }).then((r) => r.json());
  assert.deepEqual(health.busy, [ID]);
  assert.deepEqual(await f.client.stopSoul(ID), { agentId: ID, stopped: true });
  await until(() => !f.turns.busy().length);
  assert.equal(readFileSync(f.env.FAKE_CANCEL_FILE, 'utf8'), 'cancelled\n');
});

test('stop on the resume lane forwards abort to the harness process', async (t) => {
  const f = await fixture(t);
  const resumeExecutor = createResumeExecutor({ baseEnv: f.env, home: f.home, sessions: { get: () => 'session-id' },
    run: (_command, _args, options) => runProcess(process.execPath, ['-e',
      'require("node:fs").writeFileSync(process.env.FAKE_CANCEL_FILE, "ready"); setInterval(() => {}, 1000);'], options) });
  const plane = createWakePlane({ turns: f.turns, pool: { has: () => false, send: () => 0 },
    settings: { [ID]: { lane: 'resume', policy: 'read-only' } },
    lookupSoul: () => ({ worktree: f.home, file: path.join(f.home, 'binding.json') }),
    identities: () => ({ harness: 'codex' }), resumeExecutor,
    receipt: (record) => appendAuditReceipt(record, f) });
  await plane({ event: 'wake', agentId: ID, count: 1, cursor: 1, messageIds: ['m1'] }, { report: async () => {} });
  await until(() => existsSync(f.env.FAKE_CANCEL_FILE));
  assert.equal(plane.stop(ID), true);
  await plane.idle();
  assert.deepEqual(plane.busy(), []);
  assert.ok(f.receipts().some((r) => r.event === 'cold-wake' && r.decision === 'cancelled'));
});

test('principal stop cancels interactive invocation and attributes its receipt', async (t) => {
  const f = await fixture(t);
  const options = { env: f.env, home: f.home, file: f.env.AGENT_BOT_PRINCIPALS_PATH };
  const principal = enrollPrincipal({ label: 'owner' }, options);
  bindTransport(principal.principalId, { transport: 'cli', providerId: 'local' }, options);
  authorizeSouls(principal.principalId, [ID], options);
  setOperations(principal.principalId, ['message', 'observe', 'cancel'], options);
  const requester = { transport: 'cli', providerId: 'local' };
  const { session } = await f.client.createSession({ ...requester, agentId: ID });
  const { invocation } = await f.client.submitMessage(session.sessionId, { ...requester, message: 'hang', idempotencyKey: 'one' });
  await until(() => f.ready() === 1);
  assert.deepEqual(await f.client.stopSoul(ID, requester), { agentId: ID, stopped: true });
  await until(async () => (await f.client.invocation(invocation.invocationId, requester)).invocation.status === 'cancelled');
  assert.deepEqual(f.turns.busy(), []);
  assert.ok(f.receipts().some((r) => r.event === 'stop' && r.principalId === principal.principalId && r.transport === 'cli'));
  await assert.rejects(f.client.stopSoul(OTHER, requester), /not authorized/);
  setOperations(principal.principalId, ['observe'], options);
  await assert.rejects(f.client.stopSoul(ID, requester), /not authorized/);
});

test('stop route requires daemon token and returns stable unknown-soul and invalid-id errors', async (t) => {
  const f = await fixture(t);
  const post = (body, token) => fetch(`${f.url}/v0/soul/stop`, { method: 'POST', headers: { 'content-type': 'application/json',
    ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body) });
  assert.equal((await post({ agentId: ID })).status, 401);
  const missing = await post({ agentId: OTHER }, f.server.token);
  assert.equal(missing.status, 404);
  assert.deepEqual(await missing.json(), { error: 'unknown soul' });
  assert.equal((await post({ agentId: 'invalid' }, f.server.token)).status, 400);
  assert.deepEqual(await f.client.stopSoul(ID), { agentId: ID, stopped: false, reason: 'idle' });
  assert.equal(f.receipts().at(-1).decision, 'idle');
});

test('CLI parses and dispatches soul stop, resolves names, and prints one line or JSON', async (t) => {
  const f = await fixture(t);
  assert.deepEqual(parseAgentBotArgs(['soul', 'stop', 'stop-me', '--json']), {
    kind: 'command', command: 'soul', args: ['stop', 'stop-me', '--json'] });
  const lines = [];
  const options = { ...f, cwd: f.home, write: (text) => lines.push(text) };
  await soulStopCommand(['stop-me', '--json'], options);
  assert.deepEqual(JSON.parse(lines.pop()), { agentId: ID, stopped: false, reason: 'idle' });
  await soulStopCommand([ID], options);
  assert.equal(lines.pop(), `${ID} idle\n`);
  for (const args of [[], [ID, 'extra'], ['--unknown']]) await assert.rejects(soulStopCommand(args, options), /usage:/);
  await assert.rejects(soulStopCommand([ID], { ...options, env: { ...f.env, AGENT_BOT_ID: ID } }), { code: 'not-owner' });
  const parsed = spawnSync(process.execPath, [cli, 'soul', 'stop'], { env: f.env, cwd: f.home, encoding: 'utf8' });
  assert.equal(parsed.status, 1);
  assert.match(parsed.stderr, /usage: agent-bot soul stop/);
  rmSync(f.env.AGENT_BOT_DAEMON_STATE_PATH);
  await assert.rejects(soulStopCommand([ID], { ...options, client: daemonClient(f) }), /daemon is not running \(no state file\)/);
});

test('registry keeps overlapping turns until they settle and retains turn timeouts', async () => {
  const turns = createTurnRegistry();
  const first = new AbortController();
  const second = new AbortController();
  const releaseFirst = turns.track(ID, first);
  const releaseSecond = turns.track(ID, second);
  assert.equal(turns.stop(OTHER), false);
  assert.equal(turns.stop(ID), true);
  assert.equal(first.signal.aborted, true);
  assert.equal(second.signal.aborted, true);
  assert.equal(turns.stop(ID), false);
  releaseFirst();
  assert.deepEqual(turns.busy(), [ID]);
  releaseSecond();
  assert.deepEqual(turns.busy(), []);
  // Keep the event loop alive: AbortSignal.timeout deliberately unrefs its timer.
  const keepAlive = setInterval(() => {}, 100);
  try {
    await assert.rejects(turns.run({ invocation: { agentId: ID } }, ({ signal }) =>
      new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true })),
    { turnTimeoutMs: 5 }), { name: 'AbortError' });
    assert.deepEqual(turns.busy(), []);
  } finally { clearInterval(keepAlive); }
});
