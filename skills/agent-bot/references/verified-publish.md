# Verified publishing

Use `agent-bot signed-commit` when the local bot-authored commits must show
GitHub's **Verified** badge. The command replays each commit through GitHub's
Git Data API, verifies the returned signature and tree, then updates the remote
branch under a force-with-lease equivalent.

## Preconditions

1. Work only in bot territory with a resolvable App identity.
2. Commit all intended changes and run the repository's required validation.
3. Keep the range linear. Rebase away merge commits.
4. Fetch the branch before beginning if another writer may have updated it.
5. Confirm the worktree is clean.

## Preview and publish

Preview locally without minting credentials or contacting GitHub:

```bash
agent-bot signed-commit --dry-run
```

Publish the current branch:

```bash
agent-bot signed-commit
```

Use overrides only when repository discovery is insufficient:

```bash
agent-bot signed-commit --base <ref> --branch <name> --repo <owner/name>
```

The default branch is protected. Do not pass `--allow-default-branch` unless
the user explicitly requests a default-branch rewrite and repository policy
allows it.

## Understand the safety checks

The command must stop when:

- the worktree is dirty;
- the range is empty or contains a merge commit;
- a submodule update appears in the range;
- the App identity or token cannot be resolved;
- the remote branch differs from the fetched remote-tracking ref;
- the remote moves while replay is in progress;
- GitHub returns an unsigned commit;
- a signed commit's tree differs from the tested local tree.

The remote update is necessarily forced because replayed commits have new
object IDs. The lease prevents overwriting a remote head this checkout did not
observe. Never replace this check with a blind forced push.

## Recover

If the lease fails, run the recovery command printed by the CLI, revalidate the
new range, and start again. If the remote update succeeds but the local reset
fails, follow the printed fetch/reset recovery; do not republish the branch.

After success, verify the PR or commit page shows the App author and GitHub's
Verified status before reporting completion.
