# Soul credentials

A soul that acts as a GitHub App keeps that App's key in its own key store
(#383). Agents never touch the store: the daemon and the mint path read it and
hand the soul short-lived installation tokens.

## Declaration

`soul.json` names the App and the store, never the key:

```json
{
  "credentials": {
    "github": { "app": "you-claude-agent", "store": "keychain" }
  }
}
```

`store` is `keychain` (the macOS default) or `file` (the default elsewhere).
Any other key, under `credentials` or `credentials.github`, fails validation,
so a key cannot be packaged by mistake. `soul spawn` copies the declaration
into every instance. The key is not copied.

## Stores

- **keychain**: a generic password in the login keychain, service
  `agent-bot.soul.<agentId>`, account `github-app/<slug>`. It is written and
  read with `/usr/bin/security`. The secret is passed on `security -i`'s
  stdin, never on a command line. The value is base64 of
  `{appId, privateKeyPem}`.
- **file**: `<soul>/.soul-state/credentials/github-app-<slug>.json`. The
  directory is 0700 and the file 0600, both owned by this user. A read refuses
  a link, a loosened mode or another owner. `.soul-state/` is never packaged,
  exported or hashed into a revision.

pass-cli is not a soul store yet. `ensure-private-key` still restores the
legacy folder from pass-cli.

### What the Keychain access list can and cannot enforce

A Keychain item's trusted-application list names executables, not scripts:

- The item is created by `security`, so `security` is trusted by default.
- The daemon is a Node script that reads through `security`.
- The only executables the list could name are `security` and `node`.
  Trusting `node` would trust every Node script in the account.

**What it does not do.** The Keychain does not lock the item to the daemon.
Any process in the owner's account that runs `security find-generic-password`
can read it.

**What it does give:**

- the item is encrypted at rest;
- it cannot be read while the login keychain is locked;
- it is not a plain file in any directory an agent works in.

**What keeps souls out.** Confinement denies souls the `security` and
`pass-cli` executables and every credential path ([confinement](confinement.md)).
That is a cooperative hook, not an OS boundary.

Locking the item to the daemon needs a signed helper binary that the access
list can name; that is a follow-up.

## Resolution at mint

For an App slug, the mint path (`mint-token`, the git credential helper, the
daemon's `/v0/credential`) checks two places in order:

1. **The soul's store.** The soul is the one that declares the App: the soul
   the daemon is minting for, else the caller's own soul, else any soul in the
   census. If its store holds the key, that key is used. If a store holds the
   key but cannot read it, the mint fails; it does not fall back.
2. **The legacy `~/.config/<slug>/{app-id,private-key.pem}`.** The first use
   prints a one-time deprecation notice on stderr.

`GH_APP_ID` with `GH_APP_PRIVATE_KEY` or `GH_APP_PRIVATE_KEY_PATH` keeps
working as before. Nothing in this path prints, logs, audits or returns key
material. No agent-facing command or MCP tool returns a key.

## Migrating

```sh
agent-bot identity migrate-credentials --all --dry-run
agent-bot identity migrate-credentials --soul AGENT_ID|NAME [--json] [--principal-stdin]
```

Owner only, through the owner gate: a caller with any soul marker is refused,
dry run included. For each soul with a GitHub App (declared, or the census
`appSlug`), the command:

1. copies the legacy key into the soul's store;
2. reads it back;
3. verifies it live with an App JWT against `GET /app`. This proves GitHub
   accepts the key without minting an installation token;
4. if the soul had no declaration, writes one into `soul.json` as a new
   revision.

Each migration leaves a `credential-migrate` audit receipt with no key
material. The report lists the legacy `private-key.pem` files that every soul
using that App no longer needs.

The command never deletes anything. The legacy folder also holds `bot-uid`,
`bot-avatar-url` and `app-id`, which other commands still read, so it names
only the key file.
