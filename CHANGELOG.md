# Changelog

## Unreleased

## 0.10.7

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
