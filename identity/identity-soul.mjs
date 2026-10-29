// Identity's published entry for soul and comms (#645; owner decisions on
// soul's helpers, F7 custody and F8 owner prompts, 2026-10-11). Soul and
// comms import identity in-process only through this file and the other
// listed contracts (identity-format.mjs, daemon-client.mjs). Record writes
// still run in identity's entry through identityOp; what is here is what
// must stay in the caller's process: the binding and bot-identity reads the
// hooks run on every tool call, the vouch key paths, the co-author rules and
// session grants; credential custody (F7): the stores, the App metadata, the
// reconciler and in-process minting, so keys never cross a process boundary;
// and the owner gate, statements and presence (F8), so a presence prompt keeps
// the caller's terminal.
// The module map lists it as a contract importable by soul and comms, with
// its exact exports.

export { readBinding } from './agent-binding.mjs';
export { assertSoulCoAuthor, soulCoAuthorCredits, soulCoAuthorDomains, soulCoAuthorTrailer } from './agent-identity.mjs';
export { PROOF_HEADER, signBindingProof } from './binding-proof.mjs';
export { reconcileAppCredentials } from './credential-reconciler.mjs';
export { mintForCaller } from './git-credential-bot.mjs';
export { appStoreTarget, legacyAppFolderStatus, migrateAppMetadata, readAppMetadata, readManagedAppCredential, writeAppMetadata } from './identity-app-store.mjs';
export { importIntoKeyd } from './keyd-client.mjs';
export { assertOwnerAction, confirmOwnerPresence, ownerActionSummary, presenceOrConsent, soulMarkers } from './owner-gate.mjs';
export { attestedOwnerKeys, keydPresenceWithoutDialog } from './owner-presence.mjs';
export { createOwnerChallenges, localHost, promptOwnerChallenge, readOwnerKeys, statementError, verifyOwnerChallenge } from './owner-statement.mjs';
export { pinnedSlug, resolveAgentSlug } from './resolve-agent.mjs';
export { createSessionGrants } from './session-approvals.mjs';
export { credentialStores, defaultCredentialStore, deleteSoulSecret, legacyCredentialDirectory, legacyKeyRemovable, readLegacyCredential, readSoulCredential, readSoulSecret, verifyAppCredential, writeSoulCredential, writeSoulSecret } from './soul-credentials.mjs';
export { vouchKeyPath, vouchStateDir } from './vouch.mjs';

// App-owner scoping for join/setup-worktree refuses (#1182 review).
export { refuseAppOwnerMismatch } from './server-client.mjs';
