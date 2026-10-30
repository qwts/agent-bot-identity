// Identity's published entry for cli's readiness, doctor, bootstrap and
// hook-sync code (#645, F13 step 3; the owner's revised Q-F13-3 answer).
// cli imports identity only through this file and the other listed
// contracts, in-process, so readiness keeps its injectable probes. The module map lists it as a contract importable by cli only, with
// its exact exports: the readiness and doctor probes, the bootstrap actions
// and the hook fallback; the owner gate, statements and presence for the
// owner commands (F8, in-process so presence prompts keep the terminal); and
// what `agent-bot identity`, `principal` and `identity app` run in-process.

export { sinceTime } from './agent-audit.mjs';
export { readBindToken, readBinding } from './agent-binding.mjs';
export { discoverTranscript } from './agent-identity.mjs';
export { principalCommand } from './agent-principals.mjs';
export { inspectAppCredentials, reconcileAppCredentials } from './credential-reconciler.mjs';
export { isSoulBound } from './git-credential-bot.mjs';
export { cacheAppDoctorRows, legacyAppFolderStatus, readAppMetadata } from './identity-app-store.mjs';
export { identityAppFailure, identityAppsCommand } from './identity-apps.mjs';
export { probeInboxReachability } from './inbox-probe.mjs';
export { inspectConfiguredCodexDesktopGh, inspectShellGhShim, installGhShim } from './install-gh-shim.mjs';
export { keydStatus, keydVersionAction } from './keyd-client.mjs';
export { soulMarkers } from './owner-gate.mjs';
export { attestedOwnerKeys, keydAttestPins, keydStatementStore } from './owner-presence.mjs';
export { extractToken, ownerCommand } from './owner-statement.mjs';
export { pinnedSlug, readGitConfig, resolveAgentSlug, territoryHarness } from './resolve-agent.mjs';
export { createSecretProviderRegistry, probeSecretStore } from './secret-store.mjs';
export { BUILTIN_SECRET_PROVIDERS } from './secret.mjs';
export { appKeyStores } from './soul-credentials.mjs';
export { adapterFallback } from './uninstalled-identity-hook.mjs';

// Server-mode App-owner roster for the doctor's worktree.app_owner check.
export { ServerSession, appOwnerMismatch, repoFromCheckout, serverUrl } from './server-client.mjs';
