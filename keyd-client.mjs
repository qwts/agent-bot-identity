#!/usr/bin/env node
// Moved to identity/keyd-client.mjs (#645, ADR-0645 step 6). This path keeps working
// for callers that import it here; it re-exports the moved file.
export { KEYD_AUDIENCE, KEYD_GRANT_META, KEYD_LABEL, KEYD_LABEL_VARIABLE, KEYD_METHOD_NOT_FOUND, KEYD_PINNED_VERSION, KEYD_SERVER_NAME, KEYD_TOOL_NAMES, KEYD_UNTRUSTED_ITEM_RPC, appKeydAvailability, daemonGrantPublicKey, grantTarget, importAppIntoKeyd, importIntoKeyd, keydMcpServerEntry, keydPaths, keydPolicyRules, keydRequest, keydStatus, keydVersionAction, mintThroughDaemon, mintViaKeyd, readKeydRecord, removeAppFromKeyd, signKeydGrant } from './identity/keyd-client.mjs';
