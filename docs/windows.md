# Windows

What agent-bot does on `win32`: a named pipe where macOS and Linux use a
Unix socket, a DPAPI-protected file where macOS uses the Keychain, and a
per-user scheduled task where macOS uses a LaunchAgent. Windows support
currently covers the identity daemon as a per-user scheduled task, the DPAPI-protected file credential store,
identity-owned vouch-key custody, and the daemon's single-account comms
client over a named pipe. Cross-platform tests use fakes for Windows account
and ACL calls; a separate Windows CI preflight exercises native custody and
pipe primitives with disposable state.

## Install from a source checkout

Run machine preparation with native Node from PowerShell:

```powershell
node agent-bot.mjs bootstrap --machine-only --profile ABSOLUTE_PROFILE_PATH --json
```

The installer writes a matching `agent-bot` shell launcher and `agent-bot.cmd`
under `%USERPROFILE%\.local\bin`, without requiring symlink privileges. It
registers that directory in the current user's PATH. Open a new terminal to
inherit the registration, or invoke the `.cmd` by its full path. Existing
foreign files, incomplete launcher pairs, and launchers belonging to a
different runtime are refused rather than overwritten. Keep the installed
source checkout at its original path.

Git hooks run through the shell bundled with Git for Windows and require that
Git installation's `usr/bin/sh.exe`. They do not select the Windows WSL shell.
The same interpreter runs the `agent-comms` shell launcher for soul membership;
install that CLI and configure the broker before joining. Existing Agent Space
and external-checkout directory aliases use Windows junctions without symlink
privileges, preserving the original targets and refusing foreign occupied paths.
The scheduled task runs Node directly. When a packaged terminal redirects
AppData, installation resolves the log directory through its native directory
handle so Task Scheduler uses the same physical directory. It retains the
installing host's tool PATH so binding checks can find that host's Git.

Binding state needs a private ancestor chain. A checkout copied or moved from
a directory granting other accounts mutation rights retains those ACLs; moving
it alone does not make it eligible. Inspect and repair only agent-owned checkout
ACLs under the soul's private work area. AppData can also carry packaged-app
capability grants, so native binding tests use the profile state boundary.
Windows daemon storage requests allow up to 60 seconds for native custody and
protected writes. Installation allows 60 seconds for startup and binding
restoration; each separate health probe remains bounded to 1.5 seconds.

Machine readiness and App token minting do not establish a soul's worktree
binding or prove broker pairing. Complete [joining](joining.md) separately.

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
the action is a classic PowerShell wrapper that enters an unnamed Windows
job before starting `cmd.exe /S /C`. Its non-inheritable job handle remains
open for the wrapper lifetime: ending the task closes it and terminates only
that task's descendant tree, including the daemon and pipe bridges. Failure
to enter the job refuses startup; no PID scan or fallback is used. Older
installed tasks gain this protection when refreshed. The cmd line pins the
daemon's
environment (`AGENT_BOT_DAEMON_STATE_PATH`, the label, the host's npm and
tool path, explicit broker label/shared/state paths, `XDG_STATE_HOME` and
`AGENT_BOT_COMMS_DAEMON_PATH`), runs the current `node.exe` with the daemon entry script and
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
- The optional `gh` shim remains a POSIX shell entrypoint; native Windows
  `gh` interception is not established here. Packaged soul files that themselves
  require arbitrary symlinks still need a separate Windows packaging strategy.

## Signed-in supervisor acceptance

Run the following command:

```powershell
node scripts/windows-supervisor-acceptance.mjs --comms ABSOLUTE_COMMS_CHECKOUT --report ABSOLUTE_REPORT_PATH
```

with `AGENT_COMMS_DISPOSABLE_WINDOWS=1` only in a disposable signed-in Windows
account. Use the host-selected portable Node and a comms checkout containing
the task-lifetime fix from agent-comms #148. The report path must be outside
the script's runtime directory.

This exercises the production supervisor installer, actual scheduled tasks,
normal native vouch-key pairing, and actual `runDaemon` account-watch/wake
reporting before and after task and broker restart. The daemon runs through
its supported host API with an explicit disposable home and empty config;
Windows custody still uses the actual account and profile. This isolates
logs, population and config without changing `USERPROFILE` or `LOCALAPPDATA`.
It does not establish CLI default-home installation, packaged host support,
actual logoff/logon or full harness launch. No OS, process, transport or
credential provider is injected. Cleanup targets only uniquely named tasks
and directories. On failure, the sanitized JSON report includes scheduler
state and result code, daemon health, and fixed startup error classifications.
The uniquely named runtime directory is retained with its local startup log
for diagnosis; that directory can contain credentials and must not be
published with the report. Successful runs remove their runtime directory.

Windows binding secrets and the daemon's binding registry use native SID and
owner-only file ACL checks. Existing parent ACLs are inspected without changes:
parents must be real directories with trusted account or OS ownership, and
foreign mutation or descendant replacement rights cause refusal. Secure Git
worktrees outside the profile remain eligible. The fixed Windows Modules
Installer (TrustedInstaller) SID is accepted as an ancestor owner; immediate
parents and binding files still require ownership by the current account, and
foreign mutation grants remain subject to the same refusal checks.
