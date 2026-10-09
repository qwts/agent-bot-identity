# Dream maintenance implementation contract

Status: implementation proposal for #603, following
[ADR-0603 decision 11](decisions/ADR-0603-imported-skills-keep-local-snapshots-and-upstream-provenance.md).
This document adds no command, schedule, daemon job or owner authorization.
Names and limits below are proposed contracts to review before implementation;
they do not describe capabilities already shipped.

Dreaming is a bounded agent turn that maintains eligible knowledge using the
soul's existing tools and permissions. The runtime schedules the turn, records
what happened and prevents duplicate maintenance. It cannot infer that copying
a file indexed it, or that an old conversation is disposable.

## Reuse the daemon's execution mechanisms

There is currently no recurring task scheduler in this repository.
`task-turns.mjs` reports individual executions to the broker; it does not own
recurrence. Dream needs a small daemon-owned scheduling service, not a second
harness launcher or a fabricated broker task.

The service must use the daemon's configured executor factory, tool-home and
runtime resolution, soul identity, permission/approval policy, and shared turn
registry. `coldTurnExecutor` is the closest reusable execution boundary. Its
current input does not forward a caller's cancellation signal or turn kind;
an implementation must add those inputs with existing wake behavior as the
default. Add `dream` to the history kind vocabulary rather than recording a
maintenance run as an inbox wake. Do not invent an interaction-store invocation,
session, principal or broker task ID to acquire unrelated capabilities.

Registration and control use the existing owner settings authorization path.
A daemon bearer token alone is not proof of owner authority. Imported skill
text, a peer message, or an agent's proposed maintenance plan cannot register
a job or broaden permission. Registering a schedule authorizes execution under
the current policy; it does not preapprove later tool requests or revisions.

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

Timeout, cancellation and daemon shutdown request abort. The lease stays held
until the executor settles; an abort request is not evidence of process exit.
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

Before runtime implementation, peer review must resolve the host-local
activation boundary, orphan-process evidence and the exact source adapters to
ship first. If an adapter or notification consumer is not implemented, report
that coverage explicitly rather than declaring all of ADR-0603 complete.
