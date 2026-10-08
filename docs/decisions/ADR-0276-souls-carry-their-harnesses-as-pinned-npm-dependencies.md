# ADR-0276: Souls carry their harnesses as pinned npm dependencies

**Status:** Accepted
**Date:** 2026-10-01
**Issue:** qwts/agent-bot-identity#307
**Review:** [#616](https://github.com/qwts/agent-bot-identity/issues/616)
— joint harness/runtime reconciliation, 2026-10-08.
**Accepted:** 2026-10-08, [owner approval](https://github.com/qwts/agent-bot-identity/pull/622#pullrequestreview-5450714771)
of commit `2ea0ed87bff357cb09eb955b0260c3f1d7894ce5`. Acceptance covers the
reconciled contract; the linked implementation gaps remain separately tracked.

## Context

The original proposal addressed fresh hosts that lacked npm harness adapters
and depended on host PATH or `npx`. A soul already declared its preferred
harnesses, but could not reliably bring the adapter versions it needed.

Pinned npm harness installation now exists. Accepted
[ADR-0583](ADR-0583-the-soul-root-owns-the-environment.md) subsequently made the
soul root own its environment, including active installs and per-harness tool
state. This review retains npm packaging and selection here, while
[ADR-0322](ADR-0322-souls-carry-their-runtimes-and-non-npm-harnesses.md) owns
runtimes and non-npm installs. The historical ADR ID and originating issue
#307 are retained; they are not renumbered during reconciliation.

## Decision

1. **Npm harness dependencies are part of the definition.** A package may
   include `package.json` and `package-lock.json`; changing either is a
   definition revision under
   [ADR-0275](ADR-0275-soul-packages-are-versioned-definitions-souls-can-grow.md).
   A package without `package.json` requests no npm install. A manifest without
   the required lockfile refuses provisioning; it does not resolve fresh pins
   implicitly. Non-npm installations use ADR-0322's manifest contract.
2. **`preferredHarnesses` orders the soul's defaults.** A per-agent harness
   selection takes precedence over the default. Selection does not enable an
   unsupported or disabled adapter, satisfy sign-in, or grant credentials.
3. **Provision pinned npm dependencies inside the soul.** Retain
   `npm ci --ignore-scripts --omit=dev`, no global install, and no opportunistic
   `npx` replacement for a declared installation that failed. The target
   environment follows ADR-0583: declared Node/npm come from the soul's
   provisioned environment rather than requiring a host package manager.
   Existing host npm injection and legacy npm install locations are migration
   concerns, not proof of a completely self-contained path. Provisioning errors
   refuse launch with the cause and preserve a recoverable previous state;
   package-spawn cleanup follows the existing launch lifecycle.
4. **Resolve the selected harness explicitly.** Use the soul's pinned install
   for a declared harness requirement. An absent, unsupported or failed declared
   install must not silently become a different registry/PATH/`npx` version.
   When no such requirement is declared, existing supported registry/host
   behavior can remain a disclosed compatibility path. Runtime overrides and
   their verification limits belong to ADR-0322; they cannot silently bypass
   required policy. Builder output, adapter support, provisioning and sign-in
   remain separately observable states.
5. **Installing a harness grants no authority.** Harness-specific sign-in and
   provider authorization remain necessary. ADR-0583 decision 5 supersedes the
   original shared native-login-store decision: use per-soul tool homes where
   the harness supports routing, with explicit owner-authorized sign-in
   adoption. Unsupported/shared-host paths must be reported rather than called
   contained. Do not rewrite `HOME` or copy secrets into a definition package.

## Precedence and implementation evidence

| Original choice | Current disposition |
| --- | --- |
| Decisions 1–2: npm lockfile pins and preferred harnesses | Retained, alongside current package validation and adapter capability checks. |
| Decision 3: install in a private home using host Node/npm | Installation command and lockfile requirement retained; environment ownership follows ADR-0583 decisions 1 and 6. Host npm dependence and legacy paths need explicit migration evidence. |
| Decision 4: registry fallback after a missing local binary | Retained only for an undeclared compatibility path; failed declared requirements cannot silently change versions. |
| Decision 5: native shared login stores | Superseded by ADR-0583 decision 5; implementation limitations remain reported. |

At runtime evidence commit
[`759055e`](https://github.com/qwts/agent-bot-identity/tree/759055ef0b443c5f3988057249c3d65cdcc86c86),
`soul-home.mjs` implements lockfile-based adapter extraction/installation and
`soul-runtimes.mjs` provisions per-soul Node including npm. This does not prove
that every install/launch path uses that npm: `npmCommand` still accepts host
injection or PATH. Npm installs now land under
`.soul-state/runtimes/harnesses/<harness>/<version>` with an install stamp, and
#583 slice 8's `soul env migrate --harnesses-into-runtimes` moves a legacy
`.soul-state/harnesses` install there (the descriptor's pending
`harnesses-into-runtimes` step runs).

[#617](https://github.com/qwts/agent-bot-identity/issues/617) tracks runtime,
override, integrity and launch-path conformance; [#583](https://github.com/qwts/agent-bot-identity/issues/583)
owns environment migration. [#378](https://github.com/qwts/agent-bot-identity/issues/378)
and [#379](https://github.com/qwts/agent-bot-identity/issues/379) own remaining
builder primitives/settings. [#523](https://github.com/qwts/agent-bot-identity/issues/523)
retains signed-in Kiro validation; [#536](https://github.com/qwts/agent-bot-identity/issues/536)
retains prerequisite reporting. None is completed merely by accepting this ADR.

## Consequences

- Souls can select different pinned harness versions; each active install uses
  per-soul disk. Shared verified downloads do not imply shared mutable installs.
- A fresh-host experience still depends on supported provisioning, adapter
  availability and sign-in; a rendered configuration file alone proves none.
- Installing executable code remains subject to definition review and runtime
  authorization. Skipping lifecycle scripts is a safeguard, not a signature or
  proof that an npm dependency is safe. A signed catalog remains separate work.
- Proprietary harnesses are obtained on the user's machine under their license,
  not redistributed inside a host without authorization.
