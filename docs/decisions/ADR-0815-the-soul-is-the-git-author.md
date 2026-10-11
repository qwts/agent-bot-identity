# ADR-0815: The soul is the Git author

**Status:** Proposed
**Date:** 2026-10-11
**Issue:** [qwts/agent-bot-identity#815](https://github.com/qwts/agent-bot-identity/issues/815)

## Context

[#815](https://github.com/qwts/agent-bot-identity/issues/815) asks that a
soul's work be attributed to the soul, not to the GitHub App of whichever
harness or orchestrator happened to create the commit. Apps are shared: one
per harness, plus an orchestrator App where one exists. A soul outlives any
one harness or provider, so its authorship should too.

Today the soul is not in the author field at all:

- [`setup-worktree.mjs`](../../setup-worktree.mjs) sets the worktree's
  `user.name` and `user.email` to the App bot, and
  [`hooks/prepare-commit-msg`](../../hooks/prepare-commit-msg) says the Git
  author stays the App bot and adds an `Agent-Identity: agent_<uuid>` trailer.
- [`signed-commit.mjs`](../../signed-commit.mjs) replays each local commit
  through `POST /repos/{repo}/git/commits` with an App installation token.
  It sends only `message`, `tree` and `parents`, and it refuses any commit
  that comes back without `verification.verified`. The local author is
  discarded on replay.

A commit published that way, `5294f38` on `main`, reads:

```text
author    qwts-claude-agent[bot] <308461354+qwts-claude-agent[bot]@users.noreply.github.com>
committer GitHub <noreply@github.com>
gpgsig    (GitHub's web-flow key)          verification: valid
```

So today the App is the **author** and the authenticated API actor. The
**committer and signer are GitHub's web-flow identity**, acting on the App's
request. The App holds no signing key of its own.

The owner chose option A on 2026-10-11
([#815 comment](https://github.com/qwts/agent-bot-identity/issues/815#issuecomment-6106555348)):
the soul is the Git author; the harness or orchestrator App stays the
committer and signer, so commits stay Verified; the execution trailer stays;
no per-operation actor picker yet. The first acceptance item is a live commit
with a soul author that GitHub shows as Verified. The owner asked how this
affects signed commits. Section 4 answers that.

The issue's names (`agent-ada`, `codex[bot]`, `geniusbar[bot]`) are
illustrative. This record says "harness App" and "orchestrator App".

## Decision

### 1. The author string

```text
<display name> <agent_<uuid>@souls.agent-bot.invalid>
```

- **Email local part:** the soul's immutable Agent ID, `agent_<uuid>`. This
  is what makes the author unique per soul. Two souls with the same display
  name still have different author emails.
- **Email domain:** `souls.agent-bot.invalid` by default. `.invalid` is
  reserved by [RFC 6761 §6.4](https://www.rfc-editor.org/rfc/rfc6761#section-6.4)
  and never resolves, so the address is never a mailbox and no one can ever
  verify it on a GitHub account. That matters: GitHub links a commit to any
  account that has verified the author email, so a real domain would let
  whoever controls it claim the soul's commits. An organization may set its
  own domain in its profile (mechanism here, policy there, per
  [ADR-0274](ADR-0274-product-is-mechanism-add-ons-and-sop-packs-carry-policy.md)),
  and it must be one that accepts no mail. The domain is never
  `users.noreply.github.com`, which implies a GitHub account.
- **Name:** the soul's census display name when the commit is created. It is
  for people; the email is the key.

### 2. Rename, fork and retire

- **Rename** changes the name on new commits only. The email does not change,
  because the Agent ID does not. Old commits keep the old name: Git history is
  not rewritten, and a commit's object ID covers its author.
- **Fork** makes a new soul with a new Agent ID, so a new author email. The
  source soul's commits keep its email.
- **Retire** leaves old commits as they are. A retired Agent ID is a tombstone
  (`import-id-retired`), so its author email is never reused by another soul.
- **Import** of the same soul keeps its Agent ID and therefore its email.

### 3. Committer, signer and actor

- **Committer and signer:** whatever GitHub records for an API commit made by
  the App. Today that is `GitHub <noreply@github.com>` with the web-flow key,
  not the App itself. The owner's "the App stays the committer and signer"
  means this: the App's request is what GitHub creates and signs.
- **GitHub actor:** the App whose token made the API call, resolved from the
  bound credential for each operation, as today. A Git author string never
  selects or authorizes an actor.
- **No per-operation actor picker.** Which App acts is still the worktree's
  pinned App ([#648](https://github.com/qwts/agent-bot-identity/issues/648)
  must not regress).

### 4. Signed commits and Verified

This is the answer to the owner's question, from GitHub's documentation and
the code above.

- **REST `git/commits` with a custom author is documented to lose the
  signature.** GitHub's
  [signature verification for bots](https://docs.github.com/en/authentication/managing-commit-signature-verification/about-commit-signature-verification#signature-verification-for-bots)
  says bot signing "will only work if the request is verified and
  authenticated as the GitHub App or bot and contains no custom author
  information, custom committer information, and no custom signature
  information, such as Commits API." Putting the soul in `author` is custom
  author information.
- **Setting only `author` also moves the committer.** The
  [Create a commit](https://docs.github.com/en/rest/git/commits?apiVersion=2022-11-28#create-a-commit)
  docs say the committer defaults to the author. So the soul would become the
  committer too, unless `committer` is also set, which is custom committer
  information as well.
- **`createCommitOnBranch` cannot carry a soul author at all.** The GraphQL
  schema says the mutation "does not support specifying the author or
  committer of the commit and will not add support for this in the future".
  The commit is authored by the credential's owner, the App, and is signed.
  It keeps Verified but cannot express this decision.
- **Local signing is not a way out.** GitHub verifies a signature against a
  key registered on the account that owns the committer email (the `no_user`,
  `unknown_key` and `bad_email` reasons). A GitHub App's bot account has no
  key settings. A machine user could hold a key, but that is a human-style
  account, which the no-human-fallback rule excludes.
- **When Verified is kept:** a commit with no custom author or committer,
  created by an App token through the REST Git Data API or
  `createCommitOnBranch`, which is today's path. Once GitHub records a commit
  as verified, the record
  [persists](https://docs.github.com/en/authentication/managing-commit-signature-verification/about-commit-signature-verification#persistent-commit-signature-verification),
  so a later push of the same commit by a different App keeps it.
- **When it would be lost:** any API commit that names the soul as author, if
  GitHub follows its documentation. `signed-commit` then stops with
  `came back unsigned (unsigned)` before it moves any branch, so nothing
  unsigned is published. That stop is correct and stays.

As documented, then, "the soul is the Git author" and "GitHub signs it" do not
both hold on any API path. The live proof (section 6, item 1) decides:

- **If GitHub signs it anyway,** this record goes ahead as written.
- **If it does not,** the owner chooses before rollout. The choice that keeps
  Verified is: the App stays the author, and the soul is added as
  `Co-authored-by: <display name> <agent_<uuid>@souls.agent-bot.invalid>`.
  GitHub shows trailer co-authors on the commit, and a trailer is message
  text, so signing is unaffected. The other choice is the soul as author with
  unsigned commits, which fails any ruleset that requires signed commits. This
  record does not make that choice.

### 5. The trailer

`Agent-Identity: agent_<uuid>` stays, with the same meaning: the private
execution-identity lookup key, written by `prepare-commit-msg` while the
GitHub identity add-on is on. The author email names the soul; the trailer
names the execution record. When they are the same ID, both stay. The
README's caveat still applies: a squash merge can push the trailer out of the
final trailer block, and the local identity record is the authority.

### 6. Acceptance matrix

Nothing rolls out until item 1 passes. Each row names what a test or a manual
check must show.

| # | Case | Must show |
| --- | --- | --- |
| 1 | **Live proof.** On a scratch branch, in CI or by the owner, the harness App creates a commit through the API with the soul as author. | GitHub returns `verification.verified: true` and the web UI shows Verified, with the soul as author. If not, stop: section 4's owner choice applies. |
| 2 | Harness App creates, pushes and opens the PR. | Author is the soul; committer and signer are GitHub's for the harness App; push and PR actor are the harness App. |
| 3 | Orchestrator App creates, pushes and opens the PR. | Same, with the orchestrator App in place of the harness App. |
| 4 | Harness App creates the commit; orchestrator App updates the branch and opens the PR. | The commit keeps its author, committer and verification; push and PR actor are the orchestrator App. |
| 5 | Inherited pin: a worktree created from a pinned worktree. | The soul author and App come from the new worktree's own binding, never from the parent's config (#648). |
| 6 | Missing or revoked credential. | No commit is created or pushed; the existing denial codes (`no-live-binding`, `soul-retired`, `github-identity-off`, `no-github-app`) are returned; nothing falls back. |
| 7 | Unauthorized substitution: a client sets a different soul's author, or claims another App. | Refused. The author comes from the bound soul and the actor from the bound credential; a label in the request changes neither. |
| 8 | No human fallback. | No path uses the owner's or any human's token, including when the App cannot mint (ENG-0339 fail-closed `gh`). |
| 9 | GitHub identity add-on off. | No soul author and no trailer are written; the agent is the owner's delegate, as today. |

## Consequences

- **No avatar for the author.** The soul's email belongs to no GitHub
  account, so GitHub shows the author as plain text with no avatar or profile
  link. Commits by a soul will not count toward any account's contributions.
  The App still shows as the API actor on pushes and PRs.
- **The decision may not be deliverable as stated.** GitHub's documentation
  says a custom author loses the bot signature. If the proof agrees, the owner
  has to pick between the soul as author and Verified. That cost is known now
  and is why the proof comes first.
- **Code follows only after the proof.** Building this changes
  `setup-worktree.mjs` (the worktree's `user.name` and `user.email`),
  `hooks/prepare-commit-msg` (its comment that the author is the App) and
  `signed-commit.mjs` (sending `author`, and `committer` if needed). It also
  adds an organization profile key for the author domain. Each is a reviewed
  change of its own; none is made by this record.
- **Author strings are assertions.** Anyone can write any author into a
  commit. Verification comes from the binding, the credential and receipts
  (#815 invariant 7), not from the author field.
- **Display names leak into history.** A soul's name at commit time is
  permanent in that commit, even after a rename.
