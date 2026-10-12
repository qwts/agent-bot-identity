// Moved to identity/identity-entry.mjs (#645, ADR-0645 step 6). This path keeps working
// for callers that import it here; it re-exports the moved file.
export { IDENTITY_OPS, runIdentityOp } from './identity/identity-entry.mjs';
