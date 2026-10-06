import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { populationFile, recordSoulLaunch, setSoulComputerUse, showSoul, soulComputerUse, upsertSoul } from '../agent-population.mjs';
import { soulComputerUseCommand } from '../soul-computer-use.mjs';
import { createDaemonServer, daemonClient, daemonStateFile, withPermissionReceipts } from '../agent-daemon.mjs';
import { auditFile } from '../agent-principals.mjs';
import { createComputerUseActivity } from '../computer-use-activity.mjs';
import { createContractExecutor } from '../executor-contract.mjs';
import { createTurnRegistry, coldTurnExecutor } from '../wake-plane.mjs';
import { assertOwnerAction } from '../owner-gate.mjs';

const ID = 'agent_11111111-1111-4111-8111-111111111111';
const OTHER = 'agent_22222222-2222-4222-8222-222222222222';
const TOOL = 'mcp__computer-use__left_click';
const AT = '2026-10-06T12:00:00.000Z';
const cli = fileURLToPath(new URL('../agent-bot.mjs', import.meta.url));
const principal = { principal: 'test-owner', secret: 'synthetic-test-value', brokerUid: 1234 };

function fixture(t) {
  const home = mkdtempSync(path.join(tmpdir(), 'soul-computer-use-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const env = { HOME: home, PATH: process.env.PATH, XDG_STATE_HOME: path.join(home, 'state'),
    AGENT_BOT_CONFIG: path.join(home, 'config.json'), AGENT_BOT_POPULATION_PATH: path.join(home, 'population.json'),
    AGENT_BOT_DAEMON_STATE_PATH: path.join(home, 'daemon.json'), AGENT_BOT_INTERACTION_HOME: path.join(home, 'interaction'),
    GIT_CONFIG_COUNT: '0', GIT_CONFIG_NOSYSTEM: '1' };
  const file = populationFile({ env, home });
  const record = { id: ID, name: 'bill', displayName: 'Bill - Starter', status: 'active', spacePath: home };
  upsertSoul(record, { file });
  const out = [], gates = [];
  const opts = { env, home, cwd: home, now: () => new Date(AT), write: (text) => out.push(text),
    gate: async (action, input) => { gates.push({ action, ...input }); return { method: 'consent' }; },
    client: { available: async () => false } };
  return { ...opts, opts, file, record, out, gates,
    invoke: (...args) => promisify(execFile)(process.execPath, [cli, ...args], { env, cwd: home }),
    receipts: () => existsSync(auditFile(opts)) ? readFileSync(auditFile(opts), 'utf8').trim().split('\n').map(JSON.parse) : [],
  };
}

async function serve(t, f, overrides = {}) {
  const computerUse = createComputerUseActivity({ now: f.now });
  const turns = createTurnRegistry();
  const server = createDaemonServer({ ...f, config: {}, computerUse, turns, settingGate: f.gate, ...overrides });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  writeFileSync(daemonStateFile(f), JSON.stringify({ schemaVersion: 1, pid: process.pid,
    host: '127.0.0.1', port: server.address().port, token: server.token, startedAt: AT }), { mode: 0o600 });
  const request = (pathname, body, token = server.token) => fetch(`http://127.0.0.1:${server.address().port}${pathname}`, {
    method: body === undefined ? 'GET' : 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { server, turns, computerUse, request, client: daemonClient(f) };
}

function contract(run, { mode = 'safe', policy = 'approval' } = {}) {
  return createContractExecutor({ harness: 'claude', identity: { agentId: ID }, mode,
    policy: { version: 1, rules: [], fallback: policy },
    run: async (ports) => { const result = await run(ports); ports.emitStop({ stopReason: 'end_turn' }); return result; } });
}
const port = (overrides = {}) => ({ invocation: { agentId: ID }, message: 'go', attachments: [],
  signal: new AbortController().signal, appendEvent: () => ({}), addArtifact: () => ({}),
  requestApproval: () => assert.fail('must not prompt'), ...overrides });

test('population defaults legacy records on, preserves off through upserts/launches, and validates writes', (t) => {
  const f = fixture(t);
  const stored = JSON.parse(readFileSync(f.file));
  delete stored.souls[ID].computerUse;
  writeFileSync(f.file, JSON.stringify(stored));
  const before = readFileSync(f.file, 'utf8');
  assert.equal(showSoul(ID, f).computerUse, true);
  assert.equal(soulComputerUse(ID, f), true);
  assert.equal(soulComputerUse(OTHER, f), true);
  assert.equal(readFileSync(f.file, 'utf8'), before);
  setSoulComputerUse(ID, false, f);
  upsertSoul(f.record, f);
  recordSoulLaunch(ID, { comms: false }, f);
  assert.equal(showSoul(ID, f).computerUse, false);
  assert.equal(JSON.parse(readFileSync(f.file)).souls[ID].computerUse, false);
  for (const value of [null, 'false', 0]) {
    assert.throws(() => setSoulComputerUse(ID, value, f), /boolean/);
    if (value !== null) assert.throws(() => upsertSoul({ ...f.record, computerUse: value }, f), /boolean/);
  }
  assert.throws(() => setSoulComputerUse(OTHER, false, f), /no population record/);
  assert.throws(() => setSoulComputerUse('../invalid', false, f), /Agent ID/);
  stored.schemaVersion = 2;
  writeFileSync(f.file, JSON.stringify(stored));
  assert.throws(() => setSoulComputerUse(ID, false, f), /future schemaVersion/);
  writeFileSync(f.file, 'broken');
  assert.throws(() => soulComputerUse(ID, f), /not valid JSON/);
});

test('CLI resolves IDs and names, defaults to show, gates changes and forwards presented principals', async (t) => {
  const f = fixture(t);
  await soulComputerUseCommand([ID], f.opts);
  assert.equal(f.out.pop(), 'computer use: on\n');
  for (const target of [ID, 'bill', 'Bill - Starter']) {
    const { stdout } = await f.invoke('soul', 'computer-use', target, '--json');
    assert.deepEqual(JSON.parse(stdout), { agentId: ID, computerUse: true });
  }
  assert.equal(f.gates.length, 0);
  await soulComputerUseCommand(['Bill - Starter', 'off', '--json', '--principal-stdin'], {
    ...f.opts, readStdin: () => JSON.stringify(principal),
  });
  assert.deepEqual(JSON.parse(f.out.pop()), { agentId: ID, computerUse: false });
  assert.deepEqual(f.gates[0].principal, principal);
  assert.equal(f.gates[0].action, `switch ${ID} computer use off`);
  await soulComputerUseCommand(['bill', 'on'], f.opts);
  assert.equal(f.out.pop(), 'computer use: on\n');
  assert.deepEqual(f.receipts().map(({ event, decision }) => ({ event, decision })), [
    { event: 'computer-use', decision: 'off' }, { event: 'computer-use', decision: 'on' },
  ]);
});

test('CLI invalid input, soul callers and refused owner gate leave population and receipts unchanged', async (t) => {
  const f = fixture(t);
  const before = readFileSync(f.file, 'utf8');
  for (const args of [[], [ID, 'auto'], [ID, 'show', '--principal-stdin'], [ID, '--json', '--json'],
    [ID, 'off', '--principal-stdin', '--principal-stdin'], [ID, 'off', 'extra']]) {
    await assert.rejects(soulComputerUseCommand(args, f.opts), /usage/);
  }
  await assert.rejects(soulComputerUseCommand([ID, 'off', '--principal-stdin'], {
    ...f.opts, readStdin: () => 'broken',
  }), /JSON on stdin/);
  await assert.rejects(soulComputerUseCommand([ID, 'off'], { ...f.opts,
    gate: async () => { throw new Error('cancelled'); },
  }), /cancelled/);
  await assert.rejects(soulComputerUseCommand([ID, 'off'], { ...f.opts,
    env: { ...f.env, AGENT_BOT_ID: ID },
    client: { available: () => assert.fail('soul caller must be refused before daemon access') },
  }), /owner only/);
  await assert.rejects(f.invoke('soul', 'computer-use', ID, 'invalid', '--json'), (error) => {
    assert.equal(error.code, 1);
    assert.equal(error.stderr, '');
    assert.equal(JSON.parse(error.stdout).error.code, 'soul-computer-use-failed');
    return true;
  });
  assert.equal(readFileSync(f.file, 'utf8'), before);
  assert.deepEqual(f.receipts(), []);
});

for (const mode of ['safe', 'autopilot']) {
  for (const policy of ['allow', 'approval', 'deny']) {
    test(`${mode}/${policy}: off overrides computer tools without prompting and leaves other tools unchanged`, async (t) => {
      const f = fixture(t);
      setSoulComputerUse(ID, false, f);
      const computerUse = createComputerUseActivity();
      const tools = [TOOL, 'screenshot', 'mcp__remote-devices__computer_click', 'mcp__computer-use__read_screen'];
      let prompts = 0;
      const seen = [];
      await withPermissionReceipts(contract(async ({ requestPermission }) => {
        for (const toolName of tools) assert.deepEqual(await requestPermission({ toolName }), { outcome: 'deny', decidedBy: 'computer-use' });
        assert.equal((await requestPermission({ toolName: 'Bash' })).outcome, policy === 'deny' ? 'deny' : 'allow');
      }, { mode, policy }), { ...f, computerUse })(port({
        onPermission: (record) => seen.push(record), requestApproval: async () => { prompts++; return { decision: 'approve' }; },
      }));
      assert.equal(prompts, mode === 'safe' && policy === 'approval' ? 1 : 0);
      assert.equal(seen.length, tools.length + 1);
      assert.deepEqual(computerUse.list(), []);
      assert.deepEqual(f.receipts().filter((row) => row.event === 'computer-use').map((row) => row.decision), tools.map(() => 'off'));
    });
  }
}

test('existing turns reread the switch, including after a pending approval, and resume normally after on', async (t) => {
  const f = fixture(t);
  let prompts = 0;
  await withPermissionReceipts(contract(async ({ requestPermission }) => {
    // Approval starts with the switch on; the owner changes it before replying.
    assert.equal((await requestPermission({ toolName: TOOL })).decidedBy, 'computer-use');
    assert.equal((await requestPermission({ toolName: TOOL })).decidedBy, 'computer-use');
    setSoulComputerUse(ID, true, f);
    assert.equal((await requestPermission({ toolName: TOOL })).outcome, 'allow');
    setSoulComputerUse(ID, false, f);
    assert.equal((await requestPermission({ toolName: TOOL })).decidedBy, 'computer-use');
  }), f)(port({ requestApproval: async () => {
    if (prompts++ === 0) setSoulComputerUse(ID, false, f);
    return { decision: 'approve' };
  } }));
  assert.equal(prompts, 2);
});

test('cold turns enforce off and report the denied tool', async (t) => {
  const f = fixture(t);
  setSoulComputerUse(ID, false, f);
  const run = coldTurnExecutor({ executorFor: () => withPermissionReceipts(contract(async ({ requestPermission }) => {
    await requestPermission({ toolName: TOOL });
  }, { mode: 'autopilot' }), f), approvals: () => assert.fail('must not prompt') });
  const result = await run({ invocation: { agentId: ID, harness: 'claude', cwd: f.home }, message: 'go', attachments: [], env: f.env });
  assert.deepEqual(result.denied, [TOOL]);
  assert.equal(f.receipts()[0].decision, 'off');
});

test('daemon validates token, soul and boolean; refused setting gate writes nothing', async (t) => {
  const f = fixture(t);
  const d = await serve(t, f, { settingGate: async () => { throw new Error('cancelled'); } });
  assert.equal((await d.request('/v0/soul/computer-use', { agentId: ID, enabled: false }, 'bad')).status, 401);
  assert.equal((await d.request('/v0/soul/computer-use', { agentId: OTHER, enabled: false })).status, 404);
  for (const enabled of [undefined, null, 'false', 0]) assert.equal((await d.request('/v0/soul/computer-use', { agentId: ID, enabled })).status, 400);
  assert.equal((await d.request('/v0/soul/computer-use', { agentId: 'bad', enabled: false })).status, 400);
  await assert.rejects(d.client.setComputerUse(ID, false), /cancelled/);
  assert.equal(showSoul(ID, f).computerUse, true);
  assert.deepEqual(f.receipts(), []);
});

test('daemon accepts presented principal through the mode owner gate without asking for presence', async (t) => {
  const f = fixture(t);
  const d = await serve(t, f, { settingGate: (action, { principal: credential }) => assertOwnerAction(action, {
    env: f.env, cwd: f.home, detect: false, principal: credential,
    verifyPrincipal: async (value) => { assert.deepEqual(value, principal); return { method: 'principal', principal: value.principal }; },
    consent: () => assert.fail('valid principal replaces presence like soul mode'),
  }) });
  assert.deepEqual(await d.client.setComputerUse(ID, false, { principal }), { agentId: ID, computerUse: false });
});

test('CLI uses daemon gate once; off stops all active soul turns, releases activity, and appears in JSON views', async (t) => {
  const f = fixture(t);
  const d = await serve(t, f);
  const other = new AbortController();
  const releaseOther = d.turns.track(OTHER, other);
  t.after(releaseOther);
  let ready;
  const entered = new Promise((resolve) => { ready = resolve; });
  let count = 0;
  const execute = () => d.turns.run(port(), withPermissionReceipts(contract(async ({ requestPermission, signal }) => {
    assert.equal((await requestPermission({ toolName: TOOL })).outcome, 'allow');
    if (++count === 2) ready();
    await new Promise((resolve) => signal.addEventListener('abort', resolve, { once: true }));
  }, { policy: 'allow' }), { ...f, computerUse: d.computerUse }));
  const running = [execute(), execute()];
  const cancelled = Promise.all(running.map((promise) => assert.rejects(promise, { name: 'AbortError' })));
  await entered;
  await soulComputerUseCommand(['bill', 'off', '--json', '--principal-stdin'], { ...f.opts, client: d.client,
    readStdin: () => JSON.stringify(principal), gate: () => assert.fail('daemon owns the gate'),
  });
  assert.deepEqual(JSON.parse(f.out.pop()), { agentId: ID, computerUse: false, stopped: true });
  await cancelled;
  assert.equal(other.signal.aborted, false);
  assert.deepEqual(d.computerUse.list(), []);
  assert.equal(f.gates.length, 1);
  assert.deepEqual(f.gates[0].principal, principal);
  assert.equal((await (await d.request('/v0/health')).json()).souls[0].computerUse, false);
  for (const args of [['soul', 'show', ID, '--json'], ['population', 'list', '--json'], ['daemon', 'status', '--json']]) {
    const result = JSON.parse((await f.invoke(...args)).stdout);
    assert.equal((result.souls?.[0] ?? (Array.isArray(result) ? result[0] : result)).computerUse, false);
  }
  assert.deepEqual(await d.client.setComputerUse(ID, true), { agentId: ID, computerUse: true });
  assert.deepEqual(f.receipts().filter((r) => r.operation === 'set').map((r) => r.decision), ['off', 'on']);
});

test('off leaves non-computer turns running and CLI never falls back after daemon refusal', async (t) => {
  const f = fixture(t);
  const d = await serve(t, f);
  const controller = new AbortController();
  const release = d.turns.track(ID, controller);
  t.after(release);
  assert.deepEqual(await d.client.setComputerUse(ID, false), { agentId: ID, computerUse: false });
  assert.equal(controller.signal.aborted, false);
  await assert.rejects(soulComputerUseCommand([ID, 'on'], { ...f.opts, client: {
    available: async () => true, setComputerUse: async () => { throw new Error('refused'); },
  }, gate: () => assert.fail('must not fall back') }), /refused/);
  assert.equal(showSoul(ID, f).computerUse, false);
});
