---
name: agent-bot
description: Bootstrap, configure, and operate per-harness GitHub App identities and authorized secure-store reads for coding agents. Use for fresh-clone requests such as "install agent bot identities," source or installed agent-bot setup and diagnosis, bot credential minting, password or API-key retrieval, identity attribution, GitHub-verified bot commits, transcript-bound Agent IDs, Agent Spaces, and the workstation-local soul population. Do not use to bind a human's own checkout to a bot on harness detection alone, broaden password-manager access, or fall back to human credentials.
metadata:
  qwts-contract: "1"
  qwts-cli: "agent-bot"
  qwts-versions: ">=0.10.0 <0.11.0"
  qwts-validated: "0.10.2"
  qwts-side-effects: "remote-write"
---

# Agent Bot

Choose the runtime entrypoint before acting. In an `agent-bot-identity` source
checkout, use `./agent-bot bootstrap` when the stable CLI is absent. After the
machine install succeeds, use the installed `agent-bot` CLI. Keep the
worktree's commit identity, token identity, PR author, and execution identity
aligned. Fail closed when an App cannot be resolved or a credential cannot be
minted; never continue with an ambient human GitHub login.

## Route the request

- Read [operations.md](references/operations.md) for fresh-machine bootstrap,
  installation, worktree setup, token minting, password/API-key retrieval,
  diagnostics, or identity-repair requests.
- Read [verified-publish.md](references/verified-publish.md) before publishing.
  Bot-authored commits on a qwts repository are signed. `agent-bot signed-commit` is how.
- Read [execution-identities.md](references/execution-identities.md) for Agent
  ID creation, binding, recording, lookup, transcript provenance, or Agent
  Space resolution.
- Read [storage-surfaces.md](references/storage-surfaces.md) when deciding
  where a file belongs among worktree, scratchpad, and Agent Space.

Load only the reference needed for the current request. Load all three when
diagnosing a cross-cutting mismatch among commit attribution, credentials,
verified publishing, and transcript provenance.

## Choose the storage surface

<!-- conformance: keep this three-surface distinction and its ENG-0172-backed
     reference intact in every skill edit. tests/skill.test.mjs enforces it. -->

Worktree files are Git work that ships in commits and PRs. Scratchpad files
are session-ephemeral and die with the context. Agent Space is the durable
per-soul store for belongings that must outlive both; resolve it only through
`agent-bot space ensure` and `agent-bot space path`, never a raw filesystem
path. Details and the governing contract link live in
[storage-surfaces.md](references/storage-surfaces.md).

## Preserve the invariants

1. The account, not the directory, is bot territory (ENG-0339): a rostered
   agent account owns every checkout in it; in the owner's account act as the
   human's delegate unless `--app`, `GH_AGENT_APP`, or a pin states a bot.
   Never treat a `.<tool>/worktrees/**` path as an identity signal.
2. Resolve one App through the shared runtime; do not reproduce resolution in
   shell snippets or skill-local scripts.
3. Stop on mint, credential, identity-pin, lease, verification, or tree-match
   failures. Never retry as the human account.
4. Use HTTPS for bot GitHub operations. SSH commonly bypasses the App identity.
5. Keep executable behavior in the repository runtime and keep this skill as
   workflow guidance. Do not create a second copy of runtime logic here.
6. Secret retrieval uses one explicitly selected provider and an existing
   authorized session, plus a concrete audit reason. Never search another
   provider, automate provider login, or persist the result.
7. Treat an organization-wide install request as governance discovery plus
   runtime bootstrap. Prefer the versioned `--profile` contract, require the
   complete active identity roster and organization-owned harness tooling, and
   never reduce it to the current harness or reactivate a retired identity.
8. GitHub identity is an add-on: `signed-commit`, `Agent-Identity` trailers
   and the `gh` shim run only with `features.github-identity: true` in the
   user config (`doctor` shows each gate). Off is not an error to work around.

## Know the side effects before retrying

Run `agent-bot --version` before following a workflow here. If it is outside
`qwts-versions`, treat this skill as a hint. Take a command's behavior from
that version's `--help`, and do not mutate anything that help cannot vouch
for. `agent-bot skill path` prints the installed release's copy of this skill.

| Class | Commands | Retry |
|---|---|---|
| read-only | `--help`, `doctor`, `sop`, `skill path`, `population list`, `space path`, `signed-commit --dry-run`, `secret get` | Safe to repeat. |
| local-write | `bootstrap`, `setup-worktree`, `install`, `install-gh-shim`, `daemon install`, `daemon disable`, `ensure-private-key`, `space ensure` | Converge on rerun; confirm with `doctor`. |
| remote-write | `mint-token` | Each run mints a new short-lived token; repeating is safe. |
| remote-write | `signed-commit` | Never blindly rerun. Follow the printed recovery in [verified-publish.md](references/verified-publish.md), and inspect the remote branch head before any second attempt. |

## Verify the outcome

Check the relevant local identity state before mutating GitHub. After a write,
confirm the remote author or verification state and report any recovery command
printed by the CLI. Never expose tokens, JWTs, App keys, passwords, API keys, or
private identity records in logs or responses.
