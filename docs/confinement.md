# Soul write confinement

Confinement hooks are a guardrail, not a sandbox. An agent can still read and
write anywhere its OS user can. ADR-0332 decision 7 ships reporting first:
every soul defaults to **warn**, and an outside write is allowed and reported.
Deny will become the default only after the owner has reviewed reports and
found no false positives. This release does not make that change.

## Allowed territory

The shared `agent-hook` runner checks recognized file write/edit tool calls
against real paths for:

- the soul directory resolved by the population registry;
- each entry under its `worktrees/`, including link targets elsewhere (#339);
- `$TMPDIR/agent-bot/<agentId>` (OS tmp directory when TMPDIR is unset), only
  while `agent-bot` and `<agentId>` there are real directories owned by this
  user, so a link planted in a shared temp directory grants nothing;
- the checkout of the current soul binding;
- absolute paths granted by the soul's `policy.json`:

```json
{
  "confinement": {
    "writablePaths": ["/absolute/path/to/shared-project"]
  }
}
```

Binding files (`agent-binding.json`, `agent-bindings/*.json` and any
`AGENT_BOT_BINDING` file) are never territory, even inside the bound checkout:
the binding names the soul whose mode applies.

The soul's key store, `<soul>/.soul-state/credentials/`, is never territory
either, although it sits inside the soul directory.

## Credentials stay behind the daemon

A soul gets GitHub tokens from the daemon and the credential helper, never
keys (#383, [soul credentials](soul-credentials.md)). For every tool call a
soul makes, not only file writes, the runner refuses:

- any path under any soul's `.soul-state/credentials/`;
- any path under a legacy `~/.config/<slug>` App folder (one holding
  `private-key.pem` or `app-id`), and any `private-key.pem`;
- a shell command that runs `security` or `pass-cli` (in command position,
  after `env`, `exec`, `sudo` and similar, or by path), or that names one of
  the paths above.

This guard denies in every confinement mode, `off` included, and a guard that
cannot run refuses the call. It reads only what the tool call says, so like the
write guard it is cooperative: an agent that hides a command from the hook (an
interpreter one-liner, a script it wrote) is not stopped by it. The owner, with
no soul marker, is never guarded.

Keep any existing revision policy fields such as `mode` and `paths`. Relative
paths and `~` grants are rejected. Policy changes use the existing owner-reviewed
soul revision workflow. New target files resolve through their nearest existing
ancestor; links are followed, and `/a/bc` is outside `/a/b`.

## Modes and reports

```sh
agent-bot soul confinement AGENT_ID warn
agent-bot soul confinement AGENT_ID off
agent-bot soul confinement AGENT_ID deny
agent-bot soul confinement-report AGENT_ID
agent-bot soul confinement-report AGENT_ID --json
```

Every mode change requires `assertOwnerAction`: any soul marker refuses, then
the owner proves themselves through the consent dialog or presents a principal
credential with `--principal-stdin`, verified by a broker in another account.
The command never loads that credential for the caller. A soul cannot turn off
or loosen its own confinement. `deny` is an explicit owner choice, accepted now
but not the default. Modes are keyed by Agent ID in the private 0600
`confinement.json` under the identity state directory.

Warn appends one JSON line per outside write attempt to
`<soul>/.soul-state/confinement.log` (0600). It records only `ts`, `agentId`,
`harness`, `tool`, the resolved `path`, and `roots`; never file contents,
commands, binding secrets or credentials. Claude's pre-tool context channel
also carries a short warning. Other dialects record the log without inventing
a context channel. The report counts attempts by parent directory path prefix,
with a total and a count of malformed records (such as an interrupted append).
It summarizes history, including attempts denied by another hook; it does not
prove a write succeeded. Reports are read-only and require no owner proof.

Off performs no check or logging. A session with no soul identity does nothing.
Check and logging errors allow in warn mode and do not interrupt other hooks.
Once deny mode is successfully read, check errors refuse the write. Unreadable
mode settings fall back to the shipping warn behavior. Existing hook failures
and denials still follow the runner's usual verdict rules.

## Coverage and limits

Covered file tools include Claude Write, Edit, MultiEdit and NotebookEdit,
Codex/Cursor Write and Edit, Copilot create/edit and normalized file equivalents,
and Devin Desktop's legacy `pre_write_code` path. For dialects exposing
`pre-tool-use`, that event performs the built-in check; their overlapping
`pre-file-write` adapter does not duplicate the report. Legacy dialects use
`pre-file-write`. Unsupported or missing paths cannot be evaluated; in warn
they allow, and in explicit deny they refuse recognized file tools.

Apart from the credential guard above, shell commands, shell redirections,
arbitrary patch commands, MCP tools, unknown tool names and reads are not
covered. Shell write reporting is a
follow-up; this change does not parse arbitrary commands. Hook bypasses and
filesystem races remain possible. The log and mode settings are cooperative
account-local files, not an OS security boundary.

The daemon already uses harness OS sandboxes on resume wake through
`wake-resume.mjs`: Codex uses `sandbox_mode`, Devin uses `--sandbox` for workspace
wake, and Grok uses its workspace/read-only sandbox profiles. Those existing
sandbox paths remain in use; this change adds no new sandbox. Harnesses without
an OS sandbox still use their own permission policies. See
[resume harnesses](resume-harnesses.md) for the runtime contract.
