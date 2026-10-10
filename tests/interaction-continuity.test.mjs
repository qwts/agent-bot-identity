import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { acpExecutorFor } from '../wake-plane.mjs';
import { createAcpExecutor } from '../acp-engine.mjs';
import { createInteractionService } from '../agent-interaction.mjs';
import { getInvocation, readEvents } from '../agent-jobs.mjs';
import { enrollPrincipal, bindTransport, authorizeSouls, setOperations } from '../agent-principals.mjs';
import { upsertSoul } from '../agent-population.mjs';

const SOUL = 'agent_11111111-1111-4111-8111-111111111111';
const OTHER = 'agent_22222222-2222-4222-8222-222222222222';
const fixture = fileURLToPath(new URL('./fixtures/fake-acp-agent.mjs', import.meta.url));
const registry = Object.fromEntries(['claude', 'codex'].map((harness) => [harness, {
  harness, enabled: true, command: process.execPath, args: [fixture], stripEnv: [],
}]));

function setup(t) {
  const home = mkdtempSync(path.join(tmpdir(), 'interaction-continuity-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const history = path.join(home, 'native');
  mkdirSync(history);
  const env = { HOME: home, AGENT_BOT_INTERACTION_HOME: path.join(home, 'interaction'),
    AGENT_BOT_POPULATION_PATH: path.join(home, 'population.json'),
    AGENT_BOT_PRINCIPALS_PATH: path.join(home, 'principals.json'), FAKE_ACP_HISTORY_DIR: history };
  const store = { env, home };
  for (const id of [SOUL, OTHER]) upsertSoul({ id, status: 'active', spacePath: home }, { file: env.AGENT_BOT_POPULATION_PATH });
  const principalOptions = { ...store, file: env.AGENT_BOT_PRINCIPALS_PATH };
  const principal = () => {
    const p = enrollPrincipal({ label: 'fixture owner' }, principalOptions);
    bindTransport(p.principalId, { transport: 'web', providerId: randomUUID() }, principalOptions);
    authorizeSouls(p.principalId, [SOUL, OTHER], principalOptions);
    return setOperations(p.principalId, ['message', 'observe', 'cancel'], principalOptions);
  };
  const owner = principal();
  // The fake agent's switches are not host variables a turn inherits, so
  // they ride the turn's own env, as the daemon's binding does.
  const makeFactory = ({ patch = {}, model = null } = {}) => {
    const factory = acpExecutorFor({ identities: () => ({}), baseEnv: env, interactionStore: store,
      policy: { version: 1, rules: [], fallback: 'deny' }, modelFor: () => model,
      createExecutor: (opts) => createAcpExecutor({ ...opts, registry }),
    });
    return (request) => factory({ ...request, env: { FAKE_ACP_HISTORY_DIR: history, ...patch, ...request.env } });
  };
  const makeService = ({ harness = 'claude', ...options } = {}) => {
    const factory = makeFactory(options);
    return createInteractionService({ ...store, config: {}, log: () => {}, executor: (input) =>
      factory({ agentId: input.invocation.agentId, harness, cwd: home, env: {} })(input) });
  };
  const service = makeService();
  const session = (svc = service, who = owner, agentId = SOUL) => svc.createOrContinueSession({ principal: who, agentId, transport: 'web' }).session.sessionId;
  const submit = (svc, sessionId, message, who = owner) => svc.submitMessage({ principal: who, transport: 'web', sessionId, message, idempotencyKey: randomUUID() }).invocation.invocationId;
  const events = (id) => readEvents(id, {}, store);
  async function wait(id, status = null) {
    const until = Date.now() + 8_000;
    while (Date.now() < until) {
      const job = getInvocation(id, store);
      if (status ? job.status === status : ['completed', 'failed', 'cancelled'].includes(job.status)) return job;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.fail(`invocation ${id} did not settle`);
  }
  const run = async (svc, sid, message, who = owner) => {
    const id = submit(svc, sid, message, who);
    return { job: await wait(id), events: events(id) };
  };
  return { service, makeService, makeFactory, session, submit, run, wait, events, owner, principal, store, home };
}
const text = (result) => result.events.filter((e) => e.type === 'update' && e.data.sessionUpdate === 'agent_message_chunk').map((e) => e.data.content.text).join('');
const binding = (result) => result.events.findLast((e) => e.type === 'harness-session')?.data;

test('production factory resumes persisted facts across turns and daemon reconstruction, isolating sessions, principals and souls', async (t) => {
  const x = setup(t);
  const sid = x.session();
  const first = await x.run(x.service, sid, 'remember:cerulean-596; teammates Ada and Lin');
  assert.equal(first.job.status, 'completed');
  const next = await x.run(x.service, sid, 'recall');
  assert.equal(next.job.status, 'completed');
  assert.equal(text(next), 'cerulean-596; teammates Ada and Lin');
  assert.equal(binding(next).mode, 'resume');
  assert.equal(binding(next).harnessSessionId, binding(first).harnessSessionId);
  // A coordination turn records another native session, but it must not
  // replace the binding belonging to this principal's /v1 conversation.
  await x.makeFactory()({ agentId: SOUL, harness: 'claude', cwd: x.home, env: {} })({
    invocation: { agentId: SOUL }, message: 'remember:unrelated cold-wake facts', attachments: [],
    appendEvent: () => ({}), addArtifact: () => ({}), requestApproval: async () => ({ decision: 'deny' }),
    signal: new AbortController().signal,
  });
  const restarted = x.makeService();
  const afterRestart = await x.run(restarted, sid, 'recall');
  assert.equal(text(afterRestart), text(next));
  assert.equal(binding(afterRestart).harnessSessionId, binding(first).harnessSessionId);
  const modelChanged = x.makeService({ model: 'different-model', patch: { FAKE_ACP_MODELS: JSON.stringify({
    currentModelId: 'old-model', availableModels: [{ modelId: 'different-model', name: 'Different' }],
  }) } });
  const afterModelChange = await x.run(modelChanged, sid, 'recall');
  assert.equal(text(afterModelChange), text(next));
  assert.equal(binding(afterModelChange).harnessSessionId, binding(first).harnessSessionId);
  const modelProbe = await x.run(modelChanged, sid, 'model-probe');
  assert.equal(JSON.parse(text(modelProbe)).model, 'different-model');
  for (const [who, soul] of [[x.owner, SOUL], [x.owner, OTHER], [x.principal(), SOUL]]) {
    const isolated = await x.run(restarted, x.session(restarted, who, soul), 'recall', who);
    assert.equal(text(isolated), 'no prior facts');
    assert.equal(binding(isolated).mode, 'new');
    assert.notEqual(binding(isolated).harnessSessionId, binding(first).harnessSessionId);
  }
});

test('factory checks invocation and durable session ownership before returning a native binding', async (t) => {
  const x = setup(t);
  const sid = x.session();
  const first = await x.run(x.service, sid, 'remember:private facts');
  let lookup;
  acpExecutorFor({ identities: () => ({}), baseEnv: {}, interactionStore: x.store, policy: {},
    createExecutor: (options) => { lookup = options.getHarnessSession; return async () => {}; },
  })({ agentId: SOUL, harness: 'claude', cwd: x.home, env: {} });
  assert.equal(typeof lookup, 'function');
  const invocation = getInvocation(first.job.invocationId, x.store);
  for (const patch of [
    { agentId: OTHER }, { principalId: x.principal().principalId }, { transport: 'cli' },
    { sessionId: x.session() }, { invocationId: `invocation_${randomUUID()}` },
  ]) assert.throws(() => lookup({ ...invocation, ...patch }), /ownership mismatch/);
  assert.equal(lookup({ agentId: SOUL }), null, 'cold turns have no implicit /v1 session');
});

for (const [reason, options] of [
  ['harness-changed', { harness: 'codex' }],
  ['native-resume-unsupported', { patch: { FAKE_ACP_NO_LOAD: '1' } }],
  ['native-resume-failed', { patch: { FAKE_ACP_LOAD_ERROR: '1' } }],
]) test(`continuity reports ${reason} without silently starting a new conversation`, async (t) => {
  const x = setup(t);
  const sid = x.session();
  await x.run(x.service, sid, 'remember:cerulean-596');
  const refused = await x.run(x.makeService(options), sid, 'recall');
  assert.equal(refused.job.status, 'failed');
  assert.equal(binding(refused), undefined);
  assert.deepEqual(refused.events.find((e) => e.type === 'continuity')?.data, { status: 'unavailable', reason });
  assert.doesNotMatch(JSON.stringify(refused), /private provider error/);
  const recovered = await x.run(x.makeService(), sid, 'recall');
  assert.equal(text(recovered), 'cerulean-596', 'a refused continuation preserves the prior binding');
});

test('overlapping turns in one session refuse the second until the first actually stops', async (t) => {
  const x = setup(t);
  const sid = x.session();
  await x.run(x.service, sid, 'remember:facts survive cancellation');
  const hanging = x.submit(x.service, sid, 'hang');
  const until = Date.now() + 8_000;
  while (!x.events(hanging).some((e) => e.type === 'harness-session')) {
    assert.ok(Date.now() < until);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  try {
    const refused = await x.run(x.service, sid, 'recall');
    assert.equal(refused.job.status, 'failed');
    assert.deepEqual(refused.events.find((e) => e.type === 'continuity')?.data, { status: 'unavailable', reason: 'session-busy' });
    const independent = await x.run(x.service, x.session(), 'recall');
    assert.equal(independent.job.status, 'completed', 'another session remains independent');
  } finally {
    await x.service.cancelInvocation({ principal: x.owner, transport: 'web', invocationId: hanging });
  }
  assert.equal(text(await x.run(x.service, sid, 'recall')), 'facts survive cancellation');
});

test('a completed turn without a native binding cannot be silently skipped', async (t) => {
  const x = setup(t);
  const sid = x.session();
  const foreign = createInteractionService({ ...x.store, config: {}, executor: async () => {} });
  assert.equal((await x.run(foreign, sid, 'prior non-ACP turn')).job.status, 'completed');
  const refused = await x.run(x.service, sid, 'recall');
  assert.equal(refused.job.status, 'failed');
  assert.deepEqual(refused.events.find((e) => e.type === 'continuity')?.data,
    { status: 'unavailable', reason: 'binding-unavailable' });
});
