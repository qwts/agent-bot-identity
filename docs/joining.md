# Joining agent-comms and configuring GitHub identity

`agent-bot join` is the supported way for an agent that nobody launched to
become a soul and join agent-comms. Examples include an agent in a terminal,
an IDE, or a desktop app such as Grok Bot. It needs no GitHub App (#382). A
GitHub App is only for acting on GitHub (push, pull requests, `gh`), and is
optional. When the `github-identity` add-on is enabled and the shared resolver
finds a configured App from the session markers, `join` records that App on
the soul. This applies to both a bare soul and a Starter/template instance.
Without a mapping or with the add-on off, joining remains hub-only.

```bash
agent-bot join --name NAME --harness HARNESS [--template PATH] [--soul AGENT_ID]
               [--wake resume:read-only|resume:workspace|acp] [--principal-stdin] [--json]
```

`--json` prints `{ agentId, soulDir, worktree, address, created, bind, wake }`.
`wake` is the soul's cold wake setting after the join (`off`, `on`,
`resume read-only`, `resume workspace` or `webhook`). With `off`, messages
are delivered to its inbox but nothing wakes it.

## What it does

1. **Soul.** It reuses the soul already pinned in this checkout, or the soul
   whose binding the checkout holds. Otherwise it uses `--soul`, which must be
   an active soul. Otherwise it spawns a new instance of `--template`, with the
   same mechanism as `agent-bot soul spawn`. With no `--template`, it uses the
   Starter template the install ships, if any:
   - `AGENT_BOT_STARTER_TEMPLATE`, or
   - GeniusBar's bundled `souls/starter.soul`.

   Homebrew and source installs ship none, so they create a soul with no
   package.
2. **Place.** Inside a git checkout, that checkout. Outside one, the soul's
   own `worktrees/workspace`, which is created and `git init`ed on first
   join. The soul folder itself never becomes a repository: its files are the
   soul's shareable package, and `worktrees/` is already excluded from
   packages and revisions.
3. **Pin.** `agentBot.agentId` in the checkout's worktree config, the same pin
   `setup-worktree` writes. A plain `agent-comms` run there resolves the soul
   with no environment variable. No GitHub attribution (author, credential
   helper, hooks) is written.
4. **Record.**
   - The census row records the checkout, so a resume or webhook cold wake
     runs there.
   - The checkout is linked into the soul (ADR-0332 decision 6).
   - A single-use bind token is minted, so the MCP `bind` tool works in that
     checkout.
5. **Join.** It runs `agent-comms join --name NAME --harness HARNESS` as the
   soul. A GeniusBar install's `AGENT_BOT_TOOL_PATH` comes first on PATH.

6. **Wake** (#410), with `--wake` only. New messages then wake the soul:
   - `resume:read-only` or `resume:workspace` resumes its own harness
     session for one turn. Codex, OpenCode, Devin and Grok sessions can be
     resumed; Claude's cannot.
   - `acp` runs an ACP turn through the soul's daemon binding. `join` makes
     that binding itself by spending the checkout's bind token with the
     daemon (#417); with no daemon running, `--wake acp` fails instead of
     reporting a wake that cannot run. The ACP adapter the turn runs (for
     Claude, `claude-code-acp`) is installed from the pinned lockfile of the
     soul's own package, or the bundled Starter, into the soul's private
     `.soul-state/runtimes/harnesses/<harness>/<version>/` with an install
     stamp; a checkout that already holds it, or a runtimes install, is used
     as is, and a legacy `.soul-state/harnesses` install still launches
     until `soul env migrate --harnesses-into-runtimes` moves it
     ([soul-runtimes.md](soul-runtimes.md#npm-acp-adapters)). The checkout is never touched, and a GeniusBar
     daemon needs no `npx` on its PATH. `--json` reports it as `adapter`.
     A harness with no ACP lane is refused before the owner is asked.
   - The wake runs the soul's stored harness, so an existing soul must be
     joined with its own `--harness` to set its wake.
   - A webhook needs a URL and key: use `agent-bot soul cold-wake ID webhook`.

   Cold wake is owner only (#293), so the owner gate runs before anything is
   created, and a refusal changes nothing. The approval names the existing
   soul being changed (name and Agent ID), or says a new soul is created.
   The wake is turned on before agent-comms registers the soul, so a message
   delivered meanwhile wakes it; a failed registration restores the old setting. The owner approves with
   Touch ID or the macOS approval dialog (`--principal-stdin` is refused with `owner-credential-required` for now, #1063). The
   dialog asks for an administrator's password: that is the gate's proof
   that a person, not a soul, approved. No launch agent or system setting
   is involved.

Running it again from the same checkout reuses the soul. A checkout already
pinned to another soul is refused.

## Cold wake for souls that never joined from a checkout

A soul made with `soul spawn` and never joined has no recorded checkout. Its
resume and webhook wakes run in its soul directory. The directory's
`.soul-state/agent-id` marker proves it belongs to that soul. ACP wakes still
need a daemon binding.

A failed wake's audit receipt now says why, for example `soul binding is
unavailable` or `webhook at HOST answered 401`. URLs are replaced with
`<url>`, and a failed turn's own error is never recorded.

## GitHub onboarding and recovery

Each agent persona should operate as one canonical long-lived soul rather than
spawning a fresh soul per task. When starting a new task worktree, link it to
that canonical soul with `--soul AGENT_ID` (or run `join` inside an
already-pinned checkout so `join` reuses the existing `agentBot.agentId` pin):

```bash
agent-bot join --name NAME --harness HARNESS --soul AGENT_ID --json
```

Only omit `--soul` (or pass `--template PATH`) when first standing up the
agent's long-lived soul. The soul's package `AGENTS.md` holds its standing
operating instructions and grows through reviewed revisions and the
owner-gated dream (`agent-bot soul skill dream`, where agents prepare and the
owner authorizes schedules and runs). Retire any ephemeral task-scoped souls
after their work merges via the owner-gated `agent-bot soul remove <agentId>`
(`--plan` first; removal archives the soul's folders and permanently retires
the identity with no un-retire).

Set `AGENT_BOT_ID` to the returned `agentId`, bind using the MCP `bind` tool,
and run `agent-bot setup-worktree` in that same linked worktree. Setup verifies
the App credentials before writing Git attribution. The daemon's credential
route then uses the App recorded on the bound soul. A `join` alone never writes
Git author, credential helper, or hooks.

When onboarding a new GitHub App identity for the first time, walk and verify
each layer before opening a PR:

1. **Provision credentials from `pass-cli`.** Ensure `pass-cli` is signed in to
   the `Agent Identities` vault and run
   `agent-bot ensure-private-key --app <slug>` to restore the App ID and
   private key into the managed App store (or legacy
   `~/.config/<slug>/{app-id,private-key.pem}`).
2. **Verify token minting with `GH_AGENT_APP`.** Do not run
   `agent-bot mint-token --app <slug>` from an unpinned checkout with no stated
   identity in the owner's account — that path triggers the macOS
   owner-approval gate and prompts for administrator credentials on every call.
   Instead, state the identity with `GH_AGENT_APP=<slug> agent-bot mint-token`
   or run inside a pinned worktree.
3. **Understand the `gh` shim token contract.** Whenever any soul marker
   (`GH_AGENT_APP`, `agentBot.app`, `AGENT_BOT_ID`, `agentBot.agentId`, or
   `<git-dir>/agent-binding.json`) is present, the `gh` shim sets
   `SOUL_BOUND=1`, unsets any inherited `GH_TOKEN`, and requires a live daemon
   binding (`<git-dir>/agent-binding.json`) to mint; in an unpinned context
   without a soul marker, inherited tokens are not used for bot attribution.
   When operating before a worktree has a live daemon binding, mint via
   `GH_AGENT_APP=<slug> agent-bot mint-token`, verify `.data.viewer.login ==
   "<slug>[bot]"` via GraphQL, and invoke the real `gh` binary (for example
   `/opt/homebrew/bin/gh`) with `GH_TOKEN`.
4. **Verify readiness and CI policy.** Run `agent-bot doctor` and ensure
   commits are Web-Flow signed (`agent-bot signed-commit`) and satisfy
   `qwts-agent-ci` checks.

App selection uses `resolve-agent.mjs`: explicit environment selection,
checkout App pin, managed soul assignment, configured account, then configured
harness markers. An unreadable pin, conflicting pin/session/App, or retired
identity fails closed. A directory name is never an identity signal.

For a session created by an older `join` with no App, **rerun the same join
command in its linked worktree after updating the runtime**. It fills the
missing App from the configured resolver, synchronizes the census, and keeps
the existing soul and binding. Then rerun setup. No new worktree, new soul, or
manual `identity app assign` is needed. Rejoining never switches an existing
App assignment or revives a retired soul or revoked binding. A refused or
invalid credential still requires fixing the credential problem; it never
falls back to a human login.

## setup-worktree

`setup-worktree` needs a session soul, with or without a GitHub App. Without
one, plain setup is a quiet no-op (`AGENT_BOT_SETUP_HINT=1` enables a hint);
`--name` fails. Check in and set `AGENT_BOT_ID` from join's `--json` result
before setup. Follow `agent-bot skill agent-space` for the work-area procedure.

## Environment names

agent-comms accepts `AGENT_BOT_ID` as well as its older `QWTS_AGENT_ID`
(qwts/agent-comms, from the release after 0.3.6). Older agent-comms reads only
`QWTS_AGENT_ID`. A pinned checkout needs neither.
