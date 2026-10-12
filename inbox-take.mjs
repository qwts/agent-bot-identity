// Moved to identity/inbox-take.mjs (#645, ADR-0645 step 6). This path keeps working
// for callers that import it here; it re-exports the moved file.
export { INBOX_BEARER_ACCESS_REASON, INBOX_BEARER_FIELD, INBOX_BEARER_TITLE, INBOX_TIMEOUT_MS, boundRepository, createInboxTaker, describeFetchCause, inboxError, inboxHost, readInboxBearer, resolveInboxBearer, sanitizeInboxDetail, takeFromBroker } from './identity/inbox-take.mjs';
