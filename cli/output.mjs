export function helpText() {
  return `agent-bot — standalone agent identity runtime

Usage:
  agent-bot <command> [options]
  agent-bot --version

Commands:
  bootstrap          Bootstrap from source or repair installed machine setup
  setup-worktree     Configure the current linked worktree
  mint-token         Mint a GitHub App installation token
  doctor             Diagnose installation and identity state
  identity           Manage transcript-bound execution identities
  space              Manage durable per-soul Agent Spaces
  population         List the workstation-local census of souls
  principal          Enroll and authorize messaging principals (owner ceremony)
  daemon             Run or control the loopback daemon over the same stores
  web                Pair a browser with the daemon's private web client
  telegram           Long-poll Telegram as a thin transport over the daemon
  install            Install the CLI and Git hooks
  update             Refresh the CLI and global Git hooks from this checkout
  install-gh-shim    Install the fail-closed gh shim and optional desktop adapter
  ensure-private-key Restore an App private key and app-id with pass-cli
  signed-commit      Replay local commits with GitHub-verified signatures
  secret             Read a password or API key from a secure-store provider

Cold start:
  ./agent-bot bootstrap --profile <path|-> [options]  Run from a fresh source checkout
  agent-bot bootstrap [options]                       Use after installation
`;
}

export function formatCliError(error) {
  return `agent-bot: ${error.message}\n`;
}
