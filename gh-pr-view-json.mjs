#!/usr/bin/env node
// Moved to identity/gh-pr-view-json.mjs (#645, ADR-0645 step 6). This path keeps working
// for callers that import it here; it re-exports the moved file.
export { cachedBotAvatarUrl, enrichGhPrViewJson, main } from './identity/gh-pr-view-json.mjs';
