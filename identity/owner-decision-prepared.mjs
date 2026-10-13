// Disabled composition of the daemon's owner-decision prepared response
// (#1007, agent-comms#77) against agent-comms 0686f2c (merged #204). Pure: no
// transport, route, signing, journal write or activation. The caller supplies
// the custody-verified saved admission and, for a staged action, the public
// part of the daemon's own immutable stage descriptor, never request input.
//
// Products, all deterministic from the same inputs so a duplicate never
// regenerates anything:
// - `challenge` / `challengeBytes`: the exact public challenge. Its canonical
//   bytes are daemon slot 3 (`prepared-challenge`), unchanged by #204.
// - `request`: the `owner-decision-prepared` fields
//   `{requestId,payloadDigest,daemonKey,daemonEpoch,watchId,nonce,preparedAt,exp,stage}`.
// - `stage`: the same public descriptor slot 6 (`preparation`) retains.
import { canonicalJson } from '../canonical-json.mjs';
import { DAEMON_JOURNAL_SLOTS } from './owner-decision-journal-frame.mjs';
import { validateDaemonAdmission } from './owner-decision-journal-store.mjs';
import { challengeFor } from './owner-decision-evidence.mjs';
import { COMPUTER_USE_OPERATION, decodeOwnerDecisionAction } from './owner-decision-action.mjs';

export const PREPARE_WINDOW_SECONDS = 180;
export const CLOCK_SKEW_SECONDS = 30;
// The broker retains `{challenge,stage,v:1}` within the same 32768-byte cap.
export const PREPARED_WRAPPER_CAP = 32768;
const CHALLENGE_CAP = DAEMON_JOURNAL_SLOTS.find(({ slot }) => slot === 'prepared-challenge').cap;
const UUID4 = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const DIGEST = /^[a-f0-9]{64}$/;
const matches = (pattern, value) => typeof value === 'string' && pattern.exec(value)?.[0] === value;
const integer = (value) => Number.isSafeInteger(value) && value >= 0;
const plain = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

// Schema and binding refusals are bad-request; a deadline or clock-window
// refusal is preparation-stale. Neither is authority or an effect finding.
const refuse = (reason) => { throw Object.assign(new Error('owner decision preparation refused'), { code: reason === 'owner-prepare-stale' ? 'preparation-stale' : 'bad-request', reason }); };

// Refuses instead of producing an unsafe or negative deadline.
function plus(value, delta) {
  if (!integer(value) || !integer(value + delta)) refuse('owner-prepare-stale');
  return value + delta;
}

// The exact public stage the action names: null when unstaged, otherwise the
// same staging ID, the kind its operation implies, the content digest it
// carries, and a nonnegative safe expiry.
function bindStage(action, stage) {
  const parameters = action.parameters;
  if (!Object.hasOwn(parameters, 'stagingId')) {
    if (stage !== null) refuse('owner-prepare-stage');
    return null;
  }
  const webhook = action.operation === 'cold-wake.set';
  if (!plain(stage) || Object.keys(stage).length !== 4 || !['stagingId', 'kind', 'contentDigest', 'expiresAt'].every((key) => Object.hasOwn(stage, key))
    || !matches(UUID4, stage.stagingId) || stage.stagingId !== parameters.stagingId
    || stage.kind !== (webhook ? 'webhook' : 'package')
    || !matches(DIGEST, stage.contentDigest) || stage.contentDigest !== (webhook ? parameters.configurationDigest : parameters.packageDigest)
    || !integer(stage.expiresAt)) refuse('owner-prepare-stage');
  return { stagingId: stage.stagingId, kind: stage.kind, contentDigest: stage.contentDigest, expiresAt: stage.expiresAt };
}

// `nonce` is the 32 random bytes generated once from the original prepare
// event (canonical unpadded base64url); `preparedAt` and `now` are seconds.
// `expected` is the daemon's own state captured for the action: for
// `soul.computer-use.set` exactly `{kind:'computer-use', enabled:<boolean>}`
// (agent-comms#250), and null for every other operation. The challenge is
// built by the same challengeFor the journal recomputes it with, so the
// computer-use `effectPlanDigest` is identical at every boundary.
export function composeOwnerDecisionPrepared({ actionBytes, acceptanceBytes, namespaceDigest, stage = null, nonce, preparedAt, now, expected = null } = {}) {
  let saved;
  try { saved = validateDaemonAdmission(actionBytes, acceptanceBytes, namespaceDigest); } catch { refuse('owner-prepare-admission'); }
  const acceptance = saved.record;
  const action = JSON.parse(saved.action.toString('utf8'));
  if (!matches(/^[A-Za-z0-9_-]{43}$/, nonce) || Buffer.from(nonce, 'base64url').length !== 32
    || Buffer.from(nonce, 'base64url').toString('base64url') !== nonce) refuse('owner-prepare-nonce');
  const bound = bindStage(action, stage);
  if (!integer(preparedAt) || !integer(now)) refuse('owner-prepare-stale');
  // acceptedAt is the broker's original authenticated value, never refreshed.
  const acceptedAt = acceptance.acceptedAt;
  const acceptedDeadline = plus(acceptedAt, PREPARE_WINDOW_SECONDS), preparedDeadline = plus(preparedAt, PREPARE_WINDOW_SECONDS);
  if (acceptedAt > plus(now, CLOCK_SKEW_SECONDS) || now >= acceptedDeadline
    || preparedAt < Math.max(0, acceptedAt - CLOCK_SKEW_SECONDS) || preparedAt > plus(now, CLOCK_SKEW_SECONDS)) refuse('owner-prepare-stale');
  const exp = Math.min(acceptedDeadline, preparedDeadline, ...(bound ? [bound.expiresAt] : []));
  if (now >= exp) refuse('owner-prepare-stale');

  // Only computer use carries an expected state into the challenge; its
  // display digest comes from re-decoding the retained action, never input.
  let actionDigest = null;
  if (action.operation === COMPUTER_USE_OPERATION) {
    if (!plain(expected) || Object.keys(expected).length !== 2 || expected.kind !== 'computer-use' || typeof expected.enabled !== 'boolean') refuse('owner-prepare-expected');
    try { actionDigest = decodeOwnerDecisionAction(saved.action).actionDigest; } catch { refuse('owner-prepare-admission'); }
  } else if (expected !== null) refuse('owner-prepare-expected');
  const challengeBytes = challengeFor({
    requestId: acceptance.requestId, principal: acceptance.principal, account: acceptance.account, soul: acceptance.soul,
    operation: acceptance.operation, payloadDigest: acceptance.payloadDigest, nonce, acceptedAt, preparedAt, exp,
    daemonKey: acceptance.daemonKey, daemonEpoch: acceptance.daemonEpoch, watchId: acceptance.watchId,
    ...(actionDigest === null ? {} : { actionDigest, expected: { kind: 'computer-use', enabled: expected.enabled } }),
  }, saved.action);
  const challenge = JSON.parse(challengeBytes.toString('utf8'));
  // Check both caps before anything could be published.
  if (challengeBytes.length > CHALLENGE_CAP
    || Buffer.byteLength(canonicalJson({ challenge, stage: bound, v: 1 })) > PREPARED_WRAPPER_CAP) refuse('owner-prepare-bounds');
  return {
    challenge, challengeBytes, stage: bound,
    request: {
      op: 'owner-decision-prepared', requestId: acceptance.requestId, payloadDigest: acceptance.payloadDigest,
      daemonKey: acceptance.daemonKey, daemonEpoch: acceptance.daemonEpoch, watchId: acceptance.watchId,
      nonce, preparedAt, exp, stage: bound,
    },
  };
}
