- Web client gains a read-only agent-machine section (#1295): GET
  /ui/api/machine/agent-machine reports pairing state (load-only client
  key, pinned daemon.pub fingerprint, agent-daemon peer files,
  terminal-paired) plus signed status and receipts round trips through
  machine-client. Agent-machine errors become section data — the route
  stays 200 and the Server section keeps working when it is down.
