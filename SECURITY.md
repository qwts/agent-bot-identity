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

## Where App JWTs go

An App JWT can mint a token for any of the App's installations, so it is sent
only to `https://api.github.com`, and every request that carries one refuses
redirects. The caller's `GITHUB_API_URL` is never read for it. A config or
organization profile `apiBase` naming any other host is refused when an App
token is minted, by both agent-bot and agent-bot-keyd, because the config file
is chosen by `AGENT_BOT_CONFIG` or `HOME` and a profile's `api_base` is checked
only for HTTPS. GitHub Enterprise Server and data-residency hosts therefore
cannot mint App tokens until an owner-approved enterprise host exists (#1062,
#1099). Installation tokens, which are scoped to one installation, still go to
the configured API base.

## CI and outside pull requests

Self-hosted runners are meant only for pushes to this repository, manual runs
by maintainers, and pull requests whose branch lives in this repository. A pull
request from a fork runs on GitHub-hosted runners and receives no secrets, and
no workflow uses `pull_request_target`. One gap remains: if the fork behind an
open pull request is deleted, GitHub no longer marks the head as a fork, and a
rerun takes the runner the repository variables name. The `Action Policy` job
then refuses any actor not on its allow list before other jobs run or check
out code. The changelog fragment check runs outside that policy job, so it
always uses a GitHub-hosted runner (#1066).

Approval for outside contributors' workflows is required repository
configuration, not something the workflow files enforce: the owner turns on
**Settings → Actions → General → Fork pull request workflows → Require
approval for all external contributors**, and only then do those workflows
wait for a maintainer.

## Scope

In scope: this repository's runtime (the `agent-bot` CLI, daemon, hooks, gh
shim, credential helpers), `keyd/`, the Homebrew formula and the Linux bundle
scripts, and its GitHub Actions workflows.

Out of scope: vulnerabilities in GitHub itself, in third-party harnesses
(Claude Code, Codex, Cursor and others), or in a machine that is already
compromised as the user running agent-bot. Report those to their owners.
