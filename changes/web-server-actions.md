- Web client gains Server actions (#1295): POST
  /ui/api/machine/server/reconcile settles pending unknown credential
  operations through `server reconcile --json` (single in-flight run,
  no proposal since it never mints), and POST .../server/enroll creates
  an immutable machine.enroll proposal that re-enrolls with the current
  harness set through `server enroll --force --json` — the device-code
  prompt streams as a JSON line so the outcome route reports
  pending-approval with user_code/verification_uri/thumbprint until the
  server-side approval lands. ServerSession reads device.json per
  request, so no daemon restart is needed.
