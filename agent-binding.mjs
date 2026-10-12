#!/usr/bin/env node
// Moved to identity/agent-binding.mjs (#645, ADR-0645 step 6). This path keeps working
// for callers that import it here; it re-exports the moved file.
export { assertPrivateGitDir, bindTokenPath, childBindingPath, consumeBindToken, createBindingRegistry, lookupBinding, mintBindToken, readBindToken, readBinding, revokeBinding } from './identity/agent-binding.mjs';
