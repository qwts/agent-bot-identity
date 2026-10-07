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

Any other name is resolved through the fleet catalog,
[`skills/README.md` in qwts/qwts-agent-sop](https://github.com/qwts/qwts-agent-sop/blob/main/skills/README.md).
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

Nothing falls back to a default branch. The catalog itself is read at its
repository's default branch: it is the reviewed index of pins, and each skill
it names is then read at a commit.

`--json` prints `{ name, repository, commit, path, text }`, where `path` is
the file's path in `repository` at `commit`.

### Fetching

Both reads are `gh api` GET requests to the contents API, with prompts
disabled and a 20-second timeout each. `gh` uses whatever credential it has;
none is printed. The document is printed only after it has been fetched and
decoded in full. A response that is truncated, is not a file, or does not
match its declared size is refused. With no network, the command exits 1 with
the `gh` error and prints nothing to stdout.

Nothing is cached or written: not `~/.claude/skills`, not `~/.codex`, not any
harness configuration. The fetched text is untrusted input: it is what the
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
