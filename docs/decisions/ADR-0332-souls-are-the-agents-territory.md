# ADR-0332: Souls are the agent's territory

**Status:** Accepted (2026-10-03)
**Date:** 2026-10-02
**Issue:** qwts/agent-bot-identity#332

Builds on [ADR-0274](ADR-0274-product-is-mechanism-add-ons-and-sop-packs-carry-policy.md)
(`agent-bot sop`),
[ADR-0275](ADR-0275-soul-packages-are-versioned-definitions-souls-can-grow.md)
(soul packages), and
[ADR-0276](ADR-0276-souls-carry-their-harnesses-as-pinned-npm-dependencies.md)
and [ADR-0322](ADR-0322-souls-carry-their-runtimes-and-non-npm-harnesses.md)
(what a soul carries). This record covers decisions only. The owner
accepted it on 2026-10-03; the follow-up issues below carry the work.

## Context

The pieces exist, but they are scattered across the machine:

- **Installing.** agent-bot and agent-comms come from Homebrew, or bundled
  inside GeniusBar. The app's copies reach only the souls the app launches,
  so an agent started anywhere else still needs Homebrew
  (qwts/GeniusBar#41). Headless Linux, such as a cloud agent's computer,
  has no supported install at all. Homebrew upgrades often, and a daemon
  that pointed at a Cellar path broke on upgrade (#321).
- **Where a soul lives.** One soul's state is spread over several places:
  - its package, wherever the user keeps the `.soul`;
  - its home, `<state>/homes/<agentId>` (#297);
  - its Agent Space, `~/.agent-space/<agentId>` (ENG-0172);
  - its worktrees, wherever its harness put them, e.g.
    `~/.devin/worktrees/geniusbar-34`.

  An agent can read and write anywhere its user can.
- **SOP.** `agent-bot sop` resolves one SOP per user, from
  `~/.config/agent-sop/config.toml`. A soul that works for a different
  organization has no way to say so. The command reports which commits are
  in effect, but it cannot give an agent the SOP text it needs, or only the
  parts relevant to the task at hand.
- **Harness configuration.** Each harness reads its own folder (`.claude/`,
  `.codex/`, `.cursor/`, and others) next to `AGENTS.md`, so one soul
  definition currently has to be hand-copied into each harness's format.

The owner's goal is easy install, easy removal, and fewer headaches from
tools that change often. The model is that a soul is the agent's
devcontainer.

## Decision

### Installing

1. **There are three install paths, and each one puts `agent-bot` and
   `agent-comms` on PATH.**
   - **GeniusBar** (macOS, Windows, Linux desktop). The app installs
     wrappers that run its bundled copies, the way VS Code installs its
     `code` command (qwts/GeniusBar#41).
   - **Homebrew**, for CLI users. This works today.
   - **A CLI bundle for headless Linux**: a release archive per platform
     that holds Node, agent-bot, and agent-comms, with `install.sh` and
     `uninstall.sh`. Installing unpacks the archive into one directory and
     writes wrappers into `~/.local/bin`. It never needs root.

   Each path removes cleanly. Uninstalling deletes the install directory,
   the wrappers it wrote (each carries a marker line), and the services it
   started. It never deletes souls.
2. **Each OS user runs one broker and one daemon, from one install.** The
   pair is per user, like everything else here: the services are user
   LaunchAgents or `systemd --user` units, the wrappers go in that user's
   `~/.local/bin`, and no install needs root. An installer that finds
   another install's broker or daemon running for the same user shows
   which install it belongs to. It then offers to migrate that install's
   state, or cancels. It never starts a second pair beside the first. A
   cancelled or failed install leaves the running pair untouched. Two OS
   users on one machine each have their own pair and do not see each
   other's; a machine-wide service would need a privileged coordinator,
   which is out of scope.
3. **Managed and unmanaged.** A soul is **managed** when a host such as
   GeniusBar launches its harness. Every other soul is **unmanaged**, and
   that is the default when no host is installed: the user starts the
   harness (an IDE, a chat app, a terminal) and asks it to join.
   Wakeability is a separate question. Resume wake (#323) works for an
   unmanaged soul whose harness can resume headless.

### The soul directory

4. **Each soul is one directory, `<name>.soul`, and that directory is the
   agent's territory.** It holds the package (ADR-0275) and the soul's own
   working state:

   ```text
   Billy - Principal SW Engineer.soul/
     soul.json  AGENTS.md  skills/  policy …   package (ADR-0275)
     bin/          tools this soul's workflows use
     workflows/    how this soul does particular jobs
     sop/          SOP this soul carries (optional, see 9)
     agent-sop.toml   this soul's SOP selection (optional, see 9)
     worktrees/    its checkouts (see 6)
     .claude/ .codex/ .cursor/ …   generated (see 8)
     .soul-state/  home, caches, installed harnesses (see 5)
   ```

   `bin/`, `workflows/`, `sop/`, and `agent-sop.toml` are package content:
   they are covered by the revision and versioned with the soul. The
   following are working state, never part of a revision, and the package
   format ignores them:
   - `worktrees/`;
   - `.soul-state/`;
   - the generated harness folders.

   A soul cannot add or change anything in `bin/` without the user's
   approval, because that widens its tools (ADR-0275 rule 4).
5. **Souls live under one root by default, and each soul can live anywhere.**
   - The default root is `~/.agent-bot/souls`. GeniusBar uses the same
     root, so a soul does not change places when the app is added or
     removed.
   - The root resolves like the Agent Space root: an environment variable
     (`AGENT_BOT_SOULS_HOME`), then a user setting, then the default.
   - The registry records each soul's directory. A soul moved elsewhere is
     re-registered, not lost.
   - New souls keep their home under `.soul-state/` instead of
     `<state>/homes/<agentId>`. Existing homes migrate when the soul is
     next launched.
   - Agent Space stays where ENG-0172 puts it. It is linked from the soul
     and does not move. Superseded by
     [ADR-0583](ADR-0583-the-soul-root-owns-the-environment.md) decision 8:
     the space lives at `.soul-state/space` inside the soul, the census
     `spacePath` is authoritative, and an existing linked space is moved
     by `soul env migrate --space-into-soul`.
6. **A soul's worktrees go inside the soul.**
   - `agent-bot setup-worktree` and launch create checkouts under
     `<soul>/worktrees/<name>`.
   - If that is not possible (another volume, or a path-length limit), the
     checkout goes under `$TMPDIR/agent-bot/<agentId>/<name>`, and
     `<soul>/worktrees/<name>` links to it.
   - A harness that picks its own worktree location (Devin's
     `~/.devin/worktrees`) gets a link in `worktrees/` too, so everything
     the soul works on can be found from its directory.
7. **Hooks will confine a soul to its territory, starting in warn mode.**
   - A soul may write inside its directory, its worktrees, its tmp
     directory, and paths the user grants in the soul's policy.
   - The shared hooks (`agent-hook`) first **report** writes outside those
     paths, then **deny** them by default once the reports show no false
     positives.
   - The owner can turn confinement off for one soul.
   - Hooks do not make a sandbox. Where a harness has an OS sandbox, the
     daemon uses it as well, as resume wake already does.

### Harness configuration

8. **soul-builder generates each harness's configuration from the soul.**
   - From the soul's `AGENTS.md`, skills, tool and MCP configuration, and
     policy, soul-builder writes each harness's native folder (`.claude/`,
     `.codex/`, `.cursor/`, and the others), plus any alias files a harness
     needs, such as `CLAUDE.md` pointing at `AGENTS.md`.
   - Generated files carry a marker. They are rewritten on every build,
     never edited by hand, and never part of a revision.
   - A harness that reads `AGENTS.md` and skills natively needs nothing
     generated.

### SOP per soul, on demand

9. **A soul's SOP selection overrides the user's.** `agent-bot sop` uses
   the first of these that exists:
   1. the soul's `agent-sop.toml`, in the schema of
      `~/.config/agent-sop/config.toml`. This is how a soul that works for
      another organization says so;
   2. the user's `~/.config/agent-sop/config.toml`;
   3. no SOP.

   The soul's `sop/` folder layers on top of whichever selection applies.
   Where the two have a document at the same path, the soul's version wins.
   With neither, the product runs on its defaults (ADR-0274).
10. **`agent-bot sop` gives an agent SOP text on demand, filtered.**
    - Alongside today's resolve-and-report, it lists the documents in
      effect for the current soul and prints a requested one.
    - It can filter by a workflow, and a file in `workflows/` names the SOP
      documents that workflow needs. That way an agent asks for what the
      current job needs instead of loading everything up front.
    - Content is fetched at the resolved commit and cached read-only. As
      ADR-0274 already says, it is documentation for the agent, never an
      instruction that overrides the harness.

### Templates

11. **A template soul produces tailored instances.**
    - "Principal SW Engineer.soul" is a package. Spawning from it creates
      "Billy - Principal SW Engineer.soul" and "Shiela - Principal SW
      Engineer.soul". Each instance has its own identity, from genesis
      (ADR-0275), and its own revision history.
    - The user then tailors each instance: what Billy works on, and in
      `AGENTS.md`, how Shiela approaches a problem differently from Billy.
      Several instances can then look at one problem from different angles.
    - The directory name is the display name from `soul.json`, with only
      the characters that are invalid in a file name replaced.

## Consequences

- **A friend installs once and removes cleanly.** No Homebrew is needed
  next to GeniusBar, and a headless box gets a supported install.
- **Three release artifacts per version instead of two:** the formula,
  GeniusBar's bundle, and the Linux CLI archives. They must stay in step,
  and CI has to build and test each one.
- **Moving homes into the soul directory is a migration.** It runs once per
  soul, and it must be safe to interrupt. Tools that compute
  `<state>/homes/<agentId>` today (soul-home, harness auth) change to ask
  the registry.
- **Worktree locations change.** Existing checkouts stay where they are and
  are linked into their soul. Only new ones move.
- **Confinement will break some workflows at first.** Starting in warn mode
  is how those get found before they become denials.
- **Packages need an ignore list** so working state never enters a revision
  hash. Older tools keep unknown files (ADR-0275), so this is
  backward-compatible, but an older tool would hash working state. The
  package format version records the ignore list.
- **An organization's SOP can reach a soul without the user's own config.**
  Choosing a soul from another org is therefore a trust decision, just as
  choosing an SOP repository is (ADR-0274).
- **soul-builder takes on the work of tracking each harness's folder
  format.** That cost exists either way; today it is paid by hand for every
  soul.

## Alternatives

- **Keep homes, spaces, and worktrees where they are, and only add
  links.** Rejected as the end state: removing a soul would still mean
  finding its pieces. Links are used only for what cannot move: Agent
  Space and harness-chosen worktrees.
- **Put souls under `~/.geniusbar/souls`.** Rejected: CLI-only and headless
  installs have no GeniusBar, and a soul should not move when the app is
  added or removed.
- **A container per soul.** This was the inspiration ("the soul is its
  devcontainer"), but rejected as the default. It is heavy for a desktop,
  and harnesses expect the user's own auth and tools. A directory, hooks,
  and the harness's own sandbox give most of the benefit. A container
  runtime could come later as an add-on (ADR-0274).
- **Merge a soul's SOP with the user's, key by key.** Rejected: a soul
  that works for another org should not inherit half of the user's org.
  The selection is replaced whole, and `sop/` layers documents on top.

## Out of scope

- **Managed-Machine**, a separate companion app.
- A machine-wide broker or daemon shared by several OS users, and the
  privileged coordinator it would need (see decision 2).
- Windows-specific details of the wrappers and the confinement paths.

## Follow-up issues

1. Linux CLI bundle: release archives, `install.sh`, `uninstall.sh`, and
   CI (#337).
2. Souls root and registry paths, and migrating homes into `.soul-state/`
   (#338).
3. Worktrees inside the soul: `setup-worktree`, launch, and links for
   harness-chosen locations (#339).
4. Confinement hooks: warn mode, then deny (#340).
5. Package ignore list for working state, and a package format version
   bump (#341).
6. soul-builder: generated harness folders (#342).
7. `agent-bot sop`: per-soul selection, the `sop/` layer, and list, show,
   and workflow filtering (#343).
8. Templates: spawning a named instance from a template package (#344).