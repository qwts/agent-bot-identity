# Soul packages, format 1

A soul package is a portable definition, not a running soul or its memory.
This specifies ADR-0275 decisions 1–3 for issue #283. Nothing in a package
executes during validation or grants authority. No organization or harness is
required. Revision history storage, installation, approval, and runtime adoption
belong to later work.

## Layout

A document package is a directory conventionally named `NAME.soul`. The suffix
is a presentation convention, not a validation requirement. macOS hosts may
register it as a document package. Other platforms use the same directory. A
zip may transport that directory; unpack it before validation. Archive handling
is outside this command.

```text
example.soul/
  soul.json                 required UTF-8 JSON manifest
  AGENTS.md                 required UTF-8 instructions (may be empty)
  skills/                   optional
    example/
      SKILL.md              required for each immediate skill directory
      scripts/              optional supporting files
      references/           optional supporting files
      assets/               optional supporting files
  tools.json                optional tool configuration request
  mcp.json                  optional MCP server configuration request
  policy.json               optional self-change policy
  ...                       preserved extensions and arbitrary binary assets
```

Only `soul.json` and `AGENTS.md` are required. Tool, MCP and policy files are
opaque in format 1: this validator neither interprets nor authorizes them.
Their execution and policy schemas belong to their respective consumers. In
particular, absence of a policy does not authorize automatic self-modification
(ADR-0275 defaults to asking). Memory belongs in Agent Space, not this package.

Skills follow the open Agent Skills directory layout. `SKILL.md` begins with
`---`, YAML front matter, and a closing `---`, on separate lines (LF or CRLF).
Required fields are `name` (1–64 lowercase ASCII letters/digits, with single
interior hyphens, matching its directory) and `description` (nonempty, at most
1024 characters). The format-1 validator supports required string fields as
plain single-line scalars, single/double-quoted single-line scalars, or literal
and folded block scalars (`|`, `>`, optionally `+`/`-`). Unknown front-matter
fields are opaque. It does not implement general YAML tags, aliases, or flow
collections for these two fields. Supporting files and unknown files directly
under `skills/` are retained. Every immediate directory under `skills/` is a
skill and must contain `SKILL.md`.

## Manifest schema

All these fields are required; unknown fields are allowed and retained:

| Field | Type and constraint |
| --- | --- |
| `formatVersion` | Integer, exactly `1`; other versions are rejected |
| `name` | Nonempty string, human-readable package name |
| `description` | Nonempty string |
| `displaySeed` | Nonempty string; an opaque stable display seed, not an identity |
| `preferredHarnesses` | Array of unique nonempty strings; `[]` means no preference; no registry lookup |
| `revision` | `sha256:` followed by exactly 64 lowercase hexadecimal digits |
| `parentRevision` | Same hash syntax, or `null` for the first revision |

Nonempty means not blank after ECMAScript `trim()`. For example:

```json
{
  "formatVersion": 1,
  "name": "Example",
  "description": "A portable assistant definition",
  "displaySeed": "example",
  "preferredHarnesses": [],
  "revision": "sha256:0000000000000000000000000000000000000000000000000000000000000000",
  "parentRevision": null
}
```

The zero hash above is a construction placeholder, not a valid revision for
this example. Authors compute the revision and then replace that field. The
exported `computePackageRevision(PATH)` accepts a syntactically valid placeholder;
`validateSoulPackage(PATH)` also checks equality with the computed revision.
Neither writes files. The parent must be set before computing a revision. The
validator checks its syntax, not existence or ancestry. Immutability and chain
storage must be enforced by future revision writers: edits, including undo,
create a new revision with the previous revision as parent.

## Canonical revision encoding

The ID is `sha256:` plus the lowercase SHA-256 digest of the following bytes:

1. ASCII `agent-bot-soul-package-v1` followed by one NUL byte.
2. A netstring containing the parent revision's ASCII bytes, or an empty
   netstring (`0:,`) for `null`.
3. For **every** entry beneath the root, in sorted order, three netstrings:
   relative path, normalized mode, and content bytes.

A netstring is ASCII decimal byte length (no leading zero except `0`), `:`,
exactly that many payload bytes, then `,`. There are no additional separators,
line endings, or entry count. Framing makes arbitrary binary content unambiguous.

Paths are relative to the root, with `/` between components and no leading or
trailing slash. Components must be valid UTF-8 and are normalized to Unicode
NFC. Backslashes and ASCII control characters U+0000–001F and U+007F are
rejected. Normalized path collisions are rejected. Sort the entire list by
unsigned UTF-8 byte comparison, case sensitively, not locale order or traversal
order. The root's name/path is excluded. Case-only names may not transport to
case-insensitive filesystems; producers should avoid them.

Directories, including empty ones, have mode ASCII `040000` and zero content
bytes. Regular files have mode `100755` if any POSIX execute bit is set,
otherwise `100644`. All other permission bits, ownership, timestamps, extended
attributes, and the root mode are excluded. Transfers must preserve the execute
bit distinction. Symlinks (including the package root) and all non-regular,
non-directory entries are rejected, never followed or silently skipped. Validate
a quiescent directory; concurrent writers are not supported.

File content is exact bytes, except `soul.json`. Parse that file as UTF-8 JSON
using ECMAScript JSON semantics (binary64 numbers; duplicate keys use their last
value). Nonfinite numbers are rejected. Remove only its top-level `revision`
and `parentRevision` properties. Serialize recursively: object keys sort by
UTF-16 code unit order; arrays retain their order; keys and scalar values use
ECMAScript `JSON.stringify` encoding; use commas and colons without whitespace.
Encode the resulting string as UTF-8, without BOM or final newline. Unknown
manifest properties participate. This avoids a self-referential hash and makes
manifest whitespace/key ordering irrelevant. The parent participates exactly
once, in step 2. Other files, including JSON extensions and SKILL.md, receive no
text normalization. Changing their whitespace or line endings changes the hash.

`tests/fixtures/soul-package/vectors.json` contains portable fixture recipes
(path, mode, base64 bytes), exact canonical preimages in base64, and expected
revision IDs. Fixtures include a first revision, a parent-only change, and
extensions/binary/executable/empty-directory content. Tests verify the fixed
preimages and digests, not just two calls to the implementation.

## Unknown content and validation

Every tool that reads/writes/copies a package **must preserve unknown files,
unknown manifest fields, and directories**, with their bytes and normalized
modes. There is no ignore list, including for dotfiles. An unknown file affects
the hash just like a known one. No future tool may strip extensions when
round-tripping a package. The validator is read-only, including on failure;
this issue supplies no copying or editing tool.

Run `agent-bot soul pack validate PATH`. Success exits 0 and prints one JSON
object with `formatVersion`, `revision`, and `parentRevision`. Invalid packages,
unreadable paths, unsupported versions, hash mismatches, or bad command syntax
exit 1 with a diagnostic on stderr. Validation uses no credentials, SOP,
network access, or runtime identity. Optional configuration is never executed.

## Issue #283 closeout — solution as built

`soul-package.mjs` implements validation and exports canonical-byte and hash
functions for later consumers. `cli/dispatch.mjs` routes the new command while
retaining cold-wake dispatch. Node built-ins provide filesystem access, JSON,
and SHA-256; there are no npm dependencies. Tests cover manifest/layout errors,
fixed hash vectors, normalization and mode semantics, unknown content, read-only
behavior, and CLI outcomes. No runtime consumes packages yet.

ADR decisions 1–3 are retained. Format details not fixed by the ADR are resolved
above. General YAML parsing and zip extraction are intentionally not implemented;
the supported required-field YAML forms are explicit. Policy/tool interpretation,
history enforcement, and host document registration remain with sibling work.
