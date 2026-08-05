---
name: agent-bot
description: Configure and operate per-harness GitHub App identities and authorized secure-store reads for coding agents. Use when setting up or diagnosing agent-bot, minting bot credentials, retrieving a password or API key, checking identity attribution, publishing local commits as GitHub-verified bot commits, or working with transcript-bound Agent IDs. Do not use to turn a primary human checkout into bot territory, broaden password-manager access, or fall back to human credentials.
---

# Agent Bot

Use the installed `agent-bot` CLI as the only runtime entrypoint. Keep the
worktree's commit identity, token identity, PR author, and execution identity
aligned. Fail closed when an App cannot be resolved or a credential cannot be
minted; never continue with an ambient human GitHub login.

## Route the request

- Read [operations.md](references/operations.md) for installation, worktree
  setup, token minting, password/API-key retrieval, diagnostics, or
  identity-repair requests.
- Read [verified-publish.md](references/verified-publish.md) before publishing
  commits that must show GitHub's **Verified** badge.
- Read [execution-identities.md](references/execution-identities.md) for Agent
  ID creation, binding, recording, lookup, or transcript provenance.

Load only the reference needed for the current request. Load all three when
diagnosing a cross-cutting mismatch among commit attribution, credentials,
verified publishing, and transcript provenance.

## Preserve the invariants

1. Treat only `.<tool>/worktrees/**` paths and recognized Claude scratchpads
   as bot territory. Leave primary checkouts human.
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

## Verify the outcome

Check the relevant local identity state before mutating GitHub. After a write,
confirm the remote author or verification state and report any recovery command
printed by the CLI. Never expose tokens, JWTs, App keys, passwords, API keys, or
private identity records in logs or responses.
