// The daemon's lifecycle, turn and approval diagnostics (#983, ADR-0983).
//
// Each wrapper records into the local diagnostics store (and, when the owner
// configured it, the OTLP exporter behind it) and returns exactly what the
// wrapped call returned or threw: recording never changes a turn, an
// approval or the daemon's start. Only allowlisted fields are recorded: the
// harness and decision as a stage, a stable code, the outcome, the duration
// and the agent (hashed by the store). Messages go only into `detail`, which
// the store redacts and the exporter never sends.

import { startSpan } from './traceparent.mjs';

const NAME = /^[a-z][a-z0-9]*(?:[-.][a-z0-9]+)*$/;
const stageName = (value) => (typeof value === 'string' && value.length <= 64 && NAME.test(value) ? value : undefined);

function record(diagnostics, fields) {
  if (!diagnostics) return;
  try { diagnostics.record(fields); } catch { /* diagnostics never change the work */ }
}

/**
 * The stable code for a turn that did not finish (registered in
 * governance/error-codes.json): a cancelled turn, a harness that exited or
 * could not start, else `turn-failed`.
 */
export function turnFailureCode(error, { aborted = false } = {}) {
  if (aborted) return 'turn-cancelled';
  const message = String(error?.message ?? '');
  if (message.includes('agent process exited before the turn finished')) return 'harness-exited';
  if (message.includes('acp engine: cannot start') || message.includes('acp engine: failed to run agent process')) return 'harness-start-failed';
  return 'turn-failed';
}

/** An executor that records one `turn` event per turn, under its own span. */
export function withTurnDiagnostics(executor, { diagnostics, nowMs = () => Date.now() } = {}) {
  if (!diagnostics) return executor;
  return async (input) => {
    const span = startSpan();
    const startedAt = nowMs();
    const base = {
      event: 'turn', stage: stageName(input?.invocation?.harness), traceId: span.traceId, spanId: span.spanId,
      agentId: typeof input?.invocation?.agentId === 'string' ? input.invocation.agentId : undefined,
    };
    try {
      const result = await executor(input);
      record(diagnostics, { ...base, outcome: 'ok', durationMs: nowMs() - startedAt });
      return result;
    } catch (error) {
      const code = turnFailureCode(error, { aborted: input?.signal?.aborted === true });
      record(diagnostics, { ...base, outcome: code === 'turn-cancelled' ? 'refused' : 'failed', code, durationMs: nowMs() - startedAt, detail: error });
      throw error;
    }
  };
}

/**
 * An approval port that records one `approval` event per request: `ok` when
 * allowed; `refused` when the owner denied it, it expired or it was
 * cancelled, which are expected outcomes, not faults; `failed` when the
 * request itself threw.
 */
export function diagnosedApprovals(approve, { diagnostics, nowMs = () => Date.now() } = {}) {
  if (!diagnostics) return approve;
  return async (request) => {
    const startedAt = nowMs();
    const agentId = typeof request?.agentId === 'string' ? request.agentId : undefined;
    try {
      const result = await approve(request);
      const allowed = result?.decision === 'allow';
      const code = allowed ? undefined : (result?.expired ? 'approval-expired' : result?.cancelled ? 'approval-cancelled' : 'approval-denied');
      record(diagnostics, {
        event: 'approval', stage: stageName(result?.decision), outcome: allowed ? 'ok' : 'refused', code, agentId, durationMs: nowMs() - startedAt,
      });
      return result;
    } catch (error) {
      record(diagnostics, { event: 'approval', outcome: 'failed', code: 'approval-failed', agentId, durationMs: nowMs() - startedAt, detail: error });
      throw error;
    }
  };
}

/** The code for a daemon start that failed before it was ready to serve. */
export function daemonStartCode(error) {
  return /daemon already running/.test(String(error?.message ?? '')) ? 'daemon-already-running' : 'daemon-start-failed';
}

/** Records the daemon start: ready (`ok`), or where and why it stopped first. */
export function recordDaemonStart(diagnostics, { startedAt, nowMs = () => Date.now(), error = null } = {}) {
  if (!error) { record(diagnostics, { event: 'daemon-start', stage: 'ready', outcome: 'ok', durationMs: nowMs() - startedAt }); return; }
  const code = daemonStartCode(error);
  record(diagnostics, {
    event: 'daemon-start', outcome: code === 'daemon-already-running' ? 'refused' : 'failed', code, durationMs: nowMs() - startedAt, detail: error,
  });
}

/** Records a signalled shutdown, with the signal as its stage. */
export function recordDaemonShutdown(diagnostics, { signal = null, startedAt = null, nowMs = () => Date.now() } = {}) {
  record(diagnostics, {
    event: 'daemon-shutdown', stage: stageName(typeof signal === 'string' ? signal.toLowerCase() : null), outcome: 'ok',
    ...(startedAt === null ? {} : { durationMs: nowMs() - startedAt }),
  });
}
