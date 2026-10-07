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

// The soul's own MCP server (#378): the reach and agent-comms channel in the
// registered placement the daemon already documents for desktop harnesses. The
// command is `agent-bot` from PATH — every install adds it — with the same
// subcommand the drive engine injects, so a soul opened by hand in its own
// directory reaches its teammates exactly as a daemon-run turn does. Nothing
// machine-specific is written: the server identifies the soul from the working
// directory's `agentBot.agentId` pin, so one package renders the same bytes on
// every host.
export const MCP_SERVER_NAME = 'agent-bot';
export const MCP_COMMAND = 'agent-bot';
export const MCP_SUBCOMMAND = 'reach-mcp';

// Where each harness's native file spells that one server. `key` is the JSON
// object the builder owns inside it, `table` the TOML table it owns; every
// other key, and every other server, is the soul's and is merged through.
export const MCP_TARGETS = Object.freeze([
  Object.freeze({ harness: 'claude', path: '.mcp.json', format: 'json', key: 'mcpServers', style: 'stdio' }),
  Object.freeze({ harness: 'gemini', path: '.gemini/settings.json', format: 'json', key: 'mcpServers', style: 'stdio' }),
  Object.freeze({ harness: 'codex', path: '.codex/config.toml', format: 'toml', table: `mcp_servers.${MCP_SERVER_NAME}` }),
  Object.freeze({ harness: 'opencode', path: 'opencode.json', format: 'json', key: 'mcp', style: 'local' }),
]);

// The harnesses the toolkit knows, with what this builder renders for each: a
// native consumer reads AGENTS.md and the shared `.claude/skills/` directly, so
// its instructions need no generated file. `mcp: null` marks a harness with no
// adapter in this slice; a later slice adds one rather than leaving a declared
// primitive silently dropped.
const HARNESS_FILES = Object.freeze({
  claude: Object.freeze({ instructions: 'CLAUDE.md', skills: '.claude/skills/', mcp: '.mcp.json', subagents: '.claude/agents/', commands: '.claude/commands/' }),
  gemini: Object.freeze({ instructions: 'GEMINI.md', skills: '.gemini/skills/', mcp: '.gemini/settings.json', commands: '.gemini/commands/' }),
  codex: Object.freeze({ instructions: null, skills: null, mcp: '.codex/config.toml' }),
  opencode: Object.freeze({ instructions: null, skills: null, mcp: 'opencode.json', subagents: '.opencode/agent/', commands: '.opencode/command/' }),
  cursor: Object.freeze({ instructions: null, skills: '.claude/skills/', mcp: null }),
  copilot: Object.freeze({ instructions: null, skills: '.claude/skills/', mcp: null }),
  devin: Object.freeze({ instructions: null, skills: '.claude/skills/', mcp: null }),
  muse: Object.freeze({ instructions: null, skills: null, mcp: null }),
});

// JSON has no comment syntax, so a generated JSON file carries the marker as
// its first `_comment` string: the same header position as every other marked
// file, in a key each harness ignores rather than a syntax error it refuses.
const JSON_MARKER = /^\{\s*"_comment"\s*:\s*"<!-- agent-bot soul-builder: generated -->"/;

export function hasGeneratedJsonMarker(content) {
  return JSON_MARKER.test(content);
}

function mcpServer(style) {
  return style === 'local'
    ? { type: 'local', command: [MCP_COMMAND, MCP_SUBCOMMAND] }
    : { command: MCP_COMMAND, args: [MCP_SUBCOMMAND] };
}

// soul.json `comms: false` opts a soul out of agent-comms, so it gets no MCP
// entry (#381 owns the setting; absent means on). Read here rather than through
// soulCommsSetting because the renderer must stay free of the disk layer.
export function soulCommsDeclared(source) {
  const bytes = source.get('soul.json');
  if (!bytes) return true;
  let manifest;
  try { manifest = JSON.parse(text(bytes)); } catch { return true; } // the package reader validates it
  return manifest?.comms !== false;
}

function targetFor(path) {
  const target = MCP_TARGETS.find((candidate) => candidate.path === path);
  if (!target) throw new Error(`not a rendered MCP path: ${path}`);
  return target;
}

function authoredText(path, bytes) {
  let content;
  try { content = text(bytes); }
  catch { throw new Error(`${path} must be UTF-8 text to merge the ${MCP_SERVER_NAME} MCP server into it`); }
  if (content.includes('\0')) throw new Error(`${path} is binary and cannot carry the ${MCP_SERVER_NAME} MCP server`);
  return content;
}

function authoredObject(target, bytes) {
  const content = authoredText(target.path, bytes);
  let value;
  try { value = JSON.parse(content); }
  catch (error) { throw new Error(`${target.path} is not valid JSON, so the ${MCP_SERVER_NAME} MCP server cannot be merged into it (${error.message})`); }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${target.path} must be a JSON object to merge the ${MCP_SERVER_NAME} MCP server into it`);
  }
  if (value[target.key] !== undefined && value[target.key] !== null
      && (typeof value[target.key] !== 'object' || Array.isArray(value[target.key]))) {
    throw new Error(`${target.path} ${target.key} must be a JSON object of servers to merge the ${MCP_SERVER_NAME} MCP server into it`);
  }
  return value;
}

// The server names a soul's own MCP file already declares, sorted, so
// `--check` can name what a merge kept. Throws exactly what the merge would.
export function mergeableMcpServers(path, bytes) {
  const target = targetFor(path);
  if (target.format === 'toml') return Object.freeze(tomlServerNames(target, authoredText(path, bytes)));
  return Object.freeze(Object.keys(authoredObject(target, bytes)[target.key] ?? {}).sort());
}

// The `mcp_servers.<name>` tables a Codex config declares, without their
// sub-tables: exactly the servers the merge has to keep beside ours.
function tomlServerNames(target, content) {
  const prefix = `${target.table.slice(0, target.table.indexOf('.'))}.`;
  const names = new Set();
  for (const [, header] of content.matchAll(/^\s*\[\[?([^\]\s]+)\]\]?[ \t]*(#.*)?$/gm)) {
    const name = header.startsWith(prefix) ? header.slice(prefix.length) : '';
    if (name && !name.includes('.')) names.add(name);
  }
  return [...names].sort();
}

function renderMcp(target, authored) {
  if (authored === undefined || authored === null) {
    return target.format === 'toml' ? Buffer.from(tomlMerge(target, Buffer.alloc(0)))
      : Buffer.from(`${JSON.stringify({ _comment: MARKER, [target.key]: { [MCP_SERVER_NAME]: mcpServer(target.style) } }, null, 2)}\n`);
  }
  if (target.format === 'toml') return Buffer.from(tomlMerge(target, authored));
  const { _comment: _authored, ...rest } = authoredObject(target, authored);
  return Buffer.from(`${JSON.stringify({
    _comment: MARKER,
    ...rest,
    [target.key]: { ...(rest[target.key] ?? {}), [MCP_SERVER_NAME]: mcpServer(target.style) },
  }, null, 2)}\n`);
}

// TOML has no parser here (zero dependencies), so the merge is section-level
// and only ever touches the one table the builder owns: every other table,
// key, comment and blank line is kept verbatim and in order. A previous
// render's table and marker line are dropped first, so the merge is idempotent
// byte for byte.
function tomlMerge(target, authored) {
  const kept = [];
  let skipping = false;
  for (const line of authoredText(target.path, authored).split('\n')) {
    const header = line.match(/^\s*\[\[?([^\]\s]+)\]\]?[ \t]*(#.*)?$/);
    if (header) skipping = header[1] === target.table || header[1].startsWith(`${target.table}.`);
    if (skipping) continue;
    if (line.trim() === MARKER || line.trim() === `# ${MARKER}`) continue;
    kept.push(line);
  }
  const body = kept.join('\n').replace(/^\n+|\n+$/g, '');
  const table = [`[${target.table}]`, `command = "${MCP_COMMAND}"`, `args = ["${MCP_SUBCOMMAND}"]`].join('\n');
  return `# ${MARKER}\n${body ? `${body}\n\n` : ''}${table}\n`;
}

// Claude renders every declared agent/command, so its output inventories the
// received names even for harnesses without adapters. No hidden Map metadata
// or source/disk access is needed by the report.
export function harnessReport(output, { comms = true } = {}) {
  const skills = [...output.keys()].some((path) => Object.values(HARNESS_FILES).some((files) => files.skills && path.startsWith(files.skills)));
  const names = (prefix) => prefix ? [...output.keys()].filter((path) => path.startsWith(prefix))
    .map((path) => path.slice(prefix.length).replace(/\.(md|toml)$/, '')).sort(compare) : [];
  const received = { subagents: names(HARNESS_FILES.claude.subagents), commands: names(HARNESS_FILES.claude.commands) };
  const report = {};
  for (const [harness, files] of Object.entries(HARNESS_FILES)) {
    const paths = [...output.keys()].filter((path) => path === files.instructions
      || (files.skills && path.startsWith(files.skills)) || path === files.mcp
      || (files.subagents && path.startsWith(files.subagents)) || (files.commands && path.startsWith(files.commands)));
    // An empty build rendered nothing at all: there is no AGENTS.md to point a
    // harness at, so it gets no instructions either.
    const rendered = [];
    if (output.size > 0) {
      rendered.push('instructions');
      if (skills) rendered.push('skills');
      if (comms && files.mcp) rendered.push('mcp');
    }
    const primitives = {}, unsupported = {};
    for (const kind of ['subagents', 'commands']) {
      const delivered = names(files[kind]);
      primitives[kind] = { received: [...received[kind]], rendered: delivered };
      unsupported[kind] = files[kind] ? [] : [...received[kind]];
      if (delivered.length) rendered.push(kind);
    }
    report[harness] = { rendered, files: paths, ...primitives, unsupported };
  }
  return report;
}

function primitiveName(name, path) {
  // The same name grammar as package skills, including its length bound.
  if (name.length > 64 || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name)) {
    throw new Error(`${path}: name must use lowercase letters, digits and single hyphens (1–64 characters)`);
  }
  return name;
}

// Only the declaration fields below are translated, not arbitrary YAML. Keep
// the original header for Claude and fail closed on ambiguous translated fields.
// Like skillField in soul-package, scalars support plain/quoted strings and
// literal/folded blocks. This module cannot import the package reader (a cycle).
function declaration(path, bytes, required) {
  let content;
  try { content = text(bytes); } catch { throw new Error(`${path} must be UTF-8 text`); }
  if (content.includes('\0')) throw new Error(`${path} must be text without NUL bytes`);
  const match = content.match(/^---\n([\s\S]*?)^---(?:\n|$)/m);
  const front = match?.index === 0 ? match[0] : '';
  if (!front && (required || content.startsWith('---\n'))) throw new Error(`${path} needs YAML front matter`);
  const fields = new Map();
  const header = front ? match[1] : '';
  const fieldPattern = /^([\w-]+):[ \t]*([^\n]*)(\n(?:(?:[ \t]+[^\n]*|)\n)*)?/gm;
  for (const field of header.matchAll(fieldPattern)) {
    if (fields.has(field[1])) throw new Error(`${path}: duplicate ${field[1]} field`);
    fields.set(field[1], { raw: field[2].trim(), tail: field[3]?.slice(1) ?? '' });
  }
  if (header.replace(fieldPattern, '').split('\n').some((line) => line.trim() && !line.trim().startsWith('#'))) {
    throw new Error(`${path}: unsupported YAML front matter`);
  }
  return { front, body: content.slice(front.length), fields };
}

function scalar(raw, label) {
  let value, quoted;
  if ((quoted = raw.match(/^("(?:[^"\\]|\\.)*")(?:[ \t]+#.*)?$/))) {
    try { value = JSON.parse(quoted[1]); } catch { throw new Error(`${label}: invalid quoted string`); }
  } else if ((quoted = raw.match(/^'((?:[^']|'')*)'(?:[ \t]+#.*)?$/))) {
    value = quoted[1].replaceAll("''", "'");
  } else {
    value = raw.replace(/\s+#.*$/, '').trim();
    if (/^["'\[\]{}&*!>|#]/.test(value) || /^(?:null|true|false|~|[\d.+-]+)$/i.test(value) || /:\s/.test(value)) {
      throw new Error(`${label} must be a string (quote YAML punctuation)`);
    }
  }
  if (!value || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value)) throw new Error(`${label} must be a nonempty text string`);
  return value;
}

function declarationField(fields, key, path, required = false) {
  const field = fields.get(key), label = `${path} ${key}`;
  if (!field) {
    if (required) throw new Error(`${label} is required`);
    return undefined;
  }
  const block = field.raw.match(/^([>|])([-+]?)(?:\s+#.*)?$/);
  if (!block) {
    if (field.tail.trim()) throw new Error(`${label}: use a literal or folded block for multiline strings`);
    return scalar(field.raw, label);
  }
  const lines = field.tail.replace(/\n$/, '').split('\n');
  const indent = lines.find((line) => line.trim())?.match(/^ */)[0].length ?? 0;
  if (!indent || lines.some((line) => line.trim() && !line.startsWith(' '.repeat(indent)))) {
    throw new Error(`${label}: invalid block indentation`);
  }
  const body = lines.map((line) => line.slice(indent));
  let value = body.reduce((out, line, i) => {
    if (!i) return line;
    if (block[1] === '|' || !line || /^[ \t]/.test(line) || /^[ \t]/.test(body[i - 1])) return `${out}\n${line}`;
    return `${out}${body[i - 1] ? ' ' : ''}${line}`;
  }, '');
  value = block[2] === '+' ? `${value}\n` : value.replace(/\n*$/, '') + (block[2] === '-' ? '' : '\n');
  if (!value.trim()) throw new Error(`${label} must be a nonempty string`);
  return value;
}

function agentTools(fields, path) {
  const field = fields.get('tools');
  if (!field) return undefined;
  const label = `${path} tools`;
  let values;
  if (!field.raw || field.raw.startsWith('#')) {
    values = field.tail.split('\n').filter((line) => line.trim() && !line.trim().startsWith('#')).map((line) => {
      const item = line.match(/^ +-[ \t]+(.+)$/);
      if (!item) throw new Error(`${label} must be a list of tool names`);
      return scalar(item[1].trim(), label);
    });
    if (!values.length) throw new Error(`${label} must be a list of tool names`);
  } else if (field.raw.startsWith('[')) {
    const list = field.raw.match(/^\[(.*)\](?:\s+#.*)?$/);
    if (!list || field.tail.trim()) throw new Error(`${label} must be a list of tool names`);
    values = list[1].trim() ? list[1].split(',').map((item) => scalar(item.trim(), label)) : [];
  } else {
    values = declarationField(fields, 'tools', path).split(',').map((item) => item.trim());
  }
  if (values.some((name) => !/^[A-Za-z][A-Za-z0-9_-]*$/.test(name))) throw new Error(`${label} must contain tool names, not permission expressions`);
  // Claude's tools field is an allowlist; disable unlisted OpenCode tools too.
  // MultiEdit uses OpenCode's edit tool; other native names use lowercase.
  return [...new Set(values.map((name) => name === 'MultiEdit' ? 'edit' : name.toLowerCase()))].sort(compare);
}

// Omit an empty command header: the disk layer's existing marker recognizer
// expects at least one line inside front matter. The prompt is still verbatim.
const markedDeclaration = ({ front, body }) => `${front && !/^---\n---(?:\n|$)$/.test(front) ? front.replace(/\n?$/, '\n') : ''}${MARKER}\n${body}`;
const mappedDeclaration = (header, body) => `---\n${header.join('\n')}\n---\n${MARKER}\n${body}`;
// JSON strings are also YAML strings and TOML basic strings; DEL needs an
// explicit escape for TOML. Escaping newlines avoids triple-quote collisions.
const quotedString = (value) => JSON.stringify(value).replace(/\x7f/g, '\\u007f');

function renderPrimitives(source, output) {
  for (const [path, bytes] of source) {
    if (!/^(agents|commands)\/.*\.md$/.test(path)) continue;
    const [directory, ...parts] = path.split('/');
    const name = primitiveName(parts.join('/').slice(0, -3), path);
    const agent = directory === 'agents';
    const parsed = declaration(path, bytes, agent);
    const description = declarationField(parsed.fields, 'description', path, agent);
    const header = description === undefined ? [] : [`description: ${quotedString(description)}`];
    if (agent) {
      const declaredName = primitiveName(declarationField(parsed.fields, 'name', path, true), path);
      if (declaredName !== name) throw new Error(`${path}: agent name must match filename ${name}`);
      header.push('mode: subagent');
      const model = declarationField(parsed.fields, 'model', path);
      if (model !== undefined) header.push(`model: ${quotedString(model)}`);
      const tools = agentTools(parsed.fields, path);
      if (tools) header.push('tools:', '  "*": false', ...tools.map((tool) => `  ${quotedString(tool)}: true`));
      output.set(`.opencode/agent/${name}.md`, Buffer.from(mappedDeclaration(header, parsed.body)));
    } else {
      output.set(`.opencode/command/${name}.md`, Buffer.from(header.length ? mappedDeclaration(header, parsed.body) : `${MARKER}\n${parsed.body}`));
      const toml = [`# ${MARKER}`, ...(description === undefined ? [] : [`description = ${quotedString(description)}`]),
        `prompt = ${quotedString(parsed.body.replaceAll('$ARGUMENTS', '{{args}}'))}`];
      output.set(`.gemini/commands/${name}.toml`, Buffer.from(`${toml.join('\n')}\n`));
    }
    output.set(`.claude/${directory}/${name}.md`, Buffer.from(markedDeclaration(parsed)));
  }
}

export function buildHarnessFiles(packageEntries, { authored = new Map() } = {}) {
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
  renderPrimitives(source, output);
  // The soul's MCP entry (#378), unless its soul.json turned comms off. A soul
  // that already ships one of these files keeps its own servers: the disk
  // layer hands those bytes over as an explicit input, so rendering stays pure
  // and repeatable from the same package plus the same file.
  if (soulCommsDeclared(source)) {
    for (const target of MCP_TARGETS) output.set(target.path, renderMcp(target, authored.get(target.path)));
  }
  return new Map([...output].sort(([a], [b]) => compare(a, b)));
}
