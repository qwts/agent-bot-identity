# Soul tool homes and sign-in adoption

A harness keeps its native state (sign-in, sessions, settings) in a store
under the user's HOME: `~/.claude`, `~/.codex`, `~/.local/share/opencode`.
Every soul on the machine used to share it, so two Codex souls shared one
login and a soul folder moved to another Mac lost its sign-in.
[ADR-0583](decisions/ADR-0583-the-soul-root-owns-the-environment.md)
decision 5 gives each soul its own tool home instead:
`<soul>/.soul-state/tools/<harness>/`, routed with the harness's own
variable and nothing else.

```sh
agent-bot soul env <agentId|name> [--json]                                   # tool-state rows, readiness
agent-bot soul env migrate <agentId|name> --adopt-host-signin [--harness NAME] [--json] [--principal-stdin]
```

## Contract

- A launch of a routable harness that is contained (below) sets that
  harness's store variables to directories under
  `<soul>/.soul-state/tools/<harness>/`, which it creates (0700) first. The
  host's own value of the same variable is replaced for that soul's turn.
- Whether a routable harness is contained is decided at each launch, from
  the sign-in files alone (existence, never contents), by the pure
  `toolHomeDecision(harness, { signIn, hostSignIn, adopted })`:

  | Soul's tool home | Host store | Containment |
  | --- | --- | --- |
  | sign-in present | anything | `soul`: routed |
  | sign-in missing | sign-in missing (or no store) | `soul`: nothing to lose; a new Mac is contained from the first launch |
  | sign-in missing | sign-in present | `shared-host`: the harness keeps the host store exactly as before, until the owner adopts the sign-in |
  | sign-in missing | unknown (a Mac's Claude keychain, which no file shows) | `shared-host`: a signed-in host is never mistaken for one with nothing to lose |
  | anything, after `soul env migrate --adopt-host-signin` ran for it (journal step `done` or `skipped`) | anything | `soul`: the owner decided |

  A harness is never started into an empty store that would ask it to sign
  in. An existing sign-in stays on the host store until adopted; the
  descriptor says so (`containment: "shared-host"`, `routing: []`, a
  `launch.limitations` row and the `tool-signin-missing` warning with the
  adoption command). After the adoption the next launch routes.
- `HOME` is never set: it stays the host's (the soul home and worktree
  routing are separate, [soul-homes.md](soul-homes.md)). `XDG_STATE_HOME`
  is never set either: every agent-bot child (the reach server, keyd's
  relay, hooks) reads it for the daemon's own state. The registry refuses a
  row that names either, and the executor drops them if a port returns them.
- A harness with no documented variable that moves its store is reported
  `unsupported` with the reason, keeps running on the shared host store,
  and stays listed under `launch.limitations`. Nothing is faked with a HOME
  swap or a symlink.
- The routed variables are paths, not secrets, so they go to the harness
  process and to the reach MCP server and keyd relay entries alike (unlike a
  provider secret, [soul-providers.md](soul-providers.md)): a child those
  servers start reads the same store as the harness.
- Existing sign-ins are adopted once, explicitly, by the owner
  (`--adopt-host-signin`). The launch never copies a credential.

`soul-tool-homes.mjs` is the pure registry (`TOOL_HOME_REGISTRY`,
`toolHomeEnv`, `toolHomeFiles`, `hostToolStore`); `soul-env-migrate.mjs`
does the reading, creating and adopting.

## Per harness

| Harness | Variables set | Tool home layout | Host store | Adopted files | Notes |
| --- | --- | --- | --- | --- | --- |
| `claude` | `CLAUDE_CONFIG_DIR` | `tools/claude/` | `~/.claude` (`$CLAUDE_CONFIG_DIR` when the host sets it) | `.credentials.json` (sign-in), `.claude.json` (onboarding and user-scoped settings; `~/.claude.json` on a host without `CLAUDE_CONFIG_DIR`) | On macOS Claude Code keeps its OAuth token in the login keychain, per user; no file copy carries it. A routed soul without `.credentials.json` signs in once inside its tool home, or runs on a provider secret (`ANTHROPIC_API_KEY`). The keychain is never read. |
| `codex` | `CODEX_HOME` | `tools/codex/` | `~/.codex` (`$CODEX_HOME`) | `auth.json` (sign-in) | Sessions, `config.toml` and logs are not adopted; the soul's generated `.codex/config.toml` carries its settings. |
| `opencode` | `XDG_CONFIG_HOME`, `XDG_DATA_HOME`, `XDG_CACHE_HOME` | `tools/opencode/{config,data,cache}/`, and OpenCode adds `opencode/` under each | `~/.config/opencode`, `~/.local/share/opencode`, `~/.cache/opencode` (the XDG bases when the host sets them) | `opencode/auth.json` under the data base (sign-in) | The user-level `opencode.json` is not adopted; the soul's generated `opencode.json` carries its settings. `XDG_STATE_HOME` is not set. |
| `kiro` | none | - | `~/.kiro` (sessions), `~/Library/Application Support/kiro-cli` (sign-in) | - | `unsupported`: no variable that moves the store is documented in this repo. |
| `muse` | none | - | `~/.local/share/muse` | - | `unsupported`: no variable documented here. |
| `gemini`, `copilot`, anything else | none | - | `~/.gemini`; Copilot's isolated store | - | `unsupported`: not ACP drive harnesses, nothing to route. |

Evidence for the variables, as this repo has it: `CLAUDE_CONFIG_DIR` is
followed by `sync-hooks.mjs` and `metrics.mjs` (and reserved for the launch
in `soul-providers.mjs`); `CODEX_HOME` is reserved in `soul-providers.mjs`
and named by ADR-0583; the OpenCode XDG bases follow from its registry
store `~/.local/share/opencode` and ADR-0583. That `.claude.json` moves into
`CLAUDE_CONFIG_DIR` when it is set is Claude Code's documented behaviour,
not verified by anything in this repo. No variable was invented for a
harness the repo has no evidence for: those are `unsupported`.

## At launch

`acpExecutorFor` asks `toolHomeEnvFor({ agentId, harness })` for the patch
each turn (empty unless the decision above is `soul`) and merges it into
the turn env, after the runtime routing and before the provider secret. The reach server entry and keyd's relay entry
carry the same variables (`forward`), by name, once each. A soul with no
folder yet (a lookup that fails without a code) runs on the host store as
before. A tool home that cannot be created is `tool-home-unwritable` and
fails the turn; a silent fallback to the shared store would be the faked
containment decision 5 forbids.

A launch runs a `tool-home` stage after `runtimes` and before `provider`
whenever the launched harness is contained: it creates
`.soul-state/tools/<harness>` (and OpenCode's three bases) so the harness
starts into its own store, and fails there with `tool-home-unwritable` and
the stage name before the soul joins. An unroutable or `shared-host`
harness has nothing pending and no stage. The daemon wires `toolHomeEnvFor`, `toolHomes.pending`
and `toolHomes.prepare` from `soulToolHomeEnv`, `pendingSoulToolHome` and
`prepareSoulToolHome`.

## Adopting a host sign-in

```sh
agent-bot soul env migrate billy --adopt-host-signin                 # every routable harness the soul names
agent-bot soul env migrate billy --adopt-host-signin --harness codex
```

- Owner action, gated like `soul runtimes install` (`--principal-stdin`
  carries the principal JSON). The action named to the gate is
  `adopt the host's <harnesses> sign-in into <id>'s soul folder`.
- Copies only the files the registry names for that harness, from the host
  store to the soul's tool home: the sign-in file, and for Claude the
  `.claude.json` state file. Never sessions, history, caches, settings or
  anything else beside them. Each copy is opened without following links,
  bounded (16 MiB), written exclusively with mode 0600 into 0700
  directories. A linked host file is treated as absent.
- Idempotent: a file the soul already has is left alone (`present`), so a
  second run is `skipped` with `already adopted` and the soul's copy is
  never overwritten by a newer host login. A host without the file gives
  `skipped` with `the host has no sign-in file for this harness; sign in
  once inside the soul`; the tool home still exists afterwards for that.
- Claude on macOS: `.credentials.json` is usually absent (the token is in
  the keychain), so the step is `done` for `.claude.json` alone (or
  `skipped` with nothing to copy) and the `note` says the keychain sign-in
  is per user and the harness asks once in the soul. Nothing reads the
  keychain. Because the keychain is invisible to a file check, a Mac's
  Claude host sign-in is `unknown` and the soul stays `shared-host` until
  this step has run: the owner, not a guess, decides when Claude signs in
  inside the soul.
- Without `--harness`, the soul's own harnesses are taken: its execution
  identity's, then `soul.json` `preferredHarnesses`, routable ones only.
  `--harness` names one; an unroutable one is refused with
  `tool-home-unsupported` and the reason, before the gate.
- Each harness is one step `adopt-host-signin:<harness>` recorded in
  `.soul-state/migration.json` (`{ schemaVersion: 1, steps[] }`, 0600,
  written through a rename): `{ id, status: done | skipped | failed, from,
  to, at, note, files[] { path, kind, status: copied | present | absent |
  failed } }`. A rerun replaces the step's record; the journal holds one
  entry per step.
- One audit receipt `soul-env-migrate` per run with `operation`
  `adopt-host-signin`, `decision` `adopted | skipped | failed` and a
  `detail` naming each harness, its status and its files' outcomes. Never a
  byte of a file.
- `--json` prints `{ schemaVersion, agentId, soulDir, operation, decision,
  steps[], root }`. Errors are coded: `soul-not-found`,
  `soul-state-missing` (spawn or launch the soul first),
  `tool-home-unsupported`, `tool-home-unwritable`.

## In the descriptor

`agent-bot soul env` ([soul-environment.md](soul-environment.md)) reports,
per harness the soul names, a `tool-state.entries[]` row `{ harness, path,
routing, containment, reason, hostPath, signIn, hostSignIn, note }`:
`containment` is the decision above: `soul` (routed), `shared-host` (kept
on the host store for its sign-in, with `reason`) or `unsupported` (with
`reason`); `routing` the variables the next launch sets (empty unless
`soul`); `signIn` whether the sign-in file exists in the soul's tool home,
`hostSignIn` whether it exists in the host store, both by existence alone,
never read; `unknown` for an unroutable harness, and for a Mac's Claude host
when no file shows the sign-in. `launch.routing.toolHome` is `soul` or
`host` for the selected harness and `launch.routing.env` includes its
variables; a routed harness is no longer a `launch.limitations` row, a
`shared-host` or `unsupported` one is, with its reason.

`readiness.problems` gets `tool-signin-missing` (warning, component
`tool-state`) when the selected harness is `shared-host`; the action is the
adoption command. The `migration.steps[]` list carries what the journal
recorded and a `pending` `adopt-host-signin:<harness>` step for each
`shared-host` harness.

## Limits

- Routing covers the ACP lane (`acpExecutorFor`) and the launch handler. A
  soul joined from the user's own session (`agent-bot join`) runs in that
  session's HOME with the shared store; the resume lane (`wake-resume`) is
  outside this slice.
- A contained harness no longer sees the host's user-level settings
  (`~/.claude/settings.json`, `~/.codex/config.toml`, the user
  `opencode.json`): its tool home starts empty apart from what is adopted,
  and the soul's generated files carry its settings. What `sync-hooks`
  writes at user level (`[features] hooks = true` for Codex) does not reach
  a contained soul yet.
- The metrics collector reads Claude's session logs under the host's
  `CLAUDE_CONFIG_DIR`; a contained Claude soul's logs are under its tool
  home.
  `agent-bot harness` sign-in status likewise reports the host store.
- `.claude.json` carries user-scoped MCP servers and per-project state as
  well as onboarding; adoption copies it whole.
- OpenCode is routed through the XDG base variables, which every XDG-aware
  program the harness starts also reads: inside a contained OpenCode soul,
  `gh` looks for its hosts file under the soul's `XDG_CONFIG_HOME` and git
  for `git/config` there, so a host `~/.config/gh` sign-in does not reach
  that soul (its `~/.gitconfig` and `HOME` still do). The provider secret
  (slice 4) and the soul's own GitHub identity are unaffected.
- A soul's copy of a sign-in is a credential inside its folder, excluded
  from export (ADR-0583 decision 10) like `.soul-state/credentials`.
