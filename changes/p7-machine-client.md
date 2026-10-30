- Agent-machine client (#1254): agent-daemon can now call the local
  agent-machine control daemon over its signed unix-socket protocol.
  `POST /v0/machine` takes {verb, name?, option?, target?, plan_id?} behind the
  caller's binding proof and fills soul, harness and session_id from the
  binding (a supplied mismatch is `derived-field-mismatch`). The agent-daemon
  Ed25519 key lives under vouch custody; `agent-bot machine pair|unpair|status`
  (owner-gated) stages `peers/agent-daemon.*` and pins `daemon.pub` so a key
  swap is refused. MCP gains machine_status/machine_receipts (read) and
  machine_plan/machine_apply/machine_update (write) behind the meta-tools.
