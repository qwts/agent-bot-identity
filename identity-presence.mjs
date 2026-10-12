// Public pure verification contract. The caller supplies its already trusted
// key, exact action and nonce; this module performs no enrollment or authority.
export { actionDigest, verifyPresence } from './identity/presence-verifier.mjs';
