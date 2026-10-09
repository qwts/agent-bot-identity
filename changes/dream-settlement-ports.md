- Preserve a dream executor's successful settlement after cancellation was
  requested, while keeping its shared turn busy until settlement. Pass a cold
  caller's shorter execution deadline into the shared registry without allowing
  it to extend the host bound; ordinary wake cancellation behavior is unchanged.
