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
  and pull requests, so mentions of `<slug>[bot]` arrive.

GitHub's `X-GitHub-Delivery` GUID becomes the record id, so a redelivery
dedupes instead of being stored twice.

## 4. Wire the inbox into the harness

The session's MCP server needs the inbox URL and the bearer in its
environment, and the harness needs the server:

```bash
export GH_APP_HOOK_INBOX_URL=https://<worker host>
export GH_APP_HOOK_INBOX_TOKEN=<INBOX_TOKEN, from the secret store>
```

```json
{ "mcpServers": { "agent-bot": { "command": "agent-bot", "args": ["mcp"] } } }
```

The server is `agent-bot mcp`; a soul package's `agent-bot` entry runs
`reach-mcp`, the daemon's reach-back server, which has no `take_inbox`, so
`doctor` does not count it as inbox wiring (#247). The bearer today is a
shared secret the agent's environment carries; #229 tracks moving it behind
the daemon so an agent never holds it.

## 5. Verify

```bash
agent-bot doctor --machine-only --json | jq '.machine.checks[] | select(.id | startswith("inbox."))'
agent-bot doctor --machine-only --probe-inbox
```

`inbox.configuration` is `ready` when the URL is set, the bearer is present
and a harness wires `agent-bot mcp`; `--probe-inbox` sends one unauthenticated
`HEAD /inbox` and reports the host's reachability. Then, from a bound
worktree, `take_inbox` returns `{ "event": null }` (HTTP 204, nothing
waiting) or the oldest record for that App and repository.

`GET /deadletter?app=<slug>` with the bearer lists the records whose pushes
exhausted their retries (kept seven days).
