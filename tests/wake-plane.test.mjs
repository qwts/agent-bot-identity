import test from 'node:test';
import assert from 'node:assert/strict';

import { acpExecutorFor, coldTurnExecutor, createWakePlane } from '../wake-plane.mjs';
import { HARNESS_SESSION_EVENT, UPDATE_EVENT } from '../executor-contract.mjs';

const ID = 'agent_66666666-6666-4666-8666-666666666666';
const soul = { agentId: ID, worktree: '/work/tree', gitDir: '/work/tree/.git', file: '/work/tree/.git/agent-binding.json' };
const coldPool = { has: () => false, send: () => 0 };

test('ACP factory supplies fresh identity to every new session, including later cold turns', async (t) => {
  const { mkdtempSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { default: path } = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const { createAcpExecutor } = await import('../acp-engine.mjs');
  const { soulPromptIdentity } = await import('../agent-daemon.mjs');
  const { recordSoulDisplayName, upsertSoul } = await import('../agent-population.mjs');
  const home = mkdtempSync(path.join(tmpdir(), 'wake-identity-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const env = { HOME: home, AGENT_BOT_POPULATION_PATH: path.join(home, 'population.json') };
  const registry = { claude: { harness: 'claude', enabled: true, command: process.execPath,
    args: [fileURLToPath(new URL('./fixtures/fake-acp-agent.mjs', import.meta.url))], stripEnv: [] } };
  upsertSoul({ id: ID, displayName: 'VMThree', status: 'active', spacePath: home }, { file: env.AGENT_BOT_POPULATION_PATH });
  const factory = acpExecutorFor({ identities: () => ({}), baseEnv: env, policy: { version: 1, rules: [], fallback: 'deny' },
    identityFor: (id) => soulPromptIdentity(id, { env, home }),
    createExecutor: (options) => createAcpExecutor({ ...options, registry }),
  });
  const executor = factory({ agentId: ID, harness: 'claude', cwd: home, env: {} });
  const observed = [];
  const input = { invocation: { agentId: ID }, message: 'ping', attachments: [],
    appendEvent: (_type, data) => { if (data.content?.text) observed.push(data.content.text); return {}; },
    addArtifact: () => ({}), signal: new AbortController().signal, requestApproval: async () => ({ decision: 'deny' }) };
  await executor(input);
  recordSoulDisplayName(ID, 'Renamed', { file: env.AGENT_BOT_POPULATION_PATH });
  await executor(input);
  assert.deepEqual(observed, ['VMThree', 'Renamed'].map((name) =>
    `pong: [agent-bot] You are ${name} (agent id ${ID}). You have no parent agent.\n\nping`));
});

function plane({ pool = coldPool, settings = { [ID]: true }, executorFor = null, receipts = [] } = {}) {
  return createWakePlane({
    pool,
    settings,
    lookupSoul: () => soul,
    identities: () => ({ harness: 'codex', github: { appSlug: 'you-codex-agent' } }),
    executorFor,
    receipt: (record) => receipts.push(record),
  });
}

function wake(messageIds = ['m1']) {
  return { event: 'wake', agentId: ID, count: messageIds.length, cursor: 1, messageIds };
}

test('a warm socket takes the wake and the broker hears warm', async () => {
  const frames = [];
  const reports = [];
  const onWake = plane({ pool: { has: () => true, send: (_id, frame) => { frames.push(frame); return 1; } } });
  await onWake(wake(), { report: async (fields) => reports.push(fields) });
  assert.equal(frames.length, 1);
  assert.equal(reports[0].outcome, 'warm');
  assert.deepEqual(reports[0].messageIds, ['m1']);
});

test('without an executor, or with cold wake off, a cold soul waits', async () => {
  const reports = [];
  const report = async (fields) => reports.push(fields);
  await plane()(wake(), { report });
  let started = 0;
  await plane({ settings: {}, executorFor: () => async () => { started += 1; } })(wake(), { report });
  assert.deepEqual(reports.map((r) => r.outcome), ['waiting', 'waiting']);
  assert.equal(started, 0);
});

test('with cold wake on, one turn starts in the worktree with the soul\'s binding', async () => {
  const reports = [];
  const receipts = [];
  let built;
  let input;
  let finish;
  const onWake = plane({
    receipts,
    executorFor: (options) => {
      built = options;
      return async (value) => { input = value; await new Promise((resolve) => { finish = resolve; }); };
    },
  });
  const report = async (fields) => reports.push(fields);
  await onWake(wake(['m1', 'm2']), { report });
  await onWake(wake(['m3']), { report });
  assert.deepEqual(reports.map((r) => r.outcome), ['cold', 'cold']);
  assert.deepEqual(built, { agentId: ID, harness: 'codex', cwd: soul.worktree, env: { AGENT_BOT_BINDING: soul.file } });
  assert.match(input.message, /IDs: m1, m2/);
  // A cold turn has nobody to approve anything.
  assert.deepEqual(await input.requestApproval({ operation: {}, summary: 'x' }), { decision: 'deny' });
  finish();
  await onWake.idle();
  assert.ok(receipts.some((r) => r.event === 'cold-wake' && r.decision === 'finished'));
  assert.ok(receipts.every((r) => !('messageIds' in r)));
});

test('the cold turn executor supplies the contract ports and a turn deadline', async () => {
  let seen;
  const run = coldTurnExecutor({ executorFor: () => async (value) => { seen = value; }, turnTimeoutMs: 1_000 });
  await run({ invocation: { agentId: ID, harness: 'codex', cwd: '/w' }, message: { text: 'hi' }, attachments: [], env: {} });
  assert.equal(typeof seen.appendEvent, 'function');
  assert.equal(typeof seen.addArtifact, 'function');
  assert.equal(seen.signal.aborted, false);
});

test('the cold turn resolves with the agent text after its last tool call', async () => {
  const run = coldTurnExecutor({
    executorFor: () => async ({ appendEvent }) => {
      appendEvent('update', { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Let me look.' } });
      appendEvent('update', { sessionUpdate: 'tool_call', toolCallId: 't1', title: 'Read' });
      appendEvent('update', { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'hmm' } });
      appendEvent('update', { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Hi, ' } });
      appendEvent('update', { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'all good.' } });
      return { stopReason: 'end_turn' };
    },
  });
  const result = await run({ invocation: { agentId: ID, harness: 'codex', cwd: '/w' }, message: 'hi', attachments: [], env: {} });
  assert.deepEqual(result, { stopReason: 'end_turn', reply: 'Hi, all good.', denied: [] });
});

test('the cold turn names each tool the policy refused, once', async () => {
  const run = coldTurnExecutor({
    executorFor: () => async ({ onPermission }) => {
      onPermission({ toolName: 'Read', outcome: 'allow', decidedBy: 'policy' });
      onPermission({ toolName: 'Bash', outcome: 'deny', decidedBy: 'policy' });
      onPermission({ toolName: 'Bash', outcome: 'deny', decidedBy: 'policy' });
      onPermission({ toolName: 'Edit', outcome: 'deny', decidedBy: 'approval' });
      return { stopReason: 'end_turn' };
    },
  });
  const result = await run({ invocation: { agentId: ID, harness: 'claude', cwd: '/w' }, message: 'hi', attachments: [], env: {} });
  assert.deepEqual(result.denied, ['Bash', 'Edit']);
  assert.equal(result.reply, '');
});

test('acpExecutorFor reports each turn\'s harness session binding and passes every event through', async () => {
  const agentId = 'agent_11111111-1111-4111-8111-111111111111';
  const seen = [];
  const events = [];
  const createExecutor = () => async ({ appendEvent }) => {
    appendEvent(HARNESS_SESSION_EVENT, { harness: 'claude', mode: 'new', harnessSessionId: 'sess-1234abcd' });
    appendEvent(UPDATE_EVENT, { sessionUpdate: 'agent_message_chunk' });
    return { stopReason: 'end_turn' };
  };
  const factory = acpExecutorFor({ identities: () => ({}), policy: {}, baseEnv: {}, createExecutor, onHarnessSession: (b) => seen.push(b) });
  const result = await factory({ agentId, harness: 'claude', cwd: '/soul', env: {} })({
    appendEvent: (type) => { events.push(type); return { type }; },
  });
  assert.equal(result.stopReason, 'end_turn');
  assert.deepEqual(seen, [{ agentId, harness: 'claude', harnessSessionId: 'sess-1234abcd' }]);
  assert.deepEqual(events, [HARNESS_SESSION_EVENT, UPDATE_EVENT]);
});

test('a failing session recorder never fails the turn', async () => {
  const createExecutor = () => async ({ appendEvent }) => {
    appendEvent(HARNESS_SESSION_EVENT, { harness: 'claude', mode: 'new', harnessSessionId: 'sess-1234abcd' });
    return { stopReason: 'end_turn' };
  };
  const factory = acpExecutorFor({ identities: () => ({}), policy: {}, baseEnv: {}, createExecutor, onHarnessSession: () => { throw new Error('disk full'); } });
  const result = await factory({ agentId: 'agent_11111111-1111-4111-8111-111111111111', harness: 'claude', cwd: '/soul', env: {} })({ appendEvent: () => ({}) });
  assert.equal(result.stopReason, 'end_turn');
});

// Cross-agent comms (#146): every daemon turn gets the reach server, so a
// cold soul can see its teammates and message them as itself.
test('acpExecutorFor injects the soul\'s reach server and allows its tools under a deny policy', () => {
  const agentId = 'agent_11111111-1111-4111-8111-111111111111';
  let options = null;
  const createExecutor = (opts) => { options = opts; return async () => ({ stopReason: 'end_turn' }); };
  const policy = { version: 1, rules: [{ tool: 'Bash', outcome: 'deny' }], fallback: 'deny' };
  acpExecutorFor({ identities: () => ({}), policy, baseEnv: { HOME: '/home/bot' }, createExecutor, reachEnv: { PATH: '/opt/bin' } })(
    { agentId, harness: 'claude', cwd: '/souls/bill/worktree', env: { AGENT_BOT_BINDING: '/souls/bill/binding.json' } },
  );
  assert.deepEqual(policy.rules, [{ tool: 'Bash', outcome: 'deny' }], 'the owner policy object is not mutated');
  assert.equal(options.policy.rules.at(-1).tool, 'Bash');
  assert.ok(options.policy.rules.some((rule) => rule.tool === 'mcp__agent-reach__send_message' && rule.outcome === 'allow'));
  assert.equal(options.policy.fallback, 'deny');

  // A comms turn has no store invocation: the entry carries the soul alone.
  const [entry] = options.mcpServers({ invocation: { agentId, harness: 'claude', cwd: '/souls/bill/worktree' } });
  const vars = Object.fromEntries(entry.env.map((pair) => [pair.name, pair.value]));
  assert.equal(entry.name, 'agent-reach');
  assert.equal(vars.AGENT_BOT_REACH_AGENT_ID, agentId);
  assert.equal(vars.AGENT_BOT_REACH_WORKTREE, '/souls/bill/worktree');
  assert.equal(vars.AGENT_BOT_BINDING, '/souls/bill/binding.json');
  assert.equal(vars.PATH, '/opt/bin');
  assert.equal('AGENT_BOT_REACH_INVOCATION' in vars, false);
  assert.equal('AGENT_BOT_REACH_COMMS' in vars, false, 'comms is on by default');

  // A store-backed invocation is stamped so fetch_context and post_reply work.
  const [stamped] = options.mcpServers({ invocation: { invocationId: 'invocation_44444444-4444-4444-8444-444444444444' } });
  assert.ok(stamped.env.some((pair) => pair.name === 'AGENT_BOT_REACH_INVOCATION'));
  assert.equal('AGENT_BOT_REACH_CORRELATION' in vars, false);

  // A task turn's invocation is minted for task reporting and is not in the
  // store: it is never stamped, so the reach server withholds the invocation
  // tools instead of offering ones that fail with "unknown invocation" (#407).
  const [taskLinked] = options.mcpServers({ invocation: {
    agentId, invocationId: 'invocation_55555555-5555-4555-8555-555555555555', taskId: 'task_1', correlation: 'msg_task',
  } });
  assert.equal(taskLinked.env.some((pair) => pair.name === 'AGENT_BOT_REACH_INVOCATION'), false);
  assert.ok(taskLinked.env.some((pair) => pair.name === 'AGENT_BOT_REACH_AGENT_ID' && pair.value === agentId));
  assert.ok(taskLinked.env.some((pair) => pair.name === 'AGENT_BOT_REACH_CORRELATION' && pair.value === 'msg_task'));

  // A relayed turn's thread key travels so its sends stay in the thread (#392).
  const [threaded] = options.mcpServers({ invocation: { agentId, correlation: 'msg_starter' } });
  assert.ok(threaded.env.some((pair) => pair.name === 'AGENT_BOT_REACH_CORRELATION' && pair.value === 'msg_starter'));
});

test('a soul launched with comms off gets the reach server without its teammate tools', () => {
  let options = null;
  const createExecutor = (opts) => { options = opts; return async () => ({ stopReason: 'end_turn' }); };
  const asked = [];
  acpExecutorFor({ identities: () => ({}), policy: { version: 1, rules: [], fallback: 'deny' }, baseEnv: {}, createExecutor,
    commsFor: (id) => { asked.push(id); return false; } })({ agentId: ID, harness: 'claude', cwd: '/soul', env: {} });
  const [entry] = options.mcpServers({ invocation: {} });
  assert.deepEqual(asked, [ID]);
  assert.ok(entry.env.some((pair) => pair.name === 'AGENT_BOT_REACH_COMMS' && pair.value === '0'));

  // An unreadable setting (no census row) is the default: on.
  acpExecutorFor({ identities: () => ({}), policy: { version: 1, rules: [], fallback: 'deny' }, baseEnv: {}, createExecutor,
    commsFor: () => { throw new Error('no population record'); } })({ agentId: ID, harness: 'claude', cwd: '/soul', env: {} });
  assert.equal(options.mcpServers({ invocation: {} })[0].env.some((pair) => pair.name === 'AGENT_BOT_REACH_COMMS'), false);
});

test('acpExecutorFor hands the engine the soul\'s own harness directory, and a failing lookup gives none (#417)', () => {
  const agentId = 'agent_11111111-1111-4111-8111-111111111111';
  const seen = [];
  const createExecutor = (options) => { seen.push(options.harnessDirs); return async () => ({ stopReason: 'end_turn' }); };
  acpExecutorFor({ identities: () => ({}), policy: {}, baseEnv: {}, createExecutor, harnessDirsFor: (id) => [`/souls/${id}/.soul-state/harnesses`] })({ agentId, harness: 'claude', cwd: '/repo', env: {} });
  acpExecutorFor({ identities: () => ({}), policy: {}, baseEnv: {}, createExecutor, harnessDirsFor: () => { throw new Error('no soul folder'); } })({ agentId, harness: 'claude', cwd: '/repo', env: {} });
  assert.deepEqual(seen, [[`/souls/${agentId}/.soul-state/harnesses`], []]);
});

test('acpExecutorFor routes the soul\'s installed runtimes into the turn env, and a failing lookup leaves the host PATH (#583 slice 3)', () => {
  const agentId = 'agent_11111111-1111-4111-8111-111111111111';
  const seen = [];
  const createExecutor = (options) => { seen.push(options.env); return async () => ({ stopReason: 'end_turn' }); };
  const asked = [];
  const runtimeEnvFor = ({ agentId: id, harness, env }) => { asked.push([id, harness, env.PATH]); return { PATH: `/souls/${id}/.soul-state/runtimes/node/24.21.0/bin:${env.PATH}`, GOROOT: `/souls/${id}/.soul-state/runtimes/go/1.27.1` }; };
  acpExecutorFor({ identities: () => ({}), policy: {}, baseEnv: { PATH: '/usr/bin', HOME: '/Users/host' }, createExecutor, runtimeEnvFor })({ agentId, harness: 'opencode', cwd: '/repo', env: {} });
  acpExecutorFor({ identities: () => ({}), policy: {}, baseEnv: { PATH: '/usr/bin' }, createExecutor, runtimeEnvFor: () => { throw new Error('no soul folder'); } })({ agentId, harness: 'opencode', cwd: '/repo', env: {} });
  assert.deepEqual(asked, [[agentId, 'opencode', '/usr/bin']]);
  assert.equal(seen[0].PATH, `/souls/${agentId}/.soul-state/runtimes/node/24.21.0/bin:/usr/bin`);
  assert.equal(seen[0].GOROOT, `/souls/${agentId}/.soul-state/runtimes/go/1.27.1`);
  assert.equal(seen[0].HOME, '/Users/host', 'HOME is left to the soul-home routing');
  assert.equal(seen[1].PATH, '/usr/bin');
});

test('acpExecutorFor hands the daemon\'s log to the engine, and leaves the engine\'s default without one', () => {
  const agentId = 'agent_11111111-1111-4111-8111-111111111111';
  const seen = [];
  const createExecutor = (options) => { seen.push('log' in options ? options.log : 'absent'); return async () => ({ stopReason: 'end_turn' }); };
  const log = () => {};
  acpExecutorFor({ identities: () => ({}), policy: {}, baseEnv: {}, createExecutor, log })({ agentId, harness: 'claude', cwd: '/repo', env: {} });
  acpExecutorFor({ identities: () => ({}), policy: {}, baseEnv: {}, createExecutor })({ agentId, harness: 'claude', cwd: '/repo', env: {} });
  assert.deepEqual(seen, [log, 'absent']);
});

test('ACP turns bind each soul mode at creation and reread it for the next turn', async (t) => {
  const { mkdtempSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { default: path } = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const { createAcpExecutor } = await import('../acp-engine.mjs');
  const { setSoulMode, soulMode } = await import('../soul-mode.mjs');
  const home = mkdtempSync(path.join(tmpdir(), 'wake-mode-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const env = { HOME: home, XDG_STATE_HOME: path.join(home, 'state'), AGENT_BOT_INTERACTION_HOME: path.join(home, 'interaction') };
  const registry = { claude: { harness: 'claude', enabled: true, command: process.execPath,
    args: [fileURLToPath(new URL('./fixtures/fake-acp-agent.mjs', import.meta.url))], stripEnv: [] } };
  const modes = [];
  const factory = acpExecutorFor({ identities: () => ({}), baseEnv: env,
    policy: { version: 1, rules: [], fallback: 'approval' },
    modeFor: (agentId) => soulMode(agentId, { env, home }),
    createExecutor: (options) => { modes.push(options.mode); return createAcpExecutor({ ...options, registry }); } });
  const request = { agentId: ID, harness: 'claude', cwd: home, env: {} };
  let approvals = 0;
  const port = () => ({ invocation: { agentId: ID }, message: 'need-permission', attachments: [],
    appendEvent: () => ({}), addArtifact: () => ({}), signal: new AbortController().signal,
    requestApproval: async () => { approvals += 1; return { decision: 'deny' }; } });
  const safeTurn = factory(request);
  setSoulMode(ID, 'autopilot', { env, home });
  await safeTurn(port());
  assert.equal(approvals, 1, 'the current turn keeps its starting mode');
  const seen = [];
  await factory(request)({ ...port(), onPermission: (record) => seen.push(record) });
  assert.equal(approvals, 1, 'the next turn uses autopilot without asking');
  assert.equal(seen[0].decidedBy, 'autopilot');
  assert.deepEqual(modes, ['safe', 'autopilot']);
  const otherSoul = { ...request, agentId: 'agent_77777777-7777-4777-8777-777777777777' };
  const other = factory(otherSoul);
  await other({ ...port(), invocation: { agentId: otherSoul.agentId } });
  assert.equal(approvals, 2, 'another soul retains its default Safe mode');
});

test('ACP model selection is captured per turn and discovery is cached for the correct soul', async (t) => {
  const { mkdtempSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { default: path } = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const { createAcpExecutor } = await import('../acp-engine.mjs');
  const { setSoulModel, soulModel, recordSoulModels } = await import('../soul-model.mjs');
  const home = mkdtempSync(path.join(tmpdir(), 'wake-model-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const models = { availableModels: [{ modelId: 'default', name: 'Default' }], currentModelId: 'default' };
  const env = { HOME: home, XDG_STATE_HOME: path.join(home, 'state'), AGENT_BOT_INTERACTION_HOME: path.join(home, 'interaction'), FAKE_ACP_MODELS: JSON.stringify(models) };
  const registry = { claude: { harness: 'claude', enabled: true, command: process.execPath,
    args: [fileURLToPath(new URL('./fixtures/fake-acp-agent.mjs', import.meta.url))], stripEnv: [] } };
  const selected = [];
  const discovered = [];
  const factory = acpExecutorFor({ identities: () => ({}), baseEnv: env, policy: { version: 1, rules: [], fallback: 'deny' },
    modelFor: (id) => soulModel(id, { env, home }).model,
    onModels: (id, block) => { discovered.push([id, block]); recordSoulModels(id, block, { env, home }); },
    createExecutor: (options) => { selected.push(options.model); return createAcpExecutor({ ...options, registry }); } });
  const request = { agentId: ID, harness: 'claude', cwd: home, env: {} };
  const observed = [];
  const port = (id = ID) => ({ invocation: { agentId: id }, message: 'model-probe', attachments: [],
    appendEvent: (type, data) => { if (data.content?.text) observed.push(JSON.parse(data.content.text).model); return {}; },
    addArtifact: () => ({}), signal: new AbortController().signal, requestApproval: async () => ({ decision: 'deny' }) });
  setSoulModel(ID, 'first', { env, home });
  const firstTurn = factory(request);
  setSoulModel(ID, 'second', { env, home });
  await firstTurn(port());
  await factory(request)(port());
  const other = 'agent_77777777-7777-4777-8777-777777777777';
  await factory({ ...request, agentId: other })(port(other));
  assert.deepEqual(selected, ['first', 'second', null]);
  assert.deepEqual(observed, ['first', 'second', 'default']);
  assert.deepEqual(discovered, [[ID, models], [ID, models], [other, models]]);
  assert.equal(soulModel(ID, { env, home }).model, 'second');
  assert.deepEqual(soulModel(other, { env, home }).available, models.availableModels);
});

test('acpExecutorFor puts the provider secret in the launched harness env only: the reach server and keyd relay get the turn env without it, and a missing secret fails the turn (#583 slice 4)', () => {
  const agentId = 'agent_11111111-1111-4111-8111-111111111111';
  let options = null;
  const createExecutor = (opts) => { options = opts; return async () => ({ stopReason: 'end_turn' }); };
  const asked = [];
  const providerEnvFor = ({ agentId: id, harness }) => { asked.push([id, harness]); return { env: { GITHUB_TOKEN: 'ghp_never_printed' }, envKey: 'GITHUB_TOKEN' }; };
  acpExecutorFor({ identities: () => ({ github: { appSlug: 'app' } }), policy: {}, baseEnv: { PATH: '/usr/bin', HOME: '/Users/host', GITHUB_TOKEN: 'from-the-host' }, createExecutor, providerEnvFor,
    keydFor: () => '/opt/keyd', reachEnv: { PATH: '/opt/bin' } })({ agentId, harness: 'codex', cwd: '/repo', env: { AGENT_BOT_BINDING: '/souls/bill/binding.json' } });
  assert.deepEqual(asked, [[agentId, 'codex']]);
  assert.equal(options.env.GITHUB_TOKEN, 'ghp_never_printed', 'the harness gets the soul\'s secret, over any host value');
  assert.equal(options.env.PATH, '/usr/bin');
  const [reach, keyd] = options.mcpServers({ invocation: {} });
  const reachVars = Object.fromEntries(reach.env.map((pair) => [pair.name, pair.value]));
  assert.equal('GITHUB_TOKEN' in reachVars, false, 'the reach server entry never carries the secret');
  assert.equal(reachVars.AGENT_BOT_REACH_STRIP_ENV, 'GITHUB_TOKEN', 'and strips it from its own environment if the harness merges env');
  assert.equal(reachVars.PATH, '/opt/bin');
  assert.ok(!JSON.stringify(keyd).includes('ghp_never_printed') && !JSON.stringify(keyd).includes('from-the-host'), 'keyd\'s relay never sees it either');
  // No provider: nothing injected, nothing stripped, no strip variable.
  acpExecutorFor({ identities: () => ({}), policy: {}, baseEnv: { PATH: '/usr/bin' }, createExecutor, providerEnvFor: () => ({ env: {}, envKey: null }) })({ agentId, harness: 'claude', cwd: '/repo', env: {} });
  assert.equal('GITHUB_TOKEN' in options.env, false);
  assert.equal(options.mcpServers({ invocation: {} })[0].env.some((pair) => pair.name === 'AGENT_BOT_REACH_STRIP_ENV'), false);
  // A secret the store cannot give is a coded failure of the turn, never a harness that silently cannot authenticate.
  const missing = Object.assign(new Error('codex needs the secret "github-models"'), { code: 'provider-secret-missing', action: `agent-bot soul secret ${agentId} set github-models` });
  assert.throws(() => acpExecutorFor({ identities: () => ({}), policy: {}, baseEnv: {}, createExecutor, providerEnvFor: () => { throw missing; } })({ agentId, harness: 'codex', cwd: '/repo', env: {} }), (error) => error.code === 'provider-secret-missing');
});
