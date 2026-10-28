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
- **Exit:** a loopback inference proxy ends the exception (#1190). It must land before any `managed protected` claim, or at stage 3 exit, whichever comes first.
- **The limits, as decided (Q1, 2026-10-27):**
  - the declared provider only;
  - daemon memory only;
  - each fetch and use receipted as `provider-key-exception`;
  - the proxy tracked as the exit criterion.

## Setting up a machine with no local keys

1. Configure `~/.config/agent-bot/config.json`. Leave it with **no** `legacyLocalCustody` and no App keys on the machine:

   ```json
   { "settings": { "agentBotServer": "https://agents.true-line.ai", "pilotProvider": "anthropic" } }
   ```

2. Run `agent-bot server enroll --harness <app-slug> [--harness <app-slug>]`. In the browser, approve only those identities.
3. Run `agent-bot server status`, which should show `auth: ok`. Then check `/v0/health`, whose `profile` should read `managed cooperative`.
4. Run `agent-bot mint-token` in a checkout of a repository the App is installed on. The receipt in `audit.jsonl` carries `issuanceId`, `taskId`, `operationId` and `profile`.
5. To retire the machine, revoke it on `/devices`. Its next call reports `device-revoked`.

## Known limits

- The device key is a software key (`key_storage=software`). Hardware-backed keys (Secure Enclave, TPM, Android Keystore) are future work, so the profile stays `managed cooperative`. See the server's `docs/daemon-client.md`.
- **GitHub installation tokens are bearer tokens.** They live up to an hour and cannot be DPoP-bound at GitHub. They are minted per operation and repository-scoped. The server keeps each one sealed for its lifetime only, so it can replay the same operation and revoke the token at GitHub when the device is revoked.
- **The pilot provider key reaches the harness process** until the inference proxy lands (#1190).
