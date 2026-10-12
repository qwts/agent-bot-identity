#!/usr/bin/env node
// Moved to identity/soul-credentials.mjs (#645, ADR-0645 step 6). This path keeps working
// for callers that import it here; it re-exports the moved file.
export { appKeyStores, credentialStores, credentialsDirectory, defaultCredentialStore, deleteSoulSecret, fileStore, keychainItem, keychainStore, keydStore, legacyCredentialDirectory, legacyKeyRemovable, passCliItem, passCliSecretItem, passCliStore, readLegacyCredential, readSoulCredential, readSoulSecret, resolveAppCredential, secretItem, verifyAppCredential, writeSoulCredential, writeSoulSecret } from './identity/soul-credentials.mjs';
