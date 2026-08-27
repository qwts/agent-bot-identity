# agent-bot-identity

Give every coding agent on your machine its **own GitHub identity** — so a
worktree created by Codex commits and opens PRs as `you-codex-agent[bot]`, one
created by Claude Code as `you-claude-agent[bot]`, and so on, while your own
shell stays *you*. Zero npm dependencies, no per-tool plugins: the trigger is
git's native hooks, and the identity is detected from the environment each IDE
already sets on its own. A loopback identity daemon is installed as a user-level
supervisor so production verbs do not depend on someone remembering to start it.

Why you'd want this:

- **You can approve your agents' PRs.** GitHub forbids approving your own PR;
  when agents author as you, review-gated merges are impossible on a solo
  account. Bot authorship gives you a real Approve button.
- **Authorship tells you which tool wrote what** — machine-queryable
  (`author:you-codex-agent[bot]`), immutable, audit-friendly.
- **Per-tool blast radius.** Each App has its own key and repo list; revoke or
  narrow one agent without touching the others.
- **Fail-closed `gh`.** With the shim installed, agents outside bot territory
  cannot fall through to your human credentials.
- **Transcript-bound Agent IDs.** Each conversation gets a private
  `agent_<uuid>` recorded on commits as an `Agent-Identity:` trailer, so you
  can resolve a commit back to the provider transcript that produced it.
  (Read one commit with `git show -s --format='%B' <sha> | grep '^Agent-Identity:'` — GitHub's
  squash merge appends its own co-author block, which pushes the trailer out
  of the final paragraph that git's `%(trailers:)` parser reads. The local
  identity record and census are the authoritative attribution store; the
  trailer is a breadcrumb.)

This repository is the sole runtime owner of the agent-bot and
transcript-bound execution identity system. Clone and install it directly;
organization governance may supply the roster, compatible configuration, and
shared harness tooling, but it is not a runtime provider. For `qwts`, those
organization-owned inputs and their acquisition procedure are governed from
[`playbook-engineering`](https://github.com/qwts/playbook-engineering/blob/main/docs/reference/agent-bot-operations.md);
if that procedure does not yet publish compatible input, bootstrap must stop.

## Machine install (Homebrew)

This repository is a Homebrew self-tap. Operators install the runtime from
the tap, then wire machine state with the installed CLI — do not require a
durable git checkout:

```bash
brew tap qwts/agent-bot-identity https://github.com/qwts/agent-bot-identity.git
brew install agent-bot
```

Newer Homebrew may require `brew trust qwts/agent-bot-identity` after the tap.

Homebrew places `agent-bot` on PATH under the prefix. It does **not** write
`~/.local/bin`, Git `core.hooksPath`, or shell startup files. Run machine
wiring next:

```bash
agent-bot bootstrap --profile /path/to/organization-profile.json --with-gh-shim --machine-only
```

If `~/.local/bin/agent-bot` already points at a git checkout, move that
symlink aside first (`rm ~/.local/bin/agent-bot`). The installer refuses to
replace a symlink that does not already point at this packaged tree.
Bootstrap records Homebrew's stable `opt` wrapper, not a versioned Cellar
path, so a later `brew upgrade` does not leave hooks dangling.

Development and first-time source installs still clone this repository and
use `./agent-bot bootstrap` as documented below.

## Cold start: “install agent bot identities”

When the stable CLI is already installed from Homebrew, skip the source
launcher and use `agent-bot bootstrap` as in Machine install. From a fresh
clone, begin with the source launcher. Do not require an installed
CLI to install itself, and do not configure only the harness currently running.
Opening this checkout before bootstrap, or a cloud / ephemeral session that
cannot finish install, is the uninstalled class: committed hooks refuse
human-attributed commits and GitHub writes unless the actor is in
`AGENT_BOT_UNMANAGED_AUTHORS` (default `ai9d` when unset). Reads and
uncommitted edits are allowed. `doctor` reports `identity.class` and does
not install. Publishing as the bot still requires the durable-host journey
below.
For a governed organization, first obtain its explicit secret-free versioned
profile and shared-tooling procedure. Never search for or assume
a local governance checkout; follow its canonical HTTPS guidance instead.

From a primary checkout, prepare machine state without claiming that checkout
as bot territory:

```bash
./agent-bot bootstrap --profile /path/to/organization-profile.json --with-gh-shim --machine-only
```

Then enter a linked agent worktree and bind it through the installed runtime:

```bash
agent-bot bootstrap --worktree-only
```

When already working from a linked agent worktree, omit `--machine-only` from
the source command to perform both phases. Bootstrap reconciles and
live-verifies every App resolved by the configuration, not merely the current
harness. Afterward, complete the organization-owned shared skills and harness
tooling from its governance procedure.

Finish with the secret-free readiness contract:

```bash
agent-bot doctor --machine-only --json --require-schema-version 1
agent-bot doctor --json --require-schema-version 1  # linked worktree
```

Do not report the organization install complete until every expected App row
and requested harness tool is ready. A missing organization input or tool is a
blocking dependency, not permission to fall back to a human GitHub login or a
partial current-harness setup.

## Stable CLI

Installation provides one executable at `~/.local/bin/agent-bot`:

```bash
agent-bot bootstrap [--profile <path|->] [--config <path>] [--app <slug>] [--with-gh-shim] [--json]
agent-bot --version
agent-bot setup-worktree [app-slug]
agent-bot mint-token --app <slug> [--json]
agent-bot doctor [--machine-only] [--app <slug>] [--json]
agent-bot identity <ensure|spawn|bind|record|finalize|show|current>
agent-bot space <init|ensure|path|show> [agent-id]
agent-bot space export [agent-id] [--out <path>] [--gist]
agent-bot space import <pack|gist:id|gist-url> [--force]
agent-bot space retire <agent-id> [--delete-space]
agent-bot population <list|show|backfill> [agent-id|name] [--dry-run] [--json]
agent-bot daemon <run|start|status|stop|disable> [--json]
agent-bot mcp
agent-bot web open [--principal <principal-id>] [--no-browser] [--json]
agent-bot telegram <run|status> [--json]
agent-bot install [--with-gh-shim]
agent-bot install-gh-shim
agent-bot ensure-private-key --app <slug> [--force]
agent-bot signed-commit [--base <ref>] [--branch <name>] [--repo <owner/name>] [--dry-run]
agent-bot secret get --provider <id> --collection <name> --item <title> --field <name> --reason <text>
```

### Organization profile v1

`--profile` is the governed cold-start input. It accepts a JSON file or `-`
for stdin, validates the complete document before any machine mutation, and
projects it into the existing private runtime config. Profile schema version
and runtime interface version are independent from readiness schema version.

```json
{
  "schema_version": 1,
  "organization": "example-engineering",
  "account_owner": "example",
  "minimum_runtime_interface_version": 1,
  "defaults": {
    "claude": "example-claude-agent",
    "codex": "example-codex-agent"
  },
  "identities": [
    {
      "slug": "example-claude-agent",
      "harness": "claude",
      "status": "active"
    },
    {
      "slug": "example-codex-agent",
      "harness": "codex",
      "status": "active"
    },
    {
      "slug": "example-codex-sol-agent",
      "harness": "codex",
      "status": "active",
      "models": ["gpt-5.6-sol"]
    },
    {
      "slug": "example-retired-agent",
      "harness": "codex",
      "status": "retired"
    }
  ]
}
```

Every active harness must have one active default. Active App slugs, including
model-specific identities, enter roster-wide credential reconciliation;
retired identities remain as lifecycle evidence but are never reconciled or
live-minted and cannot be selected explicitly, by launcher environment, or by
a stale worktree pin. Duplicate slugs, ambiguous active model mappings, invalid or
partial profiles, unknown schema versions, and incompatible runtime
requirements fail before the config, runtime, credentials, shim, or worktree
is changed. Reapplying the same profile is a no-op; a different installed
config is a conflict that requires explicit reconciliation.

Optional `api_base` must be a credential-free HTTPS URL. Optional `settings`
may contain `spaces_root` and `daemon_preference` (`off`, `prefer`, or
`required`). Unknown fields are rejected under schema v1 instead of being
silently ignored.

```bash
./agent-bot bootstrap --profile - --machine-only < organization-profile.json
```

`--config` remains the compatibility path for an already projected runtime
config. It is mutually exclusive with `--profile` and does not carry the
versioned organization roster contract.

`mint-token --json` writes one secret-bearing object to stdout:

```json
{"schema_version":1,"token":"<installation token>","expires_at":"<ISO timestamp>","installation_id":123}
```

Treat that stdout as a credential. Errors, diagnostics, identity records, and
logs never contain tokens, JWTs, or private keys.

`doctor --json` and `bootstrap --json` emit the same secret-free readiness
contract. Unlike mint output, this object is safe to retain in automation:

```json
{
  "schema_version": 1,
  "command": "doctor",
  "scope": "machine",
  "ready": true,
  "machine": { "status": "ready", "checks": [], "apps": [] },
  "worktree": { "status": "not_requested", "checks": [] },
  "first_actionable_failure": null
}
```

Each check has fixed `id`, `status`, `code`, `message`, `action`, and
`evidence` fields. App rows contain separate `credential` and `live_mint`
checks. Consumers can pass `--require-schema-version <n>`; bootstrap rejects an
unsupported minimum before changing config, credentials, tools, or worktrees.

`secret get` provides the same narrow stdout boundary for a password or API key
that an agent is already authorized to read. The first built-in provider is
`proton-pass`, backed by `pass-cli`; install and authenticate that CLI before
calling `agent-bot`. The command never performs provider login, searches another
provider, or persists a retrieved value:

```bash
API_KEY=$(agent-bot secret get \
  --provider proton-pass \
  --collection "Agent Identities" \
  --item anthropic \
  --field "api key" \
  --reason "Use the Anthropic API for this task") || exit 1
export API_KEY
```

An agent-bot config with a harness-to-App mapping must already exist; without
it, retrieval is inert. Collection and item names are exact and must identify
one active item. The requested field selector is trimmed, then matched exactly
and case-insensitively against the provider label; provider-label whitespace
and punctuation remain significant. Thus `api key` matches `API Key`, but not
` API Key ` or `api_key`. An unqualified label that exists in more than one
section is rejected; use a qualified label such as `Production.api key`.
Success writes only the unchanged field value to stdout, with no added newline.
Every error exits nonzero with empty stdout and a non-secret diagnostic on
stderr. Shell command substitution removes trailing newlines, so use the raw
stdout stream when those bytes are significant.

`--reason` is required and is passed to Proton as `PROTON_PASS_AGENT_REASON`
only for the audited item read. It must describe why the agent needs the value.
For a least-privilege Proton session granted one item instead of its parent
vault, use the explicit virtual collection `--collection @item-shares`; the
item title must still identify exactly one direct item share. Vault-backed
reads require list access to the named vault and its active item summaries.

This password/API-key path is separate from `ensure-private-key`, which
provisions GitHub App key files and issuers.

`signed-commit` replays a clean, linear local commit range through GitHub's Git
Data API so each result is App-authored and GitHub-verified. It checks the
remote branch before and after replay, verifies every returned signature and
tree, then resets the local branch to the published signed history. Start with
`agent-bot signed-commit --dry-run`; the preview is network-free.

`population` reads the workstation-local census at
`$XDG_STATE_HOME/agent-bot/population.json` (or
`$AGENT_BOT_POPULATION_PATH`). Records contain only the Agent ID, App slug,
parent ID, status, Agent Space path, optional transcript locator, and last-seen
timestamp. Identity JSON remains the provenance source of truth; this census
is a separate aggregate index. Filter the population with `--status` or
`--app`, and use `--json` for machine-readable output:

```bash
agent-bot population list --status active --app you-codex-agent --json
agent-bot population show agent_00000000-0000-4000-8000-000000000000
agent-bot population show quiet-heron-42
```

Every census row carries a human-readable display name (`quiet-heron-42`),
derived deterministically from the Agent ID, so rows written before names
existed gain one on the next read with no migration. The census is
authoritative: consumers read the recorded name rather than re-deriving
meaning from the display string, the row stays keyed by Agent ID (names are
handles and may collide; IDs cannot), and `population show` accepts a name
whenever it is unambiguous.

Rows that predate binding carry `transcriptLocator: null` and show `?` in the
PARENT column; `population list` counts them on every listing so the gap can
never persist silently. `population backfill` repairs what the workstation's
own transcript stores still prove: it scans `~/.claude/projects` and
`~/.codex/sessions` for session files that mention each unbound Agent ID and
records the locator when exactly one transcript names it. An ID found in
several transcripts or none is reported and left untouched — ambiguity never
turns into invented provenance. `--dry-run` prints the exact repairs without
writing; results carry only `{provider, id}` locators, never transcript
content or paths.

```bash
agent-bot population backfill --dry-run
agent-bot population backfill
```

`daemon` runs a machine-local service over the same space and population
stores, so other agents and hooks can register souls and ensure spaces without
importing runtime modules. It binds only to `127.0.0.1` — a non-loopback bind
address is refused before the listener opens — and every request must present
the per-start bearer token recorded in the `0600` state file at
`$XDG_STATE_HOME/agent-bot/daemon.json`, which keeps other local accounts on a
shared machine out. `install`, `update`, and `bootstrap` write and load a
user-level supervisor (`launchd` on macOS, a systemd user unit on Linux) that
execs `daemon run` at login and restarts it on failure. `start` is recovery
when the supervisor is not in use; `status`/`stop` probe and terminate the
recorded daemon; `disable` unloads the supervisor. MCP remains per-conversation
stdio and is never supervised. With `settings.daemonPreference` set to
`prefer` or `required`, `setup-worktree` registers and ensures space through
the daemon: `prefer` falls back to the in-process path only when the daemon is
unreachable, and `required` fails closed rather than diverging from the
daemon-owned stores. After the supervisor path has been applied, `doctor`
treats a missing supervisor or a down daemon as not-ready.

### MCP server: bind a conversation to its identity

`agent-bot mcp` serves the sanctioned agent-bot MCP tools over stdio, so any
MCP-capable harness can mount them with zero dependencies. It augments the
worktree scripts rather than replacing them: `setup-worktree` still configures
everything it always did, and additionally mints a **single-use bind token**
into the worktree's private git dir — an inert claim of *place* that confers
nothing until surrendered.

Mount it in the harness (for Claude Code, `.mcp.json` in the repo or project):

```json
{ "mcpServers": { "agent-bot": { "command": "agent-bot", "args": ["mcp"] } } }
```

At conversation start the agent calls the `bind` tool with what only the
conversation knows — its session/thread identifier, and its parent agent when
it was spawned by one. The server reads the minted token from the worktree it
is running in and surrenders it to the daemon, which verifies the token
against the file on disk, **consumes it**, joins place and conversation into
one identity, and answers with a per-connection binding secret the MCP server
holds in memory only. The secret is never written down, logged, or shown to
the conversation.

From then on identity is a property of the connection, not a parameter of any
request: `whoami` and `space_path` carry no Agent ID, and the daemon derives
who is asking from the binding alone. A consumed token cannot be replayed —
after binding there is no token left to steal — and a daemon restart drops
every binding, so re-binding takes a fresh mint from the same worktree
(re-running `setup-worktree` or any later checkout re-mints; a re-mint is a
fresh proof of place, never a fresh identity).

Binding is also the moment provenance lands in the census: the row picks up
the transcript locator and parent lineage that pre-bind rows lack. Tools:
`bind`, `whoami`, `population`, `space_path`, `credential`.

The `credential` tool is tier-1 brokering only: the daemon mints a
short-lived App installation token for the identity the connection is bound
to — the bot the caller already *is*, so nothing is borrowed. The request
names no App and no Agent ID; both derive from the binding, authorization is
"a bound agent on an enforced connection" rather than "can read the key
file", and every grant or refusal appends an audit receipt (which records
who and what, never the credential). Delegated human authority — operations
only `qwts` can approve — is deliberately not this tool: that tier must
never return a credential at all, and remains future work under #35's
bounded approval broker.

### Reach-back MCP server: the session's channel to its thread

`agent-bot reach-mcp` serves the daemon reach-back tools over stdio: the one
channel a daemon-driven harness session has back to the adapter thread that
started it. Tools: `fetch_context` (the inbound message, attachment
references — `space://` refs resolved into the soul's Agent Space when
possible — and a bounded thread history), `report_status` (interim progress),
`post_reply` (the final answer, landed as a durable `reply` event the adapter
relays to its surface), and `clock_in` (an identity heartbeat carrying
`agentBot.agentId`).

It is **one server with two placements**:

- **Injected** — the ACP drive engine passes a per-invocation entry in
  `session/new` `mcpServers[]` (built by `reachMcpServerEntry`), with the
  invocation id and identity stamped into the entry's environment
  (`AGENT_BOT_REACH_INVOCATION`, `AGENT_BOT_REACH_AGENT_ID`). Claude,
  OpenCode, and Codex sessions get this placement for free; no tool argument
  ever names the invocation, and the server refuses an explicit
  `invocation_id` that addresses any other thread. Muse is the exception:
  muse-acp warns and drops injected entries because `muse exec` has no
  per-run MCP mount, so Muse's reach-back lane is registered-only for now.
- **Registered** — a live desktop harness config mounts
  `agent-bot reach-mcp` from a configured worktree. Identity comes from the
  worktree's `agentBot.agentId` git config, invocations are addressed
  explicitly via `invocation_id`, and sessions remain **session-initiated
  only**: the harness reaches into threads; nothing wakes it.

Writes fail closed on identity: an invocation belonging to a different soul
than the server speaks for is refused before any event is appended.

Registered-placement snippets per harness:

```json
// Claude Code — .mcp.json
{ "mcpServers": { "agent-reach": { "command": "agent-bot", "args": ["reach-mcp"] } } }
```

```json
// OpenCode — opencode.json
{ "mcp": { "agent-reach": { "type": "local", "command": ["agent-bot", "reach-mcp"] } } }
```

```toml
# Codex — ~/.codex/config.toml
[mcp_servers.agent-reach]
command = "agent-bot"
args = ["reach-mcp"]
```

```json
// Muse — workspace plugin manifest, .muse-plugin/plugin.json
{ "schemaVersion": 1, "name": "agent-reach", "version": "0.1.0",
  "capabilities": { "mcpServers": [
    { "id": "agent-reach", "transport": "stdio", "command": ["agent-bot", "reach-mcp"] }
  ] } }
```

```json
// Cursor — ~/.cursor/mcp.json
{ "mcpServers": { "agent-reach": { "command": "agent-bot", "args": ["reach-mcp"] } } }
```

```json
// VS Code / Copilot — .vscode/mcp.json
{ "servers": { "agent-reach": { "type": "stdio", "command": "agent-bot", "args": ["reach-mcp"] } } }
```

**Cursor and VS Code/Copilot are registered-only.** Neither has an entry on
the ACP drive plane (isolated-store CLIs, per #144), so the registered
placement is their ONLY reach-back lane: a person working in those harnesses
can read context and land replies into agent threads, but no daemon ever
drives a Cursor or Copilot session.

### Private web client

The daemon serves a small installable PWA at `http://127.0.0.1:<port>/ui/` —
population browsing, conversations with message submission, active jobs with
live events and cancellation, immutable approvals, and bounded,
sha256-verified artifact downloads.
It is a projection of the same interaction APIs every adapter uses (`/v1`
semantics, deny-by-default principals); the browser never reads population,
session, job, or Agent Space files, and browser storage holds no tokens and
no daemon state.

Browser access is a local pairing ceremony, mirroring principal enrollment:

```bash
agent-bot principal enroll --label "operator phone"      # once
agent-bot principal allow <principal-id> --soul <agent-id> \
  --operation observe --operation message --operation cancel --operation approve
agent-bot web open --principal <principal-id>
```

`web open` asks the running daemon (authenticated with the bearer token from
the `0600` state file) to mint a one-time pairing code and prints/opens
`http://127.0.0.1:<port>/ui/#<code>`. The page exchanges the code — single
use, ~2 minute expiry — for a short-lived (~12 h) `HttpOnly` /
`SameSite=Strict` cookie session held daemon-side in memory. The daemon's
bearer token is never copied into JavaScript-accessible storage. State-
changing UI requests additionally require the `X-Agent-Bot-UI` header and a
same-origin `Origin` check, static assets ship a `'self'`-only
Content-Security-Policy with no inline script, and the service worker caches
only the offline shell — never API responses. Privileged work is approved
only through immutable proposals: the UI posts back the exact sha256 digest
of the proposed operation's canonical JSON, and a mismatched, expired, or
already-consumed proposal is refused; a conversational "yes" has no pathway
to authorize anything.

#### Remote access (explicit operator choice)

The daemon binds to loopback, full stop — `/ui` does not change that, and a
non-loopback bind is refused before the listener opens. To reach the web
client from another device, put a private-network ingress you already trust
in front of the loopback port and treat it as the transport that
authenticates the remote identity, for example with Tailscale on the daemon
machine:

```bash
tailscale serve --https=443 http://127.0.0.1:<port>
```

The tailnet (or an equivalently reviewed reverse proxy with its own
authentication) decides who reaches the port; the daemon still only ever
sees a local peer, and the browser still has to pair: run `agent-bot web
open --no-browser` on the daemon machine and open the printed link from the
remote device, substituting the proxy host for `127.0.0.1`. Authorization
stays with the local principal model — the proxy translates a remote
identity into possession of an owner-minted pairing code for one enrolled
principal, and there is no Tailscale API coupling in the runtime. Never
expose the port with an unauthenticated LAN listener or a public reverse
proxy; the pairing code is a capability, not a substitute for the private
network's own authentication.

The repository also ships an official progressive-disclosure skill at
`skills/agent-bot`. Its main `SKILL.md` routes setup, verified publishing, and
execution-provenance requests into focused references while all executable
behavior remains in this zero-dependency runtime.

## How it works

```
git worktree add …            (run by ANY tool: Codex, Cursor, VS Code, Claude Code)
 └─ post-checkout hook        (git-native; installed once via core.hooksPath)
     └─ setup-worktree.mjs    detects the harness from its env markers,
                              maps it to your bot via ~/.config/agent-bot/config.json,
                              then — scoped to that worktree only —
                              sets bot author/committer, disables signing,
                              forces HTTPS remote, wires an on-demand
                              credential helper, pins core.hooksPath here
                              (chaining any previous hooks), and mints a
                              transcript-bound Agent ID
         └─ git push          asks the helper → mints a fresh 1-hour
                              installation token → authenticates as the bot
         └─ gh …              (with the shim) mints the same way automatically
```

**Territory.** Paths under `.<tool>/worktrees/**` at *any* filesystem root are
bot territory (not only under `$HOME`). Primary checkouts and bare human shells
are never touched. No config file → the whole thing is inert.

**Identity resolution** (same order for commits and tokens):

1. `--app <slug>` / explicit argument
2. `GH_AGENT_APP`
3. `git config agentBot.app` (pin; also reads `qwts.agentApp` for compatibility)
4. harness auto-detection mapped through `config.json`

An unverifiable pin fails closed — it never falls through to harness detection.

## Setup

### Bootstrap details

The cold-start route above is the supported source-to-installed handoff. Once
the GitHub Apps and their escrowed credentials exist, the source launcher can
perform the whole runtime setup without an already-installed CLI or an npm
command:

```bash
./agent-bot bootstrap --profile /path/to/organization-profile.json --with-gh-shim
```

The bootstrap installs the stable CLI and hooks, refuses a conflicting existing
config, reconciles every active App resolved by the profile through `pass-cli`, and
live-verifies every App before it installs the optional managed `gh` shim or
configures a linked worktree. A local failure is reported for every affected
App before any live mint is attempted; a revoked or mismatched App ID/private
key fails during the live phase. It finishes by collecting the same readiness
report as `doctor` and never interposes a system or Homebrew `gh`; that remains
a separate explicit operation.

Use `--machine-only` from a primary checkout when preparing the machine without
binding a worktree. Use `--worktree-only` later from a linked worktree to run
only identity setup and verification. The latter requires the machine install
to point at the same source checkout and rejects machine-setup options rather
than silently ignoring them.

`doctor` is always read-only and continues to reject `--repair`. Bootstrap is
the explicit repair boundary: it performs only the documented idempotent setup
operations, stops after the first failed mutation phase, and reports later live
verification as skipped. A full bootstrap requires a linked worktree; use
`--machine-only` deliberately from a primary checkout.

The numbered sections below document standalone operator provisioning and the
runtime's underlying components. They are not a substitute for an
organization-owned profile, roster, or shared-tooling workflow.

### 1. Create a GitHub App per agent tool you use (~5 min each)

GitHub → Settings → Developer settings → GitHub Apps → **New GitHub App**
(on an org account: the org's Settings → Developer settings):

- **Name:** e.g. `you-claude-agent` — this becomes the `[bot]` author name;
  App names are globally unique. Optionally create model-level Apps too
  (`you-claude-sonnet-agent`, `you-codex-sol-agent`, …) and pin them per worktree.
- **Homepage URL:** anything real. **Webhook:** uncheck *Active*.
- **Repository permissions:** Contents *Read and write*; Pull requests
  *Read and write*; Issues *Read and write*. Nothing else.
- **Identifying and authorizing users / Post installation:** leave everything
  blank and unchecked — user-to-server OAuth would attribute actions to *you*,
  which defeats the purpose. Never generate a client secret.
- After creating: note the **App ID**, **generate a private key**, then
  **Install App** on your account/org → *Only select repositories* → the repos
  agents work in.

### 2. Store each App's credentials

```bash
mkdir -p ~/.config/you-claude-agent
echo '<app id>' > ~/.config/you-claude-agent/app-id
mv ~/Downloads/you-claude-agent.*.pem ~/.config/you-claude-agent/private-key.pem
chmod 600 ~/.config/you-claude-agent/private-key.pem
```

Keep an escrow copy of each key in your password manager; the files here are
disposable runtime copies.

`app-id` may hold either the numeric **App ID** or the **client ID** — GitHub
accepts both as the JWT issuer and now recommends the latter. Note that neither
is recoverable from the REST API afterwards: `/apps/{slug}` and every `/app/*`
route require a JWT you cannot build without this value, and
`/user/installations` needs a GitHub App user-to-server token, which a `gh`
OAuth token is not. Read it off the App's settings page once and keep it
somewhere durable.

With **pass-cli** (Proton Pass) both halves can be restored instead of copied by
hand. Store the key as a `private-key.pem` attachment on an item titled with the
App slug, in a vault named `Agent Identities`, and put the issuer on the same
item in whichever form your vault session allows — an `app-id` / `client-id`
custom field, an `app-id: <value>` line in the note, or a plain-text `app-id`
attachment. Fields are checked first and cost nothing extra; the attachment is
downloaded only when no field or note carries the value, and its contents are
validated before use. An agent token with read-only item access can still add an
attachment, which is why all three are accepted:

```bash
agent-bot ensure-private-key --app you-claude-agent
```

One `item view` provisions whichever of the two files is missing or malformed,
so a fresh machine needs no manual copying. Restored files are staged,
validated, and atomically installed with private permissions; valid existing
files are preserved without contacting the provider. `setup-worktree` performs
the same reconciliation and a live mint before changing the remote, resolving
the bot UID, or writing worktree identity. Missing, ambiguous, malformed,
revoked, or mismatched credentials therefore fail closed with the App slug and
operator action instead of leaving a partially configured worktree.

### 3. Write the config

`~/.config/agent-bot/config.json`:

```json
{ "prefix": "you" }
```

`"you"` is a placeholder — the prefix must reproduce how *you named your
Apps* in step 1: it maps detected harnesses to `<prefix>-claude-agent`,
`<prefix>-codex-agent`, and so on. If your App names don't follow that pattern,
use the `apps` map with the exact slugs instead. `doctor` prints the resolved
`harness -> slug` table so you can compare. Options:

```json
{
  "prefix": "you",
  "apps": { "claude": "some-custom-name" },
  "owner": "your-org",
  "apiBase": "https://ghe.example.com/api/v3",
  "settings": {
    "spacesRoot": "/absolute/path/to/agent-bot/spaces",
    "daemonPreference": "off"
  }
}
```

- `apps` — per-harness overrides of the prefix pattern.
- `owner` — required when an App is installed on more than one account.
- `apiBase` — GitHub Enterprise Server / data-residency hosts.
- `settings.spacesRoot` — an absolute, durable Agent Space root.
- `settings.daemonPreference` — `off`, `prefer`, or `required`; the default is
  `off`.

Settings precedence is environment override, then user setting, then default.
`AGENT_BOT_SPACES_HOME` overrides `settings.spacesRoot`; without either, the
root is `~/.agent-space`. `XDG_DATA_HOME` is not a resolution input — it only
names the legacy tree for the one-time cutover that `install`, `update`, and
`bootstrap` run when that tree holds spaces and `~/.agent-space` does not.
`AGENT_BOT_DAEMON_PREFERENCE` overrides
`settings.daemonPreference`. The modes select client fallback: direct-only
(`off`), daemon-with-local-fallback (`prefer`), and daemon-only (`required`).
`setup-worktree` already enforces all three. The supervisor is installed
regardless of preference; preference does not start or stop the daemon.

This config is policy, not a secret store: never put tokens, credentials, or
private keys in it. Agent Space lifetime and path ownership remain defined by
[ENG-0172](https://github.com/qwts/playbook-engineering/blob/main/docs/decisions/ENG-0172-agent-space-is-durable-per-soul-storage.md).

#### Agent Space export packs, gist handoff, and retirement

`agent-bot space export [agent-id]` writes the soul's space as a single
secret-free pack: one deterministic JSON document whose manifest records the
Agent ID, pack schema version, creation time, and a content hash over the
entries (no external archiver, zero dependencies). Export fails closed when a
known secret filename (private keys, `*.pem`, `*token*`, `.netrc`, `.env`,
credential files, …) is present anywhere in the space; the only removals are
the documented regenerable-cache exclusions (for example the
`.agent-bot-token.json` worktree-token cache), which are reported on stderr
rather than dropped silently. `agent-bot space import <pack> [--force]`
validates the manifest hash and the embedded space marker before restoring
atomically into the spaces root, and refuses to clobber an existing space
without `--force`.

`agent-bot space export <agent-id> --gist` is an opt-in suitcase transport: it
uploads the same secret-free pack as a *secret* gist through the bound App's
token-minting path (the slug is resolved territory-aware, exactly like
`setup-worktree` and `worktree-token`), then records only the pointer
`gist:<id>` in the space marker — never pack contents.
`agent-bot space import gist:<id>` (or a gist URL) downloads and restores it.
A mint failure or missing gist access fails closed with the App permission
named. The App needs the account-level Gists permission, and organization
policy may forbid unsanctioned gists entirely — nothing uses this transport
unless you ask for it.

`agent-bot space retire <agent-id>` is the explicit end of a soul's local
lifecycle: it marks the soul `retired` in the authoritative identity record
*and* the population census (under the shared lifecycle lock), and by
default keeps the space directory on disk as a tombstone. `--delete-space`
removes the directory, and only when its marker is present and bound to
that id. Retirement is permanent for that identity: a worktree still pinned
to a retired Agent ID fails setup closed with instructions to unpin or
start fresh, a retired census record refuses to be overwritten, and a
retired identity cannot be finalized — so re-running `setup-worktree` can
never resurrect the soul or recreate a deleted space. Retirement never runs
implicitly — identity finalize and worktree teardown do not call it — and
`population list` shows retired souls in a separate `RETIRED` section.

### 4. Install the hooks (and optionally the gh shim)

```bash
node install.mjs
# or, hooks + automatic GH_TOKEN for gh:
node install.mjs --with-gh-shim
```

After the first install, refresh the machine-wide CLI and Git hook wrappers
from the current agent-bot checkout with:

```bash
agent-bot update
```

The installer symlinks the CLI into `~/.local/bin`, installs the no-op fast path
at `~/.local/share/agent-bot/agent-hook`, installs stable Git hook dispatchers
under `~/.local/share/agent-bot/hooks`, and points global `core.hooksPath`
there. The fast path starts Node only when the current repository has an
executable hook for the event. A displaced non-agent hooks path is recorded in
`agentBot.chainedHooksPath`, so repository and Husky hooks keep running.
Re-running the installer is idempotent and foreign files are never replaced.
The installed CLI points at a portable shell launcher in this checkout. It
uses `AGENT_BOT_NODE` when set, then searches PATH, nvm, and common version
manager and system locations. This lets GUI-launched Git hooks find Node
without sourcing a user shell; the selected Node directory is exported for
child hooks such as `post-checkout`.
PATH is registered in two files because zsh reads them in different situations.
`.zshenv` is read by *every* zsh, including the non-login, non-interactive
shells a harness spawns for its startup scripts — so both `~/.local/bin` and the
gh shim directory are registered there. `.zprofile` is read by login shells only
and is appended after existing setup such as Homebrew, which is what makes our
directories resolve first in a normal session. Both are needed: without
`.zshenv` a harness cannot find `agent-bot` at all; without `.zprofile` a login
shell finds Homebrew's `gh` first.

Shells other than zsh get no registration. The identity scripts fall back to
`~/.local/bin/agent-bot` directly for that case, and `agent-bot doctor` probes a
non-login shell so a missing registration is reported rather than assumed.

#### Codex desktop Pull Requests UI

The normal gh-shim install covers agent shells but does not necessarily cover
GitHub commands launched directly by the Codex desktop app. Codex currently
resolves a `gh` executable from its own host PATH for the built-in Pull Requests
and environment UI. That executable can be explicitly and reversibly
interposed:

```bash
# First identify the system gh selected by the desktop host. Common macOS paths:
type -a gh
agent-bot install-gh-shim --codex-desktop-gh /opt/homebrew/bin/gh

# Restore the exact executable or symlink that was preserved during install:
agent-bot install-gh-shim --restore-codex-desktop-gh /opt/homebrew/bin/gh
```

The explicit install moves the selected `gh` to an adjacent
`gh.agent-bot-real` backup and replaces only that path with a symlink to the
managed shim. A valid legacy `gh.bak` is migrated to that canonical name;
shim-to-shim backups, missing originals, relative paths, and unrecoverable
restores fail closed. Re-running the explicit install repairs a Homebrew
upgrade or relink by preserving the new stock executable and restoring the
interposer. The ordinary
`agent-bot install-gh-shim` command never modifies a system or Homebrew path.
The explicitly selected path is recorded without credentials so
`agent-bot doctor` can report shell-shim readiness separately from missing,
replaced, recursive, legacy, or unrecoverable Codex-desktop coverage.

When a direct Codex desktop call is detected, the shim mints the configured
Codex App token and adapts only the observed native request shapes:

- REST `/user` falls back to the App's real `<slug>[bot]` user object because
  installation tokens cannot use the authenticated-user endpoint.
- Pull Request inbox searches replace only the `author:@me`, `reviewed-by:@me`,
  or `review-requested:@me` identity predicate with repeated `repo:` qualifiers
  discovered from the App installation. The secret-free repository list is
  cached privately for ten minutes; native PR/state/sort filters remain, but
  these three broadened lanes can overlap.
- The exact branch PR lookup drops only `--author @me`, retaining its head
  branch and repository constraints so PRs created by another agent App appear.
- PR detail JSON fills missing App avatars from the exact App profile cached by
  `setup-worktree`, or from a numeric local App ID, without adding a network
  request to Codex's five-second detail deadline.

Everything else passes through to the preserved `gh`. This affects only local
desktop CLI traffic; it does not replace or reconfigure the ChatGPT GitHub
connector and has no effect on Codex cloud. The native request shapes and
desktop parent-process detection are observed implementation details, not a
documented Codex extension API, so this compatibility mode is deliberately
labelled experimental and may need adjustment after a desktop update. The
branch PR row remains branch-scoped; this adapter does not turn it into a
repository-wide PR list.

### 5. Verify

```bash
agent-bot doctor
```

Or smoke-test a worktree from an agent session:

```bash
git worktree add ../t -b test-identity && git -C ../t config --worktree user.name
```

From inside an agent session that prints `you-<harness>-agent[bot]`; from a
bare shell it prints nothing (human worktree). Clean up with
`git worktree remove ../t && git branch -D test-identity`.

## Day-to-day: gh and PRs

With the **gh shim** installed (`agent-bot install-gh-shim`), there is no
per-task step: inside bot territory `gh` mints and exports `GH_TOKEN` on its
own. Outside territory, agent processes are refused (fail closed); human shells
passthrough to stock `gh`.

Without the shim, mint before `gh pr create`:

```bash
GH_TOKEN=$(agent-bot mint-token) || exit 1
export GH_TOKEN
```

Two steps on purpose: `export GH_TOKEN=$(…)` returns `export`'s own exit
status even when the mint fails, and `gh` treats an empty `GH_TOKEN` as
absent — silently falling back to *your* login. A failed mint must abort,
never continue as the human.

## Pinning an identity

Detection can be overridden, first match wins: `--app <slug>` on any tool,
`GH_AGENT_APP` in the environment, or `git config agentBot.app <slug>` to pin
a checkout to one compatible identity (e.g. a model-level App for that
harness). Setup persists the resolved App as the worktree pin so later token
minters cannot disagree with commit authorship.

**Worktree territory is authoritative.** A checkout under
`.<tool>/worktrees/**` belongs to that tool: `.codex/worktrees/**` always uses
a Codex App, and likewise for Claude, Cursor, and VS Code. A pin for another
harness is corrupt metadata. Startup repairs it, its author/helper settings,
and its execution identity; an explicit cross-harness `setup-worktree` request
is rejected.

## Claude Code worktrees

Claude Code often creates worktrees from a sandbox that cannot write the shared
git dir — so git's `post-checkout` may not land the identity. Wire Claude's
`WorktreeCreate` hook to the installed CLI (user or project settings):

```json
{
  "hooks": {
    "WorktreeCreate": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "agent-bot claude-worktree-create"
          }
        ]
      }
    ]
  }
}
```

The wrapper finds Node even when nvm is not on the desktop app's PATH.

## Codex / harness startup

Sandboxed harnesses can miss identity at worktree creation. Run the stable
setup command from the harness startup hook:

```bash
agent-bot setup-worktree
```

The checked-in `scripts/ensure-identity.sh` adds verification of the pin,
author, credential helper, and execution-identity hooks. `AGENT_BOT_HOME` is
only a fallback for harnesses whose startup environment cannot find the
installed executable.

All harness lifecycle adapters are generated from `hook-dialects.mjs`:

```bash
npm run sync:hooks       # refresh checked-in adapters
node sync-hooks.mjs --check
```

The adapters call one vendor-neutral runner. Claude's adapter also serves Devin
CLI; Codex, Cursor, Copilot, and Devin Desktop receive their native JSON shape.
The Git `pre-commit` and `pre-push` hooks provide the common backstop for
harnesses or cloud surfaces that do not expose every lifecycle event.

## Execution identities (Agent IDs)

Each bot worktree gets a private `agent_<uuid>` stored under
`~/.local/state/agent-bot/agent-identities/` (override with
`AGENT_BOT_STATE_HOME`). Records name the credential provider; they never
contain secrets.

- `prepare-commit-msg` appends `Agent-Identity: <id>`
- `post-commit` records `commit:<sha>` against the identity
- `pre-commit` refuses bot-attributed commits with no resolvable Agent ID

```bash
agent-bot identity current
agent-bot identity show <agent-id>
agent-bot identity ensure --reuse-pending
```

Transcript binding: Codex uses `CODEX_THREAD_ID`; Claude's WorktreeCreate hook
passes the session id; other launchers set `AGENT_BOT_TRANSCRIPT_PROVIDER` and
`AGENT_BOT_TRANSCRIPT_ID` (the `QWTS_AGENT_*` names still work).

## Telegram adapter (remote messaging)

`agent-bot telegram run` long-polls the Telegram Bot API and projects the
daemon's `/v1` interaction contract into a chat: it is a thin transport, not
an agent runtime. The local daemon must be running (`agent-bot daemon
start`); there is no in-process fallback.

Command grammar inside the chat: `/souls` lists the souls your principal may
message, `/use <agent-id>` selects one for the chat, plain text submits a
message to the selected (or default) soul, `/status` reports the active
invocation, `/cancel` cancels it. Progress is projected by editing one
bounded status message; the daemon's event log stays the record, so restarting
the adapter — or Telegram losing every message — loses no canonical state.

**Enrollment (owner-only, local CLI).** Telegram accounts are authenticated
by their immutable numeric user ID only; usernames, display names, and
forwarded metadata grant nothing. Send `/start` to your bot from the account,
read the refused sender's numeric ID with
[@userinfobot](https://t.me/userinfobot) or from the Bot API, then:

```bash
agent-bot principal enroll --label "me on telegram"
agent-bot principal bind <principal-id> --transport telegram --provider-id <numeric-user-id>
agent-bot principal allow <principal-id> --soul <agent-id> \
  --operation message --operation observe --operation cancel \
  --default-soul <agent-id>
```

**Token provisioning (reviewed paths only).** The bot token comes from
`AGENT_BOT_TELEGRAM_TOKEN` or from the secure-store flow via user config:

```json
{ "settings": { "telegram": { "tokenSecret": {
  "provider": "proton-pass", "collection": "Agents",
  "item": "telegram-bot", "field": "token" } } } }
```

The token is never read from repository config and never written to state
files, population or principal records, Agent Space, logs, events, or error
messages (a redaction guard strips it from every error the adapter emits).

**Policy defaults.** Direct messages only: group, supergroup, and channel
updates are ignored unless the owner opts in with
`AGENT_BOT_TELEGRAM_ALLOW_GROUPS=1` or `settings.telegram.allowGroups: true`
(a reviewed policy decision). Attachments are refused in v1 with a static
message — Telegram-supplied file names are never interpreted as paths; a
staged, scanned ingress area is planned follow-up work. Messages are bounded
to the daemon's message cap.

**Trust and privacy limits.** Telegram (the provider) can read every bot
message, so nothing canonical lives there: no secrets, no raw private
repository archives, no authoritative memory. The adapter keeps only a small
restart-safe projection file (`$XDG_STATE_HOME/agent-bot/telegram/state.json`,
override `AGENT_BOT_TELEGRAM_STATE_PATH`) holding the update offset,
per-chat soul selections, and session/invocation references — chat IDs map to
daemon sessions, never the other way round. Duplicate or replayed updates are
absorbed by deterministic idempotency keys (`telegram:<update_id>`), so one
update can never create two invocations.

## Enterprise notes

- **Org-owned Apps work identically** — create them under the org's developer
  settings; set `owner` in the config.
- **App installation tokens are exempt from SAML/SSO enforcement** — unlike
  PATs, no per-org authorization dance.
- **EMU / managed accounts live on github.com** — do *not* set `apiBase` for
  them; it is only for GHE Server / data-residency hosts, where commit
  noreply emails also follow the host.
- **Externally invisible Apps are handled**: the bot-UID lookup retries
  authenticated as the App itself when the anonymous lookup 404s.

## Debugging

```bash
agent-bot doctor
agent-bot doctor --json --require-schema-version 1
```

The diagnostic reports Node and Git, the managed CLI and harness PATH, config,
every configured App credential and live mint, hooks, optional gh shim, the
runtime-owned skill, and current worktree identity. Machine and worktree status
are separate; a primary checkout is `not_applicable`, not silently converted to
bot territory. Human output prints one action for the earliest failure, while
JSON retains secret-free status for every check and App.

## Failure modes

- `no app config for "<slug>"` — step 2 missing for that App.
- Mint `401` mentioning the JWT — app-id and key mismatch, or key revoked.
- `could not pick an installation` / multi-account — set `owner` or
  `GH_APP_INSTALLATION_ID`.
- Push rejected with the token set — the repo isn't in that App's
  installation list.
- A `gh` call acts as you — shim not on PATH, or `GH_TOKEN` unset/expired
  without the shim.
- Wrong `[bot]` authored a PR — a stray `GH_AGENT_APP` or `agentBot.app`
  override outranks detection.
- `unverifiable pin` — git could not read `agentBot.app`; fix the config,
  do not unset and hope detection is "close enough".

## Development

```bash
npm test
```

Zero dependencies; Node's built-in test runner only.

## Deprecated migration aliases

New writes use `agentBot.app`, `agentBot.agentId`,
`agentBot.chainedHooksPath`, and `AGENT_BOT_*`. Compatibility reads remain for
`qwts.*`, `QWTS_AGENT_*`, `PLAYBOOK_HOME`, and
`~/.config/agent-bot/playbook-home` so existing worktrees and harness startup
configuration migrate safely. These aliases remain throughout `0.x` and are
scheduled for removal in `1.0`; no new configuration should write them.

## License

MIT
