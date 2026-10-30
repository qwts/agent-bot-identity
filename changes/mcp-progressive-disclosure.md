- MCP progressive disclosure: the local `agent-bot mcp` server now lists only
  the four meta-tools `search_tools` / `describe_tool` / `call_tool` /
  `call_write_tool` (matching the remote server's contract); every existing tool
  is callable through them or still directly by name. New read tools `doctor`,
  `server_status` and `guide` join the hidden registry, and the initialize
  `instructions` stamp the installed version and point at server-mode minting.
