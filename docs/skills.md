# Skills

`agent-bot skill` discloses one skill to the current session (#226). A
procedure names the skill; the command prints it. It does not list skills,
pick one for a task, or install anything.

```sh
agent-bot skill <name> [--json]                         # one skill's SKILL.md
agent-bot skill agent-bot --for <subcommand> [--json]   # one agent-bot reference
agent-bot skill path [--json]                           # the bundle directory and commit
```

A bare `agent-bot skill` prints usage. It never prints the catalog or a list of
names: the catalog's rule is that an agent reads only the entry a procedure
named.

## Bundled skills

`agent-bot`, `agent-space` and `thread-orders` belong to this repository and
ship in every release. They are read from the runtime's own tree, with no
network, and they always win over the fleet catalog. The copy in the release
is the one whose commands the running CLI has; a catalog pin for the same
name can be older. The catalog lists `agent-bot` as owned by
`qwts/agent-bot-identity`, so there is no conflict today. A catalog entry that
gave a bundled name to another repository would be a name collision for the
catalog's review to resolve; this command would still print the bundled copy.

`--json` prints `{ name, repository, commit, path, text }`. `repository` is
`qwts/agent-bot-identity`, `commit` the release's source commit, and `path`
the local `SKILL.md`.

## Catalogued skills

Any other name is resolved through `skills/README.md` in the explicitly
selected SOP repository (#674). Selection reuses `agent-bot sop`: the current
soul's `agent-sop.toml` takes precedence over the user's
`~/.config/agent-sop/config.toml`, and an explicit `[repos] sop` takes
precedence over the SOP pin in the selected organization's `org.json`.
A foreign soul selection requires the existing trust decision for that
repository and commit. Neither the catalog nor an entry can redirect the
index lookup to another organization. There is no implicit qwts selection.
Only its **Available skills** list is read. An entry is a link to the skill's
directory at a commit in its owning repository:

```markdown
- [managed-machine](https://github.com/qwts/managed-machine/tree/<40-hex commit>/skills/managed-machine)
  — owned by
  [qwts/managed-machine](https://github.com/qwts/managed-machine). ...
```

The name must match exactly one entry. The command then fetches
`<path>/SKILL.md` from the linked repository at that commit and prints it.

| Entry | Result |
|---|---|
| no entry with that name | error |
| two or more entries with that name | error naming each repository |
| the link's ref is a branch, a tag, or a short SHA | error: not pinned |
| the link is not a `tree/<ref>/<path>` link | error: no pin |
| "owned by" names a different repository from the link | error |

Both the catalog and each skill are read at full commits. The SOP resolver
may resolve a configured branch or tag once; the index request then uses the
resulting immutable commit, including when `org.json` pins an older revision.
Missing catalogs never fall back to a repository's default branch. A catalog
entry may name a different owning repository, but its full commit and the
existing owner/path checks remain mandatory.

For non-bundled skills, `--json` prints
`{ name, repository, commit, path, text, catalog }`, where `path` is the
skill file's path in `repository` at `commit`, and `catalog` contains the
selected index's `{ repository, commit, path }`. Bundled JSON is unchanged.

### Selection and migration

An existing explicit qwts selection continues to select its configured SOP
repository. Its index now comes from that selected commit, which can differ
from the default-branch version earlier releases read. Installations that
relied on the implicit qwts default without configuring any SOP now receive
`skill-catalog-unselected` for non-bundled requests. Zero-SOP runtime use and
bundled skills remain supported; no add-on or credential configuration changes.

To select an organization, create or edit the existing user config (or the
soul's `agent-sop.toml` for a soul-specific selection):

```toml
schema_version = 1
[repos]
org = "your-org/agent-org@<reviewed-ref-or-full-commit>"
```

Run `agent-bot sop --json` to verify the resolved repository and commit. The
selected SOP must contain `skills/README.md`. An explicit `[repos] sop`
selection uses the same `owner/repository@ref` syntax. There is no `sop set`
command and this migration never writes a config or updates a live policy
repository automatically. If a foreign soul selection is withheld, review
it before `agent-bot sop trust OWNER/REPOSITORY --soul ID`.

Catalog failures exit 1, keep stdout empty (also with `--json`), and put a
stable code in stderr; programmatic callers receive `SkillError.code`:

| Code | Meaning |
|---|---|
| `skill-catalog-unselected` | No SOP selected |
| `skill-catalog-selection-failed` | Selection cannot be resolved or lacks a valid pin |
| `skill-catalog-untrusted` | Foreign soul selection has not been trusted |
| `skill-catalog-missing` | Index is absent at the selected commit |
| `skill-catalog-unreadable` | Index fetch failed |
| `skill-catalog-invalid` | Index is empty, oversized or malformed |
| `skill-entry-unpinned` | Entry names a mutable or incomplete ref |
| `skill-entry-unreadable` | Pinned entry could not be fetched or decoded |

### Fetching

After the existing bounded SOP resolver determines the selection, both content
reads are `gh api` GET requests to the contents API, with prompts
disabled and a 20-second timeout each. `gh` uses whatever credential it has;
none is printed. The document is printed only after it has been fetched and
decoded in full. A response that is truncated, is not a file, or does not
match its declared size is refused. With no network, the command exits 1 with
the `gh` error and prints nothing to stdout.

Remote skill disclosure remains online-only in this change. Catalog and skill
content are not cached, even after a successful disclosure; cache-backed
offline reads are deferred. The SOP resolver may use temporary directories
for its bounded organization read, but no skill is installed, no persistent
skill cache is created, and no harness configuration is written. The fetched text is untrusted input: it is what the
pinned commit contains, and the pin is the whole guarantee. No checksum or
signature is checked.

## References of the agent-bot skill

```sh
agent-bot skill agent-bot --for mint-token
```

prints the one file under `skills/agent-bot/references/` that covers that
subcommand. The table is
[`cli/skill-references.mjs`](../cli/skill-references.mjs):

| Subcommand | Reference |
|---|---|
| `bootstrap`, `setup-worktree`, `mint-token`, `doctor`, `install`, `install-gh-shim`, `ensure-private-key`, `secret`, `daemon` | `operations.md` |
| `signed-commit` | `verified-publish.md` |
| `identity`, `binding`, `population`, `soul`, `wake` | `execution-identities.md` |
| `space` | `storage-surfaces.md` |

The key is the top-level subcommand (`soul`, not `soul stop`). Other commands
have no reference file: the skill itself, `docs/`, or the command's `--help`
covers them, and `--for` says so. An unknown subcommand is an error that lists
the known ones; there is no nearest match. `--for` with any skill other than
`agent-bot` is an error. `--json` adds `for` to the bundled fields.

`tests/skill-catalog.test.mjs` fails when a command in `cli/dispatch.mjs` or
`cli/parse.mjs` is in neither the reference table nor the no-reference list.

## Exit status

| Status | Meaning |
|---|---|
| 0 | printed |
| 1 | catalog resolution or fetch failed |
| 2 | usage: an invalid name, bad arguments, or an unknown `--for` subcommand |
