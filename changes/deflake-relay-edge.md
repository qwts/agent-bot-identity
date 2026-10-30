- Relay edge auto mode: an SSE stream that held to its own deadline now makes
  the following poll a single terminal catch-up — drain its `hasMore` pages,
  never nap and retry. The stream's monotonic abort timer can beat the
  wall-clock deadline by a hair, and that hair let a loaded runner schedule a
  nap and count a second catch-up poll (flake in
  tests/relay-edge.test.mjs "edge holding to the deadline").
