# agent-bot-keyd

A native MCP server that holds souls' GitHub App keys
([agent-bot-identity #397](https://github.com/qwts/agent-bot-identity/issues/397)).
GeniusBar bundles it next to `node` and signs it with the app's Developer ID.
Its source lives here in agent-bot-identity (#767), imported from GeniusBar at
`9433009`; this repository builds and tests it unsigned, and GeniusBar's
release job signs it. The agent-bot side of the protocol is in
[docs/keyd-protocol.md](../docs/keyd-protocol.md).
agent-bot installs it as a launchd agent (`app.geniusbar.keyd`) during setup.

keyd holds keys and signs App JWTs. agent-bot's daemon decides who may mint.

## Keys

Each key is a login-keychain generic password that keyd creates through the
Security framework:

- service `agent-bot.keyd.<agentId>`
- account `github-app/<slug>`
- value: base64 of `{appId, privateKeyPem}`

An App-level key (agent-bot-identity #110), shared by every soul that acts
as that App, is its own item: service `agent-bot.keyd.app`, account
`github-app/<slug>`, the same value. A grant mints with it only when it says
`keyScope: "app"`; otherwise keyd uses the soul's item, and it never falls
back from one to the other.

An item created this way trusts only its creator's designated requirement:
keyd's Team ID and identifier. Any other reader, including `security`, `node`
and every script, gets the system's allow/deny prompt instead of a silent
read. A keyd update signed by the same team keeps access. keyd never returns
a key over any channel.

## Sockets

Both sockets live in `<state>/keyd/` (0700). `<state>` is agent-bot's state
directory: `$XDG_STATE_HOME/agent-bot` or `~/.local/state/agent-bot`. Both
sockets are 0600, and keyd checks each peer's user ID.

| socket | speaks | for |
| --- | --- | --- |
| `keyd.sock` | MCP (newline-delimited JSON-RPC) | `credential`, `git_credential` |
| `owner.sock` | JSON-RPC | `owner/status`, `owner/import`, `owner/remove`, `owner/pin`, `owner/presence`, `owner/app-status`, `owner/app-import`, `owner/app-remove` |

Each call leaves a receipt in `keyd/audit.jsonl` (0600). Receipts never hold a
secret.

## Who may mint: daemon-signed grants

A tool call carries `params._meta["agent-bot/grant"]`, a grant the daemon
signs with its account Ed25519 key (the vouch key):

```
v1.<base64url(payload)>.<base64url(Ed25519 signature of the payload segment)>
payload: { v: 1, aud: "agent-bot-keyd", agentId, app, tool, iat, exp, nonce,
           apiBase, installationId?, owner?, host?, keyScope? }
```

Before minting, keyd checks the grant:

- the signature verifies against the pinned daemon key;
- the audience is `agent-bot-keyd`;
- the tool matches the call;
- it is fresh: `exp` is at most 120 seconds after `iat`, with 30 seconds of skew allowed;
- `apiBase` is https;
- the nonce has not been used.

keyd then mints for the grant's soul and App, and only for them.

The daemon checks policy before it signs a grant:

- the soul's binding proof;
- the `github-identity` gate;
- that the soul's App is the declared one and that keyd holds it.

The daemon also records an audit receipt.

Grants were chosen over keyd calling the daemon back. keyd needs no daemon
credential and no network path, and the check is one signature with no round
trip.

The daemon key is pinned in keyd's own Keychain item (service
`agent-bot.keyd`, account `daemon-grant-key`) on the owner's first import.
To change it, the owner must approve `owner/pin`.

What this does not stop: a process in the owner's account that can read the
daemon's vouch key file can sign grants and get tokens. It can never get keys.
agent-bot's confinement denies souls that file.

## Souls: the relay

A harness runs `agent-bot-keyd mcp` over stdio. For each `tools/call`, the relay:

1. reads the soul's binding (`AGENT_BOT_BINDING`, or the worktree's
   `agent-binding.json`, a private file);
2. sends `POST /v0/keyd/grant {tool}` to the daemon with the soul's binding
   proof;
3. forwards the call, with the grant, to `keyd.sock`.

The relay never opens the Keychain.

`git_credential` takes `{protocol, host}`. It answers
`username=x-access-token\npassword=<token>\n` only for https and the grant's
host. Otherwise it returns nothing.

## Owner operations

`owner/import`, `owner/remove`, `owner/pin`, `owner/app-import` and
`owner/app-remove` need the owner's consent. keyd
asks for it itself through LocalAuthentication (Touch ID or the login
password).

`owner/import` accepts one key, or up to 64 keys under `items`, for one
prompt. A key keyd cannot sign with is refused before the owner is asked.
The first import must carry `daemonKey`, which keyd pins.
`owner/app-import` does the same for App-level keys, by `app` with no
`agentId`; `owner/app-status` says whether one is held. See
[docs/keyd-protocol.md](../docs/keyd-protocol.md#app-level-keys-110).

agent-bot's `identity migrate-credentials --to keyd` drives this.

## The owner's presence for agent-bot

agent-bot's owner-only commands (`soul comms`, `soul cold-wake`,
`identity migrate-credentials`, and the rest of its owner gate) ask keyd
instead of the macOS administrator dialog
([agent-bot-identity #416](https://github.com/qwts/agent-bot-identity/issues/416)).
The owner approves with Touch ID where the Mac has it, otherwise with the
login password. No administrator account is needed.

agent-bot sends `owner/presence {action, nonce}`. `action` is one line naming
the soul (name and Agent ID) and the change. `nonce` is agent-bot's own
random value. keyd shows "agent-bot wants to <action>". Only if the owner
approves does it sign:

```
p1.<base64url(payload)>.<base64url(Ed25519 signature of the payload segment)>
payload: { v: 1, aud: "agent-bot-owner", kind: "presence",
           action: hex(sha256(action)), nonce, iat, exp }
```

`exp` is 60 seconds after `iat`, which is when the owner answered. The signing seed is keyd's own Keychain item
(service `agent-bot.keyd`, account `presence-key`), made on first use, so
only keyd's code reads it.

agent-bot pins the public half by running the code-signed binary,
`agent-bot-keyd presence-key`, not by asking the socket. A process that
stands up a socket of its own therefore cannot answer for the owner.

When nobody can be asked here (no GUI session, or no login password), keyd
answers error `-32001`, and agent-bot falls back to its administrator dialog.
A person's cancel, failure or timeout is error `-32000`, and agent-bot does
not ask again.

## Build and test

```sh
cargo test                                 # in keyd/
node scripts/build-keyd.mjs                # into src-tauri/binaries/
```

Tests never open the login keychain. The store test uses a keychain file of
its own and deletes it afterwards. Consent and GitHub are fakes.
