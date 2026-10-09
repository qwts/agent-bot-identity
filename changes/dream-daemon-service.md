- Compose dream scheduling into the daemon with a private durable journal,
  strict owner-authorized controls, bounded source capture and the existing
  configured ACP execution/approval path. Shared stop and shutdown retain
  unsettled leases, and restart quarantines unverified child ownership. Status
  explicitly reports execution facts with unverified maintenance coverage.
