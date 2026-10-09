import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createDreamService, dreamControlRequest, DREAM_POLL_MS, prepareDreamDirectory } from '../skill-dream-service.mjs';
import { createDreamFileStore } from '../skill-dream-store.mjs';
import { createDreamScheduler } from '../skill-dream-scheduler.mjs';
import { createTurnRegistry, acpExecutorFor } from '../wake-plane.mjs';
import { createAcpExecutor } from '../acp-engine.mjs';
import { createDaemonServer } from '../agent-daemon.mjs';
import { computePackageRevision, PACKAGE_IGNORE_LIST } from '../soul-package.mjs';
import { upsertSoul } from '../agent-population.mjs';
import { assertOwnerAction, ownerCredentialRequired, verifyPrincipalOwner } from '../owner-action.mjs';
import { PROOF_HEADER } from '../binding-proof.mjs';
import { auditFile } from '../agent-principals.mjs';
import { UPDATE_EVENT } from '../executor-contract.mjs';
import { createProcessOwnershipPort } from '../process-ownership.mjs';
import { spawn } from 'node:child_process';

const ID = 'agent_66666666-6666-4666-8666-666666666666';
const posix = { skip: process.platform === 'win32' };
const principal = { principal: 'principal_12345678-1234-4123-8123-123456789abc', secret: 'p'.repeat(64), brokerUid: process.getuid?.() + 1, mode: 'group' };
const until = async check => { const end = Date.now() + 8_000; while (!check()) { assert.ok(Date.now() < end, 'fixture did not become ready'); await new Promise(resolve => setTimeout(resolve, 5)); } };

function fixture(t, { scenario = null, configured = true, executorFor: customFactory = null } = {}) {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'dream-service-'))), soul = path.join(root, 'fixture.soul'), directory = path.join(root, 'state', 'dream');
  mkdirSync(soul); mkdirSync(path.join(soul, '.soul-state'));
  const manifest = { formatVersion: 2, ignore: PACKAGE_IGNORE_LIST, name: 'Fixture', description: 'Dream fixture', displaySeed: 'dream-fixture', preferredHarnesses: ['codex'], revision: `sha256:${'0'.repeat(64)}`, parentRevision: null, template: false };
  writeFileSync(path.join(soul, 'AGENTS.md'), 'UNTRUSTED_SOURCE_CANARY'); writeFileSync(path.join(soul, 'soul.json'), JSON.stringify(manifest));
  manifest.revision = computePackageRevision(soul); writeFileSync(path.join(soul, 'soul.json'), JSON.stringify(manifest));
  writeFileSync(path.join(soul, '.soul-state', 'agent-id'), ID);
  writeFileSync(path.join(soul, '.soul-state', 'secret'), 'PRIVATE_CANARY');
  const env = { HOME: root, PATH: process.env.PATH, AGENT_BOT_CONFIG: path.join(root, 'missing-config'),
    AGENT_BOT_POPULATION_PATH: path.join(root, 'population.json'), AGENT_BOT_INTERACTION_HOME: path.join(root, 'interaction'), AGENT_COMMS_SHARED_DIR: path.join(root, 'no-broker') };
  upsertSoul({ id: ID, name: 'fixture', status: 'active', soulDir: soul, spacePath: root }, { file: env.AGENT_BOT_POPULATION_PATH });
  let service, at = Date.parse('2026-10-09T00:00:00Z'), poll = null, ready = 0, paused = false, moved = false;
  const records = [], prompts = [], resolutions = [], approvals = [], timers = [];
  const turns = createTurnRegistry({ isPaused: () => paused, history: { turn: (_id, record) => records.push(record) }, onStop: id => service?.stopSoul(id) });
  const registry = { codex: { harness: 'codex', enabled: true, command: process.execPath, args: [fileURLToPath(new URL('./fixtures/fake-acp-agent.mjs', import.meta.url))], stripEnv: [] } };
  const factory = acpExecutorFor({ identities: () => ({ github: null }), baseEnv: env,
    policy: { version: 1, rules: [], fallback: 'approval' }, runtimeEnvFor: () => ({ FAKE_KEEP: 'selected-runtime' }),
    toolHomeEnvFor: () => ({ CODEX_HOME: path.join(soul, '.soul-state', 'home') }),
    providerEnvFor: () => ({ env: { FAKE_SET: 'provider-canary' }, envKey: 'FAKE_SET' }),
    createExecutor: options => {
      resolutions.push(options);
      const engine = createAcpExecutor({ ...options, registry });
      return input => {
        prompts.push(input.message);
        return engine({ ...input, ...(scenario ? { message: scenario } : {}), appendEvent(type, data) {
          if (data?.content?.text?.startsWith('pid:')) ready++;
          return input.appendEvent(type, data);
        } });
      };
    },
  });
  const options = { directory, turns, executorFor: configured ? customFactory ?? factory : null,
    lookupSoul: () => ({ directory: moved ? `${soul}-moved` : soul, harness: 'codex' }), isPaused: () => paused,
    now: () => new Date(at), approvals: async request => { approvals.push(request); return { decision: 'deny' }; },
    setIntervalImpl: (callback, ms) => { poll = callback; timers.push(ms); return 1; }, clearIntervalImpl: () => { poll = null; },
  };
  service = createDreamService(options);
  t.after(async () => { service.shutdown(); await service.idle(); rmSync(root, { recursive: true, force: true }); });
  return { root, soul, directory, env, options, service, turns, records, prompts, resolutions, approvals, timers,
    ready: () => ready, advance: ms => { at += ms; }, poll: () => poll?.(), paused: value => { paused = value; }, moved: () => { moved = true; },
    control: (action, body = {}) => service.control(dreamControlRequest(action, { ...(action === 'cancel' ? {} : { agentId: ID }), ...body })) };
}

async function serverFixture(t, options = {}) {
  const f = fixture(t, options), verified = [];
  const server = createDaemonServer({ env: f.env, home: f.root, config: {}, turns: f.turns,
    settingGate: (action, { principal: credential }) => assertOwnerAction(action, { env: f.env, cwd: f.root, detect: false,
      principal: credential, consent: () => { throw ownerCredentialRequired('fixture has no owner ceremony'); },
      verifyPrincipal: input => verifyPrincipalOwner(input, { env: f.env, clientFactory: () => ({ request: async request => {
        verified.push(request);
        if (request.auth.secret !== principal.secret) throw new Error('invalid fixture principal');
        return { uptimeMs: 1 };
      } }) }),
    }),
  });
  server.dream = f.service;
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const call = async (route = '', body, headers = {}, token = server.token) => {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/v0/soul/dream${route}`, {
      method: body === undefined ? 'GET' : 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', ...headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: response.status, body: await response.json() };
  };
  return { ...f, server, call, verified };
}

test('daemon dream controls require owner verification, reject bindings and validate every mutation', posix, async t => {
  const f = await serverFixture(t);
  assert.equal((await f.call('', undefined, {}, 'bad')).status, 401);
  for (const action of ['register', 'pause', 'unschedule', 'run-now', 'cancel']) {
    const body = action === 'cancel' ? { runId: '12345678-1234-4234-8234-123456789abc' } : { agentId: ID, ...(action === 'register' ? { schedule: 'PT1H' } : {}) };
    assert.equal((await f.call(`/${action}`, body)).status, 403, 'bearer alone cannot authorize a control');
    assert.equal((await f.call(`/${action}`, { ...body, principal: { ...principal, secret: 'bad' } })).status, 403);
    for (const header of ['x-agent-binding', PROOF_HEADER]) assert.equal((await f.call(`/${action}`, { ...body, principal }, { [header]: '' })).status, 403);
    assert.equal((await f.call(`/${action}`, { ...body, principal, path: '/outside' })).status, 400);
  }
  assert.equal(f.service.status().revision, 0); assert.deepEqual(f.resolutions, []);
  assert.equal((await f.call('/register', { agentId: ID, schedule: 'PT1H', principal })).status, 200);
  assert.equal(f.service.status().registrations.length, 1);
  assert.equal((await f.call('/pause', { agentId: ID, principal })).status, 200);
  assert.equal((await f.call('/run-now', { agentId: ID, principal })).body.result.reason, 'paused');
  assert.equal((await f.call('/unschedule', { agentId: ID, principal })).body.result.removed, true);
  assert.equal((await f.call('/history?limit=1')).body.records.length, 1);
  assert.equal((await f.call('/history?limit=1&limit=2')).status, 400);
  assert.equal((await f.call('/history?limit=17')).status, 409);
  assert.equal((await f.call('?agentId=' + ID)).status, 400);
  assert.ok(f.verified.length > 0);
  assert.equal(JSON.stringify(f.service.status()).includes(principal.secret), false);
});

test('dream audit retains authorization before a failed control and distinguishes its outcome', posix, async t => {
  const f = await serverFixture(t, { configured: false });
  const receipts = () => readFileSync(auditFile({ env: f.env, home: f.root }), 'utf8').trim().split('\n').map(JSON.parse)
    .filter(row => row.event.startsWith('dream-control'));
  const request = { agentId: ID, schedule: 'PT1H', principal };
  assert.equal((await f.call('/register', { ...request, principal: null })).status, 403);
  assert.deepEqual(receipts().map(row => row.decision), ['owner-refused']);
  const control = f.service.control;
  let calls = 0;
  f.server.dream = { ...f.service, control(input) {
    calls++;
    assert.equal(receipts().at(-1).decision, 'authorized', 'approval is recorded before executing the control');
    return control(input);
  } };
  assert.equal((await f.call('/register', request)).status, 409, 'missing executor refuses the authorized control');
  assert.equal(calls, 1);
  assert.deepEqual(receipts().slice(-2).map(row => [row.event, row.decision]), [
    ['dream-control', 'authorized'], ['dream-control-outcome', 'failed'],
  ]);
  assert.equal((await f.call('/unschedule', { agentId: ID, principal })).status, 200);
  assert.deepEqual(receipts().slice(-2).map(row => [row.event, row.decision]), [
    ['dream-control', 'authorized'], ['dream-control-outcome', 'returned'],
  ]);
  assert.ok(receipts().every(row => row.agentId === ID));
  assert.equal(JSON.stringify(receipts()).includes(principal.secret), false);
});

test('owner run-now uses configured ACP and keeps its unverified reply separate from execution facts', posix, async t => {
  const f = await serverFixture(t, { scenario: 'need-permission' });
  await f.call('/register', { agentId: ID, schedule: 'PT1H', principal });
  const result = await f.call('/run-now', { agentId: ID, principal });
  assert.equal(result.status, 202); assert.equal(result.body.result.status, 'started');
  assert.equal(Object.hasOwn(result.body.result, 'done'), false);
  await f.service.idle();
  const status = f.service.status(), record = status.registrations[0].lastRun;
  assert.equal(record.status, 'completed'); assert.equal(status.maintenanceCoverage, 'unverified');
  assert.equal(f.approvals.length, 1); assert.equal(f.approvals[0].agentId, ID);
  assert.equal(f.resolutions[0].env.FAKE_KEEP, 'selected-runtime'); assert.equal(f.resolutions[0].env.FAKE_SET, 'provider-canary');
  assert.ok(f.prompts[0].includes('UNTRUSTED_SOURCE_CANARY')); assert.ok(f.prompts[0].includes('untrusted source data'));
  assert.equal(f.prompts[0].includes('PRIVATE_CANARY'), false);
  assert.equal(f.records[0].kind, 'dream'); assert.equal(f.records[0].id, record.runId);
  assert.equal(JSON.stringify(f.service.history()).includes('CANARY'), false);
  const events = f.service.history().records.flatMap(record => record.events);
  const outcome = events.find(event => event.kind === 'outcome-recorded');
  assert.equal(outcome.outcome.report.status, 'unstructured');
  assert.ok(outcome.outcome.report.text.includes('opt-reject'));
  assert.deepEqual(outcome.outcome.items, []);
  assert.equal(JSON.stringify(events.filter(event => event.kind !== 'outcome-recorded')).includes('opt-reject'), false);
  const prepared = f.service.history().records.flatMap(record => record.events).find(event => event.kind === 'inputs-prepared');
  assert.equal(prepared.run.runId, record.runId);
  assert.equal(prepared.inputs.sources[0].path, 'AGENTS.md');
  assert.deepEqual(status.inputReceipts, [prepared.receipt]);
  const reopened = createDreamFileStore({ directory: f.directory });
  assert.deepEqual(reopened.read().inputReceipts, status.inputReceipts);
  assert.deepEqual(reopened.read().outcomeReceipts, status.outcomeReceipts);
  assert.equal(status.outcomeReceipts[0].runId, record.runId);
});

test('structured and truncated replies are persisted atomically with terminal run facts', posix, async t => {
  for (const truncated of [false, true]) await t.test(String(truncated), async t => {
    const f = fixture(t, { executorFor: () => async input => {
      const captured = JSON.parse(input.message.split('\n\n').at(-1));
      const text = JSON.stringify({ schemaVersion: 1, runId: captured.runId, startingRevision: captured.revision,
        items: captured.sources.map(source => ({ path: source.path, digest: source.digest, outcome: 'skipped', reason: 'no-change', evidence: null })) });
      const emit = text => input.appendEvent(UPDATE_EVENT, { sessionUpdate: 'agent_message_chunk', content: { text } });
      emit(text);
      if (truncated) emit(' '.repeat(256 * 1024)); // a valid JSON prefix is still an incomplete reply
    } });
    f.control('register', { schedule: 'PT1H' }); f.control('run-now'); await f.service.idle();
    const transaction = f.service.history().records.at(-1);
    assert.deepEqual(transaction.events.map(event => event.kind), ['ended', 'outcome-recorded', ...truncated ? ['notices-updated'] : ['selection-advanced']]);
    const record = transaction.events[1];
    assert.equal(record.outcome.report.status, truncated ? 'truncated' : 'structured');
    assert.equal(record.outcome.items.length, truncated ? 0 : 1);
    assert.equal(record.outcome.processingCoverage, 'unverified');
    assert.equal(record.receipt.journalRevision, transaction.revision);
    const reopened = createDreamFileStore({ directory: f.directory });
    assert.deepEqual(reopened.read().outcomeReceipts, [record.receipt]);
    assert.equal(reopened.read().flights.length, 0);
  });
});

test('report previews live outside the journal, read back by digest and refuse tampering', posix, async t => {
  const f = fixture(t, { executorFor: () => async input => {
    input.appendEvent(UPDATE_EVENT, { sessionUpdate: 'agent_message_chunk', content: { text: 'PREVIEW_CANARY unstructured' } });
  } });
  f.control('register', { schedule: 'PT1H' }); f.control('run-now'); await f.service.idle();
  const journal = readdirSync(f.directory).map(name => readFileSync(path.join(f.directory, name), 'utf8')).join('');
  assert.equal(journal.includes('PREVIEW_CANARY'), false);
  const recorded = () => f.service.history().records.flatMap(record => record.events).find(event => event.kind === 'outcome-recorded');
  assert.equal(recorded().outcome.report.text, 'PREVIEW_CANARY unstructured');
  assert.equal(recorded().outcome.report.preview.status, 'available');
  assert.deepEqual(f.service.status().previews, { location: 'outside-journal', retainPerSoul: 20 });
  const dir = path.join(path.dirname(f.directory), 'dream-previews', ID), [file] = readdirSync(dir);
  assert.equal(statSync(dir).mode & 0o777, 0o700); assert.equal(statSync(path.join(dir, file)).mode & 0o777, 0o600);
  writeFileSync(path.join(dir, file), 'PREVIEW_CANARY edited');
  assert.deepEqual([recorded().outcome.report.text, recorded().outcome.report.preview.status], [null, 'invalid']);
  rmSync(path.join(dir, file));
  assert.deepEqual([recorded().outcome.report.text, recorded().outcome.report.preview.status], [null, 'unavailable']);
});

test('durable preparation precedes provider resolution and survives a launch failure', posix, async t => {
  let f, sawReceipt = false;
  f = fixture(t, { executorFor: () => {
    const disk = createDreamFileStore({ directory: f.directory });
    const prepared = disk.history().records.flatMap(record => record.events).find(event => event.kind === 'inputs-prepared');
    assert.ok(prepared); assert.equal(prepared.inputs.sources[0].path, 'AGENTS.md');
    sawReceipt = true;
    throw new Error('PROVIDER_SECRET_CANARY');
  } });
  f.control('register', { schedule: 'PT1H' }); f.control('run-now'); await f.service.idle();
  assert.equal(sawReceipt, true);
  assert.equal(f.service.status().registrations[0].lastRun.status, 'failed');
  assert.equal(f.service.status().maintenanceCoverage, 'unverified');
  assert.equal(JSON.stringify(f.service.history()).includes('CANARY'), false);
  assert.equal(f.service.status().inputReceipts.length, 1);
});

test('shared stop and shutdown cancel real ACP runs through the scheduler and retain factual receipts', posix, async t => {
  for (const mode of ['stop', 'shutdown']) await t.test(mode, async t => {
    const f = fixture(t, { scenario: 'hang' });
    f.control('register', { schedule: 'PT1H' }); f.control('run-now');
    await until(() => f.ready());
    assert.deepEqual(f.turns.busy(), [ID]);
    // The production wiring recorded the real agent group before its prompt.
    assert.ok(Number.isSafeInteger(f.service.status().flights[0].ownership?.pgid));
    if (mode === 'stop') assert.equal(f.turns.stop(ID), true); else f.service.shutdown();
    assert.equal(f.service.status().flights[0].status, 'cancelling');
    await f.service.idle();
    const record = f.service.status().registrations[0].lastRun;
    assert.equal(record.status, 'cancelled'); assert.equal(record.cancelReason, mode === 'stop' ? 'owner' : 'shutdown'); assert.ok(record.cancelRequestedAt);
    assert.deepEqual(f.turns.busy(), []);
    if (mode === 'shutdown') assert.throws(() => f.control('run-now'), { code: 'dream-service-stopped' });
  });
});

test('daemon timer dispatch defers paused/busy/moved souls and performs one catch-up', posix, async t => {
  const f = fixture(t);
  f.control('register', { schedule: 'PT1H' }); f.service.start(); f.service.start();
  assert.deepEqual(f.timers, [DREAM_POLL_MS]); assert.equal(f.resolutions.length, 0);
  f.advance(3_600_000 * 10);
  f.paused(true); f.poll(); assert.equal(f.resolutions.length, 0); f.paused(false);
  const controller = new AbortController(), release = f.turns.track(ID, controller);
  f.poll(); assert.equal(f.resolutions.length, 0); release();
  f.poll(); await f.service.idle();
  assert.equal(f.resolutions.length, 1); f.poll(); await f.service.idle(); assert.equal(f.resolutions.length, 1);
  f.advance(3_600_000); f.moved(); f.poll(); assert.equal(f.resolutions.length, 1);
});

test('unconfigured execution and invalid input never resolve credentials or launch a harness', posix, async t => {
  const disabled = fixture(t, { configured: false });
  assert.equal(disabled.service.status().executorConfigured, false);
  assert.throws(() => disabled.control('register', { schedule: 'PT1H' }), { code: 'dream-executor-unavailable' });
  assert.equal(disabled.service.status().revision, 0);
  const f = fixture(t);
  f.control('register', { schedule: 'PT1H' });
  writeFileSync(path.join(f.soul, 'AGENTS.md'), 'unsealed change');
  f.control('run-now'); await f.service.idle();
  assert.equal(f.service.status().registrations[0].lastRun.status, 'failed'); assert.equal(f.resolutions.length, 0);
  assert.equal(f.service.status().diagnostics.scope, 'this-daemon');
  assert.equal(f.service.status().diagnostics.inputFailures[0].code, 'dream-input-drift');
  assert.equal(JSON.stringify(f.service.status().diagnostics).includes('unsealed change'), false);
  writeFileSync(path.join(f.soul, 'AGENTS.md'), 'UNTRUSTED_SOURCE_CANARY');
  f.control('run-now'); await f.service.idle();
  assert.deepEqual(f.service.status().diagnostics.inputFailures, []);
});

test('startup quarantines unsettled durable work and controls cannot erase that lease', posix, async t => {
  const f = fixture(t);
  // Seed an earlier daemon's running record using the production journal,
  // without launching a child or leaving a live timeout in this process.
  const old = createDreamScheduler({ store: createDreamFileStore({ directory: f.directory }), soulDirectory: () => f.soul,
    execute: () => new Promise(() => {}), setTimer: () => 1, clearTimer: () => {}, now: () => new Date('2026-10-09T00:00:00Z') });
  old.register(ID, 'PT1H'); old.runNow(ID); await Promise.resolve();
  const recovered = createDreamService(f.options);
  t.after(() => recovered.shutdown());
  assert.equal(recovered.status().flights[0].status, 'recovery-required');
  assert.equal(recovered.control(dreamControlRequest('run-now', { agentId: ID })).reason, 'recovery-required');
  recovered.control(dreamControlRequest('unschedule', { agentId: ID }));
  recovered.control(dreamControlRequest('register', { agentId: ID, schedule: 'PT1H' }));
  assert.equal(recovered.control(dreamControlRequest('run-now', { agentId: ID })).reason, 'recovery-required');
  assert.equal(f.resolutions.length, 0);
  // The quarantine's owner-visible notice is durable across another restart and acknowledgeable.
  recovered.shutdown();
  const again = createDreamService(f.options);
  t.after(() => again.shutdown());
  const [notice] = again.status().noticeLedgers.find(ledger => ledger.agentId === ID).notices;
  assert.deepEqual([notice.kind, notice.detail, notice.occurrences], ['recovery', 'recovery-required', 1], 'a later startup does not renotify');
  assert.equal(again.control(dreamControlRequest('ack-notice', { agentId: ID, noticeId: notice.id })).notice.state, 'acknowledged');
  assert.equal(again.status().schemaVersion, 8);
});

test('a restarted daemon terminates its predecessor\'s owned agent group and settles the run as interrupted (#603)', posix, async t => {
  const f = fixture(t);
  // An earlier daemon recorded a real detached group, then vanished without settling.
  let child;
  const old = createDreamScheduler({ store: createDreamFileStore({ directory: f.directory }), soulDirectory: () => f.soul,
    processOwnership: createProcessOwnershipPort(), setTimer: () => 1, clearTimer: () => {}, now: () => new Date('2026-10-09T00:00:00Z'),
    execute: ({ recordProcess }) => {
      child = spawn('sleep', ['30'], { detached: true, stdio: 'ignore' });
      recordProcess({ pid: child.pid });
      return new Promise(() => {});
    } });
  old.register(ID, 'PT1H'); old.runNow(ID); await Promise.resolve();
  t.after(() => { try { process.kill(-child.pid, 'SIGKILL'); } catch { /* already gone */ } });
  const { ownership } = createDreamFileStore({ directory: f.directory }).read().flights[0];
  assert.equal(ownership.pgid, child.pid);
  const recovered = createDreamService(f.options);
  t.after(async () => { recovered.shutdown(); await recovered.idle(); });
  assert.equal(recovered.status().orphanRecovery, 'process-group-or-quarantine');
  assert.equal(recovered.control(dreamControlRequest('run-now', { agentId: ID })).reason, 'recovering');
  await recovered.idle();
  const status = recovered.status();
  assert.deepEqual(status.flights, []);
  assert.deepEqual([status.registrations[0].lastRun.status, status.registrations[0].lastRun.ownership], ['interrupted', ownership]);
  assert.throws(() => process.kill(-ownership.pgid, 0), { code: 'ESRCH' });
  assert.equal(f.resolutions.length, 0, 'recovery never launched a new turn');
});

test('private directory failures and corrupt journals disable dreaming without repairing or deleting data', posix, t => {
  const f = fixture(t);
  chmodSync(f.directory, 0o755);
  const bad = createDreamService(f.options);
  assert.equal(bad.status().available, false); assert.equal(statSync(f.directory).mode & 0o777, 0o755);
  assert.throws(() => prepareDreamDirectory(f.directory), { code: 'dream-store-directory' });
  chmodSync(f.directory, 0o700);
  writeFileSync(path.join(f.directory, 'unexpected'), 'RETAIN_CANARY');
  const corrupt = createDreamService(f.options);
  assert.equal(corrupt.status().available, false); assert.equal(readFileSync(path.join(f.directory, 'unexpected'), 'utf8'), 'RETAIN_CANARY');
  const linked = path.join(f.root, 'linked'); symlinkSync(f.directory, linked);
  assert.throws(() => prepareDreamDirectory(linked), { code: 'dream-store-directory' });
  assert.equal(existsSync(f.directory), true);
});

test('a failed stop observer cannot prevent the shared controller from cancelling execution', async () => {
  const turns = createTurnRegistry({ onStop: () => { throw new Error('receipt unavailable'); } });
  const done = turns.run({ invocation: { agentId: ID } }, ({ signal }) => new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true })));
  const rejected = assert.rejects(done, { name: 'AbortError' });
  assert.equal(turns.stop(ID), true); await rejected; assert.deepEqual(turns.busy(), []);
});

test('durable selection rotates bounded pages across restart, wraps blocked items and resets on source change', posix, async t => {
  const seen = [];
  const f = fixture(t, { executorFor: () => async input => {
    const captured = JSON.parse(input.message.split('\n\n').at(-1)); seen.push(captured);
    input.appendEvent(UPDATE_EVENT, { sessionUpdate: 'agent_message_chunk', content: { text: JSON.stringify({
      schemaVersion: 1, runId: captured.runId, startingRevision: captured.revision,
      items: captured.sources.map(source => ({ path: source.path, digest: source.digest, outcome: 'blocked', reason: 'missing-tool', evidence: null })),
    }) } });
  } });
  const seal = () => {
    const file = path.join(f.soul, 'soul.json'), manifest = JSON.parse(readFileSync(file, 'utf8'));
    manifest.revision = computePackageRevision(f.soul); writeFileSync(file, JSON.stringify(manifest));
  };
  for (let i = 0; i < 102; i++) {
    const dir = path.join(f.soul, 'skills', `fixture-${String(i).padStart(3, '0')}`);
    mkdirSync(dir, { recursive: true }); writeFileSync(path.join(dir, 'SKILL.md'), `---\nname: fixture-${String(i).padStart(3, '0')}\ndescription: Fixture skill\n---\nSkill ${i}`);
  }
  seal(); f.control('register', { schedule: 'PT1H' }); f.control('run-now'); await f.service.idle();
  assert.equal(seen[0].sources.length, 100); assert.equal(seen[0].coverage.remaining, 3);
  const firstPaths = seen[0].sources.map(source => source.path);
  f.service.shutdown();
  const reopened = createDreamService(f.options);
  t.after(async () => { reopened.shutdown(); await reopened.idle(); });
  const run = async () => { reopened.control({ action: 'run-now', agentId: ID }); await reopened.idle(); };
  await run();
  assert.equal(seen[1].sources.length, 3); assert.ok(seen[1].sources.every(source => !firstPaths.includes(source.path)));
  assert.equal(reopened.status().selectionCheckpoints[0].nextCursor, null);
  await run(); assert.deepEqual(seen[2].sources.map(source => source.path), firstPaths, 'blocked items return in the next cycle');
  writeFileSync(path.join(f.soul, 'AGENTS.md'), 'Changed definition'); seal();
  await run(); assert.deepEqual(seen[3].sources.map(source => source.path), firstPaths, 'new revision resets selection');
  assert.notEqual(seen[3].revision, seen[2].revision);
  assert.equal(reopened.status().maintenanceCoverage, 'unverified');
  assert.ok(reopened.status().selectionCheckpoints.every(row => row.processingCoverage === 'unverified'));

  // A same-revision cursor must match its immutable preparation receipt. A
  // structurally valid journal checkpoint alone is not enough to skip sources.
  reopened.shutdown();
  const disk = createDreamFileStore({ directory: f.directory }), state = disk.read(), expectedRevision = state.revision;
  state.selectionCheckpoints[0].nextCursor.path = 'AGENTS.md'; state.revision++;
  assert.equal(disk.commit({ expectedRevision, state, events: [{ kind: 'registered', at: state.registrations[0].updatedAt,
    registration: state.registrations[0] }] }), true);
  const mismatched = createDreamService(f.options);
  t.after(async () => { mismatched.shutdown(); await mismatched.idle(); });
  mismatched.control({ action: 'run-now', agentId: ID }); await mismatched.idle();
  assert.equal(seen.length, 4, 'a mismatched checkpoint never reaches the provider');
  assert.equal(mismatched.status().diagnostics.inputFailures[0].code, 'dream-selection-invalid');
});

test('post-control audit failure preserves the applied result, while pre-control audit failure prevents execution', posix, async t => {
  const f = await serverFixture(t), file = auditFile({ env: f.env, home: f.root }), control = f.service.control;
  let calls = 0;
  f.server.dream = { ...f.service, control(request) {
    calls++;
    const result = control(request);
    renameSync(file, `${file}.saved`); mkdirSync(file); // real outcome append fails after the control applied
    return result;
  } };
  const response = await f.call('/register', { agentId: ID, schedule: 'PT1H', principal });
  assert.equal(response.status, 200); assert.equal(response.body.result.agentId, ID);
  assert.deepEqual(response.body.audit, { status: 'unconfirmed', code: 'dream-control-audit-unconfirmed' });
  assert.equal(f.service.status().registrations.length, 1); assert.equal(calls, 1);
  const receipt = JSON.parse(readFileSync(`${file}.saved`, 'utf8').trim().split('\n').at(-1));
  assert.equal(receipt.decision, 'authorized', 'authorization receipt precedes the applied action');
  assert.equal(JSON.stringify(response.body).includes(file), false, 'filesystem errors are not exposed');
  const second = await f.call('/pause', { agentId: ID, principal });
  assert.notEqual(second.status, 200); assert.equal(calls, 1, 'a missing authorization receipt still prevents execution');
  assert.equal(f.service.status().registrations[0].paused, false);
});

test('notices survive restart in the journal, stay deduplicated and are acknowledged through the owner control', posix, async t => {
  const f = fixture(t, { executorFor: () => async () => { throw new Error('PROVIDER_SECRET_CANARY'); } });
  f.control('register', { schedule: 'PT1H' });
  for (let i = 0; i < 2; i++) { f.control('run-now'); await f.service.idle(); }
  const [notice] = f.service.status().noticeLedgers[0].notices;
  assert.deepEqual([notice.kind, notice.detail, notice.occurrences, notice.delivery], ['execution', 'execution-failed', 2, 'pending-host-read']);
  assert.equal(JSON.stringify(f.service.history({ afterRevision: 0, limit: 16 })).includes('PROVIDER_SECRET_CANARY'), false);
  assert.throws(() => dreamControlRequest('ack-notice', { agentId: ID, noticeId: 'ntc_short' }), { code: 'dream-request-invalid' });
  const acked = f.control('ack-notice', { noticeId: notice.id });
  assert.deepEqual([acked.notice.state, acked.notice.delivery], ['acknowledged', 'host-acknowledged']);
  f.service.shutdown();
  const reopened = createDreamService(f.options);
  t.after(async () => { reopened.shutdown(); await reopened.idle(); });
  assert.deepEqual(reopened.status().noticeLedgers[0].notices, [acked.notice], 'notices are durable scheduler state');
  assert.throws(() => reopened.control(dreamControlRequest('ack-notice', { agentId: ID, noticeId: `ntc_${'0'.repeat(24)}` })), { code: 'dream-notice-not-found' });
});
