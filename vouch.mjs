// Moved to identity/vouch.mjs (#645, ADR-0645 step 6). This path keeps working
// for callers that import it here; it re-exports the moved file.
export { SOUL_TOKEN_AUDIENCE, SOUL_TOKEN_TTL_SECONDS, loadOrCreateVouchKey, signSoulToken, verifySoulToken, vouchDaemonKey, vouchKeyPath, vouchPublicKeyPem, vouchStateDir } from './identity/vouch.mjs';
