// Moved to identity/daemon-client.mjs (#645, ADR-0645 step 6). This path keeps working
// for callers that import it here; it re-exports the moved file.
export { HEALTH_TIMEOUT_MS, LOOPBACK_HOSTS, SCHEMA_VERSION, daemonBaseUrl, daemonClient, daemonStateFile, identityOp, probeDaemonHealth, readDaemonState, spawnIdentity } from './identity/daemon-client.mjs';
