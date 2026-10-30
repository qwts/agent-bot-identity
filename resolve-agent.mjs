// Moved to identity/resolve-agent.mjs (#645, ADR-0645 step 6). This path keeps working
// for callers that import it here; it re-exports the moved file.
export { CHAINED_HOOKS_KEYS, hookBypassReason, pinnedSlug, readGitConfig, resolveAgentSlug, shadowedGhReason, statedBotSlug, territoryHarness, unboundBotReason, unboundBotSlug, unprovableBotReason, unverifiableGhReason } from './identity/resolve-agent.mjs';
