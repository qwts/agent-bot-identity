# Windows

What agent-bot does on `win32`, per GeniusBar
[ADR-0046](https://github.com/qwts/GeniusBar/blob/main/docs/decisions/ADR-0046-windows-pipe-transport-dpapi-store-and-logon-tasks.md)
(qwts/GeniusBar#46). Two things run on Windows today: the identity daemon as
a per-user scheduled task, and the file credential store as a DPAPI-protected
file. Each is a `win32` branch of the module that already branches on the
platform, and every external call goes through an injected runner, so the
suite exercises both on every platform with fakes for `schtasks.exe` and
`powershell.exe`.

## The daemon as a scheduled task

`agent-bot daemon install` registers a per-user scheduled task named after
the service label (`AGENT_BOT_SERVICE_LABEL`, default
`dev.qwts.agent-bot.daemon`) from an XML definition:
`schtasks /Create /XML <unit> /TN <label> /F`, then `/End` and `/Run` so the
task starts now, on the new files, rather than at the next logon. The `/SC
ONLOGON` shorthand is not used because it cannot express restart on failure.
Registering a task for the current user needs no administrator.

The task runs at this user's logon, hidden, with `RestartOnFailure` every
minute (count 999, the schema's ceiling; it resets at the next logon), no
`ExecutionTimeLimit` (`PT0S`) and `MultipleInstances` set to ignore a second
start. Task Scheduler has neither stdio paths nor an environment block, so
the action is `cmd.exe /S /C` with one line that pins the daemon's
environment (`AGENT_BOT_DAEMON_STATE_PATH`, the label, the host's npm and
tool path), runs the current `node.exe` with the daemon entry script and
`daemon run`, and appends stdout and stderr to the log. A path carrying a
quote or a percent sign has no faithful form on that line and is refused as
a usage error.

Files live under `%LOCALAPPDATA%\<label>` (a terminal install with no host
label uses `%LOCALAPPDATA%\agent-bot`), where custody is the profile's own
access list:

| What | Where |
| --- | --- |
| The unit (the task's XML, UTF-16 with a byte-order mark) | `%LOCALAPPDATA%\<label>\<label>.xml` |
| The daemon's stdout and stderr | `%LOCALAPPDATA%\<label>\Logs\daemon.log` |
| The daemon's state file | `%USERPROFILE%\.local\state\agent-bot\daemon.json`, as on Linux (`XDG_STATE_HOME` and `AGENT_BOT_DAEMON_STATE_PATH` still win) |

`daemon install --json` answers the same `{ label, unitPath, changed,
loaded }` as on macOS; `daemon disable` is `/End`, `/Delete /F` and the file
removed; status (`doctor`, `readiness`) reads `schtasks /Query /TN <label>
/FO CSV /NH` and takes the row naming the task as the proof. A task that
schtasks cannot find is the ordinary state of a machine that never
installed one, never a failure to remove; any other refusal is a
`supervisor-load-failed` or `supervisor-unload-failed` error carrying
schtasks's reason.

## Secrets: a DPAPI-protected file

The `file` credential store, which souls and managed Apps use wherever
there is no Keychain, keeps `github-app-<slug>.dpapi` beside where the
`.json` would be: the credential encrypted with
`[System.Security.Cryptography.ProtectedData]::Protect(..., 'CurrentUser')`,
so only this Windows account on this machine decrypts it. That, with the
profile's access list, is what the 0700 directory, the 0600 file and the
owner check are on Unix: a file another account planted does not
unprotect, and there is no mode to loosen. The script goes to
`powershell.exe -NoProfile -NonInteractive -Command -` on stdin with the
credential hex-encoded inside it, never on argv; reading reverses it. A
refused Unprotect is `dpapi-unprotect-failed`, an answer that is not the
credential's bytes is `dpapi-malformed`, and a failed Protect writes
nothing (`dpapi-protect-failed`); none of them quotes PowerShell's output.
See [soul credentials](soul-credentials.md).

## Not on Windows

- `keyd`, `keychain` and the persona accounts: a Windows soul's App key
  stays in the file store above, as Homebrew and Linux installs do.
- `agent-bot install` (the hooks, the `~/.local/bin` launcher, the PATH
  block) and soul homes as symlinks: the GeniusBar slice of ADR-0046
  (`.cmd` shims, copies in place of links, bundled MinGit).
- A Windows machine has not run the daemon end to end; the branches are
  complete and tested with fakes, and the first real run is the next step.
