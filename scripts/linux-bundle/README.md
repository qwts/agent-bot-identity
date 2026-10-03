# Linux CLI bundle

A release archive per platform that carries a pinned Node, `agent-bot` and
`agent-comms`, plus `install.sh`, `uninstall.sh` and the `systemd --user` unit
templates. It is the headless-Linux install path in
[ADR-0332 decision 1](../../docs/decisions/ADR-0332-souls-are-the-agents-territory.md):
a cloud agent's computer gets a supported install with no Homebrew and no root.

Three release artifacts now exist per version — the formula, GeniusBar's bundle
and these archives — and CI builds and tests each one.

## Install

```bash
tar -xzf agent-bot-linux-x64-v0.10.5.tar.gz
cd agent-bot-linux-x64-v0.10.5   # whatever the tarball unpacks to
./install.sh
```

`install.sh` never needs root. It:

1. copies `bundle/` into `${XDG_DATA_HOME:-$HOME/.local/share}/agent-bot`;
2. writes marked wrappers for `agent-bot`, `agent-comms` and `node` into
   `~/.local/bin`;
3. adds `~/.local/bin` to a login shell's PATH the way GeniusBar #41 does;
4. writes `agent-bot-daemon.service` and `agent-comms-broker.service` into
   `~/.config/systemd/user` and starts them.

Open a new login shell afterwards, or `. ~/.profile` (`.zprofile` for zsh).

### Options

| Flag | Meaning |
|------|---------|
| `--prefix DIR` | install directory, default `${XDG_DATA_HOME:-$HOME/.local/share}/agent-bot` |
| `--bin-dir DIR` | wrapper directory, default `$HOME/.local/bin` |
| `--replace` | preserve a foreign file at a wrapper path as `<name>.before-agent-bot` |
| `--migrate` | take the pair over from another install's broker and daemon |
| `--no-services` | install the tree and wrappers, write no units |

### Wrappers and markers

Every wrapper `install.sh` writes is a `#!/bin/sh` script carrying the marker
line:

```text
# agent-bot-linux-cli-tool
```

That marker is the whole ownership contract. A file at a wrapper path is
replaced only when it carries it; anything else — a Homebrew keg's symlink, a
checkout, GeniusBar's own wrapper — belongs to another install and is never
overwritten without `--replace`. With `--replace` the foreign file is renamed to
`<name>.before-agent-bot`, and `uninstall.sh` puts it back at the original path.

### PATH

If `~/.local/bin` is not already on PATH for a login shell, `install.sh` appends
one marked block:

```text
# >>> agent-bot PATH >>>
# Managed by the agent-bot Linux bundle install. uninstall.sh removes this block.
case ":$PATH:" in
  *":$HOME/.local/bin:"*) ;;
  *) PATH="$HOME/.local/bin:$PATH" ;;
esac
export PATH
# <<< agent-bot PATH <<<
```

It goes in `~/.zprofile` for zsh (or `$ZDOTDIR/.zprofile` when that is set) and
`~/.profile` for sh, bash and dash. Running install twice appends nothing: the
markers are matched against the whole file, and a startup file that already puts
`~/.local/bin` on PATH by hand is left alone. `uninstall.sh` deletes exactly the
lines between the markers.

### One broker and one daemon per user

[ADR-0332 decision 2](../../docs/decisions/ADR-0332-souls-are-the-agents-territory.md)
makes the pair per OS user, from one install. The unit names are fixed, so
`install.sh` checks for another install's pair before it writes anything:

- a `agent-bot-daemon.service` or `agent-comms-broker.service` unit file in this
  user's `~/.config/systemd/user`;
- either unit reported `active` by `systemctl --user`;
- a running `agent-bot daemon run` or agent-comms broker process outside this
  install's prefix.

Findings are printed with the install each belongs to, and then:

```bash
./install.sh            # exits non-zero, changes nothing
./install.sh --migrate  # stops and disables the other pair, starts this one
```

`--migrate` preserves the other install's unit files as
`<prefix>/<unit>.migrated`, so a failure while starting this install's pair puts
them back and re-enables the previous pair before it exits.

Two OS users on one machine each have their own pair and never see each other's;
everything here resolves from `$HOME`.

## Uninstall

```bash
./uninstall.sh
```

It stops and disables the units this install wrote, deletes those unit files,
removes the marked wrappers, restores any `<name>.before-agent-bot`, deletes
exactly the marked PATH block, and removes the install directory. `--keep-tree`
does everything except the last step.

**Souls are never deleted.** `~/.agent-bot/souls` and `$AGENT_BOT_SOULS_HOME` are
not read, moved or removed by either script, and neither script touches an Agent
Space under `~/.agent-space`. Removing an install removes the three paths it
wrote and nothing else.

## Building

```bash
node scripts/linux-bundle/build.mjs --platform all --out dist
node scripts/linux-bundle/build.mjs --platform linux-x64 --require-verified
```

The build runs on macOS: it downloads the Linux Node tarball, unpacks it, fetches
agent-comms by commit with git, and copies files. Nothing executes a Linux
binary. One x64 or macOS CI job produces both archives.

Each archive is named `agent-bot-linux-<platform>-v<version>.tar.gz`, and
`SHA256SUMS` covers the set. `--platform all` writes both plus the checksum file.

### Pins

`components.json` pins every artifact, each by the anchor that can actually be
verified. The build checks each one before anything is unpacked and fails on a
mismatch, so a re-publish cannot enter an archive.

```json
{
  "node": { "version": "24.21.0", "tarballs": { "linux-x64": { "url": "…", "sha256": "…" } } },
  "agent_comms": { "repo": "qwts/agent-comms", "tag": "v0.3.3", "ref": "3948c9a8…", "bin": "bin/agent-comms.mjs" }
}
```

Node is pinned by version and SHA-256, and the download is compared against the
checksum before it is unpacked. `agent-comms` is pinned exactly the way GeniusBar
pins it in its own `components.json` — repository, release tag, and the full
commit that tag must resolve to — because the commit SHA *is* the integrity pin:

1. `git ls-remote https://github.com/qwts/agent-comms.git refs/tags/v0.3.3*`
   must resolve to the pinned commit. An annotated tag is peeled (`^{}`); a
   lightweight tag is the commit. A moved tag fails the build.
2. `git fetch --depth 1 <url> <ref>` into a temp repository, then
   `git archive FETCH_HEAD | tar -x`.
3. Only the entries the package's own `package.json` `files` list names are
   copied, plus `package.json` and `LICENSE`.

The `qwts/agent-comms` repository is the agent-comms this runtime talks to —
the same one GeniusBar bundles. It is **not** the unrelated npm package that
shares the name: the verbs the runtime calls over the broker socket
(`comms-client.mjs`) are what identify it, and the build checks them below.

v0.3.3 has no npm dependencies, so there is nothing to resolve and no install
step in the archive: no `node_modules` tree, no `npm install`, and no third-party
install script that could run on a maintainer's machine. Its entry point is
`bin/agent-comms.mjs`, which is what `bundle/bin/agent-comms` launches and what
the broker unit execs.

### The verb check

The runtime calls agent-comms for exactly four verbs: `join`
(`agent-daemon.mjs:111`), `inbox read` / `send` / `inbox ack`
(`comms-relay.mjs:36-38`) and the broker it pairs with. After staging, the build
runs the fetched CLI's own `--help` and requires each verb to be listed as a
command:

```bash
node bundle/lib/agent-comms/bin/agent-comms.mjs --help   # join, inbox, send, broker
```

That runs on the build host's Node, never the bundled Linux binary — agent-comms
is plain JavaScript, so what its help dispatches does not depend on the runtime
that would execute it. The result is recorded in `bundle-report.json` as
`agentComms.verified`, with `provided` and `missing` beside it. `--require-verified`,
which the release workflow passes, turns a missing verb — or an archive built
with `--skip-comms`, which carries no broker at all — into a build failure.

Bump a pin, rebuild, and let CI check it. Never hand-edit an assembled archive.
There is no environment override for the agent-comms pin: the file is the pin,
`git` verifies the content, and `--offline` reuses a warm
`.guard/linux-bundle-cache` when a build must not reach the network.

## Testing without touching the machine

`install.sh` and `uninstall.sh` take every path from `$HOME`, `--prefix` and
`--bin-dir`, and every `systemctl` and `ps` call goes through an injectable
command. Tests run them against a temp HOME with fakes:

```bash
AGENT_BOT_SYSTEMCTL=/path/to/fake-systemctl AGENT_BOT_PS=/path/to/fake-ps \
  HOME=/tmp/fake-home ./install.sh --migrate
```

`AGENT_BOT_SYSTEMCTL` and `AGENT_BOT_PS` exist for exactly that: a test never
reaches a real user manager, and never sees the developer's own running daemon
and decides it is a second pair.

## Files

| Path | Role |
|------|------|
| `build.mjs` | fetch, verify, assemble, checksum |
| `components.json` | pinned Node checksums and the agent-comms commit |
| `install.sh` | one-user install, wrappers, PATH, units |
| `uninstall.sh` | the exact inverse |
| `lib/common.sh` | shared POSIX helpers: markers, paths, migration |
| `systemd/*.service.in` | `systemd --user` unit templates |
