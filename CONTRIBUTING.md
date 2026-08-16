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

A version bump updates `package.json`, lands on `main`, tags `vX.Y.Z`, then
updates the formula `url` / `sha256` in a follow-up. The tap
reads the formula from `main`; Cellar contents come from the tag tarball.
