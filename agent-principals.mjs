// Moved to identity/agent-principals.mjs (#645, ADR-0645 step 6). This path keeps working
// for callers that import it here; it re-exports the moved file.
export { PRINCIPAL_OPERATIONS, applyAuthorizationChanges, assertAuthorized, assertMachineAuthorized, authorizeSouls, bindTransport, enrollPrincipal, getPrincipal, listPrincipals, principalCommand, principalsFile, resolvePrincipal, revokePrincipal, setDefaultSoul, setOperations, validateProviderId } from './identity/agent-principals.mjs';
