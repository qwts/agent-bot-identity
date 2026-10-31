- Registry coverage now runs source->registry too: a test scans
  agent-mcp.mjs, machine-client.mjs, cli/machine.mjs and agent-daemon.mjs
  for emitted stable codes (mcpError/mcError literals and code: object
  literals) and asserts each is in governance/error-codes.json, so an
  emitted-but-unregistered code like doctor-unavailable can't slip past
  review again. Seven codes the daemon already emitted unregistered are
  now registered (n93-n99).
