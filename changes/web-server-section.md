- Web client gains a read-only Server section (#1295): GET
  /ui/api/machine/server returns enrollment status, device id/name,
  approved identities and a doctor readiness summary for principals whose
  observe authorization covers souls exactly ['*']. The MCP
  server_status and doctor tools now share their probes through
  server-status.mjs.
