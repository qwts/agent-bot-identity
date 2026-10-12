#!/usr/bin/env node
// Moved to identity/agent-identity.mjs (#645, ADR-0645 step 6). This path keeps working
// for callers that import it here; it re-exports the moved file.
export { SOUL_COAUTHOR_DOMAIN, assertSoulCoAuthor, assignAgentApp, bindAgentLineage, bindAgentTranscript, currentAgentId, discoverTranscript, ensureAgentIdentity, finalizeAgentIdentity, harnessForApp, identityFieldsFromEnv, initializeAgentApp, mintAgentIdentity, parseIdentityArgs, printIdentityRecord, readAgentIdentity, recordAgentEvidence, recordAgentPackageRevision, retireAgentIdentity, soulCoAuthorCredits, soulCoAuthorDomains, soulCoAuthorTrailer, validateIdentity } from './identity/agent-identity.mjs';
