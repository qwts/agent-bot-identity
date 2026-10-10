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
agent-bot soul env migrate <agentId|name> --template-name [--plan] [--json] [--principal-stdin]
agent-bot soul env migrate <agentId|name> --harnesses-into-runtimes [--plan] [--json] [--principal-stdin]
agent-bot soul env migrate <agentId|name> --complete [--plan] [--json] [--principal-stdin]
agent-bot soul env clean <agentId|name> [--plan] [--component cache|temp|runtimes] [--json] [--principal-stdin]
agent-bot soul env export <agentId|name> --to FILE [--plan] [--json] [--principal-stdin]
agent-bot soul env import FILE [--fork] [--replace] [--name NAME] [--plan] [--json] [--principal-stdin]
agent-bot soul env history <agentId|name> [--json] [--limit N]
agent-bot soul template refresh <agentId|name> [--from TEMPLATE_PATH] [--plan] [--json] [--principal-stdin]
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
  "tool-homes", "tool-home-set", "memory", "history", "template-name",
  "template-refresh", "launch-parent", "migrate-complete", "env-clean",
  "env-export", "env-import", "harnesses-into-runtimes",
  "env-history", "dream-status", "dream-ack-notice"]` today; a client gates
  each later slice on it
  (`template-name` is the `soul env migrate --template-name` rename and the
  `templateName` / `nameSource` provenance, `template-refresh` the
  `soul template refresh` command, see [soul-templates.md](soul-templates.md);
  `tool-homes` advertises tool-home inspection and adoption,
  while `tool-home-set` advertises the setter documented in
  [soul-tool-homes.md](soul-tool-homes.md). Hosts must treat a missing
  `tool-home-set` flag as unsupported, even if `tool-homes` is present;
  `launch-parent`: a principal launch may name the new soul's parent,
  GeniusBar#261; `migrate-complete` the `soul env migrate --complete` verb
  and `env-clean` the `soul env clean` command, both below; `env-export`
  and `env-import` the two commands under [Export and import](#export-and-import);
  `harnesses-into-runtimes` the npm adapter install under the runtimes and
  the `soul env migrate --harnesses-into-runtimes` verb, below;
  `env-history` the `soul env history` read of the history mirror, see
  [soul-memory-history.md](soul-memory-history.md#reading-the-fact-mirror)).
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
  target, repository, branch }` and `workspaces.imported[]` `{ name, path,
  target, branch, head, remote, patch, untracked, linked }`, one per linked
  workspace an import left as a pointer under `.soul-state/imports/<name>/`
  (`linked` once a `worktrees/<name>` entry exists again); `home` `{ git, built, harnessInstall }`;
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
  legacy `.soul-state/harnesses`, then every stamped install under
  `.soul-state/runtimes/harnesses/<name>/<version>`: an npm adapter listed
  from its stamp as `kind: "npm"` with its `package`, the archive and uv
  tool installs as before; each with `version`, `bin`, `location`,
  `status`), `launchable` (true when any listed install has its binary,
  the runtimes location alone included).
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
  adoption, the space move, the template rename and the harness move each
  run by their own verb or together through `soul env migrate --complete`
  (below); the legacy install still launches until it is moved.
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
| `tool-home-record-invalid` | error | `.soul-state/tool-homes.json` (a soul's per-harness `soul`/`global` choice, #617) is a link, is not JSON, or names an unknown harness or choice; fix or remove it ([soul-tool-homes.md](soul-tool-homes.md)) |
| `memory-not-contained` | warning | `.soul-state/space` is a link to an Agent Space outside the soul, so the soul's memory does not travel with its folder; `agent-bot soul env migrate <id> --space-into-soul` moves it inside |
| `workspace-unlinked` | warning | A linked workspace came back from an import as a pointer (`.soul-state/imports/<name>/`) and no `worktrees/<name>` exists yet; check the repository out again, link it there, then apply `changes.patch` and copy the untracked files |

Warnings leave `ready` true. Codes are appended, never renamed.

## Moving the npm adapter under the runtimes

```sh
agent-bot soul env migrate billy --harnesses-into-runtimes --plan --json   # read-only
agent-bot soul env migrate billy --harnesses-into-runtimes [--json] [--principal-stdin]
```

A soul joined before #583 slice 8 keeps its ACP adapter in
`.soul-state/harnesses`; a fresh install lands under
`.soul-state/runtimes/harnesses/<harness>/<version>/` with an install stamp
([soul-runtimes.md](soul-runtimes.md#npm-acp-adapters)). This verb moves the
legacy install there, recorded as the `harnesses-into-runtimes` step. The
harness is the soul's recorded one when its adapter is in the legacy
directory, else the single adapter found there; the version is the
adapter's `package.json`, else the lockfile. The directory is renamed into a
`.installing-<uuid>` staging beside the target (copied and verified when
another filesystem), checked for `node_modules/.bin/<adapter>`, stamped and
renamed into place; on any failure it is put back where the soul still
launches it from and the step is recorded `failed` with the code in its
`note` (`harness-migrate-source-invalid`: no adapter package, two with no
recorded harness to choose, no version or no binary;
`harness-migrate-verify-failed`: the move itself). A target the runtimes
already hold with its stamp and binary makes the legacy copy redundant
(reconstructible from the pins, never exported): it is removed and the step
is `done`. One owner gate, refused `soul-running` before and after it,
`--plan` read-only. Idempotent: nothing left is `skipped` (`nothing to
migrate`). Receipt `soul-env-migrate` with `operation
harnesses-into-runtimes` and the decision `migrated | skipped | failed`.

## Completing a migration

```sh
agent-bot soul env migrate billy --complete --plan --json   # read-only
agent-bot soul env migrate billy --complete [--json] [--principal-stdin]
```

`--complete` finishes every step the descriptor's `migration.steps` lists
as not finished: an inventory entry still `pending`, a phase an interrupted
run left (`copying | verifying | switching`), or a `failed` step, which is
run again. Each step goes through the mechanism its own verb uses and is
recorded as that verb records it (`soul-memory.mjs` for `space-into-soul`,
the adoption for `adopt-host-signin:<harness>`, the rename for
`template-name`, the harness move for `harnesses-into-runtimes`), so
`.soul-state/migration.json` keeps its format and `soul env` reflects the
outcome. One owner gate for the lot (the action names the step ids);
refused `soul-running` (action `agent-bot soul stop <id>`) while the soul
has a turn in flight or a warm harness, checked before and after the gate.
A step that cannot run (the retired source is gone:
`space-migrate-source-missing`; the legacy install holds no runnable
adapter: `harness-migrate-source-invalid`) is reported `failed` with the
code in its `note` and the other steps still run.

Idempotent: nothing pending is `decision: skipped` with `steps: []`, no
gate and no receipt. `--plan` prints the steps as they stand with a note
of what would happen, changes nothing and asks nobody; the same plan twice
is byte-identical. `--json` prints `{ schemaVersion, agentId, soulDir,
operation: "complete", decision: planned | completed | skipped | failed,
steps[], root }` with `root` the soul root. One audit receipt
`soul-env-migrate` with `operation` `complete` and a `detail` of `id:
status` pairs; the steps' own records hold paths and notes, never a
file's contents.

## Cleaning

```sh
agent-bot soul env clean billy --plan --json          # what would go, with sizes
agent-bot soul env clean billy [--component cache|temp|runtimes] [--json] [--principal-stdin]
```

A clean removes only what the contract classifies reconstructible or
disposable, and only from these components:

| Component | Removed | Kept |
| --- | --- | --- |
| `cache` | every entry under `.soul-state/cache/` | the directory itself |
| `temp` | every entry under `.soul-state/tmp/`, a `revision-<uuid>` staging only once its 24-hour window has passed | a staging within its window (a host's edit in progress; `soul revision prepare --discard` removes it) |
| `runtimes` | the runtime caches a routed launch fills (`node/npm-cache`, `uv/cache`, `go/cache`) and the `.installing-<uuid>` staging an interrupted install left | every installed version, its stamp and `last-install.json`, `go/gopath` |

Never anything durable: the definition, generated output (reconstructible,
but the builder's to rebuild), workspaces whether or not they hold
uncommitted work, the home, tool state, credentials, secrets, sign-ins,
memory and history. The retired source of a space move
(`<source>.retired-<date>`, outside the root) is not the soul's and is left
for the owner. Every path is classified by `classifyPath` once in the plan
and again before removal; a durable retention is refused with
`clean-component-durable`, as is `--component` naming anything but
`cache`, `temp` or `runtimes`. A component root that is a link is never
followed: it is listed under `kept` with the reason. A space move under
way keeps its staging and is listed under `kept` pointing at `--complete`.

`--plan` is read-only (no gate, nothing written, byte-identical on a
rerun). The apply is owner-gated (the action names the components),
refused `soul-running` (action `agent-bot soul stop <id>`) while the soul
runs, checked before and after the gate, planned again after the gate,
and records the run in `.soul-state/clean.json` (`{ schemaVersion: 1,
agentId, at, files, bytes, removed[] { relative, classification, kind,
files, bytes }, failed[] { relative, error } }`, 0600, written through a
rename; the last run replaces the previous) plus one audit receipt
`soul-env-clean` (`operation` `clean`, `decision` `cleaned | nothing |
failed`, counts and the first few names). A path that cannot be removed is
listed under `failed` with its error code and the rest still goes.

`--json` prints `{ schemaVersion: 1, agentId, soulDir, applied, decision:
planned | cleaned | nothing | failed, components[], removable[],
removed[], failed[], kept[], files, bytes, journal }`; each row is
`{ component, path, relative, classification, retention, kind: cache-entry
| temp-entry | revision-staging | runtime-cache | install-staging | link |
space-staging, files, bytes }` (`kept` rows carry `reason` instead of a
size). Errors: `soul-not-found`, `soul-state-missing`, `soul-running`,
`clean-component-durable`, each `{ error: { code, message, action } }`
with `--json`.

## Doctor

`agent-bot doctor` describes each active soul that has a folder through
the same descriptor, as one machine check `souls.environment` per soul:
`ready` with no problem, `warning` (`soul-env-warnings`) with warnings
only, `failed` (`soul-env-not-ready`) with an error-severity problem, which
makes doctor exit 1. The message lists the problem codes, the action is
the first problem's own fix (an error's before a warning's), and `evidence`
holds `{ agentId, soulDir, ready, problems[], errors[] }` (codes only).
A descriptor that cannot be read is `soul-env-unreadable` (warning).
`doctor --json` carries the same checks. Doctor provisions and rebuilds
nothing: the descriptor is read-only.

## Export and import

```sh
agent-bot soul env export billy --to ~/Desktop/billy.soul.tgz --plan --json   # the manifest, read-only
agent-bot soul env export billy --to ~/Desktop/billy.soul.tgz [--json] [--principal-stdin]
agent-bot soul env import ~/Desktop/billy.soul.tgz --plan --json              # identity decision and destination, read-only
agent-bot soul env import ~/Desktop/billy.soul.tgz [--fork] [--replace] [--name NAME] [--json] [--principal-stdin]
```

An export is the soul's life as one file (ADR-0583 decision 10), not a
copy of its root: every path is classified by the contract and travels
only when it is durable and the soul's own. A definition-only template
(`soul templates`, a package) and a life export are different artifacts;
the export carries what a template never has.

### What travels

| Component | Carried | Left out |
| --- | --- | --- |
| definition | everything at the root that is the definition (`soul.json`, `AGENTS.md`, `skills/`, `hooks/`, `bin/`, `workflows/`, `sop/`, `package.json`, policy) | generated output (`CLAUDE.md`, `.claude/`, `.codex/`, …): the next build regenerates it |
| home | `.soul-state/home` whole, its git history included | `node_modules` and `.soul-state/harnesses`: harness installs, the next launch installs them again |
| tool state | `.soul-state/tools/<harness>` (sessions, settings, `.claude.json`) | every sign-in file the tool-home registry names (`.credentials.json`, `auth.json`, `opencode/auth.json`), and a harness's cache route (`XDG_CACHE_HOME`) |
| credentials | nothing | `.soul-state/credentials` whole: GitHub App keys, file-store secrets |
| memory | `.soul-state/space` whole; a space still linked from the spaces root is read through its link (the census says it is the soul's) and lands inside on import | |
| history | `.soul-state/runs`, `confinement.log`, and the daemon's revision journal for the soul (its events and stored packages, under `journal/` in the archive) | locks and stagings |
| interaction | the soul's own rows from the daemon's interaction store (#583): `.soul-state/runs/interaction/interaction.json` `{ schemaVersion: 1, agentId, invocations[], sessions[] }`, and each of its invocations' `events/<id>.jsonl` and `payloads/<id>.json` byte for byte, all 0600 | every other soul's sessions, invocations, events and payloads; whatever the root held at `.soul-state/runs/interaction` (regenerated from the store) |
| settings | `home-harness`, `migration.json`, `clean.json`, anything else durable directly under `.soul-state/` | `agent-id` (the import writes the marker), `*.lock`, `space.migrating-*`, `space.link-*` |
| workspaces | a soul-owned directory under `worktrees/` whole, admin directory included; a linked one as `pointer.json` (target, repository, `HEAD`, branch, `origin`), `changes.patch` (`git diff --binary HEAD`) and each untracked file (`git ls-files --others --exclude-standard`, up to 64 MiB each) | the linked repository itself, its ignored files |
| runtimes, cache, temp | nothing | `.soul-state/runtimes`, `.soul-state/cache`, `.soul-state/tmp`: reconstructible or disposable |
| any other link | a pointer row (`kind: pointer`, its target), nothing followed | |

The archive is gzip over POSIX ustar (GNU long names), so `tar -tzf` lists
it; its first entry is `manifest.json`: `{ schemaVersion: 1, agentId,
name, displayName, exportedAt, engineVersion, root, identity { harness,
parentId, genesis, createdAt }, memory { location, target }, workspaces[]
{ name, location, target, head, branch, remote, patch, untracked, note },
journal { entries }, interaction { sessions, invocations, events, payloads }
| null, components[], excluded[], totals { files, bytes } }`. `interaction`
is `null` when the export ran without the interaction store at hand (the
library called directly); `agent-bot soul env export` always carries it.
Each component is `{ area: root | workspace | journal, entry, relative,
classification, retention, kind: file | dir | pointer | patch, bytes,
sha256, mode }` (plus `workspace` or `target`); entries live under `life/`
(the root), `workspaces/<name>/` and `journal/`. Each `excluded` row is
`{ relative, classification, reason }`. `--plan` prints the manifest and
writes nothing; the same plan twice is byte-identical. The write is
owner-gated (the archive holds the private home), refused `soul-running`
(action `agent-bot soul stop <id>`) while the soul has a turn in flight or a
warm harness, checked before and after the gate, planned again after it,
and every file is hashed again while it is written (`export-changed` when
one moved under the export). The file is written privately (0600) through
a rename, must not exist (`export-target-exists`) and may not be inside the
root (`export-target-inside-root`). One audit receipt `soul-env-export`
with counts and the path, never contents. `--json` prints `{ schemaVersion:
1, agentId, soulDir, applied, decision: planned | exported, file,
manifest }`.

### Identity on import

- The ID is kept: a moved life. An ID unknown here gets its identity
  record minted with the exported harness, the revision journal restored
  from the archive (or, when the archive carries none, the restored
  package adopted as the chain's start), the marker written, the space
  marker checked, a census row (handle, display name, `soulDir`,
  `spacePath` inside, `active`).
- `--fork` mints a new ID through the same genesis path `soul fork` uses:
  the restored package minus its `credentials` declaration (it names the
  original's GitHub App), `template: false`, a new revision chain adopted
  as `Import as a fork of <id>`, the display seed re-initialized, the space
  marker rebound to the new ID, the census showing both souls. `--name`
  sets the fork's display name; the handle derives from the new ID.
- An ID that is active here is `import-id-active` (action: `--replace` or
  `--fork`). `--replace` is refused `soul-running` while that soul runs
  (before and after the gate), keeps the local identity record and revision
  chain (`journal: kept-local`), moves the existing root aside as
  `<root>.replaced-<stamp>` (the export's time, ISO-8601 with `:` and `.`
  as `-`), never deletes it, then puts the restored root in its place and
  points the census at it.
- A retired ID is a tombstone: `import-id-retired`, even with `--replace`;
  only `--fork` brings the life back.

### Safety on import

The archive is untrusted. Its first entry must be the manifest; every
other entry must be a regular file or directory the manifest lists, under
`life/`, `workspaces/<name>/` or `journal/`, a relative path without `..`,
and must match the manifest's size and SHA-256. A symlink or any other
entry type, an absolute path, traversal, an entry the manifest does not
name, a manifest component outside the root or with a non-durable
classification, is `import-unsafe-archive` or `import-manifest-invalid`;
a hash that does not match is `import-checksum-mismatch`; a listed entry
that never arrives is `import-archive-incomplete`. Everything is extracted
and verified in a private staging under the souls root
(`.import-<uuid>`, removed on any failure) before a byte reaches a soul
root or the census. Pointers are never recreated as links. A linked
workspace comes back as `.soul-state/imports/<name>/pointer.json`,
`changes.patch` and `untracked/…`; the descriptor lists it under
`workspaces.imported` with the `workspace-unlinked` warning until a
`worktrees/<name>` exists again. Nothing is cloned: the owner checks the
repository out, links it, applies the patch and copies the untracked files.

The interaction records are checked before anything is minted: the
document and every session and invocation must name the exported soul
(`import-interaction-foreign`), and every event log and payload must
belong to a listed invocation and parse (`import-interaction-invalid`).
A kept or replaced life then merges them into this host's store, adding
only: a session, invocation, event log or payload already here is kept
as it is, and a retry handle already pointing elsewhere keeps pointing
there. The root keeps no second copy. A fork does not merge them and
does not reassign them to its new ID: they move to
`.soul-state/runs/interaction-history/<parent agentId>/` as the parent's
read-only history, still naming the parent, and travel with the fork's
life from then on.

The apply is owner-gated (the action names the archive and the decision)
and recorded as migration step `life-import` (`done`, `from` the archive,
`to` the root, `identity { decision, agentId, importedFrom }`, `journal`,
`replaced`, `workspaces[]`, `space: restored | created`, `interaction`), plus one audit
receipt `soul-env-import` with counts and the destination. `--plan` reads
the manifest only, decides identity and destination, and writes nothing.
`--json` prints `{ schemaVersion: 1, archive, applied, decision: planned |
imported | replaced | forked, identity { decision: keep | replace | fork,
agentId, importedFrom, existing }, soulDir, replaced, name, displayName,
journal: restored | adopted | kept-local, restored { files, bytes,
byClassification }, pointers[], workspaces[], migration, interaction }`,
where `interaction` is the manifest's counts on a plan and, once applied,
`{ decision: merged, sessions, invocations, events, payloads }` (each
`{ added, kept }`), `{ decision: history, parentAgentId, path }` for a
fork, or `null` when the archive carries none. Errors are
`{ error: { code, message, action } }` with `--json`, exit 1.

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
