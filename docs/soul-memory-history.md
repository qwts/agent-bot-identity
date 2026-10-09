# Soul memory and history

Where a soul's Agent Space (its memory) and its run history live, how an
existing soul's space moves into its folder, and what the descriptor says
about both. Implements #583 slice 5, ADR-0583 decisions 8 and 9: the soul
folder owns its memory and carries its history, so a folder that is backed
up, copied or exported takes the soul's life with it.

## Commands

```sh
agent-bot soul env <agentId|name> [--json]                                  # reports memory and history
agent-bot soul env migrate <agentId|name> --space-into-soul [--json] [--principal-stdin]
agent-bot soul env migrate <agentId|name> --complete [--plan] [--json] [--principal-stdin]   # resumes an interrupted move
agent-bot agent-space path <agentId>                                        # the census path, wherever it is
```

## Memory: the Agent Space inside the soul

- A new soul (spawn, fork, the first launch of a soul whose space does not
  exist yet) gets its Agent Space as a real directory,
  `<soulDir>/.soul-state/space/`, marked with `space.json` like any space,
  and the census row's `spacePath` names it. Nothing is created under the
  spaces root (`~/.agent-space`, `AGENT_BOT_SPACES_HOME`) for such a soul.
- The census `spacePath` is authoritative. Every reader of a soul's space
  resolves through it: `agent-space path | show | export | retire`, the
  daemon's `GET /v0/space/path`, `soul env`, machine readiness and revision
  promotion (`promoteSpaceContent`). A soul the census does not know is
  looked up at the spaces root as before. In code: `soulSpacePath` and
  `inspectSoulSpace` in `soul-memory.mjs`; `inspectAgentSpace` and friends
  take `root` for the same reason.
- Ensuring a space (the daemon's `POST /v0/space/ensure`, a worktree bind,
  `agent-bot join` and `setup-worktree` in process) goes through
  `ensureSoulSpace`: the census space when it carries the soul's marker,
  wherever it is (`created: false`), else a new one under the spaces root.
  A contained soul is never handed, and re-registered to, an empty space
  under the root.
- An existing soul whose space lives under the spaces root keeps it there,
  linked from `.soul-state/space` as before, until the owner moves it. The
  descriptor reports `memory.location: linked`, `contained: false`, the
  `memory-not-contained` warning with the migrate command as its action and
  a pending `space-into-soul` migration step. Nothing moves on upgrade.

## Moving a space into its soul

```sh
agent-bot soul env migrate billy --space-into-soul
```

One soul per run, owner-gated (`--principal-stdin` carries the principal
JSON; the action named to the gate is `move <id>'s Agent Space into its
soul folder`), refused with `space-migrate-busy` (action `agent-bot soul
stop <id>`) while the soul has a turn in flight or a warm harness, checked
before and after the gate so a turn cannot write into the space mid-copy.
The run holds the soul's `.soul-state/.space-migrate.lock` and the same
`.<id>.lock` beside the source that `initAgentSpace` takes, so nothing
re-creates the source while it moves. Phases, each recorded in
`.soul-state/migration.json` as step `space-into-soul` before it starts:

1. `pending`: the source is the link's target (else the journal's recorded
   source, else the census path); it must be outside the soul and carry the
   soul's marker, otherwise `space-migrate-source-missing`.
2. `copying` into a fresh staging directory
   `<soulDir>/.soul-state/space.migrating-<uuid>` (0700, exclusive). Every
   regular file is copied exclusively with its mode and mtime, every
   symlink is copied as a symlink (never followed; the kept links are
   listed in `copied.links`), directories keep their modes and mtimes. A
   socket, fifo or device is skipped and listed in `copied.skipped`.
3. `verifying`: the staging is walked against the source: same paths, same
   kinds, same sizes, same SHA-256 per file, same link targets, nothing
   extra. A difference removes the staging, records `failed` and fails
   `space-migrate-verify-failed`; the link and the source are untouched.
4. `switching`: the link is renamed aside (`space.link-<uuid>`, recorded as
   `aside`), the staging is renamed to `.soul-state/space`, the aside link
   is removed. A soul that reads its space during the switch sees the old
   target until the rename, then the directory.
5. `done`: the census `spacePath` is set to the directory, then the source
   is retired by rename to `<source>.retired-<YYYY-MM-DD>` (a suffix is
   added if that exists). The source is never deleted; remove the retired
   directory yourself once the soul has run from its folder. The step holds
   `source`, `staging` (null when done), `aside` (null), `retired`, `copied
   { files, bytes, links[], skipped[] }` and a `note` with the counts.

Resumable: a run that stops in any phase continues from the journal, by
the same verb or by `soul env migrate --complete` (which finishes every
pending step at once; see [soul-environment.md](soul-environment.md)). A
partial staging is thrown away and copied again; a complete one is verified
and used; a link already moved aside or a directory already in place is
finished (census, retirement). A rerun of a contained soul is `skipped`
with `already inside` (and repairs a census that still names the old path).
A `.soul-state/space` that is neither a link nor a directory is
`space-migrate-source-missing`: move it aside and run again.

One audit receipt `soul-env-migrate` per run with `operation`
`space-into-soul`, `decision` `migrated | skipped | failed` and a `detail`
with the counts and paths. Never a byte of the space. `--json` prints
`{ schemaVersion, agentId, soulDir, operation, decision, steps[], root }`
with `root` the directory inside the soul.

## History: the mirror under `.soul-state/runs/`

The daemon's journals (wake sessions, launch requests, task turns, the
revision journal under the state directory) are unchanged and recovery
reads them as before. In addition each soul folder carries an append-only
mirror, facts only, never a prompt, an output, a session's contents or a
secret:

- `turns.jsonl`: one line per turn that passed the daemon's turn registry
  (cold ACP wake `wake`, resume wake `wake`, a task `task`, a launch
  `launch`, anything else `turn`) and per Claude session binding
  (`session`): `{ id, kind, startedAt, endedAt, harness, outcome }` with
  `outcome` `ok | failed | cancelled` (null for a session line).
- `revisions.jsonl`: one line per revision the journal records, from
  genesis on: `{ id, parent, reason, at }`.

Files are 0600 under a 0700 directory; each line is one write, so
concurrent appends never interleave. The mirror is best effort by design:
a soul the census has no folder for, a folder without `.soul-state`, or a
mirror that cannot be written changes nothing about the turn or the
revision; the daemon logs `history mirror: <what> for <id> not written
(<code>)` to its stderr once per failure. `soul-history.mjs` holds it
(`createSoulHistory` is the daemon's port; `appendSoulTurn` and
`appendSoulRevision` take the soul root).

### Portable cold conversation context

The cold-wake message journal lives at
`.soul-state/runs/comms-context.jsonl` for a soul whose registered folder has
a matching `.soul-state/agent-id`. Unlike the two fact-only mirrors above,
this file contains the bounded messages used to reconstruct the next cold
turn's context. It keeps the existing entry, journal and prompt limits; it
is not an unlimited transcript. Principal isolation and quoted-data prompt
formatting apply after import just as they do before export.

An older journal at `<agent-bot state>/threads/<agentId>.jsonl` remains readable
until the first contained write. That write locks the destination and source,
copies the source into a private temporary file, verifies its bytes, and
publishes it atomically before appending. The original is retained. Interrupted
staging files are disposable under `.soul-state/tmp`; a subsequent write can
retry from the original. Reads never migrate. Missing/mismatched soul markers
or linked history paths refuse the journal read/write rather than selecting
another soul's data. Souls without a registered folder keep the legacy path.

Life export includes the contained file through the history classification.
If the contained file is absent, export snapshots this soul's legacy journal
directly into that same archive path without changing live storage. A life
import restores it beneath the kept or explicitly forked soul's root. In-flight
send claims stay in daemon state and are not carried. Recorded decisions and
linked teammate facts can therefore reach a later cold turn after transfer,
provided the requesting principal retains the same identity.

Rollback to an engine that only reads the legacy location is a stopped-writer
operation. Back up both journals, restore the contained journal's bytes to the
legacy path with mode 0600, verify that copy, then move the contained file to
the retained backup. The old engine can continue from the restored journal;
the next upgrade will import its later writes because the contained path is
absent. Never switch versions with two writers active or simply remove the
new file without first preserving its newer messages. No automatic downgrade
or live old/new-writer reconciliation is claimed.

Native `/v1` sessions, invocations, events and payloads live in the
separate interaction store. A life export now carries the soul's own rows
from it and a kept or replaced import merges them back, adding only; a
fork keeps them as the parent's read-only history (#583, see
[Export and import](soul-environment.md#export-and-import)). That moves the
record, not continuity: imported native harness sessions are not made
resumable. The descriptor lists the legacy conversation
journal and reports the contained one at `history.conversation { path, present }`.
Native interaction inventory/transfer, full native continuity and host-view
reconstruction remain tracked in #596; #583 is not complete merely because
the run summaries or cold context survive export.

### Reading the fact mirror

```sh
agent-bot soul env history <agentId|name> [--json] [--limit N]
```

Lists the mirror, newest first, so a host (GeniusBar's Memory tab) renders
a soul's past turns and revisions without reading soul files itself.
Read-only: no gate, no receipt, nothing written, and it reads nothing but
the two mirror files. `--json` prints, schema 1:

```json
{ "schemaVersion": 1, "agentId": "agent_…", "soulDir": "…/Billy.soul",
  "mirror": "…/Billy.soul/.soul-state/runs", "mirrored": true,
  "turns":     { "total": 3, "listed": 2, "limit": 2, "skipped": 0, "truncated": false,
                 "records": [ { "id", "kind", "startedAt", "endedAt", "harness", "outcome" } ] },
  "revisions": { "total": 2, "listed": 2, "limit": 2, "skipped": 0, "truncated": false,
                 "records": [ { "id", "parent", "reason", "at" } ] } }
```

Every record has exactly the keys above (each line passes through the
same shaper the writer uses, so a stray field never reaches the listing).
`total` is the file's line count, `listed` how many came back. Limits:

- `--limit N` is 1..500 per file, default 50; anything else is a usage
  error. A host pages by asking for more, up to the maximum.
- Each file is read within a window of its last 16 MiB. Past that, only
  the tail is parsed (the first partial line dropped) and the group says
  `truncated: true`; `total` still counts the whole file up to 256 MiB,
  `null` beyond.
- A line that is not a JSON object is skipped and counted in `skipped`;
  blank lines are nothing.
- No `.soul-state/runs/` directory is `mirrored: false` with empty groups
  and `null` totals, not an error: a life may not have started yet. A file
  that cannot be read (a link in its place, say; a link is never followed)
  is `total: null` with nothing listed; an absent file is `total: 0`.

Without `--json`: `agentId`, `soulDir`, `mirror`, then `turns: <listed>
of <total>` and one line per turn (`<startedAt>  <kind>  <harness>
<outcome>  <id>`), then `revisions: <listed> of <total>` and one line per
revision (`<at>  <id>  (<parent>)  <reason>`); `-` for an unknown value.
The capability is `env-history`.

## In the descriptor

`soul env` reports `memory { location: inside | linked, target, contained,
spacePath, status }` (`status` is the inspection at the census path) and
`history { external[], confinementLog, mirror: ".soul-state/runs",
turns, revisions, mirrored }` (`turns` and `revisions` are line counts,
`null` for a file that cannot be counted; `mirrored` when the directory
exists). The capabilities list gains `memory` and `history`. Readiness:
`memory-not-contained` (warning) while the space is linked, with the
migrate command as its action. The migration inventory lists
`space-into-soul` pending while linked and as recorded once run.

## Limits

### Conversation continuity

Stored history and the context delivered to a turn are separate. The run
mirror above contains facts about executions, not conversation text. Cold
agent-comms turns recover a bounded context from the existing per-soul
thread journal (`soul-threads.mjs`) before the relay starts the harness:

- Messages with `correlation` or `replyTo` receive that linked thread.
- A principal message with neither field seeds from its eight most recent
  exchanges with that exact principal in this soul's journal, including linked teammate
  work. This supports the GeniusBar composer, which sends `to`, `body` and
  an idempotency `key` without either thread field. Previously its next
  message received no earlier context, even though the UI showed it (#596).
- An unthreaded message from another agent gets no implicit conversation
  history. A different principal or soul does not inherit this fallback.
  An explicit thread link always takes precedence, even when unknown.
- Principal context never follows another principal's exchanges or teammate
  links connected to them. A summary actually sent to the current principal
  remains eligible, but shared correlations cannot pull the other person's
  private conversation into it. This filter also applies to explicit principal
  thread requests; ambiguous linked teammate work is omitted.
- The fallback is per soul and principal, not per UI chat tab. The composer
  supplies no conversation ID or fresh-chat marker; opening a new chat view
  does not establish a separate context boundary in this mechanism.
- Existing bounds still apply: at most eight recent entries within 6 KiB
  of serialized context, with each stored body capped at 2 KiB. Entries
  appear oldest first as quoted message data, not new instructions. The
  journal itself is bounded; this is not lifetime-memory retrieval.

`tests/soul-threads.test.mjs` exercises the actual relay prompt with a
distinctive decision and teammate facts, then checks the next turn, a new
waker reading the same persisted journal, and a changed harness. Negative
fixtures check another principal, another soul, agent messages and explicit
thread boundaries. These are deterministic engine fixtures: they prove the
input delivered to the executor, not a model's answer or a live GeniusBar
restart. No native session-resume support is implied by this fallback.

Remaining #596 acceptance includes live UI/app and daemon restarts and
supported CLI transitions. Native `/v1` session association and the CLI
resume-wake lane's per-soul session registry are separate paths requiring
their own evidence. Neither is demonstrated by the cold-relay fixtures,
and relocating Agent Space alone does not resolve those continuity requirements.

### Storage and migration limits

- Interactive sessions tracked by `agent-bot join` (`turns.track`, no
  outcome) are not mirrored; the daemon's wake-session and launch-request
  files are not mirrored line by line (their turns pass the registry and
  are).
- A soul joined from the user's session or bound to a worktree keeps an
  external space until its folder exists: `ensureSoulDirectory` links an
  existing external space and contains a missing one; the owner moves an
  existing one with the migrate command.
- The migration copies within one filesystem walk and holds the space in
  memory one file at a time; a space of many gigabytes takes as long as a
  copy of it. The staging lives inside the soul folder, so the folder needs
  the room.
- `soul env migrate --space-into-soul` moves the space; it does not export
  it. `soul env export` carries the space (through its link when it is
  still linked, so the life travels either way) and `soul env import` puts
  it inside the restored folder; see
  [soul-environment.md](soul-environment.md#export-and-import).
- The retired source (`<source>.retired-<date>`) is memory outside the
  root: `soul env clean` never removes it (it removes only reconstructible
  and disposable paths inside the root). Remove it yourself once the soul
  has run from its folder.
