# ADR-0645: One runtime repository, four owned modules, contracts before moves

**Status:** Proposed
**Date:** 2026-10-08
**Issue:** [qwts/agent-bot-identity#645](https://github.com/qwts/agent-bot-identity/issues/645)

## Context

[#645](https://github.com/qwts/agent-bot-identity/issues/645) proposes
consolidating this repository and
[agent-comms](https://github.com/qwts/agent-comms) into one runtime. It would
have four capabilities:

- **identity:** who am I, and what may I do?
- **soul:** what am I, and how do I operate?
- **harness:** what can a harness do, and how is it configured?
- **comms:** how do I interact?

Organization, SOP and harness-documentation sources stay in their own
repositories.

The code at `a339a31` shows why ownership must be fixed before code moves:

- **There are no boundaries to move along.** About 135 runtime `.mjs` files sit
  in one flat directory.
- **Identity and soul import each other.** `agent-identity.mjs` imports
  `soul-genesis.mjs` and `soul-package.mjs`, and `soul-genesis.mjs` imports it
  back. `identity-app-store.mjs` and `soul-credentials.mjs` import each other.
- **The GitHub App credential custody sits in a file named for souls.**
  `soul-credentials.mjs` holds `resolveAppCredential`.
- **The authorization gate depends on the soul census and the comms client.**
  `owner-gate.mjs` imports `agent-population.mjs` and `comms-client.mjs`.
- **Nine soul modules import the daemon process host** (`agent-daemon.mjs`),
  mostly for `daemonClient`.
- **Harness knowledge is spread across about a dozen tables** whose keys
  disagree:
  - in this repository: `acp-registry`, `soul-tool-homes`, `soul-builder`,
    `hook-dialects`, `detect-harness`, `organization-profile`, `soul-package`,
    `wake-resume` and `harness-auth`;
  - outside it: agent-comms `lib/worker/adapters.mjs`, GeniusBar `launch.ts`,
    and the qwts-agent-org roster;
  - the disagreements include `claude` vs `claude-code`, `devin` vs
    `devin-desktop`, and `qwen` vs `qwen-code`.
- **[qwts/harness-docs](https://github.com/qwts/harness-docs) has no commits
  yet.**

Moving files in this state would carry every cycle into the new layout. The
result would be unreviewable and could break the installs GeniusBar, Homebrew
and the Linux bundle ship today.

Accepted records constrain the design:

- **Provisioning belongs to the soul:**
  - [ADR-0276](ADR-0276-souls-carry-their-harnesses-as-pinned-npm-dependencies.md):
    souls carry their harnesses as pinned npm dependencies.
  - [ADR-0322](ADR-0322-souls-carry-their-runtimes-and-non-npm-harnesses.md):
    souls carry their runtimes and non-npm harnesses, with a reviewed pin
    catalogue bundled with each release.
  - [ADR-0583](ADR-0583-the-soul-root-owns-the-environment.md): the soul root
    owns the environment.
  - None of these allows a declared requirement to fall back to another version.
- **Install channels:** [ADR-0332](ADR-0332-souls-are-the-agents-territory.md)
  decision 1 ships `agent-bot` and `agent-comms` together through three
  channels, with one daemon and one broker per OS user.
- **agent-comms placement:**
  - [agent-comms
    ADR-0002](https://github.com/qwts/agent-comms/blob/main/docs/decisions/ADR-0002-messaging-plane-on-the-agent-bot-daemon.md)
    rejected, "for now", putting agent-comms inside this repository, so that
    messaging could ship on its own cadence.
  - [agent-comms
    ADR-0059](https://github.com/qwts/agent-comms/blob/main/docs/decisions/ADR-0059-host-apps-embed-agent-comms.md)
    has host apps embed pinned agent-comms and agent-bot releases as a
    compatible set.
- **Org-level runtime ownership:**
  [ENG-0128](https://github.com/qwts/qwts-agent-sop/blob/main/docs/decisions/ENG-0128-agent-bot-runtime-ownership.md)
  (Proposed) makes this repository the identity runtime owner. Its boundary is
  "invoke `agent-bot`; no imports, vendoring or submodules".

## Decision

### 1. One source repository, logical modules first

- **The runtime's source home is this repository.** Its name, the `agent-bot`
  command, service labels and state paths stay as they are. A rename is a
  separate decision.
- **Each runtime file has one owning module, recorded in
  [`governance/runtime-modules.json`](../../governance/runtime-modules.json).**
  - Modules are logical first. A file moves into a module directory only when
    its module has no remaining boundary crossings, one module per PR, behind
    re-export shims at the old paths.
  - The modules are `identity`, `soul`, `harness`, `comms`, `org` and `shared`,
    plus two composition roots, `host` and `cli`. When the agent-comms broker
    moves in (§5) it becomes one more module, `comms-broker`.
- **No new process, package, binary or service is created to mirror a module
  name.**
  - `agent-bot` stays the command facade. An `agent-identity` or `agent-soul`
    binary needs a demonstrated consumer first.
  - The identity daemon, `keyd` and the agent-comms broker remain separate
    processes with their current sockets, labels and authentication.

### 2. Dependency rules

These are enforced by `tests/module-boundaries.test.mjs`:

| Module | May import | Owns |
| --- | --- | --- |
| `shared` | nothing | Configuration, shell path, logging; nothing that reads a credential or secret |
| `harness` | `shared` | Harness knowledge: detection, hook dialects, configuration conventions, capability descriptors |
| `org` | `shared` | Organization and SOP source resolution from pinned external data |
| `identity` | `harness`, `org`, `shared` | Principals, Agent IDs, execution bindings, credential custody (App keys, secret stores and providers), token minting, authorization, owner gate, revocation, audit |
| `comms` | `identity`, `org`, `shared` | In-process client side: broker client, relay, wake listener and dispatch, task turns |
| `soul` | `identity`, `harness`, `comms`, `org`, `shared` | Definition, packages, population, lifecycle, workspace, environment, provisioning, configuration generation, launch, resume |
| `host` | all but `cli` | The daemon, its supervisor and wake plane, MCP servers, the interaction plane, the hook runner, adapters, session metrics |
| `cli` | all | `agent-bot` dispatch, install, update, doctor, readiness |

Consequences of these rules:

- **Nothing may import `soul`** except `host` and `cli`. So identity can never
  depend on whether a soul exists, and neither can comms.
- **Nothing in a capability module may import a process host.**
- **`harness` and `org` are leaf knowledge.** They cannot reach credentials,
  launch code or routing. That holds because every credential-capable file
  (App key stores, `secret*.mjs`, `secret-providers/*`, token minting) is
  owned by `identity`, and `shared` holds none. The test lists those files and
  fails if one is reassigned.
- **The policy graph is acyclic.** `cli` may import `host`; `host` never
  imports `cli`.
- **The 31 crossings that exist today form the test's `baseline`.**
  - A new crossing fails the test.
  - A removed crossing must also be removed from the baseline, so the baseline
    only shrinks.
  - Widening a module's `may_import` row is an architecture decision: a new
    record that supersedes this one, never a silent edit to the map. The test
    keeps its own frozen copy of this table, so a map edit alone fails.
  - An `import()` whose specifier is computed hides its target from the check.
    The test fails on one unless the map lists that file, with a reason, under
    `computed_imports`. Today there are none.

### 3. Authority and data ownership

- **Identity is the only authority.**
  - Only identity modules read App keys or secret stores, mint tokens, verify
    execution bindings, or decide owner and principal authorization.
  - Soul code obtains credentials through identity's exported functions or the
    daemon's `/v0/credential` route, never by reading key stores itself.
  - An ID that names a soul is not proof. The authenticated execution binding
    is.
- **Soul owns its persisted state:**
  - the `<name>.soul` layout described by `soul-env-contract.mjs`;
  - `population.json`;
  - workspaces, runtimes and generated harness configuration.
- **Comms owns** broker state, mailboxes, pairings, tasks and A2A routes. A soul
  exists without comms membership.
- **Harness owns no persisted runtime state.** It reads a bundled, commit-pinned
  snapshot of harness knowledge (§4).
- **No state path, file format, service label or command name changes under this
  record.** Any change needs its own migration and rollback plan.

### 4. agent-harness is knowledge, never authority

- **Descriptors.** `harness` will expose descriptors sourced from
  `qwts/harness-docs` for each capability (instructions, skills, hooks, MCP,
  subagents, session launch and resume APIs, platforms, runtimes, adapters).
  A capability is not one status. It has independent dimensions, each with its
  own provenance and its own `unknown`:
  - **Documentation evidence:** what the harness documents, `documented`,
    `documented-unsupported` or `unknown`, with the harness-docs commit and
    path.
  - **Applicability:** the harness versions and platforms the evidence covers.
    Outside that range the answer is `unknown`.
  - **Adapter support:** whether this runtime implements the capability for the
    harness (`implemented`, `not-implemented`, `unknown`) and which test covers
    it.
  - **Local observation:** what the soul observed on this machine: installed
    version, sign-in, a successful use, and when. It is never in the bundled
    snapshot, because a snapshot cannot prove a local install.
  - A missing claim is `unknown` in every dimension, never assumed.
  - A launch or privilege decision may rest only on adapter support and local
    observation. Documentation evidence alone never enables anything.
- **Pinned and offline.** The harness-docs data is pinned by commit, validated
  against a schema, and bundled with each runtime release, the same way
  `runtime-catalog.mjs` is reviewed per release. The runtime never needs network
  access to answer.
  - A newer snapshot is a reviewed change.
  - Staleness is reported, never silently refreshed.
- **Documentation is not authority:**
  - A descriptor never selects, pins, installs or launches anything.
  - It never supplies a version pin, so ADR-0276 and ADR-0322 pins stay with the
    soul.
  - Content from harness-docs is never executed.
  - Documentation evidence is never reported as installed, signed in or
    locally verified. Those are local observations, which the soul makes.
- **What moves.** Tables that *describe or classify* move to `harness`,
  gradually and each behind its existing exports: hook dialect shapes, tool-home
  routability, configuration file conventions and harness detection.
- **What stays.** Tables that *select, pin, install or launch* stay in `soul`:
  `acp-registry` spawn rows, `runtime-catalog`, `soul-builder` generation and
  `soul-providers`.
- **Harness keys.** Each harness keeps one canonical key. Today's spellings
  resolve through an alias table, and no persisted key (`soul.json`
  `preferredHarnesses`, config slugs, the roster) is rewritten.

### 5. agent-comms joins without losing its seams

- **History.** agent-comms moves in with its history, issues and ADRs traceable.
  It stays its own package root with its own `package.json`,
  `bin/agent-comms.mjs` and `lib/principal-client.mjs` at stable relative paths,
  because GeniusBar imports that file directly.
- **Unchanged.** The `agent-comms` command, broker service label, sockets, wire
  protocol and state directories do not change.
- **Wire contracts only.** The broker keeps authenticating souls through the
  daemon's vouch token (`/v0/vouch`) and the binding proof. It does not import
  identity internals; ENG-0128's no-imports boundary holds at the wire.
  - The broker's files form their own module, `comms-broker`, whose
    `may_import` is `shared` and the wire-contract files only. It may not import
    `identity`, `comms`, `soul` or `host`, and the boundary test enforces that
    like any other rule.
  - The `comms` client module may use identity's exported functions; the broker
    may not. Sharing a repository gives the broker no in-process path to
    identity, and the daemon and broker share no secrets (see Non-goals).
  - The two byte-identical copies of `binding-proof.mjs` become one shared
    contract file only once both trees live here.
- **Ordering.** This move comes after the boundary work. It is gated on this
  record and on the ENG decision in question 1. Nothing changes agent-comms
  ownership, its release contract or ENG-0128's boundary until that decision is
  recorded.

### 6. One coordinated release

A release produces the `agent-bot` and `agent-comms` artifacts from one tag as
one tested compatible set:

- the Homebrew formulae;
- the Linux bundle, whose `components.json` agent-comms pin becomes the same
  tag;
- the GeniusBar component pins.

Compatibility checks in GeniusBar (`scripts/compat-check.mjs`, its ADR-0282
minimum-reader policy) keep working: old tags remain fetchable, and pins never
move backwards.

### Supersedes and amends (on acceptance)

- **agent-comms ADR-0002:** superseded in part. The rejected alternative "put
  agent-comms inside agent-bot-identity" becomes the decision. Its process and
  security separation (broker separate from the daemon, versioned interfaces
  between them) is retained.
- **ADR-0332 decision 1:** amended. The three channels and both commands remain,
  but they are built from one tag.
- **agent-comms ADR-0059 decision 1:** amended. The embedded "pinned agent-comms
  and agent-bot releases" become one release that ships two components.

## Migration strategy

The work is done in dependency order. Every step is its own PR, keeps observable
behavior, and shrinks the baseline or adds a contract:

1. **Module map and boundary ratchet** (this record's companion PR). No code
   moves.
2. **Identity untangling:**
   - App credential custody moves out of `soul-credentials.mjs` behind a
     re-export shim.
   - The `agent-identity` ↔ `soul-genesis` and `soul-package` cycle is broken by
     passing the package revision in.
   - The owner gate gets its soul census and comms dependencies through
     parameters.
   - Overlaps the [#104](https://github.com/qwts/agent-bot-identity/issues/104)
     epic, which it should be reconciled with.
3. **Daemon client contract.** `daemonClient` moves out of `agent-daemon.mjs`,
   so soul modules stop importing the process host.
4. **Harness descriptor schema** in harness-docs plus a validator and bundled
   snapshot in `harness`, starting with every claim `unknown` and
   evidence-backed entries added by review.
5. **Harness knowledge consolidation.** Descriptive tables read from `harness`,
   and the key alias table is added. Selection tables stay in soul.
6. **Physical module directories**, one module at a time once its crossings
   reach zero, with shims at the old paths.
7. **agent-comms history import** and a combined CI run of both suites.
8. **Coordinated release:** formulae, Linux bundle, GeniusBar pins and
   compatibility fixtures; overlaps
   [agent-comms#127](https://github.com/qwts/agent-comms/issues/127).
9. **Organization and SOP integration:** org capability pins for the runtime
   entries
   ([qwts-agent-org#32](https://github.com/qwts/qwts-agent-org/issues/32)) and
   SOP references.
10. **Verification against #645's acceptance criteria**, then a completion
    report. Old repositories are archived or redirected only after a validated
    rollout.

Rollback for steps 1 to 6 is a revert. They change no persisted state or
installed surface. Steps 7 to 9 each carry a written rollback before they merge.

## Alternatives considered

- **Move files into `packages/*` first, then untangle.** Rejected. Every cycle
  would come along, PRs would mix moves with behavior, and GeniusBar's path
  assumptions would break at once.
- **One npm workspace package per module, published separately.** Rejected for
  now. There is no consumer for separate packages, it adds tooling to a
  zero-dependency runtime, and it multiplies the release surface ADR-0332 just
  settled.
- **A separate `agent-harness` repository or service.** Rejected. harness-docs
  is the independent source. A second repository or a network service would add
  an online dependency and a second registry.
- **Keep two repositories and only add contracts.** This is the fallback if
  consolidation is not accepted. Steps 1 to 5 deliver value either way.

## Non-goals

- Merging agent-org, qwts-agent-org, agent-sop, qwts-agent-sop, harness-docs or
  GeniusBar into this repository.
- Combining the daemon, keyd and broker into one process, or sharing their
  secrets.
- Renaming commands, services, state directories or this repository.
- Rewriting identity, soul, messaging or authorization protocols.
- Changing installed harness versions or pins.

## Questions before acceptance

1. Does the umbrella decision need an ENG record under ENG-0001, since it
   changes agent-comms, GeniusBar, qwts-agent-org and SOP references? Should
   that record extend ENG-0128 or supersede it? Accepting this record does not
   answer this: migration steps 7 and 8 stay blocked until it is answered.
2. Is standalone agent-comms deployment, or a replaceable comms identity
   provider, a real requirement? If yes, comms keeps its own release cadence and
   §6 changes.
3. Which harness key vocabulary is canonical: the roster's (`claude-code`,
   `qwen-code`) or the runtime's (`claude`, `qwen`)?
4. What is the Node engine floor for the combined tree? agent-bot is `>=20`;
   agent-comms is `^22.22.2 || ^24.15.0 || >=26`.

## Consequences

- Reviewers see ownership and every crossing a PR adds or removes. The cost is
  maintaining the map: a new runtime file must be assigned before its PR passes.
- The baseline makes today's debt explicit: 12 identity → soul imports, 10 soul
  → host imports, and 9 others.
- Physical consolidation is slower. Each module moves only once it is untangled.
- agent-comms loses an independent release cadence. Question 2 is the escape
  hatch.
