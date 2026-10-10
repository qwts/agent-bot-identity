# Delegation grants

A soul can ask to make one named write as the owner's GitHub account (#108).
The owner approves that exact write at keyd's presence prompt (Touch ID or the
login password). The daemon then performs it once with the owner's narrow
token. The soul never holds the token.

The writes that can be granted are:

- `issue-comment`: comment on an issue or pull request;
- `issue-state`: close or reopen an issue or pull request;
- `review-request`: request review on a pull request.

Approving or merging a pull request is never grantable.

## Setup

1. Create a fine-grained GitHub token on your own account. Give it
   **Issues: write** and **Pull requests: write**, and only for the
   repositories souls may act on.
2. Store the token in pass-cli, in the host's credential vault (`Agent
   Identities` by default). Title the note `agent-bot.human/<login>-github-token`,
   for example `agent-bot.human/qwts-github-token`. A host that sets
   `AGENT_BOT_CREDENTIAL_NAMESPACE` uses that namespace in place of
   `agent-bot`.
3. Set `AGENT_BOT_HUMAN_LOGIN=<login>` and run `agent-bot daemon install`.

Until these steps are done, each spend refuses and leaves the grant approved:

| Code | Meaning |
| --- | --- |
| `human-login-unconfigured` | `AGENT_BOT_HUMAN_LOGIN` is not set. |
| `human-token-missing` | The note is missing or empty. |
| `human-token-unavailable` | pass-cli could not be read. |
| `human-check-failed` | GitHub's `GET /user` failed. |
| `human-login-mismatch` | The token belongs to a different account. |

## Flow

1. The soul calls `request_grant` with the operation. The daemon records the
   grant and asks for your presence on a line that names the soul, the write
   and the grant's digest. The call returns the approved grant.
2. The soul calls `spend_grant` with the grant's `proposal_id` and the same
   operation. The daemon reads the token and checks `GET /user`. It then makes
   the write and writes a receipt to the audit log that names the account.
3. A grant is spent once. A failed write still uses up the grant. Approved
   grants expire with their proposal and are forgotten when the daemon
   restarts.
