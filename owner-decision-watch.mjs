// Owner-decision watch identity (agent-comms#77, slice C0): disabled and pure.
// The broker's account-watch `ready` event carries a broker-generated
// `watchId`, the pairing's current `daemonEpoch` and `daemonKey`, SHA-256 of
// the exact daemon vouch SPKI DER presented at pairing. The comms supervisor
// records that identity once per socket; owner-decision relay events are
// accepted only when they carry exactly the identity of the socket they
// arrived on. Nothing here dispatches an owner decision, persists the
// identity, or treats it as authority: it is in-memory socket binding only,
// and a reconnect starts over with no replay.
import { createHash, createPublicKey } from 'node:crypto';

export const OWNER_DECISION_EVENTS = Object.freeze(['owner-decision-prepare', 'owner-decision', 'owner-decision-cancel']);
const UUID4 = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const DIGEST = /^[a-f0-9]{64}$/;
const matches = (pattern, value) => typeof value === 'string' && pattern.exec(value)?.[0] === value;

// The daemonKey we expect: SHA-256 of our own vouch public key's SPKI DER.
// Computed locally, so the broker's value is checked, never trusted.
export function daemonKeyFromPublicKeyPem(publicKeyPem) {
  const der = createPublicKey(publicKeyPem).export({ type: 'spki', format: 'der' });
  return createHash('sha256').update(der).digest('hex');
}

// The identity a `ready` event binds, or null when it binds none: fields
// missing (a broker that does not send them yet), malformed, or a daemonKey
// that is not ours. A null identity means no owner-decision intake at all on
// that socket.
export function watchIdentityFromReady(event, { daemonKey } = {}) {
  if (!matches(DIGEST, daemonKey) || event === null || typeof event !== 'object') return null;
  const { watchId, daemonEpoch } = event;
  if (!matches(UUID4, watchId) || !Number.isSafeInteger(daemonEpoch) || daemonEpoch < 1
    || !matches(DIGEST, event.daemonKey) || event.daemonKey !== daemonKey) return null;
  return Object.freeze({ watchId, daemonEpoch, daemonKey });
}

// Whether one relay event may be taken in on the socket whose identity is
// `identity`: an owner-decision event whose three bindings equal it exactly.
export function ownerDecisionIntakeBound(event, identity) {
  return identity !== null && typeof identity === 'object' && event !== null && typeof event === 'object'
    && OWNER_DECISION_EVENTS.includes(event.event)
    && event.watchId === identity.watchId && event.daemonEpoch === identity.daemonEpoch && event.daemonKey === identity.daemonKey;
}
