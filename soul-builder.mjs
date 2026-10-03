// Pure package-to-harness rendering. No filesystem, environment or registry
// imports: ACP spawn data includes machine-specific paths and is not build input.
import { GENERATED_HARNESS_MARKER as MARKER, isGeneratedPath } from './soul-harness-contract.mjs';

const compare = (a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b));
const text = (bytes) => new TextDecoder('utf-8', { fatal: true }).decode(bytes).replace(/\r\n?/g, '\n');

function markedSibling(path, bytes) {
  let content;
  try { content = text(bytes); } catch { return null; }
  if (content.includes('\0')) return null;
  if (/\.(md|txt)$/i.test(path)) return `${MARKER}\n${content}`;
  const comment = /\.(sh|bash|zsh|py|rb|toml|yaml|yml)$/i.test(path) ? '#'
    : /\.(js|mjs|cjs|ts|css)$/i.test(path) ? (path.endsWith('.css') ? '/*' : '//') : null;
  if (!comment) return null;
  const marker = comment === '/*' ? `/* ${MARKER} */\n` : `${comment} ${MARKER}\n`;
  // Executable siblings retain their interpreter line before its comment.
  const shebang = content.match(/^#![^\n]*(?:\n|$)/)?.[0];
  return shebang ? `${shebang.replace(/\n?$/, '\n')}${marker}${content.slice(shebang.length)}` : `${marker}${content}`;
}

export function buildHarnessFiles(packageEntries) {
  const source = new Map();
  for (const entry of packageEntries) {
    if (!entry.path || entry.path.split('/').some((part) => !part || part === '.' || part === '..') || /[\\\x00-\x1f\x7f]/.test(entry.path)) {
      throw new Error(`unsafe package path: ${entry.path}`);
    }
    if (source.has(entry.path)) throw new Error(`duplicate package path: ${entry.path}`);
    if (!isGeneratedPath(entry.path) && entry.mode !== '040000') source.set(entry.path, entry.bytes);
  }
  const output = new Map();
  if (!source.has('AGENTS.md')) return output;
  output.set('CLAUDE.md', Buffer.from(`${MARKER}\n@AGENTS.md\n`));
  output.set('GEMINI.md', Buffer.from(`${MARKER}\n@AGENTS.md\n`));
  for (const [path, bytes] of source) {
    if (!/^skills\/[^/]+\/SKILL\.md$/.test(path)) continue;
    const content = text(bytes);
    const front = content.match(/^---\n[\s\S]*?\n---(?:\n|$)/)?.[0];
    if (!front) throw new Error(`${path} needs YAML front matter`);
    const directory = path.slice(0, -'SKILL.md'.length);
    const pointers = [];
    for (const [sibling, siblingBytes] of [...source].sort(([a], [b]) => compare(a, b))) {
      if (!sibling.startsWith(directory) || sibling === path) continue;
      const marked = markedSibling(sibling, siblingBytes);
      if (marked !== null) output.set(`.claude/${sibling}`, Buffer.from(marked));
      else pointers.push(`- ${JSON.stringify(sibling.slice(directory.length))}: use the original file at ${JSON.stringify(`../../../${sibling}`)} (relative to this skill directory).`);
    }
    const appendix = pointers.length ? `\n\nSupporting files retained in the source skill directory:\n${pointers.join('\n')}\n` : '';
    output.set(`.claude/${path}`, Buffer.from(`${front.replace(/\n?$/, '\n')}${MARKER}\n${content.slice(front.length)}${appendix}`));
  }
  // Gemini does not discover Claude-compatible skills; its native skill
  // directory is within the existing, fixed v2 generated-path contract.
  for (const [path, bytes] of [...output]) {
    if (path.startsWith('.claude/skills/')) output.set(path.replace(/^\.claude\//, '.gemini/'), Buffer.from(bytes));
  }
  return new Map([...output].sort(([a], [b]) => compare(a, b)));
}
