# ADR-0275: Soul packages are versioned definitions that souls can grow

**Status:** Proposed
**Date:** 2026-10-01
**Issue:** qwts/agent-bot-identity#275

## Context

A soul today is a randomly minted `agent_<uuid>` row and a reference to the
transcript it was bound to. Nothing records what the agent is: its
instructions, skills, tools, and limits. A soul cannot be shared, installed,
or customized, and its ID means nothing on its own. Design note #95 counts
162 rows on one workstation whose transcript references are null. Nothing
inside a random ID can recover the link.

#95 proposed deriving identity from content: a stable **genesis** at birth
and a **chain** of what the agent becomes, the way a git commit covers its
tree and its parents. It also noted that hashing a prompt alone lets anyone
holding a candidate prompt confirm a match.

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
   standards, never one organization's conventions.
2. **The `.soul` extension and layout are the same everywhere.** On macOS a
   host app declares `.soul` as a document package, so Finder shows it as
   one item. On other platforms it is the same directory, or a zip archive of
   it for transfer.
3. **Every change is a new revision.** A revision ID is a hash over the
   package's contents (computed canonically, like a git tree) and its parent
   revision. Revisions are never rewritten. Undoing a change is a new
   revision that restores the earlier contents.
4. **Users customize, and souls propose.** A user's edit becomes a revision
   directly. A soul can propose a revision of its own package. The package
   policy decides what happens to a proposal:
   - `ask` (the default): the user approves or declines it;
   - `auto`: applied without asking, but only for the paths the policy
     lists;
   - `never`: not accepted.

   A soul can never change its own policy file, or anything that widens its
   tools, without the user's approval. An SOP pack can tighten these rules
   but cannot loosen them.
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
7. **Memory stays in Agent Space.** What a soul accumulates while working
   lives in its Agent Space (ENG-0172). Moving something learned into the
   package is an explicit revision, proposed and approved like any other.
8. **A package grants no authority.** Its tool configuration is a request.
   The user approves it when installing, and again when a revision widens
   it. Authority still comes only from the bound connection.
9. **Existing souls keep their IDs.** Souls minted before this change keep
   their random IDs and are recorded as having no genesis. They can adopt a
   package without changing ID.

## Consequences

- A soul can be downloaded, shared, customized, and improved over time, and
  every step can be undone.
- Installing a package installs code: skills can run scripts and MCP
  servers are programs. Showing what a package or revision adds becomes part
  of install and approval. Signing and a catalog are follow-up work.
- Self-improvement depends on proposals that the user can review. A soul
  that proposes too often is a usability problem the policy file has to
  manage.
- The manifest, canonical hashing, and the proposal flow each need a format
  specification and tests before any code relies on them.
- Two ID kinds coexist through 0.x: derived and legacy.

## Alternatives

- **The package is the running soul, with memory inside it:** rejected. A
  shareable definition would carry one user's private state, and every turn
  would rewrite a file meant to be signed and versioned.
- **Keep random IDs and add a package reference:** rejected. It repeats the
  fault #95 describes: lose the reference and the link is gone.
- **Derive identity from the package alone, with no nonce:** rejected.
  Unrelated users installing the same package would collide, and a guessed
  prompt could be confirmed.
- **Definitions live in Agent Space:** rejected. Agent Space is one soul's
  storage. A definition is shared by many souls and outlives each of them.
