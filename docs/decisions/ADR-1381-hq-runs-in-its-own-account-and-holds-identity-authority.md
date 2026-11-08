# ADR-1381: HQ runs in its own account and holds identity authority; this repository's plugin is member surfaces only

**Status:** Accepted (applies agent-bot-daemon D6, decided by the owner on 2026-11-07, and platform [PDR-0027](https://github.com/true-line/agent-bot-platform/blob/main/docs/04-decisions/PDR-0027-hq-identity-authority-lives-in-agent-bot-daemon.md), accepted by the owner on 2026-11-08)
**Date:** 2026-11-08
**Issue:** [qwts/agent-bot-identity#1381](https://github.com/qwts/agent-bot-identity/issues/1381)

Supersedes [ADR-0332](ADR-0332-souls-are-the-agents-territory.md) decision 2
and the agent-bot-identity bullet of
[ADR-1183](ADR-1183-agent-bot-splits-into-hq-and-plugins.md) decision 1. The
rest of both records stands.

## Context

The Soul Agent Platform ([true-line/agent-bot-platform](https://github.com/true-line/agent-bot-platform),
read at `main`) is the source of truth for repository charters, the trust
model and cross-repository decisions. Two records here predate it:

- **ADR-0332 decision 2** runs one broker and one daemon per OS user, as
  user LaunchAgents or `systemd --user` units in the Souls' own account, and
  puts a machine-wide service out of scope.
- **ADR-1183 decision 1** makes this repository "the identity plugin":
  device enrollment, credential references and the link to the identity
  service.

The platform has since decided both questions:

- **agent-bot-daemon D6** ([plan §10.1](https://github.com/true-line/agent-bot-daemon/blob/main/docs/daemon-plugin-split.md#101-decisions)): HQ, the
  agent-bot-daemon repository, runs in its own OS account, `_agent-bot-hq`
  on macOS and `agent-bot-hq` on Linux. agent-bot-machine creates it,
  separate from its admin sandbox and from the members (D7 gives each member
  its own account). Platform DRIFT-003 asks for this record.
- **PDR-0027:** all HQ identity authority is part of HQ core in
  agent-bot-daemon: enrollment, the identity-service link, the device key
  and signer, credential references, grants and approvals. agent-bot-identity
  is inside the Soul and untrusted for authority
  ([repository catalog](https://github.com/true-line/agent-bot-platform/blob/main/docs/03-architecture/repository-catalog.md)).

## Decision

1. **HQ runs in its own account, not the Souls' account.** On a managed
   host, the daemon (HQ) runs in `_agent-bot-hq` (macOS) or `agent-bot-hq`
   (Linux), created by agent-bot-machine. Members and the owner's daily
   account cannot read its state or keys. This replaces ADR-0332 decision 2.
   The per-user broker and daemon that ship today stay until HQ's account
   exists. That is agent-bot-daemon D4's stated residual risk: while members
   share the owner's account, any process there can use the daemon's
   machine-client key for routine operations.
2. **This repository holds no HQ identity authority.** Enrollment, the
   identity-service link, the device key and signer, credential references,
   grants and approvals move to HQ core in agent-bot-daemon (its plan §9
   PR 25). This repository's `hq-plugin-contract` plugin registers member
   surfaces only (MCP tools, CLI commands, hook handlers), and each one
   resolves to a broker query. This replaces the agent-bot-identity bullet of
   ADR-1183 decision 1.
3. **Everything else carries forward.** ADR-0332's install paths, soul
   directory, SOP and template decisions, and ADR-1183's other decisions,
   are unchanged.

## Consequences

- The README and code comments that cite ADR-0332 decision 2 describe what
  ships today. They change when the code moves to HQ's account.
- The HQ half of today's identity module leaves this repository, as the
  agent-bot-daemon plan already says. The identity contract
  ([identity-contract.md](../identity-contract.md)) shrinks to member
  surfaces.
- A machine-wide HQ needs a privileged coordinator to create its account.
  agent-bot-machine is that coordinator, so ADR-0332's out-of-scope note on
  machine-wide services no longer applies to HQ.

## Alternatives

- **Keep the daemon in the Souls' account.** Rejected by D6: any member
  process could act as HQ.
- **Keep an authority-bearing identity plugin here.** Rejected by PDR-0027:
  one repository would span two trust domains.
