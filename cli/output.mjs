export function helpText() {
  return `agent-bot — standalone agent identity runtime

Usage:
  agent-bot <command> [options]
  agent-bot --version

Commands:
  setup-worktree     Configure the current linked worktree
  mint-token         Mint a GitHub App installation token
  doctor             Diagnose installation and identity state
  identity           Manage transcript-bound execution identities
  space              Manage durable per-soul Agent Spaces
  install            Install the CLI and Git hooks
  update             Refresh the CLI and global Git hooks from this checkout
  install-gh-shim    Install the fail-closed gh shim
  ensure-private-key Restore an App private key and app-id with pass-cli
  signed-commit      Replay local commits with GitHub-verified signatures
  secret             Read a password or API key from a secure-store provider
`;
}

export function formatCliError(error) {
  return `agent-bot: ${error.message}\n`;
}
