# Soul asides

Asides record agent-comms messages that entered or left a soul's context.
Cold wake records its delivered prompt and final reply; reach tools record
`send_message` and `start_soul` sends. Earlier thread messages shown again have
`via: "thread-context"` and `reshown: true`.

A live session's agent-comms client can report messages it read with
`via: "inbox-read"`, or a hook can report bodies it injected with
`via: "hook-inject"`, through [POST /v0/asides/delivered](daemon-api.md#delivered-aside-api).
Both produce `dir: "in"`, `reshown: false`. A message left unread in a mailbox,
or consumed without a delivery report, creates no live-session aside.
The daemon fetches the message as the bound soul rather than trusting a
client-supplied body or identity.

Each entry includes its message ID, peer, reply-to, correlation, census-derived
team ID, optional harness session ID, and a body bounded to 2048 bytes. A session
ID describes the reporting session; it is not authentication. Delivery reports
are idempotent against incoming, non-reshown entries in the retained journal,
across restarts and across the two delivery vias. Once retention removes an old
entry, reporting it again can record it again if it is still in the mailbox.

Journals are private daemon state (0700 directory, 0600 files), bounded to 2 MiB
and trimmed to at most 2000 newest entries that fit half that byte budget.
The owner reads `agent-bot soul asides <agentId|name> [--after ASIDE_ID]
[--limit N] [--json]`. A principal authorized to observe the soul reads
`GET /v1/souls/<agentId>/asides?after=<asideId>&limit=200`. Both return
`{ agentId, asides, next }`; `next` is null at the end. A soul's binding permits
delivery reports, not reading these observation surfaces.
