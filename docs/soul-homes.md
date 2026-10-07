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

Agent Space does not move until slice 5 of #583 migrates it into the soul
([ADR-0583](decisions/ADR-0583-the-soul-root-owns-the-environment.md)):
`.soul-state/space` links to the census's recorded space path. An existing
link, including a dangling one, is kept. `agent-bot soul env` reports the
link as `location: linked` with a pending `space-into-soul` step.

`agent-bot soul dir AGENT_ID` prints `{ agentId, soulDir, home, soulsRoot,
source, copies }`. `source` is `environment`, `setting`, or `default`. Hosts such as
GeniusBar should use this contract for location reads, and harness auth uses
this registry home too. Reading the directory does not provision a home.

## Expired harness sign-in

When a daemon turn fails because the soul's harness is signed out, the
census row records it (#84). Claude's "Not logged in · Please run /login" and
an ACP "Authentication required" are recorded as `signed-out`. An expired
OAuth access token or a Codex refresh token that can no longer be used is
recorded as `expired`:

```json
"harnessAuth": { "status": "expired", "harness": "claude", "since": "2026-10-03T10:00:00.000Z" }
```

`agent-bot population list|show --json` carries it, so GeniusBar can show a
sign-in banner. Each sender waiting on the soul gets one short reply naming
the sign-in, for example "I couldn't answer this: my Claude sign-in has
expired. My owner needs to sign me in again before I can work on it." Their
messages stay unread and are answered on a later wake. The field is gone once
a turn runs again, or once `agent-bot harness auth status|login HARNESS
--soul AGENT_ID` reports that harness signed in. The harness's own error text
is never stored. The audit receipt reads `harness expired` or
`harness signed-out`.

## Copied soul folders

Copying a soul folder (a Finder Duplicate, for example) copies its
`.soul-state/agent-id` marker, so two folders claim one soul (#80). The soul
runs only from its census-registered folder; a copy is never used. `copies`
in `soul dir` lists the others, and `agent-bot doctor` warns with code
`soul-folder-duplicate` and names them. When no registered folder carries the
marker, the claims are ambiguous and a moved-folder search refuses to pick one.

`agent-bot soul locate PATH [--json]` says what a folder opened as a package is, as
JSON `{ path, status, agentId?, name, description, preferredHarnesses, template,
soulDir?, copies?, message? }`. For `package`, `installed`, and `copy`, prefill
fields come from that folder's `soul.json`. Missing or invalid fields are `null`
or `[]` for harnesses; an omitted `template` in a readable manifest is `false`.
The default output is already JSON; `--json` is an explicit equivalent.

The status determines what launching the folder does:

| status | meaning | a package launch of it |
| --- | --- | --- |
| `package` | no soul marker | spawns a new soul |
| `installed` | an active soul's registered folder | relaunches that soul |
| `copy` | another folder is the soul's own | forks it: a new soul in that folder, named by the launch (#432) |
| `duplicate` | several folders claim the soul, none registered | is refused |
| `unregistered` | the marker names no active soul here | is refused |
| `invalid` | `.soul-state/agent-id` is a link, not a small regular file, or not an Agent ID; its contents are never quoted | is refused |

The daemon applies the same rule to launch requests, so opening an installed
soul from Finder and launching it never creates a second soul. Nor does it
rename one: the name on a package launch is for the soul the launch makes,
so an installed folder relaunches its soul under its own name, and a launch
of a copy forks it (below) into a new soul with that name (#432). A copy
launched without a name is refused and nothing changes. The soul the copy
came from, and a template an instance is spawned from, are never renamed.

`agent-bot soul fork <copy-path> --name NAME [--harness H] [--json]` makes a
`copy` a new soul instead (GeniusBar #83, "Make it a new soul"). It is
owner-gated like `soul remove`, and it refuses any other status before asking.
The copy keeps its folder and package and gets its own Agent ID, identity,
genesis revision, census row (named NAME) and agent-comms membership, joined
from a `worktrees/workspace` checkout in its folder as `agent-bot join` does.
Its harness is the original's unless `--harness` names another. Afterwards
`soul locate` reports the folder as `installed`. The original's folder,
identity and membership are not changed.

The copy's `.soul-state/` and `worktrees/` are the original's working state,
including its harness sign-ins and git worktrees, so they move to
`<souls root>/.archive/<UTC stamp>-<folder>-state/` before the new soul is
minted. A `credentials` declaration names the original's GitHub App, so the
fork drops it. If a fork fails after minting, it rolls back like a failed
launch: it leaves agent-comms if it joined, retires the new soul, and archives
the folder.

## Failed launches and archived folders

A launch that spawns a new soul and then fails before its first session
starts rolls back what it made (#419). If it joined agent-comms, the soul
leaves as itself. The identity and census row are retired, and every folder
carrying the soul's marker moves to `<souls root>/.archive/<UTC stamp>-<folder
name>`. Nothing is deleted, and a retry with the same name gets a fresh
folder. The archive is not scanned for souls.

`agent-bot doctor` warns with code `soul-folder-orphan` (`souls.orphans`)
about any folder under the souls root whose marker names a soul that is
retired or unknown here, such as one a failed launch left before this
rollback existed. Finalized souls keep their folders and are not listed.
`agent-bot soul remove <agentId>` archives them the same way (#420).

## Repository worktrees

Read `agent-bot skill agent-space` for the check-in, checkout, and cleanup procedure.

ADR-0332 decision 6 and the work-area rule (#516) require agents to check in
with `agent-bot join` and do repository work in their soul's
`<soulDir>/worktrees/<name>` (0700), or in an existing checkout linked from
that directory. This applies to every harness. A path validates the work
area; it never supplies an identity (ENG-0339).

```sh
agent-bot setup-worktree [app-slug]
agent-bot setup-worktree [app-slug] --name NAME [--branch BRANCH]
```

With `--name`, setup uses `placeWorktree` to create a linked Git worktree
there if it does not exist, then configures it. The branch defaults to NAME;
an existing branch is checked out, otherwise a branch is created from HEAD.
An existing named checkout must belong to the same repository and, when
specified, the requested branch. Without `--name`, setup validates and
configures the current checkout. `--help` describes both forms and refusals.
Names must start with a letter or number, contain only letters, numbers,
dots, underscores or hyphens, contain no `..`, and be at most 100 characters.

The session must already have a soul: `AGENT_BOT_ID` (legacy `QWTS_AGENT_ID`),
an explicitly supplied `AGENT_BOT_BINDING`, or an existing registered soul
matching the session transcript. Setup does not resolve a soul from a Git pin
or from the checkout path, and never mints a replacement soul. A session
without a soul joins first (`agent-bot join --name NAME --harness H`); any
harness key can join, and a harness's wake lanes and generated files are its
agent-bot rows (Kiro: #523). No ambient identity substitutes for that step.

Before credentials, census updates, or Git configuration writes, setup refuses
an owner's primary checkout outside the soul work area, an arbitrary checkout,
or a checkout pinned or bound to another soul. Refused locations keep their
configuration unchanged, even when GitHub identity is disabled. Existing
checkouts must already be linked from this session's soul; setup no longer
creates a link as a side effect to make an arbitrary location valid.

`placeWorktree` compares the soul directory's device with the repository's
common Git directory. Cross-device placement and paths over 900 characters
are refused; there is no TMPDIR fallback. Move the repository to the soul's
device, or create a durable linked Git worktree on the repository device and
link it into `<soulDir>/worktrees/` using the existing `linkWorktree` mechanism
(or an explicit directory symlink). For long paths use a shorter name or
registered soul location. Existing links remain supported, including older
harness-created worktrees; repeated setup keeps their paths.

Claude's `WorktreeCreate` adapter uses the same placement helper and propagates
placement refusals for a resolved soul. Git's `post-checkout` hook only runs
setup for the current session soul; without a soul it is silent. It cannot
reapply a previous session's pin. `agent-bot install` / `agent-bot update`
refresh already-installed hook wrappers through the existing installer; those
wrappers dispatch to the current runtime's hook template.

Successful setup records the checkout's actual path in the census's
`worktree` and `worktrees` fields.

Launch does not create repository worktrees. It runs in an existing binding
or provisions the git home at `.soul-state/home` as described above.
`worktrees/` remains working state excluded from soul packages and revisions.
