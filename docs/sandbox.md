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
agent-bot sandbox remove [ACCOUNT] --dry-run [--json]
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
- `sop`: the SOP pack's persona mapping as recorded (see [The SOP pack's
  persona mapping](#the-sop-packs-persona-mapping)): its `state`, whether it
  `decides` anything, the `repository`, `commit` and `recordedAt` of the
  record, a `message` for every state but `ok`, the parsed `rules` and
  `default`.
- `souls`: every census row with its `override`, whether it is `sandboxed`,
  the account it `runsAs` and the `source`: `sop` when the pack decided,
  else `override`, else `global`. Each row carries `sop` (`decides`, `state`,
  and for a decided soul the `rule` that matched, the pack's `sandbox` and
  `account`), a `reason` when the pack decides sandboxed but the add-on gate
  is off, and `refused` (`code`, `reason`, `action`, `source`) when a launch
  of that soul would be refused (#613).

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
override in the census; `inherit` removes it. A soul the SOP pack decides
takes no override: `sandboxed` or `unrestricted` is refused (code `usage`)
naming the pack, its commit and the rule, because the pack's `persona.toml`
is where that decision changes; `inherit` is always accepted, so an override
left from before the pack decided can be cleared. `resolve <soul>` says what
the soul gets: the pack's decision when it has one, else the override when
one is set, else the global switch, and the account it runs as. The daemon's
launch path consults the same resolution when it starts a soul (see [At
launch](#at-launch)).

## Removing a persona account

`sandbox off` stops using the account; it does not delete it. Removing one
follows the owner's decision on #750 (2026-10-10): keep by default and remove
only what is named.

- Souls, workspaces and transcripts are exported to the owner's account, and
  the export is verified before anything that depends on it is removed.
- Broker pairings are removed only after the export is verified. Each
  retained soul keeps its census row, marked retired, so it stays
  identifiable and recoverable.
- Harness sign-ins are listed only; agent-bot never removes one.
- Deleting the macOS account is a guided step the owner does by hand.
  agent-bot never runs privileged deletion.
- Each category has its own owner-gated confirm. A partial failure stops,
  leaves everything in place, and can be resumed.

`sandbox remove [ACCOUNT] --dry-run` is the first step, and the only one built
so far. It lists what the account has and what would happen to each
category, and changes nothing: it runs only the reads `status` runs, asks no
owner gate, and refuses without `--dry-run`. ACCOUNT defaults to
`sandbox.account`, and the account agent-bot itself runs as is refused
(`sandbox-remove-self`). Each category carries an `id`, an `action`, whether
it could be read (`known`), its `items` and a note:

| Category | Action | Items |
| --- | --- | --- |
| `souls` | `export` | souls the local census sends to the account, and souls the broker's census has joined from it |
| `workspaces` | `export` | the souls' folder in the account's home |
| `transcripts` | `export` | the harness session stores in the account's home |
| `pairings` | `remove-after-export` | the account's broker pairings: account, uid and state only |
| `census` | `mark-retired` | the broker's census rows for the account |
| `harness-sign-ins` | `list-only` | the harness homes in the account's home |
| `macos-account` | `manual` | the account and its home, when it exists |

Another account's home is usually unreadable from the owner's, so each path
is reported as `present`, `absent` or `unreadable`, never guessed at. The
paths are the default locations: the account may set `AGENT_BOT_SOULS_HOME`,
`CLAUDE_CONFIG_DIR` or `CODEX_HOME` elsewhere, which cannot be read from here,
so `workspaces`, `transcripts` and `harness-sign-ins` are always `known:
false`. `souls` is `known` only when both the local census and the broker's
were read. Off
macOS there is nothing to list. The export and the gated removal steps come
in later slices.

## At launch

After its `checking` stage, before a package launch mints a soul, the
daemon's launch handler resolves what the soul gets: the SOP pack's decision
(an existing soul by its census name or its soul.json role, a soul the
launch makes by the launch's `name` and `role`), else an existing soul's
override, else the global switch. The config, census and recorded mapping
are read at each launch, so a switch flipped in GeniusBar applies to the
next one, and nothing is fetched. A configured policy that cannot be
evaluated refuses the launch instead of falling back to the user setting
(ADR-0274, #613; see the state table below). Only no SOP, or an SOP with
no `persona.toml`, leaves the user setting in charge.

- refused: `persona-policy-unavailable` (an SOP is selected but its mapping
  is not recorded, or the config, record or `persona.toml` cannot be read or
  is invalid), `persona-policy-stale` (the
  record is not for the selection the config makes now) or
  `persona-policy-requires-addon` (the pack decides sandboxed and
  `features.persona-accounts` is off). The launch fails at `account`,
  before anything is minted, bound or started, with the repair as its
  action. A soul override or the user setting does not turn it into a
  launch.
- stale, on a principal's launch: the owner has the final say, so instead
  of refusing, the daemon asks the owner to verify (Touch ID, else the
  administrator dialog). Approved, that launch is decided by the stale
  record's own mapping, never by the user setting in its place, and the
  launch journal keeps `ownerVerified: { code, method, source, digest }`,
  saved at once. The approval is for that very record (its sha256): one
  that changes while the owner is asked is refused again. Declined,
  or with no one to ask, the launch fails `persona-policy-stale` before
  anything is minted. A team start, which a soul makes, is refused without
  asking (#613).

- `unrestricted`: the launch is unchanged and runs as the daemon's account.
- `sandboxed`, and the account is `missing` or a step agent-bot can see is
  not done: the launch fails at the `account` stage, so GeniusBar's progress
  list shows where it stopped. Its detail (code `sandbox-not-ready`) is the
  next owner step with its command and the ids of the steps after it:

  ```text
  sandbox-not-ready: this soul runs sandboxed as geniusbar-agent, which is
  missing. Next: Create the standard account geniusbar-agent (owner-admin):
  sudo sysadminctl -addUser geniusbar-agent -fullName "GeniusBar Agent"
  -password -. Then: standard-account, broker-group, pair, harness-sign-in.
  `agent-bot sandbox plan` prints every step's commands.
  ```

  It is one line on the wire and fits the broker's
  512-character launch detail. A step agent-bot cannot see (`broker-group`,
  `harness-sign-in`) never blocks, and neither does `join`: the launch is
  what completes it. Off macOS a sandboxed launch fails the same way rather
  than running unsandboxed.
- `sandboxed`, and the account is ready: the launch runs only on a daemon
  running in that account. The executor starts a harness as the daemon's
  own macOS user: its contract carries a harness, a working directory and
  an environment, but no account or uid, and the owner's daemon has no
  privilege to switch users (nor should it: no silent privileged helper).
  So the owner's daemon fails such a launch at `account` with code
  `sandbox-other-account`, naming the account; a daemon running as
  `geniusbar-agent`, and paired with the broker from it, launches it.

The launch journal row keeps `sandbox: { resolution, account }`, and the
launch result reported to the broker carries the same object beside the
unchanged `requestId`, `status`, `agentId` and `detail`; a broker that does
not know the field ignores it. Showing "Runs as …" from `launchStatus` needs
agent-comms to keep and return that field.

The launch result's `sandbox` object is unchanged (`resolution`, `account`);
the resolver's full answer, with `source` and `sop`, is what `sandbox resolve`
prints.

## The SOP pack's persona mapping

Which souls get an account, and what it is called, is the SOP pack's persona
mapping (ADR-0274 decision 3): a pack is data in the SOP repository, and the
product carries its decision out. The setting here is the user's choice only
when no SOP decides it.

### `persona.toml`

The mapping is `persona.toml` at the root of the SOP repository, in the same
TOML subset as `agent-sop.toml` (comments, `[table]` and `[table.sub]`
headers, quoted strings and integers; no arrays, inline tables or booleans):

```toml
schema_version = 1

[persona]                     # optional: what a soul no rule matches gets
sandbox = "unrestricted"      #   sandboxed | unrestricted; absent: the user setting decides
account = "geniusbar-agent"   #   optional: the account for sandboxed souls whose rule names none

[soul.reviewer]               # by the soul's name
sandbox = "sandboxed"         #   required in every rule
account = "gb-reviewer"       #   optional; else [persona] account, else the user's sandbox.account

[role.auditor]                # by the role in the soul's soul.json (#535)
sandbox = "sandboxed"
```

Two matchers, in order of precedence: `[soul.NAME]`, the soul's name as
GeniusBar shows it (the launch or join name, else its soul.json name, else its
census handle), then `[role.ROLE]`, the `role` in its soul.json; then the
`[persona]` default. Names and roles are compared lowercased with runs of
whitespace as hyphens, so `[soul.release-bot]` matches a soul named "Release
Bot". There is no template matcher: the census records a template revision,
not a template name. Every account name must be a short macOS account name
(`validateSandboxAccount`); anything else, an unknown table or key, or a
rule without `sandbox`, makes the whole file invalid, and an invalid file is
reported as a pack error, and launches are refused until it is fixed.

### Every turn

The policy is evaluated again at the start of every turn the daemon runs
(launch, wake, task and dream turns), once for the turn (#613). A turn is
refused, before its harness is prompted, with the same codes as a launch:
the policy cannot be evaluated, the record is stale, or the pack now puts
the soul in an account this daemon is not (`sandbox-other-account`). Only a
launch the owner verified runs its own first turn past a stale record; the
soul's next wake is refused until `agent-bot sop persona` records the
current selection.

Interactive turns a principal drives (a `/v1` message) are checked the same
way before their harness runs. A principal's turn refused only because the
record is stale asks the owner to verify, by Touch ID or the dialog, as a
principal's launch does. Approved, the turn runs on the stale record's own
mapping and the invocation keeps an `owner-verified` event (`code`, `method`,
`source`, `digest`); declined, or with no one to ask, it fails. Any refusal
leaves a `turn-refused` event with its code and repair action.

`agent-bot doctor` reports the record under `sop.persona`: ready when it
matches the selection, and a warning with `run: agent-bot sop persona` when
it is legacy (`sop-persona-legacy`, from before selections were kept), stale
(`sop-persona-stale`), not recorded (`sop-persona-unrecorded`) or unreadable
(`sop-persona-unavailable`).

### Recording the mapping

The sandbox and the daemon's launch path never fetch anything, so the
mapping is read once, online, and recorded:

```sh
agent-bot sop persona [--json]
```

resolves the **user's** SOP (`~/.config/agent-sop/config.toml`, ENG-0355),
reads `persona.toml` at the SOP commit through the same pinned, read-only git
boundary as `org.json` (nothing is cloned or executed) and writes
`<state>/sop-persona.json` (0600) with the selection it was made from (the
config file and its `owner/name@ref` for org, and for sop when the config
names one), the org and SOP repositories, the commit, the time and the
file's text. It prints the parsed rules, or that the
commit has no `persona.toml`, or the pack error (exit 1; the file is still
recorded so `sandbox status` reports the same error). A soul's own
`agent-sop.toml` never decides personas: a soul must not choose the account
it runs as, so `--soul` is refused. Run it again after the pack moves or the
config selects another SOP. With no config file it records nothing and
removes a previous record.

Offline, `sandbox status`, `resolve` and the launch read the record and
report its `state`:

| `state` | Meaning | What applies |
| --- | --- | --- |
| `ok` | the record is for the SOP the config selects and parses | the pack decides matched souls |
| `none` | no `~/.config/agent-sop/config.toml` | the user setting |
| `unrecorded` | a config, but `sop persona` has not run | **launch refused** (`persona-policy-unavailable`); run `agent-bot sop persona` |
| `stale` | the record is not for the selection the config makes now | **refused** (`persona-policy-stale`); a principal's launch asks the owner |
| `absent` | the SOP commit has no `persona.toml` | the user setting |
| `invalid` | `persona.toml` does not parse (the message says why) | **launch refused** (`persona-policy-unavailable`) |
| `error` | the config or the record could not be read | **launch refused** (`persona-policy-unavailable`) |

A record is current only for the exact selection it was made from: the same
config file, the same org and sop `owner/name@ref` (repository names compare
without case, refs exactly), and, where a ref is a 40-hex pin, that very
commit. A record written before the selection was kept is `stale`; run
`agent-bot sop persona` once to refresh it.

A record cannot tell that the SOP's branch has moved to a new commit; it says
which commit it is for, and the next `sop persona` picks the move up.

### Resolution order and the gate

For each soul, in order:

1. **The pack.** A matched rule or the `[persona]` default decides;
   `source` is `sop` and the account is the rule's, else `[persona]`'s, else
   the user's `sandbox.account`. The user's override and switch do not apply.
2. **The override.** No pack decision: the census override, `source`
   `override`.
3. **The switch.** `features.persona-accounts`, `source` `global`.

The pack never turns the add-on on. With `features.persona-accounts` off, a
pack decision to sandbox is reported (`sop.rule`, `sop.sandbox`,
`sop.account`) and its launch is refused (`persona-policy-requires-addon`),
with a `reason` saying the gate is off; it never runs unrestricted instead.
`agent-bot sandbox on` is still the owner's consent to persona accounts, and
creating the account stays the owner's steps above. A pack decision of
`unrestricted` launches as before.

## Daemon routes

With the daemon's per-start bearer:

- `GET /v0/sandbox` returns what `status --json` returns, plus `schemaVersion`:
  the `sop` record and each soul's `source`, `sop` and `reason`.
- `POST /v0/sandbox` with `enabled` and/or `account`, and `principal`, sets
  the switch and the account through the same owner gate as other settings,
  appends a `sandbox` audit receipt, and returns the new status.
- `POST /v0/sandbox/override` with `agentId`, `override` and `principal`
  records a soul's override and returns its resolution; an unknown soul is
  404, and `sandboxed` or `unrestricted` for a soul the pack decides is 409
  with the message naming the pack (`inherit` is accepted).
