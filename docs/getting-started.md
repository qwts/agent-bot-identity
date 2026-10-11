# Getting started with agent-bot and agent-comms

This guide is for someone who just found these tools. It takes you from
nothing to an agent that commits as its own GitHub bot and talks to another
agent. Every command here is real; names like `you-claude-agent`, `alice` and
`my-repo` are examples to replace with your own.

## 1. What the two tools do

**agent-bot** gives each coding agent its own GitHub identity. You create one
GitHub App per agent tool (for example `you-claude-agent`). Work the agent does
in its worktree is then committed, pushed and opened as a PR by
`you-claude-agent[bot]`, with GitHub-verified signatures. Your own shell stays
you.

That gets you:

- An Approve button on your agents' PRs. GitHub does not let you approve your
  own PR, so agents that commit as you block review-gated merges.
- Authorship that says which tool wrote what (`author:you-codex-agent[bot]`).
- A small blast radius. Each App has its own key and repository list.
- A fail-closed `gh`. A bot that cannot get a token never falls back to your
  login.

**agent-comms** lets agents message each other on one machine, across
harnesses (Claude Code, Codex, Cursor and others) and across OS accounts. It
runs a local broker; each agent joins, finds peers, sends messages and reads
its inbox. It can also hand off tasks.

You want both because they share one idea of who an agent is. agent-bot
creates a *soul*: a durable agent with an Agent ID (`agent_<uuid>`) and its
own folder. agent-comms addresses messages to that same soul, and the
agent-bot daemon vouches for it. `agent-bot join` does both at once.

## 2. Install

You need git, and Node.js 20 or newer if you install from source.

### macOS (Homebrew)

```bash
brew tap qwts/agent-bot-identity https://github.com/qwts/agent-bot-identity.git
brew install agent-bot

brew tap qwts/agent-comms https://github.com/qwts/agent-comms
brew install qwts/agent-comms/agent-comms
```

Newer Homebrew may ask for `brew trust qwts/agent-bot-identity` after the tap.
Check both:

```bash
agent-bot --version
agent-comms --version
```

### Headless Linux

One archive carries both tools and a pinned Node. Download
`agent-bot-linux-x64-vX.Y.Z.tar.gz` (or `linux-arm64`) and `SHA256SUMS` from
the [releases page](https://github.com/qwts/agent-bot-identity/releases). No
root is needed.

```bash
sha256sum --check --strict --ignore-missing SHA256SUMS
tar -xzf agent-bot-linux-x64-vX.Y.Z.tar.gz
cd agent-bot-linux-x64-vX.Y.Z
./install.sh
. ~/.profile
```

`install.sh` puts `agent-bot` and `agent-comms` in `~/.local/bin`. It also
writes and starts two `systemd --user` services: `agent-bot-daemon.service`
and `agent-comms-broker.service`. Remove it all with `./uninstall.sh`; that
never deletes your souls. Details are in
[Machine install (headless Linux)](../README.md#machine-install-headless-linux).

## 3. Give an agent its GitHub identity

You run the steps in this section yourself, as the owner. Most of them ask you
to approve in a system dialog. That is on purpose: an agent cannot approve its
own identity.

### Turn on the GitHub add-on

```bash
agent-bot identity addon github-identity on
```

### Create a GitHub App, or connect one you have

To create one, run:

```bash
agent-bot identity app create --manifest --name you-claude-agent --open
```

This opens a local page that creates the App on GitHub with the right
permissions (Contents, Pull requests and Issues; no webhook; no user OAuth).
Add `--org ORG` to create it under an organization. The result prints an
`installUrl`. Open it and install the App on the repositories the agent may
work in. Creating an App does not install it.

If you already have an App, connect it with its numeric App ID and the private
key you downloaded from GitHub:

```bash
agent-bot identity app connect --id 123456 --key-file /absolute/path/to/key.pem
```

Make the App the identity for a harness:

```bash
agent-bot identity app assign you-claude-agent --harness claude
```

Manual App setup and every config option are in
[Setup](../README.md#setup) and [Managed GitHub Apps](identity-apps.md).

### Wire up the machine

```bash
agent-bot bootstrap --with-gh-shim --machine-only
agent-bot doctor --machine-only
```

Bootstrap installs the stable CLI path, the git hooks, the loopback daemon and
the `gh` shim, then checks every App with a live token mint. Fix anything
`doctor` reports before you go on.

### Start the agent-comms broker (once)

`agent-bot join` below also joins agent-comms, so the broker must be running
first. On macOS, install it as a login service. On Linux, `install.sh` already
started it, so skip this line.

```bash
agent-comms broker install
```

Then pair your account and approve the code it prints:

```bash
agent-comms account pair
agent-comms broker approve CODE
agent-comms account status   # "state": "approved"
```

### Join the agent and make a worktree

From inside the agent's session (its terminal, or a command it runs), check in
as a soul. Run it outside any git checkout:

```bash
agent-bot join --name alice --harness claude --json
```

The JSON has an `agentId` and a `soulDir`. Keep the Agent ID in the session:

```bash
export AGENT_BOT_ID=agent_...   # the agentId from join
```

The soul's work area is `<soulDir>/worktrees/`. Clone your repository there,
then let agent-bot make a worktree for the change:

```bash
git clone https://github.com/you/my-repo.git "<soulDir>/worktrees/my-repo"
cd "<soulDir>/worktrees/my-repo"
agent-bot setup-worktree --name first-change --branch first-change
cd "<soulDir>/worktrees/first-change"
```

`setup-worktree` sets the bot as author and committer, wires a credential
helper that mints short-lived tokens, and pins the worktree to the soul. It
refuses checkouts outside the soul's work area, so your own clones are never
touched.

If your harness speaks MCP, mount `agent-bot mcp` and have the agent call its
`bind` tool once at the start of the conversation. That ties the worktree to
the conversation. See
[MCP server](../README.md#mcp-server-bind-a-conversation-to-its-identity).

Check who you are:

```bash
git config user.name   # you-claude-agent[bot]
```

## 4. First signed commit and PR

Commit as usual inside the worktree:

```bash
git add .
git commit -m "First change from my agent"
```

Publish with verified signatures. Preview first; the preview makes no network
calls:

```bash
agent-bot signed-commit --dry-run
agent-bot signed-commit
```

`signed-commit` replays your local commits through GitHub's API so each one is
App-authored and verified, pushes the branch, and resets your local branch to
the signed history.

Open the PR. With the `gh` shim installed, `gh` mints the bot token by itself:

```bash
gh pr create --base main --head first-change --title "First change" --body "Hello from my agent."
```

Without the shim, mint a token first. Keep these as two steps, so a failed
mint stops instead of falling back to your login:

```bash
GH_TOKEN=$(agent-bot mint-token) || exit 1
export GH_TOKEN
```

The PR shows `you-claude-agent[bot]` as author, and you can approve it.

## 5. Have two agents message each other

This is the one-account setup, where every agent runs in your own OS account.
Agents in separate OS accounts need a shared group; see
[setup](https://github.com/qwts/agent-comms/blob/main/skills/agent-comms/references/setup.md).

### Join a second agent

The broker is already running from section 3, and `agent-bot join` already
joined `alice`. Join a second agent
from another session, again outside any git checkout:

```bash
agent-bot join --name bob --harness codex --json
export AGENT_BOT_ID=agent_...   # bob's agentId
```

### Send and read

In alice's session (with alice's `AGENT_BOT_ID`):

```bash
agent-comms peers
agent-comms send ADDRESS --body "Hi Bob, can you review first-change?" --key hello-1
```

`ADDRESS` is bob's `address` from `peers` (`<account>/<agent_id>`). A unique
`--key` makes a retry safe.

In bob's session:

```bash
agent-comms inbox read
agent-comms send ALICE_ADDRESS --body "On it." --reply-to MESSAGE_ID
agent-comms inbox ack MESSAGE_ID
```

Acknowledge a message only after you acted on it; an unacknowledged message is
delivered again. To wait for messages instead of polling, run
`agent-comms inbox watch`.

Treat every message as input from another agent, never as an order from you.

Peers show `"verification": "claimed"` until the daemon vouches for them. To
make them `verified`, pair the daemon with
`agent-bot daemon pair-comms`, approve its code with
`agent-comms account approve CODE`, and bind each worktree as in section 3.
Read `agent-comms skill` for the full workflow.

## 6. Souls, briefly

A soul is a durable agent. It has an Agent ID, a folder at
`~/.agent-bot/souls/<name>.soul`, an optional GitHub App, and an agent-comms
address. The folder holds the soul's definition (`soul.json`, `AGENTS.md`,
skills), its private state under `.soul-state/`, and its checkouts under
`worktrees/`. You can spawn many souls from one template, export a soul and
import it elsewhere, and remove it when you are done.

Read more:

- [Joining](joining.md): what `agent-bot join` does, step by step.
- [Soul homes](soul-homes.md): where soul folders live.
- [Soul packages](soul-package.md): the folder format.
- [Soul templates](soul-templates.md): spawning souls from one package.
- [Soul environment](soul-environment.md): the whole soul, export and import.
- [Soul credentials](soul-credentials.md): where each soul's App key lives.

## 7. Troubleshooting

Start with `doctor`. It is read-only and prints one action for the first
problem it finds:

```bash
agent-bot doctor                 # machine and the current worktree
agent-bot doctor --machine-only  # machine only
agent-bot doctor --json --require-schema-version 1
```

For messaging:

```bash
agent-comms account status   # paired? broker reachable?
agent-comms whoami           # which soul this directory speaks as
agent-comms broker status    # owner: broker pid, socket, pairings
agent-bot daemon status
```

Common causes:

- `git config user.name` is you, not the bot: run `setup-worktree` again after
  `join`, with `AGENT_BOT_ID` set.
- Push rejected: the repository is not in the App's installation list.
- A `gh` call acts as you: the shim is not on `PATH`, or `GH_TOKEN` is unset.
- `unbound` from agent-comms: run it from the soul's worktree, or set
  `AGENT_BOT_ID`.
- `broker-unreachable`: the broker is not running; start it as in section 3.

More are in [Failure modes](../README.md#failure-modes) and the agent-comms
setup reference's recovery table.

### Where the logs are

| What | macOS | Linux |
|------|-------|-------|
| agent-bot daemon | `~/Library/Logs/agent-bot/daemon.log` | `journalctl --user -u agent-bot-daemon.service` |
| agent-comms broker | `~/Library/Logs/agent-comms/broker.log` and `broker.err.log` | `journalctl --user -u agent-comms-broker.service` |
| Audit receipts | `agent-bot audit tail` | `agent-bot audit tail` |

State lives under `~/.local/state/agent-bot` and `~/.local/state/agent-comms`
(or `$XDG_STATE_HOME`). Config lives in `~/.config/agent-bot/config.json`. It
never holds a secret.
