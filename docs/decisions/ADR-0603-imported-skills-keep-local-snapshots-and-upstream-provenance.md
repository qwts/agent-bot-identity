# ADR-0603: Soul skills have distinct import, install, learn, and dream operations

**Status:** Accepted
**Date:** 2026-10-07
**Issue:** [qwts/agent-bot-identity#603](https://github.com/qwts/agent-bot-identity/issues/603)
**Acceptance:** [Owner acceptance on PR #604](https://github.com/qwts/agent-bot-identity/pull/604#issuecomment-6050210566), 2026-10-07.

## Context

A skill can contain scripts, references, and assets as well as `SKILL.md`.
Its instructions may depend on files retrieved from mutable URLs. Copying
only the entrypoint leaves those dependencies remote or missing, and a
later fetch can silently change the instructions an agent reads.

The existing [`agent-bot skill`](../skills.md) command discloses bundled or
catalogued skills without installing them. [Issue #312](https://github.com/qwts/agent-bot-identity/issues/312)
tracks per-skill manifests, instruction capture, and explicit source
rechecks within soul packages. Its first slice already provides
[`skill-manifest.mjs`](../../skill-manifest.mjs), with exact-byte digests,
file modes, and revision diffs. Neither defines a standalone import into a
local skill library.

Local adaptation complicates change detection: replacing a dependency URL
with a local path intentionally changes a file. Comparing that edited file
directly with upstream cannot distinguish the agent's adaptation from the
source author's change. Both versions and their relationship must survive.

Importing files into a library does not make them available to a harness or
useful to a soul. Installing a skill at a repo or user location is different
from an agent progressively incorporating useful pieces into its own skills.
Learning and ongoing knowledge maintenance require agent judgment and may
use tools that this runtime does not provide. They must not assume that
every soul has an embedding service, retrieval index, or knowledge graph.

## Command boundary and governance

[ENG-0064](https://github.com/qwts/qwts-agent-sop/blob/main/docs/decisions/ENG-0064-cli-skill-command-family.md)
and its [command contract](https://github.com/qwts/qwts-agent-sop/blob/main/docs/reference/cli-skill-command-contract.md)
reserve `<cli> skill` for the CLI's own bundled router, feature references,
bundle path, and guarded export. Its `list` lists the CLI's features; it is
not an imported-skill catalog. All lifecycle commands proposed here live
under **`agent-bot soul skill`**, including optional search/status interfaces.
No new lifecycle aliases are added under `agent-bot skill`. Existing legacy
disclosure behavior remains unchanged by this proposal; alignment of that
behavior with ENG-0064 is separate work.

The namespace identifies the soul subsystem, not necessarily one soul:
import/list/show/verify can operate on the shared local library without a
soul identity, install selects a repo/user target, and learn/dream or
soul-scoped retrieval select a soul explicitly. The library remains at
`~/.agent-bot/skills/<uuid>/<name>/`; its location does not change with the
command spelling.

The no-install direction in
[ENG-0055 decision 6](https://github.com/qwts/qwts-agent-sop/blob/main/docs/decisions/ENG-0055-every-cli-ships-its-agent-skill.md)
and the [ENG-0006 amendment](https://github.com/qwts/qwts-agent-sop/blob/main/docs/decisions/ENG-0006-agentic-primitives-governance.md#amendment-2026-09-23)
protects against repo and context rot: duplicated or stale skill copies and
irrelevant discovery metadata accumulating in every session. Preserve that
intent with library-first storage and on-demand consumption. Installation
is an explicit, managed product capability, not the default way to load
skills or a requirement for learning. Organization packs retain applicable
source/placement restrictions, including the governed CLI/shared-skill
rules; a namespace change does not waive them. This product proposal does
not amend those accepted decisions.

## Decision

1. **Import is an explicit acquisition operation.** Add the proposed
   `agent-bot soul skill import <url|path>` command for a local skill directory,
   local `SKILL.md`, direct skill-document URL, or supported repository
   skill-directory URL. Preserve existing disclosure commands. Import
   neither executes the skill nor activates it in a harness, overrides a
   catalog entry, or adopts it into a soul. Local import requires no soul,
   GitHub App, or organization SOP, consistent with [ADR-0274](ADR-0274-product-is-mechanism-add-ons-and-sop-packs-carry-policy.md).

2. **A UUID identifies a library record; its name identifies the payload.**
   Use `~/.agent-bot/skills/<uuid>/<name>/` for the usable skill files. Keep
   the versioned manifest and immutable upstream snapshots beside that
   directory, outside the payload's checksum scope. Different imports can
   share a name without overwriting one another. A name change does not
   change the UUID. The following layout is illustrative; snapshot storage
   and deduplication remain implementation design choices:

   ```text
   ~/.agent-bot/skills/<uuid>/
     manifest.json
     snapshots/<revision>/...
     <name>/
       SKILL.md
       scripts/
       references/
       assets/
       remote/
   ```

3. **Capture the selected package and bounded, discoverable dependencies.**
   Preserve the skill directory's relative layout and supporting files,
   subject to documented exclusions. For a local `SKILL.md`, its containing
   skill directory is the declared import root. For remote sources, resolve
   relative references against the source that supplied them; record both
   original and final locations when redirects occur. Follow supported
   file/instruction references recursively with cycle detection and limits
   on time, depth, file count, and bytes. This is not a whole-site crawl or
   a promise to discover dynamically constructed dependencies. Report
   captured, unresolved, and deliberately external references separately;
   a partial import must never claim to be self-contained.

4. **Provenance and integrity describe exact bytes.** A schema-versioned
   manifest records relative file paths, modes, sizes, SHA-256 digests, dependency
   edges, secret-free source/resolved locations, retrieval times, and
   repository commits when available. Keep the refresh locator separate
   from the immutable revision used for the snapshot. A branch can be a
   refresh locator; the retrieved commit is the snapshot's identity.
   Reuse the existing manifest's mode-sensitive comparison semantics.
   Define canonical ordering and checksum scope, excluding the manifest's
   own digest field from any aggregate hash. Preserve raw bytes, including
   binary content and line endings. Stage acquisition before publishing a
   coherent library record, with explicit incomplete status when needed.

5. **An agent reviews local-reference replacements.** Import emits a
   report with the referring file and location/context, original reference,
   captured local path, and unresolved reason where applicable. Advise the
   agent to replace dependency URLs with direct local file references and
   verify that those references resolve. Do not blindly replace citations,
   service endpoints, or refresh locators. The report supports adaptation;
   import does not silently alter instruction semantics. Recompute and
   record the local baseline after reviewed edits, while retaining the
   original upstream snapshot and mapping.

6. **Source checks stage changes; adoption is separate.** Preserve three
   distinct records: the accepted upstream snapshot, the locally adapted
   payload with its recorded baseline, and any newly fetched upstream
   candidate. Compare old upstream with new upstream for source changes,
   old upstream with the local payload for adaptations, and the recorded
   local baseline with current local files for subsequent local edits.
   Report added, removed, and modified paths with old/new digests and text
   diffs where meaningful. Retain both versions for binary inspection.
   Distinguish unchanged, changed, and unavailable; a timeout is not
   evidence that a source is unchanged. A source check never replaces
   accepted files. Agents explain changes from the actual diffs, and a
   later adoption action preserves local edits or surfaces conflicts.
   Command names for checking, recording adaptations, and applying updates
   are not decided by this ADR.

7. **Reuse soul revision policy at the adoption boundary.** The library is
   an acquisition source, not a second soul revision engine. Coordinate
   manifest and dependency-capture contracts with #312. When a soul adopts
   a skill, materialize the selected bytes and provenance into its versioned
   package through the existing package/revision proposal flow. Do not
   leave an accepted soul package depending on a mutable library symlink.
   Updating the library must not silently update any consuming soul. This
   preserves [ADR-0583](ADR-0583-the-soul-root-owns-the-environment.md)'s
   containment requirement: a soul carries its adopted skill files.

8. **Treat imports as untrusted data.** Never execute imported scripts or
   follow instructions in fetched text during acquisition. Constrain writes
   to the import root; reject path traversal and escaping symlinks. Bound
   redirects and revalidate network destinations, including private/local
   targets, at each hop. Do not forward credentials across origins or
   persist authorization headers and secret-bearing URLs. A refused or
   unavailable dependency is explicit in the report. Checksums establish
   byte identity and change detection, not authenticity, approval, or safety.

9. **Install targets a repo or user harness location.**
   `agent-bot soul skill install <skill> --harness <h> --repo <path>` or `--user`
   places a selected local revision through a harness-specific adapter.
   Record the destination, revision, managed files, and checksums; refuse
   unsupported targets and conflicting files. `uninstall` removes the
   managed installation, preserving the library and surfacing local edits.
   Placement and verified harness discovery are separate outcomes; report
   any reload requirement. Prefer library references and task-scoped reads
   when placement is unnecessary. Do not bulk-install the library or add
   every imported skill's metadata to repo instructions or session context.
   Managed placement must remain attributable, verifiable, and removable so
   it does not become an abandoned copy. There is no `install --soul`
   shortcut: the soul path is agent-guided learning through its revision
   policy. Apply the selected organization's installation restrictions.

   **Amendment, 2026-10-09 (owner direction on #603):** install places a
   skill in the soul's own `<soul>/skills` and records its file hashes; the
   agent discloses it progressively and adds it to a workspace only while it
   is needed. Global targets (`~/.agent/skills`, `~/.<harness>/.../skills`)
   are opt-in and only for a skill with a clear reason to always load. Skills
   no longer relevant are archived to a folder in the soul, or moved to the
   trash by the user. A repo's harness config folders are generally
   gitignored. `soul skill install <skill> --soul <soul>` therefore exists;
   it still records through the soul revision path (owner edit or soul
   proposal). See [soul-skills.md](../soul-skills.md#install-into-a-soul).

10. **Learn instructs an agent; it is not an ingestion pipeline.**
    `agent-bot soul skill learn <skill> --soul <soul>` supplies the entrypoint,
    provenance, previous learning outcomes, and guidance for progressive
    consumption. The agent selects relevant procedures, references, scripts,
    and assets, follows their dependencies, and adapts useful material into
    the soul's skills through the existing revision workflow. It need not
    adopt the whole source skill. Record adopted source revisions and local
    destinations so later source changes can be compared against the pieces
    and dependencies the soul actually uses.

    Guide the agent to discover existing knowledge tools and, where useful
    and authorized, make adopted material retrievable through embeddings,
    graph relationships, or other available capabilities. The guidance
    describes outcomes and general methods, not mandatory providers or tool
    calls. If a capability is absent, the agent explains what is missing
    and how the user can configure it. The runtime neither provisions a new
    external service implicitly nor claims to have embedded content merely
    because files were copied. Report completed, skipped, and blocked work
    with evidence from files or tools; record inference as inference.

11. **Dream schedules agent-driven maintenance of the soul's knowledge.**
    `agent-bot soul skill dream --soul <soul> --schedule <schedule>` registers or
    updates a recurring maintenance task, analogous to `git maintenance`.
    The runtime owns scheduling, execution bounds, overlap prevention,
    checkpoints, and run records. The task instructs an agent to review
    changed memories, conversations, learned skills, and other eligible
    soul contents; consolidate useful knowledge; refresh embeddings; repair
    references and graph relationships; and remove stale derived material
    using available tools. It is not a deterministic embed-and-delete job.

    A deleted source's embedding or a dangling relationship can be removed
    as stale derived data. Superseded source knowledge can be consolidated
    or retired under the soul's retention/revision policy, preserving
    provenance; age or lack of recent retrieval alone does not establish
    that a memory or conversation is disposable. Missing tools permit
    partial maintenance with an explicit outcome, not fabricated success.
    Repeated registration updates the existing soul task. Provide run-now,
    status, pause, and unschedule controls. Operate quietly when nothing
    actionable changes; notify on meaningful changes, failures, or required
    user action without repeating unchanged missing-capability notices.
    No maintenance task is registered by import, install, or this proposal.

12. **Knowledge interfaces adapt to available capabilities.** Prioritize
    `agent-bot soul skill search --soul <soul> "<query>"` and
    `agent-bot soul skill status --soul <soul>` when a retrieval/capability
    contract is defined. Search queries configured tools and returns local
    citations and source revisions; it does not launch learning as an
    implicit substitute for retrieval. Status distinguishes tool-verified
    coverage and health from an agent's last report, including unknown or
    unsupported states. Do not require agent-bot to own a vector database,
    graph engine, embedding model, or universal network interceptor.
    Retrieval and indexes must respect the soul's eligible-content and
    provider boundaries. Derived entries retain source checksums and
    revision references; removed content stops appearing as current
    knowledge. Source-backed relationships and inferred ones remain
    distinguishable. Exact adapter schemas are a follow-up design question.

## Command scope

The names below describe the accepted design; this record adds no runtime commands.
Abbreviated verbs in each row share the `agent-bot soul skill` prefix.

| Surface | Responsibility |
| --- | --- |
| `soul skill import`, `list`, `show`, `verify` | Acquire, discover, explain, and verify library content; provide structured output for agents. |
| `soul skill install`, `uninstall` | Manage a selected revision at an explicit repo or user harness location. |
| `soul skill learn` | Guide progressive, agent-led adoption into a soul and optional knowledge-tool integration. |
| `soul skill dream` | Register and manage recurring, agent-driven soul maintenance. |
| Source check, diff, explicit update | Stage, explain, and adopt upstream candidates separately; exact command names remain open. |
| `soul skill search`, `status` | Query configured capabilities and report evidenced state when a common interface is available. |

Defer a dedicated `soul skill inspect` command until indexed items have a
stable identity/provenance contract. Defer `soul skill reindex` and `graph`;
focused dream tasks can guide available tools without assuming a universal
backend. References can be a `show` view, recording can reuse revision
tooling, and installation upgrades can select another revision through
`install`. Separate snapshot, learned, upgrade, forget, rollback, and export
verbs are not commitments of this proposal. Integrating knowledge into other
skills makes forgetting an agent-guided revision, not necessarily the inverse
of copying a file.

## Consequences

- Agents can work from inspectable local files and explain upstream changes
  without confusing them with intentional local adaptations.
- Retained snapshots and provenance make update review and recovery
  possible, but consume disk space. Retention and deduplication need a
  policy that preserves revisions still used by a soul or pending review.
- Acquisition is useful before harness installation or soul adoption, but
  introduces an additional lifecycle boundary that users must understand.
- Reference discovery is necessarily incomplete for dynamic instructions,
  scripts, inaccessible sources, and unsupported document formats. The
  command must expose that limitation instead of treating a successful
  download as proof of a complete skill.
- Agent-assisted rewriting preserves context but requires an explicit way
  to record and verify the edited local baseline. Update conflicts can
  require human review.
- Hashes alone do not make skills trusted. Existing selection, review, and
  adoption policies remain necessary where the user or organization uses
  them.
- A soul can learn without a repo/user installation and can perform useful
  maintenance without embeddings or a graph. Outcomes vary with available
  tools, so reports need evidence and explicit partial-completion states.
- Harness placement adapters and optional knowledge interfaces add contracts
  to maintain. Agent-bot provides a common workflow without committing to a
  particular knowledge-storage implementation. A distinct soul skill
  namespace preserves the application-skill discovery contract.
- Dream tasks consume execution resources and can change durable knowledge.
  Scheduling must be explicit, bounded, inspectable, and reversible; source
  consolidation follows retention/revision policy rather than an age cutoff.

## Alternatives considered

- **Use `agent-bot skill` for lifecycle management:** rejected. ENG-0064
  gives that surface a different contract; even `list` and `show` would
  otherwise have incompatible meanings.
- **Install every imported skill for automatic discovery:** rejected.
  This recreates repo/context rot. Managed installation is deliberate;
  library reads and progressive learning require no blanket installation.
- **Copy only `SKILL.md`:** loses supporting files and leaves mutable
  dependencies outside the snapshot.
- **One checksum over the edited skill:** cannot distinguish upstream
  changes from local URL rewrites; a package-level digest alone does not
  explain which files changed.
- **Rewrite every URL automatically:** changes citations and operational
  endpoints as well as dependencies, and may change instruction meaning.
- **Refresh in place:** silently replaces accepted instructions and can
  destroy local adaptations before an agent explains the change.
- **Keep only source URLs or use a live symlink into the library:** accepted
  instructions can change outside the soul's revision/proposal mechanism.
- **Make every import a soul revision:** prevents standalone collection and
  review, and couples acquisition to adoption unnecessarily.
- **Install the whole skill into a soul:** conflates harness placement with
  progressive learning and hides the agent's selection and adaptation.
- **Make learn/dream deterministic embedding pipelines:** assumes tools and
  storage choices that may be absent, and replaces judgment about relevance
  and consolidation with an inflexible sequence.
- **Build a mandatory RAG/graph engine first:** makes useful import, learning,
  and maintenance depend on a backend rather than on available capabilities.

## Questions before implementation

- Which remote adapters and reference syntaxes are supported first, and
  what exclusions define a local skill directory?
- Does repeating the same import create a fresh UUID or offer reuse of an
  existing record? How are duplicate names presented?
- Which commands and exit statuses distinguish complete import, partial
  capture, source checking, local-baseline recording, and update adoption?
- How should an agent record reviewed URL replacements so the mapping and
  local checksum baseline stay consistent?
- Which manifest/capture components are shared with #312, and how is their
  provenance carried into a soul package without inventing a parallel
  approval or revision model?
- What retention and source-authentication mechanisms are needed beyond
  the initial public-URL/local-file support?
- Which harness adapters and discovery checks ship first, and how does a
  new installation avoid conflicts with unmanaged skills?
- How are learn guidance, progressive disclosure, and evidenced learning
  outcomes handed between the CLI, agent, and soul revision workflow?
- Which existing task scheduler executes dream procedures, and what are the
  schedule syntax, resource bounds, checkpoints, and retention defaults?
- What minimal capability contract supports knowledge search/status without
  assuming an embedding provider, graph backend, or complete index coverage?

This document records the accepted design only. Acceptance does not implement
the feature or close the originating feature issue.
