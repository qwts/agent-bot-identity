# Security policy

agent-bot holds GitHub App credentials, mints installation tokens, and decides
which agent may act as which bot, so a flaw here can let one agent speak for
another. Please report it privately.

## Reporting a vulnerability

Use GitHub's private vulnerability reporting:

1. Open the repository's **Security** tab and choose **Report a vulnerability**,
   or go straight to
   <https://github.com/qwts/agent-bot-identity/security/advisories/new>.
2. Describe the issue, the affected version or commit, and the steps to
   reproduce it. A proof of concept helps but is not required.

Only the maintainers and you can see the report. Do not open a public issue,
pull request or discussion for a suspected vulnerability, and do not include
real tokens, private keys or other credentials in the report.

The maintainers reply in the advisory, keep you updated there while a fix is
prepared, and can credit you in the published advisory if you wish.

## Supported versions

Fixes land on `main` and ship in the next release. Only the latest release is
supported; please confirm an issue against it or `main` before reporting.

## Scope

In scope: this repository's runtime (the `agent-bot` CLI, daemon, hooks, gh
shim, credential helpers), `keyd/`, the Homebrew formula and the Linux bundle
scripts, and its GitHub Actions workflows.

Out of scope: vulnerabilities in GitHub itself, in third-party harnesses
(Claude Code, Codex, Cursor and others), or in a machine that is already
compromised as the user running agent-bot. Report those to their owners.
