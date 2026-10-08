---
name: agent-bot
description: Bootstrap, configure, and operate per-harness GitHub App identities and authorized secure-store reads for coding agents. Use for fresh-clone requests such as "install agent bot identities," source or installed agent-bot setup and diagnosis, bot credential minting, password or API-key retrieval, identity attribution, GitHub-verified bot commits, transcript-bound Agent IDs, Agent Spaces, joining the hub (agent-comms), and the account-local soul population. Do not use to bind a human's own checkout to a bot on harness detection alone, broaden password-manager access, or fall back to human credentials.
metadata:
  qwts-contract: "1"
  qwts-cli: "agent-bot"
  qwts-versions: ">=0.10.0 <0.11.0"
  qwts-validated: "0.10.49"
  qwts-side-effects: "remote-write"
---

# Agent Bot

Choose the runtime entrypoint before acting. In an `agent-bot-identity` source
checkout, use `./agent-bot bootstrap` when the stable CLI is absent. After the
machine install succeeds, use the installed `agent-bot` CLI. Keep the
worktree's commit identity, token identity, PR author, and execution identity
aligned. Fail closed when an App cannot be resolved or a credential cannot be
minted; never continue with an ambient human GitHub login.

## Route the request

- Read [operations.md](references/operations.md) for fresh-machine bootstrap,
  installation, worktree setup, token minting, password/API-key retrieval,
  diagnostics, or identity-repair requests.
- Read [verified-publish.md](references/verified-publish.md) before publishing.
  Bot-authored commits on a qwts repository are signed. `agent-bot signed-commit` is how.
- Read [execution-identities.md](references/execution-identities.md) for Agent
  ID creation, binding, recording, lookup, transcript provenance, or Agent
  Space resolution.
- Read [storage-surfaces.md](references/storage-surfaces.md) when deciding
  where a file belongs among worktree, scratchpad, and Agent Space.

`agent-bot skill agent-bot --for <subcommand>` prints the one reference that
covers a subcommand. Load only the reference needed for the current request. Load all three when
diagnosing a cross-cutting mismatch among commit attribution, credentials,
verified publishing, and transcript provenance.

## Joining the hub (agent-comms)

The hub is agent-comms. `agent-bot join` is the supported way for an agent
that nobody launched to become a soul and join agent-comms. It needs no
GitHub App. A GitHub App is only for acting on GitHub (push, pull requests,
`gh`), and is connected separately.

```bash
agent-bot join --name NAME --harness H
```

It reuses the soul already pinned in this checkout, or the soul whose binding
the checkout holds. Otherwise it uses `--soul`, which must be an active soul.
Otherwise it spawns a new instance of `--template`, with the same mechanism as
`agent-bot soul spawn`. Pass `--soul AGENT_ID` to join an existing active soul
from an unpinned checkout; pass `--template PATH` when creating a new instance
from that package. With no `--template`, it uses the Starter template the
install ships, if any. Homebrew and source installs ship none, so they create
a soul with no package. Running it again from the same checkout reuses the
soul. A checkout already pinned to another soul is refused.

A new soul gets a soul directory under the souls root and a census row.
The census row records the checkout, the checkout is linked into the soul,
and `agentBot.agentId` pins the soul in the checkout's worktree config.
A single-use bind token is minted, so the MCP `bind` tool works in that
checkout. Outside a git checkout, the soul's own `worktrees/workspace` is
created and `git init`ed on first join. No GitHub attribution (author,
credential helper, hooks) is written. It runs
`agent-comms join --name NAME --harness H` as the soul.

With `--wake` only, new messages then wake the soul. Cold wake is owner only,
so the owner gate runs before anything is created, and a refusal changes
nothing. See [joining.md](../../docs/joining.md) for all flags, wake choices,
and the full join procedure, and [soul-homes.md](../../docs/soul-homes.md)
for the souls root and directory contract.

## Choose the storage surface

<!-- conformance: keep this three-surface distinction and its ENG-0172-backed
     reference intact in every skill edit. tests/skill.test.mjs enforces it. -->

Worktree files are Git work that ships in commits and PRs. Scratchpad files
are session-ephemeral and die with the context. Agent Space is the durable
per-soul store for belongings that must outlive both; resolve it only through
`agent-bot space ensure` and `agent-bot space path`, never a raw filesystem
path. Details and the governing contract link live in
[storage-surfaces.md](references/storage-surfaces.md).

## Preserve the invariants

1. The account, not the directory, is bot territory (ENG-0339): a rostered
   agent account owns every checkout in it; in the owner's account act as the
   human's delegate unless `--app`, `GH_AGENT_APP`, or a pin states a bot.
   Never treat a `.<tool>/worktrees/**` path as an identity signal.
2. Resolve one App through the shared runtime; do not reproduce resolution in
   shell snippets or skill-local scripts.
3. Stop on mint, credential, identity-pin, lease, verification, or tree-match
   failures. Never retry as the human account.
4. Use HTTPS for bot GitHub operations. SSH commonly bypasses the App identity.
5. Keep executable behavior in the repository runtime and keep this skill as
   workflow guidance. Do not create a second copy of runtime logic here.
6. Secret retrieval uses one explicitly selected provider and an existing
   authorized session, plus a concrete audit reason. Never search another
   provider, automate provider login, or persist the result.
7. Treat an organization-wide install request as governance discovery plus
   runtime bootstrap. Prefer the versioned `--profile` contract, require the
   complete active identity roster and organization-owned harness tooling, and
   never reduce it to the current harness or reactivate a retired identity.
8. GitHub identity is an add-on: `signed-commit`, `Agent-Identity` trailers
   and the `gh` shim run only with `features.github-identity: true` in the
   user config (`doctor` shows each gate). Off is not an error to work around.

## Know the side effects before retrying

Run `agent-bot --version` before following a workflow here. If it is outside
`qwts-versions`, treat this skill as a hint. Take a command's behavior from
that version's `--help`, and do not mutate anything that help cannot vouch
for. `agent-bot skill path` prints the installed release's copy of this skill.

| Class | Commands | Retry |
|---|---|---|
| read-only | `--help`, `doctor`, `sop`, `skill`, `skill path`, `population list`, `space path`, `signed-commit --dry-run`, `secret get` | Safe to repeat. |
| local-write | `bootstrap`, `setup-worktree`, `install`, `install-gh-shim`, `daemon install`, `daemon disable`, `ensure-private-key`, `space ensure` | Converge on rerun; confirm with `doctor`. |
| read-only | `soul show`, `soul profile`, `soul env`, `soul runtimes`, `soul secret ID status`, `soul locate`, `soul templates`, `soul asides`, `soul cold-wake ID show`, `soul model ID show`, `soul mode ID show`, `soul computer-use ID show`, `soul comms ID show`, `soul confinement-report`, `soul pack validate`, `soul build --check`, `approvals list`, `telegram status` | Safe to repeat. |
| local-write | `soul dir` | May re-register a uniquely moved soul directory; see [soul-homes.md](../../docs/soul-homes.md). |
| local-write | `soul spawn`, `soul build`, `soul revision`, `soul env migrate`, `soul runtimes install`, `soul secret ID set|clear`, `soul cold-wake`, `soul model`, `soul mode`, `soul computer-use`, `soul confinement`, `soul stop`, `soul pause`, `soul resume` | Inspect the subcommand and current state before retrying; spawning creates a new identity, and owner actions require the owner gate. |
| local-write | `approvals approve`, `approvals deny`, `web open` | Decisions require the daemon's owner gate; inspect waiting proposals before retrying. Each web open mints a single-use pairing code and prints/opens its link. |
| remote-write | `join` | Also writes local soul, census, checkout pin and bind-token state. Running it again from the same checkout reuses the soul; see [joining.md](../../docs/joining.md). |
| remote-write | `soul comms`, `soul fork`, `telegram run` | Changes agent-comms membership or relays messages; also writes local state. Inspect current state before retrying. |
| destructive | `soul remove` | Owner-gated: leaves agent-comms, retires the soul (there is no un-retire), and archives its folders. Repeating finishes cleanup. |
| remote-write | `mint-token` | Each run mints a new short-lived token; repeating is safe. |
| remote-write | `signed-commit` | Never blindly rerun. Follow the printed recovery in [verified-publish.md](references/verified-publish.md), and inspect the remote branch head before any second attempt. |

## List and spawn soul templates

```bash
agent-bot soul templates [--json]
agent-bot soul spawn TEMPLATE_PATH --name NAME [--harness H]
```

Listing is read-only and secret-free. It discovers marked, unlaunched packages
in the souls root, `teams.template` from config, and any bundled Starter.
JSON includes `templates`, `soulsRoot`, and per-package `errors`; each template's
absolute `package` path can be passed to spawn or a named package launch.
Spawning writes a new local soul with its own identity and revision history.

## Control computer use

`agent-bot soul computer-use <agentId|name> [show|on|off] [--json] [--principal-stdin]`
defaults to show. Changes require the same owner gate as `soul mode`, accepting
a presented principal on stdin. JSON is `{agentId, computerUse: true|false}`.
The durable flag defaults to true and appears beside `paused` in soul,
population, and daemon health/status JSON. Off denies computer-use proposals
without prompting in Safe and Auto-Pilot modes, leaving other tools unchanged.
With the daemon running, off also stops the soul's turns when computer use is
active and returns `stopped: true`. Changes and denials leave `computer-use`
audit receipts. `POST /v0/soul/computer-use` accepts `{agentId, enabled}` and an
optional presented `principal`; `daemonClient.setComputerUse` uses this route.

## Approve a tool call

`agent-bot approvals list --json` shows waiting proposals. The owner decides
with `approvals approve <proposalId> [--scope once|session] [--json]` or
`approvals deny <proposalId> [--json]`; both require the daemon's owner gate.
The default `once` also allows the tool for the rest of that turn. `session`
allows that exact tool for that soul across turns in the same harness session,
until the session changes, the soul stops or pauses, or the daemon restarts.
Policy deny and computer-use off still win. JSON exposes `scope` and
`decision` (`approved_session`, `approved`, or `denied` after a decision).

## Stop or pause a soul

`agent-bot soul stop <agentId|name> [--json]` asks the loopback daemon to
cancel the soul's current cold, launch, or interactive turn. The local caller
must pass the same soul-marker check as `approvals`; no owner presence dialog
is needed. JSON is `{agentId, stopped: true}` or
`{agentId, stopped: false, reason: "idle"}`. The daemon records a `stop`
receipt, and the turn remains busy until cancellation finishes. Later wakes
still run; this command does not pause cold wake.

`agent-bot soul pause <agentId|name> [--json]` cancels the current turn and
persists `paused: true`. Wakes wait without acknowledging inbox messages;
launches and interactive turns are refused with `soul-paused`. JSON is
`{agentId, paused: true, stopped: true|false}`.
`agent-bot soul resume <agentId|name> [--json]` clears the flag, returning
`{agentId, paused: false}`; the next inbox poll can wake the soul normally.
Both use the same caller gate as stop and record `pause` or `resume` receipts.
`agent-bot soul show <agentId|name> --json`, population JSON, and daemon health
and status soul lists expose `paused` (false by default).

`agent-bot soul profile <agentId|name> [--json] [--file RELATIVE_PATH]` reads
the soul’s profile, allowed package and generated files, skills, declared
credential names, and offline SOP availability. File contents require an
inventoried UTF-8 path and are capped at 256 KiB. It never reads credential
stores or fetches SOPs. See [soul-profile.md](../../docs/soul-profile.md).

`agent-bot soul env <agentId|name> [--json]` describes the soul's whole
environment (schema 1): each component with its classification and
retention, declared against installed harnesses and runtimes, launch routing,
readiness problems with the command that fixes each, and pending migration
steps. It is read-only: it never provisions, links, registers or rebuilds.
`agent-bot soul revision prepare <agentId|name> [--json] [--dest PATH]` stages
the editable definition under `.soul-state/tmp/`; `soul revision edit ... --apply`
finishes it and `prepare --discard STAGING` drops it. See
[soul-environment.md](../../docs/soul-environment.md).

Each soul's harness state can live in its own tool home,
`<soul>/.soul-state/tools/<harness>/`: a launch sets `CLAUDE_CONFIG_DIR`,
`CODEX_HOME` or OpenCode's XDG bases to it, never `HOME`, and a harness
with no such variable (kiro, muse) is reported `unsupported`. Containment
is decided per launch from sign-in presence: a soul holding its sign-in, or
a host with none to lose, is routed (a new Mac is contained from the first
launch); an existing host sign-in the soul lacks stays on the host store
until adopted, reported `containment: shared-host` with the
`tool-signin-missing` warning. `agent-bot soul env migrate <agentId|name>
--adopt-host-signin [--harness NAME]` is the owner action that copies the
host's sign-in files (and Claude's `.claude.json`) into the tool home once;
it never reads the keychain, never copies sessions or caches, and a rerun is
`skipped`. Run it when `soul env` reports `tool-signin-missing` and the soul
should be contained; the next launch then routes. See
[soul-tool-homes.md](../../docs/soul-tool-homes.md).

A soul's memory and history live in its folder too. A new soul's Agent
Space is a real directory at `<soul>/.soul-state/space/` and the census
`spacePath` is what every reader resolves (`agent-space path`, the daemon,
`soul env`, promotion). A soul from before keeps its space under
`~/.agent-space`, linked, and `soul env` reports `memory-not-contained`;
`agent-bot soul env migrate <agentId|name> --space-into-soul` is the owner
action that moves it: copied into a staging inside the soul, verified by
size and SHA-256, switched in, the census updated, the source retired as
`<source>.retired-<date>` (never deleted), journaled and resumable, refused
`space-migrate-busy` while the soul runs. Each soul also carries an
append-only history mirror under `.soul-state/runs/` (`turns.jsonl`,
`revisions.jsonl`: ids, kinds, times, harness, outcome, reason; never
prompts or outputs), written best effort beside the daemon's own journals.
See [soul-memory-history.md](../../docs/soul-memory-history.md).

`agent-bot soul runtimes <agentId|name> [--json]` reports the runtimes
(`node`, `python`, `go`) and non-npm harness installs the soul's `soul.json`
declares, resolved against the pinned catalog and what is installed under
`.soul-state/runtimes/`. `agent-bot soul runtimes install <agentId|name>
[--runtime NAME] --principal-stdin` is the owner action that provisions what
is missing from checksum-verified downloads; the daemon runs it at launch
too. Failures are coded (`runtime-download-failed`,
`runtime-checksum-mismatch`, `runtime-unsupported-platform`,
`runtime-install-failed`) and name the fixing command. Never install a
runtime on the host for a soul; see
[soul-runtimes.md](../../docs/soul-runtimes.md).

`agent-bot soul secret <agentId|name> set <name>` stores the secret a
harness's `soul.json` provider names (`harnesses.<h>.provider.credential`
→ `credentials.secrets.<name>`), reading the value from stdin only: pipe
it (`printf '%s' "$TOKEN" | agent-bot soul secret billy set github-models`),
never put it on argv, never echo it, never write it into `soul.json` or a
harness `env`. `clear <name>` removes it; both are owner actions. `status
[--json]` says `present` or `missing` per secret and `ready` or
`secret-missing` per provider with the fixing command, never the value.
At launch the daemon injects it into that harness's process alone; a
missing one fails the launch with `provider-secret-missing`. See
[soul-providers.md](../../docs/soul-providers.md).

`agent-bot sandbox status|plan|on|off|account NAME|override <agentId|name> [inherit|sandboxed|unrestricted]|resolve <agentId|name> [--json]` reports the persona account for sandboxed souls (`missing | creating | ready`), lists the owner's steps to create and onboard it (agent-bot never runs them), and keeps the global switch and per-soul overrides (#376). Writes are owner actions. The SOP pack's `persona.toml` decides first (`source: sop`; an override on such a soul is refused), then the override, then the switch; `agent-bot sop persona [--json]` records that mapping online (`<state>/sop-persona.json`) so status and launches read it offline, and the switch off keeps a pack decision reported but unapplied (GeniusBar#66, ADR-0274).

## Verify the outcome

Check the relevant local identity state before mutating GitHub. After a write,
confirm the remote author or verification state and report any recovery command
printed by the CLI. Never expose tokens, JWTs, App keys, passwords, API keys, or
private identity records in logs or responses.
