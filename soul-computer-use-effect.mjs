// The domain effect of a remote owner decision on a soul's computer use
// (agent-comms#250, first phase): permission only. Disabling denies the
// soul's further computer-use tool calls, because the executor re-reads the
// setting on every call and again after an approval wait
// (executor-contract.mjs requestPermission). It never stops a turn: the
// owner decided the first phase must not call the whole-soul stop path, which
// can't target one prepared turn and would stop a later or overlapping one.
// So this module takes no turn registry, wake plane or activity tracker, and
// has nothing it could stop.
//
// The local `POST /v0/soul/computer-use` route is unchanged (owner decision):
// it still stops the soul's turns when it disables an active one.
//
// Disabled: no route calls this. The #77 owner-decision effect gate
// (owner-decision-effect-gate.mjs) will, once `soul.computer-use.set` exists
// with agent-comms vectors and #77's production gates allow it.
import { compareAndSetSoulComputerUse, populationFile } from './agent-population.mjs';
import { appendAuditReceipt } from './identity-format.mjs';

const refuse = (code, message) => { throw Object.assign(new Error(message), { code }); };

// Applies `enabled` to one soul only if its current setting is
// `expectedEnabled`, the state the owner saw. Returns `{ agentId, before,
// after, written, audited }`. A stale expected state refuses
// `stale-expected-state` and an absent or retired soul refuses
// `soul-not-found`; both write nothing. The audit line is best effort: once
// the setting is written the effect has happened, so a failed audit write is
// reported as `audited: false`, never as a failed effect.
export function applyComputerUseSetting({ agentId, enabled, expectedEnabled } = {}, {
  env = process.env, home = env.HOME, now = () => new Date(), file = populationFile({ env, home }),
} = {}) {
  if (typeof agentId !== 'string' || !agentId) refuse('invalid-request', 'agentId is required');
  if (typeof enabled !== 'boolean') refuse('invalid-request', 'enabled must be a boolean');
  if (typeof expectedEnabled !== 'boolean') refuse('invalid-request', 'expectedEnabled must be a boolean');
  const { before, after, written } = compareAndSetSoulComputerUse(agentId, expectedEnabled, enabled, { file });
  let audited = false;
  if (written) {
    try {
      appendAuditReceipt({ event: 'computer-use', agentId, operation: 'set', decision: after ? 'on' : 'off', detail: 'owner-decision' }, { env, home, now });
      audited = true;
    } catch { /* the setting is written; the audit line is best effort */ }
  }
  return { agentId, before, after, written, audited };
}
