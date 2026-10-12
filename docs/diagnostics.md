# Diagnostics

Local-first engine diagnostics ([ADR-0983](decisions/ADR-0983-local-first-diagnostics-and-optional-otlp-export.md), #983).
Nothing here leaves the machine unless you send it.

```sh
agent-bot diagnostics export --preview                  # print the bundle; write nothing
agent-bot diagnostics export --since -PT6H --output diag.json
```

## What is recorded

The daemon records each launch: a `launch-stage` event as each stage
completes, and a `launch` event with the outcome, the stage it stopped at,
the stable code and the duration. `ok` is a launch that started, `refused`
an expected refusal (the owner's choice, a policy or this host's setup, such
as `harness-signed-out`), and `failed` a fault. Codes are listed in
`governance/error-codes.json` and never change meaning.

Each wake the broker sends is recorded as one `wake` event whose stage is the
path it took: `warm` (a listening session took it), `cold` (a cold turn
started), `merged` (it joined a cold turn already running) or `waiting`. A
paused soul (`wake-paused`) or cold wake being off (`wake-cold-off`) is an
expected refusal; a warm or cold path that failed, or a report the broker did
not take, is `failed`. A wake that carries an exact version-00 `traceparent`
continues that trace; otherwise it starts its own. Daemon starts and
shutdowns, harness turns, approvals and credential refreshes are recorded
the same way.

Events of one operation share a W3C trace ID, so a launch can be followed
across processes. Trace and span IDs are untrusted correlation IDs: they only
link events and never identify, authenticate or authorize anyone. A launch
continues a principal's trace when its `event:launch` carries an exact
version-00 `traceparent` (55 characters, lowercase hex, nonzero IDs, the same
grammar the broker forwards) (principal launches only, inbound only; the broker forwards it
unchanged once agent-comms supports it), and starts its own otherwise. They
are never put in a prompt or a security receipt.

Storing these IDs is still metadata exposure, even locally: they show when
operations happened, how long they took and which ones belong together, to
anyone who can read the store or a bundle exported from it, and to the
collector when OTLP export is on.

Each event keeps only these fields: schema version, time, event ID,
component, agent-bot version, event, stage, outcome, code, duration, trace
and span IDs, a hash of the agent ID, and a redacted one-line detail. No
message content, prompt, tool argument, environment, credential or path under
a home directory is stored.

## Where and how long

Events live in `~/.local/state/agent-bot/diagnostics/` (mode 0700, files
0600). `events.jsonl` rotates into `events.1.jsonl` before it reaches 5 MB, so
at most about 10 MB is kept, and nothing older than 7 days. If an event
cannot be written, the work goes on; the next event written records how many
were dropped.

## Export

`export` reads the store, checks every field again, redacts `detail` again and
writes one JSON bundle: the agent-bot version, platform, architecture and
Node version, a summary of outcomes, codes and components, and the events in
the window. `--since` takes an ISO-8601 time or a negative duration such as
`-P1D` (the default) or `-PT6H`, and never reaches past retention.
`--output` creates a new 0600 file and refuses to replace one; `--preview`
prints the bundle to stdout and the note to stderr. Export never uploads and
never opens an issue: attach the file yourself when you report a problem.

## OpenTelemetry export (optional, off by default)

The daemon can send diagnostics to an OpenTelemetry collector over OTLP/HTTP
JSON. Nothing is sent unless the agent-bot config names an endpoint; ambient
`OTEL_*` variables never turn it on.

```json
{ "settings": { "diagnosticsOtlpEndpoint": "http://localhost:4318" } }
```

The endpoint must be `https`, or `http` to `localhost`, `127.0.0.1` or
`[::1]`, with no user name, password, query or fragment; anything else fails
the config load. The exporter posts to `<endpoint>/v1/traces` and
`<endpoint>/v1/metrics`. A collector that needs a key gets it from the
daemon's environment, never from the config file:

```sh
AGENT_BOT_OTLP_HEADERS='x-api-key=YOUR_KEY'   # name=value,name=value; values may be %-encoded
```

Restart the daemon after changing either. What is sent:

- **Traces.** Each finished launch is a span named `launch`, with its trace,
  span and parent IDs, start and end time, status (`ERROR` only for
  `failed`) and the attributes `agent_bot.component`, `agent_bot.outcome`,
  `agent_bot.stage`, `agent_bot.code`, `agent_bot.agent_hash` and
  `agent_bot.duration_ms`. Its stages are span events with the stage and
  duration.
- **Metrics.** `agent_bot.operations`, a cumulative count of finished
  operations by component, operation, outcome and code (at most 256
  combinations), and `agent_bot.export.dropped`.
- **Resource.** `service.name=agent-bot`, `service.version` and `os.type`.

The redacted `detail`, Agent IDs, paths, messages, prompts, environment and
credentials are never sent. The exporter is bounded (512 queued spans,
batches of 128, a 5-second timeout, one retry for a network error, 429 or
5xx) and drops rather than waits; `agent_bot.export.dropped` counts what it
dropped. A collector that is down or misconfigured never changes a launch or
the local store.

To try it locally, run any OTLP/HTTP collector on port 4318 (for example the
OpenTelemetry Collector with its `otlp` receiver's `http` protocol and a
`debug` exporter), set the endpoint above, and launch a soul.

