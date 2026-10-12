// Moved to identity/secret-store.mjs (#645, ADR-0645 step 6). This path keeps working
// for callers that import it here; it re-exports the moved file.
export { SecretStoreError, createSecretProviderRegistry, getSecret, probeSecretStore, selectSecretField } from './identity/secret-store.mjs';
