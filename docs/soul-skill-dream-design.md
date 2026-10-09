# Dream maintenance implementation contract

Status: staged implementation contract for #603, following
[ADR-0603 decision 11](decisions/ADR-0603-imported-skills-keep-local-snapshots-and-upstream-provenance.md).
The scheduler, journal, bounded inputs and daemon service are implemented.
Durable maintenance outcomes, checkpoints and the remaining owner-facing
workflow are incomplete; their requirements below remain proposed contracts.
Implementation does not register a schedule or grant owner authorization.

Dreaming is a bounded agent turn that maintains eligible knowledge using the
soul's existing tools and permissions. The runtime schedules the turn, records
what happened and prevents duplicate maintenance. It cannot infer that copying
a file indexed it, or that an old conversation is disposable.

## Reuse the daemon's execution mechanisms

`skill-dream-service.mjs` composes the host-local scheduler into the daemon.
`task-turns.mjs` reports individual executions to the broker; it does not own
recurrence. Dream reuses the configured executor instead of adding a second
harness launcher or a fabricated broker task.

The service must use the daemon's configured executor factory, tool-home and
runtime resolution, soul identity, permission/approval policy, and shared turn
registry. `coldTurnExecutor` is the closest reusable execution boundary. Its
input now accepts a caller's cancellation signal, `kind: 'dream'`, a facts-only
`historyId` and `timeoutMs`, with existing wake behavior as the default. The
caller timeout shortens the host's configured bound but cannot extend it; the
scheduler's execution port passes its `timeoutMs` through. The shared registry
retains an aborted turn until the configured executor settles. For dream calls,
a successful executor return remains successful after an abort request, so the
scheduler can retain cancellation facts without falsely claiming execution
stopped; ordinary wake calls retain their post-execution abort check. `dream` is
part of the history kind vocabulary. The daemon service composes these ports,
but they do not authorize registration by themselves. Do not invent an interaction-store invocation,
session, principal or broker task ID to acquire unrelated capabilities.

Registration and control use the existing owner settings authorization path.
A daemon bearer token alone is not proof of owner authority. Imported skill
text, a peer message, or an agent's proposed maintenance plan cannot register
a job or broaden permission. Registering a schedule authorizes execution under
the current policy; it does not preapprove later tool requests or revisions.

The daemon exposes `GET /v0/soul/dream` for status and
`GET /v0/soul/dream/history?afterRevision=N&limit=N` for bounded execution-history
pages. `POST /v0/soul/dream/{register,pause,unschedule,run-now,cancel}` uses strict
request fields: `agentId` for soul controls, `schedule` for registration, and
`runId` for cancellation, with an optional owner `principal` credential. Every
mutation passes the existing owner settings gate. Binding-authenticated requests
cannot authorize these actions; the bearer alone cannot replace principal
verification or an explicit owner ceremony. Client paths, executor overrides and
capability claims are rejected. `run-now` returns a run receipt immediately.
The audit records owner authorization before executing a control, then records
whether that control returned or failed. A returned control can defer execution;
its audit receipt does not certify a completed maintenance run.

The journal is under `dream/` beside the daemon state file. Creation establishes
private directory permissions and syncs new directory entries. Unsupported or
invalid storage disables dreaming while other daemon services remain available;
it never deletes or silently repairs state. A 30-second host timer offers due
runs, with no registration or execution enabled by installation alone. Missing
executor configuration prevents new registration/manual runs and defers timers.
Existing run leases are quarantined before any timer starts. Shared stop records
an owner cancellation request; daemon shutdown records `cancelReason: shutdown`
and stops the timer. Older journal readers that reject that new reason must be
upgraded before opening a journal containing shutdown receipts.

This integration exposes execution status with `maintenanceCoverage: unverified`.
It captures bounded starting inputs and durably records their metadata before
runtime/provider resolution. The outcome/checkpoint schema remains incomplete. Raw replies
are not stored as verified evidence, no processing checkpoints advance, and no
maintenance-success notice is claimed. CLI controls and outcome/notice support
remain subsequent acceptance work.
Input preparation failures appear as bounded, content-free codes in status
diagnostics (for example `dream-input-limit`, `dream-input-unavailable` or
`dream-input-drift`). These diagnostics explicitly last only for this daemon
process; they are not durable outcome records and clear after successful capture.

## Schedule and controls

One registration exists per soul on the current host, bound to its agent ID and
canonical soul directory. Dispatch rechecks that binding against the population;
a copied or moved directory does not inherit activation. The proposed CLI is:

```text
agent-bot soul skill dream --soul SOUL --schedule PT24H
agent-bot soul skill dream --soul SOUL --status
agent-bot soul skill dream --soul SOUL --run-now
agent-bot soul skill dream --soul SOUL --pause
agent-bot soul skill dream --soul SOUL --unschedule
agent-bot soul skill dream --soul SOUL --cancel RUN_ID
```

Exactly one action is accepted. The initial schedule grammar is `PT<N>H`, with
an integer from 1 to 720. This is elapsed-time recurrence, not a wall-clock cron
expression; there are no timezone, daylight-saving or month-length semantics.
Unsupported syntax is refused instead of approximated. Schedule registration
sets the first due time to one interval after registration. Repeating the same
active registration is idempotent and preserves its due time; a changed interval
or resumption from pause schedules from the update time. `run-now` requests one
run of an existing active registration without changing its interval.

Pause disables future dispatch. Unschedule removes future registration while
preserving run history. Neither operation claims to terminate an executing
turn. Cancellation targets the named maintenance run through its own abort
controller; the normal soul-wide stop command still reaches it through the
shared registry. Status distinguishes cancellation requested from settled.
If the executor resolves successfully despite a cancellation request, settlement
is `completed` and retains the request timestamp/reason. A rejected execution
after an abort records `cancelled` or `timed-out`; an abort before launch never
calls the executor. None of these execution states claims maintenance coverage
or rolls back changes already committed by tools.

After a completed, failed or interrupted attempt, the next normal due time is
one interval after that attempt ends. A daemon starting after several missed
intervals offers at most one catch-up run, never a queue of missed runs. Failed
attempts do not create an immediate retry loop. Backward clock movement delays
dispatch; forward movement can make one run due. Execution timeout uses a
monotonic timer, independently of recorded wall-clock timestamps.

## Ownership, overlap and recovery

The daemon is the sole scheduling writer. Before dispatch it records a unique
run ID, registration generation, soul ID and daemon generation. Register/update,
pause, unschedule, dispatch and completion serialize through the same service.
A completion from an older registration generation cannot recreate or overwrite
a subsequently changed registration. CLI clients do not start an alternative
scheduler when the daemon is unavailable.

At most one dream turn per soul may be unsettled. The scheduler defers a due
run while the soul is paused or the shared registry reports another active
turn. This is a start-time busy check: it does not promise that a new foreground
session cannot start during maintenance. Definition changes therefore still
need the existing revision compare-and-swap/proposal mechanism. Do not change
interactive session concurrency as a side effect of adding dreaming. Dream
holds no lock that blocks a new interactive turn; foreground work remains
available. The registry currently has no exclusive soul lease to reuse.

Timeout, cancellation and daemon shutdown request abort. The dream run's own
per-soul lease stays held until the executor settles; an abort request is not
evidence of process exit.
On restart, an unfinished record becomes `interrupted`, never successful. Before
another run may start, recovery must establish that the earlier child is gone.
The current ACP engine's process-group ownership is only in memory: it does not
persist a PID/PGID, so existing job recovery cannot establish child exit. Gate 2
therefore needs a process-ownership reporting port before unattended restart
recovery can be claimed. If exit cannot be established,
status reports `recovery-required` and dispatch remains deferred. A stale PID or
an elapsed lease timestamp alone cannot prove exit or authorize killing a reused
process. Restart recovery is an acceptance requirement, not a best-effort promise.

The proposed POSIX port records the process group, leader start time and daemon
generation before sending the first prompt. Only `ESRCH` from a process-group
probe proves absence. A still-live group may be signalled through the existing
termination ladder only when the leader's start time establishes ownership;
then recovery must again verify group absence. Missing ownership metadata,
permission errors, a reused PID, or a crash between spawning and recording the
child remain `recovery-required`. No signal is sent on an ambiguous match.
Windows needs its own process-ownership/reaping adapter; until then it reports
`recovery-required` for interrupted runs rather than simulating POSIX evidence.

An initial daemon integration may ship with all ambiguous interrupted runs
quarantined, leaving the ownership port to a separate reviewed change. Pausing,
unscheduling, updating the schedule or moving the soul cannot clear that
quarantine. Any later explicit owner recovery procedure must retain its evidence
and distinguish an owner attestation from runtime-verified child exit. Ordinary
confirmation alone must not be reported as verified process absence.

Active registration, daemon generation and dispatch leases belong to host-local
daemon state. Run facts and verified checkpoints belong to the soul's durable
history. Exporting/importing a soul carries its past, but does not silently
activate recurring work on another host. A new host requires explicit schedule
registration. Imported history is provenance only; it never drives catch-up or
restores a lease. This placement is a proposed resolution of ADR-0603's scheduler
question and must remain explicit in portability documentation.

## Eligible evidence and execution bounds

Each attempt captures the soul revision and a bounded inventory before launching
the agent. Eligible sources are the soul's current definition/learned skills,
memory sources exposed by existing authorized tools, and conversations actually
available to that soul through a supported reader. Execution facts from
`.soul-state/runs` are not conversation transcripts. Missing readers produce
explicit unsupported coverage; they cannot be replaced by reading arbitrary
host-wide harness stores or another soul's sessions.

The first implementation supports definition and learned-skill sources only,
verified against the soul revision and file digests. Memory-tool and conversation
adapters report `unsupported` until implemented. A conversation reader must use
the same verified store origin as its session; an unknown origin cannot be
guessed from a current environment override. These are explicit partial coverage,
not proof that every soul knowledge source was maintained.

`captureDreamInputs` implements the read-only capture boundary for format-2
packages. It uses the canonical package reader and hashing format, with limits
of 4096 visited entries, 16 MiB actually read across both inventory passes and
the initial manifest read, 1 MiB per file, and depth 32. It refuses larger or
unsafe packages; these are verification limits, separate from the smaller prompt
limits below. It hashes the captured snapshot and compares that hash with the
declared revision instead of trusting the manifest alone or reopening files.
The snapshot proves the captured package content, not owner approval of a revision
or immutability of the live directory after capture. Later outcome verification
must detect source drift again.

Only root `AGENTS.md`, `soul.md`/`SOUL.md` and eligible `skills/` files supply
text, reusing the profile's private-path filter. Manifest settings, generated
harness files, binary files and private working state do not supply prompt text.
The format-2 ignore contract keeps private working state out of revision reads;
legacy format-1 packages refuse maintenance capture. Text excerpts preserve
UTF-8 boundaries and retain the whole captured file's digest and size. Truncated
excerpts are explicit. Selection cursors are revision-bound pagination only;
they never assert successful processing or advance a maintenance checkpoint.
The host must pass the registered canonical soul directory. This internal reader
does not expose daemon controls or activate execution.

Inventory entries identify the source, revision/checksum or adapter cursor, and
why it was selected. Source content remains untrusted data. Credentials, runtime
caches, authorization records, host-private state and another soul's territory
are not eligible knowledge inputs. An adapter must enforce its own provider and
content boundaries rather than accepting arbitrary paths supplied by a model.

Proposed initial limits are a 10-minute wall-clock turn, 100 selected source
entries, 1 MiB total supplied text, 64 KiB per supplied source excerpt, and a
256 KiB outcome record. Selection is stable and resumes from a recorded cursor;
truncation is explicit. These limits bound the runtime's inventory/prompt/record,
not arbitrary content a permitted tool may read. They do not promise a token or
monetary budget unsupported by the harness. Tool execution retains the existing
policy and cancellation behavior.

Guide the agent to examine changed material progressively, consolidate useful
knowledge, check references, and use configured retrieval/graph capabilities
where appropriate. No embedding provider, graph backend or external service is
provisioned implicitly. Definition changes use normal revision proposals.
Deleting stale derived entries requires evidence that their source was removed
or superseded. Retiring durable source material requires an applicable retention
policy and the relevant revision authorization; otherwise record it as blocked.
Age and infrequent retrieval alone are not deletion evidence.

## Outcomes, checkpoints and notices

### Implemented input preparation receipts

Journal state version 2 adds bounded `inputReceipts` references for active runs
and each registration's latest run. A reference names the run, journal revision,
starting soul revision and metadata digest. The corresponding `inputs-prepared`
event retains the selected paths, kinds, digests, byte sizes, excerpt sizes,
truncation flags, selection counts and optional pagination cursor. Excerpts and
raw replies are excluded. The existing 100-source bound applies; serialized
metadata is additionally capped at 512 KiB. A receipt proves capture preparation,
not successful delivery, processing or maintenance coverage.

The host's execution port commits preparation synchronously before resolving
the runtime/provider or launching the harness. Duplicate or late preparation is
refused. An uncertain write freezes dispatch and retains the unfinished lease
for restart quarantine. Preparation references survive failed execution and
restart. References no longer needed by active/latest runs leave the current
state, while their append-only history events remain available through bounded
history pages. No source selection or processing checkpoint advances here.

Version 1 journals remain readable. The next scheduler transaction writes state
version 2 without rewriting historical records or their hash chain. Read-only
inspection does not migrate disk. Readers supporting only state version 1 must
be upgraded before opening a journal advanced by this implementation.

### Remaining outcome and checkpoint contract

Execution status and maintenance coverage are separate. A process can finish
successfully while some sources or capabilities remain blocked or unsupported.
Each run records IDs, start/end time, starting soul revision, schedule generation,
selection coverage, terminal execution state and bounded per-item outcomes:

| Field | Contract |
| --- | --- |
| Item identity | Source revision/checksum or adapter-owned stable locator; never a free-form claim of ownership. |
| Outcome | `completed`, `skipped` or `blocked`, with a bounded reason code. |
| Evidence | Existing revision/proposal ID, eligible file digest, or configured adapter receipt. |
| Verification | `runtime-verified`, `adapter-verified` or `agent-reported`, according to the actual checker. |
| Knowledge coverage | Explicit covered, unavailable and truncated sources/capabilities; unknown indexing stays unknown. |

An agent report must name the active run and starting revision. Reject malformed,
oversized, duplicate or wrong-run records. Verify file evidence against the
eligible root and exact bytes without following links outside it. Evidence for
an external operation remains agent-reported without a verifying adapter, even
when a local log file exists. Unstructured final text is retained only as an
explicitly unverified bounded report, not converted into successful outcomes.

The cold executor caps accumulated dream reply text at 256 KiB before any
outcome parsing. Hosts may request a smaller positive byte limit, but cannot
disable or raise the dream cap. `replyTruncated` reports omitted output; a
truncated prefix must never be accepted as a complete structured report. UTF-8
code points are not split. As with ordinary cold replies, a tool-call event
starts a new final-reply segment and resets its truncation flag. Ordinary wake
reply behavior is unchanged unless its caller explicitly requests a bound.

Checkpoint publication follows validation of the corresponding outcomes. Only
verified processed items advance their source cursors; missing/blocked entries
remain eligible on a later run. A cancelled or interrupted attempt must not
advance the entire inventory. Changes already committed through normal revision
or tool mechanisms are not rolled back by pretending that cancellation is a
transaction. Subsequent runs reconcile those changes from evidence.

The canonical host run record and its checkpoint publish atomically or through a
recoverable journal. The soul's existing history mirror remains best effort and
must not become the scheduler's recovery authority. Detailed evidence checkpoints
need their own versioned schema; do not place free-form prompts or outputs into
the current facts-only turn mirror. Records are append-only with bounded reads;
automatic pruning is deferred until a retention policy exists. Status must make
that disk-growth limitation visible.

No-change runs are quiet. Meaningful changes, failures and required user action
create a notice with a stable fingerprint of the condition and relevant source
revision/capability state. Run ID and timestamps are excluded from deduplication;
the same missing capability must not notify every interval. Recovery followed by
a later recurrence of the problem may create a new notice. An authorized host
can read and acknowledge notices through status. A configured delivery adapter
may deliver them, but delivery is recorded separately from notice creation.
Without that adapter, status says `pending-host-read`, not `delivered`.

## Implementation and verification gates

Ship incremental reviewed changes, each documenting its actual capability. A
pure scheduler or outcome schema alone does not implement the `dream` command.

1. Define persisted registration/run/checkpoint schemas, strict schedule parsing
   and a deterministic scheduler driven by injected clock/storage/executor ports.
   Test idempotence, registration generations, clock movement, one catch-up,
   paused/busy souls, unsettled cancellation, and dispatch refusal on bad state.
2. Integrate the daemon's owner control routes, configured cold executor and
   shared registry. Test the real authorization and factory path, cancellation,
   history kind, denial/approval, shutdown and orphan recovery. Do not replace
   these with a fake launcher and call it production parity. Verify that the
   optional cold-executor inputs leave existing wake history records unchanged.
3. Add bounded eligible-source selection, agent guidance, outcome validation and
   checkpoint recovery. Test missing transcript/tool support, source drift,
   malicious locators, forged/oversized outcomes and partial progress after abort.
4. Expose CLI controls and host notice consumption. Test no-change silence,
   repeated missing-capability deduplication, acknowledgments, delivery failure,
   and explicit re-registration after soul transfer.

The peer review of this contract settled host-local activation, quarantine when
child exit is unproven, and definition/learned-skill sources first. Changing
those boundaries reopens design review. If an adapter or notification consumer
is not implemented, report that coverage explicitly rather than declaring all
of ADR-0603 complete.

## Implemented scheduling core

`skill-dream-scheduler.mjs` implements the scheduling state machine through
injected ports. It has no default disk store, daemon registration, owner-control
route, recurring timer loop, source reader, maintenance prompt, checkpoint
publisher or notice consumer. The proposed CLI above is still unavailable.
Importing this module creates no job. A production adapter must authorize the
controls and supply the existing configured turn executor before exposing them.
The separately supplied POSIX journal below implements the storage port; the
scheduler still does not choose or create a default store.

The version-1 host-local state has a revision, at most 256 registrations and
at most 256 unsettled flights. A registration records the soul ID, canonical
directory, generation, interval, pause state, next due time and latest settled
execution. A flight records its run and daemon generation, original registration
and directory, trigger, start time, execution bound and cancellation state.
Strict validation refuses unknown schemas, extra fields, duplicate souls/runs,
invalid timestamps and inconsistent states. These are new records, not migrations
of existing soul or daemon stores. Checkpoint/evidence schemas remain later work.
A canonical directory cannot be assigned to different souls across registrations
and unsettled flights. The same soul may re-register at a new directory while its
old flight remains quarantined; another soul cannot claim that old directory
until the earlier flight settles.

The required synchronous store port reads a state snapshot and atomically commits
the replacement state **together with** its execution/control events against an
expected revision. It must retain those events in durable history before returning
true. State and event records must not be written independently by a future
adapter. A false, throwing or otherwise unconfirmed commit freezes dispatch on
that service instance. Only an explicit `null` read means absent state; undefined
or malformed reads refuse. An acknowledged state must also read back unchanged.
That check detects an observable bad acknowledgment, not history atomicity or
power-loss durability; those require the actual backend's integration tests.
No executor starts before the durable started event and
flight commit. Losing a completion receipt retains the flight; it cannot trigger
a retry of already executed work. The core unit tests use a JSON-round-tripped
atomic port fixture. The separate journal conformance tests below exercise real
filesystem publication and process interruption.

`tick()` performs one bounded pass when the daemon calls it; it does not install
a timer. `runNow()` returns a run handle whose `done` settles only after the
executor and completion persistence. `cancel()` requests abort without releasing
the slot. A failed completion reports `persistence-failed`. The host concurrency
bound defaults to one and accepts 1–16 through the internal port configuration;
one unsettled dream per soul remains mandatory regardless of that bound. The
per-turn deadline defaults to ten minutes and may only be lowered. The injected
deadline timer is independent of the wall clock used for due times and receipts.

After a service restart, stored flights block dispatch even before `recover()`
journals their quarantine. Recovery never probes or kills a process, clears an
unproven lease, or infers a task from imported history. Pause, unschedule and
re-registration preserve that independent flight. An old run may record its
actual settlement but cannot change a newer registration's due time or recreate
a removed registration. Daemon/owner integration and the remaining maintenance
gates still need their own implementation and validation.

## POSIX journal adapter

`skill-dream-store.mjs` supplies the synchronous state/history port for a local
POSIX filesystem. The host supplies an already-created, durably established,
canonical private directory owned by the current account. The adapter creates
no daemon state directory, grants no authority and registers no job. Windows is
explicitly unsupported by this adapter; it never skips directory synchronization
while claiming the same guarantees.

Each numbered version-1 transaction contains the complete validated scheduler
state, the corresponding bounded control/execution events, a previous-record
digest and its own checksum. It contains no prompt or executor output. The writer
creates a private unique temporary file, writes and fsyncs it, then publishes it
with a hard link to the fixed next-revision name. That link refuses an existing
name: concurrent writers cannot overwrite the same revision. Directory fsync
precedes acknowledgment. State and history are in the same record, so there is
no separate pointer or partially committed history to reconstruct.

Opening the store inventories a contiguous prefix of revision names; subsequent
reads track the head and inspect adjacent names for an unexpected writer rather
than rescanning all history. Reads validate the head and predecessor and fsync
the directory before using a recovered publication. An unexpected writer makes
the existing handle refuse; reopening through daemon recovery discovers the new
head. History validates records as they are paged, including their digest links.
Checksums detect corruption; they are not signatures or authorization evidence.
Status performs a fresh directory inventory. Historical bytes are validated when
read, not scanned in full on every scheduler action.

Reads refuse malformed, missing, gapped, oversized, public or symlink records.
They never silently roll back to an older state. Recognizable unpublished
temporary files are ignored and counted in status, not automatically removed;
more than 1,024 such files refuses the inventory. The directory holds at most
100,000 transactions (an internal host parameter may lower that limit), each at
most 8 MiB. A history page contains at most 16 transactions. At capacity, new
commits refuse and status reports `full`; there is no automatic pruning or
retention cleanup. An explicit archive/retention procedure remains future work.
The directory inventory at startup and status is bounded by those limits but
still grows with the number of transactions.

The reusable store conformance suite checks state/history pairing across reopen,
stale revision refusal and bounded history pages. The POSIX adapter tests kill a
separate writer after creation, partial/full write, file fsync, link publication
and directory fsync, then require a complete old or new pair after reopening.
Two competing processes also race the same revision and exactly one can publish.
These tests demonstrate process-interruption recovery, not physical power-loss
behavior. Node's `fsync` is not macOS `F_FULLFSYNC`; sudden power loss on macOS is
not guaranteed, and filesystem/hardware durability still depends on the host.
The production daemon integration must preserve this limitation explicitly.

## Revision evidence

`skill-dream-evidence.mjs` checks one journal reference (a `proposalId` or a
`revision`) against what a run was delivered: the starting revision and each
delivered source's path, full-content digest and truncation flag. It is
read-only and bounded. The newest journal index is found by probing names, not
by listing the directory. At most 256 newest records and 2 MiB are read, each a
regular single-link file of at most 64 KiB, opened without following links and
unchanged across the read. Both content-addressed packages are read with the
dream package limits and must hash to their object names.

A reference older than the scan window, or behind an unreadable record, reports
`search-incomplete`. The journal's extent is `proven` only when a bounded
inventory (at most 512 directory entries) finds record names exactly `0..N`.
A gap or a larger directory leaves it `unproven`. Only a whole scan of a proven
journal reports `reference-not-found`.
The result reports the validated record fields (never journal reasons or
approval text), whether its parent is the starting revision, both object states,
the recomputed change set, whether a proposal's recorded diff matches it, which
changed paths were not delivered, how delivered digests compare with the parent
bytes, which changed sources were delivered truncated, and whether the record
falls inside the run window when one is given.

`verified-change` requires all of the following:
- a soul-authored record whose parent is the starting revision;
- both objects verified;
- a non-empty change set within the bound and no recorded-diff mismatch;
- every changed path delivered with a digest matching the parent bytes;
- the run window, when supplied.

A proposal's reported status comes from newer records naming it inside the
scan. A record decides it only when it is a well-formed later approval (the
soul author, an approval kind, and the proposal's own revision and parent) or a
well-formed later user rejection. `pending` requires a proven journal. Any
other matching record, more than one decision, or an unproven journal gives
`uncertain`. Status is informational and never affects the verdict. A new file is never a delivered source, so a change that adds one is not
verified. Revision records carry no diff, so there is no cross-check for them;
the hash-verified objects stand alone. Truncated delivery is reported but never
blocks the verdict. A change is not proof that the full source was reviewed.
Attribution is always `not-established`: the journal shows a change was
recorded, not that a particular model turn read or produced it. This evidence
may advance review coverage only for the verified changed paths. Delivery alone
advances only the selection cursor.
