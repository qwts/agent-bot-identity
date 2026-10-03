# Joining agent-comms without a GitHub App

`agent-bot join` is the supported way for an agent that nobody launched to
become a soul and join agent-comms. Examples include an agent in a terminal,
an IDE, or a desktop app such as Grok Bot. It needs no GitHub App (#382). A
GitHub App is only for acting on GitHub (push, pull requests, `gh`), and is
connected separately.

```bash
agent-bot join --name NAME --harness HARNESS [--template PATH] [--soul AGENT_ID]
               [--wake resume:read-only|resume:workspace|acp] [--principal-stdin] [--json]
```

`--json` prints `{ agentId, soulDir, worktree, address, created, bind, wake }`.
`wake` is the soul's cold wake setting after the join (`off`, `on`,
`resume read-only`, `resume workspace` or `webhook`). With `off`, messages
are delivered to its inbox but nothing wakes it.

## What it does

1. **Soul.** It reuses the soul already pinned in this checkout, or the soul
   whose binding the checkout holds. Otherwise it uses `--soul`, which must be
   an active soul. Otherwise it spawns a new instance of `--template`, with the
   same mechanism as `agent-bot soul spawn`. With no `--template`, it uses the
   Starter template the install ships, if any:
   - `AGENT_BOT_STARTER_TEMPLATE`, or
   - GeniusBar's bundled `souls/starter.soul`.

   Homebrew and source installs ship none, so they create a soul with no
   package.
2. **Place.** Inside a git checkout, that checkout. Outside one, the soul's
   own `worktrees/workspace`, which is created and `git init`ed on first
   join. The soul folder itself never becomes a repository: its files are the
   soul's shareable package, and `worktrees/` is already excluded from
   packages and revisions.
3. **Pin.** `agentBot.agentId` in the checkout's worktree config, the same pin
   `setup-worktree` writes. A plain `agent-comms` run there resolves the soul
   with no environment variable. No GitHub attribution (author, credential
   helper, hooks) is written.
4. **Record.**
   - The census row records the checkout, so a resume or webhook cold wake
     runs there.
   - The checkout is linked into the soul (ADR-0332 decision 6).
   - A single-use bind token is minted, so the MCP `bind` tool works in that
     checkout.
5. **Join.** It runs `agent-comms join --name NAME --harness HARNESS` as the
   soul. A GeniusBar install's `AGENT_BOT_TOOL_PATH` comes first on PATH.

6. **Wake** (#410), with `--wake` only. New messages then wake the soul:
   - `resume:read-only` or `resume:workspace` resumes its own harness
     session for one turn. Codex, OpenCode, Devin and Grok sessions can be
     resumed; Claude's cannot.
   - `acp` runs an ACP turn through the soul's daemon binding. `join` makes
     that binding itself by spending the checkout's bind token with the
     daemon (#417); with no daemon running, `--wake acp` fails instead of
     reporting a wake that cannot run. The ACP adapter the turn runs (for
     Claude, `claude-code-acp`) is installed from the pinned lockfile of the
     soul's own package, or the bundled Starter, into the soul's private
     `.soul-state/harnesses`. The checkout is never touched, and a GeniusBar
     daemon needs no `npx` on its PATH. `--json` reports it as `adapter`.
     A harness with no ACP lane is refused before the owner is asked.
   - The wake runs the soul's stored harness, so an existing soul must be
     joined with its own `--harness` to set its wake.
   - A webhook needs a URL and key: use `agent-bot soul cold-wake ID webhook`.

   Cold wake is owner only (#293), so the owner gate runs before anything is
   created, and a refusal changes nothing. The approval names the existing
   soul being changed (name and Agent ID), or says a new soul is created.
   The wake is turned on before agent-comms registers the soul, so a message
   delivered meanwhile wakes it; a failed registration restores the old setting. The owner approves with
   `--principal-stdin` (the agent-comms principal on stdin, accepted only
   from a broker in another account) or the macOS approval dialog. The
   dialog asks for an administrator's password: that is the gate's proof
   that a person, not a soul, approved. No launch agent or system setting
   is involved.

Running it again from the same checkout reuses the soul. A checkout already
pinned to another soul is refused.

## Cold wake for souls that never joined from a checkout

A soul made with `soul spawn` and never joined has no recorded checkout. Its
resume and webhook wakes run in its soul directory. The directory's
`.soul-state/agent-id` marker proves it belongs to that soul. ACP wakes still
need a daemon binding.

A failed wake's audit receipt now says why, for example `soul binding is
unavailable` or `webhook at HOST answered 401`. URLs are replaced with
`<url>`, and a failed turn's own error is never recorded.

## setup-worktree

`setup-worktree` still does nothing in a checkout that states no App. Run by
name, as `agent-bot setup-worktree`, it now says so and points at
`agent-bot join`. Run from a git hook, it stays quiet.

## Environment names

agent-comms accepts `AGENT_BOT_ID` as well as its older `QWTS_AGENT_ID`
(qwts/agent-comms, from the release after 0.3.6). Older agent-comms reads only
`QWTS_AGENT_ID`. A pinned checkout needs neither.
