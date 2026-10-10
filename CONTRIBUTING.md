# Contributing

Contributions are welcome from anyone. You need a GitHub account, git and
Node.js 20 or newer. You do not need any of the maintainers' bot Apps,
credentials or machine setup.

## Outside contributors

1. Fork the repository and create a branch in your fork.
2. Make your change. The runtime has zero npm dependencies; keep it that way,
   and match the surrounding code style.
3. Run the tests (see below) and add or update tests for what you changed.
4. Add a changelog fragment as `changes/<slug>.md`, never by editing
   `CHANGELOG.md` (see [changes/README.md](changes/README.md)). The
   `Changelog fragment` check enforces it; a maintainer labels a PR
   `skip-changelog` when it needs no entry.
5. Commit with your own git identity and open a pull request against `main`.
   Ordinary commits are fine; signing is optional.

A maintainer reviews every pull request. CI for a pull request from a fork
runs only on GitHub-hosted runners and receives no secrets, and GitHub may
hold a first-time contributor's run until a maintainer approves it.

For a bug or feature, open an issue first if the change is large, so the
approach can be agreed before you write it. Report security problems
privately as described in [SECURITY.md](SECURITY.md), never in a public issue.

### Running the tests hermetically

No `npm install` is needed. From the repository root:

```bash
env -u AGENT_BOT_ID -u QWTS_AGENT_ID -u AGENT_BOT_BINDING npm test
```

The tests work in temporary directories and need no GitHub App credentials,
no installed or configured agent-bot, and nothing under your `~/.config`; they
pass with `HOME` pointed at an empty directory. Unsetting the variables above stops a shell
that already runs agent-bot from leaking its identity into the tests. To run
one file, use `node --test tests/<name>.test.mjs`.

`keyd/` is a separate Rust crate. If you change it, also run
`cargo fmt --check && cargo clippy --locked --all-targets -- -D warnings && cargo test --locked`
inside `keyd/`, as CI does.

## Maintainers

The maintainers' own workflow is not required of contributors. Maintainer
agents commit and open pull requests as the project's GitHub App bots, use
`agent-bot signed-commit` and the soul worktree workflow, and follow the
[qwts/playbook-engineering](https://github.com/qwts/playbook-engineering)
SOPs, including the
[branch, PR, and review SOP](https://github.com/qwts/playbook-engineering/blob/main/docs/sop/branch-pr-review.md)
and the
[feature-lifecycle SOP](https://github.com/qwts/playbook-engineering/blob/main/docs/sop/feature-lifecycle.md).
Repo-specific gates and deltas, if any, are listed in this repo's `AGENTS.md`.

### Homebrew formula

This repo is a self-tap (`Formula/agent-bot.rb`). After changing the formula
or cutting a version tag, verify locally:

```bash
brew tap qwts/agent-bot-identity "$(pwd)"
brew trust qwts/agent-bot-identity
brew audit --strict agent-bot
brew install --build-from-source agent-bot
brew test agent-bot
```

Release in two reviewed PRs so the tap stays installable throughout:

1. Run `node scripts/changelog.mjs assemble X.Y.Z`, which moves every
   `changes/*.md` fragment under `## X.Y.Z` in `CHANGELOG.md` and deletes them.
   Update `package.json` and `qwts-validated` in `skills/agent-bot/SKILL.md`,
   validate, and merge the release PR to `main`. Leave the formula's last
   published `url` and `sha256` unchanged. The formula PR in step 3 carries
   the `skip-changelog` label.
2. Create and push an annotated `vX.Y.Z` tag on that merged release commit.
   Never move an existing release tag.
3. Download the tag's GitHub archive and compute its SHA-256. Verify the
   archive's `package.json` and CLI version match the tag, then update the
   formula `url` and `sha256` together in a follow-up PR. Validate and merge it.
4. Only after the formula PR merges is the new version available to Homebrew
   and managed-machine consumers. Test a pilot installation before rollout.

The tap reads the formula from `main`; Cellar contents come from the tag
archive. The formula may temporarily lag `package.json`, but must never point
at a newer runtime or carry a placeholder checksum. Tests enforce this
ordering and reject all-zero checksums; archive availability and the actual
checksum must be verified during the formula update, not guessed.
