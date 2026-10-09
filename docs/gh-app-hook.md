# gh-app-hook: deploying the GitHub App mailbox

`gh-app-hook.mjs` is a Cloudflare Worker with one Durable Object. GitHub
posts each App's webhook deliveries to it; it stores the records that
mention the App, pushes them to subscribers, and lets a bound session take
the oldest one for its App and repository through `take_inbox` (the
`agent-bot mcp` server). This is the deployment and provisioning procedure
that `doctor`'s `inbox.configuration` check points at (#230).

Nothing here is automated by agent-bot: the Worker is deployed by the
organization owner with `wrangler`, and its secrets are set with
`wrangler secret put`, never through an agent.

## 1. Deploy the Worker

From a checkout of this repository, as the owner of the Cloudflare account:

```bash
npx wrangler deploy
```

`wrangler.toml` names the Worker `gh-app-hook`, its entry `gh-app-hook.mjs`,
the Durable Object binding `INBOX` (class `InboxDurable`) and the `v1`
migration that creates it. The first deploy applies the migration; later
deploys keep the stored records.

## 2. Set the three secrets

| Secret | Shape | Used for |
| --- | --- | --- |
| `INBOX_TOKEN` | one opaque string | The bearer `take_inbox` and `GET /deadletter` present as `Authorization: Bearer …`. Compared in constant time. |
| `WEBHOOK_SECRETS` | JSON object, App slug → that App's webhook secret | Verifying `x-hub-signature-256` on `POST /github/<slug>`. A delivery whose signature does not match is refused with 401 and stored nowhere. |
| `SUBSCRIBERS` | JSON object, App slug → list of push destinations (optional) | Pushing each stored record to receivers; see the header of `gh-app-hook.mjs` for the entry fields (`url`, `key`, optional `repos` and `auth`). Without it records wait to be pulled. |

```bash
npx wrangler secret put INBOX_TOKEN
npx wrangler secret put WEBHOOK_SECRETS      # paste {"<slug>":"<webhook secret>",...}
npx wrangler secret put SUBSCRIBERS          # optional; paste the JSON object
```

Generate `INBOX_TOKEN` and each webhook secret with a password manager or
`openssl rand -hex 32`, and keep them in the organization's secret store
(Proton Pass for this toolkit). A malformed `WEBHOOK_SECRETS` is treated as
empty, so every delivery is refused until it is fixed; a malformed
`SUBSCRIBERS` is logged (redacted) and skipped.

## 3. Point each App's webhook at it

For every GitHub App that agents act as, in the App's settings on github.com:

- Webhook URL: `https://<worker host>/github/<app slug>` (the slug is matched
  case-insensitively against the `WEBHOOK_SECRETS` keys).
- Webhook secret: the value stored for that slug in `WEBHOOK_SECRETS`.
- Events: issue comments, pull request review comments and reviews, issues
  and pull requests, so mentions of `<slug>[bot]` arrive. The pull request
  subscription also carries `review_requested`; GitHub does not offer the App
  as a reviewer unless its webhook is active and subscribed to pull requests.

GitHub's `X-GitHub-Delivery` GUID becomes the record id, so a redelivery
dedupes instead of being stored twice.

## 4. Wire the inbox into the daemon and the harness

`take_inbox` goes through the daemon (#229). The daemon holds the bearer and
the URL; the session's MCP server holds neither and presents only its
binding. Store `INBOX_TOKEN` as a pass-cli note, in the `Agent Identities`
vault, titled exactly:

```text
agent-bot.inbox/gh-app-hook-inbox-token
```

with the bearer as the note's only content. The daemon reads it for each
take, so a rotated value takes effect without a restart. Then install the
daemon with the URL set, which writes it into the daemon's unit:

```bash
GH_APP_HOOK_INBOX_URL=https://<worker host> agent-bot daemon install
```

Only a plain `http(s)://host[:port][/path]` goes into the unit; a URL with
userinfo, a query or a fragment is left out. The harness needs the MCP
server:

```json
{ "mcpServers": { "agent-bot": { "command": "agent-bot", "args": ["mcp"] } } }
```

The server is `agent-bot mcp`; a soul package's `agent-bot` entry runs
`reach-mcp`, the daemon's reach-back server, which has no `take_inbox`, so
`doctor` does not count it as inbox wiring (#247). The bearer is **one
fleet-wide value, not per-App**: it can take any App's records for any
repository, which is why only the daemon reads it. The daemon takes for the
App on the bound soul's own record and the repository of the bound
worktree's `origin`; nothing the caller sends chooses either, and takes for
one App and repository run one at a time. Each take leaves an `inbox-take`
receipt in the audit log naming the soul, App and outcome, never the bearer.

| take_inbox code | Meaning |
| --- | --- |
| `inbox-credential-missing` | The pass-cli note is missing or empty. |
| `inbox-credential-unavailable` | pass-cli could not be read (no session, locked). |
| `inbox-not-configured` | The daemon has no valid `GH_APP_HOOK_INBOX_URL`. |
| `inbox-no-app` | The bound soul has no GitHub App. |
| `inbox-auth-expired` | The Worker refused the bearer; update the note. |
| `inbox-broker-unreachable`, `inbox-unavailable`, `inbox-bad-request` | The broker failed, timed out or refused the request. |
| `inbox-not-bound`, `inbox-wrong-worktree`, `inbox-daemon-unreachable` | The session's own binding or daemon connection. |

`GH_APP_HOOK_INBOX_TOKEN` in a session's environment is no longer read.

## 5. Verify

```bash
agent-bot doctor --machine-only --json | jq '.machine.checks[] | select(.id | startswith("inbox."))'
agent-bot doctor --machine-only --probe-inbox
```

`inbox.configuration` is `ready` when the URL is set and a harness wires
`agent-bot mcp` (the bearer is the daemon's, so doctor does not look for it); `--probe-inbox` sends one unauthenticated
`HEAD /inbox` and reports the host's reachability. Then, from a bound
worktree, `take_inbox` returns `{ "event": null }` (HTTP 204, nothing
waiting) or the oldest record for that App and repository.

`GET /deadletter?app=<slug>` with the bearer lists the records whose pushes
exhausted their retries (kept seven days).

## 6. Troubleshooting and recovery

**Cloudflare secrets are write-only.** `wrangler secret put` sets a value and
`wrangler secret list` shows names only; nothing reads a value back. Record
each value in the secret store when you set it. A value that was not recorded
can only be replaced, which is a rotation.

**A 401 does not say which side is wrong.** `POST /github/<slug>` answers
`401 {"error":"bad signature"}` both when the slug has no entry in
`WEBHOOK_SECRETS` and when the secret does not match. `/inbox` answers
`401 {"error":"unauthorized"}` both when `INBOX_TOKEN` is unset on the Worker
and when the presented bearer is wrong. Two probes separate the halves without
changing anything stored.

Delivery half: a correctly signed payload with no `repository` is verified
and then stored nowhere, answering `200 {"stored":false}`:

```sh
SECRET='<app webhook secret>'; BODY='{"action":"ping"}'
SIG="sha256=$(printf '%s' "$BODY" | openssl dgst -sha256 -hmac "$SECRET" | awk '{print $NF}')"
curl -sS -w '\nHTTP %{http_code}\n' -X POST \
  -H "x-hub-signature-256: $SIG" -H 'content-type: application/json' \
  -d "$BODY" https://<worker host>/github/<app slug>
```

`200 {"stored":false}` means the slug is in `WEBHOOK_SECRETS` and the secret
matches; `401` means it does not, and no change on the GitHub side will help
until it does. This isolates the Worker's half from the App's, which a `200`
on GitHub's own ping does not.

Retrieval half: **probe a repository that can never have records.** A
successful take deletes the record it returns, so probing a real repository
can consume a pending event. A nonexistent `owner/name` matches nothing:

```sh
INBOX_TOKEN='<the value of the pass-cli note>'
curl -sS -o /dev/null -w '%{http_code}\n' -X POST \
  -H "Authorization: Bearer $INBOX_TOKEN" \
  "https://<worker host>/inbox?app=<app slug>&repo=<owner>/nonexistent-probe-repo"
```

`204` means the bearer is accepted; `401` means it is not.

**GitHub disables a webhook after repeated failures.** Deliveries that keep
failing (for example, a run of 401s while `WEBHOOK_SECRETS` was wrong) can
get the App's webhook marked inactive. Fixing the secret does not re-enable
it: re-save the webhook URL in the App's settings, which re-arms it, then
check **Recent Deliveries** there, and redeliver anything missed. Redeliveries
reuse the delivery GUID, so they dedupe.

**Rotation.** For a webhook secret: generate a new value, update that slug's
entry in `WEBHOOK_SECRETS` (`wrangler secret put` replaces the whole JSON
object, so paste every entry), then set the same value on the App and save.
Deliveries in between fail and can be redelivered afterwards. For
`INBOX_TOKEN`: put the new value, then update the
`agent-bot.inbox/gh-app-hook-inbox-token` note; until it is updated,
`take_inbox` calls get `inbox-auth-expired`. Re-run the probes above after either rotation.
