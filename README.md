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
agent-bot --version
agent-bot setup-worktree [app-slug]
agent-bot mint-token --app <slug> [--json]
agent-bot doctor
agent-bot identity <ensure|spawn|bind|record|finalize|show|current>
agent-bot install [--with-gh-shim]
agent-bot install-gh-shim
agent-bot ensure-private-key --app <slug> [--force]
```

`mint-token --json` writes one secret-bearing object to stdout:

```json
{"schema_version":1,"token":"<installation token>","expires_at":"<ISO timestamp>","installation_id":123}
```

Treat that stdout as a credential. Errors, diagnostics, identity records, and
logs never contain tokens, JWTs, or private keys.

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
  "apiBase": "https://ghe.example.com/api/v3"
}
```

- `apps` — per-harness overrides of the prefix pattern.
- `owner` — required when an App is installed on more than one account.
- `apiBase` — GitHub Enterprise Server / data-residency hosts.

### 4. Install the hooks (and optionally the gh shim)

```bash
node install.mjs
# or, hooks + automatic GH_TOKEN for gh:
node install.mjs --with-gh-shim
```

The installer symlinks the CLI into `~/.local/bin`, installs stable hook
dispatchers under `~/.local/share/agent-bot/hooks`, and points global
`core.hooksPath` there. A displaced non-agent hooks path is recorded in
`agentBot.chainedHooksPath`, so repository and Husky hooks keep running.
Re-running the installer is idempotent and foreign files are never replaced.
The installer registers `~/.local/bin` at the end of `.zprofile`, after existing
shell setup such as Homebrew has run. It removes only legacy agent-bot-managed
PATH lines from `.zshenv`; unrelated shell configuration is left untouched.

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
