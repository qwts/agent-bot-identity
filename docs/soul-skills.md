# Skill library

The library collects a skill independently of a soul, retaining the acquired
bytes and provenance separately from an editable copy. Importing does not run
scripts, activate a harness skill, select an SOP, or create a soul revision.
This implements local-directory and HTTPS-document acquisition and comparison
for #603/#312. Learning guides selected adaptations through the existing soul
revision/proposal policy. Repository directory adapters, source-update adoption,
installation and dreaming remain separate work.

```sh
agent-bot soul skill import /path/to/skill --json
agent-bot soul skill import /path/to/skill/SKILL.md --json
agent-bot soul skill import https://example.com/skills/demo/SKILL.md --json
agent-bot soul skill list --json
agent-bot soul skill show UUID --json
agent-bot soul skill verify UUID --json
agent-bot soul skill check UUID --json
agent-bot soul skill learn UUID --soul AGENT_ID --json
```

A source is a real local directory containing `SKILL.md`, or that file itself.
The entrypoint uses the same UTF-8/frontmatter/name/description validation as a
soul package. Its frontmatter name determines the editable directory's name;
the source directory need not have that name. Each import receives a new UUID,
even for the same name and bytes. There is no implicit deduplication or update.
These operations require neither a GitHub App nor a soul binding.

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
a server response. Source root links, repository-directory URLs, arbitrary
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

Document attempts include DNS/connection failures; repeated failed locators are
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
- `.checks/<uuid>.json` records each successful or unavailable source check. Receipts are append-only;
  automatic retention/pruning is not implemented, so repeated checks grow this directory.

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
or authority to change permissions. Later adoption must verify again and use
the existing revision authorization.
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
pointer or local baseline. Later adoption must go through the soul revision
policy; this library does not introduce a second soul revision history.

All successful output is JSON (pretty by default; compact with `--json`). Exit 0
means the operation succeeded, including a changed candidate. Exit 1 reports
errors, local drift or an unavailable source; exit 2 is incorrect command usage.

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
only the explicit HTTPS-document adapter performs the bounded capture above.
No permission is inferred from a reference. Repository adapters, broader
retrieval interception, update adoption and harness installation remain open.

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
no service or maintenance schedule. Capability adapters and dream scheduling
remain open requirements in #603.

Learning receipts enumerate retained source paths, byte hashes and modes. Relearning refuses extra or changed provenance material, including material beside an otherwise valid receipt. Read-only learning history reports malformed receipts as `invalid-receipt` and continues; recording still refuses an invalid current candidate receipt. Default prepared paths may traverse an alias of the soul root, but staging leaves and internal state directories must remain real directories.
