# ADR-0276: Souls carry their harnesses as pinned npm dependencies

**Status:** Proposed
**Date:** 2026-10-01
**Issue:** qwts/agent-bot-identity#307

## Context

The ACP registry starts `claude` and `codex` through `npx`, and `opencode`
from the user's PATH. `muse` runs the co-shipped `muse-acp.mjs` adapter
with the daemon's Node, but that adapter needs `muse` on PATH. A developer
machine has all of these. A fresh Mac running an embedded host such as
GeniusBar has only the host's bundled Node. It has no `npx` and no harness,
so a soul cannot run until the user opens a terminal.

[ADR-0275](ADR-0275-soul-packages-are-versioned-definitions-souls-can-grow.md)
gives each soul a package whose `preferredHarnesses` already orders the
harnesses it runs best on. A launched soul gets a private home seeded from
that package (#297).

## Decision

1. **A soul ships like any distributed npm app.** Its package may include
   `package.json` and `package-lock.json`. Both are optional, as in format
   1; a package without `package.json` installs nothing and runs on the
   harnesses already available. The dependencies pin the harness
   adapters the soul runs on, such as the Claude Code ACP adapter, Copilot
   CLI, `pi-acp`, or the Codex ACP adapter. The package revision covers
   both files, so changing a pin is a new revision.
2. **The first entry of `preferredHarnesses` is the soul's default.** Each
   registry row may name the npm binary that serves it in a soul's home.
3. **The daemon installs a home's dependencies when it creates the home,**
   only when the package has `package.json`. A `package.json` without
   `package-lock.json` fails the launch, because the pins would not be
   exact. With both, it runs the host's `npm ci --ignore-scripts --omit=dev`
   inside the home,
   with no global install and no `npx`. A host passes its Node and npm. A
   failed install fails the launch with the npm error, and the new soul is
   retired as #297 requires.
4. **Selection order:** the per-agent harness option, then the soul's
   default, then any registry harness on the user's PATH. A harness found
   in the home's `node_modules/.bin` runs from there. Otherwise the registry
   command runs as before: `npx` for `claude` and `codex`, PATH for
   `opencode`, and the co-shipped adapter for `muse`.
5. **Credentials stay the harness's own.** Each harness keeps its login
   store, such as `~/.claude` or the Copilot sign-in. Installing a harness
   grants it nothing, and a host offers each harness's own sign-in step.

## Consequences

- A friend can launch the starter soul with no terminal, apart from signing
  in to the harness.
- Each soul pins its own harness versions, so upgrades happen soul by soul,
  and two souls may run different versions.
- Disk use grows with each home: every home holds its own `node_modules`.
  A shared npm cache keeps the downloads to one per version.
- Installing code at spawn widens what a package can bring in. Lifecycle
  scripts are skipped, and installation stays behind the package approval
  in ADR-0275. A signed catalog is still follow-up work.
- Proprietary harnesses such as Copilot CLI are downloaded on the user's
  machine under their own license, never redistributed inside a host.
