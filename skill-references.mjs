// The deliberately bounded discovery syntax shared by local and remote skill
// acquisition. It is not a full Markdown parser or a harness network hook.
export function* inlineMarkdownLinks(text) {
  const links = /\[[^\]\n]*\]\(\s*(?:<([^>\n]+)>|([^\s)]+))(?:\s+[^)\n]*)?\)/g;
  for (const match of text.matchAll(links)) yield { url: match[1] ?? match[2], line: text.slice(0, match.index).split('\n').length };
}

// What capture does not cover (#312; owner decision 2026-10-09): only
// agent-bot's own skill import, check, update and learn commands capture,
// checksum and recheck instruction files. Every command that reports
// checksums or dependencies says so in its output, rather than implying that
// whatever a harness reads was captured.
export const NOT_CAPTURED = 'Only agent-bot soul skill import, check, update and learn capture, checksum and recheck instruction files. '
  + 'Not captured: anything a harness fetches or reads on its own (web fetch, MCP tools, its own file reads), runtime fetches, '
  + 'and references outside the reported dependency boundary.';
