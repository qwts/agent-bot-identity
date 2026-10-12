// Disabled owner-decision prepare-side target resolution (agent-comms#77, C2).
// The daemon resolves the action's soul by Agent ID from its own local state
// (the population census and the identity record), never from comms hub
// membership or receive allowlists, and checks the account against its own
// paired account. Every target it cannot act for (malformed, another
// account, missing from the census, retired in the census or identity, or
// unreadable) becomes the same early refusal, after the same bounded local
// work, so a result never tells whether a soul exists or whose it is.
// No route, transport or authority: a resolved target is only "local and
// live at prepare time"; final entry rechecks under its locks.
import { identityOp } from './daemon-client.mjs';
import { populationFile, showSoul } from './agent-population.mjs';

const SOUL = /^agent_[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
// Stands in for a malformed Agent ID so that case still does both reads.
const PLACEHOLDER_SOUL = 'agent_00000000-0000-4000-8000-000000000000';
const matches = (pattern, value) => typeof value === 'string' && pattern.exec(value)?.[0] === value;

// The one early refusal: validation-refused, no receipt, no effect, no
// detail. Frozen and shared, so every refused case is the same value.
export const TARGET_REFUSAL = Object.freeze({
  state: 'refused',
  receiptDigest: null,
  outcome: Object.freeze({ code: 'validation-refused', effectDigest: null }),
});

// Pure classification of one request from the two read results (values, not
// functions): the resolved target, or TARGET_REFUSAL.
export function classifyOwnerDecisionTarget({ account, soul } = {}, { daemonAccount, row = null, record = null } = {}) {
  const id = matches(SOUL, soul) ? soul : PLACEHOLDER_SOUL;
  const live = matches(SOUL, soul) && typeof account === 'string' && account.length > 0
    && typeof daemonAccount === 'string' && daemonAccount.length > 0 && account === daemonAccount
    && row !== null && typeof row === 'object' && row.status !== 'retired'
    && record !== null && typeof record === 'object' && record.id === id && ['active', 'finalized'].includes(record.status);
  return live ? Object.freeze({ state: 'resolved', target: Object.freeze({ account, soul: id }) }) : TARGET_REFUSAL;
}

// Resolves at prepare time with the fixed local reads only: the census at
// `file` and the identity entry's read under `stateDir`. No resolver or read
// function can be injected. Both reads always run, of the request's Agent ID
// or of the fixed placeholder, whatever the request holds.
//
// The refusal deliberately carries no request binding. The caller that
// reports it (C2's owner-decision-result) attaches the saved acceptance
// binding {requestId, payloadDigest, daemonKey, daemonEpoch, watchId} itself.
export function resolveOwnerDecisionTarget(request = {}, { daemonAccount, file = populationFile(), stateDir } = {}) {
  const id = matches(SOUL, request?.soul) ? request.soul : PLACEHOLDER_SOUL;
  let row = null, record = null;
  try { row = showSoul(id, { file }); } catch { row = null; }
  try { record = identityOp('read', { id, ...(stateDir ? { stateDir } : {}) }); } catch { record = null; }
  return classifyOwnerDecisionTarget(request, { daemonAccount, row, record });
}
