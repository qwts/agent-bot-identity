// Moved to identity/gh-shim.mjs (#645, ADR-0645 step 6). This path keeps working
// for callers that import it here; it re-exports the moved file.
export { GH_SHIM_MARKER, buildGhShim } from './identity/gh-shim.mjs';
