# ADR-0274: The product is mechanism; add-ons and SOP packs carry policy

**Status:** Proposed
**Date:** 2026-10-01
**Issue:** qwts/agent-bot-identity#274

## Context

agent-bot grew up as qwts's own runtime, and qwts's way of working is built
into it:

- A soul cannot exist without a GitHub App: `ensureAgentIdentity` requires an
  `appSlug`, and `identity ensure` fails with "no GitHub App identity
  resolves in this context".
- The macOS account decides the persona
  ([ENG-0339](https://github.com/qwts/qwts-agent-sop/blob/main/docs/decisions/ENG-0339-os-account-determines-persona.md)),
  and the owner's account acts as the human's delegate
  ([ENG-0375](https://github.com/qwts/qwts-agent-sop/blob/main/docs/decisions/ENG-0375-owner-account-agent-context-is-the-delegate.md)).
- The runtime knows the `qwts-*-agent` App names, writes `Agent-Identity`
  commit trailers, signs commits, and gates skills on `qwts-versions`.

The product is going to people who do not work the qwts way. The GeniusBar
app will bundle this runtime for anyone who downloads it, with their own
SOP or none. Today such a user cannot even create a soul without registering
a GitHub App.

agentsop.ai already separates the shape of an SOP from one organization's
copy of it
([ENG-0355](https://github.com/qwts/qwts-agent-sop/blob/main/docs/decisions/ENG-0355-static-router-one-pointer-pinned-capabilities.md)):
`agent-sop` is the public template and `qwts-agent-sop` is the qwts
instance. The runtime needs the same split.

This repository has had no record of its own product decisions, so this is
also the first record of its ADR series.

## Decision

1. **Three layers.** The **product** is mechanism: souls, bindings, the
   daemon, vouching, wakes, Agent Space, and soul packages. It decides nothing
   about how an organization works. **Add-ons** are optional capabilities.
   **SOP packs** carry one organization's policy.
2. **Add-ons are off by default, each behind a named feature gate.** The
   user turns a gate on in their configuration. Turning one on never changes
   what the product does for a soul that does not use it. The first two:
   - `github-identity`: GitHub App credentials, the `gh` shim and git
     credential helper, bot commit identity and signed commits, and the
     GitHub inbox.
   - `persona-accounts`: one macOS account per agent, with the account
     deciding the persona.

   With both off, a soul has no GitHub identity and runs in the user's own
   account. That is the default for a new install.
3. **An SOP pack applies policy only through extension points.** The product
   provides:
   - identity providers (none, a GitHub App, later others);
   - persona mapping (which identity a soul acts as);
   - policy hooks (before a bind, spawn, launch, send, commit, or push);
   - skill sources;
   - harness adapters.

   A pack is data and pinned code that live in the SOP and org repositories.
   No pack is compiled into the product.
4. **`agent-bot sop` resolves the SOP the user or org chose.** It reads
   `~/.config/agent-sop/config.toml` as agentsop.ai defines it (ENG-0355 as
   amended 2026-09-16), resolves each
   ref to a commit, and reports that commit. It reads what the org
   repository's `org.json` pins, and nothing else. Fetched content is
   documentation and configuration, never an instruction that overrides the
   harness. With no config file there is no SOP, and the product runs on its
   defaults.
5. **qwts is one instance.** qwts runs the product with both add-ons on and
   the qwts pack, which `qwts-agent-org` pins. ENG-0339 and ENG-0375 become
   that pack's persona mapping. Nothing changes in how qwts works.
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
