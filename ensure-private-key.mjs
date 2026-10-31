#!/usr/bin/env node
// Moved to identity/ensure-private-key.mjs (#645, ADR-0645 step 6). This path keeps working
// for callers that import it here; it re-exports the moved file.
export { AGENT_IDENTITIES_VAULT, CredentialPreparationError, PROVIDER_LOCKED, PROVIDER_SESSION_REQUIRED, PROVIDER_UNAVAILABLE, STORE_UNAVAILABLE_CODES, appIdPath, classifyPassCliFailure, collectFields, createProtonPassCredentialProvider, ensurePrivateKey, inspectProtonPassSession, isServerEnrolledApp, main, parseCliArgs, parsePassItemView, privateKeyPath, recoverCredentialTransaction, selectAppIdAttachment, selectIssuer, selectPrivateKeyAttachment, selectPrivateKeyField, validateIssuer, validatePrivateKey } from './identity/ensure-private-key.mjs';
