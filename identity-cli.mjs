// Identity's published entry for cli's readiness, doctor, bootstrap and
// hook-sync code (#645, F13 step 3; the owner's revised Q-F13-3 answer).
// readiness.mjs, doctor.mjs, bootstrap.mjs and sync-hooks.mjs import identity
// only through this file, in-process, so readiness keeps its injectable
// probes. The module map lists it as a contract importable by cli only, with
// its exact exports: the readiness and doctor probes, the bootstrap actions
// and the hook fallback.

export { readBindToken, readBinding } from './agent-binding.mjs';
export { inspectAppCredentials, reconcileAppCredentials } from './credential-reconciler.mjs';
export { isSoulBound } from './git-credential-bot.mjs';
export { cacheAppDoctorRows, legacyAppFolderStatus } from './identity-app-store.mjs';
export { probeInboxReachability } from './inbox-probe.mjs';
export { inspectConfiguredCodexDesktopGh, inspectShellGhShim, installGhShim } from './install-gh-shim.mjs';
export { keydStatus, keydVersionAction } from './keyd-client.mjs';
export { pinnedSlug, readGitConfig, resolveAgentSlug, territoryHarness } from './resolve-agent.mjs';
export { createSecretProviderRegistry, probeSecretStore } from './secret-store.mjs';
export { BUILTIN_SECRET_PROVIDERS } from './secret.mjs';
export { appKeyStores } from './soul-credentials.mjs';
export { adapterFallback } from './uninstalled-identity-hook.mjs';
