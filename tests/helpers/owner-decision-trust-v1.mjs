// Test adapter for the versioned owner-decision trust writers (owner decision
// Q2). Older tests drive key setup through enrollKeys/revokeKeys; this wraps a
// writer so those calls go to enrollKeysV1/revokeKeysV1 with the store's
// current observation digest, as a ceremony would pass it, and answer as the
// retired methods did (readiness after an enrollment, {state, version} after a
// revocation). When there is no observation to take (no store, a pending or
// damaged one), it passes a digest that can match nothing, so the writer
// refuses for its own reason.
import { observeOwnerDecisionTrust, readOwnerDecisionTrust } from '../../identity/owner-decision-trust.mjs';

const NONE = '0'.repeat(64);

export function withCurrentObservation(writer, { root, env, home, legacyPresenceKey }) {
  const expected = () => { try { return observeOwnerDecisionTrust({ root, env, home }).observationDigest; } catch { return NONE; } };
  return {
    ...writer,
    enrollKeys: ({ daemonKey, ...input } = {}) => {
      writer.enrollKeysV1({ ...input, expectedObservationDigest: expected() });
      return readOwnerDecisionTrust({ root, env, home, legacyPresenceKey });
    },
    revokeKeys: (input = {}) => {
      const { observation } = writer.revokeKeysV1({ ...input, expectedObservationDigest: expected() });
      return { state: 'revoked', version: observation.chainVersion };
    },
  };
}
