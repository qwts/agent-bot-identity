// Moved to identity/secret-providers/proton-pass.mjs (#645, ADR-0645 step 6). This path keeps working
// for callers that import it here; it re-exports the moved file.
export { PROTON_ITEM_SHARES_COLLECTION, createProtonPassAdapter, protonPassAdapter } from '../identity/secret-providers/proton-pass.mjs';
