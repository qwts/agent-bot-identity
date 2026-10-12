# ADR-0983: Local-first diagnostics, stable error codes and optional OTLP export

**Status:** Accepted (2026-10-12; the owner's choices of 2026-10-11 as relayed by the coordinating agent, record merged in #997, implemented in #991, #999, #1000, #1001, #1002, #1004 and #1005)
**Date:** 2026-10-11
**Issue:** [qwts/agent-bot-identity#983](https://github.com/qwts/agent-bot-identity/issues/983)

## Context

Launch, refresh and harness failures span the daemon, the CLI, the harness
processes and the host (GeniusBar). Today the evidence is scattered: the
launch journal keeps a stage and a code, `agent-bot metrics` keeps token
observations, the audit JSONL keeps receipts, and the rest goes to stderr or
launchd's `daemon.log`. Nothing ties one operation together across processes,
and free-text messages can carry paths under the home directory
([#991](https://github.com/qwts/agent-bot-identity/pull/991) fixed one such
leak in `metrics`).

[#983](https://github.com/qwts/agent-bot-identity/issues/983) asks for
local-first, bounded diagnostics with stable codes and correlation, plus an
optional OpenTelemetry-compatible export that is off by default. The
repository has zero npm dependencies. The owner chose option A on each of
the six questions below.

## Decision

1. **Local store.** Diagnostic events are appended as JSON lines to
   `~/.local/state/agent-bot/diagnostics/` (the state directory's sibling,
   like `metrics/`): the directory is 0700 and the files 0600. The live file
   rotates at 5 MB into one previous generation, so at most two files and
   10 MB exist. Events older than 7 days are deleted at rotation and ignored
   on read. Writing never blocks or fails the operation it describes. A
   write that cannot be made is counted, and the count is recorded as a
   `diagnostics-dropped` event on the next write that succeeds.
2. **Error codes.** Stable codes live in
   [`governance/error-codes.json`](../../governance/error-codes.json),
   versioned (`schema_version`) and add-only. Each code has a sequence
   number, the component that raises it, a kind (`refusal` for an expected
   owner, policy or environment refusal, `failure` for a defect or fault),
   the agent-bot version it was registered in and a one-line summary. Codes are never
   removed, renumbered or re-kinded; a retired code is marked `deprecated`.
   `tests/error-codes.test.mjs` enforces the shape, the numbering and that
   every launch code the daemon emits is registered.
3. **Export implementation.** Export is a hand-written OTLP/HTTP JSON
   exporter in this repository, using only Node built-ins (`fetch`). No
   OpenTelemetry SDK, and no reusable module initializes a global exporter.
4. **What leaves the machine.** Export is off by default and needs explicit
   agent-bot configuration of an endpoint; ambient `OTEL_*` variables alone
   never enable it. When on, an exported span or metric carries only: the
   code, the stage, the duration, the outcome, the component and build
   versions, the trace and span IDs, and a hashed agent ID. The hash is the
   first 16 hex characters of SHA-256 over `agent-bot-diagnostics:v1:` and
   the Agent ID, so the same soul correlates across machines without its ID
   being sent. Messages, details, paths, environment, prompts, tool
   arguments, message bodies and credentials are never exported, even
   redacted. Export is bounded (queue, batch, timeout and retry limits), drops
   rather than waits, counts what it drops, and never changes a task or
   security result.
5. **Inspection and export by the user.**
   `agent-bot diagnostics export --since <ISO-8601|-P1D> [--preview]`
   writes a local bundle (version and status summary plus the redacted
   events in the window) to a file the user names, or with `--preview`
   prints what would be written. It never uploads and never opens an issue.
6. **Correlation.** Operations carry a W3C Trace Context `traceparent`
   (`00-<32 hex trace id>-<16 hex span id>-<flags>`). It links events and
   nothing else: a propagated `traceparent` is never identity, authorization
   or evidence of a caller, and a malformed one is replaced, not trusted. It
   is designed to cross machines later under the agent-net epic
   ([qwts/qwts-agent-org#46](https://github.com/qwts/qwts-agent-org/issues/46))
   with the same rule. The first wire contract, agreed with agent-comms
   ([qwts/agent-comms#164](https://github.com/qwts/agent-comms/issues/164))
   on 2026-10-12, is narrow: principal launch only, inbound only. A principal
   may set an optional `traceparent` on `op:launch`; the broker forwards it
   unchanged on `event:launch`, and the daemon makes its launch span a child
   of it. Nothing is echoed on `launch-progress` or `launch-result`, mailbox
   wake carries none, and sender authorization does not change. These are
   untrusted correlation IDs, kept out of prompts and security receipts.

The event record (schema version 1) has these fields, all optional except
`v`, `at`, `component` and `event`: `v`, `at`, `id` (random event ID, for
deduplication), `component`, `version`, `event`, `stage`, `outcome`
(`ok`, `refused`, `failed`), `code`, `durationMs`, `traceId`, `spanId`,
`parentSpanId`, `agent` (the hash above) and `detail` (redacted through
`diagnostic-redact.mjs`, local only). Audit receipts, the launch journal and
lifecycle records stay where they are and are not replaced by diagnostics.

## Consequences

- One bounded place answers "what happened, where, and which version" for a
  standalone launch or refresh failure, without GeniusBar.
- The store, the registry and the CLI are public contracts from now on:
  changes follow the versioning above.
- A hand-written exporter covers only the OTLP subset we emit (spans and a few
  counters over HTTP JSON). Features such as gRPC, compression or
  auto-instrumentation are not available, and keeping the subset correct is
  ours to test.
- The unsalted agent hash is linkable by anyone who already knows an Agent
  ID. That is accepted so a soul correlates across machines; the ID itself is
  never sent.
- The add-only rule for codes is checked against the base branch where git
  history is available (locally) and by numbering everywhere; CI's shallow
  checkout relies on the numbering check and on review.
- Implementation lands in small PRs under #983, in this order: this record
  and the registry; the store and `traceparent` helper; redaction of existing
  outputs; launch, refresh and shutdown events; the export command; the OTLP
  exporter.
