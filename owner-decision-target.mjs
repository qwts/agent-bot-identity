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

// Classification of one request from the two read results. Internal: no
// production caller can supply its own read results.
function classifyOwnerDecisionTarget({ account, soul } = {}, { daemonAccount, row = null, record = null } = {}) {
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

// The final-entry identity port's exact shape: a frozen
// { kind: 'owner-decision-identity-read-v1', read(id) } whose read is
// synchronous. The host builds it (owner-decision-identity-port.mjs); soul
// only checks the shape and never launches a process or awaits.
const IDENTITY_PORT_KIND = 'owner-decision-identity-read-v1';
// Exactly two own data properties, kind and read: nothing inherited, no
// accessors, so checking the port never runs caller code.
function validPort(port) {
  if (port === null || typeof port !== 'object' || !Object.isFrozen(port)) return false;
  const names = Object.getOwnPropertyNames(port);
  if (names.length !== 2 || !names.includes('kind') || !names.includes('read') || Object.getOwnPropertySymbols(port).length !== 0) return false;
  const kind = Object.getOwnPropertyDescriptor(port, 'kind'), read = Object.getOwnPropertyDescriptor(port, 'read');
  return 'value' in kind && 'value' in read && kind.value === IDENTITY_PORT_KIND && typeof read.value === 'function';
}

// Resolution for the locked final entry: the same fixed census read, then the
// identity through the strict in-process port, classified identically. A
// missing or malformed port, a port that returns a promise, or any read
// failure gives the same uniform refusal.
export function resolveOwnerDecisionTargetLocked(request = {}, { daemonAccount, file = populationFile(), identityPort } = {}) {
  if (!validPort(identityPort)) return TARGET_REFUSAL;
  const id = matches(SOUL, request?.soul) ? request.soul : PLACEHOLDER_SOUL;
  let row = null, record = null;
  try { row = showSoul(id, { file }); } catch { row = null; }
  try {
    record = Object.getOwnPropertyDescriptor(identityPort, 'read').value(id);
    if (record !== null && typeof record === 'object' && typeof record.then === 'function') record = null;
  } catch { record = null; }
  return classifyOwnerDecisionTarget(request, { daemonAccount, row, record });
}
