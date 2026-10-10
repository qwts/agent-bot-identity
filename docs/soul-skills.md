# Skill library

The library collects a skill independently of a soul, retaining the acquired
bytes and provenance separately from an editable copy. Importing does not run
scripts, activate a harness skill, select an SOP, or create a soul revision.
This implements local-directory, HTTPS-document and public GitHub-directory acquisition and comparison
for #603/#312. Learning guides selected adaptations through the existing soul
revision/proposal policy. Explicit source updates merge a reviewed candidate into
the standalone library. Managed harness installation/uninstallation, other
repository adapters and optional knowledge search/status remain unimplemented.

The [dream maintenance guide](soul-skill-dream-design.md) describes the implemented
owner CLI, daemon scheduling, bounded definition/learned-skill inputs, recovery
and reported outcomes. Register maintenance explicitly; importing or learning a
skill creates no schedule. Maintenance coverage remains unverified, and the guide
identifies the remaining processing, notice and retrieval work.

```sh
agent-bot soul skill import /path/to/skill --json
agent-bot soul skill import /path/to/skill/SKILL.md --json
agent-bot soul skill import https://example.com/skills/demo/SKILL.md --json
agent-bot soul skill import https://github.com/OWNER/REPO/tree/main/skills/demo --json
agent-bot soul skill list --json
agent-bot soul skill show UUID --json
agent-bot soul skill verify UUID --json
agent-bot soul skill check UUID --json
agent-bot soul skill learn UUID --soul AGENT_ID --json
agent-bot soul skill install UUID|NAME --soul AGENT_ID --json
agent-bot soul skill uninstall NAME --soul AGENT_ID [--trash] --json
agent-bot soul skill dream --soul AGENT_ID --status --json
```

A source is a real local directory containing `SKILL.md`, or that file itself.
The entrypoint uses the same UTF-8/frontmatter/name/description validation as a
soul package. Its frontmatter name determines the editable directory's name;
the source directory need not have that name. Each import receives a new UUID,
even for the same name and bytes. There is no implicit deduplication or update.
Library import/list/show/verify/check/update require neither a GitHub App nor a
soul binding. Recording a learning outcome requires the target soul's binding
and existing revision policy. `dream` controls require owner authorization and
run in the daemon; see
[the dream design](soul-skill-dream-design.md#schedule-and-controls).

## HTTPS documents and instruction dependencies

An explicit HTTPS document URL must yield a valid `SKILL.md`. Acquisition also
captures inline Markdown links ending in `.md`, `.markdown` or `.txt`, including
nested references and cycles. Relative URLs resolve against the **final URL of
the referring document**, after redirects. Each retained file records its
original and final URLs in `locations`; its exact bytes have the same digest
and comparison rules as local imports. Source checking revisits the original
refresh URL and retains new source bytes as a separate candidate. Every check
also records the current URL/dependency mapping, even when bytes are unchanged.

Files under the final entrypoint's URL directory keep their relative layout.
Other origins or paths map to `remote/<sha256-of-final-url>/document.md`.
The report maps references to retained paths. It does not rewrite instruction
text: review replacements deliberately before using the material as guidance.
All remote files have mode `100644`; no executable permission is inferred from
a server response. For direct document URLs, source root links, repository-directory URLs, arbitrary
supporting assets/scripts, reference-style Markdown, HTML and dynamic fetches
are not supported by this adapter. Noninstruction links are reported external;
unsafe or sensitive locators are unresolved. Coverage is explicitly
`markdown-inline-https-instructions-v1`, with `universalRetrieval: false`.

The fetcher accepts public DNS hostnames over HTTPS port 443. It refuses literal
IP URLs, local/special-use addresses, user information, query parameters and
non-HTTPS redirects. Every redirect repeats URL and DNS validation; a mixed
public/private DNS answer is refused. The connection uses the checked address
without a second DNS lookup, preserves the original hostname for TLS/SNI, and
requires certificate validation. Requests use no GitHub App, ambient
authorization, cookies, proxy agent or credential forwarding. A dedicated HTTPS
agent with an empty proxy environment also ignores ambient proxy variables.
Provenance lists every contacted hostname, including intermediate redirects. Only an identity
content encoding is accepted so retained bytes are unambiguous. Error messages
do not include response bodies or rejected URLs. Exact imported payload bytes
are still not secret-redacted; source authors must not put secrets in content or
URL paths. The library is untrusted source data, never execution authority.

Remote acquisition has a 30-second total deadline, at most five redirects per
document, 100 document attempts, 100 retained files, 1 MiB per file, 8 MiB total,
eight dependency levels and
1,000 inline references. `SKILL.md` remains bounded to 64 KiB; metadata is bounded
to 4 MiB. Unsafe portable paths, excluded metadata directories and normalized
path collisions refuse. Internal API limits may only lower these bounds.
An invalid, unavailable or over-limit root document still prevents publication.
After a valid root is acquired, failed or refused nested instructions become
`unresolved` dependency records with a bounded reason code and referring file/line.
The import retains valid documents and reports `coverage.acquisition: partial`;
CLI import returns exit 1 with the retained import UUID/report so partial work
cannot look like a complete capture. `complete-within-boundary` means only the
supported declared reference syntax, never universal coverage. Unsupported
noninstruction links remain external rather than being fetched.

References expand breadth-first so a document uses its shallowest discovered
depth before its own dependencies are expanded. Depth refusals do not poison
URL failure caching. Document attempts include DNS/connection failures; repeated failed locators are
not retried within the same acquisition. Failed streamed bodies consume the total
byte budget. File/depth limits become unresolved references. Exhausting the
reference-discovery budget records one terminal unresolved edge and
`discoveryTruncated: true`, without pretending to enumerate every remaining link.
No refusal relaxes destination, credential, TLS or path checks.

A source recheck with partial capture reports `unavailable` even if the retained
bytes match the accepted digest. It keeps an inspectable partial candidate and
its current dependency report while preserving accepted snapshots and locally
edited files. An unavailable root records the ordinary unavailable receipt
without a candidate. Nothing implicitly adopts a partial candidate.

Network acquisition occurs before the per-import publication lock. Publication
rechecks the starting record under the lock and refuses a changed record. No
network operation runs while holding that synchronous lock. Local library API
calls retain their synchronous return values; HTTPS import/check return promises,
and the CLI awaits them before producing its usual JSON and exit status.

## Public GitHub skill directories

`https://github.com/OWNER/REPO/tree/REF/PATH` selects a directory containing a
regular `SKILL.md`. `REF` is one URL component: a full 40-hex commit, a branch or
tag without slashes, or a ref whose internal slashes are explicitly `%2F`.
There is no branch/directory suffix guessing; encode a slash-containing ref or
use its commit URL. Omit `PATH` for a skill at the repository root. GitHub
Enterprise, private repositories, `blob` web pages and other hosting providers
are unsupported by this adapter; a direct raw document URL uses the document
adapter above.

Acquisition resolves the ref once through the public GitHub API, walks
nonrecursive trees to the selected directory, and fetches allowed files from
`raw.githubusercontent.com` using that full commit. Nonrecursive traversal avoids
fetching an entire monorepo's tree; it consumes one API request per directory,
not per file. GitHub's public API rate limits still apply. There is no `gh`, Git
clone, App token, credential retry or imported command execution. API redirects
must remain on `api.github.com`; raw-file redirects must remain on
`raw.githubusercontent.com`. DNS/TLS checks remain the same as document capture.

The adapter retains supporting scripts and binary assets, relative layout, and
Git modes `100644`/`100755`. Each file must match the size and SHA-1 Git blob ID
advertised by the tree (`blob <length>\0` plus exact bytes). The location receipt
retains `gitBlob`; the library also records its usual SHA-256. This proves byte
consistency with the tree received through GitHub TLS, not a signed publisher
identity. The snapshot's `repository` records owner, repository, selected ref,
directory, resolved commit and selected tree. `show`, source checks and learning
provenance expose the repository revision. The original tree URL remains the
refresh locator. A check re-resolves branches/tags and records the new commit
even if bytes are unchanged; byte-keyed immutable snapshots retain their first
capture provenance rather than being rewritten by a later identical capture.

Every regular file under the selected directory is considered, subject to the
same explicit exclusions and portable-path checks. Symlinks, submodules and
unsupported modes become unresolved `kind: repository-entry` outcomes; they are
not followed. Captured Git LFS pointer text is marked incomplete and never causes
an LFS download. A raw response that does not match the tree blob is refused.
Directory failures and missing/oversized files retain the valid entrypoint and
other successful files as a partial import. Root failures or an invalid/truncated
selected-directory listing publish no import. All truncation is explicit.

Markdown, `.markdown` and `.txt` instruction files are scanned after the directory
capture. Links to retained supporting files map directly; cycles are recorded.
Links into missing/excluded paths or outside the selected directory at the same
repository commit are unresolved rather than fetched around the tree boundary.
Explicit external instruction URLs use the bounded document adapter, including
nested links, under the **same** 30-second deadline, 100-attempt, 100-file, 8 MiB
total and 1 MiB per-response budget. API JSON and failed response bytes consume
that shared budget too. Directory depth is bounded to eight and inventories to
4,000 entries. No phase resets the counters.

API denial, not-found/private resources and rate limiting have separate codes.
Primary rate limits and secondary limits reported by `Retry-After` are distinct
from permanent access denial. A valid retry delay/date or reset timestamp includes
`retryAt` in the unavailable check or per-entry report. Error bodies and credentials
are never persisted. No automatic retry consumes the remaining quota.

Ancestor trees are validated for navigation, but unrelated filenames outside
the selected directory need not be portable. Every captured tree still requires
safe, noncolliding portable names. Absolute `github.com` web links in instruction
text, including `blob` pages and redirects to them, are unresolved rather than
captured as HTML. Use relative links to captured files or explicit raw-document
URLs; the adapter does not guess how a web link's ref relates to the pinned commit.

## Stored bytes and receipts

The default root is `~/.agent-bot/skills`, as specified by ADR-0603.
`AGENT_BOT_SKILLS_HOME` overrides it with an absolute directory path (empty,
relative and literal `~` paths are refused by the CLI). With an invalid override,
the cooperative guard protects the default library metadata and applies normal
confinement to unrelated writes. This deliberately retains the ADR
location instead of moving skills to the identity state directory. Library
callers can also supply `skillsRoot`; tests use isolated roots. Each import
lives at `<root>/<uuid>/`:

- `<name>/` is the editable skill, including supporting files.
- `manifest.json` identifies the import, local source path, import time,
  accepted snapshot digest and local baseline file manifest.
- `.snapshots/<sha256-hex>/payload/` retains exact acquired bytes. Its sibling
  `manifest.json` records file hashes, byte sizes, executable modes, source,
  acquisition time, dependency edges, coverage, exclusions and materialized links.
- `.checks/<uuid>.json` records each successful or unavailable source check, returned as `checkId`. Receipts are append-only;
  automatic retention/pruning is not implemented, so repeated checks grow this directory.
- `.updates/<uuid>/` retains before/after records, prior local material and the
  outcome of an explicit update. `.pending-update.json` identifies an interrupted
  transaction requiring recovery. These are protected library metadata too.

Metadata stays outside the skill payload and its checksum. File receipts use
SHA-256 of exact bytes and mode `100644` or `100755`; the aggregate hashes the
canonical file manifest. Timestamps and permissions other than executable status
are not part of the digest. CRLF, binary files and supporting scripts retain their
bytes. Imported scripts are never executed. The metadata directory names begin
with dots so valid skills named `snapshots` or `checks` cannot collide with them.

Both the owner and souls may import and check: these commands collect content
without activating it. Snapshot files publish read-only (0444, or 0555 when
executable), directories use 0555, and the import manifest is 0444. Recognized
file-write tools are denied access to snapshots and receipts even when
confinement is off; editable payloads retain their normal territory rules.
This cooperative guard does not intercept arbitrary shell commands.

Snapshot bytes are immutable through these commands. Reads verify the snapshot
against its receipt and refuse corrupt records. This is corruption detection,
not protection from another process with the same filesystem account's access
or authority to change permissions. Adoption into a soul must verify again and
use the existing revision authorization.
Editing the local payload never edits its retained upstream snapshot.

## Compare without adopting

`verify` compares the editable payload with its recorded local baseline and
reports `verified` or `drifted`, with added, modified and removed paths. Mode
changes count as modifications. `check` reacquires the recorded local source,
validates and retains a candidate, then reports `unchanged`, `changed` or
`unavailable`. It provides the candidate digest, name and path, an upstream file
comparison, local adaptations relative to accepted upstream, and local drift
relative to the baseline. Text changes include a whole-file unified diff up to
64 KiB total; binary, non-UTF-8 and over-budget files have explicit omission
reasons and remain available in the snapshots.

A source that disappeared, became invalid or exceeded a limit is unavailable.
The check records the reason and retains the accepted snapshot and local edits.
Neither changed nor unchanged results replace the local files, accepted snapshot
pointer or local baseline. The explicit update below affects only the library;
adoption into a soul still goes through its existing revision policy.

All successful output is JSON (pretty by default; compact with `--json`). Exit 0
means the operation succeeded, including a changed candidate. Exit 1 reports
errors, local drift or an unavailable source; exit 2 is incorrect command usage.

## Review and apply a source update

A successful source check returns `checkId`. Select that recorded check for a
read-only three-way preview of accepted upstream, current local files and the
candidate. Preview and apply use retained snapshots; they do not fetch again.

```sh
agent-bot soul skill update UUID --check CHECK_ID --json
agent-bot soul skill update UUID --check CHECK_ID --apply \
  --expected-accepted sha256:ACCEPTED_FROM_PREVIEW \
  --expected-local sha256:CURRENT_LOCAL_FROM_PREVIEW --json
agent-bot soul skill update UUID --recover --json
```

The preview reports per-file decisions, conflicts, upstream differences and
proposed local changes. A file changed only upstream takes the upstream bytes;
one changed only locally keeps the local bytes. Identical results converge.
Different changes on both sides, add/add or delete/modify conflicts refuse the
whole update with `status: conflicted` (exit 1). This is an exact-file merge,
including executable mode, not a text merge: it never inserts conflict markers
or guesses how two edits combine. File/directory and portable-name collisions
also refuse. Resolve conflicting local files deliberately, then preview again.

Apply requires both digests from the reviewed preview. It rechecks under the
same lock as source checking and refuses stale local bytes, an older accepted
snapshot or an unavailable/partial candidate. Excluded local entries, such as
`.git` or `node_modules`, also refuse: move them out deliberately before retrying.
An upstream name change renames the editable directory only when the destination
is free and the merged entrypoint still declares that name.

A successful apply advances the accepted upstream pointer and records the merged
local baseline. It retains the entire previous local directory under
`.updates/<updateId>/previous`, alongside the before/after metadata and result.
Earlier immutable upstream snapshots remain intact. `verify` checks the new
baseline; later source checks still identify local adaptations relative to the
new accepted upstream. There is no automatic pruning of update material.

The update stages bytes and metadata before publishing a pending marker, then
moves the previous payload aside, publishes the candidate, and commits the
manifest pointer. A process interruption after the marker blocks normal library
operations on that import with `skill-update-pending`. Run `update --recover`:
before metadata commit it restores the previous payload; after commit it keeps
the new state. Edits made to an interrupted published payload are retained under
`interrupted-payload` when rolling back; post-commit edits stay live and report
local drift. Unexpected paths, links or altered metadata refuse recovery rather
than overwrite them. Repeating completed recovery reports `clean`. This covers
process interruption; it does not claim power-loss durability or protection from
uncooperative same-account writers.

Library updates require no soul binding, never execute skill contents, and
report `activationChanged: false`. Existing soul packages, harness installations
and schedules are unaffected. Use the learning/revision flow below to adopt
selected updated material into a soul.

## Acquisition and coverage boundaries

Acquisition is bounded to 1,000 regular files, 4,000 directory entries, 32 MiB
total, 8 MiB per file, 64 KiB for `SKILL.md`, and 16 directory levels below the
root. Files and directories named `.git`, `.hg`, `.svn`, `node_modules` or
`.DS_Store` are excluded at any depth. Those exclusions also apply to local
verification: changes inside excluded entries are outside the checksum scope.
Empty directories are not payload files. Library listing is bounded to 1,000
records and 4,000 top-level entries.

Contained symlinks to regular files are materialized and recorded. Root links,
directory links, escaping links, special files, unsafe portable paths and
case/Unicode-normalization collisions are refused. Invalid or oversized imports
publish no UUID record. Source checks stage candidates and serialize receipts
under the import's check lock. A concurrent verification reads only the accepted
snapshot and local payload, which check never replaces. Normal failures clean
the staging; a process killed mid-write may leave a hidden `.import-*` or
`.snapshot-*` directory. Automatic collection of those leftovers is not yet
implemented; listings do not present them as complete records. No shell or imported executable participates.

The initial dependency boundary is `markdown-inline-file-links-v1`: inline
Markdown links in copied `.md` files. Each edge names the importing UUID and
referring file. Local targets present in the acquired payload are captured;
cycles are marked. Missing or escaping targets and recognizable remote
instruction files are unresolved. Other remote references and unsupported
schemes are explicitly external. API limit overrides may only lower the documented bounds. The scan stops after 1,000 references with an
unresolved limit receipt. It is not a full Markdown parser: reference-style
links, HTML, runtime fetches and harness retrieval are outside this boundary.
`universalRetrieval` is always false.

URL user information and query-bearing locators are withheld from dependency
metadata. Imported file contents still preserve the original bytes; this is
not payload secret redaction. Local-directory import never fetches remote links;
the explicit HTTPS-document and public GitHub-directory adapters perform the
bounded remote capture described above. No permission is inferred from a
reference. Other repository adapters and harness installation remain open;
harness retrieval is out of scope, as the next section states.

## Install into a soul

`install UUID|NAME --soul AGENT_ID` copies the library's editable copy of one
import (`<root>/<uuid>/<name>/`) into the soul's own `skills/<name>/`. A name
selects the import only when exactly one import has it. The soul's skill
folder, not a global harness folder, is the default home (owner direction on
#603, 2026-10-09): the agent discloses it progressively and should place it in
a workspace only while it is needed. Global targets (`~/.agent/skills`,
`~/.<harness>/.../skills`) are opt-in and not implemented yet; a skill belongs
there only with a clear reason it must always load.

Install also writes `provenance/skill-installs/<name>.json` in the package. It
records the import UUID, the installed `files` manifest (path to `mode`,
`size`, `sha256`) and its canonical `digest`, exactly as an import records its
local baseline, plus the accepted snapshot digest, the portable source
provenance and any excluded paths. No host path is recorded. Install refuses
when `skills/<name>/` or the record already exists.

`uninstall NAME --soul AGENT_ID` moves `skills/<name>/` to
`archive/skills/<name>/<UTC stamp>/skill/` and its install record (if any) to
`install.json` beside it. Archives sit outside `skills/`, so `soul build`
renders nothing for them, and nothing is deleted. Any skill directory can be
archived, installed or authored. `--trash` instead moves the live
`skills/<name>/` to the OS trash (`~/.Trash` on macOS, the freedesktop.org
trash elsewhere; refused on Windows and across volumes) and removes the
record. It is owner only, and it never holds the skill in a temporary folder:

1. Once the owner gate passes, the skill and its record move to the archive
   folder above and that archive is applied as an owner edit, so the apply
   deletes nothing. If the edit is not recorded, they move back. A crash from
   here on leaves the skill archived, which `soul env clean` never touches.
2. The archive folder then moves to the OS trash as `<name> <stamp>`,
   restorable to its archive path. If that fails, the skill stays archived
   and recorded; the result has `trash: false` and `trashFailed`.
3. An in-place owner edit (the soul folder itself) records the removal. If
   that fails, the error (`skill-trash-unrecorded`) says where the trash
   holds the skill; the archived revision still has its bytes, and the next
   revision edit records the removal.

Both commands stage a `soul revision prepare` copy and record it through the
existing revision path; the soul needs an adopted revision. A caller with no
soul marker is the owner: the change is an owner-gated `soul revision edit
--apply` (Touch ID through keyd, the consent dialog, or `--principal-stdin`)
and is live at once. A soul caller may target only its own Agent ID and
produces a proposal under its `policy.json` (`ask`, `auto` or `never`); the
live package changes only when that revision is applied. The staging is
discarded either way. Prior bytes also stay in the revision history.

Installed skills are ordinary package skills, so `soul build` still renders
them for the soul's harnesses like an authored skill. Progressive workspace
materialization, global opt-in targets and `.gitignore` handling of repo
harness folders are later slices of #603.

## What is not captured

Capture means agent-bot's own commands: `soul skill import`, `check`, `update`
and `learn`, plus the package checksums `soul revision skills` reports. Only
the files those commands acquire are captured, checksummed and rechecked.

Not captured: anything a harness fetches or reads on its own, such as web
fetches, MCP tool results and the harness's own reads of `CLAUDE.md`,
`AGENTS.md` or other instruction files; runtime fetches made while a skill
runs; and references outside the reported dependency boundary above. agent-bot
does not intercept harness retrieval, so a change to such a file never shows
up in `verify` or `check`. Every successful `soul skill` import, list, show,
verify, check, update and learn result, and every `soul revision skills`
result, carries a `notCaptured` statement saying so.

## Learn useful pieces through a soul revision

`learn UUID --soul AGENT_ID` reads the verified accepted snapshot and current
local material, names their separate entrypoints and exact digests, and returns
progressive-consumption guidance. Source content is explicitly untrusted data;
the packet never executes it or treats it as authority. No library metadata is
added to a soul merely by requesting a packet. The command takes an exact Agent
ID, not a census name.

The agent chooses useful pieces, follows their dependencies, and adapts them in
the default staging directory returned by `soul revision prepare AGENT_ID`.
Review copied relative references and deliberate replacements there. The
recording operation accepts only that soul's `.soul-state/tmp/revision-UUID`
location, verifies its marker and current parent, and refuses links. Custom
`prepare --dest` locations are not supported by this recording path.

Record the work in a separate JSON outcome file:

```json
{
  "schemaVersion": 1,
  "parentRevision": "sha256:<current-soul-revision>",
  "source": { "selection": "accepted", "digest": "sha256:<library-snapshot>" },
  "pieces": [
    {
      "source": "references/guide.md",
      "status": "completed",
      "destination": "skills/my-skill/references/guide.md",
      "method": "adapted",
      "reason": "Selected the procedure relevant to this soul."
    },
    { "source": "scripts/tool", "status": "skipped", "reason": "Not needed." }
  ],
  "knowledge": [
    { "capability": "embedding", "status": "blocked", "reason": "No configured adapter; configure an authorized knowledge tool if needed.", "evidence": [] }
  ]
}
```

```sh
agent-bot soul skill learn UUID --soul AGENT_ID \
  --package /absolute/path/from/prepare \
  --outcome /absolute/path/to/outcome.json --reason 'Learn selected procedures' --json
```

The CLI requires the caller's existing binding to name that soul. Library
imports and read-only learning packets do not require a binding. Hosts calling
the mechanism API must authenticate the proposer, as for `soul-revisions`.

`source.selection` is `accepted` or `local`; both require the exact digest from
the packet. A changed local payload refuses until it has been reviewed again.
A source-check candidate is not implicitly accepted. The outcome is bounded to
256 KiB, 128 distinct source pieces and 16 knowledge outcomes. Piece status is
`completed`, `skipped` or `blocked`. A completed destination must be a regular
file under a named `skills/<name>/` in the candidate. `copied` verifies exact
bytes and executable mode; `adapted` records the destination bytes and the
agent's mapping without claiming semantic equivalence. Skipped and blocked
pieces cannot claim destinations. Notes must not contain secrets.

Recording copies the candidate into private staging and adds
`provenance/skills/<library-uuid>/learning.json`. The receipt carries the library
UUID, source digests, source-to-destination mapping, exact destination hashes and
modes, and explicit knowledge outcomes. It omits the host's source directory.
Selected original bytes and their captured dependency closure are retained at
`provenance/skills/<uuid>/sources/<digest>/<source-relative-path>`; local
adaptations also retain the corresponding accepted originals. No mutable
library symlink enters the package. Captured dependencies describe retained
source bytes; the agent must still review references in its adapted destination.
Unresolved/external dependencies and the absence of universal interception stay
explicit. No remote fetch or instruction execution occurs during learning.

New learning receipts use schema version 2. `source.provenance` is a versioned,
bounded projection of the accepted library snapshot: its digest and capture
timestamp, the original HTTPS source URL, original and resolved URLs for each
retained accepted file, file hashes and modes, and the repository selector,
commit, tree and blob hashes when captured from GitHub. Only those named fields
are copied; local paths and arbitrary library metadata are omitted. Local
imports retain `source: {kind: "local"}` without their host directory. The
provenance digest always names the accepted snapshot, including when
`source.selection` chooses a local adaptation with a different digest. It does
not attribute adapted bytes to the remote origin. Receipt readers check the
recorded accepted file hashes and modes against the retained package bytes.

Version 1 receipts remain readable with their original missing provenance;
relearning creates a new version 2 receipt without rewriting older revisions.
The stored origin evidence survives loss of the local library. Origin metadata
alone grants no fetching or adoption authority. The existing 256 KiB receipt
limit includes this provenance, so extensive remote metadata can exceed the
limit even when an older version 1 receipt for the same files would fit.

### Recheck a portable soul's sources

```sh
agent-bot soul skill check IMPORT_UUID --soul AGENT_ID --json
```

This explicit operation requires the caller's binding to name the soul. It reads
that soul's accepted revision and learning receipt, then reuses the bounded
HTTPS/GitHub fetcher without consulting the original local library. The result
names the accepted package revision, receipt digest and accepted upstream digest.
It reports `unchanged`, `changed` or `unavailable`, and writes a version 1 check
record under the soul's `.soul-state/tmp/skill-check-*/`. Available capture bytes
are kept in `payload/` with their acquisition `manifest.json`; `check.json`
records the comparison. The returned `staging` path is temporary review data,
not an accepted package revision or a durable history of checks.

The full upstream digest comparison is separate from file-level comparisons:
only retained accepted files have old bytes available for a diff. Candidate
files outside that baseline are labeled `unbaselined`, never proven additions.
Text diffs use whole-file replacement hunks and share a 64 KiB output budget;
binary, non-UTF-8 and larger changes remain visible through hashes, modes and
candidate bytes. Failed root fetches
write an unavailable check without a candidate. An incomplete dependency capture
keeps its partial candidate for diagnosis but also reports `unavailable`. Retained
files missing from a partial candidate are `uncaptured`, with no deletion diff;
only a complete candidate can classify missing retained files as `removed`.
Version 1 receipts and local-source receipts report unavailable without fetching
or guessing host paths. None of these outcomes changes accepted captures,
adapted skills, the live package or revision history.

The candidate uses the existing acquisition bounds and a 4 MiB metadata limit;
checks use the same 4 MiB JSON bound. The check itself adopts nothing and
grants no bypass of the revision/proposal policy; see the next section.
Readers also verify Git blob hashes against retained bytes and reject a legacy
`source.repository` alias that contradicts version 2 `source.provenance`.

### Apply a reviewed portable candidate

```sh
agent-bot soul skill learn IMPORT_UUID --soul AGENT_ID --candidate CANDIDATE_DIGEST \
  --package /absolute/path/from/prepare \
  --outcome /absolute/path/to/outcome.json --reason 'Apply reviewed source update' --json
```

This is the learning recording operation with a different source of bytes.
Review the check's `payload/`, prepare this soul's default staging with
`soul revision prepare AGENT_ID`, and adapt or copy the pieces you want there.
The outcome file is the same schema; its `source` must be
`{"selection": "accepted", "digest": CANDIDATE_DIGEST}`, and its pieces name
paths in the candidate. Local adaptations are a library concept and are not
selectable here.

The staged check bytes are review data only. Recording reads the soul's
current receipt, fetches its HTTPS source again with the same bounded
acquisition, and refuses unless the capture is complete and its digest equals
`--candidate` (`skill-source-changed`, `skill-capture-incomplete`). A version 1
or local-source receipt refuses without fetching. The CLI requires the caller's
binding to name the soul before any fetch. Nothing the soul could edit in its
temporary state becomes provenance.

The resulting version 2 receipt records the candidate as the soul's accepted
source: `source.acceptedDigest` and `source.provenance` name the candidate and
its origin metadata, and the selected candidate bytes are retained under
`provenance/skills/<uuid>/sources/<candidate-digest>/`. The receipt format is
unchanged. The previous capture set leaves the current package as described
below and stays in the prior revision. After the revision is applied, a new
portable check compares against the candidate.

The proposal uses the same expected-parent, ask/auto/never and exit-status rules
as other learning (below). Nothing is applied to the live package, and the local
library is neither required nor changed. When the library still holds the
import, the library route remains `check`, `update --apply` with reviewed
digests, then `learn` from the updated accepted snapshot.

One current receipt/capture set per import replaces that import's prior set in
the private candidate. Each source inventory retains the library's file/byte
bounds; old sets remain addressable in prior soul revisions, rather than growing
a second receipt history inside the current package. Unmanaged content at that
provenance destination is a conflict. Previous learning in the packet scans at
most 20 accepted revisions, deduplicates unchanged receipts, and reports
truncation. Destination hashes are checked in the named revision; this is not
evidence of a live harness loading those files.

The completed candidate goes through `proposeSoulRevision` with the expected
parent under its existing lock. Ask/auto/never policies and sensitive-file review
rules apply to the **entire candidate diff**, including unrelated edits already
present in staging. A stale parent refuses. The source staging, library and live
package remain unchanged, including when a policy auto-accepts a revision.
Apply an accepted revision through the existing owner-authorized revision flow;
learning does not bypass that step. Rejected proposals return exit 1; pending or
approved proposals return exit 0 with their explicit status.

Knowledge capabilities start as `unknown` with `no-capability-adapter`. Outcomes
may say `reported-completed`, `skipped` or `blocked`; reported completion needs
one or more existing package-file evidence paths. The runtime hashes those
evidence files but labels the external operation **agent-reported**. It does not
claim verified embedding, indexing, graph updates or retrieval, and provisions
no service or maintenance schedule. Retrieval adapters and verified
semantic-processing coverage, including memory and conversation inputs, remain
open requirements in #603. Daemon scheduling and owner controls are implemented;
see [Implemented scheduling core](soul-skill-dream-design.md#implemented-scheduling-core).

Learning receipts enumerate retained source paths, byte hashes and modes. Relearning refuses extra or changed provenance material, including material beside an otherwise valid receipt. Read-only learning history reports malformed receipts as `invalid-receipt` and continues; recording still refuses an invalid current candidate receipt. Default prepared paths may traverse an alias of the soul root, but staging leaves and internal state directories must remain real directories.
