# ADR-0603: Imported skills keep local snapshots and upstream provenance

**Status:** Proposed
**Date:** 2026-10-07
**Issue:** [qwts/agent-bot-identity#603](https://github.com/qwts/agent-bot-identity/issues/603)

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

## Proposed decision

1. **Import is an explicit acquisition operation.** Add the proposed
   `agent-bot skill import <url|path>` command for a local skill directory,
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

## Alternatives considered

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

This document proposes the design only. Merging it does not implement the
feature, accept the decision, or close the originating feature issue.
