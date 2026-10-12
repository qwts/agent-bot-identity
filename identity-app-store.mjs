// Moved to identity/identity-app-store.mjs (#645, ADR-0645 step 6). This path keeps working
// for callers that import it here; it re-exports the moved file.
export { APP_METADATA_FILES, APP_SLUG, MINT_CODES, appStoreTarget, atomicJson, cacheAppDoctorRows, forgetAppDoctorRow, legacyAppFolderStatus, migrateAppMetadata, readAppDoctorCache, readAppMetadata, readManagedAppCredential, updateAppConfig, validAppSlug, withAppOperationLock, writeAppMetadata } from './identity/identity-app-store.mjs';
