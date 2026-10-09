# Soul packages, formats 1 and 2

A soul package is the portable definition inventory. A living `.soul` root can
also contain memory and other working state under
[ADR-0583](decisions/ADR-0583-the-soul-root-owns-the-environment.md); physical
containment does not put that state into the format-2 definition inventory.
This specifies ADR-0275 decisions 1–3 (#283) and ADR-0332 decision 4 (#341). Nothing in a package
executes during validation or grants authority. No organization or harness is
required. Revision history and approval are described in [soul-revisions.md](soul-revisions.md).

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
  hooks/<event>/<name>      optional executable hooks, rendered by soul build (soul-builder.md)
  tools.json                optional tool configuration request
  mcp.json                  optional MCP server configuration request
  policy.json               optional self-change policy
  bin/                      tools; changes always require user approval
  workflows/                package workflows
  sop/                      optional carried SOP
  agent-sop.toml             optional SOP selection
  worktrees/                working state (ignored in format 2)
  .soul-state/              working state (ignored in format 2)
  .claude/ .codex/ …         generated harness output (exact build matches ignored in format 2)
  ...                       preserved extensions and arbitrary binary assets
```

Only `soul.json` and `AGENTS.md` are required. Tool, MCP and policy files are
opaque in both package formats: this validator neither interprets nor authorizes them.
Their execution and policy schemas belong to their respective consumers. In
particular, absence of a policy does not authorize automatic self-modification
(ADR-0275 defaults to asking). Memory belongs in Agent Space, which ADR-0583
places under the soul root but outside the format-2 definition inventory.
Format 1 keeps its original all-entry behavior; do not add living state to it
and assume the format-2 exclusions apply.

Skills follow the open Agent Skills directory layout. `SKILL.md` begins with
`---`, YAML front matter, and a closing `---`, on separate lines (LF or CRLF).
Required fields are `name` (1–64 lowercase ASCII letters/digits, with single
interior hyphens, matching its directory) and `description` (nonempty, at most
1024 characters). The validator supports required string fields as
plain single-line scalars, single/double-quoted single-line scalars, or literal
and folded block scalars (`|`, `>`, optionally `+`/`-` and an indentation
digit), each optionally followed by a ` #` comment. Block scalars are dedented,
folded, and chomped as YAML defines before the length check. Unknown front-matter
fields are opaque. It does not implement general YAML tags, aliases, or flow
collections for these two fields. Supporting files and unknown files directly
under `skills/` are retained. Every immediate directory under `skills/` is a
skill and must contain `SKILL.md`.

## Manifest schema

All these fields are required; unknown fields are allowed and retained:

| Field | Type and constraint |
| --- | --- |
| `formatVersion` | Integer, `1` or `2`; other versions are rejected |
| `name` | Nonempty string, human-readable package name |
| `description` | Nonempty string |
| `displaySeed` | Nonempty string; an opaque stable display seed, not an identity |
| `preferredHarnesses` | Array of unique nonempty strings; `[]` means no preference; no registry lookup |
| `revision` | `sha256:` followed by exactly 64 lowercase hexadecimal digits |
| `parentRevision` | Same hash syntax, or `null` for the first revision |
| `ignore` | Required only in format 2: the exact ignore contract below |

Optional fields with a meaning:

| Field | Type and constraint |
| --- | --- |
| `appearance` | Optional closed object `{ "hue": 0 }`. `hue` is required when the object is present and must be an integer from 0 to 359; no other keys are accepted. Errors name the path, for example `soul.json appearance.hue must be an integer from 0 to 359`. Absent means GeniusBar derives the avatar colour from the Agent ID. Template instances copy the declaration. |
| `skills` | Optional closed object `{ "disabled": ["name", …] }`. `disabled` is required when the object is present and lists unique skill names in the skill directory grammar (lowercase letters, digits and single hyphens, 1–64 characters); no other keys are accepted. Each named skill is switched off: `soul build` renders no `.claude/skills/<name>/` (and no Gemini copy, nothing for any harness) while the `skills/<name>/` directory and its files stay in the package untouched, so the Customize dialog (GeniusBar#64) can switch a skill off and on again without deleting it. A name no `skills/<name>/` directory matches validates (the package may gain the skill later) and `soul profile` reports it under `errors`. SOP-sourced skills are not subject to the declaration. `soul profile` reports `enabled` on every skill row and the declaration as `profile.skillsDisabled`. Like every soul.json key, it participates in the revision. |
| `harness` | Optional shared harness settings object. Only `model` (nonempty string), `reasoningEffort` (`low` / `medium` / `high`), `permissionMode` (`safe` / `autopilot`), `env` (`NAME: "value"` strings; secret-looking names and values are refused) and `permissions` (`allow` / `deny` lists of `Tool` / `Tool(pattern)` rules) are accepted; see [soul-builder.md](soul-builder.md#settings-379). |
| `harnesses` | Optional object of per-harness settings overrides, each with the same fields as `harness`. Names: `claude`, `codex`, `gemini`, `opencode`, `cursor`, `copilot`, `devin`, `muse`, `kiro`. Overrides replace declared fields and inherit omitted defaults; `env` merges per variable and `permissions` replaces only the lists it declares. Unknown names/keys and bad values are validation errors with their path, including unsupported settings. |
| `comms` | Boolean. agent-comms is part of every soul; `false` withholds the teammate tools (`fleet`, `send_message`) from the soul's daemon turns. Absent means `true`. Read when the soul is launched, so a hand edit applies from its next launch; `agent-bot soul comms <soul> on|off` changes it (and the census) while the soul is stopped, and a launch request may set it. Template instances copy it. |
| `credentials` | Optional. `{ "github": { "app": "<slug>", "store": "keychain" \| "file" } }` names the GitHub App the soul acts as and where its key lives; `store` defaults to `keychain` on macOS and `file` elsewhere. Only these keys are accepted, so key material can never be put here. The key itself lives in the soul's store, never in the package. Template instances copy the declaration, not the key. See [soul credentials](soul-credentials.md). |
| `previousNames` | Optional array of unique nonempty strings on a template: the names it went by, so an instance spawned under an earlier name still finds it after a release renames it (`"name": "Genius", "previousNames": ["Starter"]`). Not copied to instances. See [soul templates](soul-templates.md#name-provenance-and-the-template-rename). |
| `maintained` | Optional array of unique path prefixes on a template: the paths it maintains in its instances (`["docs/guide/", "skills/"]`). Relative, no `.` or `..` components, never `soul.json` or working state; a trailing slash names a directory and everything in it, a bare path one file. `soul template refresh` replaces exactly these paths in an instance from the template. Not copied to instances. See [soul templates](soul-templates.md#maintained-files-and-refresh). |
| `templateName` | Optional nonempty string on an instance: the template's `name` when it was spawned (`soul spawn` records it). |
| `nameSource` | Optional, `template` or `user`, on an instance: whether the owner kept the template's name at spawn or chose one. The rename migration changes a `template` name and never a `user` one. |

See [builder settings](soul-builder.md#settings-379) for a declaration, native mappings, and unsupported-setting reports. The owner’s launch-time `soul model` / `soul mode` / GeniusBar selection takes precedence over the package; the full order, and the owner's decision before a loosening, are in [settings precedence](soul-builder.md#settings-precedence). Omitting both settings objects preserves existing behavior; unrelated unknown top-level fields remain allowed.

GeniusBar's Customize dialog saves appearance through the existing
`soul revision edit … --apply` path. The whole package, including `soul.json`,
is validated and its revision recomputed before publication; an invalid hue
refuses the save. No separate appearance write command is needed.

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
validator checks its syntax, not existence or ancestry. The
[revision writer](soul-revisions.md) enforces immutable snapshots and the chain:
edits, including undo, create a new revision with the previous revision as parent.

## Format 2 working state and compatibility

Keep packages with no working state on format 1 when they need to work with
older agent-bot versions. Format 1 is unchanged: every entry participates,
including unknown files and dotfiles, and existing hashes stay identical.
There is no automatic upgrade. Before adding working state, explicitly set
`formatVersion` to `2`, add the following `ignore` object, and recompute the
revision (or submit the format change as an owner-reviewed revision):

```json
"ignore": {
  "directories": ["worktrees/", ".soul-state/"],
  "generatedPaths": [
    ".claude/", ".codex/", ".cursor/", ".opencode/", ".devin/", ".gemini/",
    ".github/copilot-instructions.md", ".mcp.json", "CLAUDE.md", "GEMINI.md",
    "opencode.json", ".github/hooks/agent-bot-soul.json"
  ],
  "generatedMarker": "<!-- agent-bot soul-builder: generated -->"
}
```

The contract is fixed for format 2, exported as `PACKAGE_IGNORE_LIST` from
`soul-package.mjs`, and validated exactly (object key order is immaterial;
array order matters). It is part of the canonical manifest bytes. Producers
such as soul-builder use `GENERATED_HARNESS_PATHS` and
`GENERATED_HARNESS_MARKER` from the same module. The marker is informational;
it never authorizes ignoring a file. `.mcp.json` and `opencode.json` joined the
list with the soul builder's MCP entry (#378); `.codex/config.toml` and
`.gemini/settings.json` were already covered by their directory prefixes.
`.github/hooks/agent-bot-soul.json`, Copilot's soul hook file, was appended with
soul-declared hooks (#378); `.claude/settings.json`, `.codex/hooks.json` and
`.cursor/hooks.json` were already covered. The list is exact, but a list an
earlier release wrote (`PRIOR_PACKAGE_IGNORE_LISTS`) is still accepted, so an
older soul validates without a refresh; any other list is refused.

Only root-relative `worktrees` and `.soul-state` entries are skipped, before
stat, symlink, special-file, or descendant validation. Nested entries with
these names remain package content. Generated paths ending in `/` cover files
beneath that top-level folder; other paths name individual aliases. A regular
file there is ignored only when its bytes exactly match the expected soul-builder
output for this package. `expectedGeneratedFiles(packageEntries)` derives that
output from non-generated package entries through the pure
`buildHarnessFiles` renderer. See [soul-builder](soul-builder.md) for aliases,
skill copies, MCP entries, merges, safe writing and
`agent-bot soul build [PATH] [--check] [--json]`. A marked file that does not match is ordinary package content:
it affects the revision and appears in snapshots and proposal diffs. Hand-authored
files and unknown files remain covered. Generated symlinks are rejected; builders
must write regular alias files.

Directories containing only ignored generated files are omitted recursively.
Mixed directories retain their authored files and container entries. Truly
empty directories still participate, as in format 1. Validation leaves all
working state in place; revision snapshots and diffs use the same filtered
inventory and do not copy ignored state into stored package objects.

`bin/`, `workflows/`, `sop/`, and `agent-sop.toml` participate in both formats.
Every `bin/` change, including deletion or execute-bit changes, requires the
existing user approval path, even under an auto policy allowing `**`.

Older agent-bot versions reject format 2 as unsupported; they cannot validate
or revise it. The unknown-file preservation rule does not imply support for
an unknown format version. They continue to handle unchanged format 1 packages
normally. Downgrading a package containing working state would hash that state
(and may reject its links); it is not a compatibility workaround.

## Canonical revision encoding

The ID is `sha256:` plus the lowercase SHA-256 digest of the following bytes:

1. ASCII `agent-bot-soul-package-v1` (format 1) or
   `agent-bot-soul-package-v2` (format 2), followed by one NUL byte.
2. A netstring containing the parent revision's ASCII bytes, or an empty
   netstring (`0:,`) for `null`.
3. For every included entry beneath the root (after format 2 ignores), in
   sorted order, three netstrings:
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
non-directory entries are rejected in package content, never followed. Format 2
working-state entries are excluded before these checks. Validate
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
modes. Format 1 has no ignore list, including for dotfiles. Format 2 excludes
only the working state and generated files matching the build output specified above. Every other
unknown file affects the hash just like a known one. No future tool may strip extensions when
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
