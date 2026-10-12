# Cold-wake local storage core

Cold-wake setting and webhook changes use one synchronous critical section.
Existing owner gates remain at the command and daemon entry points; storage
functions perform local mechanism work and provide no authorization callback.
This slice does not enable agent-comms owner decisions or supply request-linked
effect evidence, durable consumption, quarantine or recovery.

`cold-wake-lock.mjs` owns only the shared settings path and lock mechanism. Its
short-lived context proves a helper runs inside that synchronous section. It
reads no settings or credentials. `wake-webhook-store.mjs` remains comms-owned:
its internal helpers require that active context, then acquire the selected
soul's webhook lock. Public webhook save/read/remove functions acquire the
same settings lock first. The lock order is always settings then webhook;
no network operation or await occurs under either lock. Internal callbacks must
be synchronous: the thenable check diagnoses misuse after invocation and is not
a sandbox for arbitrary callbacks. Live holders are never reclaimed on age
alone. A finite lock timeout refuses with a fixed label containing no webhook
URL or key. Public reads now create missing state directories and transient
locks; their no-state results remain empty settings/null webhook.

Soul's `setColdWake` publishes its setting and removes an obsolete webhook
before releasing the common lock. `setColdWakeWebhook` validates the existing
HTTPS/credential rules, stores the secret and publishes webhook mode in that
section. The CLI performs its existing owner gate once before calling either
entry. Existing standalone `saveWebhook` remains a secret-only writer.

`readColdWakeSettings` reads under the shared lock. The selected-soul
`readColdWakeSnapshot` returns one setting and, only for webhook mode, its
configuration under settings then webhook locks. The owner command displays
only the existing host summary. The daemon captures this snapshot before its
asynchronous binding lookup and gives that configuration to its webhook waker;
it does not select a later secret for an earlier lane. This is selection-time
coherence: an off or replacement after the snapshot lock is released cannot
cancel an already selected outbound request. JSON show remains setting-only
and does not read the secret. The trusted in-process
composition already had access to `readWebhook`; no secret enters a broker
response, tool result, audit receipt, log or child-process argument. Standalone
webhook wakers retain their existing injected reader behavior.

Each replacement writes a private exclusive temporary file, flushes its data,
renames it and flushes the required directory entries on POSIX. Newly created
state directories are flushed through their existing ancestor. Secret deletion
flushes the webhook directory. Windows retains its existing local filesystem
semantics without a POSIX directory-durability claim. Settings stay mode 0600,
and the webhook directory/file stay 0700/0600.

Two files are **not crash-atomic**. A crash or error between publications can
leave a setting and secret partially changed; locks only guarantee coherent
snapshots while participating processes are alive. A write/removal/flush failure
never returns composite success. Failure after publication, or after the first
of the two changes, has fixed code `cold-wake-publication-uncertain` and directs
the owner to inspect state before retrying. An earlier write failure has
`cold-wake-storage-failed`; failed audit append after persisted changes has
`cold-wake-audit-failed`. Errors do not echo webhook values. The future reviewed
owner-decision journal must separately mark entry, retain uncertain evidence and
quarantine automatic retries; this local core makes no such recovery claim.

Focused tests cover existing owner gates and output, cross-process readers
blocked between each composite publication, escaped lock-context rejection,
selected configuration across an asynchronous binding race and file/directory
flush failures before and after publication. Child race tests have bounded
output, finite deadlines and awaited cleanup on failure.
