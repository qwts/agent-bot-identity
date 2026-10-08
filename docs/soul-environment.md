# Soul environment, schema 1

A soul root owns the agent's whole life ([ADR-0583](decisions/ADR-0583-the-soul-root-owns-the-environment.md)):
the definition at the top level, the life under `.soul-state/`, workspaces
under `worktrees/`. `agent-bot soul env` describes that root, and
`soul-env-contract.mjs` is the pure contract behind it. Hosts such as
GeniusBar read both instead of carrying their own path lists.

## Commands

```sh
agent-bot soul env <agentId|name> [--json]
agent-bot soul env migrate <agentId|name> --adopt-host-signin [--harness NAME] [--json] [--principal-stdin]
agent-bot soul env migrate <agentId|name> --space-into-soul [--json] [--principal-stdin]
agent-bot soul revision prepare <agentId|name> [--json] [--dest PATH]
agent-bot soul revision prepare --discard STAGING
agent-bot soul runtimes <agentId|name> [--json]
agent-bot soul runtimes install <agentId|name> [--json] [--runtime NAME] [--principal-stdin]
agent-bot soul secret <agentId|name> set|clear <name> [--json] [--principal-stdin]
agent-bot soul secret <agentId|name> status [--json]
```

`soul env` is read-only. It never provisions a home, creates the Agent Space
link, re-registers a moved folder, installs a harness, or rebuilds generated
output: everything it finds wrong is a readiness problem with the command
that fixes it. It resolves the soul like `soul profile` (Agent ID, name, or
display name; unknown is `soul-not-found`, exit 1), but describes the
registered folder even when its marker is bad, since that is the problem to
report. The daemon serves the same object at `GET /v0/soul/env?agentId=…`
beside `GET /v0/soul/profile`, with the same loopback and bearer
authentication; `daemonClient(...).soulEnvironment(agentId)` calls it.

## Classification contract

`soul-env-contract.mjs` exports `ENV_CONTRACT_VERSION` (1), the closed enum
`CLASSIFICATIONS`, the retention kinds `RETENTION`, the component table
`SOUL_LAYOUT`, and `classifyPath(relative)`. It re-exports
`GENERATED_HARNESS_PATHS` and `PACKAGE_IGNORE_LIST` from the harness
contract, so there is one list of generated paths.

| Classification | Retention | What |
| --- | --- | --- |
| `definition` | durable | Everything at the root that is not below: `soul.json`, `AGENTS.md`, `skills/`, `hooks/`, `bin/`, `workflows/`, `sop/`, `package.json`, policy, anything unknown |
| `generated` | reconstructible | The builder's output, `GENERATED_HARNESS_PATHS` (`CLAUDE.md`, `.claude/`, `.codex/`, …) |
| `workspace` | durable | `worktrees/` and what is under it |
| `runtime` | reconstructible | `.soul-state/runtimes/` |
| `private-home` | durable | Anything else under `.soul-state/`: `home`, `tools`, `credentials`, the marker |
| `memory` | durable | `.soul-state/space` |
| `history` | durable | `.soul-state/runs/` |
| `cache` | reconstructible | `.soul-state/cache/` |
| `temp` | disposable | `.soul-state/tmp/` |
| `external` | none | Host tools outside the root |

`classifyPath` applies ordered rules (the descriptor publishes them under
`classification.rules`): the specific `.soul-state/` children, then
`.soul-state/` as private home, then `worktrees/`, then the generated paths,
then the default. A prefix rule matches the directory itself as well as what
is under it. Only the named Copilot and Kiro files are generated;
`.github/workflows/` or `.kiro/steering/` are definition. The enum and the
rules are frozen; values are only ever appended.

## Descriptor

`soul env --json` prints one object, every key always present (unknown
scalars `null`, collections `[]`), in this order:

- `schemaVersion` 1; `engine` `{ version, contractVersion, capabilities }`.
  `capabilities` is `["env", "revision-prepare", "runtimes", "providers",
  "tool-homes", "memory", "history"]` today; a client gates each later
  slice on it.
- `identity`: `agentId`, `name`, `displayName`, `status`, `harness`,
  `genesis { revision, parentSoul }`, the manifest's `revision`,
  `parentRevision`, `template`, `formatVersion`.
- `root`: `soulDir`, `soulsRoot`, `source`, `registered`, `marker`
  (`ok | missing | invalid`), `copies` (other folders carrying this
  marker), `device`.
- `components[]`: one row per `SOUL_LAYOUT` component with `id`, `path`,
  `classification`, `present`, `retention`, plus what the component knows:
  `skills.entries`, `workflows.entries`; `generated.paths`, `.marker`,
  `.drift` (the builder's pending writes and removals from
  `buildSoulDirectory(dir, { check: true })`, `null` when the check cannot
  run); `workspaces.entries[]` `{ name, path, location: inside | linked,
  target, repository, branch }`; `home` `{ git, built, harnessInstall }`;
  `tool-state.entries[]` per harness the soul names `{ harness, path,
  routing, containment: soul | shared-host | unsupported, reason, hostPath,
  signIn, hostSignIn, note }` (`signIn` and `hostSignIn` are `present |
  missing | unknown` by existence of the sign-in file, never read;
  `containment` is decided per launch from them: `soul` is routed,
  `shared-host` keeps the host store for a sign-in the soul lacks until it
  is adopted; see [soul-tool-homes.md](soul-tool-homes.md)); `credentials`
  `{ exportable: false, declared }` (names, never contents); `memory`
  `{ location: inside | linked, target, contained, spacePath, status }`
  (`status` inspected at the census path); `history.external[]` (the daemon
  journals that still live under the state directory), `confinementLog`,
  and the soul's own mirror `mirror: ".soul-state/runs"`, `turns`,
  `revisions` (line counts, `null` when unreadable), `mirrored`; see
  [soul-memory-history.md](soul-memory-history.md); `temp.entries[]`
  (revision stagings);
  `host-tools.entries[]` `{ name, path, source: engine | host }`.
- `classification`: the contract's `enum` and `rules`.
- `harnesses`: `selected`, `declared[]` (the `package.json` pins, `source`
  `package.json`, and the `soul.json` `harnesses.<name>.install` pins,
  `source` `soul.json` with `kind` `archive | uv-tool`), `installed[]`
  (adapters found in `.soul-state/home/node_modules` or a joined soul's
  `.soul-state/harnesses`, and installs under
  `.soul-state/runtimes/harnesses`, each with `version`, `bin`, `location`,
  `status`), `launchable`.
- `runtimes`: `declared` from `soul.json` (`{}` when absent), `installed[]`
  `{ name, version, declared, requiredBy, source, path, bin }` read from
  each install's stamp, `missing[]` (reason `not provisioned` or `last
  install failed: <code>`), `unsupported[]` (no download for this host).
  See [soul-runtimes.md](soul-runtimes.md).
- `providers`: `declared[]` one row per harness with a provider
  `{ harness, id, name, baseUrl, envKey, wireApi, credential, store,
  status }` (`ready | secret-missing | unsupported`), `secrets[]` one row
  per `credentials.secrets` entry `{ name, store, status, usedBy }`
  (`present | missing | unreadable`; never a value or a length), and
  `invalid[]` refused declarations `{ path, message }`. The selected
  harness's `envKey` is listed under `launch.routing.env`. See
  [soul-providers.md](soul-providers.md).
- `launch`: `supported`, `lane` (`acp` or `null`), `cwd` (the home),
  `routing { HOME, PATH, TMPDIR, toolHome, runtimes, env }` (`HOME` and
  `TMPDIR` are `host` today; `PATH` is `soul-runtimes`, `host-bundled` or
  `host`; `toolHome` is `soul` when the selected harness's store is routed
  into the soul, `host` when it is not, `null` without a harness;
  `runtimes` maps `node`, `python`, `go` and `harness:<name>` to
  `{ source, version, bin }`; `env` names the variables the launch sets,
  the tool-home ones included), `limitations[]`: one per harness whose
  native state stays shared on the host (`shared-host` or `unsupported`),
  with the reason.
- `readiness`: `ready` (no error-severity problem) and `problems[]`
  `{ code, severity, component, message, action }`.
- `migration`: `status` (`pending` while any step is, else `none`),
  `journal`, `steps[]` `{ id, status, from, to }`. Inventory:
  `space-into-soul` when `.soul-state/space` is a link,
  `harnesses-into-runtimes` when `.soul-state/harnesses` exists, and
  `adopt-host-signin:<harness>` for each `shared-host` harness. Steps `soul env migrate` recorded in
  `.soul-state/migration.json` are listed as recorded (`done | skipped |
  failed`, or a phase `copying | verifying | switching` of a run under way,
  with `at` and `note`) and replace the pending entry of the same id. The
  adoption and the space move run today; `harnesses-into-runtimes` waits
  for slice 6.
- `retention`: component ids grouped as `durable`, `reconstructible`,
  `disposable`.
- `errors[]`: `{ area, message }` for what could not be read; the rest of
  the descriptor is still complete.

### Readiness codes

| Code | Severity | Action |
| --- | --- | --- |
| `marker-invalid` | error | `.soul-state/agent-id` is not a regular file holding one Agent ID |
| `root-unregistered` | error | The folder's marker names no active soul in this census |
| `root-duplicate` | warning | Other folders carry the marker (`root.copies`) |
| `home-missing` | warning | No `.soul-state/home`; the next launch provisions it |
| `generated-drift` | warning | `agent-bot soul build "<soulDir>"` |
| `generated-conflict` | error | A generated path was hand-edited (no marker); the builder refuses |
| `harness-missing` | warning | The pinned adapter or harness install is not in the soul; the next launch installs it |
| `runtime-missing` | warning | A declared runtime is not installed; `agent-bot soul runtimes install <id>` or the next launch |
| `runtime-unsupported-platform` | error | No download for this host; declare `sources` for it in a revision |
| `runtime-download-failed`, `runtime-checksum-mismatch`, `runtime-install-failed` | error | The last install of that version failed; the message says why and the action is the install command |
| `runtime-declaration-invalid` | error | `soul.json` `runtimes` or `harnesses.<name>.install` is refused; fix it in a revision |
| `provider-secret-missing` | error (selected harness) / warning (another harness) | The provider's secret is not stored; `agent-bot soul secret <id> set <name>` |
| `provider-secret-unreadable` | error / warning | The declared store cannot give the secret (a loosened file mode, a store failure); store it again |
| `provider-declaration-invalid` | error | `harnesses.<name>.provider` or `credentials.secrets` is refused; fix it in a revision |
| `tool-signin-missing` | warning | The selected harness's sign-in is in the host store (or a Mac's keychain) but not in the soul's tool home, so the launch keeps the shared host store; `agent-bot soul env migrate <id> --adopt-host-signin --harness <name>` contains it |
| `memory-not-contained` | warning | `.soul-state/space` is a link to an Agent Space outside the soul, so the soul's memory does not travel with its folder; `agent-bot soul env migrate <id> --space-into-soul` moves it inside |

Warnings leave `ready` true. Codes are appended, never renamed.

## Preparing a revision edit

`soul revision prepare <soul>` stages the current package definition into
`<soulDir>/.soul-state/tmp/revision-<uuid>/` and prints
`{ schemaVersion, agentId, soulDir, staging, revision, parentRevision,
files[], excluded, expiresAt }`. Each file row is `{ path, classification,
kind, editable, text, size, mode }`: `kind` as `soul profile` reports it,
`editable` when the file is `definition` and not `soul.json` or under `bin/`,
`text` when the bytes are UTF-8. `excluded.workingState` names the ignore
list directories present (`.soul-state/`, `worktrees/`); `excluded.generated`
the exact generated output left out. Modes are preserved. Staging is
exclusive (`mkdir` without `recursive`), is removed again if preparing
fails, and `expiresAt` is 24 hours later. `--dest PATH` stages elsewhere
(a soul without `.soul-state` needs it: `soul-state-missing`). A host edits
the staging, then runs `soul revision edit ID <staging> REASON --apply`,
which records and publishes it as before; apply also removes the exact
generated output the staging left out, which the builder regenerates on the
next build or launch (it is reconstructible). `prepare --discard STAGING`
removes one staging, and only a `revision-<uuid>` directly under a marked
soul's `.soul-state/tmp/` (`staging-not-temp` otherwise). Preparing is not
an owner action; applying still is.
