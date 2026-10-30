# ADR-1257: A soul outlives its sessions

**Status:** Accepted (2026-10-29, by the owner in chat, after review by Grok)
**Date:** 2026-10-29
**Issue:** [qwts/agent-bot-identity#1257](https://github.com/qwts/agent-bot-identity/issues/1257) (item 2)
**Builds on:** [ADR-0332](ADR-0332-souls-are-the-agents-territory.md) (souls are the agent's territory; managed and unmanaged)

## Context

Today an Agent ID is bound to one harness conversation (a transcript).
`ensureAgentIdentity` (identity/agent-identity.mjs) keeps the pinned identity
only while the transcript matches. A different conversation in the same
checkout mints a fresh identity (#192 rotation rule), and the census then
records it as a new soul.

#1257 shows the result. A Cursor session joined an existing soul
(`join --soul agent_9ae…`, `indigo-moss-18`). Its `session bind` then minted
`iron-thicket-d9`, and the joined soul's workspace was repointed at the new
one. `docs/joining.md` says to join the existing soul; the runtime did the
opposite.

The platform papers give the intended model:
- "A Soul has one stable public identity. Members, installations, runtimes,
  sessions, and revisions remain separately attributable." (Soul Agent
  Platform draft 0.4, §1)
- Session: "a bounded interaction context within a runtime, per context or
  conversation" (vocabulary).
- "Stable Soul ID; members, installations, runtimes and sessions identified
  separately" (Soul Agent System Architecture).
- A new Soul ID comes only from a template or a fork, and a fork records its
  parent (draft 0.4, §11).

The owner's direction (2026-10-29):
- **Managed soul:** the soul package runs and manages its harnesses. Sessions
  depend on their harness, and several harnesses and sessions are
  encapsulated under the one soul.
- **Unmanaged soul:** the app owns the harness, for example an IDE like Devin
  Desktop, or gemini.google.com, and exposes only sessions. The app's sessions
  across the life of the app become one soul.
- **Feeding back:** whatever the soul package maintains, such as memory,
  handoff notes and skills, has to be actively fed back into the app's
  sessions. Otherwise the soul is little more than sophisticated retrieval.

## Decision

1. **The Agent ID names the soul, not a conversation.** It is stable for the
   soul's lifetime. A conversation is a **session** record under the soul:
   provider, transcript ID, harness, runtime, start and last-seen times. Each
   session stays separately attributable in bindings, receipts and history.
2. **Binding a new conversation adds a session; it never mints a soul.**
   `session bind` in a checkout pinned to a soul attaches the transcript as a
   new session of that soul. The soul's earlier sessions stay on record and
   are not overwritten. The #192 "different transcript means a new identity"
   rotation rule is retired.

   Identities minted under the old rule, and their live bindings, stay
   valid. No new session attaches to them. They're grouped under a soul only
   through `population backfill`, with the owner's approval.
3. **Unmanaged souls.** For an app that exposes only sessions, the soul is the
   one chosen at `join`: by pin, by binding, or by `--soul`. Every later
   session the app binds in that soul's checkouts is a session of the same
   soul. The unit is the **app profile**, not the app: one app signed in to
   two accounts or profiles gives two souls, so their sessions never merge into
   one identity.
4. **Managed souls.** The soul package launches its harnesses. Each harness
   runtime has its own sessions, all under the one soul ID. Resume and
   interaction continuity (docs/interaction-continuity.md) keep using the
   per-session harness binding.
5. **New Soul IDs come only from explicit creation:**
   - `join` with no existing soul;
   - `soul spawn` or a template;
   - a fork, which records its parent.

   A bind never creates one.
6. **Conflicts fail closed.** These are refused with 409 and change nothing:
   - a transcript already bound to a different soul;
   - a bind token naming a retired soul;
   - an `AGENT_BOT_ID` that disagrees with the checkout's pin.

   A bind never repoints another soul's checkout.
7. **Feeding the soul back to the session is a requirement, not a nicety.** At
   bind (session start) the session receives the soul's brief: open tasks,
   handoff notes and relevant memory, plus its skills, through MCP and the
   skill surface. That's the "clock-in brief" in the platform papers. How this
   is designed is a follow-up; this ADR only fixes the identity model it
   depends on.
8. **Sessions are authority state.** The session record lives in the
   identity registry (HQ authority state), next to the soul's identity record.
   It never lives in `.soul-state` or anywhere else a member can write, and it
   never travels in the package. Shape:

   ```json
   {
     "session_id": "ses_<uuid>",
     "soul_id": "agent_<uuid>",
     "transcript": { "provider": "cursor", "id": "<transcript id>" },
     "harness": "cursor",
     "app_slug": "qwts-cursor-agent",
     "app_profile": "<opaque profile key or null>",
     "device_id": "dev_<id> or null",
     "status": "live | ended",
     "started_at": "<RFC 3339>",
     "last_seen": "<RFC 3339>",
     "ended_at": "<RFC 3339 or null>"
   }
   ```

   `(transcript.provider, transcript.id)` is unique across all souls; that's
   what makes the 409 in decision 6 decidable. `session_id` is minted by the
   daemon at bind and never reused.
9. **Concurrent sessions.** One soul may have several live sessions at once,
   for example two windows of the same app. Each session holds its own lease.
   Only the session holding the task's lead lease may finalise that task, so
   two windows can't both finalise it. That's the draft 0.4 §7 lease rule,
   applied per session.
10. **Audit carries the session.** Receipts, the local action ledger and
    credential-mint audit records carry `soul_id` and `session_id`, locally
    and on agents.true-line.ai. `session_id` is null only for records written
    before this ADR. The server field (Grok) lands before or with the
    implementing PR, so the two audits never disagree.

## Consequences

- AGENTS.md's "transcript-bound execution identities" becomes
  "soul-bound identities with per-session attribution".
- `ensureAgentIdentity` changes from match-transcript-or-mint to
  find-soul-then-add-session. Attribution that used the Agent ID as the
  conversation key moves to the session ID: receipts, the action ledger,
  credential-mint audit, census `sighted`.
- Existing per-transcript identities stay valid and are not merged
  automatically. Optionally, `population backfill` can propose grouping them
  under their soul for owner approval.
- `bind` responses drop `repinRequired` for this path, since the pin never
  needs to change.

## Open questions

Settled in review: concurrent sessions (decision 9), apps with several
accounts or profiles (decision 3: per app profile), and where the session
record lives (decision 8: the identity registry).

1. **A terminal harness started fresh with no pin and no `--soul`:** proposed
   that it keeps today's behaviour, where `join` creates a soul and later
   sessions in that checkout join it.
2. **How an app profile is identified** for apps that don't expose one,
   such as a web chat. Proposed: the device plus the app's account login when
   known, otherwise one profile per app on that OS user.

## Acceptance (for the implementing PR)

- After `join --soul X`, `session bind` with a new transcript returns X's
  Agent ID and adds one session. There's no new census soul, and the pin is
  unchanged.
- Binding the same transcript twice is idempotent.
- A transcript already bound to soul Y, bound in X's checkout, is refused
  with 409 and changes nothing.
- A retired soul is refused, as today.
- Receipts and mint audit records carry both the soul ID and the session ID,
  locally and on the server.
- Two live sessions of one soul: only the lead-lease holder can finalise a
  task; the other gets a lease refusal.
- An identity minted under the #192 rule keeps working, and no new session
  attaches to it.
- The session record is written only to the identity registry; nothing
  under the soul directory changes on bind.
