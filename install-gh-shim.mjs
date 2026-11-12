#!/usr/bin/env node
// Moved to identity/install-gh-shim.mjs (#645, ADR-0645 step 6). This path keeps working
// for callers that import it here; it re-exports the moved file.
export { GH_INTERPOSER_BACKUP_SUFFIX, GH_INTERPOSER_LEGACY_BACKUP_SUFFIX, codexDesktopGhStatePath, inspectConfiguredCodexDesktopGh, inspectGhInterposer, inspectShellGhShim, installGhInterposer, installGhShim, isAgentBotGhShim, isManagedGh, main, managedShimPath, resolveGhWord, restoreGhInterposer, shimGhDirs, stableConfigModulePath } from './identity/install-gh-shim.mjs';
