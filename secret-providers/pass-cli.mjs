// Moved to identity/secret-providers/pass-cli.mjs (#645, ADR-0645 step 6). This path keeps working
// for callers that import it here; it re-exports the moved file.
export { PROVIDER_LOCKED, PROVIDER_SESSION_REQUIRED, PROVIDER_UNAVAILABLE, STORE_UNAVAILABLE_CODES, classifyPassCliFailure, passCliFailure, runPass } from '../identity/secret-providers/pass-cli.mjs';
