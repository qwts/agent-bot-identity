# agent-bot-identity

Give every coding agent on your machine its **own GitHub identity** — so a
worktree created by Codex commits and opens PRs as `you-codex-agent[bot]`, one
created by Claude Code as `you-claude-agent[bot]`, and so on, while your own
shell stays *you*. Zero dependencies, no daemon, no per-tool plugins: the
trigger is git's native `post-checkout` hook, and the identity is detected
from the environment each IDE already sets on its own.

Why you'd want this:

- **You can approve your agents' PRs.** GitHub forbids approving your own PR;
  when agents author as you, review-gated merges are impossible on a solo
  account. Bot authorship gives you a real Approve button.
- **Authorship tells you which tool wrote what** — machine-queryable
  (`author:you-codex-agent[bot]`), immutable, audit-friendly.
- **Per-tool blast radius.** Each App has its own key and repo list; revoke or
  narrow one agent without touching the others.

## How it works

```
git worktree add …            (run by ANY tool: Codex, Cursor, VS Code, Claude Code)
 └─ post-checkout hook        (git-native; installed once via core.hooksPath)
     └─ setup-worktree.mjs    detects the harness from its env markers,
                              maps it to your bot via ~/.config/agent-bot/config.json,
                              then — scoped to that worktree only —
                              sets bot author/committer, disables signing,
                              forces HTTPS remote, and wires an on-demand
                              credential helper
         └─ git push          asks the helper → mints a fresh 1-hour
                              installation token → authenticates as the bot
```

Primary checkouts and bare human shells are never touched: the setup only
applies to *linked worktrees* where a harness is detected (or explicitly
configured). No config file → the whole thing is inert.

## Setup

### 1. Create a GitHub App per agent tool you use (~5 min each)

GitHub → Settings → Developer settings → GitHub Apps → **New GitHub App**
(on an org account: the org's Settings → Developer settings):

- **Name:** e.g. `you-claude-agent` — this becomes the `[bot]` author name;
  App names are globally unique.
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

That maps detected harnesses to `you-claude-agent`, `you-codex-agent`,
`you-cursor-agent`, `you-vscode-agent`. Options:

```json
{
  "prefix": "you",
  "apps": { "claude": "some-custom-name" },
  "owner": "your-org",
  "apiBase": "https://ghe.example.com/api/v3"
}
```

- `apps` — per-harness overrides of the prefix pattern.
- `owner` — required when an App is installed on more than one account:
  picks the installation by account login.
- `apiBase` — GitHub Enterprise Server / data-residency hosts.

### 4. Install the hook

```bash
node install.mjs
```

Sets `git config --global core.hooksPath` to this clone's `hooks/`. It
refuses to clobber an existing hooksPath and the hook chains to any
repo-local `post-checkout`, so nothing already on the machine breaks.

### 5. Verify

```bash
git worktree add ../t -b test-identity && git -C ../t config --worktree user.name
```

From inside an agent session that prints `you-<harness>-agent[bot]`; from a
bare shell it prints nothing (human worktree). Clean up with
`git worktree remove ../t && git branch -D test-identity`.

## The one manual step per task: PR creation

`gh` does not use git's credential helper — it uses its own stored login. So
pushes are automatic, but before `gh pr create` an agent must mint:

```bash
GH_TOKEN=$(node <this-repo>/src/mint-token.mjs) || exit 1
export GH_TOKEN
```

Two steps on purpose: `export GH_TOKEN=$(…)` returns `export`'s own exit
status even when the mint fails, and `gh` treats an empty `GH_TOKEN` as
absent — silently falling back to *your* login. A failed mint must abort,
never continue as the human.

## Forcing or pinning an identity

Detection can be overridden, first match wins: `--app <slug>` on any tool,
`GH_AGENT_APP` in the environment, or `git config agentBot.app <slug>` to pin
a checkout to one identity regardless of which tool opens it.

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
- **EMU / restricted orgs:** App creation or installation may need an org
  owner's approval (or be policy-blocked). Clear that first.

## Debugging

One command diagnoses the whole chain — runtime, hook installation, config,
live mints for every configured App, and the current worktree's state — with
a fix hint on every failing line:

```bash
node src/doctor.mjs
```

Run it from inside the misbehaving worktree for the repo checks to apply.

## Failure modes

- `no app config for "<slug>"` — step 2 missing for that App.
- Mint `401` mentioning the JWT — app-id and key mismatch, or key revoked.
- `could not pick an installation` — App installed on several accounts; set
  `owner` or `GH_APP_INSTALLATION_ID`.
- Push rejected with the token set — the repo isn't in that App's
  installation list.
- A `gh` call acts as you — `GH_TOKEN` unset in that shell, or expired (1 h).
- Wrong `[bot]` authored a PR — a stray `GH_AGENT_APP` or `agentBot.app`
  override outranks detection; check those before blaming detection.

## License

MIT
