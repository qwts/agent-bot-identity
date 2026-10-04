# Changelog fragments

Each PR adds its changelog entry as a file here instead of editing
`CHANGELOG.md`, so PRs merged side by side never conflict on the same lines.

- Name it `changes/<slug>.md`, where the slug says what changed
  (`soul-fork.md`, `approval-expiry-audit.md`). One file per PR.
- Write one Markdown bullet, as it should read in `CHANGELOG.md`: what changed
  for the user, then why, with the issue or PR number. Indented sub-bullets
  are fine.

  ```markdown
  - `agent-bot soul fork <copy> --name N` gives a Finder copy of a soul its own identity (#83).
  ```

- A PR that needs no entry (a formula bump, CI-only, a typo) carries the
  `skip-changelog` label instead.

CI (`Changelog fragment`) fails a PR that adds no fragment, or that edits
`CHANGELOG.md` directly, unless it has that label.

At release, `node scripts/changelog.mjs assemble X.Y.Z` moves every fragment
under a new `## X.Y.Z` heading in `CHANGELOG.md`, in file-name order, and
deletes the fragments. See [CONTRIBUTING.md](../CONTRIBUTING.md#homebrew-formula).
