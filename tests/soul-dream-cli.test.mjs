import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { populationFile, upsertSoul } from '../agent-population.mjs';
import { createDaemonServer, daemonClient, daemonStateFile } from '../agent-daemon.mjs';
import { auditFile } from '../agent-principals.mjs';
import { createTurnRegistry } from '../wake-plane.mjs';
import { DREAM_USAGE, parseDreamArgs, soulDreamCommand } from '../cli/soul-dream.mjs';
import { main as soulSkillMain } from '../cli/soul-skill.mjs';

const ID = 'agent_11111111-1111-4111-8111-111111111111';
const OTHER = 'agent_22222222-2222-4222-8222-222222222222';
const RUN = '12345678-1234-4234-8234-123456789abc';
const OTHER_RUN = '22345678-1234-4234-8234-123456789abc';
const HASH = `sha256:${'a'.repeat(64)}`;
const principal = { principal: 'test-owner', secret: 'synthetic-test-value', brokerUid: 1234 };
const run = (agentId, runId, status = 'running') => ({ runId, agentId, soulDir: `/souls/${agentId}`, generation: RUN, daemonGeneration: RUN,
  trigger: 'manual', startedAt: '2026-10-09T00:00:00.000Z', endedAt: null, status, timeoutMs: 600000, cancelRequestedAt: null, cancelReason: null });
const STATUS = {
  schemaVersion: 1, available: true, executorConfigured: true, started: true, closing: false, maintenanceCoverage: 'unverified',
  revision: 4, registrations: [
    { agentId: ID, soulDir: `/souls/${ID}`, generation: RUN, intervalHours: 24, paused: false, nextDueAt: '2026-10-10T00:00:00.000Z', lastRun: null },
    { agentId: OTHER, soulDir: `/souls/${OTHER}`, generation: OTHER_RUN, intervalHours: 1, paused: false, nextDueAt: '2026-10-09T01:00:00.000Z', lastRun: null },
  ],
  flights: [run(ID, RUN), run(OTHER, OTHER_RUN)],
  inputReceipts: [{ runId: RUN, journalRevision: 3, startingRevision: HASH, digest: HASH }, { runId: OTHER_RUN, journalRevision: 4, startingRevision: HASH, digest: HASH }],
  selectionCheckpoints: [{ agentId: ID, runId: 'previous-successful-run', coverage: 'selection-only', processingCoverage: 'unverified' },
    { agentId: OTHER, runId: OTHER_RUN, coverage: 'selection-only', processingCoverage: 'unverified' }],
  outcomeReceipts: [{ runId: OTHER_RUN, journalRevision: 5, startingRevision: HASH, digest: HASH }],
  noticeLedgers: [{ schemaVersion: 1, agentId: ID, lastRunId: RUN, suppressed: 0, notices: [{ id: `ntc_${'a'.repeat(24)}`, kind: 'execution' }] },
    { schemaVersion: 1, agentId: OTHER, lastRunId: OTHER_RUN, suppressed: 2, notices: [{ id: `ntc_${'b'.repeat(24)}`, kind: 'report' }] }],
  fault: null, orphanRecovery: 'quarantine-only',
  journal: { revision: 99999, transactions: 99999, capacity: 100000, full: false, temporaryFiles: 0, automaticPruning: false, maxRecordBytes: 8388608 },
  diagnostics: { scope: 'this-daemon', inputFailures: [
    { agentId: ID, runId: RUN, code: 'dream-input-drift', at: '2026-10-09T00:00:00.000Z' },
    { agentId: OTHER, runId: OTHER_RUN, code: 'dream-input-limit', at: '2026-10-09T00:00:00.000Z' },
  ] },
};

const acknowledged = agentId => ({ kind: 'notice-acknowledged', at: '2026-10-09T00:00:00.000Z', agentId, noticeId: `ntc_${'a'.repeat(24)}` });

function fixture(t, { available = true, markers = [], control = null } = {}) {
  const home = mkdtempSync(path.join(tmpdir(), 'soul-dream-cli-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const env = { HOME: home, PATH: process.env.PATH, XDG_STATE_HOME: path.join(home, 'state'),
    AGENT_BOT_CONFIG: path.join(home, 'config.json'), AGENT_BOT_POPULATION_PATH: path.join(home, 'population.json'),
    AGENT_BOT_DAEMON_STATE_PATH: path.join(home, 'daemon.json'), AGENT_BOT_INTERACTION_HOME: path.join(home, 'interaction') };
  upsertSoul({ id: ID, name: 'bill', status: 'active', spacePath: home }, { file: populationFile({ env, home }) });
  upsertSoul({ id: OTHER, name: 'ann', status: 'active', spacePath: home }, { file: populationFile({ env, home }) });
  const calls = [], out = [], err = [];
  const client = {
    available: async () => available,
    dreamStatus: async () => { calls.push(['status']); return structuredClone(STATUS); },
    dreamHistory: async query => { calls.push(['history', query]); return { records: [
      { revision: 2, events: [{ kind: 'registered', registration: { agentId: OTHER } }] },
      { revision: 3, events: [{ kind: 'started', run: run(ID, RUN) }, { kind: 'started', run: run(OTHER, OTHER_RUN) }] },
      { revision: 4, events: [acknowledged(ID)] },
      { revision: 5, events: [acknowledged(OTHER)] },
    ], nextRevision: 5, remaining: 1 }; },
    dreamControl: async (action, body, options) => { calls.push(['control', action, body, options]); return { schemaVersion: 1, result: control ?? { agentId: ID, runId: RUN, status: 'started' } }; },
  };
  const invoke = (args, stdin = JSON.stringify(principal)) => soulDreamCommand(args, { env, home, cwd: home, client, markers: () => markers,
    readStdin: () => stdin, stdout: { write: text => out.push(text) }, stderr: { write: text => err.push(text) } });
  return { env, home, calls, out, err, invoke, json: () => JSON.parse(out.at(-1)) };
}

test('dream arguments are strict: one action, a soul, and only the flags that action takes', () => {
  for (const args of [
    [], ['--soul', ID], ['--status'], ['--soul', ID, '--status', '--history'], ['--soul', ID, '--status', '--status'],
    ['--soul', ID, '--soul', ID, '--status'], ['--soul', ID, '--status', 'extra'], ['--soul', ID, '--status', '--principal-stdin'],
    ['--soul', ID, '--history', '--principal-stdin'], ['--soul', ID, '--status', '--limit', '2'], ['--soul', ID, '--run-now', '--after-revision', '1'],
    ['--soul', ID, '--schedule', 'PT0H'], ['--soul', ID, '--schedule', 'PT721H'], ['--soul', ID, '--schedule', 'P1D'], ['--soul', ID, '--schedule', '0 3 * * *'],
    ['--soul', ID, '--cancel', 'not-a-run'], ['--soul', ID, '--cancel'], ['--soul', '--status'], ['--soul', ID, '--history', '--limit', '-1'],
    ['--soul', ID, '--history', '--limit', '1.5'], ['--soul', ID, '--history', '--limit', '0'], ['--soul', ID, '--run-now', '--force'],
    ['--soul', ID, '--ack-notice', 'ntc_short'], ['--soul', ID, '--ack-notice', RUN], ['--soul', ID, '--ack-notice'],
    ['--soul', ID, '--ack-notice', `ntc_${'a'.repeat(24)}`, '--status'],
  ]) assert.equal(parseDreamArgs(args), null, args.join(' '));
  assert.deepEqual(parseDreamArgs(['--soul', 'bill', '--schedule', 'PT24H', '--json', '--principal-stdin']), { action: 'register', control: true,
    soul: 'bill', schedule: 'PT24H', runId: null, noticeId: null, afterRevision: undefined, limit: undefined, json: true, presented: true });
  assert.equal(parseDreamArgs(['--soul', ID, '--history', '--after-revision', '0', '--limit', '16']).limit, 16);
  assert.deepEqual([parseDreamArgs(['--soul', ID, '--ack-notice', `ntc_${'a'.repeat(24)}`]).action, parseDreamArgs(['--soul', ID, '--ack-notice', `ntc_${'a'.repeat(24)}`]).control],
    ['ack-notice', true]);
});

test('status and history disclose only the named soul and always report unverified coverage', async t => {
  const f = fixture(t);
  assert.equal(await f.invoke(['--soul', 'bill', '--status', '--json']), 0);
  const status = f.json();
  assert.equal(status.agentId, ID);
  assert.equal(status.maintenanceCoverage, 'unverified');
  assert.deepEqual(status.flights.map(item => item.runId), [RUN]);
  assert.deepEqual(status.inputReceipts.map(item => item.runId), [RUN]);
  assert.deepEqual(status.outcomeReceipts, [], 'receipt kinds from later state versions are filtered too');
  assert.equal(status.registration.intervalHours, 24);
  assert.deepEqual(status.selectionCheckpoints, [STATUS.selectionCheckpoints[0]], 'checkpoints are filtered by soul, including an older successful run');
  assert.deepEqual(status.notices, STATUS.noticeLedgers[0], "only this soul's live notices are disclosed");
  assert.deepEqual([status.started, status.closing, status.orphanRecovery], [true, false, 'quarantine-only']);
  assert.deepEqual(status.journal, STATUS.journal, 'journal budget and no-pruning facts stay visible');
  assert.deepEqual(status.diagnostics, { scope: 'this-daemon', inputFailures: [STATUS.diagnostics.inputFailures[0]] },
    "this soul's capture failure is kept; another soul's is not");
  assert.equal(JSON.stringify(status).includes(OTHER), false, 'other souls are not disclosed');

  assert.equal(await f.invoke(['--soul', ID, '--history', '--after-revision', '1', '--limit', '2']), 0);
  assert.deepEqual(f.calls.at(-1), ['history', { afterRevision: 1, limit: 2 }]);
  const history = JSON.parse(f.out.at(-1));
  assert.deepEqual(history.records.map(record => [record.revision, record.events.length]), [[3, 1], [4, 1]],
    "this soul's acknowledgement is kept, even as a transaction's sole event; another soul's is not");
  assert.deepEqual(history.records[1].events[0], { kind: 'notice-acknowledged', at: '2026-10-09T00:00:00.000Z', agentId: ID, noticeId: `ntc_${'a'.repeat(24)}` });
  assert.deepEqual([history.nextRevision, history.remaining, history.maintenanceCoverage], [5, 1, 'unverified']);
  assert.equal(JSON.stringify(history).includes(OTHER), false);
});

test('controls pass the principal to the daemon, refuse soul callers and never fall back in process', async t => {
  const f = fixture(t);
  assert.equal(await f.invoke(['--soul', 'bill', '--schedule', 'PT24H', '--principal-stdin', '--json']), 0);
  assert.deepEqual(f.calls.at(-1), ['control', 'register', { agentId: ID, schedule: 'PT24H' }, { principal }]);
  assert.equal(await f.invoke(['--soul', ID, '--run-now']), 0);
  assert.deepEqual(f.calls.at(-1), ['control', 'run-now', { agentId: ID }, { principal: null }]);
  for (const action of ['--pause', '--unschedule']) {
    assert.equal(await f.invoke(['--soul', ID, action]), 0);
    assert.equal(f.calls.at(-1)[1], action.slice(2));
  }
  assert.equal(await f.invoke(['--soul', ID, '--cancel', RUN, '--json']), 1, 'a cancel result without a request fails');
  assert.deepEqual(f.calls.at(-1), ['control', 'cancel', { runId: RUN }, { principal: null }]);

  const deferred = fixture(t, { control: { agentId: ID, status: 'deferred', reason: 'busy' } });
  assert.equal(await deferred.invoke(['--soul', ID, '--run-now', '--json']), 1);
  assert.equal(deferred.json().result.reason, 'busy');

  const other = fixture(t);
  assert.equal(await other.invoke(['--soul', ID, '--cancel', OTHER_RUN, '--json']), 1);
  assert.equal(other.json().error.code, 'dream-run-not-found');
  assert.equal(other.calls.some(call => call[0] === 'control'), false, "another soul's run is never cancelled");

  const soul = fixture(t, { markers: ['agent binding'] });
  assert.equal(await soul.invoke(['--soul', ID, '--run-now', '--json']), 1);
  assert.equal(soul.json().error.code, 'owner-credential-required');
  assert.deepEqual(soul.calls, []);
  assert.equal(await soul.invoke(['--soul', ID, '--status', '--json']), 0, 'reading status needs no owner');

  const down = fixture(t, { available: false });
  assert.equal(await down.invoke(['--soul', ID, '--run-now', '--json']), 1);
  assert.equal(down.json().error.code, 'dream-daemon-unavailable');
  assert.deepEqual(down.calls, []);

  const bad = fixture(t);
  assert.equal(await bad.invoke(['--soul', ID, '--pause', '--principal-stdin', '--json'], 'not json'), 1);
  assert.equal(bad.json().error.code, 'dream-principal-invalid');
  assert.equal(await bad.invoke(['--soul', 'nobody', '--status']), 1);
  assert.equal(await bad.invoke(['--soul', ID, '--bogus']), 2);
  assert.equal(bad.err.at(-1), DREAM_USAGE);
});

test('soul skill dispatches dream and lists it in its usage', async t => {
  const f = fixture(t), out = [];
  assert.equal(soulSkillMain(['--help'], { stdout: { write: text => out.push(text) } }), 0);
  assert.match(out.join(''), /soul skill dream --soul/);
  const err = [];
  assert.equal(await soulSkillMain(['dream', '--soul', ID], { stdout: { write: () => {} }, stderr: { write: text => err.push(text) } }), 2);
  assert.equal(err.join(''), DREAM_USAGE);
  assert.equal(f.calls.length, 0);
});

test('the CLI reaches the real owner-gated daemon routes through the daemon client', async t => {
  const f = fixture(t), requests = [], gates = [];
  const server = createDaemonServer({ env: f.env, home: f.home, config: {}, turns: createTurnRegistry(),
    settingGate: async (action, { principal: credential }) => {
      gates.push(action);
      if (credential?.secret !== principal.secret) throw Object.assign(new Error('refused'), { code: 'owner-credential-required' });
      return { method: 'principal' };
    } });
  server.dream = {
    status: () => ({ ...structuredClone(STATUS), closing: true }),
    history: query => { requests.push(['history', query]); return { records: [], nextRevision: 4, remaining: 0 }; },
    control: request => { requests.push(['control', request.action, request.agentId]); return { agentId: ID, runId: RUN, status: 'started' }; },
  };
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  writeFileSync(daemonStateFile(f), JSON.stringify({ schemaVersion: 1, pid: process.pid, host: '127.0.0.1',
    port: server.address().port, token: server.token, startedAt: '2026-10-09T00:00:00.000Z' }), { mode: 0o600 });
  const out = [], err = [];
  const cli = (args, stdin = JSON.stringify(principal)) => soulDreamCommand(args, { env: f.env, home: f.home, cwd: f.home,
    client: daemonClient({ env: f.env, home: f.home, cwd: f.home }), markers: () => [], readStdin: () => stdin,
    stdout: { write: text => out.push(text) }, stderr: { write: text => err.push(text) } });

  assert.equal(await cli(['--soul', 'bill', '--status', '--json']), 0);
  const viaHttp = JSON.parse(out.at(-1));
  assert.deepEqual(viaHttp.flights.map(item => item.runId), [RUN]);
  assert.deepEqual([viaHttp.available, viaHttp.closing, viaHttp.journal.transactions], [true, true, 99999]);
  assert.deepEqual(viaHttp.diagnostics.inputFailures.map(row => row.code), ['dream-input-drift']);
  assert.equal(await cli(['--soul', 'bill', '--history', '--limit', '5', '--json']), 0);
  assert.deepEqual(requests.at(-1), ['history', { limit: 5 }]);

  assert.equal(await cli(['--soul', 'bill', '--run-now', '--json']), 1, 'bearer alone is not owner authorization');
  assert.equal(JSON.parse(out.at(-1)).error.code, 'owner-credential-required');
  assert.equal(requests.some(request => request[0] === 'control'), false);
  assert.equal(await cli(['--soul', 'bill', '--run-now', '--principal-stdin', '--json']), 0);
  assert.deepEqual(requests.at(-1), ['control', 'run-now', ID]);
  assert.deepEqual(JSON.parse(out.at(-1)).result, { agentId: ID, runId: RUN, status: 'started' });
  assert.equal(gates.at(-1), `soul dream ${ID} run-now`);
  const NOTICE = `ntc_${'a'.repeat(24)}`;
  server.dream.control = request => { requests.push(['control', request.action, request.agentId, request.noticeId]);
    return { agentId: ID, notice: { id: request.noticeId, state: 'acknowledged', acknowledgedAt: '2026-10-09T00:00:00.000Z' } }; };
  assert.equal(await cli(['--soul', 'bill', '--ack-notice', NOTICE, '--principal-stdin', '--json']), 0);
  assert.deepEqual(requests.at(-1), ['control', 'ack-notice', ID, NOTICE]);
  assert.equal(gates.at(-1), `soul dream ${ID} ack-notice ${NOTICE}`, 'the owner sees which notice is acknowledged');
  assert.equal(await cli(['--soul', 'bill', '--ack-notice', NOTICE, '--json']), 1, 'acknowledgement is an owner control');
  server.dream.control = () => { throw Object.assign(new Error('Configure a dream executor first.'), { code: 'dream-executor-unconfigured', statusCode: 409 }); };
  assert.equal(await cli(['--soul', 'bill', '--pause', '--principal-stdin', '--json']), 1);
  assert.deepEqual(JSON.parse(out.at(-1)).error.code, 'dream-executor-unconfigured', 'dream codes reach --json through the HTTP body');
  server.dream.control = () => { throw Object.assign(new Error('boom'), { code: 'EACCES' }); };
  assert.equal(await cli(['--soul', 'bill', '--pause', '--principal-stdin', '--json']), 1);
  assert.equal(JSON.parse(out.at(-1)).error.code, 'dream-failed', 'other codes are not forwarded');
  const audit = auditFile({ env: f.env, home: f.home });
  const breakOutcomeAudit = () => { renameSync(audit, `${audit}.saved`); mkdirSync(audit); };
  const restoreAudit = () => { rmSync(audit, { recursive: true }); renameSync(`${audit}.saved`, audit); };
  server.dream.control = () => { breakOutcomeAudit(); return { agentId: ID, runId: RUN, status: 'started' }; };
  assert.equal(await cli(['--soul', 'bill', '--run-now', '--principal-stdin', '--json']), 0, 'a started run must not be presented as failed');
  assert.equal(JSON.parse(out.at(-1)).result.runId, RUN);
  assert.deepEqual(JSON.parse(out.at(-1)).audit, { status: 'unconfirmed', code: 'dream-control-audit-unconfirmed' });
  restoreAudit();
  server.dream.control = () => { breakOutcomeAudit(); throw Object.assign(new Error('Executor unavailable.'), { code: 'dream-executor-unconfigured', statusCode: 409 }); };
  assert.equal(await cli(['--soul', 'bill', '--pause', '--principal-stdin', '--json']), 1);
  assert.equal(JSON.parse(out.at(-1)).error.code, 'dream-executor-unconfigured', 'the original failure survives a failed audit append');
  assert.deepEqual(JSON.parse(out.at(-1)).audit, { status: 'unconfirmed', code: 'dream-control-audit-unconfirmed' });
  restoreAudit();
  assert.equal(await cli(['--soul', 'bill', '--pause', '--principal-stdin']), 1);
  assert.match(err.at(-1), /control outcome audit could not be confirmed/);
  assert.equal(JSON.stringify(out).includes(audit), false);
  assert.equal(JSON.stringify(out).includes(principal.secret), false);
});

test('the agent-bot entrypoint reaches dream with stdin for the principal', async t => {
  const f = fixture(t), seen = [];
  const server = createDaemonServer({ env: f.env, home: f.home, config: {}, turns: createTurnRegistry(),
    settingGate: async (action, { principal: credential }) => {
      if (credential?.secret !== principal.secret) throw Object.assign(new Error('refused'), { code: 'owner-credential-required' });
      return { method: 'principal' };
    } });
  server.dream = { status: () => structuredClone(STATUS), history: () => ({ records: [], nextRevision: 0, remaining: 0 }),
    control: request => { seen.push(request.action); return { agentId: ID, ...request.action === 'pause' ? { paused: true } : {} }; } };
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const cli = fileURLToPath(new URL('../agent-bot.mjs', import.meta.url));
  const invoke = (args, input = '') => new Promise(resolve => {
    const child = execFile(process.execPath, [cli, 'soul', 'skill', 'dream', ...args], { env: f.env, cwd: f.home },
      (error, stdout, stderr) => resolve({ code: error?.code ?? 0, stdout, stderr }));
    child.stdin.end(input);
  });
  let result = await invoke(['--help']);
  assert.deepEqual([result.code, result.stdout], [0, DREAM_USAGE]);
  result = await invoke(['--soul', 'bill', '--status', '--json']);
  assert.equal(result.code, 1, 'no daemon state yet');
  assert.equal(JSON.parse(result.stdout).error.code, 'dream-daemon-unavailable');
  writeFileSync(daemonStateFile(f), JSON.stringify({ schemaVersion: 1, pid: process.pid, host: '127.0.0.1',
    port: server.address().port, token: server.token, startedAt: '2026-10-09T00:00:00.000Z' }), { mode: 0o600 });
  result = await invoke(['--soul', 'bill', '--pause', '--principal-stdin', '--json'], JSON.stringify(principal));
  assert.equal(result.code, 0, result.stdout + result.stderr);
  assert.deepEqual(seen, ['pause']);
  assert.equal(JSON.parse(result.stdout).result.paused, true);
  result = await invoke(['--soul', 'bill', '--bogus']);
  assert.deepEqual([result.code, result.stderr], [2, DREAM_USAGE]);
});
