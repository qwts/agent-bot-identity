# agent-bot-keyd

A native MCP server that holds souls' GitHub App keys
([agent-bot-identity #397](https://github.com/qwts/agent-bot-identity/issues/397)).
GeniusBar bundles it next to `node` and signs it with the app's Developer ID.
Its source lives here in agent-bot-identity (#767), imported from GeniusBar at
`9433009`; this repository builds and tests it unsigned, and GeniusBar's
release job signs it. Each agent-bot release pins this crate's version
(`KEYD_PINNED_VERSION`), and a host bundles exactly that build. The agent-bot side of the protocol is in
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

keyd makes every item itself, through `SecKeychainItemCreateFromContent`, with
an access whose every entry names keyd's own code: its designated requirement,
Team ID and identifier for a signed build. Any other reader, including
`security`, `node` and every script, gets the system's allow/deny prompt
instead of a silent read. keyd turns keychain prompts off in its own process,
so a call it is not entitled to fails rather than waiting on a dialog nobody is
watching; that flag is process-wide and changes nothing for any other process.
Another process cannot widen an item's access list either. A keyd update signed
by the same team keeps access. keyd never returns a key over any channel.

Leaving an item to the framework's default access is not enough, and keyd used
to: that default trusts *any* application to write the value, so any process
in the owner's account could replace a key with no prompt (#753). keyd now
checks an item's access list on every read. An App key it does not control is
re-made from its own value under the lock, so an owner's imported key survives
the upgrade. Anything under service `agent-bot.keyd` — the daemon grant key,
the presence seed, the owner's statement keys — is refused instead, because
those values are what agent-bot trusts.

What an access list still does not stop: the legacy file keychain does not
gate every operation on one, so a process in the owner's account can still
blank or delete an item it cannot read. That makes an overwrite detectable
rather than impossible, and it costs availability, not secrecy — keyd refuses a
value it cannot vouch for, and agent-bot re-derives keyd's presence key from
the code-signed binary rather than trusting a file. The check does not prove
keyd made the item either: any process can build an access naming keyd's code,
so one that deletes an item can plant a replacement keyd cannot tell from its
own. What the lock does close is reading a value and widening an access list.
Two further limits no access list can close: an item can be planted before keyd
first creates one, and where agent-bot is installed somewhere the owner's
account can write, such as a Homebrew prefix it owns, the code doing the
checking can be changed too. The durable answer is the data-protection keychain
under a `keychain-access-groups` entitlement, which only the signed GeniusBar
build can carry.

### Upgrading from an unlocked item

An App key upgrades by itself: keyd re-makes the item from its own value under
the lock, so nothing the owner imported changes. A pin, the presence seed or
the owner's statement keys do not, because those values are what agent-bot
trusts and any process in the account could already have written them, so keyd
refuses them rather than adopt them:

- `daemon-grant-key` — reads as unpinned rather than as an error, so the
  upgrade is not wedged: `owner/status` and `owner/app-status` report
  `pinned: false`, no grant verifies against the old value, and one
  `owner/pin` asks the owner and replaces the item with a locked one. Nothing
  has to be removed first.
- `presence-key` — `agent-bot-keyd presence-key` fails, and owner actions fall
  back to the administrator dialog. Removing the item lets keyd make a fresh
  seed. That is a new presence key, so the next owner action finds the cache in
  `<state>/keyd/presence.pub` disagreeing with the binary and asks the owner
  through the administrator dialog; approving re-pins it, declining refuses the
  action with `presence-pin-mismatch`.
- `owner-pins` — keyd refuses the record, so `owner/pins-status` and
  `owner/pins-attest` answer with an error rather than reporting an approved
  key set. Removing the item returns it to "never approved", and the owner
  records their keys again with `agent-bot owner enroll`.

All three are ordinary login-keychain generic passwords under service
`agent-bot.keyd`, removable with `security delete-generic-password`.

## Sockets

Both sockets live in `<state>/keyd/` (0700). `<state>` is agent-bot's state
directory: `$XDG_STATE_HOME/agent-bot` or `~/.local/state/agent-bot`. Both
sockets are 0600, and keyd checks each peer's user ID.

| socket | speaks | for |
| --- | --- | --- |
| `keyd.sock` | MCP (newline-delimited JSON-RPC) | `credential`, `git_credential` |
| `owner.sock` | JSON-RPC | `owner/status`, `owner/import`, `owner/remove`, `owner/pin`, `owner/presence`, `owner/pins-attest`, `owner/pins-status`, `owner/app-status`, `owner/app-import`, `owner/app-remove` |

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

agent-bot derives the public half by running the code-signed binary,
`agent-bot-keyd presence-key`, not by asking the socket. A process that
stands up a socket of its own therefore cannot answer for the owner. It runs
the binary on every owner action, treating `<state>/keyd/presence.pub` as a
cache of the last pin: that file is one a soul can write, so it may record a
pin but never stand in for one. When the two disagree, or the cache is gone
while a pin is on record, the owner settles it through the administrator
dialog, which names both keys by fingerprint, and only a refusal leaves the
action refused (#753). That is detection, not prevention: a process running
as the owner can remove every record of the pin in `<state>/keyd` and get a
silent first pin, until the data-protection keychain replaces them.

When nobody can be asked here (no GUI session, or no login password), keyd
answers error `-32001`, and agent-bot falls back to its administrator dialog.
A person's cancel, failure or timeout is error `-32000`, and agent-bot does
not ask again.

## The owner's statement keys

The keys the owner signs statements with
([agent-bot-identity #753](https://github.com/qwts/agent-bot-identity/issues/753))
count only as keyd records them. `owner/pins-attest {pins, nonce}` shows the
owner every key (name, kind, whether a PIN or biometric is required, and
fingerprint) and, only on approval, keeps the
key set's digest and a generation one past the last in keyd's Keychain item
(service `agent-bot.keyd`, account `owner-pins`). `owner/pins-status {nonce}`
reports that record with no prompt. Both answer a `k1.` record signed with
the presence key, `kind: "pins"`, so it never passes as a presence assertion.
The format is in
[docs/keyd-protocol.md](../docs/keyd-protocol.md#owner-statement-keys-keyd--agent-bot-753).

## Build and test

```sh
cargo test                                 # in keyd/
node scripts/build-keyd.mjs                # into src-tauri/binaries/
```

Tests never open the login keychain. The store test uses a keychain file of
its own and deletes it afterwards. Consent and GitHub are fakes.
