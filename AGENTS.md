# AGENTS.md

Canonical, vendor-neutral agent context for this repository, per
[ENG-0006](https://github.com/qwts/playbook-engineering/blob/main/docs/decisions/ENG-0006-agentic-primitives-governance.md).
Vendor-specific files (Copilot instructions, Cursor rules, and similar) are
thin adapters onto this file — they never restate what is here.

<!-- governed:shared-agent-discovery:start -->

## Shared agent conventions and skills

PR-first workflow, validation-before-push, commit and PR hygiene, and the
untrusted-input threat model are defined once, for every repo, in the
[org-wide agent conventions](https://github.com/qwts/playbook-engineering/blob/main/docs/reference/agent-conventions.md).
Before creating or copying a repo-local skill, consult the
[shared agent skills](https://github.com/qwts/playbook-engineering/blob/main/skills/README.md)
index. Reuse a shared skill when it fits; only a skill genuinely specific
to this repository belongs in its local context.
This repository is governed by
[playbook-engineering](https://github.com/qwts/playbook-engineering) — its
[shared SOPs](https://github.com/qwts/playbook-engineering/blob/main/docs/sop/README.md)
and [engineering decisions](https://github.com/qwts/playbook-engineering/blob/main/docs/decisions/README.md)
apply here by default
([ENG-0008](https://github.com/qwts/playbook-engineering/blob/main/docs/decisions/ENG-0008-shared-sop-inheritance.md):
inherit by default, vary by explicit delta).
<!-- governed:shared-agent-discovery:end -->

## What is specific to this repository

This repository is the sole runtime owner of the agent-bot toolkit (ENG-0016 /
ENG-0045 / ENG-0079 / ENG-0081) and transcript-bound execution identities.
Governance repositories may consume its CLI but must not carry runtime copies.
Zero npm dependencies. Node ≥ 20.

### Validate before push

```bash
npm test
```

Optional live diagnosis (needs App credentials configured on the machine):

```bash
npm run doctor
```

### Layout

| Path | Role |
|------|------|
| `agent-bot.mjs`, `cli/` | Stable executable, parsing, dispatch, and formatting |
| `*.mjs` (repo root) | Runtime operations — setup, mint, resolve, identity, install |
| `hooks/` | Hook implementations dispatched from the stable installed hook path |
| `scripts/ensure-identity.sh` | Harness startup verify/repair |
| `claude-worktree-create` | Claude Code `WorktreeCreate` wrapper |
| `install.mjs` / `install-gh-shim.mjs` | One-time machine install |
| `doctor.mjs` | End-to-end self-diagnosis |
| `tests/` | Node built-in test runner |

### Conventions agents must keep

- Fail closed on mint / credential / pin failures — never fall back to the
  human GitHub login.
- Identity resolution for commits and tokens must share `resolve-agent.mjs`.
- Bot territory is the `.<tool>/worktrees` path segment at any root, plus the
  Claude Code session scratchpad chain
  (`claude-<uid>/<project>/<session-uuid>/scratchpad`); primary checkouts
  stay human.
- Worktree git config keys: `agentBot.app`, `agentBot.agentId`,
  `agentBot.chainedHooksPath` (still read the legacy `qwts.*` names).
- User config at `~/.config/agent-bot/config.json` maps harness → App slug;
  without it the toolkit is inert.
- Do not hard-code a playbook-engineering checkout path. Installed consumers
  call `~/.local/bin/agent-bot`; `AGENT_BOT_HOME` exists only for harness
  startup discovery fallback.
- Legacy `qwts.*`, `QWTS_AGENT_*`, `PLAYBOOK_HOME`, and `playbook-home` values
  are read-only migration aliases through `0.x` and are removed in `1.0`.
