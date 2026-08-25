# Spike: ACP session in the harness vs CLI-only

Parent: ZTS-30 (Linear). This is the working issue for the spike. Throwaway
proof — no production runner lands from this.

## Question

Can the agent-bot identity daemon start a session inside a real harness over
ACP, or does ACP only work by spawning a CLI?

## What was probed (2026-08-24, macOS, host MacStudioM2)

| Binary | Version | ACP entrypoint | Result |
|---|---|---|---|
| `claude` | 2.1.233 | none found | No `acp` subcommand; bare stdio gets no JSON-RPC response. Claude Code's ACP story is via the separate `zed-industries/claude-code-acp` adapter, not built in. |
| `codex` | 0.147.0 | `codex app-server` | **Works** — but it is NOT ACP. It is Codex's own JSON-RPC dialect over stdio (`initialize` with `clientInfo`, then `thread/start`, `turn/start`). |
| `devin` | (Cognition CLI) | `devin acp` | **Genuine ACP over stdio.** Full handshake succeeded: `initialize` → `session/new` → `session/prompt`. Session created (`sessionId: iodized-sandalwood`), turn failed only on auth (`auth_required`, not logged in). Protocol-wise fully compliant. |
| `muse` | 0.2.1 | none found | No ACP subcommand in help. |
| `opencode` | — | unverified | Started a TUI on stdio; no ACP response to initialize. |

### Proof 1 — Devin, true ACP (daemon-side spawn)

```
spawn("devin", ["acp"]) with stdio pipes
→ {"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":1,...}}
← id=1 result: protocolVersion 1, agentCapabilities {loadSession:true, promptCapabilities:{image:true,...}}
→ session/new {cwd:"/tmp", mcpServers:[]}
← id=2 result: sessionId "iodized-sandalwood", modes [...]
→ session/prompt {sessionId, prompt:[{type:"text",...}]}
← error -32000 "Authentication failed: Please authenticate to continue."
   + event _cognition.ai/agent_stopped {cause:"auth_required"}
```

The ACP layer itself works end-to-end from a plain child process with pipes —
exactly what the daemon executor plug would do. The only blocker is Devin
account auth, which is interactive (`devin auth login`, browser or manual token
paste). That is an environment problem, not a protocol problem.

### Proof 2 — Codex app-server (JSON-RPC but NOT ACP)

```
spawn("codex", ["app-server"])
→ initialize {clientInfo:{name:"spike-daemon"}}
← result {userAgent:"spike-daemon/0.147.0 ..."}
→ thread/start {}
← thread.id "01a036b3-fefc-..."
→ turn/start {threadId, input:[{type:"text",text:"Reply with exactly: ACP-SPIKE-OK"}]}
← item/completed agentMessage containing "ACP-SPIKE-OK"
← turn/completed
```

A full authenticated agent turn completed from a headless child process.
Method names (`thread/start`, `turn/start`, `item/*`) are Codex-specific, not
the ACP method set (`session/new`, `session/prompt`, `session/update`).

### Proof 3 — Desktop harnesses (the decisive finding)

**Devin.app (desktop) — ACP sessions ARE the harness session, but the agent is
a spawned child process.**

Live process tree on this machine while Devin.app was running:

```
PID 28304 (PPID 1)      /Applications/Devin.app/Contents/MacOS/Devin   ← the app
└─ PID 78063            Devin Helper (Plugin)  (node extension host)
   ├─ PID 84000         .../extensions/windsurf/devin/bin/devin acp          ← ACP agent sidecar
   └─ PID 84030         .../extensions/windsurf/devin/bin/devin acp --agent-type summarizer
```

The desktop app's own bundle ships `@exa/windsurf-acp` (an ACP client library:
`session/new`, `session/prompt`, `session/update`, `session/load`, and
`resolveAgentCommand` that resolves `npx` / `uvx` / per-OS `binary` command
specs). The workbench state models sessions as `{kind:"acp", sessionId}` vs
`{kind:"cascade"}`. So the "harness session" is: app spawns the same `devin
acp` binary we spawned in Proof 1, over ndjson stdio, as a child of its
extension host. There is no separate in-process agent and no attachable
external endpoint.

The app also listens on `~/Library/Application Support/Devin/1.12-main.sock`,
but it is not ACP: an ACP `initialize` and an HTTP probe both get silence.
It is internal app IPC, unreachable for third-party session starts.

**Claude.app (desktop)** — no ACP anywhere. Its local agent sessions are the
Claude Code binary run with `--input-format stream-json --output-format
stream-json` (its own streaming protocol, not ACP), spawned per session from
`~/Library/Application Support/Claude/claude-code/<ver>/claude`. No ACP
strings in the binary or app bundle; no attachable ACP endpoint.

**Cursor.app** — no native ACP host. The only `acp` hits in the workbench
bundle are a telemetry bucket name (`agent_acp`) and minified class names;
zero occurrences of `session/new` / `session/prompt` / `agent-client-protocol`.
Its agent extensions (`cursor-agent-host`, `cursor-local-agent-runtime`) are
Cursor-proprietary. Same story for VS Code generally: no built-in ACP client.

## Answer

**Mixed by harness — and the honest summary is: ACP always works by spawning
an agent process; what varies is who does the spawning.**

1. **Daemon-side spawn works.** A tiny plug that spawns binaries with pipes
   can open real sessions today. Devin speaks genuine ACP over stdio
   (`initialize` → `session/new` → `session/prompt`; blocked only on
   interactive account auth). Codex speaks its own JSON-RPC (`codex
   app-server`: `thread/start`, `turn/start`) and completed a full
   authenticated turn ("ACP-SPIKE-OK") from a headless child process. Claude
   Code has no ACP mode at all without the third-party
   `claude-code-acp` adapter.

2. **No tested desktop harness exposes an attachable ACP endpoint.** You
   cannot connect the daemon to an existing desktop session over ACP. The
   Devin desktop app — the one true positive — hosts its ACP sessions by
   spawning the very same `devin acp` CLI as a child of its extension host.
   The harness *is* the ACP client; the agent side is always a spawned
   subprocess. Cursor/Claude.app don't speak ACP at all (Cursor uses its own
   agent runtime; Claude.app uses Claude Code stream-json).

3. **Consequence for the daemon executor:** the realistic design is exactly
   Proof 1/2 — the daemon becomes an ACP client (or Codex-dialect client) and
   spawns agent CLIs itself. "Joining" a human's desktop harness session is
   not possible via ACP on any installed harness; if that is ever wanted it
   would need a different mechanism entirely (e.g. shared session stores,
   which Devin exposes via `devin resume`/sessions.db, out of scope here).

## Throwaway proof scripts

All probes were inline `node -e` one-shots against spawned processes; nothing
was committed beyond this notes file. Reproduction sketch:

```js
// ACP (devin): spawn("devin", ["acp"]) → initialize → session/new → session/prompt
// Codex dialect: spawn("codex", ["app-server"]) → initialize{clientInfo}
//                → thread/start → turn/start{threadId, input} → item/completed
```

## Out of scope / not done

- No production executor landed. All probes were throwaway scripts.
- Devin auth left unauthenticated deliberately (no credentials touched).
