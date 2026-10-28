// The shipped copy of governance/redaction-patterns.json: secret shapes that
// must never reach receipts, the action ledger, logs or diagnostics. The
// governance JSON is the shared policy document (true-line/agent-bot reads
// it in Go); this module is what the installed runtime bundles, and a test
// asserts the two never drift.
const REDACTION_PATTERNS = Object.freeze([
  Object.freeze({ id: 'github-installation-token', regex: '\\bghs_[A-Za-z0-9]{20,}' }),
  Object.freeze({ id: 'github-oauth-token', regex: '\\bgho_[A-Za-z0-9]{20,}' }),
  Object.freeze({ id: 'github-user-token', regex: '\\bghu_[A-Za-z0-9]{20,}' }),
  Object.freeze({ id: 'github-personal-token', regex: '\\bghp_[A-Za-z0-9]{20,}' }),
  Object.freeze({ id: 'github-fine-grained-token', regex: '\\bgithub_pat_[A-Za-z0-9_]{20,}' }),
  Object.freeze({ id: 'provider-api-key', regex: '\\bsk-[A-Za-z0-9_-]{16,}' }),
  Object.freeze({ id: 'inference-proxy-token', regex: '\\babp_[0-9a-f]{48}' }),
  Object.freeze({ id: 'jwt', regex: '\\beyJ[A-Za-z0-9_-]{8,}\\.[A-Za-z0-9_-]{8,}\\.[A-Za-z0-9_-]{8,}' }),
  Object.freeze({ id: 'bearer-credential', regex: '\\b[Bb]earer [A-Za-z0-9._~+/-]{16,}=*' }),
]);
export { REDACTION_PATTERNS };
