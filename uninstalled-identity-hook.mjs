#!/usr/bin/env node
// Moved to identity/uninstalled-identity-hook.mjs (#645, ADR-0645 step 6). This path keeps working
// for callers that import it here; it re-exports the moved file.
export { UNINSTALLED_REASON, adapterFallback, decideUninstalledHook, isHumanAttributedPublish, main, parseUnmanagedAuthors, uninstalledDecision } from './identity/uninstalled-identity-hook.mjs';
