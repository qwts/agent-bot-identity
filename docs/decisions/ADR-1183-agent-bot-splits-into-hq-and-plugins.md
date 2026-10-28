# ADR-1183: agent-bot splits into an HQ daemon and plugins; the identity extraction is retired

**Status:** Accepted (2026-10-27, by the owner, decision D1 on [qwts/agent-bot-daemon#2](https://github.com/qwts/agent-bot-daemon/pull/2), relayed in chat)
**Date:** 2026-10-27
**Issue:** [qwts/agent-bot-identity#1183](https://github.com/qwts/agent-bot-identity/issues/1183)

## Context

[ADR-0645](ADR-0645-one-runtime-repository-four-owned-modules.md) did two
things:

- **It set the module structure.** One runtime repository, logical modules,
  dependency rules, authority and data ownership, harness knowledge, and the
  physical `identity/` layout behind shims.
- **It planned the extraction.** Identity was to become `qwts/agent-identity`,
  and this repository would stay the `agent-bot` facade for soul, harness,
  host and cli. Migration steps 8 to 11 and
  [identity-extraction-plan.md](../identity-extraction-plan.md) described it.

The *Soul Agent Platform* draft 0.4 changed the target. HQ is a trusted local
host service in its own account. It holds grants, approvals, budgets, the task
and action ledgers and brokered inference. Souls and their members run outside
it. The identity service (agents.true-line.ai) only holds credentials and mints
short-lived ones. Relays carry sealed frames, never control.

[qwts/agent-bot-daemon `docs/daemon-plugin-split.md`](https://github.com/qwts/agent-bot-daemon/blob/1780433/docs/daemon-plugin-split.md)
maps the code onto that model. The owner decided it on 2026-10-27:

- **D1:** `agent-bot-daemon` is HQ, and `managed-machine` stays the
  provisioner.
- **D2:** a pilot provider key held only in HQ memory. Under Q1, for the
  pilot it may reach the harness process environment for the soul's
  declared provider only, until the loopback inference proxy (#1190) lands.
- **D3:** soul-runtime's core stays pure, with no server runtime before the
  pilot gates.

## Decision

1. **The runtime becomes four repositories, not two.**
   - **agent-bot-daemon:** HQ, the trusted host. It owns the `agent-bot`
     command and the runtime release.
   - **agent-bot-identity:** the identity plugin. Device enrollment,
     credential references and the link to the identity service.
   - **agent-bot-comms:** agent-comms renamed, in its broker, client and relay
     roles.
   - **agent-bot-soul-runtime:** package, render and admission logic in HQ, plus
     the Soul's entry point.
   - **managed-machine** provisions HQ's account and the member accounts.
   - The agent-bot server is the identity service, for credential custody and
     issuance only.
2. **The extraction of identity into `qwts/agent-identity` is retired.**
   ADR-0645 §1's extraction bullet, §5 "Extracting identity", §6's agent-identity
   pinning, migration steps 8 to 11 and
   [identity-extraction-plan.md](../identity-extraction-plan.md) no longer
   apply. `qwts/agent-identity` is not created.
3. **ADR-0645's structure carries forward unchanged.** It is still the rule
   until the split's own records replace it piece by piece. That covers:
   - the module map in `governance/runtime-modules.json`;
   - the dependency rules and the frozen `may_import` table (§2), including
     "widening is a new record";
   - authority and data ownership (§3);
   - harness knowledge, never authority (§4);
   - the physical `identity/` layout and its shims (migration step 6);
   - the identity public contract ([identity-contract.md](../identity-contract.md),
     step 7).

   Tests and comments that cite ADR-0645 for these keep meaning what they
   say.
4. **Credential custody follows 0.4 from now on.** No long-lived secret on the
   host. Credentials are minted per task and operation by the identity
   service, and members get references (#1184). Earlier records that assume
   keys or authority state readable on the host are superseded wherever they
   say so, and are never edited in place.

## Consequences

- **The plan replaces the extraction plan.** The split happens through the
  plan's ordered, separately mergeable PRs (strangler migration), not through
  a history-preserving move of `identity/`. The current CLI, MCP tools and
  state paths keep working throughout.
- **This repository loses more than identity over time.** HQ code moves to
  agent-bot-daemon and soul code to agent-bot-soul-runtime. That is more
  churn than the extraction would have caused, and it is accepted because it
  matches the trust boundary.
- **ENG-0128's extraction amendment is replaced** by
  [ENG-0111](https://github.com/qwts/qwts-agent-sop/blob/main/docs/decisions/ENG-0111-agent-bot-runtime-hq-daemon-and-plugins.md)
  ([qwts-agent-sop#112](https://github.com/qwts/qwts-agent-sop/pull/112)).
- [qwts-agent-org#32](https://github.com/qwts/qwts-agent-org/issues/32) (an
  org pin for agent-identity) is no longer needed in that form. The four
  repositories get pins when they first release.

## Supersedes

- **ADR-0645**, as a whole, for status purposes. Its structural decisions
  carry forward unchanged under decision 3 above.
