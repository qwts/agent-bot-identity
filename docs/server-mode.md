# Server mode (agent-bot server)

Server mode connects this machine to an [agent-bot server](https://github.com/true-line/agent-bot): a fleet control plane that keeps every harness's GitHub App key centrally and hands enrolled devices short-lived, repo-scoped installation tokens. No App `.pem` is needed on the machine.

It is **off by default**. With neither setting below present, agent-bot behaves exactly as before.

## Turning it on

```sh
export AGENT_BOT_SERVER=https://agent-bot-gold.vercel.app
```

or in `~/.config/agent-bot/config.json`:

```json
{ "settings": { "agentBotServer": "https://agent-bot-gold.vercel.app" } }
```

The environment wins over config. The URL must be `https` (plain `http` is accepted only for `localhost`).

## Commands

```sh
agent-bot server enroll --harness grok [--harness claude] [--name "Chris MBP"] [--platform macos] [--tag laptop] [--force] [--json]
agent-bot server status [--json]
agent-bot server logout
```

- **enroll**, interactive: uses the device grant (RFC 8628). It prints a link, a user code and the device key thumbprint. Approve it on the server's `/device` page, after checking the thumbprint matches.
- **enroll**, headless: when `AGENT_BOT_ENROLL_TOKEN` is set (cloud VMs, CI), it calls `/oauth/device_enroll` with the token instead. No browser is involved. The server sets the harnesses and lifetime.
- `--harness` defaults to `AGENT_BOT_SERVER_HARNESS`, or to `grok` when `GROK_AGENT=1`.
- **status** shows the local enrollment, then makes a signed `whoami` round trip. It exits 1 when the round trip fails.
- **logout** deletes the local device key, the device record and the pinned key. Also revoke the device on the server's `/devices` page.

## What is stored

Everything lives in `$XDG_STATE_HOME/agent-bot/server/`, or `~/.local/state/agent-bot/server/`, or `AGENT_BOT_SERVER_STATE` if that is set. The directory is mode 0700 and each file is mode 0600.

| File | Contents |
|---|---|
| `device-key.pem` | P-256 device private key (PKCS#8). Used only to sign enrollment proofs and token assertions. |
| `device.json` | `device_id`, server, harnesses, `management` (`managed`), method, ephemeral and expiry |
| `server-key.json` | The server's Ed25519 response-signing key, pinned on first use |

A machine that runs this client has a durable disk, so it is **managed**. Chat-only clients without a disk are **unmanaged**. They use the server's browser OAuth on `/mcp` and never run this code.

## Tokens and long-lived auth

Each access token works like this:

1. The client generates a fresh in-memory P-256 key. That key is never written to disk.
2. It sends `/oauth/token` a `jwt-bearer` assertion (RFC 7523), signed by the device key, with `cnf.jwk` set to the fresh key.
3. The 15-minute access token that comes back is DPoP-bound (RFC 9449) to the fresh key. Every `/api/daemon/*` call carries a DPoP proof (`htm`, `htu`, `iat`, `jti`, `ath`).

The session re-mints the token 60 seconds before it expires. After a `401` (sleep, clock skew) it re-mints once. Every use slides the device's idle window on the server (90 days by default), so a daemon stays authenticated indefinitely without any long-lived bearer secret.

When the server returns `invalid_grant`, the device was revoked or has expired. Re-enroll with `agent-bot server enroll --force`.

## Server authenticity

Every `/api/daemon/*` response is checked against the pinned key before it is used:

- `Agent-Bot-Signature` must equal `Ed25519("agent-bot-sig-v1\n<status>\n<hex sha256(body)>\n<request DPoP jti>")`.
- `Agent-Bot-Request-Jti` must echo the jti of the request's DPoP proof.

A mismatch is an error. That catches a different key, a tampered body or a replayed response. The key is pinned on first enrollment (TOFU). Compare its `kid` from `agent-bot server status` with the server's `/.well-known/agent-bot-server-key` out of band if you can.

## Minting

With server mode on, `agent-bot mint-token` and the credential helper call `POST /api/daemon/installation-token` with `{harness, repo}`:

- **harness** comes from `AGENT_BOT_SERVER_HARNESS`, `GROK_AGENT=1` (`grok`), `--app`/`GH_AGENT_APP` mapped through config, or harness detection, in that order.
- **repo** is `owner/name`, taken from `AGENT_BOT_SERVER_REPO` or from the checkout's `origin` remote.

The token is scoped to that one repository. `--permissions` is not available in server mode. The output shape is unchanged: `installation_id` is `null`, and the response adds `repo`, `git_author` and `source: "agent-bot-server"`.

## Known limits

- The device key is a software key (`key_storage=software`). Hardware-backed keys (Secure Enclave, TPM, Android Keystore) are future work. See the server's `docs/daemon-client.md`.
- There is no server endpoint for a device to revoke itself yet. `logout` is local only.
