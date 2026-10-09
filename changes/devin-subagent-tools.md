- Devin CLI subagents rendered from a soul now spell Claude's `Write` as Devin's
  `edit` tool (Devin has no `write` tool name, so such a subagent previously lost
  its declared write access), and keep a declared MCP tool's exact
  `mcp__<server>__<tool>` name instead of reporting the subagent unsupported
  (#378). Kiro and other adapters are unchanged.
