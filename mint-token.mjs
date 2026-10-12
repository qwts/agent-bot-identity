#!/usr/bin/env node
// Moved to identity/mint-token.mjs (#645, ADR-0645 step 6). This path keeps working
// for callers that import it here; it re-exports the moved file.
export { MINT_USAGE, appConfig, buildAppJwt, mint, parseMintArgs, parsePermissions, pickInstallation, selectionReason, ungrantedPermissions } from './identity/mint-token.mjs';
