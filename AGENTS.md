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
Before creating or copying a repo-local skill, consult the reviewed
[shared agent skills](https://github.com/qwts/playbook-engineering/blob/74e775ef23d8e7d8f8e693ccc2329f430978c096/skills/README.md)
index. Reuse only the pinned version supplied by the governed harness; a skill
genuinely specific to this repository belongs in its local context.
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
ENG-0045 / ENG-0079 / ENG-0081), transcript-bound execution identities, and
Agent Space mechanics. The canonical Agent Space contract lives in
[ENG-0172](https://github.com/qwts/playbook-engineering/blob/main/docs/decisions/ENG-0172-agent-space-is-durable-per-soul-storage.md).
Governance repositories may consume the CLI but must not carry runtime copies.
Zero npm dependencies. Node ≥ 20.

### Validate before push

```bash
npm test
```

Optional live diagnosis (needs App credentials configured on the machine):

```bash
npm run doctor
```

### Cold-start intent

When the owner says **“install agent bot identities,”** treat it as an
organization-wide bootstrap request, not as permission to configure only the
current harness:

1. From this source checkout, use `./agent-bot bootstrap` when the stable CLI
   is absent. After installation, use `agent-bot` as the stable entrypoint.
2. Obtain the explicit secret-free organization configuration/profile and the
   shared-tooling procedure from the governance owner's
   [agent bot organization operations](https://github.com/qwts/playbook-engineering/blob/main/docs/reference/agent-bot-operations.md).
   Never assume or search for a local Playbook checkout, and never synthesize a
   roster from the currently running harness.
3. A primary checkout may run only machine preparation with `--machine-only`.
   Bind identity later from a linked agent worktree; never claim the primary
   checkout as bot territory.
4. Reconcile and live-verify the complete configured App roster, install the
   requested fail-closed runtime tooling, then complete the organization-owned
   harness skills/tooling from the governance procedure. Missing compatible
   governance input is a blocking dependency, not permission to perform a
   partial current-harness install.
5. Finish with structured readiness verification. Never fall back to a human
   GitHub login, and do not report success until every configured identity and
   requested harness tool is ready.

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
- User config at `~/.config/agent-bot/config.json` maps harness → App slug and
  carries secret-free runtime settings; without App mapping the toolkit stays
  inert.
- Do not hard-code a playbook-engineering checkout path. Installed consumers
  call `~/.local/bin/agent-bot`; `AGENT_BOT_HOME` exists only for harness
  startup discovery fallback.
- Legacy `qwts.*`, `QWTS_AGENT_*`, `PLAYBOOK_HOME`, and `playbook-home` values
  are read-only migration aliases through `0.x` and are removed in `1.0`.
