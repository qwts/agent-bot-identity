# ADR-0322: Souls carry their runtimes and non-npm harnesses, with user overrides

**Status:** Proposed
**Date:** 2026-10-02
**Issue:** qwts/agent-bot-identity#322

Extends [ADR-0276](ADR-0276-souls-carry-their-harnesses-as-pinned-npm-dependencies.md)
(qwts/agent-bot-identity#307). Decision only; no implementation until the
owner approves this record.

## Context

ADR-0276 makes npm harnesses self-contained: a soul's package pins its
harness adapters, and the daemon runs `npm ci --ignore-scripts --omit=dev`
inside the soul home with the host's Node and npm. Everything else a soul
needs still comes from the host:

- **Node:** whatever the host provides (GeniusBar's bundled Node, or
  Homebrew's). A soul cannot pin a Node version.
- **Python:** not provided at all. A soul that needs Python tools, or a
  Python-based harness, works only if the user already has a suitable
  Python.
- **Non-npm harnesses** (`opencode`, `goose`, `muse`; binaries or Python
  tools): these must already be on PATH. The npm mechanism cannot carry
  them.

So a friend can run Starter on Claude out of the box, but not a soul built
on anything else.

## Decision

1. **`soul.json` may declare runtimes with version ranges and a default,**
   for example `"runtimes": { "node": "24.x", "python": "3.12" }`.
   `runtimes` is optional; absent means today's behavior (host Node, no
   Python). It rides as a preserved extension field: format-1 validation
   already retains unknown manifest fields and covers them in the package
   revision, so adding it changes no validation code — a package that
   declares runtimes is a new revision like any other edit. Unknown runtime
   names are rejected at provision time, not at pack time.
2. **The daemon provides declared runtimes per soul,** with no admin
   rights, no global install, and no system Python. Node resolves to a
   pinned per-platform download. Python resolves exclusively through
   **uv**: a single static binary a host can bundle the way GeniusBar
   bundles Node. uv installs the pinned Python — and the soul's Python
   packages from its lockfile — into the soul home or a shared,
   content-addressed cache (decision 6). There is deliberately no fallback
   to a system Python.
3. **Non-npm harnesses are declared with pinned downloads and checksums:**
   binary release assets (URL plus sha256 per platform), or `uv tool`
   packages for Python harnesses (package plus version pin; checksums via
   the lockfile). The daemon verifies the checksum before first use, and a
   mismatch fails the launch (decision 5) — a corrupt or tampered asset
   never runs.
4. **Overrides follow the harness order from #307 / ADR-0276 decision 4,
   extended to runtimes:** per-agent option, then the soul's default, then
   the host-bundled or daemon-provided runtime, then PATH. The user can
   always point a soul at their own `node` or `python`, per agent or per
   soul. An explicit user path is used as-is and never verified against a
   pin; everything the daemon fetches itself is pinned and checksummed.
5. **A launch fails with a clear, actionable error** naming the declared
   runtime or harness and the cause when it cannot be provided: offline,
   checksum mismatch, or unsupported platform. Provisioning is all or
   nothing: a failed provision leaves no half-installed runtime on the
   soul's PATH, and the launch error tells the user which override would
   unblock them (e.g. point the soul at an installed Python).
6. **Provisioning is idempotent and cached.** Cache entries are keyed by
   (kind, version, platform, checksum), so two souls that pin the same
   Python share one install; soul homes reference the cache, never copy
   it. Garbage collection is mark-and-sweep against live soul homes and
   their package revisions: entries no live soul references may be
   reclaimed, and nothing referenced is ever deleted. `doctor` reports the
   runtimes per soul (declared, resolved version, source, health) and the
   cache footprint.
7. **Hosts may bundle uv; GeniusBar would.** uv ships as one static binary
   per platform (order of 15–30 MB per arch), which the host release notes
   must account for. A host without uv that is asked for a Python soul
   gets the decision-5 error, not a silent system-Python fallback.
8. **Trust model: pins and checksums, and only via package revisions.**
   Every byte the daemon fetches — runtime, harness asset, uv-managed
   Python — is pinned with a sha256 the daemon verifies first. New sources
   enter only through a new package revision, which already passes the
   package approval in ADR-0275. As in ADR-0276, a signed catalog stays
   follow-up work; until then, review of the pin *is* the review.

## Consequences

- Souls on `opencode`, `goose`, `muse`, or Python tooling work out of the
  box, subject only to each harness's own sign-in — the same bar ADR-0276
  set for Claude.
- Each soul pins its own runtime versions, so upgrades happen soul by soul
  and two souls may run different Nodes or Pythons.
- Disk growth is bounded by the shared cache (one install per pinned
  version), not per home — unlike ADR-0276's per-home `node_modules`.
- No admin rights, no global installs, no system Python: the daemon writes
  only under the soul homes and its cache.
- Host bundles grow by the uv binary per platform; that size cost is
  explicit in decision 7.
- Proprietary harnesses keep ADR-0276's rule: downloaded on the user's
  machine under their own license, never redistributed inside a host.
- This record decides the schema shape, cache and GC, uv bundling, trust,
  and override surface. Wire formats, provisioner code, and `doctor`
  output follow after owner approval.
