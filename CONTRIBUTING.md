# Contributing

This repository is governed by
[playbook-engineering](https://github.com/qwts/playbook-engineering): shared
SOPs, decisions, and baselines there apply here by default.

- **Workflow**: branch → PR → review → merge, per the shared
  [branch, PR, and review SOP](https://github.com/qwts/playbook-engineering/blob/main/docs/sop/branch-pr-review.md).
- **Features**: follow the
  [feature-lifecycle SOP](https://github.com/qwts/playbook-engineering/blob/main/docs/sop/feature-lifecycle.md)
  — open the feature issue form before the code exists.
- **Security**: see the org
  [security policy](https://github.com/qwts/.github/blob/main/SECURITY.md);
  report vulnerabilities privately, never in a public issue.

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

1. Update `package.json` and `CHANGELOG.md`, validate, and merge the release PR
   to `main`. Leave the formula's last published `url` and `sha256` unchanged.
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
