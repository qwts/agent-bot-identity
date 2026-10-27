// Identity's one entry for host (#645, F9; owner decision D5, F9 answers Q1
// and Q2 (a)). Host loads identity in-process only through this file, which
// the module map lists as a contract importable by host alone, with its
// exact exports. It names every identity function host uses today: the
// binding registry and bind tokens, Agent ID records, principals, keyd, vouch,
// the inbox, identity Apps, the bot checks agent-hook runs and the publish
// scan. It also exports identity's daemon route handler, createIdentityRoutes
// (F9 step 2; host keeps its bearer and proof checks), and identity's half of
// /v0/spawn, spawnChildIdentity (F9 step 4). /v0/register is soul's route.
//
// It also exports the three owner-decision functions host's disabled
// effect-entry gate composes (agent-comms#77): trust readiness, native p1
// verification and the request journal.
//
// Host may also import the shared contracts identity-format.mjs and
// daemon-client.mjs directly.

export { assertPrivateGitDir, childBindingPath, consumeBindToken, createBindingRegistry, lookupBinding, readBinding, readBindToken } from './agent-binding.mjs';
export { assignAgentApp, bindAgentLineage, ensureAgentIdentity, mintAgentIdentity, readAgentIdentity } from './agent-identity.mjs';
export { assertAuthorized, getPrincipal, listPrincipals, principalsFile, resolvePrincipal } from './agent-principals.mjs';
export { parseBindingProof, PROOF_HEADER, signBindingProof } from './binding-proof.mjs';
export { expandAlias, scanGitPublish } from './git-publish-scan.mjs';
export { createIdentityAppJobs, identityAppFailure, identityAppOperation, listIdentityApps } from './identity-apps.mjs';
export { createIdentityRoutes, spawnChildIdentity } from './identity-routes.mjs';
export { createInboxTaker, inboxError } from './inbox-take.mjs';
export { createServerNotices } from './server-notices.mjs';
export { KEYD_LABEL, KEYD_LABEL_VARIABLE, keydMcpServerEntry, keydPaths, keydPolicyRules, keydRequest, keydStatus, keydVersionAction, readKeydRecord } from './keyd-client.mjs';
export { mint } from './mint-token.mjs';
export { verifyOwnerDecisionPresence } from './owner-decision-action.mjs';
export { createDaemonJournalStore, sealRecordOnlyReconciliation } from './owner-decision-journal-store.mjs';
export { readOwnerDecisionTrust, readOwnerDecisionTrustObservation } from './owner-decision-trust.mjs';
export { keydPresence } from './owner-presence.mjs';
export { extractToken } from './owner-statement.mjs';
export { hookBypassReason, readGitConfig, resolveAgentSlug, statedBotSlug, unboundBotReason, unboundBotSlug, unprovableBotReason } from './resolve-agent.mjs';
export { createPassCredentialStore } from './secret-providers/pass-cli-credentials.mjs';
export { createSecretProviderRegistry, getSecret } from './secret-store.mjs';
export { BUILTIN_SECRET_PROVIDERS } from './secret.mjs';
export { validateApprovalScope } from './session-approvals.mjs';
export { loadOrCreateVouchKey, signSoulToken, vouchPublicKeyPem, vouchStateDir } from './vouch.mjs';
