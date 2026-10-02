# Architecture decisions (ADR series)

Durable records for product decisions owned by this repository: what
agent-bot does for anyone who installs it. How one organization runs its
agents is that organization's SOP, not a product decision. For qwts that is
the ENG series in
[qwts-agent-sop](https://github.com/qwts/qwts-agent-sop/blob/main/docs/decisions/README.md),
and an ADR that depends on an ENG record links to it.

## Numbering

`ADR-NNNN`, zero-padded, taken from the originating issue number in this
repository, as the agent-comms series and the ENG records do
([ENG-0035](https://github.com/qwts/qwts-agent-sop/blob/main/docs/decisions/ENG-0035-issue-derived-record-numbers.md)).
Numbers are therefore sparse.

## Format

Short: context, the decision, and consequences, including the ones you did
not like. Each record starts with `**Status:**`, `**Date:**`, and
`**Issue:**` fields. Status is one of `Proposed`, `Accepted`, or
`Superseded by ADR-NNNN`. Records are never rewritten after acceptance;
supersede them instead.

## Index

| ID | Title | Status |
| --- | --- | --- |
| [ADR-0274](ADR-0274-product-is-mechanism-add-ons-and-sop-packs-carry-policy.md) | The product is mechanism; add-ons and SOP packs carry policy | Proposed |
| [ADR-0275](ADR-0275-soul-packages-are-versioned-definitions-souls-can-grow.md) | Soul packages are versioned definitions that souls can grow | Proposed |
| [ADR-0276](ADR-0276-souls-carry-their-harnesses-as-pinned-npm-dependencies.md) | Souls carry their harnesses as pinned npm dependencies | Proposed |
