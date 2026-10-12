#!/usr/bin/env node
// Moved to identity/gh-inbox-query.mjs (#645, ADR-0645 step 6). This path keeps working
// for callers that import it here; it re-exports the moved file.
export { broadenPullRequestInboxSearchArgument, installedRepositoryScope, main } from './identity/gh-inbox-query.mjs';
