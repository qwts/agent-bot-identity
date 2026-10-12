// Identity's published entry for soul and comms (#645; owner decisions on
// soul's helpers, F7 custody and F8 owner prompts, 2026-10-11). Soul and
// comms import identity in-process only through this file and the other
// listed contracts (identity-format.mjs, daemon-client.mjs). Record writes
// still run in identity's entry through identityOp; what is here is what
// must stay in the caller's process: the binding and bot-identity reads the
// hooks run on every tool call, the vouch key paths, the co-author rules and
// session grants.
// The module map lists it as a contract importable by soul and comms, with
// its exact exports.

export { readBinding } from './agent-binding.mjs';
export { assertSoulCoAuthor, soulCoAuthorCredits, soulCoAuthorDomains, soulCoAuthorTrailer } from './agent-identity.mjs';
export { PROOF_HEADER, signBindingProof } from './binding-proof.mjs';
export { pinnedSlug, resolveAgentSlug } from './resolve-agent.mjs';
export { createSessionGrants } from './session-approvals.mjs';
export { vouchKeyPath, vouchStateDir } from './vouch.mjs';
