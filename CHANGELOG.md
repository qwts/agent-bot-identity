# Changelog

## Unreleased

- Owner approvals use Touch ID, or the login password, instead of the administrator dialog on GeniusBar Macs (#416). Every owner-only command (`soul comms`, `soul cold-wake`, `soul confinement`, `soul revision`, `identity migrate-credentials`, and any later command behind `assertOwnerAction`, such as `join --wake` and `soul remove`) used to raise the macOS administrator dialog, because GeniusBar's principal lives in the owner's own account and cannot vouch; friends without an admin account could not approve at all.
  - The gate now asks agent-bot-keyd first (`owner/presence`). keyd shows LocalAuthentication's device-owner prompt with "agent-bot wants to <action>", naming the soul by name and Agent ID, and on approval signs `{aud: 'agent-bot-owner', kind: 'presence', action: sha256, nonce, iat, exp}` with its own Ed25519 presence key. agent-bot checks the signature, the action digest, its own nonce and a 60-second lifetime, and records `{ method: 'presence', via: 'agent-bot-keyd' }`.
  - The presence key is pinned from the binary, never from the socket: agent-bot checks the recorded keyd binary's Developer ID signature with `codesign`, runs `agent-bot-keyd presence-key`, and keeps the public half in `keyd/presence.pub` (0600).
  - Fallback: with no keyd, an unsigned keyd, or nobody to ask (no GUI session over ssh, no login password), keyd's `-32001` or a missing socket sends the gate to the administrator dialog as before. A person's cancel, a timeout or an assertion that does not verify refuses, and nothing asks again.
  - Prompts name the change in words ("turn agent comms off for Bill - Starter (agent_…)"), for keyd's prompt and the administrator dialog alike; audits keep the command-shaped action.
- Cold-woken souls stop sending narration and duplicates, and a policy refusal is no longer silent (#407, #408). On the lab Mac, Bill's final text went to Starter after he had already asked Ted with `send_message` ("Message sent to Ted. I'll wait…"), his "Forwarded… Task complete" woke Ted for nothing, and Starter got the same "Done" twice. A relayed turn woken by another soul now sends no final text when it used `send_message` in that thread during the turn (the daemon reads the turn's sends from the thread journal, told apart from earlier sends by message id, not time), and the prompt says so; a `start_soul` brief to a teammate does not hold the answer back; a person still gets the final text unless the turn already messaged them. A comms turn's reach server no longer offers `fetch_context`, `post_reply` or `report_status`: they need an interaction-store invocation, which a comms turn never has, so every call failed with "no invocation in scope" and agents narrated the error into their replies. A turn that ends with nothing said after the policy refused a tool now answers with "I couldn't finish this: Bash is not allowed for me here (my owner's policy for this agent)." instead of leaving the sender waiting; `NO_REPLY` and a real answer still win. The contract executor accepts an optional `onPermission` watcher, which sees each decision and can never change one.
- A failed soul launch rolls back (#419). When `start_soul` or a principal package launch spawned a soul and its first start failed, the soul was retired but its folder and agent-comms membership stayed. Every retry with that name was refused (`soul directory already exists`), and GeniusBar listed the dead soul as a second peer under its parent. The rollback now makes the soul leave agent-comms as itself if it had joined, retires it, and moves its folder to `<souls root>/.archive/` (never deleted), so a retry with the same name succeeds. `agent-bot doctor` warns (`souls.orphans`, code `soul-folder-orphan`) about any soul folder whose soul is retired or unknown here.
- Souls launched before 0.10.9 show as managed (#409). The managed flag is recorded at launch since #389, so Starter, Bill and Ted, launched from GeniusBar earlier, read `managed: false` and GeniusBar labelled them Unmanaged. On start the daemon now marks every soul its launch journal reports `launched` as managed, once, and leaves its comms setting as it is. A soul that only joined is never in the journal and stays unmanaged.
- agent-bot-keyd holds souls' GitHub App keys on GeniusBar installs (#397). See [soul credentials](docs/soul-credentials.md#agent-bot-keyd-397).
  - New store `keyd` in `soul.json`. Its keys live in Keychain items that only GeniusBar's signed `agent-bot-keyd` can read, and keyd never returns them.
  - keyd mints only on a 60-second, single-use grant the daemon signs with its vouch key, which keyd pins on the owner's first import. Policy stays here: `POST /v0/keyd/grant` checks the soul's binding proof, the `github-identity` gate and the declared App, and receipts `credential-grant`.
  - A keyd soul's turns get the `agent-bot-keyd` MCP relay (`credential`, `git_credential`) with exact allow rules. `/v0/credential`, the git credential helper and `mint-token` mint through keyd for such a soul.
  - `agent-bot identity migrate-credentials --to keyd` moves keys in with one owner prompt. `agent-bot keyd install|status|uninstall` supervises keyd under launchd; GeniusBar calls it at setup.
  - Confinement also denies a soul the daemon's `vouch-key.pem` and keyd's directory and sockets.
  - Without keyd (Homebrew, Linux) nothing changes.

## 0.10.11

- Codex souls run under the daemon (#384). The `codex` ACP row was registered but disabled, so a soul could not choose Codex. It now runs `@agentclientprotocol/codex-acp@2.1.1`, pinned exactly; the `@zed-industries/codex-acp` package is deprecated, and its 0.16.0 build was refused by a current ChatGPT login's default model. The adapter's default mode lets Codex's own reviewer approve tool calls, so the daemon policy was never asked. A row can now name an ACP `sessionMode`, which the engine sets on every new or resumed session, and the codex row uses `workspace-write`, so every approval, MCP tools included, reaches the daemon. A new `codex-mcp-title` naming maps a 2.x MCP approval to `mcp__<server>__<tool>` only when its `tool_call` announced `mcp.<server>.<tool>` with the adapter's MCP marker and the request carries `is_mcp_tool_approval`. Verified live with the default deny policy plus the reach rules: `fetch_context` and `post_reply` were allowed and closed the loop, a shell write outside the workspace was refused, and a resumed session recalled the earlier turn. `AGENT_BOT_ACP_LIVE=codex` and `AGENT_BOT_REACH_LIVE=codex` run those checks.
- OpenCode souls are held to the daemon policy (#390). OpenCode allows every tool by default, and a machine config such as managed-machine's `"permission": "allow"` says the same, so an OpenCode soul's shell and edit calls never asked the daemon. The opencode row now passes its own primary agent, `agent-bot`, through `OPENCODE_CONFIG_CONTENT` and selects it as the session mode on every new or resumed session. An agent's rules are evaluated after the user's, so its ruleset decides: everything asks the daemon except read-only built-ins (`read` outside `.env` files, `glob`, `grep`, `list`, `lsp`, todos, `skill`), and subagents (`task`) are off, because a subagent runs under its own agent's rules; souls start teams with `start_soul`. A registry row may now declare `setEnv`, applied after `stripEnv`, so an inherited value never replaces it. The user's own OpenCode config, models and login are untouched. Verified live with a scratch `"permission": "allow"` config under the default deny policy plus the reach rules: `fetch_context` and `post_reply` closed the loop, a resumed session recalled the earlier turn, and a shell write outside the workspace was refused. Without the fix, the write succeeded. `AGENT_BOT_REACH_LIVE=opencode` runs the refusal check.
- A copied soul folder is never used as the soul (#80). A Finder Duplicate of `Starter - Starter.soul` copied its `.soul-state/agent-id` marker, so two folders claimed one soul, and since GeniusBar 0.1.8 opens a `.soul` from Finder as a package, an installed soul could be offered as a new launch. `agent-bot soul locate PATH` now reports whether a folder is a `package`, an `installed` soul's own folder, a `copy`, an ambiguous `duplicate`, or `unregistered`; a daemon package launch of an installed soul's folder relaunches that soul instead of spawning another, and the other cases are refused before anything is minted. `soul dir` lists `copies`, and `agent-bot doctor` warns (`souls.folders`, code `soul-folder-duplicate`) naming each soul's folder and its copies.
- `soul locate` and daemon package launches read a folder's `.soul-state/agent-id` marker without following links, only as a regular file of at most 256 bytes, and believe it only when it is an Agent ID. Anything else is the new `invalid` status, refused, and its message never quotes the marker. Before, a package whose marker linked to another file could have had that file's contents echoed in the refusal and sent to the broker as the launch result (Cursor security review on #400).
- Per-soul GitHub App credentials (#383). See [soul credentials](docs/soul-credentials.md).
  - `soul.json` may declare `credentials.github: { app, store }` (`keychain` or `file`). It names where the key lives and never holds it; any other key fails validation. Template spawns carry the declaration.
  - The key lives in the soul's own store: a login-keychain generic password (service `agent-bot.soul.<agentId>`, account `github-app/<slug>`, written over `security -i` stdin), or `<soul>/.soul-state/credentials/` (0700/0600), which is never packaged or revisioned.
  - Minting reads the declaring soul's store first, then the legacy `~/.config/<slug>` with a one-time deprecation notice. The daemon's `/v0/credential` names the soul it mints for.
  - `agent-bot identity migrate-credentials [--soul ID|--all] [--dry-run] [--json]` (owner only, refused from a soul) copies legacy keys into each soul's store, verifies them live against `GET /app`, and reports which legacy key files are no longer needed. It deletes nothing.
  - Confinement now denies a soul, in every mode and every tool, any soul key store, legacy `~/.config/<slug>` App folders, `private-key.pem`, and the `security` and `pass-cli` executables.
  - The Keychain access list cannot lock an item to a Node daemon (it names executables, and the daemon reads through `security`); souls are kept out by confinement, which is cooperative.

## 0.10.10

- Souls keep the thread across cold wakes (#392). Starter asked Bill to get a book list from Ted; Ted's answer woke Bill in a fresh session that had never seen Starter's request, so the list never reached Starter, and the relay posted an answer ending in a literal `NO_REPLY`. The daemon now journals each soul's received and sent agent-comms messages (bounded, 0600, under the identity state directory), and a relayed turn's prompt carries the woken message's earlier thread, found by `correlation` and `replyTo`: at most 8 messages and 6 KiB, oldest first, each marked with its sender and as message data, not instructions. A relayed turn's reply and its `send_message`/`start_soul` sends default their `--correlation` to the woken message's correlation or id, so answers find their way back. The relay drops a final `NO_REPLY` line and sends only what is left, never the token. No agent-comms change.
- Reach tools work beyond Claude (#384). The daemon's exact allow rules for the `agent-reach` tools only matched Claude's naming (`_meta.claudeCode.toolName`), so under the default deny policy an OpenCode or Codex soul could not use `fleet` or `send_message`. Each ACP registry row now declares `mcpToolNaming` (`claude-meta`, `opencode-key`, `codex-invocation`), and the engine maps an adapter's own `tool_call` announcement, matched by `toolCallId`, onto the canonical `mcp__<server>__<tool>` name, for servers it injected only. A request title is never trusted alone: an OpenCode `external_directory` ask, a shell call titled like an MCP tool, an unannounced call or a call to another server stays unnamed, is denied, and is logged. Muse still drops injected MCP servers (out of scope); Gemini and Devin have no ACP row.
- A managed soul can start its own team (#377). The reach server's new `start_soul` tool (`name`, optional `harness`, `template`, `brief`) asks the daemon, by binding proof, to start a new full soul through the principal launch path with the caller recorded as parent in its identity and the census; comms are on, and `brief` arrives as its first message from the parent. The daemon enforces every limit: a soul starts souls only as itself, at most `teams.maxChildren` active children (default 5), at most `teams.maxDepth` levels below the root soul (default 2), and only on a harness that is enabled and launchable here. Every attempt leaves a `team-start` audit receipt. `start_soul` is gated by comms like `fleet` and `send_message`, and gets its own exact allow rule; `fleet` now shows each teammate's `parent`. A launch event can no longer carry a `parent` of its own.
- `agent-bot soul comms <soul> [show|on|off] [--json]` (#381) reports `{agentId, name, managed, comms, running}` and lets the owner turn agent-comms on or off for a stopped soul. The change is a new `soul.json` revision (an owner edit when the soul has a revision chain) and updates the census, so it applies from the next turn. It is refused (code `soul-running` with `--json`) while the soul has a turn in flight or a warm harness, checked again after the owner approves; the daemon's `/v0/health` and `daemon status` now list those busy souls. A launch request may carry `comms: true|false`, written to `soul.json` before the soul starts.

## 0.10.9

- Daemon-run souls can work with each other. A soul GeniusBar launched or cold-woke had no way to reach another agent: the reach-back MCP server (#146) was never injected into daemon ACP turns, it had no tool to see or message teammates, and the default deny policy refused any shell call to `agent-comms`. Asked to work with Ted, Bill answered that he could only reply to messages sent to him. Every daemon ACP turn now gets the `agent-reach` server, with two new tools: `fleet` (the souls this soul may message, from `agent-comms peers`) and `send_message` (an agent-comms message by fleet name, address, Agent ID or principal name). Both run `agent-comms` as the soul, in its worktree, with its binding. The daemon policy gains an exact allow rule for each `mcp__agent-reach__*` tool and nothing else. The ACP engine now names Claude permission requests by the tool name announced on the matching `tool_call` update, since the adapter sends none on the request. A relayed reply to another agent may be `NO_REPLY` to end the exchange.
- agent-comms is on by default for every managed soul. A `soul.json` may say `"comms": false`; the daemon reads it when it launches the soul and records `managed` and `comms` in the population census, which `population list|show --json` now expose. Template instances keep their template's setting.
- Agents without a GitHub App have one supported path to join, message and be woken (#382). See [joining](docs/joining.md).
  - `agent-bot join --name NAME --harness HARNESS [--template PATH] [--soul ID] [--json]` reuses or creates the soul (a bundled Starter when the install ships one). It pins the current checkout, or the soul's own `worktrees/workspace` outside one, so a plain `agent-comms` resolves it with no environment variable. It records that checkout for cold wake, links it into the soul, mints a bind token so the MCP `bind` tool works, and runs `agent-comms join`.
  - Resume and webhook cold wakes of a soul with no usable recorded checkout, such as one made by `soul spawn`, now run in its soul directory, proven by its `.soul-state/agent-id` marker. Before, a webhook soul created that way could never be woken (`soul binding is unavailable`).
  - Failed cold-wake audit receipts carry a one-line `detail`. URLs are replaced with `<url>`, and a failed turn's own error is never recorded.
  - `agent-bot setup-worktree` run by name in a checkout that states no App now says why it did nothing, and points at `agent-bot join`. Git hooks stay quiet.

## 0.10.8

- Runtime metrics now reach souls the daemon runs (qwts/agent-comms#86). A launched or cold-woken Claude soul works in its soul home, which is not a git worktree, so the session-start hook could not place its session, and `metrics collect` found nothing for it. GeniusBar's Starter showed no Model or Context rows after chatting. Every daemon ACP turn now records its harness session binding for the soul in `metrics/sessions.json`. The Claude ACP adapter uses that id as the Claude session id, so the collector reads the right log. Recording is best effort and never fails a turn.
- Daemon-run Claude souls keep their transcripts. Each ACP turn used to end in an immediate SIGKILL of the agent's process group. Claude Code writes its session log as it exits, so every daemon turn left a log with no messages: nothing to resume from and nothing for metrics to read. A finished turn now closes the agent's stdin and waits up to `exitGraceMs` (2 s) for the group to exit, then sends SIGTERM and waits again, and only then sends SIGKILL. Aborted and timed-out turns are still killed at once.

## 0.10.7

- Daemon task links (qwts/agent-comms#88): `/v1` invocations retain optional `taskId`, and task-event cold wakes use broker briefs without replying. Linked turns report execution facts independently of task state; a private journal reports interrupted turns after restart. Older agent-comms versions acknowledge task events without execution.
- The Linux bundle carries agent-comms 0.3.5, which keeps a separate principal credential file per credential name, so two hosts in one account never overwrite each other's principal (qwts/agent-comms#83).
- Optional read-only runtime metrics (qwts/agent-comms#86, ADR-0007 decisions 5–8). `agent-bot metrics collect|show [--json]` reads a soul's Claude Code session log incrementally and keeps only the reported model and the last call's token counts (`context_used_tokens` and `output_tokens`; `context_capacity_tokens` stays `unknown`). Each observation states its unit, scope, source and kind. Binding goes only through a recorded session: the identity's transcript, or the new session-start hook `30-record-session`, which records the session for the worktree's binding or Agent ID pin. Reads are checkpointed, bounded per run and survive rotation and truncation; a new large log starts at its tail and reports `skippedBytes`. See [metrics](docs/metrics.md).
- Readiness Git config probes ignore ambient command-scope injection and repository overrides, preserving hermetic global and system config controls so doctor reports the checkout’s declared identity (#232).
- Upgrading from before 0.9 no longer turns GitHub identity off (#361). A config with no `features` object predates the gates. When one of its souls already carries a GitHub App, `daemon run` and `daemon install` record `features.github-identity` and `features.persona-accounts` as `true` once, which is what that install was running with. They write atomically and keep the file's mode. Any `features` object, even an empty one, is left alone, and so is an install with no App-bearing soul (every install since 0.9). Until the daemon next starts, `doctor` warns (`feature-gates-pre-gate-config`). Before this, a brew 0.5.0 machine moved to GeniusBar lost bot identity silently: `worktree-token` refused, and the `gh` shim passed through as the human.
- The gh-app-hook Worker reserves push attempts before sending, so failed outcome saves back off and dead-letter at the delivery cap even across object restarts; storage failures re-arm alarms with capped backoff (#237).

- The Linux bundle carries agent-comms 0.3.4, whose `broker install` no longer leaves the broker down when a re-install's bootstrap is refused: it waits for the old job, retries, and restores the previous unit (qwts/agent-comms#80).

## 0.10.6

- The Linux bundle carries agent-comms 0.3.3, whose broker starts after an unclean shutdown even when a stale `broker.lock` pid has been reused (qwts/agent-comms#78).
- Soul builder (#342, ADR-0332 decision 8): deterministic Claude/Gemini imports and native skill files, `agent-bot soul build [PATH] [--check]`, conflict preflight, atomic writes and marked stale-file cleanup. New package homes build after copying. Format 2 ignores only exact renderer bytes with the unchanged v2 contract; hand edits remain revision content. MCP/tool/policy translation awaits a defined source schema. Opaque skill siblings remain in the source directory with generated pointers.
- Soul worktree placement (#339, ADR-0332 decision 6): Claude creates new checkouts under the resolved soul's `worktrees/`, falling back to `$TMPDIR/agent-bot/<agentId>/<name>` with a link when the soul is on another device or the path exceeds 900 characters. `setup-worktree` links harness-selected and existing checkouts into the soul without moving them, reuses matching links, and numbers name collisions. Launch continues to use a live binding or `.soul-state/home`.
- Per-soul SOP reference documents (#343, ADR-0332 decisions 9–10): soul `agent-sop.toml` overrides user selection; soul `sop/` Markdown layers over the resolved repository. `sop list` and `sop show` support `--soul` and workflow TOML filters, with pinned read-only caches and path checks. Foreign soul selections require explicit `sop trust REPO --soul ID`, recorded by repository and commit in private state. Printed documents carry the ADR-0274 reference header; bare no-soul text output stays unchanged.
- Soul write confinement (#340, ADR-0332 decision 7) defaults to warn. The shared hook runner reports recognized file tool writes outside soul territory in a private metadata-only log, preserving allow and the existing hook chain. Owner-gated `soul confinement AGENT_ID off|warn|deny` configures each soul; `soul confinement-report AGENT_ID [--json]` summarizes reports by directory prefix. Explicit deny is supported but is not the default. Shell writes, MCP tools and reads are follow-ups; hooks are a guardrail, not a sandbox. Existing resume-wake harness OS sandboxes remain in use. See [confinement](docs/confinement.md).
- Soul templates (#344, ADR-0332 decision 11): `agent-bot soul spawn TEMPLATE_PATH --name NAME [--harness H]` creates a named instance with its own genesis identity, display seed and revision history. Directories preserve the manifest display name, replacing invalid filename characters; existing destinations are refused. Templates remain untouched, working state and generated harness files are excluded, and named daemon package launches use the same mechanism. See `docs/soul-templates.md` for provenance and tailoring.

- Soul directories and home migration (#338, ADR-0332 decision 5): resolve the shared root from `AGENT_BOT_SOULS_HOME`, `settings.soulsRoot`, then `~/.agent-bot/souls`. The population census records `soulDir` and rediscovers moved souls by their private Agent ID marker. New package spawns copy their package into the soul directory, and homes live at `.soul-state/home`. Legacy state-directory homes migrate on launch with atomic rename or a restartable cross-filesystem copy, then rebind. Agent Spaces stay put and are linked from `.soul-state/space`. `agent-bot soul dir AGENT_ID` provides the JSON location contract for hosts; harness sign-in resolves that same home.

- Headless Linux gets a supported install (#337, ADR-0332 decisions 1 and 2). Each release publishes `agent-bot-linux-x64-v*.tar.gz` and `agent-bot-linux-arm64-v*.tar.gz` with a `SHA256SUMS` file next to the formula's tag. An archive holds a pinned Node, agent-bot and agent-comms, and `install.sh` unpacks it into `${XDG_DATA_HOME:-$HOME/.local/share}/agent-bot`, writes `#!/bin/sh` wrappers for `agent-bot`, `agent-comms` and `node` into `~/.local/bin` carrying the marker `# agent-bot-linux-cli-tool`, registers that directory on PATH through one `# >>> agent-bot PATH >>>` block in `~/.profile` or `~/.zprofile`, and writes `agent-bot-daemon.service` and `agent-comms-broker.service` as `systemd --user` units. It never needs root. A file at a wrapper path without that marker belongs to another install and is only replaced with `--replace`, which keeps it as `<name>.before-agent-bot`; `uninstall.sh` puts it back. One OS user runs one pair: install reports another install's broker or daemon and refuses without `--migrate`, which stops and disables that pair, preserves its unit files, and rolls back if this install's pair does not come up. `uninstall.sh` removes the install directory, the marked wrappers and the services this install wrote, and never deletes a soul. `scripts/linux-bundle/components.json` pins Node 24.21.0 by version and sha256 and agent-comms `qwts/agent-comms` v0.3.2 by the full commit `9b1e9e70da38c59e77a47776aa619b6ab016b18e` that its release tag must resolve to, the way GeniusBar pins it, so the commit is the integrity pin. The build copies only the entries agent-comms' own package.json `files` list names, installs nothing (v0.3.2 has no npm dependencies), checks the fetched CLI dispatches `join`, `inbox`, `send` and `broker` by running its `--help`, refuses a mismatch, and starts the broker as `<node> bin/agent-comms.mjs broker run --single-account`, the command agent-comms' own service installer builds.
- Owner actions on soul revisions need an owner proof (#293). `agent-bot soul revision adopt|edit|approve|reject` no longer treats a caller with no Agent ID or App as the owner, since a soul can unset both. Any soul marker in the environment or worktree, including a binding, refuses, and the owner then proves themselves with either the agent-comms principal credential presented on stdin (`--principal-stdin`, checked against a broker running in another account) or the macOS authorization dialog. Each record carries `authorization: { method, principal? }`. The shared check is `owner-gate.mjs`.
- Cold wake changes use the same owner gate (#293). `agent-bot soul cold-wake <agentId> on|off|resume POLICY|webhook ...` refuses an Agent ID, binding or App identity (harness detection still does not count, as before), then needs `--principal-stdin` or the authorization dialog, which names the change and the soul. `show` needs no proof. Stdin carries one thing: `--principal-stdin` with `--url-file -` or `--key-file -` is refused, so pass the webhook URL and key as files when presenting a principal.

## 0.10.5

- Webhook wake (#334): `agent-bot soul cold-wake <agentId> webhook --url-file PATH --key-file PATH|-` wakes a soul whose harness runs a routine when a webhook fires, such as Grok Bot, which has no headless CLI. On each message the daemon POSTs `{event, agentId, ask}`: `ask` is a fixed instruction to read the inbox in the soul's worktree, and no message content is sent. The soul's routine answers and acks its own inbox. The URL and key are stored 0600 under the state directory, shown only as the host, never logged, and removed when the soul's wake setting changes away from `webhook`.

## 0.10.4

- Resume wake supports Grok (#328): `agent-bot soul cold-wake <agentId> resume <read-only|workspace>` now works for a Grok soul. Both policies run under Grok's OS sandbox, and read-only also denies edits and shell. Grok fixes a session's sandbox when the session starts, so changing a Grok soul's policy starts a new session. `docs/resume-harnesses.md` is the checklist for adding a harness.

## 0.10.3

- `daemon install` writes stable Homebrew `opt` paths for node and agent-bot instead of versioned Cellar paths (#321), so a `brew upgrade` no longer leaves the daemon pointing at a removed version.
- Resume wake (#323): `agent-bot soul cold-wake <agentId> resume <read-only|workspace>` makes a message start a turn for a Codex, OpenCode or Devin soul, with no polling and nobody typing. The daemon resumes a session of the soul's own harness in its worktree for one headless turn per message, and sends the turn's answer back as the reply. The policy is enforced with each harness's own flags, so nothing waits for an approval. A soul bound by its own session (no daemon binding) is found through its recorded worktree.

## 0.10.2

- `take_inbox` says what failed (#299, #317). A network failure names the
  inbox host and the underlying cause (`ECONNREFUSED`, a timeout) with a
  stable code such as `inbox-broker-unreachable`, `inbox-auth-expired` or
  `inbox-daemon-unreachable`, plus the recovery step, and never the bearer.
  Requests time out after 10 seconds. A restarted MCP server re-binds from
  the worktree's binding file without a manual `bind`.
- `doctor` reports the inbox host and warns on an inbox URL that is not a
  valid http(s) URL (`inbox-url-invalid`). A network reachability probe is
  tracked in #318.

## 0.10.1

- A launched soul joins agent-comms before its first turn (#313), so the
  broker reports it `launched` and it appears in the principal's roster.
- A cold-woken soul reads and answers its messages (#314). A cold turn
  denies every tool call, so the daemon now relays: it reads the soul's
  inbox as the soul, runs one turn per message with the sender and body in
  the prompt, sends the turn's final text back with `--reply-to`, and acks
  the message. A reply refused for good (the reply-depth limit, or the
  sender gone) is acked unanswered. Wake and launch prompts now reach the
  harness as text; the executor contract rejects anything else.

## 0.10.0

- Souls carry their harnesses (#307, ADR-0276). When a soul home is made
  from a package with `package.json` and `package-lock.json`, the daemon
  runs `npm ci --ignore-scripts --omit=dev` in it, using the host's npm
  (`AGENT_BOT_NPM`, an `npm-cli.js` run with this Node) or else `npm` from
  PATH. A failed install fails the launch and removes the half-made home.
  Registry rows name their npm binary (`soulBin`), so a home that installed
  it runs the harness with this Node, without npx. `daemon install` carries
  `AGENT_BOT_NPM` into the unit.
- An embedded host can run souls without editing config (ADR-0276).
  `AGENT_BOT_EXECUTOR=1` turns on the daemon's ACP executor, and `daemon
  install` carries it into the unit. A principal launch turns on cold wake
  for the soul it started, so later messages wake it.
  `agent-bot harness auth status|login HARNESS --soul AGENT_ID` reports
  `{harness, loggedIn}` and runs the harness's own sign-in (Claude: the CLI
  installed in the soul's home, else `claude` from PATH).
- Souls can use the host's tools. `AGENT_BOT_TOOL_PATH`, an absolute
  directory such as GeniusBar's `agent-comms` and `agent-bot` shims, is
  carried into the daemon unit and put first on every soul harness's PATH,
  so a soul can read and answer chat on a machine with nothing installed.
- The ACP executor runs souls without a GitHub App. `validateExecutorIdentity`
  accepts `app: null`, and `acpExecutorFor` no longer refuses them. Before
  this, every real launch of an App-less soul failed even after #297.

- Principal launches start souls without a GitHub App (#297). A launched
  soul with no live binding gets a home, a private git worktree at
  `<state>/homes/<agentId>`, which the daemon binds before starting the
  harness. A package launch validates the package, spawns a root soul with
  a genesis ID, and starts its home from a copy of the package. If that
  first start fails, the new soul is retired. Cold wake also runs souls
  without an App.

## 0.9.1

- Embedded hosts supervise their own daemon (#302). `AGENT_BOT_SERVICE_LABEL`
  names the launchd label or systemd unit (one safe token, else a usage
  error) and is carried into the unit; `daemon disable` and `doctor` honour
  it. `agent-bot daemon install [--json]` registers the running node and
  `agent-bot.mjs` entry as `daemon run`, rewriting and reloading only when
  the unit changed, so an updated or moved host re-registers by running it
  again. It reports `{ label, unitPath, changed, loaded }`. Without the
  variable, install and bootstrap behave as before.

## 0.9.0

- qwts conventions run only with `github-identity` on (#281, ADR-0274
  decisions 3, 5 and 6): `Agent-Identity` commit trailers, post-commit
  identity recording, `signed-commit`, and the `gh` shim, which now checks
  the gate on every call and passes through to stock `gh` when it is off. An
  unreadable or invalid config is not "off": the shim and the trailer hook
  refuse, and post-commit warns. Installing with the gate off replaces an
  older managed shim that lacks the call-time check. The App roster already
  comes from configuration.

- Soul revisions and self-proposals (#285, ADR-0275 decisions 4, 7 and 8).
  `agent-bot soul revision` records append-only, content-addressed package
  revisions. A user edit is a new revision, and undo is another one. A soul
  proposes a revision; the package's `policy.json` decides `ask` (the
  default, needing `approve` or `reject`), `auto` (only when every changed
  path matches its globs), or `never`. Changes to `policy.json`,
  `soul.json`, or tool/MCP configuration always need the user. Promoting a
  file from Agent Space is an explicit revision that records its source.
  `docs/soul-revisions.md` documents the format and commands.

- The daemon handles principal `launch` frames from agent-comms (#295). It
  starts the named harness for an existing soul and reports `launch-result`
  by requestId, using a private journal so that no request is replayed after a
  restart. Souls without a GitHub App identity, and package spawns, report
  `failed` until #297.

- Souls no longer require a GitHub App (#280, ADR-0274). With
  `github-identity` off, setup, bind, spawn, vouch, and wake work with an
  identity that has no `github` field. Warm sockets work without GitHub;
  cold ACP wake is reported unsupported until ACP can launch without an App.
  GitHub metadata, credentials, and the `gh` shim are opt-in. qwts machines must set
  `features.github-identity: true` and `features.persona-accounts: true`
  before upgrading to keep their existing behavior.

- `agent-bot sop` reads `~/.config/agent-sop/config.toml` (ENG-0355 as
  amended 2026-09-16) and resolves each ref to a commit (#282, ADR-0274
  decision 4). It reports the org, sop, and comms repositories and what
  the org repository's `org.json` pins. With no config file it reports
  that no SOP is in effect and exits 0. Fetched content is reported only:
  the command does not clone, check out, apply, or execute it.

- Genesis-derived soul IDs (#284, ADR-0275 decisions 5, 6 and 9).
  `identity spawn --package PATH` (and the daemon's spawn) derives the
  `agent_<uuid>` as a UUIDv8 from the package's starting revision, the
  parent soul, and a private spawn nonce; the identity row records
  `genesis: { revision, parentSoul }`. Later revisions never change the ID.
  Existing souls keep their IDs and read as `genesis: null`.
  `docs/soul-genesis.md` gives the exact encoding and test vectors.

- `agent-bot daemon pair-comms` now pairs with this account's one-account
  agent-comms broker when `--broker` is omitted (#286, ADR-0059 decision 3).
  Private custody requires owned 0700 rendezvous/proof directories and a
  0600 socket. The daemon persists the broker mode and applies it to every
  account-watch connection and wake report. Named brokers and older saved
  credentials retain group-mode custody. No agent-bot feature gate is used.
  Protocol fixture tests cover CLI pairing, joining account-watch, receiving
  and reporting a wake, and refusing loosened private permissions.

- Feature gates for add-ons (#279, ADR-0274 decisions 1 and 2). The user
  config's `features` object turns `github-identity` and `persona-accounts`
  on; both are off by default and no environment variable sets them.
  `agent-bot doctor` reports each gate and its source. Gate settings do not
  mark an organization-projected config as edited, and survive profile
  updates. Nothing consumes the gates yet: qwts machines should set both
  to `true` before the add-ons start honouring them (#280, #281).

- Soul package format, version 1 (#283, ADR-0275 decisions 1 to 3).
  `docs/soul-package.md` specifies `soul.json`, the package layout, how
  unknown files are kept, and the canonical revision hash, with fixed test
  vectors. `agent-bot soul pack validate PATH` checks a package and prints
  its revision. Nothing runs packages yet.

## 0.8.0

- `agent-bot daemon pair-comms` prints the broker's pairing state and the
  owner approval code. The comms client read results under a `result` key,
  but the broker replies `{ ok: true, ...result }`, so every request's result
  came back empty and pairing printed `undefined`. The test stubs now speak
  the broker's real reply shape.

- Binding proofs (#270, agent-comms ADR-0008 decision 3 as amended). Clients
  no longer send the binding secret: each request carries a one-time
  `x-agent-binding-proof` (`v1.<keyId>.<ts>.<nonce>.<mac>`), an HMAC keyed by
  the secret's SHA-256 over the method, path, and daemon address, fresh
  within 60 s, refused once its nonce is seen, and refused when made before
  the daemon started (so a restart on the same port cannot replay one). A process holding the
  daemon's loopback port while the daemon is down learns nothing reusable,
  and a captured proof does not work at the daemon's real port. `wake listen`,
  spawn, binding revoke, and the MCP daemon client present proofs; the daemon
  still accepts the bare `x-agent-binding` from older clients.

- The daemon wakes souls through the wake plane (agent-comms ADR-0008
  decisions 7 to 9). Each wake from the broker's `account-watch` goes to the
  soul's warm sockets, or to a cold turn when the owner turned cold wake on,
  or else is reported `waiting`. The dispatcher's outcome goes back to the
  broker as a `wake-report`. The ACP executor is wired when the user config
  says `"executor": { "enabled": true, "policy": { ... } }`. A cold turn runs
  under that policy, and anything that would need an approval is denied.
  Daemon pairing reuses the vouch key instead of a second key steward.

- `agent-bot identity spawn` gives the child its own binding (#258,
  agent-comms ADR-0008 decision 2). With a parent binding it asks the daemon's
  `POST /v0/spawn`, which writes `<git-dir>/agent-bindings/<agentId>.json`, and
  `identity spawn -- <command>` runs the command with `AGENT_BOT_BINDING` set to
  it. Revoking a parent revokes its spawned descendants. With no binding the
  command mints a claimed identity locally, as before.
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
  Rebinding an already-bound worktree through `POST /v0/bind` requires the
  same proof of place as a first bind (its binding secret in
  `x-agent-binding`, or a bind token minted in that git dir), so a path and
  the daemon bearer never yield another worktree's secret.
  `readBinding` is the one reader, honoring `AGENT_BOT_BINDING`.

- The daemon pairs with the agent-comms broker (#255, agent-comms ADR-0008
  decisions 4 and 7). `agent-bot daemon pair-comms --broker <account>` sends
  `daemon-pair-request` with the daemon's Ed25519 public key and a
  kernel-stamped proof, prints the owner's approval code, and keeps the
  credential at `~/.local/state/agent-bot/comms-daemon.json` (0600). Once
  approved, `runDaemon` holds the broker's `account-watch` stream open with
  capped backoff (1 s to 30 s) and answers each wake with `wake-report`
  (`waiting` until dispatch lands). `daemon status` shows the pairing and the
  stream. The client mirrors agent-comms wire v1 and its custody checks.

- Wake dispatch gains its seam. A new `wake-dispatch.mjs` is the pure half of
  ADR-0008 decision 7: `dispatchWake(event, { pool, coldWake, report, receipt })`
  answers one coalesced account-watch wake with `warm`, `cold`, `waiting`, or
  `failed`, and `createWakeDispatcher(ports)` returns the `(event) => Promise`
  an account-watch client holds, serialising per soul so one slow cold turn
  cannot reorder or stall another soul's wake. The frame a warm socket receives
  is `{ event, agentId, count, cursor, messageIds }`, built field by field so an
  unexpected field on a watch event is never forwarded to a listener. A send
  error on every socket for a soul is `failed` with a detail and drops the
  sockets, so the soul is honestly cold on its next wake — never a `waiting`
  that hides a dead pool. Every dispatch also writes a receipt of
  `{ event, agentId, count, outcome }` and nothing else, so the audit trail is
  never a second copy of the mailbox. The warm pool (#147), the account-watch
  client (#255), and cold wake (#259) are its ports; `runDaemon` wires them
  once all three land (#256).

- Wake plane endpoint (#147, agent-comms ADR-0008 decision 8). `GET /v0/wake`
  upgrades to a WebSocket authenticated by the binding secret
  (`x-agent-binding`, or the `agent-binding.<secret>` subprotocol for clients
  that cannot set headers, echoed in the handshake), with no bearer and GET
  only. The daemon implements the server half of RFC 6455 itself: masked text
  frames, ping and pong, close, 125-byte control frames, and a 64 KiB frame
  cap in both directions. A protocol violation closes the socket and stops
  reading from it. Connected sockets are the warm pool, keyed by agent ID: a ready
  frame on connect, a ping every 30 s, and two missed pongs drop the socket.
  `/v0/health` and `agent-bot daemon status` report warm sockets per agent.

- Cold wake is opt-in per soul (#259, agent-comms ADR-0008 decision 9).
  `agent-bot soul cold-wake <agentId> [on|off|show]` is an owner-only setting
  kept in `~/.local/state/agent-bot/cold-wake.json` (0600), with a secret-free
  audit receipt. `createColdWaker` starts one executor turn in the soul's
  worktree with the soul's binding, naming only the waiting message IDs, and
  reports `cold` as soon as the turn starts; wakes that arrive during the turn
  merge into it, and the turn's end lands in a `finished` or `failed` receipt.
  With the setting off it reports `waiting`.

- Sessions arm a wake listener (#257, agent-comms ADR-0008 decision 8).
  `agent-bot wake listen` holds the session's WebSocket at the daemon's
  `GET /v0/wake`, authenticated by the binding, and prints one NDJSON line
  per frame (`connected`, each `wake`, `disconnected`, `stopped`). It runs
  under a persistent watcher such as Claude Code's Monitor, reconnects with
  capped backoff, re-reads the binding after a daemon restart, and only ever
  presents the secret to a loopback daemon. The new SessionStart hook
  `20-arm-wake` tells every bound session in bot territory to arm it. Hooks
  can now return advisory `context`, which reaches the model on dialects that
  have a context channel (Claude, Codex); readiness reports which do.

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
