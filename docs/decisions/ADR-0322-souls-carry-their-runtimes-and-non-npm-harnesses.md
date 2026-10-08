# ADR-0322: Souls carry their runtimes and non-npm harnesses, with user overrides

**Status:** Accepted
**Date:** 2026-10-02
**Issue:** qwts/agent-bot-identity#322
**Review:** [#616](https://github.com/qwts/agent-bot-identity/issues/616)
— joint harness/runtime reconciliation, 2026-10-08.
**Accepted:** 2026-10-08, [owner approval](https://github.com/qwts/agent-bot-identity/pull/622#pullrequestreview-5450714771)
of commit `2ea0ed87bff357cb09eb955b0260c3f1d7894ce5`. Acceptance covers the
reconciled contract; the linked implementation gaps remain separately tracked.

Extends [ADR-0276](ADR-0276-souls-carry-their-harnesses-as-pinned-npm-dependencies.md).
Accepted [ADR-0583](ADR-0583-the-soul-root-owns-the-environment.md) takes precedence
for environment ownership and provisioning. This refresh reconciles the older
proposal with that decision; it does not rewrite ADR-0583 or declare every
original requirement implemented because #322 closed.

## Context

The original proposal filled the gaps left by npm-only harness packaging:
Node/Python versions and non-npm harnesses still depended on the host. It
proposed shared installed-runtime caches, host-bundled uv, an exact-only manifest
and override commands. ADR-0583 subsequently selected per-soul installs, shared
verified download archives, per-soul uv, a bundled pin catalog and Go support.

#597 shipped the core runtime slice and closed #322. Its closeout explicitly
excludes launch-wire overrides, resume routing, uv.lock, npm-install migration
and a live Windows run. Those omissions remain tracked in
[#617](https://github.com/qwts/agent-bot-identity/issues/617) and
[#583](https://github.com/qwts/agent-bot-identity/issues/583).

## Decision

1. **Declarations are reviewed definition content.** `soul.json` may declare
   `runtimes.node|python|go` and per-harness `install` entries. Package readers
   validate these known fields, including unknown keys, version/source shapes
   and integrity metadata; they are not opaque until provision time. Npm
   adapters remain `package.json`/lockfile pins. The detailed maintained schema
   is [soul-runtimes.md](../soul-runtimes.md#declaring), not a second incompatible
   example in this ADR.
2. **Provision inside the soul.** Active runtimes, harness installs and their
   mutable state belong under `.soul-state/runtimes/`, without admin rights or
   global installs. Node includes npm; uv itself is a per-soul managed binary,
   and Python is provisioned through it. Declared Python cannot silently become
   system Python. Tool-home routing follows ADR-0583 and does not change `HOME`.
3. **Source integrity must be explicit.** Managed archive downloads use
   per-platform URLs and SHA-256 verification before publication. Python and
   Python tool installations go through uv; an exact tool version alone is not
   a complete dependency lock or proof of every downloaded byte. The missing
   lock/hash provenance contract is a tracked implementation requirement, not
   an implied guarantee. Required integrity policy must refuse an install or
   launch when its evidence is unavailable; successful tool exit or a stamp
   with no digest cannot be described as daemon checksum verification.
4. **Selection must distinguish overrides from managed pins.** The intended
   order is an explicit owner-authorized override, the soul's declared install,
   then disclosed host-bundled/PATH compatibility for undeclared requirements.
   A declared missing/unsupported/failed requirement must install successfully
   or refuse; it never silently falls through to a host copy. An external
   override must identify the exact selected executable and be reported as
   outside managed-pin verification. It cannot bypass a required policy.
   The current helper accepts overrides, but end-to-end launch-wire and durable
   per-soul override interfaces still need implementation and validation;
   the original illustrative command is not a shipped CLI contract.
5. **Failures are actionable and recoverable.** Name the runtime/harness,
   failure and recovery action. Publish complete usable artifacts, never a
   partially installed executable on the launch path. Preserve previous usable
   versions. Publication is per artifact, not an all-components transaction:
   a later failure may leave earlier successful installs while refusing launch.
   Archive/Python staging and uv-tool incomplete markers have different recovery
   mechanics and must be described and tested honestly.
6. **Share verified download archives, not installed runtimes.** ADR-0583
   decision 6 supersedes this record's original shared-install cache and
   soul-to-cache references. Installs and mutable state are per soul. Cleanup
   must preserve referenced installations and durable life; the original
   mark-and-sweep proposal is not an implemented cleanup contract. Inspection
   reports declared, resolved, installed, missing and unsupported state without
   provisioning; migration/doctor/cleanup completion remains under #583.
7. **uv is provisioned per soul.** ADR-0583 decision 6 supersedes the original
   host-bundled-uv requirement. A host's bundled Node may support undeclared
   compatibility, but a declared runtime or required uv cannot disappear into
   that fallback. Supported platforms and adapter limitations are explicit;
   fixture coverage does not establish a live installation on every platform.
8. **Keep declarations, resolutions and trust separate.** A package revision
   covers its declared versions and explicit sources. A range resolves against
   the engine's bundled catalog; a fresh host with a newer catalog can choose
   a different exact version. Preserve and expose resolved-version/source
   evidence and define owner-visible upgrade behavior before claiming identical
   reproduction across hosts. Catalog pins are reviewed with the engine release;
   package-specific sources are reviewed as definition revisions. Checksums
   establish byte identity, not publisher authenticity, authorization or safety.
   A signed catalog and Python dependency-lock guarantees remain separate work.

## Schema and precedence map

| Earlier proposal | Reconciled contract |
| --- | --- |
| Node/Python only, exact versions, required Node sources | ADR-0583 adds Go and catalog-resolved versions/ranges; exact package-provided sources override the catalog. |
| Provision-time-only validation | Known runtime/install objects are strictly validated by current package readers. |
| `harnesses.<name>.kind = binary` | `harnesses.<name>.install.kind = archive` or `uv-tool`; npm adapters stay lockfile dependencies. |
| `runtimes.python.lock` / uv.lock | Not accepted by the current schema; lock/hash integration remains #617, not a working option. |
| Decisions 6–7: shared installed cache and bundled uv | Superseded by ADR-0583 decision 6: per-soul installs/uv, shared verified archives only. |
| Per-agent/per-soul override commands | Retained as an explicit-authority design goal; helper support is not complete wiring or an available command. |
| One atomic provisioning transaction | Per-artifact publication with launch refusal and recovery; incomplete uv-tool installs use markers. |

## Implementation evidence and remaining work

At runtime evidence commit
[`759055e`](https://github.com/qwts/agent-bot-identity/tree/759055ef0b443c5f3988057249c3d65cdcc86c86),
`soul-runtimes.mjs`, `runtime-catalog.mjs`, package validation and the daemon
implement the core slice. Existing tests cover catalog resolution, archive
checksums, staging failure, previous-version preservation and launch refusal.
The `soul runtimes` inspection/install commands and `soul env` descriptor exist.

Archive stamps record the verified digest. uv-Python and uv-tool stamps instead
have `sha256: null`; uv-tool installation currently uses `package==version`
without a package dependency lock. The override helper currently routes through
PATH directories; exact executable validation and the real launch consumers
need review. The core daemon path passes runtime environment per turn; #322's
closeout leaves resume parity unproved. These distinctions remain in #617.

[#583](https://github.com/qwts/agent-bot-identity/issues/583) retains migration,
cleanup and complete environment ownership; [#378](https://github.com/qwts/agent-bot-identity/issues/378)
and [#379](https://github.com/qwts/agent-bot-identity/issues/379) retain builder
coverage; [#523](https://github.com/qwts/agent-bot-identity/issues/523) retains
signed-in Kiro work; [#536](https://github.com/qwts/agent-bot-identity/issues/536)
retains prerequisite progress. Accepting this record does not close them.

## Consequences

- Each soul owns the executables and mutable environment it runs, at a per-soul
  disk cost. Shared verified archives reduce downloads rather than that ownership.
- Unsupported or unverified paths remain visible. Missing declared requirements
  cause refusal instead of a deceptively successful launch with different tools.
- Version ranges trade flexibility for weaker reproduction across catalog
  releases; an exact resolved version and integrity evidence are separate facts.
- Host installation and sign-in are not inferred from a valid declaration or
  successful rendering. Proprietary harness licensing remains ADR-0276's rule.
