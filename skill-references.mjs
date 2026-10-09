// The deliberately bounded discovery syntax shared by local and remote skill
// acquisition. It is not a full Markdown parser or a harness network hook.
export function* inlineMarkdownLinks(text) {
  const links = /\[[^\]\n]*\]\(\s*(?:<([^>\n]+)>|([^\s)]+))(?:\s+[^)\n]*)?\)/g;
  for (const match of text.matchAll(links)) yield { url: match[1] ?? match[2], line: text.slice(0, match.index).split('\n').length };
}
