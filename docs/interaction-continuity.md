# Interaction session continuity

An ACP turn submitted through `/v1` uses the daemon's interaction session
(`session_<uuid>`) to find its prior native harness session. A new interaction
session starts a new harness session. A subsequent turn loads the binding
recorded by the latest bound invocation in that same interaction session,
using ACP `session/load` before sending the new prompt (#596).

The durable authority is the invocation event log's last `harness-session`
event. The lookup checks the current invocation against its stored record
and session, including soul, principal, and transport. It checks prior
records against the same ownership tuple. The soul's last observed launch
or cold-wake session does not replace this binding. No interaction session
is inferred for a cold/launch turn that has no `/v1` session ID.

The daemon supplies its job store's environment and home explicitly; the
harness's routed tool home or provider environment does not choose which
interaction store to read. Reconstructing the daemon's executor factory
therefore preserves the association, provided the job store and the
harness's native session history are retained.

## Failures are explicit

A continuation never silently becomes an empty new conversation. A refused
continuation fails the invocation and records a secret-free `continuity`
event, visible through the normal invocation event endpoint:

```json
{"status":"unavailable","reason":"native-resume-unsupported"}
```

Reasons are:

| Reason | Meaning and next step |
| --- | --- |
| `session-busy` | Another invocation in this interaction session is still queued, running, awaiting approval, or cancelling. Wait for it to stop before submitting the next turn. Other sessions remain independent. |
| `harness-changed` | The latest binding belongs to another harness. Continue with that harness, or explicitly create a new interaction session. No cross-harness transcript conversion is implemented. |
| `binding-unavailable` | A completed prior turn recorded no native binding. An ACP continuation cannot assume that turn's facts were loaded. |
| `native-resume-unsupported` | The adapter did not advertise ACP `loadSession`. Use a supported adapter or explicitly start a new interaction session. |
| `native-resume-failed` | The adapter failed to load its prior session. Restore the native history or resolve the adapter failure before retrying. |

The public job error remains the existing fixed `job execution failed`;
provider exception text stays in the daemon log. A rejected turn without a
binding does not replace the previous binding, so fixing the condition can
resume the earlier conversation. Cancelled or failed turns that did bind
retain that association: their native history may include partial work.
A cancel request is not treated as a stopped executor.

Model selection is applied to a loaded session using the existing engine
model-selection contract. Changing the harness is a different operation
and is explicitly unsupported within an existing interaction session.

## Clearing the last setting starts a new session

Each ACP turn records the model and reasoning effort it ran with in a
secret-free `harness-settings` event next to its binding. A loaded native
session keeps the model and effort it last ran, and nothing can be sent that
returns it to the harness default. So when the prior turn ran with a model or
effort and this turn has none, because the owner cleared the last setting
that named one, the turn starts a new native session on the harness default
instead of loading the old one (#379, the owner's choice). It is announced,
never silent: the turn records

```json
{"status":"fresh","reason":"setting-cleared","previousHarnessSessionId":"…"}
```

and its prompt begins with a line telling the agent its previous session was
kept but not resumed. The old session is kept: its binding stays in its own
turn's event log and its native history is not deleted. Later turns resume the
new session. Changing a setting to another value, or a turn recorded before
settings were kept, resumes as before.

## Evidence and limits

`tests/interaction-continuity.test.mjs` drives the production factory and
interaction service through a disposable ACP fixture with native history
on disk. It verifies distinctive decision and teammate facts on the next
turn, after factory/service reconstruction, after an unrelated cold turn,
after model selection changes, and after cancellation. Separate sessions,
principals and souls do not inherit those facts. It also checks ownership
mismatches, concurrent turns, missing bindings, unsupported load and failed
load. The fixture asserts both native session bindings and emitted answers;
it makes no live-model claim.

This is one path in #596. It does not prove live GeniusBar restart/reopen,
CLI-to-UI transcript reconstruction, or relocation of the interaction store
into the soul's persistent environment. The agent-comms relay uses its own
bounded thread context and is not a `/v1` interaction session. Those paths
and the remaining live acceptance stay tracked by #596 and #583.
