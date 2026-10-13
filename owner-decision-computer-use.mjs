// The computer-use owner-decision adapter (agent-comms#250, first phase):
// disabled, no route. It applies one released `soul.computer-use.set`
// request, permission only: disabling denies the soul's later computer-use
// tool calls and never stops a turn. The local POST /v0/soul/computer-use
// route, which does stop turns, is separate and unchanged.
//
// The order is fixed and runs under one held population lock
// (agent-population.mjs runComputerUseOwnerDecision): compare, refuse before
// entry with a recorded reason, enter through the owner-decision gate,
// write durably or flush the existing census for a no-op, read back, and
// complete record-only. This module supplies the three owner-decision steps
// through the population seam it seals once when it loads; nothing else can
// supply them. Any error after entry is indeterminate and is never retried,
// and the audit line is written once, best effort, after completion.
//
// Everything that names state, proof, identity or the clock is this daemon's
// own and derived here: its trust store and journal, its census, Date.now.
// The caller supplies only the request it presents.
import { createDaemonJournalStore, readOwnerDecisionTrust } from './identity-host.mjs';
import { enterOwnerDecisionEffect } from './owner-decision-effect-gate.mjs';
import { populationFile, runComputerUseOwnerDecision, sealComputerUseOwnerDecision } from './agent-population.mjs';
import { appendAuditReceipt, isAgentId } from './identity-format.mjs';

export const COMPUTER_USE_OPERATION = 'soul.computer-use.set';
const seconds = () => Math.floor(Date.now() / 1000);

// The released request, read under the population lock: its soul, the
// boolean captured at preparation and the one the action asks for. A request
// that isn't released (consumed, absent, not yet checked) or isn't this
// operation is answered unrecorded; one this adapter can't apply is refused
// before entry as validation-failed.
function read(context) {
  let view;
  try { view = context.store.readReleased(context.requestId); } catch (error) {
    // The journal's specific reason (owner-journal-consumed, …) over its class code.
    const reason = typeof error?.reason === 'string' ? error.reason : typeof error?.code === 'string' ? error.code : 'request-unavailable';
    return Object.freeze({ state: 'refused', requestId: context.requestId, reason });
  }
  if (view.action.operation !== COMPUTER_USE_OPERATION) return Object.freeze({ state: 'refused', requestId: context.requestId, reason: 'not-computer-use' });
  const { soul, parameters } = view.action, expected = view.preparation.expected;
  if (!isAgentId(soul) || typeof parameters?.enabled !== 'boolean' || expected?.kind !== 'computer-use' || typeof expected.enabled !== 'boolean') {
    return refuse(context, 'validation-failed');
  }
  return Object.freeze({ state: 'request', agentId: soul, expectedEnabled: expected.enabled, desiredEnabled: parameters.enabled });
}

// A durable pre-effect refusal with the mapped reason. A refusal that can't
// be recorded is storage-failed: nothing was applied, and nothing says so.
function refuse(context, code) {
  try {
    const settled = context.store.refusePreEffect(context.requestId, { code, at: seconds() });
    return Object.freeze({ state: 'refused', requestId: context.requestId, code, outcome: settled.outcome });
  } catch (error) {
    return Object.freeze({ state: 'storage-failed', requestId: context.requestId, code, reason: typeof error?.code === 'string' ? error.code : 'storage-failed' });
  }
}

// The gate: trust, presence, target, then the durable entered record.
function enter(context) {
  return enterOwnerDecisionEffect({ requestId: context.requestId, presenceToken: context.presenceToken });
}

// Record-only completion through the gate's own store instance and entry.
function complete(context, entered) {
  return entered.complete({ at: seconds() });
}

sealComputerUseOwnerDecision(Object.freeze({ read, refuse, enter, complete }));

export function applyComputerUseOwnerDecision({ requestId, presenceToken } = {}) {
  let namespaceDigest;
  try { ({ namespaceDigest } = readOwnerDecisionTrust()); } catch {
    return Object.freeze({ state: 'refused', requestId, reason: 'trust-unavailable' });
  }
  const store = createDaemonJournalStore({ namespaceDigest });
  const context = Object.freeze({ store, requestId, presenceToken });
  const result = runComputerUseOwnerDecision(context, { file: populationFile() });
  if (result?.state === 'applied' && result.written) {
    try {
      appendAuditReceipt({ event: 'computer-use', agentId: result.agentId, operation: 'set', decision: result.after ? 'on' : 'off', detail: 'owner-decision' });
    } catch { /* applied and completed; the audit line is best effort and never retried */ }
  }
  return result;
}
