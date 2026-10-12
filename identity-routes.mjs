// Moved to identity/identity-routes.mjs (#645, ADR-0645 step 6). This path keeps working
// for callers that import it here; it re-exports the moved file.
export { createIdentityRoutes, spawnChildIdentity } from './identity/identity-routes.mjs';
