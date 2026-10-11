// Moved to identity/owner-text.mjs (#645, ADR-0645 step 6). This path keeps working
// for callers that import it here; it re-exports the moved file.
export { MAX_TEXT_BYTES, UNSAFE_TEXT, boundedOwnerSummary, textProblem } from './identity/owner-text.mjs';
