// Moved to identity/owner-approval.mjs (#645, ADR-0645 step 6). This path keeps working
// for callers that import it here; it re-exports the moved file.
export { ambientSlug, explicitAppArg, ownerApprovalRequired, requireOwnerApproval } from './identity/owner-approval.mjs';
