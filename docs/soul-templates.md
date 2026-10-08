# Soul templates

An ordinary valid soul package can be used as a template. The optional
`"template": true` field in `soul.json` marks its intended use; it is not
required or an authority grant. Unknown manifest fields survive copying,
including when read by older tools (ADR-0275).

```bash
agent-bot soul spawn '/path/Principal SW Engineer.soul' --name Billy --harness codex
agent-bot soul spawn '/path/Principal SW Engineer.soul' --name Shiela
```

Spawning creates an instance and returns JSON with its Agent ID, `soulDir`,
`displayName`, and current `revision`. It does not launch a harness.
`--harness` optionally records the instance's harness. Authenticated daemon
package launches with a `name` use this same mechanism before launching;
unnamed daemon launches retain their existing behavior.

Billy's manifest name is `Billy - Principal SW Engineer`. Its directory is
`<soulsRoot>/Billy - Principal SW Engineer.soul`. The root resolves from
`AGENT_BOT_SOULS_HOME`, then `settings.soulsRoot`, then `~/.agent-bot/souls`.
Case, Unicode, punctuation and spaces are preserved. Only `/ \ : * ? " < > |`
and control characters become `-`; trailing dots and spaces are trimmed
before adding `.soul`. An existing destination, including a symlink or a
collision after sanitization, is refused. Census names remain separate
lowercase-hyphen handles; the registered `soulDir` uses the display name.

The template is never modified. Package files, unknown fields, binary files,
executable modes and empty directories are copied. `.soul-state/`,
`worktrees/`, and the reserved generated harness paths listed in
`GENERATED_HARNESS_PATHS` in `soul-package.mjs` are excluded. Instances use
package format 2 so their working state does not enter subsequent revisions,
even when the template uses format 1. The instance sets `template: false`.

## Listing templates

```bash
agent-bot soul templates
agent-bot soul templates --json
```

Listing reads local packages without network or secret access. It includes the
configured `teams.template`, the bundled souls (the Starter `join` and
`start_soul` use, plus every other `*.soul` shipped beside it whose soul.json
says `"template": true`, such as GeniusBar's built-in lead), and direct `*.soul`
directories under the souls root marked `"template": true` with no
`.soul-state/agent-id`. Configured packages and the bundled Starter do not need
the template flag. Every listed package passes package validation.
Invalid packages appear in `errors` without stopping the list.

Plain output is `name — description (harness, source)`, with `none` when there
is no preferred harness. JSON is `{ templates, soulsRoot, errors }`. Each row
contains `name`, `description`, `preferredHarnesses`, `defaultHarness` (the first
preferred harness or `null`), absolute `package`, `revision`, and `source`
(`config`, `bundled`, or `souls-root`). Display fields use the same caps as
`soul locate`; unavailable text is empty. Revision is `null` when `soul locate`
provides none. Errors contain `package` and `message`.

Rows sort by name and deduplicate by resolved package path, preferring config,
then bundled, then souls-root. Pass a row's `package` to `soul spawn` or a named
`{ package, name, harness }` launch. A missing souls root gives an empty local
scan and is not created. SOP-sourced templates are not included yet.

## Identity and history

Each instance mints a new root identity using `mintAgentIdentity` and the
ADR-0275 genesis hash and random nonce. A template is a definition, not a
parent soul, so `genesis.parentSoul` is null. The instance's first package
revision has `parentRevision: null`: its history starts independently at
genesis. `templateRevision` preserves the source revision as provenance,
without claiming the template's history belongs to the instance.

Initialization has two recorded revisions. The first contains the renamed
package and mints the identity. The second sets `displaySeed` to the new
Agent ID through the existing revision flow. This order avoids a circular
hash dependency: the seed contributes to the package revision, which
contributes to the identity. Genesis is never rewritten. Each instance has
its own seed, revision snapshots, history, census entry and private
`.soul-state/agent-id` marker.

## Name provenance and the template rename

A spawn records where the instance's name came from (GeniusBar#287):
`templateName` is the template's `name` at spawn and `nameSource` is
`template` when the chosen name equals it (the owner kept the default) or
`user` when they chose another. A template's own `previousNames` and
`maintained` describe the template and are not copied to the instance.
Manifests written before these fields stay valid.

When a release renames a bundled template, its soul.json keeps the old
names so existing instances still find it:

```json
{ "name": "Genius", "previousNames": ["Starter"] }
```

```bash
agent-bot soul env migrate <agentId|name> --template-name --plan --json   # read-only
agent-bot soul env migrate <agentId|name> --template-name [--json] [--principal-stdin]
```

The migration (one of the `soul env migrate` family, owner-gated, journaled
as step `template-name` in `.soul-state/migration.json`, receipted as
`soul-env-migrate`) renames a non-template instance with a
`templateRevision` whose name the template owns, to the bundled template's
current name in the spawn form, `Genius - Genius`. The template owns the
name when `nameSource` is `template`, or, for a manifest from before the
field, when the name is the `<template> - <template>` pair for the
template's current name or one of its `previousNames`. A name the owner
chose (`nameSource: "user"`, or a pre-field name that is not that pair,
such as `Bob - Starter`) is never changed; the step is `skipped` with
`the name was chosen by the owner`. So is an instance of no bundled
template, a template itself, and a name already current (`already named
by the template`), so a rerun changes nothing.

The rename is one package revision through the host edit path
(`revision prepare`, the manifest's `name`, `templateName` and
`nameSource` changed in the staging, `revision edit --apply`), reason
`Rename from template <old> to <new>`. The census display name follows
when it was the template's old name (the daemon records the launch name,
so a kept default reads `Starter`); an owner's display name stays. The
Agent ID, the folder (`Starter - Starter.soul` keeps its path), the
`.soul-state` marker, memory, turns, tool homes, the owner's AGENTS.md and
every other file are untouched; only the revision journal, its mirror and
the migration journal gain this step.

JSON is the migrate shape: `{ schemaVersion, agentId, soulDir, operation:
"template-name", decision, steps: [step], root }` with `decision`
`planned | renamed | skipped` (`failed` goes to the error) and the step
`{ id, status, from, to, at, note, templateName: { from, to }, template: {
name, package, revision }, displayName: { from, to }, revision,
parentRevision }`. `--plan` runs no gate and records nothing.

## Maintained files and refresh

A template declares the paths it maintains in its instances, prefixes of
package paths (a trailing slash is a directory and everything in it, a
bare path one file; relative, no traversal, never `soul.json` or working
state):

```json
{ "maintained": ["docs/guide/", "skills/"] }
```

```bash
agent-bot soul template refresh <agentId|name> --plan --json               # read-only
agent-bot soul template refresh <agentId|name> [--from TEMPLATE_PATH] [--json] [--principal-stdin]
```

The refresh resolves the instance's template (`--from`, else the bundled
package whose `name` or `previousNames` matches the instance's
`templateName`, or before the field the ` - <template>` suffix of its
name), computes the file diff under the maintained prefixes (`added`,
`changed`, `removed`, including a file the owner put under a maintained
prefix: that area is the template's), and without `--plan` writes one
package revision through the host edit path, reason `Refresh maintained
files from template <name> <revision>`, that replaces exactly those paths
and records the template's revision as `templateRevision` (and its name
as `templateName` when the instance had none). Nothing outside the
prefixes changes: the owner's AGENTS.md, an unmaintained doc the template
also changed, memory, turns, tool homes and the marker are byte for byte
what they were. A refresh that finds the maintained files identical and
`templateRevision` current writes no revision (`applied: false`). Owner
action, gated like `revision edit`, receipted as `soul-template-refresh`
(`applied | skipped | failed`); `--plan` runs no gate.

JSON: `{ schemaVersion: 1, soul: { agentId, soulDir, revision }, template:
{ name, package, revision }, templateRevision, maintained, added, changed,
removed, applied }`. Refusals are coded and exit 1: `soul-is-template` for
a template, `template-not-maintained` when the template declares no
`maintained` list, `template-not-found` (action: pass `--from`) when no
bundled template matches, `soul-not-found`, `soul-state-missing`.

The engine advertises both operations in `soul env`'s
`engine.capabilities` as `template-name` and `template-refresh`
([soul-environment.md](soul-environment.md)).

## Tailor an instance

Edit the instance's `AGENTS.md` to describe its focus, then record the edit
using the existing owner-authorized revision command:

```bash
agent-bot soul revision edit AGENT_ID \
  '/path/to/souls/Billy - Principal SW Engineer.soul' 'Focus on reliability'
agent-bot soul revision history AGENT_ID
```

The existing owner proof requirement applies to `revision edit`. It appends
a snapshot whose parent is the instance's current revision; it keeps the
Agent ID fixed and changes neither the template nor sibling instances.
The revision API stores the new package as an immutable snapshot; editing
does not automatically rewrite the source directory's `soul.json`.
Hosts can resolve the recorded snapshot with `revisionPackagePath`.
