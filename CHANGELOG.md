# Changelog

## Unreleased

- The daemon vouches for bound souls (#254, agent-comms ADR-0008 decision 3).
  `POST /v0/vouch`, authenticated only by `x-agent-binding` (no bearer),
  returns a five-minute Ed25519 soul token
  `v1.<payload>.<signature over the payload segment>` for agent-comms, with
  the account, soul, and parent taken from the binding, never from the body.
  The per-account key is created once at
  `~/.local/state/agent-bot/vouch-key.pem` (PKCS#8, 0600) and is never
  rotated silently; `agent-bot daemon vouch-key` prints its SPKI public key.
  Vouches are limited to 60 per binding per minute, and each attempt leaves a
  secret-free receipt.

- Soul bindings persist (#253, agent-comms ADR-0008 decision 1). A
  successful bind writes `<git-dir>/agent-binding.json` (0600) holding the
  agent ID, parent, account, daemon URL, and binding secret; the daemon keeps
  only the secret's SHA-256 in `~/.local/state/agent-bot/bindings.json`
  (0600). Bindings survive daemon restarts, idle out after 30 days unused, and
  have their daemon URL rewritten at startup; a binding whose file is gone,
  foreign, or moved is pruned rather than stopping the daemon. MCP `bind` and
  `setup-worktree` reuse an existing binding, MCP shutdown no longer revokes
  it, and `agent-bot binding revoke` (or `DELETE /v0/binding`) does.
  `readBinding` is the one reader, honoring `AGENT_BOT_BINDING`.

## 0.7.2

- `qwen` is a recognized harness. `detect-harness` gains a `HARNESSES` row
  keyed on `QWEN_CODE=1`, measured from a live Qwen Code session, and placed
  above the cursor, copilot, devin, and muse rows: those match ambient editor
  markers that an integrated terminal exports to every child process, so a
  Qwen session run inside one of them previously detected as the surrounding
  editor while `detectAgentHarness` — which excludes ambient markers by design
  — said `qwen`, splitting one session across two identities. Both resolvers
  now agree. `claude` and `codex` keep their precedence, because their markers
  name another agent CLI rather than an editor and both resolvers already
  agreed on them; a test pins that choice. `QWEN_CODE_AGENT_ID` is exported
  empty at top level and so is deliberately not a marker.
  `detectAgentHarness` gains the matching branch, so a Qwen session resolves
  its App on a deliberate CLI call, becomes visible to the gh shim's
  `--agent-slug` agent-process guard, and stops recording its transcript
  provider as `custom`. `readiness` learns the Qwen Code MCP config locations
  (`~/.qwen/settings.json` and `.qwen/settings.json`, key `mcpServers`), so
  `inbox.configuration` can report a wired Qwen harness instead of a permanent
  false negative (#248, #249).

## 0.7.1

- The agent-bot skill conforms to ENG-0055. Its frontmatter carries the
  `qwts-` contract under `metadata` (range `>=0.7.0 <0.8.0`, validated
  `0.7.0`), and it classifies every command it routes to by side effect,
  with retry guidance. New read-only `agent-bot skill path [--json]` prints
  the installed release's skill bundle and its source commit. A release
  archive reports the commit from `RELEASE_COMMIT`, which GitHub's archive
  export stamps. CI adds a `CLI skill release gate` job that packages the
  tree as the formula does and runs `qwts-agent-ci`'s `cli-skill-gate`. A
  0.8.0 bump fails until the skill is revalidated. Under that gate,
  `skill path` must name a 40-hex source commit; `unknown` passes only for
  a direct run from a tree with no git metadata (#243, #244).
- `doctor` adds an advisory `securestore.launcher_session` check. It probes
  the dedicated pass-cli session the harness MCP launcher keeps under the
  agent-bot state root, which the ambient `securestore.session` check never
  saw, so an expired launcher session no longer reports ready while the MCP
  server dies at spawn with "Connection closed". A machine without that
  session reports `not_applicable`, and each failure class names its
  pass-cli login recovery (#241).

## 0.7.0

- The `gh-app-hook` Worker pushes each stored record to registered webhook
  subscribers instead of only serving polling consumers. A `SUBSCRIBERS`
  Worker secret maps an App slug (and optional `owner/name` repos, matched
  case-insensitively) to https destinations with per-subscriber sender keys
  and an optional auth override (reserved header names are rejected, the
  scheme defaults to `Bearer`); each push is HMAC-SHA256 signed
  (`x-hub-signature-256`), at-least-once with alarm-driven retry (30s/2m/10m/1h
  backoff, 5 attempts) and a dead-letter list, and `/inbox` keeps working as
  the catch-up path because `take` now marks a record pulled instead of
  deleting it. Retention: fully pushed records expire 24h after the last
  ack regardless of `pulled` (so push-only subscribers don't accumulate),
  subscriber-less records stay until pulled with a 7-day cap, dead letters
  stay 7 days, and takes stay FIFO by creation time. Records are stored
  one per storage key (legacy single-array records migrate on first read,
  normalized so a pre-push record can never crash a request), the stored
  comment text is capped so one record can't exceed the storage value
  limit, `/add` persists first, schedules the alarm, and returns without
  any outbound push, and `X-GitHub-Delivery` becomes the record id so a
  GitHub redelivery dedupes instead of re-pushing. A transiently
  malformed `SUBSCRIBERS` secret or a failing alarm run retries instead
  of dead-lettering live deliveries. Sender keys and subscriber URLs
  never appear in logs, errors, or responses, and a bearer-protected
  `GET /deadletter?app=` surfaces what never arrived (#234).

## 0.6.1

- `doctor` reports four more pieces of machine state that previously surfaced
  only as a failure: which App each recorded checkout is bound to, whether a
  secure-store provider has a live session, whether the gh-app-hook inbox is
  configured and wired into a harness, and the installed CLI version beside a
  source checkout's. All four are advisory, so they report state without
  changing `bootstrap` behaviour or a CI gate (#228, #231).
- The secure-store session probe never reads a field, so a diagnostic cannot
  become a secret reader, and an unreachable provider is reported distinctly
  from one that answered "no session" (#231).
- An App outside the configured roster now fails the worktree section instead of
  being reported as a `failed` check inside a section that still claimed `ready`
  (#228, #231).
- An empty App roster is reported as unconfigured rather than treated as
  allowing any App, and a manifest that is not this runtime is never used as the
  checkout version for skew (#231).

## 0.6.0

- Harness hook adapters for Claude, Codex, Cursor, Copilot, and Windsurf are
  written under the user directory by `sync-hooks` and are no longer committed
  in the repository, because a project copy can outrank the user hook
  (#222, #223).
- The agent-bot skill states that bot commits on a qwts repository are signed
  with `agent-bot signed-commit`, rather than signing only when an agent already
  knows the Verified badge is required (#220, #221).
- A shared `thread-orders` skill records that the first comment on a GitHub
  thread names the App, so later comments on that thread need no second mention.
  A live-session order is `qwts`; a remote request is authorized by an issue
  `qwts` opens (#218, #219).
- A mention or review request addressed to a roster App is delivered by a
  Cloudflare Worker, and the `take_inbox` MCP tool returns the oldest event for
  the App and full `owner/name` the session is bound to, then clears it. Another
  repository, a short name, or an unauthenticated call is refused, and the
  mailbox credential stays in the tool server rather than in the model
  (#214, #215).
- PATH registrations for the CLI and the gh shim, across `.zshenv` and
  `.zprofile`, move from loose append-only export lines to managed
  `# BEGIN`/`# END` blocks following the zsh-functions contract. Existing loose
  lines are absorbed on the next install so machines self-repair, and nested
  shells no longer duplicate the directories (#206, #212).
- Allow ordinary remote branch cleanup through the git pre-push guard, leaving
  branch deletion permissions to remote rulesets while retaining rejection of
  history rewrites and non-branch ref deletion (#210).
- The shared CI actions this repository consumes are pinned to their capability
  repository home, `qwts/qwts-agent-ci`, as commit SHAs, instead of the retired
  home (ENG-0355, ENG-0282; qwts/agent-sop#372) (#209).

## 0.5.0

- Doctor reports the account-level App outside a Git checkout, including
  scoped model identities, without inferring identity from harness markers
  (#190, #197). The broader account repair command remains a follow-up.
- Installation recovers dangling CLI symlinks after preserving them in unique
  backups, while live foreign links, regular files, permission errors, and
  symlink loops remain explicit conflicts. Doctor names missing targets
  and provides recovery guidance (#179, #199).
- Release preparation keeps the last valid Homebrew formula until the new
  tag and verified archive checksum exist; placeholder checksums are rejected.

- Install/bootstrap now provision Claude's user-level WorktreeCreate transcript
  adapter for exact active Claude roster accounts, including scoped model
  identities (#193). Explicit `GH_AGENT_APP` selections are preserved.
  Human accounts and unrelated settings stay untouched;
  conflicting, disabled, or unreadable settings require explicit reconciliation.
  Doctor reports adapter installation separately from named stale/unverified
  dialect evidence and supplies repair guidance. Duplicate user/project creator
  calls serialize and reuse only the same bound session, repository, branch,
  and App; live creation locks cannot be reclaimed solely because of age.

`owner` is the account an App is installed on, not the roster's governance
owner (#194).

- The runtime profile no longer requires `owner` to equal
  `profile.accountOwner`. A private App can only be installed on the account
  that owns it, so an organization the governance owner controls gets its own
  App, installed on the organization while the person keeps governing the
  roster; that configuration now loads without `profile-invalid` and without
  falsifying either field. A config whose `owner` differs from the projected
  account owner is not a projection and is never overwritten by a profile
  republish.
- `mint-token` mints against an App's only installation whatever `owner`
  says; `owner` is consulted only when an App is installed on several
  accounts. The multi-installation errors name the candidate accounts and
  distinguish "`owner` matched none of the installations" from "pick one".
- `owner`, when present, must be a non-empty account name.

`setup-worktree` on an already-pinned checkout keeps its soul (#192).

- With no transcript in view — how the harness startup hook and git's
  `post-checkout` hook run it — `setup-worktree` and `identity ensure` reuse
  the pinned Agent ID instead of minting a new one and silently orphaning
  the previous soul. Rotation still happens on a transcript that differs
  from the bound one, an App change, or a repin; a retired pin still fails
  closed. `identity ensure --reuse-pending` is accepted and is now the
  default.
- Census rows retain all known checkouts that pinned the soul (`worktrees`)
  alongside the latest checkout (`worktree`), written by `setup-worktree`
  in-process and through the daemon's `/v0/register` and bind paths. Old rows
  gain their recorded checkout as their first reference. `doctor` gains
  `souls.referenced`: a warning when no recorded checkout's worktree-scoped
  pin still holds the active soul. The warning asks operators to verify
  unrecorded checkouts and active sessions before considering retirement;
  it does not recommend deleting a space. `setup-worktree` says on stderr
  when a rotation unpins the previous soul from the current checkout.

## 0.4.0

The macOS account, not the directory, is bot territory (ENG-0339 supersedes
ENG-0045; #187).

- Identity resolution gains the account as the fallback below the pin: in a
  rostered agent account (`<prefix>-<harness>-agent`, or an `apps` override)
  every checkout — primary or linked — resolves to that harness's App, and
  the `gh` shim, `worktree-token`, `mint-token`, `setup-worktree`, and
  `signed-commit` all reach it. `AGENT_BOT_ACCOUNT` names the account for JS
  and shell alike.
- In the owner's account, unpinned work is the human's delegate: commits,
  pushes, and `gh` run as the human with no refusal. The `pre-commit` and
  `pre-push` territory guards and the shim's "outside bot territory" refusal
  are gone; `pre-commit` still requires a resolvable Agent ID for
  bot-attributed commits, and `AGENT_BOT_UNMANAGED_AUTHORS` (ENG-0128) is
  unchanged.
- `--app`, `GH_AGENT_APP`, and the pin outrank the account and the directory
  and never throw on a directory mismatch; the `.<tool>/worktrees` and
  scratchpad path rules are retired.
- Shell hooks and the Claude `WorktreeCreate` gate classify the account by
  exact roster slug through `worktree-token --account-slug`, not a name glob.
- `bootstrap` reports `bot-identity-unresolved` (was
  `linked-worktree-required`); `doctor` verifies a primary checkout that
  resolves a bot identity instead of skipping it.

## 0.2.0

First tagged runtime of the agent-bot CLI (Node ≥ 20, zero npm dependencies).

This repository is a Homebrew self-tap. `Formula/agent-bot.rb` pins this
version's GitHub archive. Operators install with:

```bash
brew tap qwts/agent-bot-identity https://github.com/qwts/agent-bot-identity.git
brew install agent-bot
agent-bot bootstrap --profile /path/to/organization-profile.json --with-gh-shim --machine-only
```
