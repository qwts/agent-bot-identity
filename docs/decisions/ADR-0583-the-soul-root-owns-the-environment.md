# ADR-0583: The soul root owns the environment

**Status:** Accepted
**Date:** 2026-10-07
**Issue:** qwts/agent-bot-identity#583

Builds on [ADR-0332](ADR-0332-souls-are-the-agents-territory.md) (the soul
directory), [ADR-0276](ADR-0276-souls-carry-their-harnesses-as-pinned-npm-dependencies.md)
and [ADR-0322](ADR-0322-souls-carry-their-runtimes-and-non-npm-harnesses.md)
(what a soul carries). Owner direction, 2026-10-07: a soul is the agent's
life; it learns over time, and when it is shared, its life goes with it. A
new Mac with GeniusBar must need no brew, harness, node, python or go: each
soul declares what it needs and the engine provisions it inside the soul.

## Context

The pieces exist, scattered. The definition and the generated harness
config are in the root; the home is `.soul-state/home`; workspaces are
`worktrees/`, sometimes links. But every harness's native state is in the
user's HOME, shared by every soul (`~/.claude`, `~/.codex`,
`~/.local/share/opencode`, `~/.kiro`); node is the daemon's and non-npm
harnesses come from the host PATH; runtimes are host only (ADR-0322 is
Proposed, nothing implemented); the provider is not modelled; the Agent
Space is a symlink to `~/.agent-space/<id>`; history lives in the daemon's
journals under `~/.local/state/agent-bot`. Two codex souls share one
`~/.codex` login. A soul folder moved to another Mac loses its memory, its
sign-ins and its tools. A symlink is not containment.

## Decision

1. **The soul root is the environment.** Everything durable lives under
   it: definition at the top level, life under `.soul-state/` (`home`,
   `tools/<harness>`, `credentials`, `runtimes`, `space`, `runs`, `cache`,
   `tmp`). Package revisions and templates keep excluding `.soul-state/`
   and `worktrees/`.
2. **One classification contract**, versioned, in a pure module
   (`soul-env-contract.mjs`): `definition | generated | workspace | runtime
   | private-home | memory | history | cache | temp | external`, with
   retention `durable | reconstructible | disposable`. GeniusBar reads it
   and stops carrying its own lists.
3. **A descriptor command**, `agent-bot soul env <soul> [--json]` (schema
   1, every key always present), read-only: root, identity, components with
   classification and presence, declared against installed harnesses and
   runtimes, providers, launch routing, readiness problems with the command
   that fixes each, migration status, retention. The daemon serves it beside
   `soul profile`. `engine.capabilities` lets a client gate each later
   slice.
4. **`soul revision prepare <soul>`** stages the editable definition into
   `.soul-state/tmp/revision-<uuid>/` and returns the file list with
   per-file classification and `editable`; the existing `soul revision edit
   --apply` finishes it. GeniusBar #268 needs this first.
5. **Per-soul tool homes instead of a shared HOME.** Harness-specific
   routing only (`CLAUDE_CONFIG_DIR`, `CODEX_HOME`, XDG config, data and
   cache for OpenCode), never `HOME` and never `XDG_STATE_HOME` (every
   agent-bot child reads it). A harness with no routable store is reported
   `unsupported`, not faked. Existing sign-ins are adopted once with
   `soul env migrate --adopt-host-signin`. Supersedes ADR-0276 decision 5.
6. **Per-soul runtimes and harness installs, no host installs.**
   `runtimes.node|python|go` and `harnesses.<h>.install` in `soul.json`,
   versions resolved through a pin catalog bundled with agent-bot (explicit
   `sources` in the package win and are reviewed as a revision). Installs
   go under `.soul-state/runtimes/` through an atomic `.installing-*` then
   rename; a failed install never removes the previous one. Node tarballs
   ship npm, so no host npm; uv is provisioned per soul like any binary.
   Only verified download archives are shared
   (`~/.cache/agent-bot/downloads`). Supersedes ADR-0322 decisions 6 and 7
   (the shared install cache and host-bundled uv), and adds go.
7. **Provider per harness**: `harnesses.<h>.provider { id, baseUrl?,
   envKey?, wireApi?, credential? }` plus `credentials.secrets.<name>
   { store }`; the builder renders codex `model_providers` and the
   non-secret env; at launch the secret is injected only into that soul's
   harness process and stripped from the MCP child. New owner-gated
   `soul secret <soul> set|clear|status` (value on stdin, never argv).
8. **Memory moves into the soul**: `.soul-state/space` becomes a directory
   and the census `spacePath` is authoritative. Supersedes ADR-0332
   decision 5's Agent Space link. One soul at a time via `soul env migrate`,
   journaled, resumable, the source retired only after verification.
9. **History is mirrored per soul** under `.soul-state/runs/` in addition
   to the daemon's journals, so recovery paths do not change and an export
   carries it.
10. **Export and import carry the life**: definition, home, tool state minus
    sign-in files, memory, history, settings, revision journal, soul-owned
    workspaces whole and linked ones as pointer, patch and untracked files.
    Never credentials, secrets, sign-ins, runtimes or caches. Import keeps
    the Agent ID (a moved life); `--fork` mints a new one; an active local
    ID is refused unless `--replace`.

## Consequences

- One root to back up, copy or export. What is reconstructible (generated
  output, runtimes, caches) is rebuilt from the definition; what is durable
  is never rebuilt and must travel.
- Disk per soul: each soul carries its own node, python or go. Only the
  verified archives are shared.
- `HOME` stays the host's. A harness that cannot be routed stays shared and
  says so in `launch.limitations`, rather than being faked.
- A soul from before slice 5 keeps its Agent Space linked until the owner
  runs `soul env migrate --space-into-soul`; the descriptor reports it as
  `location: linked`, `contained: false`, `memory-not-contained`, with a
  pending migration step. New souls start contained.
- `soul revision edit --apply` removes the exact generated output a staging
  leaves out; the next build or launch regenerates it.

## Follow-up slices

Slice 1 (this record, implemented): contract, descriptor, `revision
prepare`, daemon route. Each later slice is releasable alone; 3 precedes 4
and 5 precedes 7.

2. Launch environment contract: per-soul tool homes, sign-in adoption.
   Shipped: `soul-tool-homes.mjs`, `soul-env-migrate.mjs`, launch routing
   of `CLAUDE_CONFIG_DIR`, `CODEX_HOME` and OpenCode's XDG bases decided
   per launch from sign-in presence (a host sign-in the soul lacks stays
   `shared-host` until adopted), the `tool-home` stage,
   `soul env migrate --adopt-host-signin`; see
   [soul-tool-homes.md](../soul-tool-homes.md).
3. Per-soul runtimes and harness installs (implements #322). Shipped:
   `soul runtimes`, `runtime-catalog.mjs`, launch routing; see
   [soul-runtimes.md](../soul-runtimes.md).
4. Providers per harness and `soul secret`. Shipped: `harnesses.<h>.provider`,
   `credentials.secrets`, `soul-providers.mjs`, `soul secret`, launch
   injection and the `provider` stage; see
   [soul-providers.md](../soul-providers.md).
5. Memory and history containment, with migration. Shipped: new souls get
   `.soul-state/space` as a directory and the census `spacePath` is what
   every reader resolves (`soul-memory.mjs`); the owner-gated, journaled,
   resumable `soul env migrate --space-into-soul` (copy into a staging,
   verify sizes and SHA-256, switch, census, source retired never deleted);
   the per-soul history mirror `.soul-state/runs/` (`soul-history.mjs`,
   appended from the turn registry, the session binding and the revision
   journal, best effort); `memory-not-contained`; see
   [soul-memory-history.md](../soul-memory-history.md).
6. Migration completion, a doctor check, `soul env clean`. Shipped:
   `soul env migrate --complete` (every step the descriptor lists as
   pending, interrupted or failed, run through its own verb's mechanism and
   recorded in the same journal; owner-gated once, refused while the soul
   runs, `--plan` read-only; `harnesses-into-runtimes` is listed and stays
   pending for a later release); `soul env clean` (`soul-env-clean.mjs`:
   only `cache`, `temp` and the runtime caches and install stagings under
   `runtimes`, each path classified by the contract before removal, a
   revision staging kept within its 24-hour window, installed runtimes and
   generated output left to their own commands, the retired space source
   outside the root left to the owner; `--plan` with sizes; the run
   recorded in `.soul-state/clean.json`); the doctor check
   `souls.environment`, one per active soul from the same descriptor;
   capabilities `migrate-complete` and `env-clean`; see
   [soul-environment.md](../soul-environment.md).
7. Export and import.
