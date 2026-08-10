# agent-bot-identity

Give every coding agent on your machine its **own GitHub identity** — so a
worktree created by Codex commits and opens PRs as `you-codex-agent[bot]`, one
created by Claude Code as `you-claude-agent[bot]`, and so on, while your own
shell stays *you*. Zero dependencies, no daemon, no per-tool plugins: the
trigger is git's native hooks, and the identity is detected from the
environment each IDE already sets on its own.

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

This repository is the sole runtime owner of the agent-bot and
transcript-bound execution identity system. Clone and install it directly;
`playbook-engineering` is a governance consumer, not a runtime provider.

## Stable CLI

Installation provides one executable at `~/.local/bin/agent-bot`:

```bash
agent-bot bootstrap [--config <path>] [--app <slug>] [--with-gh-shim]
agent-bot --version
agent-bot setup-worktree [app-slug]
agent-bot mint-token --app <slug> [--json]
agent-bot doctor
agent-bot identity <ensure|spawn|bind|record|finalize|show|current>
agent-bot space <init|ensure|path|show> [agent-id]
agent-bot population <list|show> [agent-id] [--json]
agent-bot install [--with-gh-shim]
agent-bot install-gh-shim
agent-bot ensure-private-key --app <slug> [--force]
agent-bot signed-commit [--base <ref>] [--branch <name>] [--repo <owner/name>] [--dry-run]
agent-bot secret get --provider <id> --collection <name> --item <title> --field <name> --reason <text>
```

`mint-token --json` writes one secret-bearing object to stdout:

```json
{"schema_version":1,"token":"<installation token>","expires_at":"<ISO timestamp>","installation_id":123}
```

Treat that stdout as a credential. Errors, diagnostics, identity records, and
logs never contain tokens, JWTs, or private keys.

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
```

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

### Bootstrap from a source checkout

Once the GitHub Apps and their escrowed credentials exist, the source launcher
can perform the whole machine setup without an already-installed CLI or an npm
command:

```bash
./agent-bot bootstrap --config /path/to/config.json --with-gh-shim
```

The bootstrap installs the stable CLI and hooks, refuses a conflicting existing
config, reconciles every App resolved by the config through `pass-cli`, and
live-verifies every App before it installs the optional managed `gh` shim or
configures a linked worktree. A local failure is reported for every affected
App before any live mint is attempted; a revoked or mismatched App ID/private
key fails during the live phase. It finishes with `doctor` and never interposes
a system or Homebrew `gh`; that remains a separate explicit operation.

Use `--machine-only` from a primary checkout when preparing the machine without
binding a worktree. Use `--worktree-only` later from a linked worktree to run
only identity setup and verification. The latter requires the machine install
to point at the same source checkout and rejects machine-setup options rather
than silently ignoring them.

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
root follows the XDG data default. `AGENT_BOT_DAEMON_PREFERENCE` overrides
`settings.daemonPreference`. The modes reserve direct-only (`off`),
daemon-with-local-fallback (`prefer`), and daemon-only (`required`) policy.
They are stored and validated now, but no mode changes execution until the
daemon and integration work in
[#41](https://github.com/qwts/agent-bot-identity/issues/41) and
[#43](https://github.com/qwts/agent-bot-identity/issues/43) ships; in particular,
`required` is not enforced yet.

This config is policy, not a secret store: never put tokens, credentials, or
private keys in it. Agent Space lifetime and path ownership remain defined by
[ENG-0172](https://github.com/qwts/playbook-engineering/blob/main/docs/decisions/ENG-0172-agent-space-is-durable-per-soul-storage.md).

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

#### Experimental Codex desktop Pull Requests UI

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
managed shim. It refuses existing backups, foreign replacements, missing
originals, relative paths, and unrecoverable restores. The ordinary
`agent-bot install-gh-shim` command never modifies a system or Homebrew path.
Because a package-manager upgrade may replace either link, verify the selected
`gh` path after upgrading GitHub CLI and restore or reinstall the interposer if
needed.

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
```

One command diagnoses runtime, hooks, gh shim, config, live mints, and the
current worktree (including Agent ID). Run it from inside the misbehaving
worktree for the repo checks to apply.

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
