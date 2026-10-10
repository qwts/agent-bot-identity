# Windows

What agent-bot does on `win32`, per GeniusBar
[ADR-0046](https://github.com/qwts/GeniusBar/blob/main/docs/decisions/ADR-0046-windows-pipe-transport-dpapi-store-and-logon-tasks.md)
(qwts/GeniusBar#46). Windows support currently covers the identity daemon as
a per-user scheduled task, the DPAPI-protected file credential store,
identity-owned vouch-key custody, and the daemon's single-account comms
client over a named pipe. Cross-platform tests use fakes for Windows account
and ACL calls; a separate Windows CI preflight exercises native custody and
pipe primitives with disposable state.

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

## The daemon vouch key

`vouch-key.pem` remains the per-account PKCS#8 Ed25519 key at the existing
`XDG_STATE_HOME/agent-bot` path (or `%USERPROFILE%\.local\state\agent-bot`),
with the existing create-once and no-silent-rotation behavior. On Windows,
the identity module resolves the current account SID with `whoami`, checks
that the state directory and key are real objects owned by that SID, and
creates new directories and empty private files with that SID as owner and
a protected owner-only access list. Existing directories are checked without
changing their owner or access list. Existing keys are restricted with
`icacls`, then verified to have no foreign account allow entry. Exclusive
creation never overwrites an existing key. The PEM bytes and path do not
change; only this account may retain access to the private key. These
`whoami`, `Get-Acl` and `icacls` calls are exercised through fakes in the
cross-platform suite. A live Windows daemon run is still pending.

## The daemon comms client

Windows pairing and reconnects use the implemented
[agent-comms Windows local-channel contract](https://github.com/qwts/agent-comms/blob/main/docs/windows.md#local-channel).
The daemon connects to `\\.\pipe\<service-label>.<account-SID>`; set
`AGENT_COMMS_SERVICE_LABEL` to the same label used by the broker. Set
`AGENT_COMMS_SHARED_DIR` to the broker's shared directory and
`AGENT_COMMS_BROKER_STATE_DIR` to its state directory when the broker uses
non-default locations. The client fails closed if the shared directory is
not explicitly configured to match the Windows host. It checks that the
shared and pairing-proof directories, broker state directory, and
`identity.json` belong to the current SID. The broker's SPKI Ed25519 key is
read from that custody-checked identity file and saved with the SID in the
existing daemon credential record.

Each pipe connection uses Windows PowerShell's .NET `NamedPipeClientStream`
with explicit `TokenImpersonationLevel.Identification`. This restricts the
server to identifying the client; it cannot act as the daemon account before
the application handshake finishes. There is no fallback to Node's default
pipe connector. The relay carries protocol bytes on binary stdin/stdout,
with no credentials on its command line. The client then sends a nonce and
waits for the broker's signature over the pipe name and nonce before sending
the pairing request or any daemon request. The saved credential keeps its existing JSON file path
and override behavior. Windows single-account credential storage creates empty files with a
protected account-only ACL and verifies custody before writing the secret. Group broker mode is
unsupported on Windows.

The Windows native CI preflight uses the real `whoami`, `Get-Acl` and
`icacls` commands with a disposable vouch key, then creates a unique signed
named pipe and checks the wire handshake. It verifies these local custody
and pipe primitives; it does not install or exercise a packaged broker,
daemon, or scheduled service. Live end-to-end acceptance remains pending for
GeniusBar #46, agent-comms #127, and agent-bot #813.

## Not on Windows

- `keyd`, `keychain` and the persona accounts: a Windows soul's App key
  stays in the file store above, as Homebrew and Linux installs do.
- `agent-bot install` (the hooks, the `~/.local/bin` launcher, the PATH
  block) and soul homes as symlinks: the GeniusBar slice of ADR-0046
  (`.cmd` shims, copies in place of links, bundled MinGit).
