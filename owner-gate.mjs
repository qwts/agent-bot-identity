// Moved to identity/owner-gate.mjs (#645, ADR-0645 step 6). This path keeps working
// for callers that import it here; it re-exports the moved file.
export { assertOwnerAction, confirmOwnerPresence, consentOwner, ownerActionSummary, presenceOrConsent, soulMarkers } from './identity/owner-gate.mjs';
