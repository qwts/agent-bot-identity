# Soul revisions, format 1

The revision mechanism stores package snapshots and an append-only journal at
`<identity state directory>/soul-revisions/<agentId>/`. It does not execute
package code, grant tools, or alter an identity. Hosts remain
responsible for authenticating the actor and approving requested tool authority
on their bound connections.

## Commands

All commands print JSON. Reasons are required positional strings; quote reasons
containing spaces.

```sh
agent-bot soul revision adopt ID PACKAGE 'Starting package'
agent-bot soul revision edit ID PACKAGE 'Customize instructions'
agent-bot soul revision edit ID COPY 'Customize instructions' --apply --json
agent-bot soul revision edit ID COPY 'Customize instructions' --apply --principal-stdin < principal.json
agent-bot soul revision propose ID PACKAGE 'Learned a better procedure'
agent-bot soul revision list ID
agent-bot soul revision approve ID PROPOSAL_ID 'Reviewed the proposed changes'
agent-bot soul revision approve --principal-stdin ID PROPOSAL_ID 'Reviewed' < principal.json
agent-bot soul revision reject ID PROPOSAL_ID 'Keep the current behavior'
agent-bot soul revision history ID
agent-bot soul revision promote ID notes/lesson.md knowledge/lesson.md 'Keep lesson'
```

Adopt records the starting package, preserving its parent. For a soul with a
genesis, the package must match that genesis revision. A legacy soul can adopt a
package without changing its ID. Adoption is explicit and happens once; the
spawn/install integration can call `adoptSoulPackage` after minting. Edits and
proposals require an adopted package so their base contents are available for
review. Inputs must be quiescent directories, as with package validation.

An edit copies the supplied package content (excluding format 2 working state), sets its parent to the current
head, computes its revision, and appends it. Without `--apply`, inputs are never modified. Undo uses
an earlier snapshot's contents as a new edit, with the current head as parent.
Unknown files, unknown manifest fields, binary bytes, directories, and execute
bits survive. Manifest JSON formatting is normalized in stored snapshots.

`edit ID PATH REASON --apply [--json]` also publishes the recorded snapshot into
the soul's own package folder, resolved by `soulDirectory(ID)` (the folder
reported by `soul profile`). After owner approval, it preflights the source and
destination, records the revision, and adds, replaces, or removes differing
paths. Files are written to sibling temporary files and renamed individually;
`soul.json` is published last with the new `revision` and `parentRevision`.
Execute bits are preserved. Symlinks are refused, and `.soul-state/` and
`worktrees/` are never traversed or changed. When PATH is the soul folder itself,
only the manifest's revision fields are rewritten; all other files stay in place.
A running soul is allowed: package files are read per turn.

The per-soul revision lock covers snapshotting, recording, and publication, and
a moved recorded head refuses application. Publication is atomic per file, not
for the whole folder: an I/O failure after recording can leave a recorded revision
and a partially updated folder. The command fails in that case. On success the
returned JSON revision record adds `applied: true` and `changed: [paths]`, a sorted
list of relative paths (including changed directories and `soul.json`). These
publication fields are returned only, not added to the append-only history record.
Without `--apply`, the response and record-only behavior are unchanged. All
revision commands already print JSON; `--json` is an explicit optional spelling.

Proposals snapshot the candidate package content immediately and include a computed
path diff (`added`, `modified`, `removed`), reason, author, timestamp, and base
revision. Approval uses those stored bytes, never the caller's later edits.
Approving a stale proposal fails; resubmit it against the new head. Stale
proposals can still be rejected. Rejected proposals cannot be approved later.

The CLI's adopt, edit, approve, and reject commands are owner actions, gated by
`owner-gate.mjs` (#293). A caller with no soul markers is not assumed to be the
owner, because a soul can unset its markers. Each owner action needs both:

1. **No soul marker.** An Agent ID (`AGENT_BOT_ID`, `QWTS_AGENT_ID`, or the
   worktree's git config), a binding (`AGENT_BOT_BINDING` or the worktree's
   `agent-binding.json`), or an App identity (`GH_AGENT_APP`, a pin, an agent
   account, or a detected harness) refuses the action, whatever proof comes
   with it. A marker that cannot be read also refuses.
2. **An owner proof.**
   - With `--principal-stdin`, the caller presents the owner's agent-comms
     principal credential as JSON on stdin (`{ principal, secret, brokerUid,
     mode }`, the shape agent-comms pairs). The CLI checks it with one
     authenticated `health` request to the broker, after the usual custody
     checks. The broker must run in a different account from the caller:
     a broker in the caller's own account (single-account mode, or a group
     broker still in the owner's account) cannot vouch, because any process
     in that account could stand up a socket that answers. The CLI never reads
     the principal from disk or the keychain itself. A host app such as
     GeniusBar holds the principal and presents it the same way.
   - Without it, where GeniusBar's `agent-bot-keyd` is installed and a
     person can be asked, keyd asks for Touch ID, or the login password on a
     Mac without it, naming the soul (name and Agent ID) and the change. No
     administrator account is needed. keyd signs the approval with its own
     key, which agent-bot pins from the code-signed binary, so a socket that
     merely answers cannot approve (#416).
   - Otherwise (no keyd, an unsigned keyd, no GUI session such as ssh or a
     headless Mac), the macOS authorization dialog (#204) names the action and
     needs a person to authenticate as an administrator. Cancelling it, or a
     platform without it, refuses. A "no" through keyd never falls back to
     this dialog.

Only the CLI's consent-dialog fallback requires an interactive terminal (both
stdin and stderr). Keyd presence works without a terminal or a principal, so an
app can invoke an owner revision action directly. If keyd is unavailable, a
noninteractive caller receives `owner-credential-required: owner consent requires
an interactive terminal; --yes cannot approve`. A keyd refusal never reaches the
dialog fallback. Neither stripped environment markers nor `--yes` proves
ownership. Refusals use `owner-credential-required`
and append a secret-free `soul-revision` audit receipt. Invalid principals never
fall back to consent. Daemon clients use the same principal verification via
the [revision API](daemon-api.md); daemon consent is a reserved contract only.

The record of each owner action carries `authorization`: `{ method:
"principal", principal }`, `{ method: "presence", via: "agent-bot-keyd" }` or
`{ method: "consent" }`. The secret is never recorded.

This is still a local mechanism boundary, not isolation against a process
that can rewrite runtime files: a process running as the account that owns the
journal can write it directly, and any process in the owner's account can
read a principal agent-comms stored there. Hosts that call module functions
directly must authenticate user actions themselves and may pass the
`authorization` to record. `revisionCommand` accepts an injectable `assertUser`
for a host's own ceremony; it returns the authorization to record. The CLI also
refuses cross-soul proposals and requires an Agent ID when an App
identity is resolved. Hosts can supply `assertSoulTarget` for their authenticated
soul boundary. There is no flag that changes a proposal into a user edit.

## Policy schema

The **current accepted package's** `policy.json` controls proposals:

```json
{"mode":"auto","paths":["AGENTS.md","notes","notes/**"]}
```

`mode` must be `ask`, `auto`, or `never`. A missing policy defaults to `ask`.
`paths` is an optional array of case-sensitive, package-relative globs; omitted
paths permit no changed paths. Invalid policies fail closed. Unknown policy
fields are preserved but have no effect in format 1.

`*` matches within one path component, `?` matches one character in a component,
and `**` matches across components. `**/` also matches zero directory components.
There are no negations, braces, character classes, or backslash escapes.
Absolute paths, `.` and `..` components, and control characters are invalid.
Directory creation/removal and execute-bit changes count as changed paths.
Every changed path, including a newly added directory, must match for auto
approval; otherwise the proposal stays pending. An unchanged tree can still
produce a new revision because its parent changes.

`never` records a rejected proposal without advancing the head. `ask` records a
pending proposal. `auto` applies only an allowed diff. Changes to `policy.json`
and `soul.json`, the top-level `bin` entry and all paths under `bin/`,
paths with a tool component or filename token, or any path
containing `mcp` (case-insensitive, so `mcpServers.json` is included), always
require user approval. Tool configurations have no shared capability schema yet,
so even tool removals or other potentially narrowing changes require approval.
The canonical `tools.json` and `mcp.json` files are covered. Hosts introducing
other authority-bearing extension formats must require approval for those
extensions; package contents never grant runtime authority on their own.

## Storage and module integration

`soul-revisions.mjs` exports adoption, editing, proposal, decision, history,
package-path, diff, and promotion functions. Options accept `stateDir` and `now`
for embedding/testing. `createRevisionAppender(packagePath, { reason, ...options })`
implements the `recordAgentPackageRevision` append port; it verifies the complete
prepared package's hash and current parent before appending. This low-level port
is for authenticated user edits. Soul callers use `proposeSoulRevision`.

Each `objects/<64-hex>.soul` holds a full validated package. Package formats 1
and 2 are supported; format 2 snapshots and diffs exclude working state and
generated files whose bytes exactly match the package’s soul-builder output,
using the [package ignore contract](soul-package.md). The marker alone has no
effect. Until soul-builder ships (#342), nothing at generated paths is ignored;
marked files are included in snapshots and proposal diffs. Numbered journal JSON
records carry `schemaVersion: 1`, `kind`, and `at`. Revision records contain
`revision`, `parentRevision`, `author: user|soul`, and `reason`. Approved proposals
also record `proposalId`, `approval: user|auto`, and, for user approval,
`approvedBy` and `approvalReason`. The original author remains `soul`. User
actions taken through the owner gate also record `authorization`.

Proposal records contain `proposalId`, both revisions, `author: soul`, `reason`,
`diff`, `requiresUser`, and initial `status: pending|rejected`. Reject decisions
are separate `kind: decision` records. `listSoulProposals` derives final status
from later records; it never updates a proposal in place. `history` returns only
accepted revisions. Snapshots referenced by proposals remain available after
rejection. Unreferenced snapshots or staging files from interrupted operations
are harmless; automatic garbage collection is not provided.

A per-soul lock serializes journal publication. Complete JSON files are linked
exclusively into their final names, and existing snapshots are validated rather
than overwritten. Parent comparisons reject stale appends. Host callers can pass
`expectedParent` to edit/propose for optimistic concurrency. Stored packages are
read-only by contract; hash checks detect external modification.

## Agent Space promotion

Promotion copies one regular file from the configured Agent Space into the
current package. Source and destination are relative paths without traversal;
symlinks are refused. Memory is otherwise untouched. The CLI creates a soul
proposal under the same policy as other proposals. Its reason names the source
Agent ID and relative path, including after approval.

Hosts may call `promoteSpaceContent` with authenticated `actor: user` for a direct
user revision; the default is `soul`. `resolveSpace` is the injectable seam for
space resolution and defaults to the existing `spacePath` runtime API. Promotion
rejects a changed base rather than overwriting concurrent edits. Directory-wide
promotion is deliberately not implicit: select files explicitly.
