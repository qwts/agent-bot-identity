// Moved to identity/session-approvals.mjs (#645, ADR-0645 step 6). This path keeps working
// for callers that import it here; it re-exports the moved file.
export { createSessionGrants, validateApprovalScope } from './identity/session-approvals.mjs';
