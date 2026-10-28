# Server mode (agent-bot server)

Server mode connects this machine to an [agent-bot server](https://github.com/true-line/agent-bot): a fleet control plane that keeps every harness's GitHub App key centrally and hands enrolled devices short-lived, repo-scoped installation tokens. No App `.pem` is needed on the machine.

It is **off by default**. When neither setting below is present, agent-bot does not use a server. Minting with an App key held on this machine (legacy local custody) is also off by default (#1184; see [Legacy local custody](#legacy-local-custody)). A machine with neither therefore mints nothing.

## Turning it on

```sh
export AGENT_BOT_SERVER=https://agents.true-line.ai
```

or in `~/.config/agent-bot/config.json`:

```json
{ "settings": { "agentBotServer": "https://agents.true-line.ai" } }
```

`https://agent-bot-gold.vercel.app` is the same service under its old name.

The environment wins over config. The URL must be `https` (plain `http` is accepted only for `localhost`).

## Commands

```sh
agent-bot server enroll --harness grok [--harness claude] [--name "Chris MBP"] [--platform macos] [--tag laptop] [--force] [--json]
agent-bot server status [--json]
agent-bot server logout
agent-bot server reconcile [--json]
```

- **enroll**, interactive: uses the device grant (RFC 8628). It prints a link, a user code and the device key thumbprint. Approve it on the server's `/device` page, after checking the thumbprint matches.
- **enroll**, headless: when `AGENT_BOT_ENROLL_TOKEN` is set (cloud VMs, CI), it calls `/oauth/device_enroll` with the token instead. No browser is involved. The server sets the harnesses and lifetime.
- `--harness` defaults to `AGENT_BOT_SERVER_HARNESS`, or to `grok` when `GROK_AGENT=1`.
- **status** shows the local enrollment, then makes a signed `whoami` round trip. It exits 1 when the round trip fails.
- **logout** deletes the local device key, the device record and the pinned key. Also revoke the device on the server's `/devices` page.
- **reconcile** settles credential requests whose outcome went missing, by lookup only (see [Unknown outcomes](#unknown-outcomes)). It exits 1 while any is still unknown.
- **Approve only the identities the machine needs.** The device can mint only for the harnesses the owner approves at enrollment, and the server enforces that.

## What is stored

Everything lives in `$XDG_STATE_HOME/agent-bot/server/`, or `~/.local/state/agent-bot/server/`, or `AGENT_BOT_SERVER_STATE` if that is set. The directory is mode 0700 and each file is mode 0600.

| File | Contents |
|---|---|
| `device-key.pem` | P-256 device private key (PKCS#8). Used only to sign enrollment proofs and token assertions. |
| `device.json` | `device_id`, server, harnesses, `management` (`managed`), method, ephemeral and expiry |
| `server-key.json` | The server's Ed25519 response-signing key, pinned on first use |
| `actions/<operation_id>.json` | The action ledger: one record per credential request (state, task, operation, issuance ID). It never holds a credential. |

`device.json` gains `revoked_at` once the server reports the device revoked.

A machine that runs this client has a durable disk, so it is **managed**. Chat-only clients without a disk are **unmanaged**. They use the server's browser OAuth on `/mcp` and never run this code.

## Tokens and long-lived auth

Each access token works like this:

1. The client generates a fresh in-memory P-256 key. That key is never written to disk.
2. It sends `/oauth/token` a `jwt-bearer` assertion (RFC 7523), signed by the device key, with `cnf.jwk` set to the fresh key.
3. The 15-minute access token that comes back is DPoP-bound (RFC 9449) to the fresh key. Every `/api/daemon/*` call carries a DPoP proof (`htm`, `htu`, `iat`, `jti`, `ath`).

The session re-mints the token 60 seconds before it expires. After a `401` (sleep, clock skew) it re-mints once. Every use slides the device's idle window on the server (90 days by default), so a daemon stays authenticated indefinitely without any long-lived bearer secret.

The 15-minute access token is this machine's session with the server, and it is reused across calls. Each call carries a fresh DPoP proof. Credentials minted *through* it are never reused (see [Minting](#minting)).

### When the server is unreachable or the device is revoked

| Code | When | What happens |
|---|---|---|
| `credential-unavailable` | The server is unreachable, times out (20 s), answers an unsigned 5xx, or answers a signed 503 `credential_unavailable` | Nothing is issued. The caller fails, and other local daemon work goes on. Retry later. |
| `device-revoked` | A signed 401 `device_revoked` from any `/api/daemon/*` route, or `invalid_grant`/`device_revoked` from `/oauth/token` | The cached session token is dropped at once, and in-memory credentials (the pilot provider key) are dropped too. `revoked_at` is written to `device.json`. Every later call, in any process, refuses without contacting the server until `agent-bot server enroll --force`. |
| `outcome-unknown` | A credential request may have been fulfilled but its answer was lost | See [Unknown outcomes](#unknown-outcomes). |

Any other `invalid_grant` means the device expired or is unknown. Re-enroll with `agent-bot server enroll --force`.

## Server authenticity

Every `/api/daemon/*` response is checked against the pinned key before it is used:

- `Agent-Bot-Signature` must equal `Ed25519("agent-bot-sig-v1\n<status>\n<hex sha256(body)>\n<request DPoP jti>")`.
- `Agent-Bot-Request-Jti` must echo the jti of the request's DPoP proof.

A mismatch is an error, and that includes error responses. That catches a different key, a tampered body or a replayed response. The key is pinned on first enrollment (TOFU). Compare its `kid` from `agent-bot server status` with the server's `/.well-known/agent-bot-server-key` out of band if you can.

## Minting

With server mode on, every GitHub credential is minted for **one task and one operation** (credential/v1). `agent-bot mint-token`, the credential helper, the gh shim and the daemon's `/v0/credential` all call `POST /api/daemon/credentials` with `{task_id, operation_id, kind, harness, repo, profile}`:

- **operation_id** is fresh for every request (`op_<uuid>`). An operation is never sent twice except to reconcile it.
- **task_id** is chosen in this order:
  - `AGENT_BOT_TASK_ID`, when a daemon turn set one;
  - otherwise the soul's conversation: its Agent ID plus a digest of its transcript locator;
  - otherwise `adhoc.<operation_id>`.
- **harness** is the App slug itself when the enrolled device's scope names it (the server keys Apps by slug, e.g. `trueline-devin-agent`). Otherwise it comes from `AGENT_BOT_SERVER_HARNESS`, `GROK_AGENT=1` (`grok`), `--app`/`GH_AGENT_APP` mapped through config, or harness detection.
- **repo** is `owner/name`, taken from `AGENT_BOT_SERVER_REPO` or from the checkout's `origin` remote.

The server records an issuance (`issuance_id`, task, operation, profile, the DPoP key thumbprint, expiry) and answers with a token scoped to that one repository. The daemon refuses an answer that does not echo the task and operation. `--permissions` is not available in server mode.

**No token is reused, and members get references.**

- **Nothing is cached.** The gh shim's old per-checkout token cache is deleted, not read.
- **git and gh** receive a fresh token for their one operation, through the credential helper and the shim.
- **Everything a member sees gets the reference only:** `credential_ref` (the issuance ID), task, operation and expiry. That covers the MCP `credential` tool and `agent-bot mint-token` in a soul-bound checkout.
- **Receipts carry `issuanceId`, `taskId` and `operationId`**, never the token.

### Unknown outcomes

Each credential request is written to the action ledger as `prepared`, then `submitted`, **before** it is sent, and ends as `succeeded`, `rejected` or `unknown`.

An answer that went missing after the request may have reached the server makes the record `unknown`: a reset or timeout after connecting, a dropped body, an unsigned 502 or 504, or the server's `outcome_unknown`. The daemon then looks the operation up with `GET /api/daemon/issuances/{operation_id}` instead of retrying:

- **`issued`:** the same operation is replayed. The server returns the same issuance, which is checked, and nothing new is minted. If its credential has already expired, the record becomes `rejected`.
- **`none`:** the record becomes `rejected`.
- **Still unknown, or the lookup fails:** `outcome-unknown`, and nothing is re-sent. `agent-bot server reconcile` settles it later.

Connection refusals and DNS failures cannot have reached the server, and they stay plain `credential-unavailable`.

**No retry under a new name.** While an operation is `unknown`, the daemon does not mint for the same task, harness and repository under a new `operation_id`. Before it sends a new operation, it settles the old one by lookup. If the old one settles as `issued` or `none`, the new one goes ahead. If it is still unknown, the new one is refused with `outcome-unknown`. `agent-bot server reconcile` settles it, or the lookup does once the server's hold ends (one hour).

## Enforcement profile

The daemon's `/v0/health` and every audit receipt name the enforcement profile in force (Soul Agent Platform 0.4 R8):

- **`managed cooperative`**: the default;
- **`standalone unenforced`**: when legacy local custody is on.

Nothing claims `managed protected`. A stronger claim is refused with `profile-insufficient`. That covers an `Agent-Bot-Profile` request header, `AGENT_BOT_REQUIRE_PROFILE` or `settings.requireProfile`.

## Legacy local custody

Minting with an App key held on this machine (key stores, keyd App keys, `GH_APP_PRIVATE_KEY*`, App administration's JWTs) is **off by default**, and refused with `legacy-local-custody-off`. A machine that must keep local keys for now opts in with `AGENT_BOT_LEGACY_LOCAL_CUSTODY=1` or `settings.legacyLocalCustody: true`, which makes its profile `standalone unenforced`. The opt-in stops working on **2027-01-31** (or at stage 3 exit, if that comes first).

## Pilot provider key

This is the one named exception to short-lived credentials (owner decision D2). It is turned on with `settings.pilotProvider` (e.g. `"anthropic"`), when legacy custody is off.

- **Fetch:** the daemon fetches the key from the server when it starts (`GET /api/daemon/provider-key`, a fresh operation, task `daemon-start`).
- **Holding:** the key is kept in memory only, never on disk, in a log or in a receipt. It is dropped at once on `device-revoked`.
- **Use:** it is injected into the harness process environment, only for a soul whose declared provider matches. Each fetch and each use leaves a receipt naming `provider-key-exception` and the issuance ID.
- **Lifetime:**
  - The key is never used past its lease (`expires_at`).
  - It is fetched again inside a 10-minute margin before the lease ends, and after a failure with backoff (30 s to 15 min).
  - A new `key_id` replaces it, and `provider_key_not_configured` drops it.
- **Owner's side:** the owner sets the key on the server's `/devices` page, and sets the spend cap and rotation with the provider.
- **The provider names must match.** The provider saved with the key, `settings.pilotProvider`, and the provider the soul declares for its harness must all be the same provider ID: `anthropic` for Claude Code, `openai` for Codex or OpenCode, and so on (see `soul-providers.mjs`). A harness name such as `opencode` is not a provider ID. When the names don't match, the launch fails with `provider-secret-missing`, rather than the key being injected under the wrong variable.
- **Exit: the loopback inference proxy (#1190).**
  - **Setup:** set `settings.inferenceProxy` to `{ "port": 8787, "upstreams": { "openai": "https://opencode.ai/zen/go/v1" } }`, and declare the soul's provider `baseUrl` as `http://127.0.0.1:8787/v0/inference/openai`.
  - **What changes:** the harness then gets a short-lived proxy token in place of the key. The daemon swaps the key in on the way upstream, so the key never reaches a member process.
  - **Receipts** say `brokered-inference`.
  - **Fails closed:** when the proxy is not running on that port (a bad port, a failed start), the soul's launch is refused with `inference-proxy-unavailable`. The key is never put in its environment instead. The port must be fixed; `0` is refused.
  - **Other souls:** a soul whose `baseUrl` is not on the proxy keeps the exception below. It must land before any `managed protected` claim, or at stage 3 exit, whichever comes first.
- **The limits, as decided (Q1, 2026-10-27):**
  - the declared provider only;
  - daemon memory only;
  - each fetch and use receipted as `provider-key-exception`;
  - the proxy tracked as the exit criterion.

## Soul tokens (v2)

**Opt-in while it rolls out:** `settings.soulTokens: "v2"` in
`~/.config/agent-bot/config.json`, or `AGENT_BOT_SOUL_TOKENS=v2` (the
environment wins; anything else is v1). It requires an identity service that
serves `POST /api/daemon/soul-token` and an agent-comms broker that accepts
v2 tokens — without both, vouching fails closed. **Opted in but not enrolled
fails closed:** `/v0/vouch` answers `credential-unavailable` instead of
falling back to the v1 host key, `pair-comms` refuses, and `/v0/health`
reports `soulTokens: 'v2-unavailable'`. Switching a paired daemon to
v2 means re-running `agent-bot daemon pair-comms` so the broker learns the
issuer instead of a host key. The default flips in a later release.

When opted in, enrolled and legacy local custody off, soul tokens for
agent-comms are **signed by the identity service**, not by a host key (#1196):

- `/v0/vouch` calls `POST /api/daemon/soul-token` (a fresh operation per
  request, task `soul-vouch`) and returns the service's answer:
  `{ token, agentId, parent, exp, v: 2 }`. The token is a compact ES256 JWS
  (`typ: soul+jwt`, five minutes) whose claims the broker verifies; the daemon
  checks the signed response echoes the request and this device before using
  it. No `vouch-key.pem` is read or created on this path.
- `agent-bot daemon pair-comms` sends `soulTokens: { v: 2, issuer, device }`
  in place of the host's SPKI public key, so the broker verifies v2 tokens
  against the service, not a file on this host. The `issuer` comes from the
  service's public JWKS (`GET <server>/.well-known/agent-bot/soul-keys.json`),
  which can differ from this deployment's URL — a fixed
  `https://agents.true-line.ai` versus a preview host. It is pinned into the
  server state directory before the pairing request lands, and `/v0/vouch`
  refuses a token minted under another issuer — or any v2 request while the
  pin is missing (`credential-unavailable`; re-run `pair-comms`). An
  existing `vouch-key.pem` can be deleted once the broker is re-paired.
- `GET /v0/health` reports `soulTokens: 'v2' | 'v1'` and, in v2 mode,
  `vouchKeyOnHost` (a stat, never a read).
- The broker must run an agent-comms release that accepts v2 tokens and the
  `soulTokens` pairing descriptor. The legacy local custody opt-in keeps the
  v1 path (the host vouch key) unchanged until its removal date.

## Setting up a machine with no local keys

1. Configure `~/.config/agent-bot/config.json`. Leave it with **no** `legacyLocalCustody` and no App keys on the machine:

   ```json
   { "settings": { "agentBotServer": "https://agents.true-line.ai", "pilotProvider": "anthropic" } }
   ```

2. Run `agent-bot server enroll --harness <app-slug> [--harness <app-slug>]`. In the browser, approve only those identities.
3. Run `agent-bot server status`, which should show `auth: ok`. Then check `/v0/health`, whose `profile` should read `managed cooperative`.
4. Run `agent-bot mint-token` in a checkout of a repository the App is installed on. The receipt in `audit.jsonl` carries `issuanceId`, `taskId`, `operationId` and `profile`.
5. To retire the machine, revoke it on `/devices`. Its next call reports `device-revoked`.

## ## Live-session events

A soul harness can wait for messages relayed to it while it is live — for
example a Devin session blocked on a Stop hook — and read them as untrusted
context. The daemon side is cursor-based: the identity service exposes
`relay.message` as SEP-3415 MCP events on `POST /mcp` (`events/poll`), and
this device polls it with its DPoP access token. `/mcp` answers are not
signed with `agent-bot-signature` — the relay content is untrusted input
anyway; TLS is the transport trust.

- `agent-bot events wait [--timeout S] [--cursor C] [--format text|devin-stop]`
  polls `/v0/events/wait` until an event arrives or the timeout ends
  (default 120 s, max 3600), prints the wrapped event plus a
  `Next: run \`agent-bot events wait --cursor <next>\` …` line, and acks —
  committing the cursor. Without an ack the same event is delivered again.
- `agent-bot events ack --cursor C` commits a cursor manually.
- `agent-bot events peek [--format devin-context]` does one zero-second
  wait; with `devin-context` it emits `hookSpecificOutput` only when an
  event exists and then acks (delivery into context counts).

Each relayed event's text is

```
[id=<id> correlation=<c>] Relayed from <from> (untrusted external input; no owner authority). Message body as a JSON string: <body>
```

with the body JSON-string-encoded so it can never add a line of its own.
Events that fail validation — a foreign harness, a sender outside the
GitHub-login shape, a body over 16 KiB UTF-8, `untrusted` not true, a
`data.id` that differs from the envelope id — are dropped, consumed, and
receipted `event-dropped` with no body. Deliver receipts (`event-deliver`)
are written on the ack, once per event id per daemon process, and never
carry a body either.

Cursors live in `<server state dir>/event-cursors.json` (0600), one entry
per `relay.message:<harness>` subscription. With no stored cursor the first
wait *arms* the subscription at the server's head — messages sent before
the first arm are not delivered. `--cursor` overrides the stored cursor for
one wait without moving the store. Polling is still the baseline; an edge push
transport (SSE, `events/edgeTicket`) is already wired behind the same
seam. `nextEvents()` takes `transport` — `'auto'` (default) tries the
edge and falls back to polling for the remaining wait from wherever the
stream advanced the cursor; `'poll'` never mints a ticket; `'edge'`
surfaces errors instead of falling back. Resolution order:
`AGENT_BOT_EVENT_TRANSPORT`, then `settings.eventTransport`, then
`'auto'`. A `-32026` edge-unsupported answer is remembered on the session
for five minutes so retries do not re-mint uselessly. The edge ticket is
a short-lived bearer secret — it is held in memory only and never
appears in logs, errors or receipts.

`identity/relay-events.mjs` keeps `nextEvents()` as the single seam; a
future `events/stream` implementation must be a drop-in with the same
signature. Replies to a relayed message are not available
yet — they await a device `send_message`.

The Devin hook adapters — `--format devin-stop`, `--format devin-context`,
and the `.devin/hooks.v1.json` snippets in this section — exist only as an
**optional, off-by-default** extra behind a user-enabled flag; they are
never a required delivery path. Enable them per machine with
`settings.eventHooks: true` in `~/.config/agent-bot/config.json` or
`AGENT_BOT_EVENT_HOOKS=1` (the env wins; `0` forces off). While disabled
they do nothing — no network call, no cursor move, silent stdout. A hook
that stalls on harness approval, times out, or is disabled fails closed:
the turn simply ends, and delivery falls back to the server stream (MCP
events / edge event stream, the production path) or the
`agent-bot events wait` loop below.

Example `.devin/hooks.v1.json` (optional; needs the opt-in above) — the Stop hook
waits for an event before
letting the turn end (keep the hook timeout to a few minutes; a long wait
shows the session as working and blocks `/compact`, so let `/goal` re-run
it), the PostToolUse hook surfaces whatever arrived:

```json
{
  "version": 1,
  "hooks": [
    { "event": "Stop", "command": "agent-bot events wait --timeout 300 --format devin-stop", "timeout": 330 },
    { "event": "PostToolUse", "command": "agent-bot events peek --format devin-context", "timeout": 10 }
  ]
}
```

Two ordering notes: the store *arms* on the first wait — anything relayed
before the first wait is not delivered. And because delivery is
at-least-once, a late ack can rewind the stored cursor (an older cursor
committed after a newer one); consumers must dedupe on the event id.

The daemon needs server mode (an enrolled device), the soul needs a
harness App slug, and the service scopes `events/poll` to the harnesses the
device is enrolled for — a foreign harness answers `event-forbidden`.

### Harnesses without MCP events support

For a harness that cannot consume MCP events itself (Devin today), the
supported path is the agent running the CLI in its own shell:

```
agent-bot events wait [--ide] [--cursor C]
```

`wait` blocks until one message arrives (default `--timeout 120` seconds,
max 3600), prints the wrapped event plus a
`Next: run \`agent-bot events wait --cursor <next>\` …` line, acks, and
exits 0. The agent re-runs it with that cursor for the next message. The
hook adapters above are the optional, off-by-default extra on top of this.

### IDE sessions (`--ide`)

An owner IDE or web-chat session with **no soul binding** — for example a
Devin IDE workspace in the owner's macOS account — can take the same relay
events straight from the service with this account's enrolled device:
`agent-bot events wait|peek|ack --ide`. It never talks to the daemon and
never needs a binding; a caller carrying any soul marker (an Agent ID, a
binding, a stated App) is refused `events-soul-caller` — souls keep the
daemon path. The harness is `--harness <slug>` or the ambient harness's
configured App slug; cursors live under a separate `ide:relay.message:<harness>`
key so IDE use never moves the soul store. Its hook file is likewise the
optional, off-by-default extra above — it only runs with
`settings.eventHooks` or `AGENT_BOT_EVENT_HOOKS=1`:

```json
{"Stop":[{"matcher":"","hooks":[{"type":"command","command":"agent-bot events wait --ide --harness qwts-devin-agent --format devin-stop --timeout 30","timeout":40}]}],"UserPromptSubmit":[{"matcher":"","hooks":[{"type":"command","command":"agent-bot events peek --ide --harness qwts-devin-agent --format devin-context","timeout":15}]}]}
```

Messages arriving after the 30-second wait window are still picked up: the
`peek` on the next prompt injects whatever has accumulated into context. Substitute your harness's
App slug for `qwts-devin-agent` (ambient detection alone does not name one
inside an IDE, so the flag is required there). Because marker checks skip
harness detection, an unstated soul running in the owner account is treated
as the IDE — acceptable for reads: the device's harness scope bounds what
`events/poll` may return.


## Known limits

- The device key is a software key (`key_storage=software`). Hardware-backed keys (Secure Enclave, TPM, Android Keystore) are future work, so the profile stays `managed cooperative`. See the server's `docs/daemon-client.md`.
- **GitHub installation tokens are bearer tokens.** They live up to an hour and cannot be DPoP-bound at GitHub. They are minted per operation and repository-scoped. The server keeps each one sealed for its lifetime only, so it can replay the same operation and revoke the token at GitHub when the device is revoked.
- **The pilot provider key reaches the harness process** until the inference proxy lands (#1190).
