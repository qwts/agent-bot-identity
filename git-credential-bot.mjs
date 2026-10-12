#!/usr/bin/env node
// Moved to identity/git-credential-bot.mjs (#645, ADR-0645 step 6). This path keeps working
// for callers that import it here; it re-exports the moved file.
export { isSoulBound, mintCredential, mintForCaller, parseCredentialRequest } from './identity/git-credential-bot.mjs';
