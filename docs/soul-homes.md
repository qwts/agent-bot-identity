# Soul directories and home migration

ADR-0332 decision 5 gives every soul a directory. The root resolves from
`AGENT_BOT_SOULS_HOME`, then the absolute user setting `settings.soulsRoot`,
then `~/.agent-bot/souls`. CLI and desktop hosts use the same root.

The population census is authoritative for the display name and the optional
absolute `soulDir`. Without a registered directory the path is
`<soulsRoot>/<name>.soul`. Provisioning writes `.soul-state/agent-id` (0600)
inside `.soul-state/` (0700) and registers the directory. A registered path is
used only when its marker matches the Agent ID. When that path disappears,
a lookup scans `*.soul` directories one level below the configured root for
the matching marker and re-registers the unique match. Moves elsewhere need
explicit `registerSoulDir` registration. Ambiguous matches fail closed.

The soul directory contains the package. New package spawns copy it there
before creating the git home in `.soul-state/home`. An existing soul directory
is kept. Home creation copies package content without `.soul-state/` or
`worktrees/`, installs pinned harnesses, and initializes git as before.
Package revision exclusions are tracked separately in #341.

On launch, provisioning checks the legacy `<state>/homes/<agentId>`:

1. If the new home lacks `.git` and the legacy home has it, write
   `.soul-state/migrated-from` with the legacy path and remove any leftover
   `home.migrating` staging directory.
2. Try an atomic rename into `home`. On `EXDEV`, copy the intact legacy home
   to `home.migrating` and rename that staged directory to `home`.
3. Bind the new worktree and git directory, replacing bindings for the legacy
   home while preserving bindings to other checkouts. Only then remove the
   legacy copy and leftover staging directory.

A failed copy or promotion leaves the legacy home intact. A stop after
promotion leaves the complete new home. The recorded migration path lets
provisioning finish binding and cleanup on restart. A new home with `.git`
is never copied over or reinstalled. A live binding to the legacy home also
passes through migration on its next launch.

Agent Space does not move: `.soul-state/space` links to the census's recorded
space path. An existing link, including a dangling one, is kept.

`agent-bot soul dir AGENT_ID` prints `{ agentId, soulDir, home, soulsRoot,
source }`. `source` is `environment`, `setting`, or `default`. Hosts such as
GeniusBar should use this contract for location reads, and harness auth uses
this registry home too. Reading the directory does not provision a home.
