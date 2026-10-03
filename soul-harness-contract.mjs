// Shared with soul-builder: only exact build output is ignored; the marker is
// informational and cannot authenticate generated content. Prefixes are root-relative.
export const GENERATED_HARNESS_PATHS = Object.freeze([
  '.claude/', '.codex/', '.cursor/', '.opencode/', '.devin/', '.gemini/',
  '.github/copilot-instructions.md', 'CLAUDE.md', 'GEMINI.md',
]);
export const GENERATED_HARNESS_MARKER = '<!-- agent-bot soul-builder: generated -->';
// Format 2's fixed contract. Generated paths are eligible only for exact-byte
// matching against expectedGeneratedFiles, never for marker-based ignoring.
export const PACKAGE_IGNORE_LIST = Object.freeze({
  directories: Object.freeze(['worktrees/', '.soul-state/']),
  generatedPaths: GENERATED_HARNESS_PATHS,
  generatedMarker: GENERATED_HARNESS_MARKER,
});

export function isGeneratedPath(path) {
  return GENERATED_HARNESS_PATHS.some((candidate) => candidate.endsWith('/')
    ? path.startsWith(candidate) : path === candidate);
}
