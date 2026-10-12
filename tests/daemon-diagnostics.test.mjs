import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAcpExecutor } from '../acp-engine.mjs';
import { readDiagnostics } from '../diagnostics.mjs';
import {
  diagnosedApprovals, recordDaemonShutdown, recordDaemonStart, turnFailureCode, withTurnDiagnostics,
} from '../daemon-diagnostics.mjs';
import { runDaemon } from '../agent-daemon.mjs';

const AGENT = 'agent_11111111-1111-4111-8111-111111111111';
const CANARY = 'ghs_CANARYcanary0123456789abcdefABCDEF';
const REGISTRY = JSON.parse(readFileSync(new URL('../governance/error-codes.json', import.meta.url), 'utf8'));

function recorder() {
  const events = [];
  return { events, diagnostics: { record: (fields) => { events.push(fields); return true; } } };
}

const port = (signal = new AbortController().signal) => ({
  invocation: { agentId: AGENT, harness: 'claude', cwd: tmpdir() }, message: 'hi', attachments: [],
  appendEvent: (type, data) => ({ type, data }), addArtifact: () => {}, requestApproval: async () => ({ decision: 'deny' }), signal,
});

test('every code these diagnostics record is registered, with the matching kind', () => {
  const kinds = new Map(REGISTRY.codes.map((entry) => [entry.code, entry.kind]));
  const expected = {
    'turn-failed': 'failure', 'turn-cancelled': 'refusal', 'harness-exited': 'failure', 'harness-start-failed': 'failure',
    'approval-denied': 'refusal', 'approval-expired': 'refusal', 'approval-cancelled': 'refusal', 'approval-failed': 'failure',
    'daemon-start-failed': 'failure', 'daemon-already-running': 'refusal', 'diagnostics-dropped': 'failure',
  };
  for (const [code, kind] of Object.entries(expected)) assert.equal(kinds.get(code), kind, code);
});

test('a turn records its outcome and code and returns or throws exactly as the executor did', async () => {
  const { events, diagnostics } = recorder();
  let clock = 0;
  const nowMs = () => (clock += 10);
  const ok = withTurnDiagnostics(async () => 'result', { diagnostics, nowMs });
  assert.equal(await ok(port()), 'result');
  const failure = new Error(`boom ${CANARY}`);
  const bad = withTurnDiagnostics(async () => { throw failure; }, { diagnostics, nowMs });
  await assert.rejects(bad(port()), (error) => error === failure);
  const aborted = new AbortController();
  aborted.abort();
  await assert.rejects(bad(port(aborted.signal)), (error) => error === failure);
  assert.deepEqual(events.map((e) => [e.event, e.stage, e.outcome, e.code, e.agentId]), [
    ['turn', 'claude', 'ok', undefined, AGENT],
    ['turn', 'claude', 'failed', 'turn-failed', AGENT],
    ['turn', 'claude', 'refused', 'turn-cancelled', AGENT],
  ]);
  for (const e of events) {
    assert.match(e.traceId, /^[0-9a-f]{32}$/);
    assert.equal(e.durationMs, 10);
  }
  assert.notEqual(events[0].traceId, events[1].traceId, 'each turn is its own trace');
  // A recorder that throws changes nothing.
  const broken = withTurnDiagnostics(async () => 'still', { diagnostics: { record: () => { throw new Error('disk'); } } });
  assert.equal(await broken(port()), 'still');
  assert.equal(withTurnDiagnostics(ok, { diagnostics: null }), ok);
});

test('an abrupt harness exit and a harness that cannot start are coded from the real engine', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'daemon-diag-turn-'));
  const run = async (command, args) => {
    const { events, diagnostics } = recorder();
    const executor = createAcpExecutor({
      harness: 'claude', identity: { app: 'x-claude-agent', agentId: AGENT }, policy: { version: 1, rules: [], fallback: 'allow' },
      cwd, env: { PATH: process.env.PATH, HOME: cwd }, registry: { claude: { harness: 'claude', enabled: true, command, args, stripEnv: [] } },
    });
    await assert.rejects(withTurnDiagnostics(executor, { diagnostics })({ ...port(), invocation: { agentId: AGENT, harness: 'claude', cwd } }));
    return events.at(-1);
  };
  const exited = await run(process.execPath, ['-e', 'process.exit(3)']);
  assert.deepEqual([exited.outcome, exited.code], ['failed', 'harness-exited']);
  const missing = await run(join(cwd, 'no-such-harness'), []);
  assert.deepEqual([missing.outcome, missing.code], ['failed', 'harness-start-failed']);
  assert.equal(turnFailureCode(new Error('anything else')), 'turn-failed');
});

test('approvals record allow as ok and deny, expiry and cancellation as expected refusals', async () => {
  const { events, diagnostics } = recorder();
  const answers = [{ decision: 'allow' }, { decision: 'deny' }, { decision: 'deny', expired: true }, { decision: 'deny', cancelled: true }];
  const approve = diagnosedApprovals(async () => answers.shift(), { diagnostics });
  for (let i = 0; i < 4; i += 1) await approve({ agentId: AGENT, operation: 'tool' });
  const failure = new Error('store unavailable');
  await assert.rejects(diagnosedApprovals(async () => { throw failure; }, { diagnostics })({ agentId: AGENT }), (error) => error === failure);
  assert.deepEqual(events.map((e) => [e.event, e.stage, e.outcome, e.code]), [
    ['approval', 'allow', 'ok', undefined],
    ['approval', 'deny', 'refused', 'approval-denied'],
    ['approval', 'deny', 'refused', 'approval-expired'],
    ['approval', 'deny', 'refused', 'approval-cancelled'],
    ['approval', undefined, 'failed', 'approval-failed'],
  ]);
  assert.ok(events.slice(0, 4).every((e) => e.agentId === AGENT && e.detail === undefined));
});

test('daemon start and shutdown are recorded; an already-running daemon is a refusal', () => {
  const { events, diagnostics } = recorder();
  recordDaemonStart(diagnostics, { startedAt: 0, nowMs: () => 40 });
  recordDaemonStart(diagnostics, { startedAt: 0, nowMs: () => 5, error: new Error('daemon already running (pid 1, port 2)') });
  recordDaemonStart(diagnostics, { startedAt: 0, nowMs: () => 5, error: new Error(`listen EADDRINUSE ${CANARY}`) });
  recordDaemonShutdown(diagnostics, { signal: 'SIGTERM', startedAt: 0, nowMs: () => 1000 });
  assert.deepEqual(events.map((e) => [e.event, e.stage, e.outcome, e.code, e.durationMs]), [
    ['daemon-start', 'ready', 'ok', undefined, 40],
    ['daemon-start', undefined, 'refused', 'daemon-already-running', 5],
    ['daemon-start', undefined, 'failed', 'daemon-start-failed', 5],
    ['daemon-shutdown', 'sigterm', 'ok', undefined, 1000],
  ]);
});

test('a daemon that fails before it is ready leaves a coded, redacted start event in the store', async () => {
  const home = mkdtempSync(join(tmpdir(), 'daemon-diag-start-'));
  const env = { XDG_STATE_HOME: join(home, '.local', 'state'), AGENT_BOT_CONFIG: join(home, 'none.json') };
  await assert.rejects(runDaemon({ env, home, config: {}, port: '70000' }), /daemon port/);
  await assert.rejects(runDaemon({ env, home, config: {}, host: '0.0.0.0', port: '0' }));
  const events = readDiagnostics({ env, home });
  assert.deepEqual(events.map((e) => [e.component, e.event, e.outcome, e.code]), [
    ['daemon', 'daemon-start', 'failed', 'daemon-start-failed'],
    ['daemon', 'daemon-start', 'failed', 'daemon-start-failed'],
  ]);
  assert.match(events[0].detail, /daemon port must be an integer/);
  assert.equal(JSON.stringify(events).includes(home), false);
});
