# Dream maintenance implementation contract

Status: staged implementation contract for #603, following
[ADR-0603 decision 11](decisions/ADR-0603-imported-skills-keep-local-snapshots-and-upstream-provenance.md).
The scheduler, journal, bounded inputs, daemon service, CLI, durable reported
outcomes and selection checkpoints are implemented. Processing checkpoints and
notices remain incomplete;
their requirements below remain proposed contracts.
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
its audit receipt does not certify a completed maintenance run. If the outcome
append fails after the control executes, the API and CLI preserve the returned
result (or original control error) and separately report
`audit: { status: "unconfirmed", code: "dream-control-audit-unconfirmed" }`.
A started run therefore keeps its successful control response and CLI exit 0;
missing audit confirmation is not permission to retry it. Deferred controls keep
their existing exit behavior. Inspect run status before retrying an uncertain
request. Failure to append the earlier authorization receipt still prevents the
control from executing. Raw audit filesystem exceptions are not exposed as
outcome diagnostics.

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
runtime/provider resolution. Bounded outcomes publish with terminal run facts.
Raw replies are not stored as verified evidence, no processing checkpoints advance,
and no maintenance-success notice is claimed. Notice support remains subsequent
acceptance work.
Input preparation failures appear as bounded, content-free codes in status
diagnostics (for example `dream-input-limit`, `dream-input-unavailable` or
`dream-input-drift`). These diagnostics explicitly last only for this daemon
process; they are not durable outcome records and clear after successful capture.

## Schedule and controls

One registration exists per soul on the current host, bound to its agent ID and
canonical soul directory. Dispatch rechecks that binding against the population;
a copied or moved directory does not inherit activation. The CLI is:

```text
agent-bot soul skill dream --soul SOUL --schedule PT24H
agent-bot soul skill dream --soul SOUL --status
agent-bot soul skill dream --soul SOUL --history [--after-revision N] [--limit N]
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
shared registry. The CLI cancels a run only after current status shows it
belongs to the named soul, because the route names the run alone. Status distinguishes cancellation requested from settled.
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

`cli/soul-dream.mjs` is a thin client of the daemon routes above. `SOUL` is an
agent ID or census name. Controls send `--principal-stdin` to the daemon, which
performs the owner verification; a caller with soul markers is refused before
any request. Without a running daemon every action fails with
`dream-daemon-unavailable`; nothing runs in process. Status and history show
only the named soul's registration, runs, input receipts and events, and always
carry `maintenanceCoverage: unverified`. Output is JSON, compact with `--json`
and indented otherwise. A deferred run-now, or a cancel that requests nothing,
exits 1. Daemon error responses forward `dream-*` codes as well as `soul-paused`
and owner credential codes, so `--json` failures name them. Other failures
report the daemon's message under `dream-failed`. Status filters every
run-keyed `*Receipts` list, so receipt kinds from later state versions stay
per-soul without a client change. It keeps the service lifecycle (`started`,
`closing`, orphan recovery), the journal's capacity and no-pruning facts, and
this soul's input-preparation diagnostics, because a capture failure has no
other record. Other souls' diagnostic rows are dropped.

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

Journal state version 2 introduced bounded `inputReceipts` references for active runs
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

Version 1, 2 and 3 journals remain readable. The next scheduler transaction writes
state version 4 without rewriting historical records or their hash chain.
Read-only inspection does not migrate disk. Older readers must be upgraded before
opening a journal advanced by this implementation.

### Implemented reported outcomes

The final reply must be one JSON object with `schemaVersion: 1`, the active
`runId`, its `startingRevision`, and `items`. Each item names a captured `path`
and `digest`, an `outcome` of `completed`, `skipped` or `blocked`, a short
lowercase hyphenated `reason` code, and `evidence`. Evidence is null, a
`{proposalId}` or `{revision}` reference, a captured-source `{digest}`, or an
unverified `{adapter, receipt}` claim. Unknown fields, duplicate items, wrong
runs/revisions and sources outside the captured inventory invalidate the report.
Missing items are counted as unreported; they do not become completed or skipped.

Every maintenance claim remains `agent-reported`. A matched captured digest
establishes `source-identity` only. At most four distinct revision references
are checked, with repeated references sharing one result. The daemon uses its
own identity-state root and the bounded revision verifier. A `verified-change`
result must include the particular item's path; a reference that changes only
another source does not verify that item's evidence. Records retain the artifact
revision and proposal status (including pending, rejected and uncertain), with
`attribution: not-established`. This does not prove adoption, semantic review,
indexing or causation by the run. No external adapter is provisioned or queried.

Truncated replies cannot become complete structured reports, even if the prefix
parses as JSON. Invalid, unstructured and truncated replies retain only a bounded
untrusted display preview, capped at 64 KiB including JSON escaping. Structured
outcomes retain normalized claims and check facts without duplicating the raw
reply. Every complete outcome is capped at 256 KiB. Provider exceptions retain
an `execution-failed` code without provider error text. Preparation failures
before a source revision is known still have execution facts and process-local
diagnostics, but no fabricated outcome record.

State version 3 adds `outcomeReceipts` references for latest registered runs.
The `outcome-recorded` event and its terminal `ended` event publish atomically
in one journal transaction. Staging an outcome in memory is not a durability
acknowledgment. Uncertain publication retains the lease in the running process;
restart sees either the unfinished flight or the complete terminal/outcome
transaction. Unscheduling removes current references, not append-only history.
All outcome records state `processingCoverage: unverified`. Selection rotation is
implemented below; processing checkpoints and notice deduplication remain incomplete.

### Implemented selection checkpoints

Each registration may retain one version-1 selection checkpoint in scheduler
state version 4. It names the soul, current registration generation, successful
run, journal revision, source revision, exact input preparation receipt/digest
and next selection cursor. Its `coverage` is `selection-only` and its
`processingCoverage` is `unverified`. It proves which page comes next, not that
any source was delivered, examined or processed.

The checkpoint advances only when the executor settles successfully without a
cancellation request and its report is structurally valid. The checkpoint,
terminal run and outcome publish in one transaction. Failed, interrupted,
truncated or unstructured attempts preserve the previous checkpoint. Even a
valid report with zero items can advance selection: all those items remain
unreported, and no processing credit is assigned. Missing or blocked items are
never removed from eligibility; after the last page the cursor wraps to the
start. Truncated source tails still have unknown coverage. Semantic processing
checkpoints require a trusted operation-specific verifier and are not implemented.

Before capture, the daemon reads the exact preparation transaction through a
bounded one-record history query and checks its receipt and next cursor against
the checkpoint. A mismatch refuses launch with `dream-selection-invalid` instead
of trusting a structurally valid cursor. To recover from `dream-selection-invalid`,
the owner can unschedule and explicitly re-register the same soul and schedule;
this resets current selection while preserving journal history. The bounded source reader resets to the
first page if the package revision changed. Pause and schedule changes retain
selection for the same directory and bind it to the new registration generation;
an older generation's completion cannot advance it. Unscheduling removes current
selection state while preserving its append-only events. One unsettled run per
soul prevents manual and scheduled execution from racing checkpoint publication.

Status exposes the selected soul's checkpoint even when a newer failed run is
now its latest execution. Versions 1–3 remain readable without disk changes;
the next write adds v4 state, leaving historical bytes and hash chains unchanged.
Readers must be upgraded before opening a v4 journal.

### Implemented notice derivation

`skill-dream-notices.mjs` derives deduplicated notices from one terminal run
and its validated outcome. It is pure: it holds no state, reads no clock and
delivers nothing. It is not yet wired into the scheduler journal, daemon status
or CLI, so no notice is produced by a running daemon.

A fingerprint is the SHA-256 of the soul ID, notice kind and a fixed subject;
run IDs, timestamps and agent-chosen reason codes are excluded. Kinds and their
subjects are:

| Kind | Subject | Claim | Cleared when |
| --- | --- | --- | --- |
| `execution` | none | host-observed | a later completed run (a cancelled run proves nothing) |
| `report` | none | host-observed | a later structured report, even an empty one |
| `evidence` | none | host-observed | a later structured report whose revision check ran |
| `item-blocked` | path and captured digest | agent-reported | a later structured report names that path, supplied untruncated |
| `capability` | none (no adapter is configurable yet) | host-observed | never by a quiet run; host capability state changes it |
| `change` | artifact revision | unattributed-change | never; one notice per verified revision |

A persisting condition renews its single live notice (`occurrences`,
`lastRunId`, latest `detail`) instead of notifying every interval. An
acknowledged condition stays deduplicated. A recurrence after an observed clear
creates a new notice. A pending proposal is reported as `proposal-pending`,
which is the owner's action. A change notice inherits the outcome's
`attribution: not-established`: the artifact changed the source, but the run is
not shown to have caused it. Runs are applied in journal order; replaying the
latest run is idempotent.

Each soul keeps at most 64 notices and each run contributes at most 32
conditions. Retention drops only cleared notices, oldest first, so a live
condition, even an acknowledged one, is never re-notified by eviction. When the
ledger is full of live notices, a new execution, report or evidence failure
displaces the oldest agent-reported blocked item, acknowledged ones first, so
agent claims cannot hide an owner-visible failure. Anything else dropped increments a visible
`suppressed` count. Delivery is `pending-host-read` until an authorized
host acknowledges the notice, then `host-acknowledged`; nothing is ever marked
`delivered` without a delivery adapter.

### Remaining checkpoint and notice contract

Execution status and maintenance coverage are separate. A process can finish
successfully while some sources or capabilities remain blocked or unsupported.
Each run records IDs, start/end time, starting soul revision, schedule generation,
selection coverage, terminal execution state and bounded per-item outcomes:

| Field | Contract |
| --- | --- |
| Item identity | Source revision/checksum or adapter-owned stable locator; never a free-form claim of ownership. |
| Outcome | `completed`, `skipped` or `blocked`, with a bounded reason code. |
| Evidence | Existing revision/proposal ID, eligible file digest, or configured adapter receipt. |
| Verification | Claims remain `agent-reported`; source identity and verified artifact changes are separate evidence. Adapter verification requires a configured checker. |
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
verified processed items may advance future processing cursors; missing/blocked entries
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
route, recurring timer loop, source reader or maintenance prompt. It commits
input receipts, reported outcomes and selection checkpoints through the storage
port. The daemon service and CLI above provide authorization and composition.
Importing this module creates no job.
The separately supplied POSIX journal below implements the storage port; the
scheduler still does not choose or create a default store.

The host-local state has a revision, at most 256 registrations and
at most 256 unsettled flights. A registration records the soul ID, canonical
directory, generation, interval, pause state, next due time and latest settled
execution. A flight records its run and daemon generation, original registration
and directory, trigger, start time, execution bound and cancellation state.
Strict validation refuses unknown schemas, extra fields, duplicate souls/runs,
invalid timestamps and inconsistent states. State v2 added input receipt
references, v3 added outcome references, and v4 adds bounded selection checkpoints.
These records belong to the dream journal; existing soul and daemon stores are
not rewritten. Semantic processing and notice schemas remain later work.
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
a removed registration. Daemon/owner integration is implemented above; remaining
maintenance and notice gates still need their own implementation and validation.

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
well-formed later user rejection. Any other matching record or more than one
decision gives `uncertain`. Every status in an unproven journal is
`uncertain`, because an unscanned newer record could change it. Status is informational and never affects the verdict. A new file is never a delivered source, so a change that adds one is not
verified. Revision records carry no diff, so there is no cross-check for them;
the hash-verified objects stand alone. Truncated delivery is reported but never
blocks the verdict. A change is not proof that the full source was reviewed.
Attribution is always `not-established`: the journal shows a change was
recorded, not that a particular model turn read or produced it. This evidence
may advance review coverage only for the verified changed paths. Delivery alone
advances only the selection cursor.
