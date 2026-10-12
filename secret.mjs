#!/usr/bin/env node
// Moved to identity/secret.mjs (#645, ADR-0645 step 6). This path keeps working
// for callers that import it here; it re-exports the moved file.
export { BUILTIN_SECRET_PROVIDERS, main, parseSecretArgs, secretHelpText } from './identity/secret.mjs';
