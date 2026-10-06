# Sandbox: a persona account for souls

The `persona-accounts` add-on (ADR-0274) runs a soul in its own standard
macOS account, with no admin rights, instead of the owner's. `agent-bot
sandbox` is the mechanism behind GeniusBar's Sandboxing switch (GeniusBar#66,
#376): it reports the account, gives the owner the steps that still need
doing, and keeps the switch, the account name and each soul's override.

agent-bot never creates the account. Creating a macOS user needs admin
rights, so every step is one the owner runs, with their own password, and
nothing here runs `sudo`. Everything the commands print is secret-free:
account names, booleans and the commands to run.

```sh
agent-bot sandbox status [--json]
agent-bot sandbox plan [--json]
agent-bot sandbox on|off [--json] [--principal-stdin]
agent-bot sandbox account NAME [--json] [--principal-stdin]
agent-bot sandbox override <agentId|name> [show|inherit|sandboxed|unrestricted] [--json] [--principal-stdin]
agent-bot sandbox resolve <agentId|name> [--json]
```

## Status

`status` reads the config and probes the machine, without network or secret
access:

- `enabled`: `features.persona-accounts` in the config (the global switch).
- `provider`: `standard_macos_account`, the only provider today.
- `account`: `sandbox.account` in the config, default `geniusbar-agent`.
- `status`: `unsupported` (not macOS), `missing` (no such account),
  `creating` (the account exists but onboarding is incomplete) or `ready`.
- `checks`: `exists` (`id -u`), `standard` (not in the `admin` group, by
  `dsmemberutil`), `home` (`dscl` and the directory), `devTools`
  (`xcode-select -p`), `paired` (an approved pairing for the account in
  `agent-comms account pairings`), `fleet` (a soul joined from the account in
  `agent-comms census`) and `harnessSignIn`, always `unknown`: another
  account's home cannot be read from here, so a harness sign-in is confirmed
  only by a turn running there (#84 records failures).
- `steps`: the plan below with `done` per step (`null` when agent-bot cannot
  tell).
- `souls`: every census row with its `override`, whether it is `sandboxed`,
  the account it `runsAs` and the `source` (`global` or `override`).

## Plan

`plan` lists the owner's steps in order. Each has an `id`, who runs it
(`owner-admin` with `sudo`, `owner`, or `account`, logged in as the sandbox
account), the exact commands and a note:

1. `create-account`: `sysadminctl -addUser` or System Settings → Users &
   Groups, as a Standard account.
2. `standard-account`: drop admin rights if it was created as an administrator.
3. `dev-tools`: Apple's command-line tools, shared by every account.
4. `broker-group`: add the account to the group the agent-comms broker was
   installed with (ADR-0006).
5. `pair`: `agent-comms account pair` in the account, approved by the owner
   with `agent-comms broker approve CODE` or in GeniusBar.
6. `harness-sign-in`: run each harness once as the account and sign in.
7. `join`: launch a soul with the sandbox on; its join completes onboarding.

## Switch, account and overrides

`sandbox on|off` writes `features.persona-accounts`; `sandbox account NAME`
writes `sandbox.account` (a short macOS account name). Both are owner
actions: they take the owner's principal on stdin (`--principal-stdin`) or
the owner's presence, and a caller carrying a soul's markers is refused.

`sandbox override <soul> sandboxed|unrestricted|inherit` records a per-soul
override in the census; `inherit` removes it. `resolve <soul>` says what the
soul gets: the override when one is set, else the global switch, and the
account it runs as. The daemon's launch path is expected to consult this
resolution when it starts a soul; recording and reporting it is this
command's job.

Which souls get an account, and what it is called, is the SOP pack's persona
mapping (ADR-0274 decision 3). The setting here is the user's choice only when
no SOP decides it.

## Daemon routes

With the daemon's per-start bearer:

- `GET /v0/sandbox` returns what `status --json` returns, plus `schemaVersion`.
- `POST /v0/sandbox` with `enabled` and/or `account`, and `principal`, sets
  the switch and the account through the same owner gate as other settings,
  appends a `sandbox` audit receipt, and returns the new status.
- `POST /v0/sandbox/override` with `agentId`, `override` and `principal`
  records a soul's override and returns its resolution; an unknown soul is 404.
