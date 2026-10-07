// Shared with soul-builder: only exact build output is ignored; the marker is
// informational and cannot authenticate generated content. Prefixes are root-relative.
// `.codex/` and `.gemini/` already cover their MCP config files
// (`.codex/config.toml`, `.gemini/settings.json`, #378); only the two root
// files need naming. Soul hooks (#378 slice 3) add Copilot's one dedicated
// hook file — exactly that file, never `.github/hooks/`, whose other files
// stay the soul's. The harness adapters slice (#378) appends Copilot's and
// Kiro's subagent folders and Kiro's MCP file — only those, never `.github/`
// or `.kiro/` as a whole (`.cursor/` and `.devin/` already cover theirs).
// Array order is part of the canonical format-2 ignore list, so entries are
// only ever appended or deliberately reordered.
export const GENERATED_HARNESS_PATHS = Object.freeze([
  '.claude/', '.codex/', '.cursor/', '.opencode/', '.devin/', '.gemini/',
  '.github/copilot-instructions.md', '.mcp.json', 'CLAUDE.md', 'GEMINI.md', 'opencode.json',
  '.github/hooks/agent-bot-soul.json',
  '.github/agents/', '.kiro/agents/', '.kiro/settings/mcp.json',
]);
export const GENERATED_HARNESS_MARKER = '<!-- agent-bot soul-builder: generated -->';
// Format 2's fixed contract. Generated paths are eligible only for exact-byte
// matching against expectedGeneratedFiles, never for marker-based ignoring.
export const PACKAGE_IGNORE_LIST = Object.freeze({
  directories: Object.freeze(['worktrees/', '.soul-state/']),
  generatedPaths: GENERATED_HARNESS_PATHS,
  generatedMarker: GENERATED_HARNESS_MARKER,
});

// Ignore lists earlier releases wrote into format-2 souls, newest first
// (#378 slice 1 inserted `.mcp.json` and `opencode.json`, 0.10.25; slice 3
// appended Copilot's soul hook file; the adapters slice appended Copilot's and
// Kiro's agent folders and Kiro's MCP file). A newer agent-bot
// still reads a soul carrying one of these: the generated paths it adds are
// its own renderer's, so the package hashes the same. An unknown list stays
// refused, so an older agent-bot never guesses at a newer soul.
export const PRIOR_PACKAGE_IGNORE_LISTS = Object.freeze([
  Object.freeze({
    directories: PACKAGE_IGNORE_LIST.directories,
    generatedPaths: Object.freeze([
      '.claude/', '.codex/', '.cursor/', '.opencode/', '.devin/', '.gemini/',
      '.github/copilot-instructions.md', '.mcp.json', 'CLAUDE.md', 'GEMINI.md', 'opencode.json',
      '.github/hooks/agent-bot-soul.json',
    ]),
    generatedMarker: GENERATED_HARNESS_MARKER,
  }),
  Object.freeze({
    directories: PACKAGE_IGNORE_LIST.directories,
    generatedPaths: Object.freeze([
      '.claude/', '.codex/', '.cursor/', '.opencode/', '.devin/', '.gemini/',
      '.github/copilot-instructions.md', '.mcp.json', 'CLAUDE.md', 'GEMINI.md', 'opencode.json',
    ]),
    generatedMarker: GENERATED_HARNESS_MARKER,
  }),
  Object.freeze({
    directories: PACKAGE_IGNORE_LIST.directories,
    generatedPaths: Object.freeze([
      '.claude/', '.codex/', '.cursor/', '.opencode/', '.devin/', '.gemini/',
      '.github/copilot-instructions.md', 'CLAUDE.md', 'GEMINI.md',
    ]),
    generatedMarker: GENERATED_HARNESS_MARKER,
  }),
]);

export function isGeneratedPath(path) {
  return GENERATED_HARNESS_PATHS.some((candidate) => candidate.endsWith('/')
    ? path.startsWith(candidate) : path === candidate);
}
