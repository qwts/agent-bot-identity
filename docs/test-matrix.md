# Test coverage matrix

Coverage of the fail-closed identity surface, tracked under #1184 as part of
the HQ/plugins split in [ADR-1183](decisions/ADR-1183-agent-bot-splits-into-hq-and-plugins.md).
Unit-test cells name the file and a representative test title; "fake server"
means the in-process signed HTTP fixture in `tests/server-client.test.mjs`.
Priority: **P0** blocks the security goal or is itself a security property,
**P1** is needed before launch, **P2** as time allows.

| Feature | Unit tests | E2E | Gaps | Priority |
|---------|-----------|-----|------|----------|
| Server-mode device enrollment (`identity/server-client.mjs`) | `tests/server-client.test.mjs` — "device-grant enrollment stores a 0600 P-256 key, pins the server key and records management"; "enrollment token enrolls a cloud VM without a browser"; "a failed first signed check keeps the enrollment and marks it unverified" | Fake server only | No post-deploy enrollment smoke; server-key rotation / pin migration untested | P0 |
| Per-task + per-operation credential minting (`POST /api/daemon/credentials`) | `tests/server-client.test.mjs` — "every mint is its own operation; a token is never reused, and a mismatched echo is refused"; `tests/agent-daemon.test.mjs` — "each /v0/credential is one operation of the soul's task; identity-service failures keep stable codes and local work goes on" | Fake server only | Server-mode mint not exercised through the installed gh shim / credential helper path | P0 |
| Issuance lookup (`GET /api/daemon/issuances/{operation_id}`) | `tests/server-client.test.mjs` — "T06: a mint whose answer was lost is looked up and replayed, never minted twice" | Fake server only | Only exercised inside mint flows; no direct test of a malformed or unsigned lookup answer | P0 |
| `operation_conflict` replay | `tests/server-client.test.mjs` — "every mint is its own operation…" (mismatched echo refused); "T06: an issued operation whose credential expired settles as rejected, never an endless unknown" | Fake server only | Single flow only; two souls or processes racing one operation untested | P0 |
| `outcome_unknown` reconciliation + action ledger (`identity/action-ledger.mjs`) | `tests/server-client.test.mjs` — "T06: an unknown upstream outcome stays unknown, is not retried, and settles by lookup later"; "T06: a new operation for the same task, harness and repo waits on an unknown one, and goes ahead once it settles"; ledger state asserted via `readAction` (never holds a credential) | Fake server only | No dedicated `action-ledger.mjs` unit test: corrupt entry, concurrent writers, atomicity | P0 |
| `credential_unavailable` on outage | `tests/server-client.test.mjs` — "credential-unavailable while the identity service is down, unsigned 5xx or a signed 503; nothing is issued" | Fake server only | Recovery after the outage ends (timing, first-success path) not asserted | P0 |
| `device_revoked` | `tests/server-client.test.mjs` — "device-revoked drops cached tokens at once, persists, and requires re-enrollment" (incl. a second session refusing with no network); `tests/provider-key.test.mjs` — "device revocation drops the key at once"; `tests/inference-proxy.test.mjs` — revoked proxy tokens return 401 | Fake server only | Revocation racing an in-flight mint untested | P0 |
| Enforcement profile + protected-claim refusal | `tests/enforcement-profile.test.mjs` — "a claim stronger than the profile in force is refused with profile-insufficient (T21)"; "the daemon reports its profile on /v0/health and refuses a stronger Agent-Bot-Profile claim"; "a daemon whose settings require the protected profile refuses to start" | None | Profile enforcement not exercised through a real managed daemon start | P0 |
| Legacy-local-custody gating (`identity/mint-token.mjs`, `docs/identity-apps.md`) | `tests/enforcement-profile.test.mjs` — "legacy local custody is opt-in by environment or config, reads standalone unenforced, and expires on the removal date"; "with legacy custody off nothing mints from an App key on this host, even one in the environment"; `tests/mint-token.test.mjs` — local mint path | None | Windows custody paths are compile-tested only (skipped on POSIX CI) | P0 |
| Pilot provider key fetch/lease/refetch/drop (`identity/provider-key.mjs`) | `tests/provider-key.test.mjs` — "the key is fetched with a fresh operation, held in memory only, and receipted without the secret"; "the key is never used past its lease, is refetched near its end and after a failure with backoff, and drops when unconfigured"; "a failed fetch is receipted and leaves nothing held" | Fake server only | `key_id` rotation mid-lease untested; not-configured provider covered only at the unit seam | P0 |
| Launch provider stage check | `tests/provider-key.test.mjs` — "the launch provider stage passes on the held key for the declared provider only, never a local store, and writes no receipt" | None | No launch E2E proving a soul's environment carries only the intended key material | P0 |
| Loopback inference proxy (`identity/inference-proxy.mjs`) | `tests/inference-proxy.test.mjs` — fail-closed brokering ("with the proxy down… a soul whose baseUrl is on the proxy is refused and its env never gets the key"), SSRF path refusals ("//host, dot segments and encoded separators"), 413 body cap, token TTL/lease, `set-cookie` drop, proxy token never sent upstream, loopback baseUrl detection | None | No per-request receipt of proxied calls (only the launch-time `brokered-inference` receipt); upstream redirect refusal (`redirect: 'error'`) not asserted | P0 |
| Receipts/audit never contain secrets | `tests/diagnostic-redact.test.mjs` — "known token shapes are redacted"; `tests/agent-principals.test.mjs` — "audit receipts are append-only, whitelisted, and secret-free"; `tests/agent-daemon.test.mjs` — "a mint failure after a verified binding still leaves a secret-free receipt" | None | No sweep asserting every receipt writer is secret-free; coverage is per-writer and ad hoc | P0 |
| MCP tools compatibility | `tests/agent-mcp.test.mjs` — "credential requires a live binding and presents only the connection secret"; "bind reads the worktree token itself and never returns the secret"; `tests/daemon-mcp.test.mjs` | `tests/acp-live.test.mjs` exists but is env-gated and never runs in CI | Live-harness MCP pass is opt-in only | P1 |
| Daemon route auth (`docs/daemon-api.md` table) | `tests/daemon-route-auth.test.mjs` — "the route authorization table in docs/daemon-api.md matches the daemon exactly"; bearer-only, soul-binding and broker callers refused on owner routes | None | Doc table is kept in sync by test; malformed/odd auth headers not fuzzed | P0 |
| Git credential helper / gh shim | `tests/credential-helper.test.mjs`; `tests/gh-shim.test.mjs` — "an explicit human token is rejected under a bot identity"; `tests/install-gh-shim.test.mjs`; `tests/gh-shim-stable-path.test.mjs`; `tests/cred-mint-via-daemon.test.mjs` — "installed gh shim requests daemon credentials and fails closed" | None | No E2E of `git push` through a real shimmed `gh` against GitHub | P0 |
| Vouch soul tokens (`identity/vouch.mjs`) | `tests/vouch.test.mjs` — "signSoulToken builds a v1 token node:crypto verifies"; "verifySoulToken rejects a bad signature, a long lifetime, and expiry"; key custody (0600, create race, symlink, Windows SID) | None | Being replaced by server-signed v2 under #1196 — invest in the v2 path, keep v1 tests until cutover | P2 |
| Error-code registry | `tests/error-codes.test.mjs` — "the registry has a known schema and well-formed, uniquely numbered entries"; "every launch code the daemon emits is registered"; "the registry only grows relative to the base branch" | None | Registered-but-never-emitted codes are allowed; no dead-entry check | P1 |

## E2E scenarios needed (shared with true-line/agent-bot)

The fixture server covers request shapes and refusals; none of these run
against a deployed identity service:

- enroll → mint → read-back (issuance lookup returns the same issuance)
- revoke → signed, request-bound `device_revoked` → daemon refuses without network
- GitHub 5xx/timeout → `credential_unavailable`/`outcome_unknown`; the same
  operation replays its issuance and a new operation for the task gets 409
- vault toggle → revoke still works
- provider key not configured / `key_id` rotation
- `legacy_route_disabled` end to end
- post-deploy smoke on `agents.true-line.ai`
- loopback proxy down → launch refused (fail closed, env never gets the key)
