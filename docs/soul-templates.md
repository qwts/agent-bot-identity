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
