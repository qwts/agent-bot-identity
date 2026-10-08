# ADR-0274: The product is mechanism; add-ons and SOP packs carry policy

**Status:** Proposed
**Date:** 2026-10-01
**Issue:** qwts/agent-bot-identity#274
**Review:** [#609](https://github.com/qwts/agent-bot-identity/issues/609)
— product-policy reconciliation, 2026-10-08; refreshed text pending owner acceptance.

## Context

agent-bot grew up as qwts's own runtime. When this proposal was written on
2026-10-01, qwts's way of working was built into it:

- A soul cannot exist without a GitHub App: `ensureAgentIdentity` requires an
  `appSlug`, and `identity ensure` fails with "no GitHub App identity
  resolves in this context".
- The macOS account decides the persona
  ([ENG-0339](https://github.com/qwts/qwts-agent-sop/blob/main/docs/decisions/ENG-0339-os-account-determines-persona.md)),
  and the owner's account acts as the human's delegate
  ([ENG-0375](https://github.com/qwts/qwts-agent-sop/blob/main/docs/decisions/ENG-0375-owner-account-agent-context-is-the-delegate.md)).
- The runtime knows the `qwts-*-agent` App names, writes `Agent-Identity`
  commit trailers, signs commits, and gates skills on `qwts-versions`.

These are the original motivations, not a current implementation inventory.
The review evidence below records mechanisms that have since shipped.

The product is going to people who do not work the qwts way. The GeniusBar
app will bundle this runtime for anyone who downloads it, with their own
SOP or none. At that point such a user could not even create a soul without
registering a GitHub App.

agentsop.ai already separates the shape of an SOP from one organization's
copy of it
([ENG-0355](https://github.com/qwts/qwts-agent-sop/blob/main/docs/decisions/ENG-0355-static-router-one-pointer-pinned-capabilities.md)):
`agent-sop` is the public template and `qwts-agent-sop` is the qwts
instance. The runtime needs the same split.

This repository has had no record of its own product decisions, so this is
also the first record of its ADR series.

## Decision

1. **Three layers.** The **product** is mechanism: souls, bindings, the
   daemon, vouching, wakes, Agent Space, and soul packages. It defines the
   platform's behavior and authority boundaries, without choosing an
   organization's roster, account mapping, or working procedures.
   **Add-ons** are optional capabilities.
   **SOP packs** carry one organization's policy.

   Authorization, owner consent, connection-bound identity, and fail-closed
   credential handling remain product responsibilities. A pack cannot grant
   itself authority, bypass those checks, or turn a refused bot operation into
   a human-login fallback. Detailed credential protocols belong in their own
   decisions; this record does not specify them.
2. **Add-ons are off by default, each behind a named feature gate.** The
   user turns a gate on in their configuration. Turning one on never changes
   what the product does for a soul that does not use it. The first two:
   - `github-identity`: GitHub App credentials, the `gh` shim and git
     credential helper, bot commit identity and signed commits, and the
     GitHub inbox.
   - `persona-accounts`: one macOS account per agent, with the account
     deciding the persona.

   With both off, a soul has no GitHub identity and runs in the user's own
   account. That is the default for a new install. Selecting an SOP or opening
   a soul does not itself enable an add-on. A pack may select policy for an
   enabled capability; it cannot silently opt the user into that capability.
   If the selected policy requires a capability that is disabled, the affected
   launch is refused with an owner-action diagnostic; the runtime neither
   enables the capability nor silently ignores the requirement.
3. **An SOP pack applies policy only through extension points.** The product
   provides:
   - identity providers (none, a GitHub App, later others);
   - persona mapping (which identity a soul acts as);
   - policy hooks (before a bind, spawn, launch, send, commit, or push);
   - skill sources;
   - harness adapters.

   A pack is data and pinned code that live in the SOP and org repositories.
   No pack is compiled into the product. These are explicit supported
   interfaces, not permission to execute arbitrary fetched instructions or a
   claim that every extension point already has a complete implementation.
4. **`agent-bot sop` resolves the SOP the user or org chose.** It reads
   `~/.config/agent-sop/config.toml` as agentsop.ai defines it (ENG-0355 as
   amended 2026-09-16), resolves each
   ref to a commit, and reports that commit. It reads what the org
   repository's `org.json` pins, and nothing else. Fetched content is
   documentation and configuration, never an instruction that overrides the
   harness. With no config file there is no SOP, and the product runs on its
   defaults. A configured SOP that cannot be resolved or validated must be
   reported distinctly from an intentional no-SOP configuration. Configured
   persona policy fails closed: an unrecorded, unreadable, invalid, or stale
   policy blocks the affected launch before execution. A user setting or soul
   override cannot substitute for policy that could not be evaluated.

   No selected SOP, a verified selected revision with no persona policy, or a
   valid policy with no applicable rule/default may use the explicit user
   settings. A missing local record is not evidence that the selected revision
   has no policy. A valid cached record for the selected immutable revision
   permits offline evaluation; network failure does not invalidate otherwise
   sufficient local evidence. A record for another selection/revision, or one
   failing the defined validation/freshness checks, cannot be used as a
   last-known fallback. Recovery identifies the policy and reason and asks the
   owner to refresh/repair it or explicitly change the policy selection through
   an authorized path; a launch failure does not remove the requirement.
5. **qwts is one instance.** qwts runs the product with both add-ons on and
   the qwts pack, which `qwts-agent-org` pins. ENG-0339 and ENG-0375 become
   that pack's persona mapping. Preserving qwts's intended behavior is a
   conformance requirement, not evidence that every migration is complete.
6. **Two tests gate the work.**
   - **Zero SOP:** with no SOP and no add-ons, a fresh install binds a soul,
     chats, and wakes.
   - **qwts as a pack:** qwts's behaviour is reachable through the pack
     alone. A qwts rule that needs product code is a missing extension
     point. The fix is to add the extension point, not to special-case qwts.
7. **Existing internal names stay through 0.x.** `QWTS_*` environment
   variables and `qwts.*` git keys keep working as compatibility names. Any
   name a user sees, such as a service label or a stored-credential name, is
   set by the host app that bundles the runtime. agent-comms records that
   embedding contract.

## Review evidence and boundaries (2026-10-08)

This review keeps ADR-0274 separate from the soul definition/revision contract
in [ADR-0275](ADR-0275-soul-packages-are-versioned-definitions-souls-can-grow.md),
the accepted environment contract in
[ADR-0583](ADR-0583-the-soul-root-owns-the-environment.md), and the accepted
skill lifecycle in
[ADR-0603](ADR-0603-imported-skills-keep-local-snapshots-and-upstream-provenance.md).
Those records use this product-policy boundary; they do not replace it.
The [keyd protocol review (#594)](https://github.com/qwts/agent-bot-identity/issues/594)
owns the separate grant, presence, and trust-bootstrap questions.

Evidence at commit
[`759055e`](https://github.com/qwts/agent-bot-identity/tree/759055ef0b443c5f3988057249c3d65cdcc86c86):

| Area | Existing evidence | Remaining review or issue boundary |
| --- | --- | --- |
| Optional capabilities | `config.mjs` and `tests/feature-gates.test.mjs`: named, config-only gates default off; invalid settings are refused. | These tests establish the gate contract, not full zero-SOP bind/chat/wake conformance. |
| SOP selection and provenance | `sop.mjs`, `tests/sop.test.mjs`, and `tests/sop-soul.test.mjs`: selected refs resolve to commits; document reads are bounded; foreign soul selections require trust. | General policy hooks, identity providers, and harness/skill extension coverage still need a requirement-to-evidence inventory before claiming the entire pack contract complete. |
| Persona mapping and launch | `sandbox.mjs`, `daemon-launch.mjs`, and their tests: recorded `persona.toml` mapping, account readiness, and refusal to run a sandboxed soul from the wrong account. | [#376](https://github.com/qwts/agent-bot-identity/issues/376) retains in-account sign-in verification and account lifecycle/host handoff questions; mapping and launch checks are implemented. |
| Account recovery | [#190](https://github.com/qwts/agent-bot-identity/issues/190) tracks account-level diagnosis and repair after managed state is lost. | This is separate from initial account provisioning. No live destructive account-recovery exercise is claimed by this review. |

**Owner direction, 2026-10-08:** prefer security when configured persona policy
cannot be evaluated. Decision 4 therefore replaces the earlier review draft's
fallback recommendation with fail-closed launch behavior.

The implementation at the evidence commit still falls back to user settings
for an unrecorded, unreadable, stale, or invalid mapping, and ignores a pack's
sandbox requirement when the add-on is off. These are implementation gaps
against the revised decision, not behavior approved by this record. A valid
matching pack rule already takes precedence over the soul override and global
setting when the gate is on; once a soul resolves as sandboxed, an unready or
wrong account already refuses launch. See the current
[sandbox behavior](../sandbox.md) and its existing tests.
[#613](https://github.com/qwts/agent-bot-identity/issues/613) tracks the resolver,
every launch consumer, diagnostics, documentation and test changes needed to
enforce the new decision together; this ADR edit changes no runtime behavior.

[#611](https://github.com/qwts/agent-bot-identity/issues/611) tracks the full
decision 6 conformance inventory and missing journey evidence, separately from
this documentation review. Passing the individual tests above is not proof
that every zero-SOP journey or every qwts rule is covered.
The original issue and PR closures, shipped mechanisms, and this reconciliation
do not by themselves accept the refreshed decision. Record explicit owner
acceptance separately; keep runtime issues open until their own remaining
criteria are met.

## Consequences

- Anyone can use souls, bindings, chat, and wakes without GitHub, a
  persona account, or qwts's rules.
- Moving each qwts rule behind an extension point is real work. It touches
  identity resolution, the shim, hooks, commit signing, and the skill gate.
  Until a rule moves, it applies only with `github-identity` on.
- A new install has no bot attribution. Commits from a soul are the user's
  until they turn on `github-identity`.
- Two configurations must stay tested: the zero-SOP default and qwts as a
  pack. CI needs both, and gate combinations multiply the cases.
- A broken configured persona policy can prevent a launch until repaired.
  Diagnostic and recovery operations remain available. This availability cost
  is intentional: inability to evaluate a restriction does not remove it.
- A pack's hooks run with the user's privileges. Choosing an SOP repository
  is a trust decision. The product pins packs by commit and shows which
  commit is in effect, but it cannot make an untrusted pack safe.

## Alternatives

- **Keep qwts built in and add a "lite" mode:** rejected. Every rule would
  need a lite variant, and qwts's choices would remain the product's
  defaults.
- **A fork per organization:** rejected. Fixes would not flow between forks.
- **Record product decisions in the qwts ENG series:** rejected. They would
  read as qwts governance, and a GeniusBar user's SOP has no reason to
  inherit them.
