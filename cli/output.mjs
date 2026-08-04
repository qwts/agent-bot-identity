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
  install            Install the CLI and Git hooks
  install-gh-shim    Install the fail-closed gh shim
  ensure-private-key Restore an App private key and app-id with pass-cli
`;
}

export function formatCliError(error) {
  return `agent-bot: ${error.message}\n`;
}
