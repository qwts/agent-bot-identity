// Moved to identity/binding-proof.mjs (#645, ADR-0645 step 6). This path keeps working
// for callers that import it here; it re-exports the moved file.
export { PROOF_HEADER, PROOF_WINDOW_MS, bindingKey, bindingKeyId, checkBindingProof, parseBindingProof, signBindingProof } from './identity/binding-proof.mjs';
