> **Retired (2026-10-27).** [ADR-1183](decisions/ADR-1183-agent-bot-splits-into-hq-and-plugins.md) retires this extraction: `qwts/agent-identity` is not created, and the runtime splits into agent-bot-daemon (HQ) and plugins instead. This page is kept as the record of the retired plan.

# Extraction plan for qwts/agent-identity

This is ADR-0645 migration step 8. It says how identity leaves this
repository as `qwts/agent-identity`:
- its history, CI and release;
- how each agent-bot release pins and bundles it;
- what the `agent-bot` facade does;
- how to roll back.

The plan is reviewed before the repository is created. The owner answered
its four questions on 2026-10-11 (see the end of this page). Nothing here
runs until the owner approves the plan.

What identity offers is [identity-contract.md](identity-contract.md) (step 7).
The inventory is [identity-contract-inventory.md](identity-contract-inventory.md).

## Preconditions

All of these must hold before step 9 starts:

1. **No crossings.** No file outside identity imports an identity file
   except the published entries. The module-boundaries tests check this for
   host, cli, soul and comms. The open #645 PRs listed in the contract bring
   the count to zero.
2. **Step 6: identity's physical directory.** Identity's files move to
   `identity/` in this repository, keeping their history. The old paths stay
   as one-line re-export shims (ADR-0645 step 6), because:
   - the installed git hooks run identity files by path;
   - GeniusBar's compatibility check loads modules by path;
   - so does the gh-app-hook worker.

   *Done in the code:* #969, #971, #972, #974, #1006 and the PR that moved
   `identity-cli.mjs` and `identity-soul.mjs`. The module map lists each old
   path under `shims`. A module-boundaries test holds every identity file
   outside `identity/` to a shim or a re-exporting contract. Shipping this
   in its own agent-bot release is still to do.
3. **ENG-0128 amended.** agent-identity owns identity, and this repository
   owns soul, harness and the `agent-bot` facade (answer 1). The amendment
   is recorded before step 9. *Met:* recorded in
   [qwts-agent-sop#83](https://github.com/qwts/qwts-agent-sop/pull/83).
4. **The contract is stable for one release.** One agent-bot release ships
   with identity at `identity/` and the shims in place, and nothing breaks.

## Repository and history

- **Creation:** `qwts/agent-identity` is created empty, with the same branch
  protection, signed-commit requirement and CODEOWNERS policy as this
  repository.
- **History:** identity's history is carried over by path filtering
  `identity/`, `keyd/`, the identity hooks and identity's tests. Each
  original commit keeps its author, date and message. A trailer links each
  carried commit to the commit it came from here.
- **Signatures:** a carried commit can't keep its original signature. The
  signed-history problem #737 raised is solved once, here (see question 1).
- **Back pointer:** this repository keeps its full history. The commit that
  removes `identity/` names the agent-identity commit it moved to.

## Layout and the pinned copy

- **Contents:** agent-identity holds the entry files from the contract:
  - `identity-format.mjs`, `daemon-client.mjs`, `identity-host.mjs`,
    `identity-cli.mjs`, `identity-soul.mjs` and `identity-entry.mjs`;
  - every file they reach, plus `keyd/`, the identity hooks,
    `scripts/ensure-identity.sh` and `wrangler.toml`.
- **Dependencies:** it keeps zero npm dependencies. It needs this
  repository's `shared` module (state paths, config, file lock) and the
  `org` and `harness` reads it uses today. Those come along as a pinned
  copy of agent-bot's shared files, kept byte-identical by a test in both
  repositories, as `identity-format.mjs` is (answer 2).
- **The pinned copy here:** each agent-bot release carries agent-identity at
  one pinned version, under `identity/`.
  - The version and a content digest are recorded in
    `governance/agent-identity.json`.
  - CI refuses a tree whose `identity/` doesn't match the digest.
  - Moving the pin is an ordinary reviewed PR, and pins never move backwards
    (§6).

## How agent-bot consumes it

- **In-process:** soul, host, cli and comms import the published entries
  from `identity/`, exactly as they import them from the repository root
  today. The module map keeps listing them as contracts.
- **Out of process:** `identityOp` runs `identity/identity-entry.mjs`.
- **The facade:** `agent-bot` keeps every command name and argument.
  - Dispatch runs the identity entry files from `identity/`.
  - `agent-bot identity`, `mint-token`, `principal`, `owner` and
    `identity app` behave as before.
- **Old paths:** the root-level identity paths stay as re-export shims for
  at least one release after extraction, so hooks installed by an older
  release keep working (step 9: "Old paths keep working").

## CI

- **In agent-identity:** its own CI runs identity's tests, the
  byte-identical checks for `identity-format.mjs` and the shared copy, and
  keyd's Rust build. It uses the same runner policy as this repository:
  self-hosted runners for trusted branches, and none for forks (#752).
- **In this repository:** CI keeps running the whole suite against the
  pinned `identity/`, plus the contract test in step 7. A PR that moves the
  pin runs both repositories' contract tests.

## Release

- **Versioning:** agent-identity gets semver tags signed the same way as
  agent-bot's. It ships inside each agent-bot release (answer 3), with no
  separate formula, GeniusBar component or Linux bundle entry. ADR-0332
  decision 1 is unchanged.
- **Hosts:** GeniusBar, Homebrew and the Linux bundle carry it through their
  existing agent-bot component. GeniusBar's compatibility checks keep
  working.
- **Release notes:** each one names the agent-identity version it carries.

## Rollback

- **Before any user release:** the extraction PR reverts cleanly, so
  `identity/` and the root shims come back as they were.
- **After a release:** the next agent-bot release pins the previous
  agent-identity version. Pins never move backwards, so this ships as a
  new patch release that carries the old code under a new pin record.
- **Persisted state:** nothing persisted changes at any step (contract,
  "What identity persists"). Rollback needs no migration.
- **Repository:** agent-identity is never deleted. If extraction is
  abandoned, it is archived and `identity/` here becomes ordinary source
  again.

## Owner answers (2026-10-11)

The owner picked the recommended option on all four questions:

1. **Carried history:** carried commits are re-signed as the bot, each with a
   trailer naming the original commit.
2. **The pinned copy:** a vendored copy under `identity/`. Its version and
   digest are recorded in `governance/agent-identity.json`, and CI checks
   them.
3. **The shared files:** a byte-identical pinned copy in agent-identity,
   tested in both repositories.
4. **Order:** step 6 (`identity/` with shims at the old paths) ships first,
   in its own agent-bot release, before the repository is created.

The questions as they were asked:

1. **Carried history.** Carried commits can't keep their signatures.
   - **(a) Recommended:** re-sign carried commits as the bot, with a trailer
     naming the original commit.
   - **(b)** Import history unsigned as one merge with a signed tip.
   - **(c)** Start from one signed snapshot commit and link to this
     repository for history.
2. **How the pinned copy arrives.**
   - **(a) Recommended:** a vendored copy under `identity/`, refreshed by a
     PR that records version and digest.
   - **(b)** A git submodule.
   - **(c)** git subtree.
3. **The shared files identity needs.**
   - **(a) Recommended:** a byte-identical pinned copy in agent-identity,
     tested in both repositories.
   - **(b)** Identity takes them as parameters (ports) from agent-bot.
4. **Order.**
   - **(a) Recommended:** step 6 (the `identity/` directory with shims) ships
     in one agent-bot release before the repository is created.
   - **(b)** Steps 6 and 9 in one release.
