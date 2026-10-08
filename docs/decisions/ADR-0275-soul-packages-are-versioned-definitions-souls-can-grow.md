# ADR-0275: Soul packages are versioned definitions that souls can grow

**Status:** Accepted
**Date:** 2026-10-01
**Issue:** qwts/agent-bot-identity#275
**Review:** [#614](https://github.com/qwts/agent-bot-identity/issues/614)
— definition/life reconciliation, 2026-10-08.
**Accepted:** 2026-10-08, [owner approval](https://github.com/qwts/agent-bot-identity/pull/615#pullrequestreview-5450542193)
of commit `1093b25b2115d49878bace6ac37be65c1683f4a2`. Acceptance covers the
definition/life contract; the linked runtime work remains separately tracked.

## Context

When this proposal was written on 2026-10-01, a soul was a randomly minted
`agent_<uuid>` row and a reference to the transcript it was bound to. Nothing
recorded its instructions, skills, tools, and limits as a portable definition.
A soul could not be shared, installed, or customized that way. Design note #95
counted 162 rows on one workstation whose transcript references were null.
Nothing inside a random ID could recover the link.

#95 proposed deriving identity from content: a stable **genesis** at birth
and a **chain** of what the agent becomes, the way a git commit covers its
tree and its parents. It also noted that hashing a prompt alone lets anyone
holding a candidate prompt confirm a match.

Those paragraphs record the original motivation. Package formats, genesis,
revision journals and proposal policy have since shipped; the evidence below
distinguishes them from remaining environment and learning work.

People want to download a soul, customize it, and let it improve itself.
[ENG-0172](https://github.com/qwts/qwts-agent-sop/blob/main/docs/decisions/ENG-0172-agent-space-is-durable-per-soul-storage.md)
already gives each soul an Agent Space for durable, secret-free state.
[ADR-0274](ADR-0274-product-is-mechanism-add-ons-and-sop-packs-carry-policy.md)
makes souls part of the product, so the package must work with no SOP.

## Decision

1. **A soul package is a portable definition, not a running agent.** It
   holds:
   - a manifest (`soul.json`): format version, name, description, display
     seed, preferred harnesses, and the package revision and its parent;
   - `AGENTS.md`;
   - skills, in the open Agent Skills layout;
   - tool and MCP server configuration;
   - a policy file stating what the soul may change about itself.

   Only the manifest and `AGENTS.md` are required. Unknown files are kept,
   so newer packages survive older tools. Contents use cross-harness
   standards, never one organization's conventions. Here, **definition** means
   the authored content selected by the package inventory, not every byte
   physically beneath a `.soul` root. The same root also contains the soul's
   durable life under [ADR-0583](ADR-0583-the-soul-root-owns-the-environment.md).
   Unknown-content preservation does not authorize executing an extension or
   treating its declarations as granted permissions.
2. **The `.soul` extension and layout are the same everywhere.** On macOS a
   host app declares `.soul` as a document package, so Finder shows it as
   one item. On other platforms it is the same directory, or a zip archive of
   it for transfer.
3. **Every definition change is a new revision.** A revision ID is a hash
   over the included package inventory (computed canonically, like a git tree)
   and its parent revision. Revisions are never rewritten. Undoing a change is
   a new revision that restores the earlier definition contents; it does not
   rewind conversations, workspaces, credentials, or the rest of the life.

   The [package format contract](../soul-package.md) owns the exact inventory
   and hash encoding. Format 2 excludes root `.soul-state/` and `worktrees/`.
   It excludes eligible generated output only when its bytes match the expected build.
   A marker or a generated-looking path alone cannot hide authored changes.
   Format 1 keeps its existing all-entry inventory and hashes; moving to
   format 2 is explicit, not a reinterpretation of past revisions. Environment
   classification informs clients but does not replace package validation.
4. **Users customize, and souls propose.** A user's edit becomes a revision
   directly. A soul can propose a revision of its own package. The package
   policy decides what happens to a proposal:
   - `ask` (the default): the user approves or declines it;
   - `auto`: applied without asking, but only for the paths the policy
     lists;
   - `never`: not accepted.

   A soul can never change its own policy file, or anything that widens its
   tools, without the user's approval. An SOP pack can tighten these rules
   but cannot loosen them. The current accepted definition's policy governs
   the proposal, not the candidate's replacement policy. Missing policy means
   `ask`; an invalid policy refuses the operation. Approval uses the stored
   candidate bytes and rejects a stale base rather than approving later edits.
   New authority-bearing extension formats must have an approval boundary in
   their consumer; merely retaining an unknown file is not that boundary.
5. **A soul's identity comes from its genesis.** Genesis is a hash over three
   things:
   - the package revision the soul started from;
   - its parent soul;
   - a random nonce taken when it is spawned.

   The ID keeps the `agent_<uuid>` shape, with the UUID derived from the
   genesis hash, so every existing consumer still parses it. The nonce keeps
   two identical spawns apart, and stops anyone with a candidate package or
   prompt from confirming a match.
6. **Revisions form the chain, and identity stays fixed.** When a running
   soul moves to a newer revision of its package, its ID does not change.
   Its chain records each revision it has run.
7. **Durable life and definition have separate lifecycles under one root.**
   Memories belong to Agent Space (ENG-0172), and accepted ADR-0583 places that
   space and per-soul history inside the soul. Containment does not make every
   conversation or memory a definition revision. Migration must report legacy
   links as external/linked until the bytes are actually contained.

   Promoting selected learned material into instructions, skills or other
   definition files is an explicit revision under the same proposal policy.
   Preserve its source provenance; adoption must not leave the definition
   depending on a mutable shared-library link. In
   [ADR-0603](ADR-0603-imported-skills-keep-local-snapshots-and-upstream-provenance.md),
   `learn` guides the agent's selection and adaptation, while `dream` guides
   maintenance using available authorized tools. Neither bypasses revision
   approval or implies blanket repo/user installation.

   Embeddings and retrieval indexes may be reconstructible derived material;
   durable notes, source passages, decisions and curated relationships are not
   disposable merely because a retrieval system uses them. Rebuildable outputs
   follow the engine's retention/classification contract, outside the ordinary
   definition inventory unless deliberately adopted as definition. Removing
   stale derived entries does not authorize erasing durable sources or their
   provenance. This record does not prescribe a vector store, graph engine or
   deterministic learning pipeline.
8. **A package grants no authority.** Its tool configuration is a request.
   The user approves it when installing, and again when a revision widens
   it. Authority still comes only from the bound connection.
9. **Existing souls keep their IDs.** Souls minted before this change keep
   their random IDs and are recorded as having no genesis. They can adopt a
   package without changing ID.
10. **Definition distribution and life transfer are different operations.**
    A template or definition-only package excludes accumulated working state.
    A life export/import follows ADR-0583 decision 10: it carries the selected
    durable life, including memory and history, while excluding credentials,
    secrets, sign-ins, installed runtimes and caches. Importing a moved life
    keeps its Agent ID; an explicit fork creates a new identity, and active-ID
    collision handling remains the environment contract's responsibility.
    This does not declare life export/import implemented or invent a second
    archive format. A generic copy or zip of the whole root is not automatically
    a compliant definition distribution or life export.

## Review evidence and issue ownership (2026-10-08)

Evidence at
[`759055e`](https://github.com/qwts/agent-bot-identity/tree/759055ef0b443c5f3988057249c3d65cdcc86c86):

| Contract | Existing evidence | Remaining owner |
| --- | --- | --- |
| Definition inventory and genesis | `soul-package.mjs`, `soul-genesis.mjs` and their tests cover fixed hashes, format compatibility, exact generated-byte exclusions, genesis and stable IDs. | This ADR retains those contracts; runtime/harness provisioning is reviewed separately under ADR-0276/0322 and ADR-0583. |
| Revision and promotion | `soul-revisions.mjs` and its tests cover immutable candidates, stale-base refusal, ask/auto/never, protected paths and explicit Agent Space promotion. | [#312](https://github.com/qwts/agent-bot-identity/issues/312) owns captured dependencies/rechecks; its per-skill manifests and diffs already exist. |
| Progressive learning and derived knowledge | Existing revisions are the adoption mechanism; no mandatory knowledge backend is implied. | Accepted ADR-0603 and [#603](https://github.com/qwts/agent-bot-identity/issues/603) own lifecycle guidance, outcomes and optional retrieval integration, using #312's shared capture contract. |
| Durable environment | `soul-env-contract.mjs`, the descriptor and revision preparation expose classification; format-2 revision tests exclude life state. | [#583](https://github.com/qwts/agent-bot-identity/issues/583) owns remaining containment, migration, cleanup and life export/import. A descriptor is not proof that every migration has shipped. |
| Usable continuity | Retaining history does not prove the next turn received it. | [#596](https://github.com/qwts/agent-bot-identity/issues/596) separately investigates session/context delivery and cross-soul isolation; neither an index rebuild nor storage relocation alone closes it. |

The accepted environment and skill-lifecycle decisions remain unchanged. This
review clarifies their relationship to the definition contract; it does not
implement their remaining slices or declare the observed continuity issue fixed.

## Consequences

- A soul can be downloaded, shared, customized, and improved over time, and
  every step can be undone.
- Installing a package installs code: skills can run scripts and MCP
  servers are programs. Showing what a package or revision adds becomes part
  of install and approval. Signing and a catalog are follow-up work.
- Self-improvement depends on proposals that the user can review. A soul
  that proposes too often is a usability problem the policy file has to
  manage.
- Package inventory, genesis and revision policy have specifications and
  tests. Their evidence does not establish complete containment, life transfer,
  dependency capture or context recovery.
- Two ID kinds coexist through 0.x: derived and legacy.

## Alternatives

- **Hash and distribute the entire living root as the definition:** rejected.
  Definition-only distribution would carry private working state, and ordinary
  turns would alter the definition revision. Physical containment of memory
  inside the soul is required by ADR-0583 and is compatible with excluding it
  from definition revisions.
- **Keep random IDs and add a package reference:** rejected. It repeats the
  fault #95 describes: lose the reference and the link is gone.
- **Derive identity from the package alone, with no nonce:** rejected.
  Unrelated users installing the same package would collide, and a guessed
  prompt could be confirmed.
- **Definitions live in Agent Space:** rejected. Agent Space is one soul's
  storage. A definition is shared by many souls and outlives each of them.
