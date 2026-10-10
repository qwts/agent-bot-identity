# Changelog

## 0.10.60

- Souls can ask for one owner-approved write as the owner's GitHub account: the `request_grant` and `spend_grant` MCP tools ask the owner at keyd's presence prompt, then comment or request review once with the owner's narrow token from the pass-cli note `agent-bot.human/<login>-github-token`, after checking it belongs to `AGENT_BOT_HUMAN_LOGIN`. A missing token or another account refuses without using up the grant (#108).
- Identity code no longer imports soul internals for managed Apps, the secret-name check or `identity migrate-credentials`: the census reaches `identity apps` through a port its command line and the daemon wire, and the migrate command moves to a soul module. Commands, output and stored formats are unchanged; two crossings remain until the identity contract is decided (#645).
- ADR-0645 (owned modules and contracts first, then identity becomes its own repository) and ADR-0753 (owner-signed statements) are accepted (#645, #753).
- ADR-0645 records the owner's answers: amend ENG-0128, consume identity only over the daemon, ship agent-identity inside agent-bot (and so inside GeniusBar), and keep `claude`/`qwen` as canonical harness keys (#645).
- ADR-0645 (Proposed) is revised to the direction chosen on 2026-10-09: identity is extracted into its own repository, `agent-identity`, after its contract is reviewed; soul, harness and workflows stay here; agent-comms is not imported. The `agent-bot` command, labels and state paths stay (#645).
- ADR-0753's Answers section now notes the record was accepted, and that the relayed answers and acceptance are still not verified owner statements (#753).
- ADR-0753 (Proposed) designs owner-signed statements: `agent-bot owner sign` and `owner verify`, a key enrolled through owner presence, and a signed challenge as the fallback when presence is unavailable over SSH, remote hosts, CI and subagents. It records the owner's answers: statements are scoped to a repo and issue, expire within 7 days by default (30 at most), keys are enrolled with presence and distributed through the organization profile for offline verification, and up to four named keys are allowed (#753).
- `agent-bot identity app create`, `connect` and `rotate-key` keep a new App key in agent-bot-keyd as an App-level key when keyd is running, pinned and new enough; the App's record says `store: keyd` and its souls mint with `keyScope: "app"` grants. Otherwise the key goes to the file or Keychain store as before, and the output's `storeReason` says why. Apps already in a file or Keychain store stay there (#110).
- `agent-bot identity app assign` now refuses with `identity-app-busy` while a create, connect, rotate-key or remove of the same App is running, so nothing is assigned to an App while its removal waits for keyd; a keyd-held App's webhook-secret item is put back when the config write fails; and `identity app remove` names the real `.dpapi` files on Windows (#110).
- `agent-bot bootstrap --repair` restores a deleted `~/.config/agent-bot` runtime config without `--profile`: it reads the organization profile that the selected organization (`~/.config/agent-sop/config.toml` `[repos] org`, then `org.json` `organization.profile`) names, at the resolved commit, scopes it to the account's App, and reports the commit. A surviving config wins and `--profile` stays the override (#190).
- In a bound checkout, `agent-bot mint-token`, `signed-commit` and the gist handoff now get the soul's own App token from the daemon instead of reading a key locally. A request for another App, a `GH_AGENT_APP` override or `--permissions` from a caller with a soul marker (a binding, an Agent ID or a stated App) goes through the owner gate (Touch ID, else the administrator dialog) and leaves a receipt; a decline or a headless run mints nothing. The daemon also refuses a token to a retired soul (#775, #783).
- Comments and the soul-builder follow-up list no longer describe the reach server as `agent-bot` or Devin MCP tool mapping as open (#378).
- The census records `lastSightedAt`, set only when a bind, re-bind, daemon soul-home launch or `setup-worktree` (and so the session-start hook) sights a live session; `agent-bot population list` and `agent-bot doctor` now show which souls are present (sighted in the last 24 hours) and which are historical (#109).
- `AGENT_BOT_DAEMON_STATE_PATH`, which names the file holding the daemon's bearer, no longer reaches soul harness turns, the reach server, keyd's relay or agent-comms; they all reach the daemon on the soul's binding. The daemon's spawn hooks and `agent-comms join`, the `npm ci` that installs a soul's harness adapter, and the git calls `soul env export` makes in a soul's workspace now run inside the same child boundary instead of the caller's whole environment (#785).
- Soul harness turns, the reach server and the uv runtime installers no longer inherit the daemon's whole environment: only PATH, HOME, locale, terminal, proxy and CA settings, the harness's host-store paths and agent-bot's own non-secret `AGENT_BOT_*`/`QWTS_*` configuration pass, so a host's cloud keys, `GITHUB_TOKEN`, `SSH_AUTH_SOCK` or `NODE_OPTIONS` stop reaching agent-controlled code. A soul's declared provider secret still reaches its harness; a soul that relied on a provider key exported in the daemon's shell now needs `agent-bot soul secret set` (#780).
- A bind run as another App updates the soul's record when the organization profile maps its harness to that App, or once you verify the change with Touch ID; an unverified claim leaves the record alone and the bind still succeeds. The daemon also mints only for a soul with a transcript locator. Each outcome leaves a receipt (#107).
- A test now pins that a soul woken cold after a daemon restart still sees its conversation with the same person, and that another soul or another person never does (#596).
- A host can rename its credential items and pass-cli vault with `AGENT_BOT_CREDENTIAL_NAMESPACE` and `AGENT_BOT_CREDENTIAL_VAULT` in the daemon's service unit; every Keychain, pass-cli and import path follows them, a miss never falls back to the default names, and unset keeps today's names (#676).
- `agent-bot doctor` warns when this shell's `AGENT_BOT_CREDENTIAL_NAMESPACE` or `AGENT_BOT_CREDENTIAL_VAULT` differs from the daemon unit's, and `agent-bot identity migrate-credentials --from-namespace OLD` copies App keys, provider secrets and managed App keys from an old credential namespace to the current one, reading each copy back and never deleting the old items (#676).
- Credential mint receipts now name the App (`appSlug`) and a fixed `reason` code, and `agent-bot mint-token` run by an operator leaves a `credential-mint` receipt too, so the audit log accounts for operator mints (#107).
- `agent-bot doctor` reports which key store each configured App's key is recorded in, and warns when a legacy `~/.config/<slug>/private-key.pem` remains, pointing at `identity migrate-credentials`; no store is read and the key file is never opened (#110).
- The soul environment descriptor advertises dream status and notice acknowledgement capabilities so clients can discover supported interfaces without conflating them with current daemon health (qwts/GeniusBar#341).
- Dream report previews now live in a private per-soul store outside the dream journal, which keeps only their digest, and only the newest 20 per soul are kept. Older journal records keep their inline previews unchanged (#603).
- Dream restart recovery now checks the process group that an earlier daemon recorded before its first prompt. A group that is provably gone settles as `interrupted`. A live group that is provably the daemon's own is stopped with the usual termination ladder. Anything ambiguous stays `recovery-required` and is never signalled. Windows still reports `recovery-required`. Scheduler state moves to version 7 (#603).
- Publish an owner-visible `recovery` dream notice in the same transaction that quarantines a run restart recovery cannot settle. Scheduler state moves to version 6; versions 1–5 migrate on the next write (#603).
- The installed harness hook adapter always runs the agent-bot hook runner, so the built-in identity and confinement checks apply even when a repository has no hook for the event. A missing or non-executable runner now fails the hook instead of allowing it (Codex Security finding `project-hook-fast-path-skips-builtins`).
- An explicit `GH_APP_HOOK_INBOX_TOKEN` in the daemon's own environment wins over the pass-cli inbox note again; `inbox-take` receipts record `bearerSource` (`env` or `pass-cli`), never the bearer (#229).
- `inbox-take` receipts now record `bearerSource: pass-cli` when reading the pass-cli bearer fails, and a rejected `GH_APP_HOOK_INBOX_TOKEN` tells you to restart the daemon after changing it (#229).
- `take_inbox` now goes through the daemon's new `/v0/inbox/take`, so no session holds the fleet-wide inbox bearer. The daemon reads it from the pass-cli note `agent-bot.inbox/gh-app-hook-inbox-token` for each take, takes for the bound soul's own App and worktree repository, runs takes for one App and repository one at a time, and leaves an `inbox-take` receipt. `daemon install` writes `GH_APP_HOOK_INBOX_URL` into the unit, and `doctor` no longer looks for `GH_APP_HOOK_INBOX_TOKEN` in the shell (#229).
- agent-bot-keyd can hold App-level keys, one per GitHub App shared by every soul acting as it: new `owner/app-import`, `owner/app-remove` and `owner/app-status` messages, and a grant's optional `keyScope: "app"` mints with that key. Per-soul keys and messages are unchanged; agent-bot starts using App-level keys in the next slice (#110).
- `agent-bot identity app create` into agent-bot-keyd now keeps the webhook secret GitHub returns, in its own Keychain item `agent-bot.app.SLUG.webhook` or file `github-app-SLUG.webhook.json` (`webhookSecretKept: true`), and `identity app remove` removes a keyd-held App through keyd's owner prompt (`owner/app-remove`); a key keyd holds for an App with no record here is removed only when named, and the result says `orphan: true` (#110).
- agent-bot-keyd stamps an owner-presence assertion when the owner answers rather than when the request arrived, so a Touch ID approval slower than 90 seconds is no longer refused as expired; keyd's tests now cover the daemon-key pin, single-use grant nonces, the 1–64 import limit and the presence lifetime (#594).
- New [keyd protocol](docs/keyd-protocol.md) page records the current keyd grant, owner-presence and key-pinning behaviour with an invariant-to-test matrix, and lists the open owner decisions (#594).
- agent-bot-keyd's Rust source now lives in this repository under `keyd/`, built and tested unsigned in CI on a GitHub-hosted macOS runner; GeniusBar still signs and ships the binary (#767).
- agent-bot pins keyd's presence key only from a binary signed by the configured Developer ID team on the `agent-bot-keyd` identifier, not from any Developer ID signature. The Team ID has no built-in default: an organization profile names it (`settings.keyd_team_id`), or `settings.keydTeamId` / `AGENT_BOT_KEYD_TEAM_ID`; with none set, owner actions use the administrator dialog. Pinning under `any-developer-id`, or under another signer than the last pin, asks the owner first and is receipted. The keyd protocol doc records the owner's decisions (#594).
- `agent-bot` forwards expanded launch progress stages and stable failure codes so callers can track setup and branch on causes (qwts/agent-comms#129).
- A daemon-run turn now picks its model in the settings order: the owner's `soul model` pick, then a model named in the repo's own harness file, then the soul package's declared `model`, so a soul working in a repo keeps its package's model when the repo names none (#379).
- The identity service can hold narrow delegation grants: a soul asks for one named write (an issue comment, an issue's state, or a review request), the owner approves that exact write with Touch ID through agent-bot-keyd, and the grant is spent once with a receipt. Approve and merge can never be granted (#108).
- A session that stated a bot identity is now refused a git command that skips the git hooks: `--no-verify` or `commit -n` on a commit or push, a `core.hooksPath` override for it (`-c`, `--config-env`, `GIT_CONFIG_PARAMETERS`, `GIT_CONFIG_KEY_n`), or a `git config` write of `core.hooksPath`. Those hooks back up the pre-command check for git it cannot see. `git merge`, `rebase`, `cherry-pick`, `revert`, `am` and `commit-tree` now count as commits, so an unbound checkout is refused them as it is `git commit`. The human's delegate and ordinary human shells are unaffected (#749).
- The stated-bot hook-bypass refusal now also covers a bypass that reaches a pinned checkout from elsewhere (including `git config --file`), `git config` section removes and renames that drop or set `core.hooksPath` in any argument order, and commits whose path or message reads like `--abort` or `--quit`: a sequencer control counts as one only on its own (#749).
- A session that stated a bot identity but whose checkout is not bound is now refused scripts, interpreters and task runners (`node`, `python3`, `npm`, `make`, a stdin-fed shell), which could run git the pre-command check cannot see and commit as the human; a bound bot, the delegate and a human shell run them as before (#777).
- Outside contributors get a `SECURITY.md` with a private reporting path, a `CONTRIBUTING.md` section for plain fork-and-PR work with hermetic test instructions, and CI that always runs pull requests from forks on GitHub-hosted runners, never a self-hosted one (#752).
- When a repo or soul package asks a daemon-run soul for Auto-Pilot and you have not picked a mode, the daemon now asks you once with Touch ID or your password (no administrator dialog, so the daemon never blocks), remembers your answer for that exact file, and asks again only when the file changes; when keyd can't ask, the turn stays in Safe (#379).
- A principal's interactive turn (a `/v1` message) is now checked against the SOP persona record before its harness runs, like every other turn. On a stale record it asks you to verify (Touch ID or the dialog) and goes ahead once you do; an unavailable record still refuses. `agent-bot doctor` gains a `sop.persona` check that tells you to run `agent-bot sop persona` when the record is legacy, stale or missing (#613).
- The recorded SOP persona mapping now counts only for the exact selection it was made from (config file, org and sop ref, and a 40-hex pin's commit), and the daemon checks it again at the start of every launch, wake, task and dream turn. When the record is stale, the owner's own launch asks the owner to verify (Touch ID or the dialog) instead of being refused, while a soul's turns and team starts are still refused. Run `agent-bot sop persona` once to refresh a record made before this change (#613).
- A principal's turn whose persona policy cannot be checked at all (for example, the runtime config became unreadable) now leaves a `turn-refused` event like any other refusal. `agent-bot doctor` reports a recorded but invalid `persona.toml` as unavailable, with the fix, rather than ready (#613).
- `agent-bot soul skill learn UUID --soul AGENT_ID --candidate DIGEST ...` applies a reviewed portable source-check candidate: it refetches the source, requires the reviewed digest, and proposes the update through the existing soul revision policy (#312).
- Re-pinning keyd's presence key over a corrupt `presence.pub` now also makes the file owner-only (0600); before, a replaced file kept its earlier mode (#594).
- `agent-bot principal enroll`, `bind`, `allow` and `revoke` now ask the owner before they change who can reach a soul: a soul is refused, and the owner approves with Touch ID, the login password or the administrator dialog, or presents a principal credential with `--principal-stdin`. Before, any process in the owner's account, a soul included, could enroll a principal and allow it every soul and operation (#779).
- Daemon turns now resolve the permission mode in the owner's settings order (GeniusBar or `soul mode` pick, then the repo's harness file, then the soul package), and a loosening nobody picked stays in safe mode with the code `permission-mode-loosening-needs-owner`; `docs/soul-builder.md` documents the order (#379).
- `soul skill` import, list, show, verify, check, update and learn results and `soul revision skills` now carry a `notCaptured` statement: only agent-bot's own commands capture and recheck instruction files, and anything a harness fetches or reads on its own (web fetch, MCP tools) is not captured. A boundary test pins this (#312).
- `agent-bot sop policy show|activate|deactivate` lets the owner pin the SOP pack's `policy-hooks.json` at its resolved commit, and the daemon now applies its deny rules to launches: a soul starting its team is refused, while an owner's launch that a rule denies asks for Touch ID or a password and goes ahead on approval, with an audit receipt either way (#677).
- A soul's file tools can no longer write the owner's SOP policy state (`sop-policy/`), even with confinement off, and `agent-bot doctor` now reports whether an SOP policy is active, at which pinned commit, or why it is unavailable (#677).
- Identity reads which soul declares a GitHub App through a read-only soul contract, `soul-app-declarations.mjs`, listed under `contracts` in the module map. The ADR-0645 boundary baseline is now empty (#645).
- A soul's life export now carries its own interaction records: its sessions, invocations, event logs and message payloads, but never another soul's. A moved or replaced life merges them back into the new host's store without overwriting anything already there, and a fork keeps them as the parent's read-only history (#583).
- `agent-bot soul skill install UUID|NAME --soul ID` copies a library skill into the soul's own `skills/` with a file-hash record, and `soul skill uninstall NAME --soul ID` archives it inside the soul (`--trash` moves it to the OS trash, owner only), so skills load from the soul instead of global harness folders (#603).
- New managed souls keep Codex's config, sign-in and sessions in their own tool home (`CODEX_HOME`), so two souls can run Codex against different providers. A per-soul `.soul-state/tool-homes.json` entry (`soul` or `global`) overrides this per harness. Existing souls keep their current setup and nothing is moved (#617).
- `agent-bot soul tool-home <harness> [soul|global] --soul ID` shows or sets where a soul's harness keeps its config, sign-in and sessions. The owner sets it through the owner gate, and a soul can set its own, proven by its live binding; a soul switching to the shared `global` store asks the owner first. Every change writes a receipt (#617).
- When no agent-bot runtime is installed, `scripts/ensure-identity.sh` now tells you to run `./agent-bot bootstrap` from an agent-bot-identity source checkout instead of `node install.mjs`, which installed the CLI without the organization profile or credentials; the organization operations links now point at their new home in `qwts-agent-org` (#104).
- A session that stated a bot identity (`GH_AGENT_APP`, a checkout pin, or an agent account) but whose worktree setup failed is now refused `git commit` and `git push`, with a message naming the setup failure and the fix. Before, it silently committed as the human. The installed runner's pre-command check enforces this in every harness dialect, and so do `hooks/pre-commit` and `hooks/pre-push`. The pre-command check follows the repository git will actually write (`cd`, `-C`, `--git-dir`, `GIT_DIR`, aliases) and reads shell quoting and escapes the way the shell does. A checkout counts as bound only when the commit's author and committer are exactly the stated `<slug>[bot]`, so a decoy `[bot]` name or an `--author` or `-c user.name` override does not pass. When a stated bot's command reaches a repository the check cannot place, it is refused. The human's delegate, which states no identity, and ordinary human shells are unaffected (#749).
- An `issue-state` delegation grant now closes or reopens the issue or pull request as the owner's account. Before, it could be granted but refused with `grant-unsupported` when spent (#108).
- Correct generated MCP server names in harness evidence and clarify that life
  archives carry interaction records while imported native sessions remain
  non-resumable (#378, #583). The skill lifecycle guide now distinguishes the
  implemented dream scheduler and owner controls from remaining retrieval
  adapters and unverified semantic-processing coverage (#603).
- The Codex desktop app's Pull Requests UI now leaves a secret-free `credential-mint` receipt (operation `codex-desktop-gh`) for each GitHub App token it mints. The mint still runs locally with no prompt, since that UI is the owner's own delegate surface and not an agent session (#107).
- The daemon comms client now verifies the pinned broker identity over the Windows named-pipe handshake before sending pairing or daemon credentials. The pipe connection explicitly limits OS impersonation before that handshake. Windows pairings persist the account SID and broker key, and wake, watch, and launch operations reuse that pin. Its existing PKCS#8 vouch key keeps its path and create-once identity, with SID ownership and private-file ACL checks before reading or writing key bytes. New private state receives its SID owner and protected ACL at creation; existing keys and exclusive-create collisions are never overwritten. A native Windows CI preflight checks custody and pipe primitives using disposable state (#813).
- Daemon turns apply declared repo or soul reasoning effort through the pinned adapter's supported ACP options, while preserving Codex composite owner model picks (#379).
- When a new soul's first turn finds its harness signed out, the reply now includes the exact `agent-bot harness auth login HARNESS --soul ID` command when that harness has a supported sign-in flow (qwts/agent-bot-identity#536).
- `keyd` help, the keyd App-key status hint and the sandbox pairing step now say "the host app" instead of GeniusBar. Installed names don't change: the `geniusbar-agent` account, the `app.geniusbar.*` labels, `/Applications/GeniusBar.app` and the `QWTS_*` aliases all keep working. The organization-value guard now catches GeniusBar/Dudles stems joined to identifiers and scans shipped JavaScript, shell, keyd Rust source and Cargo metadata while ignoring comments and Rust test-only modules. The test fixtures use `example.invalid` instead of the qwts inbox host (#752).
- `take_inbox` reads its shared bearer from the configured vault's named password field through the audited Proton Pass path, while preserving the daemon-only environment override (#229).
- A new App key may go to agent-bot-keyd before its daemon key is pinned: `owner/app-status` reports `pinned` and `held`, and the `pins: true` availability hint means the first App import will pin this daemon key in the same owner prompt. Success reports `daemonKeyPinned: true`. An owner decline happens before keyd writes its first pin or App key; after consent, a later import error may leave keyd state behind. `connect` does not locally fall back on a non-version import error; `create` keeps GitHub's one-time key in file/Keychain with a reason (#110, #817).
- agent-bot now pins the agent-bot-keyd version it is built with (0.2.0): `agent-bot keyd status` and `agent-bot doctor` (`keyd.version`) warn with the update to make when the running keyd is another version (#767).
- Kiro subagents can use explicitly declared MCP tools through exact per-tool selectors, keeping them supported without granting every tool from a server (#378).
- The reach server's `agent-comms` calls now run under the same child-env boundary as the daemon's own. Before, a desktop harness's whole environment, including any token or the daemon state path, reached the broker client. The broker location settings (`AGENT_COMMS_SHARED_DIR`, `AGENT_COMMS_SERVICE_LABEL`, `AGENT_COMMS_BROKER_STATE_DIR`) still pass. A test now lists every `child_process` call site with the reason its environment is what it is (#785).
- `agent-bot identity migrate-credentials --from-vault OLD` copies pass-cli notes from a host's old `AGENT_BOT_CREDENTIAL_VAULT` into the vault it uses now, alone or together with `--from-namespace`; it is owner only, reads each copy back, never overwrites a different value and never deletes the old notes (#676).
- Agent-bot accepts the `junie` and `commandcode` organization-profile harness keys and resolves their active App identities from the rostered account name, without adding environment detectors (qwts/qwts-agent-org#39). Deploy a compatible runtime before publishing these profile keys, and provision/install both GitHub Apps separately.
- A new test fails when shipped runtime code compiles in qwts's own values (its owner account, App slugs, organization repositories, host or GeniusBar's signing team), so organization values stay in the organization profile or config as the runtime goes open source. The only one left is the `ai9d` unmanaged-author fallback, which #713 removes. The README now describes `agent-bot skill`'s catalog as the selected SOP's rather than qwts's (#752).
- Owner-gated CLI actions can use a one-time signed challenge from an enrolled SSH key
  when local presence is unavailable; enrollment and removal retain their existing
  consent gate (#753).
- `agent-bot soul resume` (`POST /v0/soul/resume`) now asks the owner (Touch ID or the password) before lifting a pause, because the daemon bearer only proves a process in this account. An enrolled transport principal with `cancel` resumes as before; pause and stop never prompt. `docs/daemon-api.md` now classifies every daemon route, and a test checks a bearer-only caller is refused on each owner route (#785).
- `agent-bot owner verify` checks an owner-signed statement offline against the owner keys pinned on this host, so agents can tell a real owner decision from an agent's claim of one; `owner enroll --store ssh` (owner gate plus a proof of possession), `owner sign`, `owner keys` and `owner remove` manage the ssh security-key store, and the keyd store and challenge fallback follow (#753).
- The resume wake lane now runs a soul's harness in its own tool home, as ACP turns do. Each recorded session notes the store it was made in, and a session in the other store is refused with `resume-session-store-moved` and the `soul tool-home` command that switches back, instead of silently starting fresh (#617).
- `agent-bot sandbox export --verify` now refuses a copied manifest that is a link, not a regular file, too large, or readable by others, and leaves an audit receipt for every refusal. `--skip` is refused on `--resume` for a category the drop already holds, and the printed copy now runs `chmod 700` on both exports folders (#750).
- `agent-bot sandbox remove [ACCOUNT] --dry-run` lists what removing a persona account would touch, with the action each category gets under the keep-by-default plan: export, remove after export, mark retired, list only or a manual step. It changes nothing (#750).
- `agent-bot sandbox export --for OWNER` exports a persona account's souls, orphaned workspaces and harness transcripts to a private drop folder, with one owner-gated confirm per category and a manifest of SHA-256 hashes. A failure stops and can be resumed with `--resume`; nothing is removed. It prints the `sudo` copy for the owner to run, and `agent-bot sandbox export --verify ACCOUNT` reads every copied file back in the owner's account before reporting success (#750).
- The SOP launch policy's daemon wiring is now one tested port, and tests prove a refused policy launches nothing on every route the handler covers: an existing soul, a package spawn, an installed-folder relaunch and a copied-folder fork (#677).
- `agent-bot soul skill load NAME --soul AGENT_ID --workspace WORKTREE` copies an installed skill into one of the soul's worktrees at the harness's skills folder (`.claude/skills/<name>/` by default) while the work needs it, keeping it out of commits through the repository's local `info/exclude` rather than its `.gitignore`; `soul skill unload` removes that copy and refuses one edited in the workspace (#603).
- `agent-bot soul tool-home <harness> --soul ID --fresh-session` starts a new resume session in the store a soul's harness uses now, after a tool-home move. The old session is set aside, kept with its store and transcript, never deleted. The soul can run it for itself and the owner for any soul (#617).
- `soul env` now advertises `tool-home-set` separately from `tool-homes`, so
  hosts can discover setter support without relying on an engine version
  (qwts/GeniusBar#340).

## 0.10.59

- `doctor` adds `worktree.app_record`: it warns when a checkout acts as an App (through `GH_AGENT_APP`, the pin or the account) that its soul's identity record does not name, since the daemon mints the recorded App for a bound soul and refuses any other. Diagnosis only: the explicit App keeps working until #107 closes in-process mints, and the row points at #107's migration contract (#107).
- Credential item names (Keychain services and accounts, pass-cli note titles and vault, and the store names doctor and `identity apps remove` print) are now built in one place, `credential-names.mjs`. Every stored name is unchanged; this prepares host-owned namespaces (#676).
- The daemon's client (`daemonClient`, the state-file reader and health probe) moves out of the `agent-daemon.mjs` process host into `daemon-client.mjs` in the identity module, so identity and soul modules reach the daemon without importing the host; six cross-module imports leave the boundary baseline. `agent-daemon.mjs` re-exports `daemonClient` and `daemonStateFile` unchanged (#645).
- `daemonStatus` (now `daemon-status.mjs`) and the agent-comms join/leave helpers (now `comms-membership.mjs`) move out of the `agent-daemon.mjs` process host, and the soul PATH helpers into `shell-path.mjs`, so no soul module imports the host any more; four more cross-module imports leave the boundary baseline. `agent-daemon.mjs` re-exports every moved name unchanged (#645).
- Devin CLI subagents rendered from a soul now spell Claude's `Write` as Devin's
  `edit` tool (Devin has no `write` tool name, so such a subagent previously lost
  its declared write access), and keep a declared MCP tool's exact
  `mcp__<server>__<tool>` name instead of reporting the subagent unsupported
  (#378). Kiro and other adapters are unchanged.
- Prevent an early archive download failure from leaving a partial file on Node 20: the private output file now opens before streaming begins, so an asynchronous open cannot recreate it after cleanup. Hash verification and exclusive creation remain unchanged (#617).
- Add bounded, read-only dream input capture that verifies the current format-2
  package revision from the captured bytes, supplies definition and skill text
  with exact digests and stable pagination, and reports unsupported memory and
  conversation readers. Oversized or unsafe packages refuse capture.
- Add `agent-bot soul skill dream --soul SOUL` with `--schedule PT<N>H`, `--status`, `--history`, `--run-now`, `--pause`, `--unschedule` and `--cancel RUN_ID`. It is a client of the daemon's owner-gated dream routes, refuses soul callers and never runs maintenance in process. Status and history show only the named soul and always report unverified maintenance coverage (#603).
- Let internal dream turns reuse the configured cold executor with caller
  cancellation and a distinct facts-only history kind/ID. Wake defaults, tool
  approval policy and shared stop/pause tracking remain in force. This does not
  activate a dream job or expose a new command (#603).
- Preserve an applied dream control result when its later audit append fails, and report audit uncertainty separately through the API and CLI. A failed control retains its original error; authorization audit failure still prevents execution (#603).
- Record dream-control owner authorization before executing the operation, retaining the approval when a control fails and recording its outcome separately (#603).
- Compose dream scheduling into the daemon with a private durable journal,
  strict owner-authorized controls, bounded source capture and the existing
  configured ACP execution/approval path. Shared stop and shutdown retain
  unsettled leases, and restart quarantines unverified child ownership. Status
  explicitly reports execution facts with unverified maintenance coverage.
- Persist bounded, text-free dream input metadata before harness launch, retain preparation receipts through execution failure and recovery, and read older journals without rewriting history (#603).
- Persist bounded dream reports and independently checked revision evidence atomically with terminal execution facts, while retaining unverified claims, truncation and unsupported adapters explicitly (#603).
- Persist deduplicated dream notices atomically with terminal run facts in scheduler state v5, show each soul's live notices in `soul skill dream --status`, and add the owner-gated `--ack-notice` control. Notices are host-read only (#603).
- Derive deduplicated, host-read dream notices from terminal run facts and validated outcomes, without delivery claims (#603).
- Bound accumulated dream replies to 256 KiB before outcome parsing, retain a UTF-8-safe prefix, and explicitly report truncation (#603).
- Add a bounded, read-only verifier that checks a soul proposal or revision
  against the revision journal and both stored packages, reporting whether it
  changed only sources a maintenance run was delivered. It never establishes
  model attribution or review coverage (#603).
- Persist bounded dream selection checkpoints atomically with validated outcomes and terminal run facts. Subsequent runs rotate captured pages across restarts, verify the saved cursor against its preparation receipt, retry failed attempts, and revisit blocked or missing items after wrapping. CLI status distinguishes selection progress from unverified processing coverage (#603).
- Preserve a dream executor's successful settlement after cancellation was
  requested, while keeping its shared turn busy until settlement. Pass a cold
  caller's shorter execution deadline into the shared registry without allowing
  it to extend the host bound; ordinary wake cancellation behavior is unchanged.
- Internal: soul ID derivation (`soul-genesis.mjs`) is identity-owned and hashes a shared `canonical-json.mjs`, removing the `agent-identity -> soul-genesis` module crossing (#645). Revisions and derived IDs are byte-identical.
- `docs/gh-app-hook.md` now states that the inbox bearer is fleet-wide rather than per-App, and adds troubleshooting: non-destructive probes that tell the two 401 causes apart, re-arming a webhook GitHub disabled, and secret rotation (#230).
- Harness availability at launch now requires a regular executable file: a bare command must resolve to one on PATH (a directory or non-executable file of that name no longer counts), and an absolute registry command must exist and be executable. Otherwise the launch is refused with `harness-tool-missing` before anything is minted (#536). Adapter rows installed into the soul and declared harness downloads are unchanged.
- `agent-bot harness auth status|login` now reports `status` (`signed-in`, `signed-out` or `unknown`) and a `reason` when unknown (#536). A missing CLI, a timed-out probe or output the reader does not recognise is `unknown` instead of being reported as signed out; `signed-out` now needs positive evidence from the harness (Codex's `Not logged in`, OpenCode's zero-credentials line). `loggedIn` is unchanged for existing callers: true only when signed in.
- `agent-bot identity` now runs from `cli/identity.mjs`; running `agent-identity.mjs` directly serves only the git hooks' `current`, `show` and `record` (same output) and points other commands at `agent-bot identity`. Identity no longer reads soul packages: callers pass the package revision for genesis-derived IDs (#645).
- Resume `/v1` ACP conversations from their persisted, ownership-checked native session binding; report unsupported continuity and overlapping turns explicitly instead of silently starting over (#596).
- `agent-bot keyd install|uninstall|status` now runs from `keyd-supervisor.mjs`, beside the daemon supervisor. Commands, flags, output and the launchd unit are unchanged; `keyd-client.mjs` keeps the protocol and grants (#645).
- A launch refused because its harness can't start now carries a stable code in the launch journal and the failure detail: `harness-unknown`, `harness-disabled` or `harness-tool-missing` (#536). The message is unchanged after the code prefix. `harnessLaunchProblem` still returns the message alone; `harnessLaunchRefusal` returns `{ code, message }`.
- A daemon launch probes the harness sign-in at a `sign-in` stage before the soul joins, with the exact environment the harness turn gets (#536). A positive sign-out of an existing soul fails the launch with `harness-signed-out` and the `agent-bot harness auth login` command. A new soul or an `unknown` probe continues, and the evidence is kept in the launch journal.
- `agent-bot harness auth status|login --soul` now runs with the soul's runtimes and routed tool home, so for a soul whose store is routed into `.soul-state/tools/<harness>` it reads and signs in to that store instead of the host's (#536, #583). The turn-environment composition is now one function (`turn-env.mjs`), shared by the executor, the launch probe and this command.
- The sign-in probe and `harness auth login` spawn the harness CLI with the turn spawn's env (row `stripEnv`/`setEnv` through one shared `harnessProcessEnv`) and on the first Node on the soul's PATH. The host's Node is no longer put ahead of a soul's declared Node (#536).
- The engine runs an installed ACP adapter on the first Node on the turn's PATH, a soul's declared Node before the daemon's, matching the sign-in probe (#536, #617). `whichOnPath` accepts only regular executable files.
- Report locations of legacy `mcp__agent-bot__` references during soul build/check so authored rules can be reviewed after the reach server rename, without rewriting policy, exposing matching text, or failing a clean build (#378).
- Add `soul skill import PATH`, `list`, `show UUID`, `verify UUID` and `check UUID` for a local skill library. Imports preserve supporting bytes and executable modes under independent UUIDs; source checks retain candidates and compare them without overwriting accepted snapshots or local edits. Bounded acquisition refuses escaping links and special files, and records the limited Markdown dependency coverage. Remote acquisition, adoption and installation remain separate work (#603, #312). See `docs/soul-skills.md`.
- `agent-bot mint-token` now runs from `cli/mint-token.mjs`; the flags, the owner-approval ceremony and the stdout format (plain token or the `--json` object) are unchanged. `node mint-token.mjs` run directly now refuses with "run agent-bot mint-token" and mints nothing; the module stays the minting library (#645).
- The owner gate no longer reaches into comms or the soul census itself: the broker check for `--principal-stdin` lives in `owner-principal.mjs`, and `owner-action.mjs` wires it, plus the soul names shown in Touch ID and consent prompts, for every gated command. `agent-bot identity apps|app|addon` and `identity migrate-credentials` now run from `cli/`. Prompts, flags and output are unchanged. A caller that presents a principal without the wiring is refused rather than checked less (#645).
- Launches now fail closed when the configured SOP persona policy cannot be evaluated (ADR-0274, #613): a selected SOP whose mapping is unrecorded, or an unreadable or invalid config, record or `persona.toml`, refuses with `persona-policy-unavailable` (run `agent-bot sop persona`), a record for another repository with `persona-policy-stale`, and a pack decision to sandbox while `persona-accounts` is off with `persona-policy-requires-addon`, before anything is minted or started. No SOP and no `persona.toml` still leave the user setting in charge.
- Reclassify `agent-backfill.mjs` and `approval-action.mjs` as soul and `agent-approvals.mjs` as cli in the runtime module map, removing two identity-to-population crossings. No code, command or format changes (#645).
- Keep a registered soul's bounded cold-conversation journal under its durable history, preserve legacy context during migration and life export, and recover it after import. Environment inspection now identifies contained and legacy cold context (#583, #596).
- Add explicit portable source checks from accepted soul receipts, retaining unchanged, changed or unavailable results and bounded review candidates independently of the local library. Checks preserve accepted revisions and distinguish retained-file diffs from unbaselined candidate files (#312, #603).
- Recover bounded prior conversation context for unthreaded principal messages, including GeniusBar composer follow-ups, from the same soul's journal. Explicit thread links keep their scope; other principals, souls and unthreaded agent messages do not inherit the conversation (#596).
- Add isolated zero-SOP and selected-policy bind/chat/wake journey tests and an ADR-0274 conformance matrix that identifies remaining persona enforcement, policy extension, catalog, author-exception and host-naming gaps.
- `soul build` renders the `agent-bot` MCP entry for Qwen Code into `.qwen/settings.json`, merging through the soul's own Qwen settings and servers, so a soul home launched under Qwen Code reaches the daemon like the other harnesses. `.qwen/settings.json` is appended to the format-2 generated-path list; souls carrying the previous list still validate. Qwen asks once before starting a project-scoped server (`qwen mcp approve agent-bot`) (#247).
- Render the soul's MCP server as `agent-reach`, matching the daemon's injected server and permission rules. Rebuilds migrate unchanged, marked `agent-bot` entries across all supported MCP files, keep customized legacy entries and other settings, and refuse to overwrite a custom server already using the canonical name (#378).
- Re-binding an already-bound worktree now refreshes the soul's census `lastSeen`, as a first bind and `setup-worktree` already did, so a session that resumes on its existing binding shows as present. Only `lastSeen` changes; a missing or retired census row is never created or revived (#109).
- The resume wake lane (`soul cold-wake <agentId> resume <policy>`) now composes its environment through the same runtime and provider ports as ACP turns. A soul's declared runtimes and harness installs come first on PATH, and the harness CLI is resolved there, so a soul-installed harness runs instead of the host's. A missing, mismatched or unsupported declaration refuses the turn before any harness process starts, including Devin's session listing; the wake stays unacked and the recorded session is kept. Souls that declare nothing still run the host CLI. Tool-home routing on this lane is not applied yet (#617).
- A declared runtime or harness install is ready only when its executable is a regular file this account may execute. Previously a receipt-valid install whose `node` had lost its execute bit counted as installed. The ACP engine then skipped it on PATH and ran the daemon's own Node. That install now reports `missing` with "the installed node is missing or not executable" and refuses the turn or launch with `runtime-install-failed`. An archive whose declared executable is not executable is never published (#617).
- Readiness now checks only the executable name for the inspected platform: `node.exe` on Windows, the bare `node` everywhere else. A POSIX install whose `node` is unusable no longer counts as ready because a `node.exe` sits beside it (#617).
- Tests only: new fixtures prove that the daemon's interactive executor factory, ACP cold wake and launch handler share one runtime path. A soul's real `soul.json`, census row and install receipt are resolved by `soulRuntimeEnv`, as the daemon wires it. Every path spawns the harness adapter on the receipt-verified Node with the same env. A removed executable or a mismatched receipt refuses all three before any spawn. The resume wake lane is not covered and stays open on #617 (#617).
- `governance/runtime-modules.json` assigns every runtime file to one module (identity, soul, harness, comms, org, shared, host, cli) and states which modules each may import; `tests/module-boundaries.test.mjs` fails on any new cross-module import and on stale baseline entries, so the 31 crossings that exist today can only shrink. The test also pins the dependency policy to ADR-0645 and checks it has no cycles, keeps every credential-capable file (secret stores and providers included) in identity, and fails on an `import()` with a computed specifier unless the map lists it. Imports are found with a small lexer, so strings, templates, regexes and comments neither hide nor fake one. No runtime code, installed file or behavior changes (#645, ADR-0645).
- Runtime readiness now checks install receipts against the selected name, kind, version, platform and archive digest, and requires executables to resolve inside their soul-owned installation. Mismatches refuse host fallback; archive/Python repair preserves a conflicting same-version directory under a reported `.retained-<uuid>` path. Receipt checks do not rehash installed bytes or attest Python dependency integrity (#617).
- Recheck declared runtimes before every daemon ACP turn and refuse missing or unsupported installs, invalid manifests and lookup errors instead of falling back to host tools. Install stamps no longer report a runtime ready when its executable is missing (#617).
- Non-bundled `agent-bot skill` disclosure now uses `skills/README.md` at the explicitly selected SOP commit, with soul/user precedence and foreign-selection trust, instead of an implicit qwts catalog at its default branch. Missing selection/catalogs fail with actionable codes; remote JSON adds catalog provenance. Bundled skills, `path` and `--for` remain offline and unchanged. Existing explicit qwts selections keep their repository but now honor its selected pin; callers relying on the implicit default must configure an SOP. Remote content caching is deferred (#674).
- Move the organization profile schema, validator and runtime-config projection into `organization-profile-schema.mjs`, a shared leaf, so `config.mjs` and `detect-harness.mjs` no longer cross into the org module. `organization-profile.mjs` keeps external acquisition (`readOrganizationProfile`) and re-exports the schema, so no import or command changes (#645).
- Internal: the state-root resolvers (`stateDirectory`, `interactionHome`) and the relayed-turn correlation variable name now live in shared modules (`state-paths.mjs`, `reach-env.mjs`). The original modules re-export them, and paths and environment names are unchanged (#645).
- Document the proposed dream maintenance scheduler, owner controls, process recovery, bounded evidence, checkpoints and notice behavior for #603. No command or recurring maintenance is activated by this design document.
- Add an internal POSIX journal for the dream scheduler: publish state and history
as one revision-checked transaction, retain uncertain leases across process
interruption, and expose bounded history and capacity status. This adds no dream
CLI or daemon job. Windows and macOS sudden-power-loss guarantees are not claimed.
- Add the dream scheduling core with strict host-local state, atomic storage/execution ports, bounded dispatch, cancellation that retains unsettled runs, and restart quarantine. Daemon storage, owner controls and the dream CLI are not connected yet (#603).
- Keep successful dream execution marked completed when it races an abort request,
  retaining cancellation facts separately. Refuse different souls sharing a
  canonical directory across registrations and unsettled runs (#603).
- Import public GitHub skill-directory URLs at a resolved commit, preserving supporting files, modes and Git blob consistency receipts. Repository and linked-instruction acquisition share bounded transport; partial captures, LFS pointers, excluded/unsupported entries and public-API failures stay explicit (#603, #312).
- Import explicit public HTTPS skill documents and bounded inline instruction dependencies with exact-byte snapshots and original/final URL provenance. Remote source checks retain changed candidates separately and preserve accepted/local files on failure; private destinations, credential-bearing URLs and unsafe redirects refuse (#603, #312).
- Retain portable HTTPS origins, redirects, capture timestamps and repository revisions in version 2 learning receipts, bound to retained accepted bytes separately from local adaptations. Version 1 receipts remain readable without inventing missing provenance (#312, #603).
- Add `soul skill learn` guidance and outcome recording through the existing soul revision policy. Selected source pieces, captured dependencies and accepted originals remain inside versioned packages; file-verified adoption is separate from agent-reported knowledge work (#603, #312).
- Document the implemented skill import, source-update, learning and dream workflows in the README and bundled agent guidance, replacing obsolete unimplemented claims while preserving capture, authorization and remaining-feature boundaries (#603, #312).
- Retain valid imported instruction documents with explicit partial reports when nested acquisition fails or is refused. Charge failed attempts and response bytes to shared limits; incomplete rechecks retain reviewable candidates but report freshness unavailable without replacing accepted or local material (#603, #312).
- Skill source checks return a selectable receipt ID. `soul skill update` previews a three-way merge, applies only reviewed accepted/local digests, retains prior bytes, and recovers interrupted publication without changing soul or harness activation (#603, #312).
- Reject bidirectional formatting controls in policy denial reasons while preserving ordinary right-to-left text. Document duplicate JSON member handling and the required owner-facing diagnostics for future activation when the runtime's harness vocabulary changes (#677).
- Define the six selected-pack policy boundaries and add a bounded, data-only deny-rule parser/evaluator with fixtures. No activation command, persisted policy state or daemon enforcement is wired yet; bind, spawn, send, commit, push and wake/resume coverage remains explicit work under #677. The evaluator requires the host's actual canonical execution-harness vocabulary and refuses unknown or alias keys instead of silently missing a restriction.
- Provision declared soul runtimes before installing npm harness adapters in both managed homes and joined worktrees. A declared Node now runs the npm CLI from that same distribution, ignoring host npm overrides; missing Node/npm files and runtime provisioning failures stop installation instead of falling back to host tools (#617).
- Concurrent first-time soul creators no longer refuse each other's half-made Agent Space at the default root: `ensureSoulSpace` lets `initAgentSpace` decide under its per-soul lock, which still refuses an unmarked directory or another soul's space.
- Move the turn registry (`createTurnRegistry`) from `wake-plane.mjs` into `turn-registry.mjs` in the soul module, so `daemon-launch.mjs` no longer imports the daemon host. `wake-plane.mjs` re-exports it; behavior is unchanged (#645).
- The unmanaged-author allowlist (ENG-0128) can now come from configuration: `settings.unmanagedAuthors` in the agent-bot config, or `settings.unmanaged_authors` in an organization profile, which projects to it. `AGENT_BOT_UNMANAGED_AUTHORS` still wins whenever it is set, even empty. The committed git hooks and `doctor` read the same resolver, and `doctor` reports `unmanaged_authors_source`. A malformed list makes the hooks refuse. With nothing set, the hooks and `doctor` keep `ai9d` for now; that default goes once organization profiles carry the list (#675).
- On Windows, PATH lookup (`whichOnPath`/`onPath`) now resolves `name.exe` rather than an extensionless `name` that Windows cannot run. A name that already ends in `.exe` is kept as-is. This change covers the interactive, cold and launch turn lanes, the sign-in probe and default harness selection. POSIX lookup is unchanged (#617).
- npm `.cmd` shims are deliberately not matched, because `spawn()` refuses them without a shell. A Windows harness installed only as a shim is therefore reported missing rather than chosen and then failing at spawn. Executing shims and live Windows verification remain open in #617.
- Runtime readiness and PATH lookup now share one exported `windowsExecutable()` rule, so readiness can never accept a Windows file that the lookup would then skip. No behavior change (#617).
- A worktree created with `git worktree add` no longer silently keeps the pin git copies from the source checkout's `config.worktree`: another soul's Agent ID, App, bot author, bot credential helper or `commit.gpgsign=false`. The `post-checkout` hook removes the copied pin from a brand-new linked worktree unless it belongs to the session soul, which then configures the worktree as usual. `agent-bot setup-worktree --name` does the same for a worktree it adds. Keys agent-bot does not write are kept. `agent-bot doctor` warns (`worktree-pin-inherited`) when a linked worktree is pinned to a soul but holds no setup or binding state for it (#648).

## 0.10.58

- Agent onboarding now carries the GitHub App resolved from harness markers into new identities, and rejoining restores a missing App on existing hub-only identities without overwriting an assigned App, so configured agents can publish without manual per-session App assignment (#644).

## 0.10.57

- `agent-bot soul env history <soul> [--json] [--limit N]` lists the soul's history mirror (`.soul-state/runs`: turns and revisions, facts only, never a prompt or an output) newest first, at most `--limit` per file (1..500, default 50) from a bounded 16 MiB window, with line counts and skipped-line counts, so GeniusBar's Memory tab renders a soul's past without reading soul files itself; read-only, capability `env-history` (#583, GeniusBar#268).

## 0.10.56

- A soul's npm ACP adapter now installs under `.soul-state/runtimes/harnesses/<harness>/<version>/` with an install stamp, and `agent-bot soul env migrate <soul> --harnesses-into-runtimes` (also run by `--complete`) moves a legacy `.soul-state/harnesses` install there; the legacy location still launches until moved (#583 slice 8).

## 0.10.55

- `agent-bot soul env export <soul> --to FILE [--plan]` writes the soul's life as one archive (definition, home, tool state minus every sign-in file the tool-home registry names, memory, history, settings, revision journal, soul-owned workspaces whole, linked ones as a pointer with the patch and untracked files; never credentials, secrets, sign-ins, runtimes, caches or generated output), each path classified by the environment contract and hashed in the archive's `manifest.json`; `soul env import FILE [--fork] [--replace] [--plan]` restores it keeping the Agent ID, mints a new one with `--fork`, refuses an active local ID unless `--replace` (the existing root is moved aside, never deleted), verifies every entry before anything reaches the souls root and restores linked workspaces as pointers under `.soul-state/imports/` (readiness `workspace-unlinked`); capabilities `env-export` and `env-import` (#583 slice 7, ADR-0583 decision 10).

## 0.10.54

- Clarify the accepted harness and runtime contracts and their documented implementation limits: per-soul installs, integrity evidence, explicit overrides, and catalog version resolution (ADR-0276/ADR-0322; #622).
- `agent-bot soul env clean <soul> [--plan] [--component cache|temp|runtimes]` removes only what the environment contract classifies reconstructible or disposable (the cache, temporary files past their window, the runtime caches, a leftover install staging), never the definition, home, tool state, credentials, memory, history or a workspace; `soul env migrate <soul> --complete [--plan]` finishes every migration step still pending, interrupted or failed through the same mechanisms and journal; `agent-bot doctor` reports each active soul's environment problems from the same descriptor as one `souls.environment` check per soul; capabilities `migrate-complete` and `env-clean` (#583 slice 6, ADR-0583).

## 0.10.53

- A principal launch may name the new soul's `parent` (GeniusBar #261): `null` or absent starts an independent soul as before, an agent id must be an active soul in this account's census and not the launched soul itself, and the child is bound, censused and joined with that parent as a teammate a soul starts is, with a `team-start` receipt (`operation: launch`) on the parent. A relaunch keeps the parent its census row records; a different one is refused as a `failed` launch result, never written quietly. `soul env --json` lists `launch-parent` in `engine.capabilities` so a host can gate the form on it.
- Template provenance and maintained files (GeniusBar#287): `soul spawn` records `templateName` and `nameSource` (`template` when the owner kept the template's name, `user` when they chose one); a template may declare `previousNames` and `maintained` path prefixes. `agent-bot soul env migrate <soul> --template-name [--plan]` renames an instance that kept its template's name to the renamed bundled template's name in one package revision (and the census display name), never a chosen name, idempotent and journaled like the other migrations. `agent-bot soul template refresh <soul> [--from PATH] [--plan]` replaces exactly the template's maintained paths in the instance in one revision and updates `templateRevision`, leaving the owner's AGENTS.md, memory and history untouched. `soul env` capabilities gain `template-name` and `template-refresh`.

## 0.10.52

- `agent-bot soul remove <soul> --plan [--scope soul|team] --json` previews exactly which souls a remove would archive, make independent or leave unchanged, to any depth and whether or not they are awake, with capability flags (`restore` and `delete` are false) so a host never infers more than the engine does; the remove itself runs that same plan and reports it with its effects. `--scope soul` (the default) now clears the census `parentId` of the souls the removed soul led directly (audited as `soul-reparent`); `--scope team` removes every active descendant too, deepest first, refused before anything changes while any of them runs (GeniusBar #283).

## 0.10.51

- `start_soul` takes `model`, `provider` and `parent` (`"self"` or `"none"`) beside `name`, `harness`, `template` and `brief`, so a soul can start a new agent on a chosen harness, model and provider, as its teammate or as an independent root soul with no parent. The daemon validates each setting before minting anything: an unlisted model, an unknown or non-template provider, or another soul named as parent is refused with the fix, never replaced by a default; the result reports the effective `{harness, model, provider, parent}` (qwts/GeniusBar#261).

## 0.10.50

- A soul's memory and history now live in its folder (#583 slice 5, ADR-0583 decisions 8 and 9). A new soul's Agent Space is a real directory at `<soul>/.soul-state/space/` with the census `spacePath` naming it, and every reader (`agent-space path|show|export|retire`, the daemon's `/v0/space/path`, `soul env`, readiness, revision promotion) resolves through the census rather than `~/.agent-space` alone, and ensuring a space (`/v0/space/ensure`, bind, join, setup-worktree) hands back the census space instead of making an empty one under the root. An existing soul keeps its linked space untouched and `soul env` reports `memory-not-contained` with the new owner-gated `agent-bot soul env migrate <soul> --space-into-soul`: one soul per run, refused `space-migrate-busy` while the soul runs, copied into a staging inside the soul with modes, mtimes and symlinks kept, verified by path, size and SHA-256 (`space-migrate-verify-failed` leaves the link intact), switched in atomically, the census updated, the source retired as `<source>.retired-<date>` and never deleted; journaled in `.soul-state/migration.json` through `pending → copying → verifying → switching → done`, resumable from any phase, `skipped` when already inside, with a `soul-env-migrate` receipt that never carries contents. Each soul also carries an append-only history mirror under `.soul-state/runs/` (`turns.jsonl` from the turn registry and Claude session bindings, `revisions.jsonl` from the revision journal: ids, kinds, times, harness, outcome, reason; never prompts, outputs or secrets), written best effort and reported by `soul env` as `history.mirror`, `turns`, `revisions`, `mirrored`; the descriptor gains the `memory` and `history` capabilities.

## 0.10.49

- Each soul's harness state can now live in its own tool home, `<soul>/.soul-state/tools/<harness>/`: a launch sets `CLAUDE_CONFIG_DIR`, `CODEX_HOME` or OpenCode's `XDG_CONFIG_HOME`/`XDG_DATA_HOME`/`XDG_CACHE_HOME` to it (never `HOME`, never `XDG_STATE_HOME`), for the harness process and the reach and keyd MCP entries alike, with a `tool-home` launch stage that fails `tool-home-unwritable` when the directory cannot be made; kiro, muse and other harnesses with no documented store variable are reported `unsupported`, not faked. Containment is decided per launch from sign-in presence: a soul that holds its sign-in, or a host with none to lose, is routed (a new Mac is contained from the first launch); an existing host sign-in the soul lacks stays on the host store exactly as before, reported `shared-host`, until adopted. Existing sign-ins are adopted once with the new owner-gated `agent-bot soul env migrate <soul> --adopt-host-signin [--harness NAME]` (copies the named sign-in and state files only, 0600, never the keychain, journaled in `.soul-state/migration.json` with a `soul-env-migrate` receipt). `soul env` reports per harness `containment`, `routing`, `signIn` and `hostSignIn` by existence, warns `tool-signin-missing` with the adoption command, and gains the `tool-homes` capability. Nothing changes for a signed-in soul on upgrade; run the adoption for each existing claude, codex or opencode soul when you want it contained (#583 slice 2, ADR-0583 decision 5).

## 0.10.48

- `harnesses.<h>.provider` and `credentials.secrets.<name>` in `soul.json` give each harness of a soul its model provider (Codex `openai`, `github`, `openai-compatible`; Claude Code and OpenCode ids too): `soul build` renders Codex `model_provider` + `[model_providers.<id>]`, Claude's endpoint env and OpenCode's provider block, never a secret; the new owner-gated `agent-bot soul secret <soul> set|clear <name>` (value on stdin) and `soul secret <soul> status` keep the secret in the soul's declared store, and every launch injects it into that soul's harness process only, stripped from the reach MCP server and keyd relay, failing with `provider-secret-missing` and the fixing command when it is not stored; `soul env` gains `providers` and the `providers` capability (#583 slice 4).

## 0.10.47

- `agent-bot soul runtimes <id>` and `soul runtimes install <id>` provision the runtimes (`node`, `python` via uv, `go`) and non-npm harnesses a soul declares in `soul.json` into `.soul-state/runtimes/`, from a pinned, checksum-verified catalog, atomically and never on the host; launches route them first and install what is missing as a `runtimes` stage, with coded errors (#583 slice 3, #322).

## 0.10.46

- `agent-bot soul env <soul> [--json]` describes a soul's whole environment (schema 1: components with classification and retention, declared against installed harnesses and runtimes, launch routing, readiness problems, pending migration steps), served by the daemon at `GET /v0/soul/env`; `soul revision prepare <soul>` stages the editable definition under `.soul-state/tmp/` for `soul revision edit --apply`. The classification contract lives in `soul-env-contract.mjs`; ADR-0583 records the decisions (#583).
- On Windows, `agent-bot daemon install|disable` registers the identity daemon as a per-user scheduled task from an XML definition under `%LOCALAPPDATA%\<label>` (at logon, hidden, restarted every minute, kickstarted with `schtasks /End` then `/Run`), and the `file` credential store keeps souls' and managed Apps' keys as DPAPI-protected `.dpapi` files that only that account on that machine decrypts. Both go through injected runners, so the suite fakes `schtasks.exe` and `powershell.exe` on every platform. GeniusBar ADR-0046 decisions 3 and 4 (qwts/GeniusBar#46); see `docs/windows.md`.

## 0.10.45

- The SOP pack's persona mapping decides which souls run in their own macOS account (GeniusBar#66, ADR-0274 decision 3): `persona.toml` at the SOP repository's root maps souls by name (`[soul.NAME]`) or soul.json role (`[role.ROLE]`), with a `[persona]` default, to `sandbox = "sandboxed" | "unrestricted"` and an account. `agent-bot sop persona [--json]` records it online in `<state>/sop-persona.json`; `agent-bot sandbox status|resolve`, the override commands, `GET /v0/sandbox` and the daemon's launch path read the record offline and resolve the pack first (`source: sop`), then the soul's override, then the global switch. A pack decision never turns `features.persona-accounts` on: with the gate off it is reported with a `reason` while the soul runs unrestricted. An override on a pack-decided soul is refused naming the pack (`inherit` still clears one), and an unrecorded, stale, absent or invalid mapping leaves the user setting in charge and says so.

## 0.10.44

- `agent-bot` puts a host's `AGENT_BOT_TOOL_PATH` first on its own PATH, so the daemon's and the CLI's git calls use GeniusBar's bundled git on a Mac without the Command Line Tools, as the souls' harnesses already did (GeniusBar#102).

## 0.10.43

- soul.json `skills: { "disabled": ["name", …] }` switches a soul's skills off without deleting them (GeniusBar#64): `soul build` renders nothing for a disabled skill on any harness while its `skills/<name>/` directory stays in the package, `soul profile` reports `enabled` on every skill row and the declaration as `profile.skillsDisabled`, and a disabled name the package has no skill for is a profile error, not a validation failure. SOP skills are unaffected.

## 0.10.42

- `docs/gh-app-hook.md` is the gh-app-hook deployment and provisioning procedure `doctor` pointed at but which did not exist (#230): `wrangler deploy`, the three Worker secrets (`INBOX_TOKEN`, `WEBHOOK_SECRETS`, `SUBSCRIBERS`), the per-App webhook URL and secret, harness wiring and verification.
- `doctor`'s `inbox.configuration` counts a harness as wiring the inbox only when its MCP config runs the inbox server, `agent-bot mcp` (#247): a soul package's reach-back server, which is also named `agent-bot` but runs `reach-mcp` and has no `take_inbox`, no longer reads as inbox wiring. The stale launcher comment and the `agent-bot mcp` help line are corrected.

## 0.10.41

- `mint-token --permissions <name>=<level>[,...]` mints a least-privilege token (#213): each requested permission must be at or below the installation's grant, a request the grant does not cover is refused before the token request (naming what was wanted and what is granted), and without the option the token carries the whole grant as before. A keyd-held key refuses the option instead of ignoring it.

## 0.10.40

- `identity apps list` keeps each cached installation's grant (#213): `installations[].permissions` is the permission name → level map GitHub reported at connect or key rotation (`null` for a row cached before), the plain listing prints `installed:<account>(<selection>; <name>:<level>,…)`, and the docs say why that grant is not the bot user's collaborator role (which is what Dependabot commands check).

## 0.10.39

- `bootstrap` tells apart "no App resolves for this account" from "the account resolves an App but this checkout is unbound" (#190): in a rostered agent account a run outside a repository reports `checkout-unbound`, naming the account and its App and saying to run from the checkout (or `--machine-only`); `bot-identity-unresolved` stays for an account with no App and says whether the run was outside a repository. Both carry `evidence.account`, `app_slug` and `outside_repository`.
- `mint-token` checks its command line before minting (#213): `--help`/`-h` print the usage and mint nothing, `--app` needs a slug and is accepted once, and any other option is `unknown option: …` with exit 1 and nothing on stdout, so a mistyped flag never releases a credential.

## 0.10.38

- Per-skill manifests (#312, first slice): every skill in a soul package has a manifest of its files with a SHA-256 digest over each file's exact bytes, and `soul revision edit` and `propose` report the skills a revision added, removed or changed (added, modified and removed files per skill, where a one-byte edit, a line-ending change or an execute-bit flip counts). `agent-bot soul revision skills ID [REVISION [SINCE]]` prints a stored revision's manifests and what changed since its parent or any earlier revision. Manifests are a pure function of a stored revision, so prior captures stay addressable by revision; instruction-dependency capture and recheck are later slices.

## 0.10.37

- `agent-bot soul build` reaches more harnesses with a soul's MCP server and subagents (#378). Cursor gets `.cursor/mcp.json` and Kiro `.kiro/settings/mcp.json`, merged into any servers the soul already ships; Copilot CLI and Devin CLI are reported on the shared `.mcp.json` and `.claude/commands/` they read natively. Declared subagents also render as `.cursor/agents/<name>.md`, `.github/agents/<name>.agent.md`, `.kiro/agents/<name>.md` and `.devin/agents/<name>.md`, each in its documented front matter.
  - Tool allowlists are translated per harness; a subagent with a tool Kiro or Devin has no name for is listed under that harness's `unsupported.subagents` instead of being widened.
  - Cursor and Kiro commands, Gemini CLI subagents and Muse stay unsupported and are reported, with the reason and doc links in `docs/soul-builder.md`.
  - `.github/agents/`, `.kiro/agents/` and `.kiro/settings/mcp.json` are appended to the format-2 ignore list; souls carrying an earlier list still validate and build.

## 0.10.36

- `agent-bot skill <name>` now discloses any skill in the fleet catalog (qwts/qwts-agent-sop `skills/README.md`): the name must match exactly one entry, and its `SKILL.md` is fetched read-only from the owning repository at the entry's pinned commit. Absent, ambiguous, and unpinned names fail; a branch or tag is never followed, nothing is installed, and the bundled skills stay local and win. `agent-bot skill agent-bot --for <subcommand>` prints the one reference file for that subcommand from a static table, and `--json` now includes `repository` (#226).
- `soul build` renders a soul's harness `env` and permission `allow`/`deny` rules (#379, slice 2): Claude Code gets `env` and `permissions.allow`/`deny`, Codex gets `[shell_environment_policy.set]`, OpenCode gets its `Bash`/`Edit` rules in `permission.bash`/`edit`, and every rule a harness cannot express is listed per rule in `soul build --check --json` (`unsupported.permissions`). Secret-looking env names and values fail package validation, so a soul never carries credentials.

## 0.10.35

- `agent-bot identity app remove SLUG` forgets a managed App's local key, config record and doctor cache row, refusing while a harness or soul still uses it; `agent-bot identity addon github-identity on|off` switches the add-on; and `identity apps list --json` reports it as `addons`. Both are owner-gated and have daemon routes, so GeniusBar's add-on switch and Remove button can work (GeniusBar#67).

## 0.10.34

- A daemon launch now consults the soul's sandbox resolution (#376): an unrestricted soul launches as before; a sandboxed one whose persona account is missing or not set up fails at the `account` stage with the owner's next step and its command (`sandbox-not-ready`), before a package launch mints anything; and a ready one runs only on a daemon in that account, since the executor starts harnesses as its own user (`sandbox-other-account`). The launch journal and result carry `sandbox: { resolution, account }`.
- `agent-bot soul build` renders a soul's own hooks (#378, slice 3). A soul declares each hook once as an executable `hooks/<event>/<name>`, with the agent-hooks contract and canonical events; the builder writes one marker-tagged entry per event into `.claude/settings.json` (Claude Code and Devin CLI), `.codex/hooks.json`, `.cursor/hooks.json` and `.github/hooks/agent-bot-soul.json`, each running the agent-hook runner over the soul's folder.
  - Foreign entries and the identity lifecycle entries `sync-hooks` manages are kept in place; a rebuild is byte-identical, and a removed declaration removes only the builder's entries.
  - Gemini CLI, OpenCode, Muse and Kiro list every hook under `unsupported.hooks` in `soul build --check --json`, and the plain summary now prints each harness's unsupported primitives.
  - Copilot's hook file joins the format-2 ignore list; a soul carrying the previous list still validates.
  - Unknown or git/daemon events, non-executable files, nested paths and bad names fail the build.

## 0.10.33

- `agent-bot identity apps list --json` rows gain `key: {fingerprint, updatedAt} | null` (the managed App key's public SHA256 fingerprint and when connect/rotation stored it) so a companion's sheet can show which key it holds and when it was issued without reading the key.
- `agent-bot doctor --probe-inbox` adds an opt-in `inbox.reachability` check that sends one bounded (5s), bearer-free request to the gh-app-hook inbox and reports DNS, TLS, refused, timeout or HTTP status with the host only, so a dead DNS name or down broker no longer reads as ready; the default doctor run still makes no network call (#318).

## 0.10.32

- A soul made before 0.10.25 works again with `soul build`, forks, revisions and Customize: its earlier format-2 ignore list is accepted (an unknown list is still refused), and an existing soul home is rebuilt before each launch so it gains the agent-bot MCP entry a harness opened inside it needs to reach the fleet; a conflicting hand-edited generated file is reported on the daemon's stderr and the launch proceeds (#378, GeniusBar#73).

## 0.10.31

- A launch can name a short `role` for a new soul (agent-comms `launch` `role`, `soul spawn --role`, `soul fork --role`): 1 to 60 printable characters, trimmed and written into the spawned soul's `soul.json` where `population list` reads it; an invalid role, or one on an existing soul's relaunch, is refused before anything spawns (#535).

## 0.10.30

- The daemon reports each stage of a launch (`checking`, `account`, `joining`, `harness`) to agent-comms through its `launch-progress` op (agent-comms 0.3.12) so a launcher can show the steps, best effort on an older broker, and keeps the stage in the launch journal so a failed launch says where it stopped (#536).\n

## 0.10.29

- The daemon refuses a launch whose harness it cannot start (no registry row, disabled, or its command missing from the soul's PATH) before anything mints or joins the hub, so a mistyped or unsupported "Other…" harness no longer leaves dead same-name companions behind; the refusal points a self-running harness like Kiro to `agent-bot join`. A rollback that fails part way is named in the launch journal detail, and `soul remove` says which step failed and what to do when a soul's folder will not move into `.archive` (#531, GeniusBar#196).

## 0.10.28

- `acp-registry.mjs` gains a `kiro` row (`kiro-cli acp`, `kiro-cli login`) that ships disabled: the engine, `team start` and `harness auth` refuse with the reason until a signed-in Kiro verifies the wire shape and MCP tool naming (#523, GeniusBar#185). Kiro souls keep joining from a running session.
- `kiro` is a known harness for `soul.json harnesses` and `soul build` (AGENTS.md and the shared skills, no generated files yet); `setup-worktree` without a session soul now says to check in with `agent-bot join` instead of naming a GeniusBar approval step that does not exist (GeniusBar#185, #523).
- `agent-bot skill <name>` serves the bundled `agent-bot`, `agent-space`, and `thread-orders` skills as text or JSON, preserving `skill path`; the new `agent-space` skill guides check-in and repository work in the soul's work area, distinct from the durable Agent Space store (#515).

## 0.10.27

- `agent-bot soul build` renders soul-declared subagents for Claude Code and OpenCode, and commands for Claude Code, Gemini and OpenCode, with per-harness received/rendered names and explicit unsupported lists so declarations are never silently dropped (#378, slice 2).
- `agent-bot soul build` renders shared and per-harness model, reasoning effort, and permission-mode declarations from `soul.json`, preserving unrelated authored settings and reporting unsupported settings in `--check --json`; launch-time model choices retain precedence (#379).
- `agent-bot doctor` warns when a rostered worktree pin has no usable daemon binding for the calling soul; binding-related gh shim refusals now point to doctor and explain how to join as that soul or re-bind with `agent-bot setup-worktree` (#512).
- The agent-bot skill explains how to join the agent-comms hub without a GitHub App, including checkout soul reuse and command side effects; `join`, `soul`, `approvals`, `web`, and `telegram` now provide descriptive help with a successful exit status (#513).
- `setup-worktree` now creates named soul worktrees or validates existing soul work areas before writing identity, refuses primary/arbitrary checkouts (a session with no soul leaves the checkout human, as before), and provides `--help`. Checkout hooks cannot reuse another session's pin; installed wrappers refresh through the existing installer, and cross-device placement refuses without a TMPDIR fallback (#516, #512).
- Souls can declare an avatar colour as `appearance.hue` (integer 0–359) in `soul.json`, exposed by population list/show and soul profiles so GeniusBar's Customize dialog can use the existing revision edit path; template instances inherit it, invalid declarations are refused on save, and undeclared colours retain the Agent ID default (qwts/GeniusBar#64).

## 0.10.26

- Bound live sessions can report agent-comms inbox reads and hook injections through `POST /v0/asides/delivered`, recording verified incoming asides once per retained message so conversations include live-session deliveries (qwts/agent-comms#100).
- Souls can opt into a per-soul `pass-cli` credential store and move existing keys with `identity migrate-credentials --to pass-cli`; daemon and mint readers use the selected item while soul callers are refused and keys stay out of command arguments and diagnostics (#396).
- The daemon's relay sets `AGENT_COMMS_NO_DELIVERY_REPORT=1` on every agent-comms call it makes as a soul, so its own mailbox reads (cold wake, the delivered-asides route) are never reported back to it as deliveries (qwts/agent-comms#100).
- `soul revision edit` accepts owner approval through agent-bot-keyd without a terminal, and `--apply` publishes the recorded edit into the soul’s package folder so GeniusBar customization takes effect while preserving working state (qwts/GeniusBar#64).

## 0.10.25

- App IDs, bot user IDs and avatars now live in `identityApps[slug]` instead of legacy App folders. Create/connect and provider restore fill the new stores; `identity migrate-credentials` copies existing metadata, and migration/doctor report remaining files and an owner removal command without deleting anything (#399).
- Soul launch forms can read package prefill fields from `soul locate PATH [--json]` and send a persistent launch `brief`, included after the soul’s identity on its first turn (qwts/GeniusBar#120).
- `agent-bot soul build` now renders the soul's own MCP entry for each harness — `.mcp.json` (Claude Code), `.gemini/settings.json` (Gemini), `.codex/config.toml` (Codex) and `opencode.json` (OpenCode), all running `agent-bot reach-mcp` from PATH — so a soul opened by hand in its own directory can reach its teammates as well as a daemon-run turn. `soul.json` `comms: false` renders none, a soul that already ships one of these files keeps its own servers (only the `agent-bot` entry is added or replaced), and `soul build --check --json` reports every harness's rendered primitives plus `unsupported` for what a later slice cannot honor (#378).
  - `.mcp.json` and `opencode.json` joined the fixed format-2 `generatedPaths` contract, so a package carrying the older list must refresh it and recompute its revision.

## 0.10.24

- `agent-bot soul templates` lists every soul package shipped beside the bundled Starter whose soul.json says `template: true`, so GeniusBar's built-in lead (GeniusBar#73) appears in the launch picker; `join` and `start_soul` still default to Starter.
- Manage GitHub App identities through secret-free `identity apps list` and `identity app create`, `connect`, `rotate-key`, and `assign` commands and authenticated daemon routes. Manifest creation uses a one-time loopback callback and pollable jobs; credentials use App-scoped Keychain/private file stores, and list reuses doctor mint history without minting (#373).
- Soul revision owner actions now expose principal-authenticated daemon routes, reject and audit soul bindings with `owner-credential-required`, and refuse noninteractive CLI consent; GeniusBar can list pending revisions and use the reserved consent contract (#293).
- `agent-bot sandbox status|plan|on|off|account|override|resolve` and daemon routes `GET/POST /v0/sandbox`, `POST /v0/sandbox/override` report the persona account (`missing | creating | ready`), give the owner the exact steps to create and onboard it (never run with admin rights by agent-bot), and keep the global switch, account name and per-soul overrides (#376, GeniusBar#66).

## 0.10.23

- `agent-bot soul profile <agentId|name> [--json] [--file RELATIVE_PATH]` and authenticated `GET /v0/soul/profile` expose a read-only customization profile, allowed files, skills, credential declarations and offline SOP availability without fetching repositories or reading secret stores (#375).

## 0.10.22

- `agent-bot soul templates [--json]` lists validated templates from the souls root, the configured team template, and any bundled Starter, with launchable package paths and per-package errors for local discovery (#374).

## 0.10.21

- `agent-bot approvals approve <proposalId> --scope session` and daemon approval routes can approve a tool for the soul’s current harness session. Grants stay in daemon memory and clear on session change, stop, pause, or restart; decision JSON exposes `scope` and `approved_session` for approval cards (#486).

## 0.10.20

- `agent-bot soul computer-use <agentId|name> [show|on|off]` lets the owner disable computer use for one soul in Safe or Auto-Pilot mode, stops active computer-use turns, and exposes the durable setting through population and daemon APIs (#482).

## 0.10.19

- `agent-bot soul pause` cancels a soul's in-flight turns and keeps wakes, launches, and interactive turns paused until `soul resume`; population and daemon status expose the durable pause flag, with matching daemon client methods and audited routes for per-soul controls (#478).

## 0.10.18

- Add `agent-bot soul stop <agentId|name> [--json]` to cancel running daemon turns with an audited loopback request (#474).

## 0.10.17

- Souls install only their own harness adapter (#426). A Claude soul made from Starter no longer installs the pinned Codex adapter and its roughly 330 MB binary. Home launches and ACP joins select the adapter named by the harness registry, keep its template lockfile pin, and prune the install manifest and v3 lockfile to that adapter and its reachable dependencies before running `npm ci --ignore-scripts --omit=dev`. A home relaunched with another harness reinstalls for that choice; a joined checkout uses the soul's private harness directory. Harnesses without an adapter and packages without a matching pin install nothing, and the daemon never falls back to npx.

## 0.10.16

- The daemon now checks its macOS launchd log at startup and every ten minutes, copying logs above 5 MiB to a single `daemon.log.1` backup before truncating the live file, so long-running installations no longer accumulate an unbounded live log. Both files use mode 0600; `AGENT_BOT_DAEMON_LOG_MAX_BYTES` overrides the cap with a positive integer byte count. Linux journald is unchanged, and no system configuration or root access is required (#452).
- Souls now receive their own population name, Agent ID and parent name/ID in their launch turn and the first prompt of every new ACP harness session, including cold wakes (GeniusBar #119). Previously a soul launched from a template could introduce itself as Starter and deny having a parent. Resumed sessions keep their existing prompts, and the identity preamble contains only bounded public names and IDs.

## 0.10.15

- Add proposal risk levels and live daemon computer-use activity signals for GeniusBar.
- Add owner-controlled per-soul Safe and Auto-Pilot modes, with turn-scoped tool approvals and permission audit receipts.
- Store an owner-selected model per soul, expose it and cached ACP model choices through the CLI, and apply it on every daemon turn and optional launch selection.

## 0.10.14

- Add filtered audit log listing and live tailing for GeniusBar, including receipts for tool permissions allowed or denied by daemon policy.
- Soul-bound Git and gh callers now obtain GitHub credentials through the daemon and fail closed when it is unavailable, keeping key-store reads out of caller processes. (#398)
- Add Codex and OpenCode harness sign-in status/login support and JSON output for soul cold-wake show.
- `agent-bot soul locate PATH` on a package now also reports the package's `name`, `description` and `preferredHarnesses` from its soul.json (bounded, printable values only), so a launch form can prefill the companion's name and harness. (GeniusBar #120)

## 0.10.13

- An ACP turn now resolves only after the agent's process group is reaped. After the SIGKILL fallback, the engine waits up to 2s for the group to disappear. It no longer reads macOS's EPERM, which the kernel returns for a group of zombies, as "gone". Before this, a turn could finish while its killed tree was still exiting, which made the "ignores EOF and SIGTERM" test flaky on CI. The process-tree test reads the grandchild's pid from the spawn runner, so only one Node boot has to beat the deadline instead of two plus the ACP handshake. The wake-endpoint tests now wait for the response instead of sleeping a fixed 20ms. The shared hook budget is now proven by counting the hooks that started, not by timing Node startup.
- Lab souls on Codex can now do agent-comms task work. The daemon's Codex row sets `CODEX_CONFIG` so the workspace-write sandbox keeps network access, since the agent-comms broker socket counts as network: before this, `agent-comms task accept` inside a turn answered `daemon-unreachable`, Codex asked to escalate, and the policy denied it. A task turn's reach server also no longer advertises `fetch_context`, `post_reply` and `report_status`: its invocation is minted for task reporting and is not in the interaction store, so every call failed with "unknown invocation".
- A cold wake turn that fails now leaves a readable trace: the launchd unit files the daemon's stdout and stderr under `~/Library/Logs/agent-bot/daemon.log` (an existing install repairs its unit on the next `daemon install`; the systemd unit keeps journald), the daemon hands the ACP engine's one-line diagnostics to that log, cold wake logs the failed turn's agent, error code and a bounded message (the audit receipt still says only that the turn failed), and a harness command the daemon's PATH does not reach fails at once as `acp engine: cannot start <command>: not found on the daemon's PATH` instead of a bare `spawn ENOENT` after the exit grace. Before this, under launchd both streams went to /dev/null, so a soul whose turn failed in 134 ms left nothing to read anywhere.
- `agent-bot join --wake` now rolls back a newly created soul when a post-creation step fails (no daemon, no pinned adapter, agent-comms refused), exactly like the failed-launch path from #421: leave agent-comms, retire the soul, archive its folder. Previously the soul was left behind with no wake and no membership. (#435)
- Launching a copied soul folder now starts a new agent: the daemon forks the copy into its own soul, named by the launch, and leaves the soul it was copied from alone. Before this, a package launch that resolved to an existing soul relaunched it under the launch's name, so the existing agent was renamed and no new one appeared; a launch of an installed folder now keeps that soul's name, and a template is never renamed (#432).

## 0.10.12

- Changelog entries are fragments: a PR adds `changes/<slug>.md` instead of editing `CHANGELOG.md`, and the release runs `node scripts/changelog.mjs assemble X.Y.Z` to move them under the version and delete them. A new `Changelog fragment` check fails a PR that adds none or edits `CHANGELOG.md` directly, unless it is labelled `skip-changelog`.
- `agent-bot soul fork <copy-path> --name N [--harness H] [--json]` makes a Finder copy of a soul a new soul (GeniusBar #83, "Make it a new soul"). A copy carries the original's `.soul-state/agent-id`, so `soul locate` calls it `copy` and nothing may launch it (#80). Owner-gated like `soul remove`, fork gives the copy, in place, its own Agent ID, identity, genesis revision and census row named N. It then joins agent-comms from a `worktrees/workspace` checkout in the folder, as `agent-bot join` does, and `soul locate` reports the folder `installed`. The original's folder, identity and membership are untouched. The copy's `.soul-state/` and `worktrees/` (the original's harness sign-ins and git worktrees) move to `<souls root>/.archive/<stamp>-<folder>-state/` first, and a `credentials` declaration naming the original's GitHub App is dropped. A fork that fails after minting rolls back like a failed launch (#419): it leaves agent-comms, retires the new soul, and archives the folder.
- An approval that expires or whose turn aborts now leaves an `approval-decision` audit receipt (#439). A cold-woken turn's proposal was marked `expired` on its 15-minute timeout or when the turn ended, but nothing reached the audit stream, so automatic denials were invisible next to the owner's approvals and denials. The call that moves the proposal out of open now writes one receipt with `decision: expired` or `cancelled`; a decision that got there first keeps the only receipt.
- Approving or denying a soul's tool request needs the owner at the Mac (#438). `POST /v0/approvals/decide` decided on the daemon token alone, so any process in the owner's account (a soul included) holding that token could approve its own `approval` tool request, and `POST /v1/proposals/<id>/decision` decided on a transport principal's provider login alone. The daemon now asks for the owner's presence on both routes before a decision lands: keyd's Touch ID or login-password prompt, naming the soul and tool ("approve Bash for Bill - Starter (agent_…): git push"), with the administrator dialog only when keyd cannot ask. A principal credential sent with `approvals approve|deny --principal-stdin` is checked too but no longer replaces presence. A refusal decides nothing, answers 403 and is audited as `owner-refused`. `agent-bot approvals` no longer asks on its own, so the owner sees one prompt, and waits up to 3 minutes for the answer. A principal that may not approve the soul is refused without a prompt. The web UI's pairing-cookie route is unchanged.
- The census gives each soul a role line (Lovable X2). `population list|show --json` and `GET /v0/population` now add `role` (from `soul.json` `role`), `description`, `children` (live souls it started) and `roleLine`, such as "Lead · 7 subagents" or "Research". These are derived on read and never stored. `roleLine` is null when there is no role and no team, so GeniusBar falls back to the harness.
- Expired harness sign-in shows in the census (#84, GeniusBar's sign-in banner). When a cold-woken turn failed with "Not logged in", "Authentication required", an expired OAuth access token or a used-up Codex refresh token, the sender heard nothing and the soul looked healthy. The census row now carries `harnessAuth: { status: signed-out|expired, harness, since }` until a turn runs again or `harness auth status|login` sees the harness signed in. Each waiting sender gets one short notice, as in #408, and their messages stay unacked for the turn after the owner signs in again. The harness's error text is never stored.
- Owner approvals use Touch ID, or the login password, instead of the administrator dialog on GeniusBar Macs (#416). Every owner-only command (`soul comms`, `soul cold-wake`, `soul confinement`, `soul revision`, `identity migrate-credentials`, and any later command behind `assertOwnerAction`, such as `join --wake` and `soul remove`) used to raise the macOS administrator dialog, because GeniusBar's principal lives in the owner's own account and cannot vouch; friends without an admin account could not approve at all.
  - The gate now asks agent-bot-keyd first (`owner/presence`). keyd shows LocalAuthentication's device-owner prompt with "agent-bot wants to <action>", naming the soul by name and Agent ID, and on approval signs `{aud: 'agent-bot-owner', kind: 'presence', action: sha256, nonce, iat, exp}` with its own Ed25519 presence key. agent-bot checks the signature, the action digest, its own nonce and a lifetime of at most 120 seconds (keyd issues 60), and records `{ method: 'presence', via: 'agent-bot-keyd' }`.
  - The presence key is pinned from the binary, never from the socket: agent-bot checks the recorded keyd binary's Developer ID signature with `codesign`, runs `agent-bot-keyd presence-key`, and keeps the public half in `keyd/presence.pub` (0600).
  - Fallback: with no keyd, an unsigned keyd, or nobody to ask (no GUI session over ssh, no login password), keyd's `-32001` or a missing socket sends the gate to the administrator dialog as before. A person's cancel, a timeout or an assertion that does not verify refuses, and nothing asks again.
  - Prompts name the change in words ("turn agent comms off for Bill - Starter (agent_…)"), for keyd's prompt and the administrator dialog alike; audits keep the command-shaped action.
- A soul waits for its teammates instead of chasing them (#427). On the clean VM, Starter briefed a new teammate and, while it was still starting up, pinged it twice more and told the owner it was "queued"; Bill did the same on the lab Mac. Until a teammate answers in a thread (or for 10 minutes), the reach server's `send_message` refuses a second message to it in that thread with a result saying its reply will wake the soul later. A send or brief to another soul now returns a `next` note saying the same, and a relayed turn's prompt names the teammates the soul is still waiting on in that thread. People are never waited on, and a turn with no thread is not held. Two `send_message` calls racing to one teammate let only one through, and a soul's automatic final answer to a teammate never counts as a message awaiting an answer.
- `agent-bot doctor` recognises a runtime GeniusBar embeds (#428). On a clean Mac with only GeniusBar, doctor reported six FAILs and told the user to run a source-checkout bootstrap, while the daemon ran and souls launched, joined and messaged. A runtime inside `<App>.app/Contents/Resources/components/agent-bot` now reports `runtime.installed_cli` as running inside the app. A missing shell PATH entry is a warning pointing at the app's Command-line tools… item. The organization config, account App identity and git hooks, which the app does not install, are `not_applicable` instead of failures, and the skill bundle is checked in place. The missing user-level identity hook and hook-dialect coverage are `not_applicable` too, a stopped or missing daemon says to open the app and choose Set up instead of `agent-bot install`, and an incomplete in-app skill bundle says to reinstall the app instead of restoring a checkout. Source checkouts and Homebrew installs are unchanged. The `agent-bot` launcher inside the app also runs on the app's own Node (`Contents/MacOS/node`), so it no longer fails with "Node.js >= 20 is required" on a Mac without Node.
- `agent-bot approvals list|approve|deny` (#85, GeniusBar's approvals panel). A soul's policy could answer a tool with `approval`, but a cold-woken turn denied it at once, so nothing ever waited on the owner. Daemon turns now park on an immutable proposal that names the soul, the tool, a summary and an expiry; the turn resumes when the owner approves or denies, and an expiry, the turn's timeout or a daemon restart is a deny. `approvals list --json` lists them; `approve` and `deny` are owner-gated, refuse callers with a soul marker, and echo the proposal's digest. The daemon serves them on `GET /v0/approvals` and `POST /v0/approvals/decide` (daemon token) and, for a principal with the `approve` operation, `GET /v1/proposals` and `POST /v1/proposals/<id>/decision`. Launch turns still deny.
- `agent-bot join --wake` (#410). A joined soul received messages but nothing woke it: cold wake stayed off, and turning it on was a separate `soul cold-wake` command. `join` now takes `--wake resume:read-only|resume:workspace|acp`, runs the owner gate once before anything is created (`--principal-stdin`, or the macOS approval dialog), and sets the soul's cold wake after it joins. A resume wake for a harness whose sessions cannot be resumed, such as Claude, is refused up front. `join --json` reports `wake`, and the plain output says when the soul will not wake. `--wake acp` binds the checkout with the daemon and installs the pinned ACP adapter (from the soul's package or the bundled Starter) into the soul's `.soul-state/harnesses`, which the daemon's ACP turns now fall back to when the checkout has none, so a joined Claude soul wakes through an ACP turn (#417); with no daemon, or with no package that pins the adapter (an adapter row never falls back to npx, #418), it fails rather than reporting a wake that cannot run. The approval names the existing soul it changes, an existing soul's stored harness decides its wake, and the wake is on before agent-comms registers the soul (a failed registration restores the previous setting). The administrator password in the approval dialog is the owner gate's proof of a person, not a launch agent: on a GeniusBar install the broker runs in the owner's account, so a presented principal is refused and the dialog is the only approval.
- One name for a soul everywhere (#429). A soul launched as "VMStarter" showed that name in the census and its folder, but `soul comms show`, `soul locate` and `soul remove` reported its generated handle (`mild-rowan-48`), so GeniusBar's Details and its copy notice named a soul the owner never chose. The census row now records the name a launch or `agent-bot join` gave it (`displayName`), and those commands report it as `name`, falling back to the soul.json name and then the handle; the handle agents address stays, now as `handle`. A soul can also be named by that name wherever a command accepts one.
- Codex and OpenCode souls start under GeniusBar (#418). Bill's `start_soul` for a Codex teammate failed with `spawn npx ENOENT`: the Starter template only carried the Claude adapter, the engine fell back to the row's `npx` command, and a GeniusBar Mac has no npx. An OpenCode teammate was refused as `not launchable`, because the launchd daemon's PATH (`/usr/bin:/bin:/usr/sbin:/sbin`) never reached `~/.local/bin/opencode`.
  - The claude and codex rows now name their pinned adapter (`adapter: { package, version }`) and never fall back to npx. A soul whose package does not install the adapter fails its turn, naming the package. GeniusBar's Starter now pins `@agentclientprotocol/codex-acp@2.1.1` beside the Claude adapter (paired GeniusBar PR).
  - The daemon reads the login shell's PATH once at start (3 s bound; `AGENT_BOT_LOGIN_PATH=0` skips it) and adds `~/.local/bin`, `~/.opencode/bin`, `/opt/homebrew/bin` and `/usr/local/bin` after it. Soul turns, launch checks and the relay all use that PATH.
  - A `start_soul` refusal now says why, e.g. "the `opencode` command is not on this host's PATH (…); install OpenCode (https://opencode.ai) and run `opencode auth login`".
  - A launch with no harness picks the first enabled harness whose CLI (`claude`, `opencode`, `codex`) is on PATH, not one whose runner is.
- `agent-bot soul remove <soul> [--json]` takes a soul out of this account without deleting anything (#420). Owner-gated and refused while the soul runs, it turns cold wake off, leaves agent-comms as the soul, retires it and moves its folders to `<souls root>/.archive/`. Every step can be repeated, so it also finishes a cleanup a failed launch left behind. `doctor`'s `souls.orphans` warning now points to it.
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
- Asides (#404): the daemon records each agent-comms message that actually entered or left a soul's context, so a control surface can show "Bill asked Ted…" and Ted's answer inside each soul's conversation, on a team or off it. A relayed cold turn records the woken message (`relay-prompt`) and the thread it re-showed (`thread-context`, marked `reshown`) once the turn's harness session exists, and the reply the relay sent (`final-reply`); the reach server records `send_message` and `start_soul` briefs where they are sent. Each aside names its direction, peer (with the soul's name), message id, `replyTo`, `correlation`, team (the root of a `start_soul` parent chain), the daemon's `turnId` and the harness session (also for reach-server sends, from the turn's session binding), with a body clipped to 2 KiB, and the journal trims to the newest asides within half its 2 MiB limit. Messages left in a mailbox, turns that fail before their session starts, and a final answer of `NO_REPLY` (which sends nothing) leave none, and so do messages a soul reads itself with `agent-comms inbox read` (a batch wake or a live session), which the daemon cannot see. Asides are daemon state (0700/0600, bounded). The owner reads them with `agent-bot soul asides <soul> [--after ASIDE_ID] [--limit N] [--json]`, which refuses a caller carrying a soul marker, and a principal allowed to observe the soul with `GET /v1/souls/<agentId>/asides`.

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
