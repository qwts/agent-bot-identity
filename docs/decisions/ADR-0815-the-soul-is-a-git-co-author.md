# ADR-0815: The soul is a Git co-author; commits stay Verified

**Status:** Accepted (2026-10-11, by the owner, on [#815](https://github.com/qwts/agent-bot-identity/issues/815#issuecomment-6106642014))
**Date:** 2026-10-11
**Issue:** [qwts/agent-bot-identity#815](https://github.com/qwts/agent-bot-identity/issues/815)

## Context

[#815](https://github.com/qwts/agent-bot-identity/issues/815) asks that a
soul's work be attributed to the soul, not only to the GitHub App of whichever
harness or orchestrator created the commit. Apps are shared: one per harness,
plus an orchestrator App where one exists. A soul outlives any one harness or
provider, so its attribution should too.

Today the soul is not named in a commit's attribution at all:

- [`setup-worktree.mjs`](../../setup-worktree.mjs) sets the worktree's
  `user.name` and `user.email` to the App bot, and
  [`hooks/prepare-commit-msg`](../../hooks/prepare-commit-msg) adds an
  `Agent-Identity: agent_<uuid>` trailer.
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

So the App is the **author** and the authenticated API actor. The
**committer and signer are GitHub's web-flow identity**, acting on the App's
request. The App holds no signing key of its own.

### What GitHub documents

- **Bot signing needs a request with no custom author.** GitHub's
  [signature verification for bots](https://docs.github.com/en/authentication/managing-commit-signature-verification/about-commit-signature-verification#signature-verification-for-bots)
  says it "will only work if the request is verified and authenticated as the
  GitHub App or bot and contains no custom author information, custom
  committer information, and no custom signature information, such as
  Commits API."
- **The committer follows the author.** The
  [Create a commit](https://docs.github.com/en/rest/git/commits?apiVersion=2022-11-28#create-a-commit)
  docs say the committer defaults to the author.
- **`createCommitOnBranch` takes no author.** The GraphQL schema says the
  mutation "does not support specifying the author or committer of the commit
  and will not add support for this in the future". It authors as the
  credential's owner and signs.
- **Local signing is not available to an App.** GitHub verifies a signature
  against a key on the account that owns the committer email (`no_user`,
  `unknown_key`, `bad_email`). An App's bot account has no key settings, and a
  machine user would be a human-style account, which the no-human-fallback
  rule excludes.

### The live proof

The owner first chose option A
([#815](https://github.com/qwts/agent-bot-identity/issues/815#issuecomment-6106555348)):
the soul as Git author, with commits still Verified, gated on a live proof.
The proof was run on 2026-10-11
([#815](https://github.com/qwts/agent-bot-identity/issues/815#issuecomment-6106633691)):
three REST `git/commits` calls as `qwts-claude-agent[bot]` on `main`'s tree,
left as dangling commits on no branch.

| Request | `verified` | `reason` |
| --- | --- | --- |
| No author named | `true` | `valid` (GitHub is the committer) |
| Soul author `probe-soul <agent_probe@souls.agent-bot.invalid>` | `false` | `unsigned` |
| Soul author and an explicit committer | `false` | `unsigned` |

This matches the documentation: once a custom author is named, GitHub does not
sign the commit. A soul author and Verified cannot both hold on any API path.
The owner then replaced option A with the decision below
([#815](https://github.com/qwts/agent-bot-identity/issues/815#issuecomment-6106642014)).

## Decision

### 1. Author, committer and signer do not change

- **Author:** the App whose token creates the commit, exactly as today.
- **Committer and signer:** GitHub's web-flow identity, exactly as today.
  Every commit `signed-commit` publishes stays Verified, and `signed-commit`
  still stops on any commit that comes back unsigned.
- **GitHub actor:** the App whose token made each call, resolved from the
  bound credential, as today. A trailer never selects or authorizes an actor.
- **No per-operation actor picker.** Which App acts is still the worktree's
  pinned App ([#648](https://github.com/qwts/agent-bot-identity/issues/648)
  must not regress).

### 2. The soul is named in a co-author trailer

Each commit a soul makes carries, in its final trailer block next to the
execution trailer:

```text
Co-authored-by: <display name> <agent_<uuid>@souls.agent-bot.invalid>
Agent-Identity: agent_<uuid>
```

- **Email local part:** the soul's immutable Agent ID. This makes the trailer
  unique per soul; two souls with the same display name still differ.
- **Email domain:** `souls.agent-bot.invalid` by default. `.invalid` is
  reserved by [RFC 6761 §6.4](https://www.rfc-editor.org/rfc/rfc6761#section-6.4)
  and never resolves, so the address is never a mailbox, and no one can verify
  it on a GitHub account and so claim the soul's commits. An organization may
  set its own domain in its profile (mechanism here, policy there, per
  [ADR-0274](ADR-0274-product-is-mechanism-add-ons-and-sop-packs-carry-policy.md));
  it must accept no mail. It is never `users.noreply.github.com`, which
  implies an account.
- **Name:** the soul's census display name when the commit is created.
- **Written from the binding.** The trailer comes from the worktree's bound
  soul, as `Agent-Identity` does, never from text the caller supplies. A
  message that already carries a co-author trailer in the soul domain for a
  different Agent ID is refused, so one soul cannot be credited with another
  soul's work. Co-author trailers for people or other domains are left alone.
- **Add-on off:** like `Agent-Identity`, the trailer is written only while
  the GitHub identity add-on is on.

A trailer is message text, so it does not affect GitHub's signature.

### 3. Rename, fork and retire

- **Rename** changes the name in new trailers only. The email does not change,
  because the Agent ID does not. Old commits keep the old name: history is
  not rewritten, and a commit's object ID covers its message.
- **Fork** makes a new soul with a new Agent ID, so a new trailer email. The
  source soul's commits keep its email.
- **Retire** leaves old trailers as they are. A retired Agent ID is a tombstone
  (`import-id-retired`), so its email is never reused by another soul.
- **Import** of the same soul keeps its Agent ID and therefore its email.

### 4. The execution trailer

`Agent-Identity: agent_<uuid>` stays with the same meaning: the private
execution-identity lookup key. The co-author trailer names the soul; the
execution trailer names the execution record. When they carry the same ID,
both stay. The README's caveat still applies: a squash merge can push trailers
out of the final trailer block, and the local identity record is the
authority.

### 5. Acceptance matrix

| # | Case | Must show |
| --- | --- | --- |
| 1 | **Live proof** of signing with a soul author. | **Done, 2026-10-11** ([#815](https://github.com/qwts/agent-bot-identity/issues/815#issuecomment-6106633691)): no author `valid`; a soul author, with or without a committer, `unsigned`. It decided this record. |
| 2 | Harness App creates, pushes and opens the PR. | Author is the harness App; committer and signer GitHub; Verified; the soul's co-author and execution trailers present; push and PR actor the harness App. |
| 3 | Orchestrator App creates, pushes and opens the PR. | Same, with the orchestrator App in place of the harness App. |
| 4 | Harness App creates the commit; orchestrator App updates the branch and opens the PR. | The commit keeps its author, trailers and verification; push and PR actor are the orchestrator App. |
| 5 | Inherited pin: a worktree created from a pinned worktree. | The trailer's soul and the App come from the new worktree's own binding, never from the parent's config (#648). |
| 6 | Missing or revoked credential. | No commit is created or pushed; the existing denial codes (`no-live-binding`, `soul-retired`, `github-identity-off`, `no-github-app`) are returned; nothing falls back. |
| 7 | Unauthorized substitution: a message names another soul as co-author, or a client claims another App. | Refused. The trailer comes from the bound soul and the actor from the bound credential; a label in the request changes neither. |
| 8 | No human fallback. | No path uses the owner's or any human's token, including when the App cannot mint (ENG-0339 fail-closed `gh`). |
| 9 | GitHub identity add-on off. | Neither trailer is written, as today. |
| 10 | Squash merge of a PR. | The result is checked for the soul's co-author trailer; if GitHub drops it, the local identity record remains the authority, as for `Agent-Identity`. |

## Alternatives rejected

- **The soul as Git author (option A).** Rejected on the live proof: GitHub
  does not sign an API commit that names a custom author, with or without an
  explicit committer, so every soul-authored commit would be unsigned.
  `signed-commit` would refuse them, and allowing them would fail any ruleset
  that requires signed commits. `createCommitOnBranch` cannot name an author
  at all, and an App cannot sign locally.
- **A per-operation actor picker.** Deferred by the owner. Nothing in this
  record needs one.

## Consequences

- **Every commit stays Verified.** Nothing about signing, the committer or the
  App's authorship changes.
- **The soul shows as a plain name.** GitHub links a co-author only through an
  email on a GitHub account
  ([multiple authors](https://docs.github.com/en/pull-requests/committing-changes-to-your-project/creating-and-editing-commits/creating-a-commit-with-multiple-authors)).
  The soul's `.invalid` email is on none, so GitHub shows the co-author as a
  plain name with no avatar or profile link, and the commit counts toward no
  account's contributions. The App stays the visible author.
- **The soul is credited, not the author.** Tools that read only the Git
  author field still see the App. Reading the soul means reading the trailer.
- **Code follows as its own change.** `hooks/prepare-commit-msg` writes the
  new trailer and refuses a substituted one, and the organization profile
  gains a key for the trailer domain. `setup-worktree.mjs` and
  `signed-commit.mjs` keep the App as author and do not change. Each is
  reviewed when built; none is made by this record.
- **Trailers are assertions.** Anyone can write any trailer into a commit.
  Verification comes from the binding, the credential and receipts (#815
  invariant 7), not from the trailer.
- **Display names stay in history.** A soul's name at commit time is permanent
  in that commit, even after a rename.
