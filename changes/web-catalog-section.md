- Web client gains the Catalog section (#1295): GET /ui/api/machine/catalog
  fetches and verifies the signed server catalog (ed25519 envelope, key id
  derived from the key, floor enforcement) with a 5-minute single-flight
  cache, and POST .../catalog/deliver relays the verified catalog_key/floor/
  envelope to agent-machine's catalog verb — agent-machine pins the key on
  first delivery and enforces the floor itself. Per-item Update routes
  through the existing machine.update proposal. The daemon also uploads
  the agent-machine status-digest to /api/daemon/relay/status every 15
  minutes and after each successful apply/update, byte-exact, skipping
  silently when unenrolled or undigested.
