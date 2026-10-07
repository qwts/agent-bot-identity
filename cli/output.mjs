export function helpText() {
  return `agent-bot — standalone agent identity runtime

Usage:
  agent-bot <command> [options]
  agent-bot --version

Commands:
  bootstrap          Bootstrap from source or repair installed machine setup
  setup-worktree     Create or configure a soul worktree
  join               Join agent-comms as a soul from here, with or without a GitHub App: --name N --harness H [--template PATH] [--soul ID] [--json]
  mint-token         Mint a GitHub App installation token
  doctor             Diagnose installation and identity state; --probe-inbox also checks the gh-app-hook inbox answers (network, bounded, no bearer sent)
  identity           Manage execution identities and Apps (apps list; app create/connect/rotate-key/assign/remove; addon github-identity on|off); migrate-credentials [--soul ID|--all] [--dry-run] [--json] moves App keys into each soul's key store and public metadata into config; reports removable legacy folders (owner only)
  space              Manage durable per-soul Agent Spaces
  population         List this account's census of souls
  principal          Enroll and authorize messaging principals (owner ceremony)
  binding            Revoke this worktree's soul binding
  soul               Turn cold wake on or off (owner only); build [PATH] [--check] [--json]; pack validate PATH; revision <command>; model <agentId|name> [show|set <modelId>|clear] [--json] [--principal-stdin]; mode <agentId|name> [show|safe|autopilot] [--json] [--principal-stdin]; computer-use <agentId|name> [show|on|off] [--json] [--principal-stdin]; stop <agentId|name> [--json]; pause|resume <agentId|name> [--json]; show <agentId|name> [--json]; profile <agentId|name> [--json] [--file RELATIVE_PATH]; comms <soul> [show|on|off] [--json]; remove <soul> [--json] archives a soul (owner only); dir AGENT_ID; locate PATH; templates [--json]; spawn TEMPLATE_PATH --name NAME [--harness H]
                     confinement AGENT_ID off|warn|deny (owner only); confinement-report AGENT_ID [--json]
  daemon             Run, supervise, or disable the loopback daemon; vouch-key prints the soul public key
  keyd               Supervise agent-bot-keyd, the signed key holder GeniusBar ships: install --bin PATH | uninstall | status [--json]
  approvals          Tool-permission requests souls are waiting on: list [--json] | approve PROPOSAL_ID [--scope once|session] [--json] [--principal-stdin] | deny PROPOSAL_ID [--json] [--principal-stdin]
  audit              Read audit receipts: list [--json] [--since ISO-8601|-P1D] [--agent ID] [--event KIND] [--limit N] | tail [--json] [--agent ID]
  mcp                Serve the agent-bot MCP tools (bind, whoami, population)
  reach-mcp          Serve the daemon reach-back MCP tools (fetch_context, post_reply, fleet, send_message)
  wake               Hold this session's socket at the daemon's wake plane
  web                Pair a browser with the daemon's private web client
  telegram           Long-poll Telegram as a thin transport over the daemon
  install            Install the CLI and Git hooks
  update             Refresh the CLI and global Git hooks from this checkout
  install-gh-shim    Install the fail-closed gh shim and optional desktop adapter
  ensure-private-key Restore an App key into its managed store and ID into config with pass-cli
  signed-commit      Replay local commits with GitHub-verified signatures
  secret             Read a password or API key from a secure-store provider
  skill              Print this release's agent skill bundle and source commit
  sop                Resolve the configured SOP and report its pinned commits
  metrics            Collect or show optional read-only runtime metrics

Cold start:
  ./agent-bot bootstrap --profile <path|-> [options]  Run from a fresh source checkout
  agent-bot bootstrap [options]                       Use after installation
`;
}

export function formatCliError(error) {
  return `agent-bot: ${error.message}\n`;
}
