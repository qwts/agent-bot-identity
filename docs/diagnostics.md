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

Events of one operation share a W3C trace ID, so a launch can be followed
across processes. A trace ID only links events; it never identifies or
authorizes anyone.

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
