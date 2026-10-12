// Moved to identity/inbox-probe.mjs (#645, ADR-0645 step 6). This path keeps working
// for callers that import it here; it re-exports the moved file.
export { INBOX_PROBE_TIMEOUT_MS, classifyProbeError, probeInboxReachability } from './identity/inbox-probe.mjs';
