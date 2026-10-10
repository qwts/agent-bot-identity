// Pure package-to-harness rendering. No filesystem, environment or registry
// imports: ACP spawn data includes machine-specific paths and is not build input.
import { GENERATED_HARNESS_MARKER as MARKER, isGeneratedPath } from './soul-harness-contract.mjs';
import { REACH_SERVER_NAME } from './reach-contract.mjs';
import { CANONICAL_EVENTS, isBlocking, nativeHookEntry, SOUL_HOOK_MARKER, vendorEvent } from './hook-dialects.mjs';
import { PROVIDERS, claudeProviderEnv, codexProviderConfig, normalizeProvider, opencodeProviderConfig, providerRenders } from './soul-providers.mjs';

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
export const MCP_SERVER_NAME = REACH_SERVER_NAME;
const LEGACY_MCP_SERVER_NAME = 'agent-bot';
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
  // Project-level files each harness documents (see docs/soul-builder.md,
  // "Format evidence"). Copilot CLI and Devin CLI read the shared `.mcp.json`.
  Object.freeze({ harness: 'cursor', path: '.cursor/mcp.json', format: 'json', key: 'mcpServers', style: 'stdio' }),
  Object.freeze({ harness: 'kiro', path: '.kiro/settings/mcp.json', format: 'json', key: 'mcpServers', style: 'stdio' }),
  // Qwen Code's project settings file also holds the soul's other settings;
  // only `mcpServers.agent-reach` is the builder's (#247).
  Object.freeze({ harness: 'qwen', path: '.qwen/settings.json', format: 'json', key: 'mcpServers', style: 'stdio' }),
]);

// The harnesses the toolkit knows, with what this builder renders for each: a
// native consumer reads AGENTS.md and the shared `.claude/skills/` directly, so
// its instructions need no generated file. `mcp: null` marks a harness with no
// adapter in this slice; a later slice adds one rather than leaving a declared
// primitive silently dropped. A path another harness owns (`.mcp.json`,
// `.claude/commands/`) is one this harness documents reading natively.
const HARNESS_FILES = Object.freeze({
  claude: Object.freeze({ instructions: 'CLAUDE.md', skills: '.claude/skills/', mcp: '.mcp.json', subagents: '.claude/agents/', commands: '.claude/commands/' }),
  gemini: Object.freeze({ instructions: 'GEMINI.md', skills: '.gemini/skills/', mcp: '.gemini/settings.json', commands: '.gemini/commands/' }),
  codex: Object.freeze({ instructions: null, skills: null, mcp: '.codex/config.toml' }),
  opencode: Object.freeze({ instructions: null, skills: null, mcp: 'opencode.json', subagents: '.opencode/agent/', commands: '.opencode/command/' }),
  cursor: Object.freeze({ instructions: null, skills: '.claude/skills/', mcp: '.cursor/mcp.json', subagents: '.cursor/agents/' }),
  copilot: Object.freeze({ instructions: null, skills: '.claude/skills/', mcp: '.mcp.json', subagents: '.github/agents/', commands: '.claude/commands/' }),
  devin: Object.freeze({ instructions: null, skills: '.claude/skills/', mcp: '.mcp.json', subagents: '.devin/agents/', commands: '.claude/commands/' }),
  muse: Object.freeze({ instructions: null, skills: null, mcp: null }),
  // Kiro reads AGENTS.md and the shared skills; its wake lanes are #523.
  kiro: Object.freeze({ instructions: null, skills: '.claude/skills/', mcp: '.kiro/settings/mcp.json', subagents: '.kiro/agents/' }),
  // Qwen Code reads AGENTS.md natively; its skills live under `.qwen/` in a
  // folder not rendered yet (#247). Commands and agents are Markdown (#378).
  qwen: Object.freeze({ instructions: null, skills: null, mcp: '.qwen/settings.json', subagents: '.qwen/agents/', commands: '.qwen/commands/' }),
});

// The workspace-relative folder a harness reads skills from, or null when it
// has none (#603: `soul skill load` places one skill there).
export function harnessSkillsDirectory(harness) {
  return Object.hasOwn(HARNESS_FILES, harness) ? HARNESS_FILES[harness].skills : undefined;
}

// Settings are defaults for native harness launches; owner-selected launch
// models remain outside the package and take precedence at launch.
// `provider` (#583 slice 4) renders the non-secret parts of a per-harness
// model provider: Codex's `model_providers` table, Claude's endpoint in its
// settings `env`, OpenCode's `provider` block. The secret is launch-time only.
export const SETTINGS_TARGETS = Object.freeze([
  Object.freeze({ harness: 'claude', path: '.claude/settings.json', keys: Object.freeze(['env', 'model', 'permissionMode', 'permissions', 'provider', 'reasoningEffort']) }),
  Object.freeze({ harness: 'codex', path: '.codex/config.toml', keys: Object.freeze(['env', 'model', 'permissionMode', 'provider', 'reasoningEffort']) }),
  Object.freeze({ harness: 'gemini', path: '.gemini/settings.json', keys: Object.freeze(['model']) }),
  Object.freeze({ harness: 'opencode', path: 'opencode.json', keys: Object.freeze(['model', 'permissionMode', 'permissions', 'provider']) }),
]);

const plainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

// An override replaces the fields it declares, except that `env` merges per
// variable over the shared `env`, and `permissions` keeps a shared list the
// override does not declare (a declared list replaces the shared one whole).
// `provider` is per harness only: a shared one is never applied.
export function harnessSettings(manifest, name) {
  const shared = plainObject(manifest.harness) ? manifest.harness : {};
  const override = plainObject(manifest.harnesses?.[name]) ? manifest.harnesses[name] : {};
  const settings = { ...shared, ...override };
  for (const key of ['env', 'permissions']) {
    if (plainObject(shared[key]) && plainObject(override[key])) settings[key] = { ...shared[key], ...override[key] };
  }
  if (override.provider === undefined) delete settings.provider;
  return settings;
}

// The declared provider, normalized for this harness; a harness with no
// provider rendering gets null, so the key is reported unsupported there.
function declaredProvider(harness, settings) {
  if (settings.provider === undefined || !Object.hasOwn(PROVIDERS, harness)) return null;
  return normalizeProvider(harness, settings.provider);
}

// Environment variables (#379, slice 2). A soul is shared, copied and forked,
// so it never carries a credential: secret-looking names and values are
// refused. Credentials are referenced by name (soul.json `credentials`) and
// resolved at launch, never written into a package or a generated file.
export const ENV_NAME = /^[A-Z_][A-Z0-9_]*$/;
// Whole words between underscores, so TOKENIZER or SECRETARY_MODE pass.
const SECRET_NAME = /(?:^|_)(?:TOKEN|SECRET|PASSWORD|PASSWD|PRIVATE_KEY|API_KEY|APIKEY|CREDENTIALS?|AUTH)(?:_|$)/i;
const SECRET_PREFIX = /(?:^|[^A-Za-z0-9])(?:gh[pousr]_|github_pat_|sk-|sk_live_|xox[abprs]-|glpat-|AKIA|AIza)[A-Za-z0-9_-]{8,}/;
function credentialLike(value) {
  if (value.includes('-----BEGIN') || SECRET_PREFIX.test(value) || /[0-9a-fA-F]{32,}/.test(value)) return true;
  // A long base64 run mixing digits and both cases; plain words and paths do not.
  return (value.match(/[A-Za-z0-9+/_-]{32,}={0,2}/g) ?? []).some((run) => /\d/.test(run) && /[a-z]/.test(run) && /[A-Z]/.test(run));
}

// Why `NAME: value` cannot be declared, or null. The message never repeats a
// value, so a refused credential is not echoed into logs.
export function envProblem(name, value) {
  if (!ENV_NAME.test(name)) return 'must be an environment variable name matching ^[A-Z_][A-Z0-9_]*$';
  if (SECRET_NAME.test(name)) return 'names a secret; a soul never carries credentials (reference them by name and resolve them at launch)';
  if (typeof value !== 'string') return 'must be a string';
  if (value.includes('\0')) return 'must not contain NUL';
  if (credentialLike(value)) return 'looks like a credential; a soul never carries credentials (reference them by name and resolve them at launch)';
  return null;
}

// Permission rules use Claude Code's `Tool` / `Tool(pattern)` syntax as the
// portable form.
export const PERMISSION_RULE = /^[A-Za-z][A-Za-z0-9_-]*(?:\([^\x00-\x1f\x7f]+\))?$/;

function declaredEnv(settings) {
  const env = plainObject(settings.env) ? settings.env : {};
  for (const [name, value] of Object.entries(env)) {
    const problem = envProblem(name, value);
    if (problem) throw new Error(`harness env ${name} ${problem}`);
  }
  return env;
}

// Declared rules in order, allow before deny: `{ effect, rule }`.
function permissionRules(settings) {
  const permissions = plainObject(settings.permissions) ? settings.permissions : {};
  return ['allow', 'deny'].flatMap((effect) => (Array.isArray(permissions[effect]) ? permissions[effect] : [])
    .map((rule) => ({ effect, rule })));
}

// OpenCode spells only shell and edit rules natively: `Bash` / `Bash(pattern)`
// in permission.bash, bare Edit/Write/MultiEdit in permission.edit. Claude's
// legacy `prefix:*` becomes both `prefix` and `prefix *`, OpenCode globs.
function opencodeRule(rule) {
  if (rule === 'Bash') return { tool: 'bash', patterns: ['*'] };
  const bash = rule.match(/^Bash\((.+)\)$/s);
  if (bash) return { tool: 'bash', patterns: bash[1].endsWith(':*') ? [bash[1].slice(0, -2), `${bash[1].slice(0, -2)} *`] : [bash[1]] };
  if (['Edit', 'Write', 'MultiEdit'].includes(rule)) return { tool: 'edit' };
  return null;
}

// The declared keys this target actually renders: OpenCode renders
// `permissions` only when at least one rule maps; the rest are reported.
function renderedKeys(target, settings) {
  return target.keys.filter((key) => Object.hasOwn(settings, key)
    && (key !== 'permissions' || target.harness !== 'opencode' || permissionRules(settings).some(({ rule }) => opencodeRule(rule)))
    && (key !== 'provider' || providerRenders(target.harness, declaredProvider(target.harness, settings))));
}

export function settingsTargets(manifest) {
  return SETTINGS_TARGETS.filter((target) => renderedKeys(target, harnessSettings(manifest, target.harness)).length);
}

function settingsObject(path, bytes) {
  if (!bytes) return {};
  let value;
  try { value = JSON.parse(authoredText(path, bytes)); }
  catch (error) { throw new Error(`${path}: cannot merge settings (${error.message})`); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${path} must be a JSON object to merge settings`);
  return value;
}

function nestedSettings(value, key, path) {
  if (value[key] === undefined) return {};
  if (!value[key] || typeof value[key] !== 'object' || Array.isArray(value[key])) {
    throw new Error(`${path} ${key} must be a JSON object to merge settings`);
  }
  return value[key];
}

// Separate TOML statements without treating apparent keys/headers inside
// multiline strings, arrays or inline tables as configuration. This is a
// lexical merge, not a general TOML parser; unrelated bytes stay in order.
export function tomlStatements(content) {
  const statements = [];
  let start = 0, quote = '', depth = 0, comment = false;
  for (let i = 0; i < content.length; i++) {
    const char = content[i];
    if (comment) { if (char !== '\n') continue; comment = false; }
    else if (quote) {
      if (quote[0] === '"' && char === '\\') { i++; continue; }
      if (content.startsWith(quote, i)) { i += quote.length - 1; quote = ''; }
      continue;
    } else if (char === '#') { comment = true; continue; }
    else if (char === '"' || char === "'") {
      quote = content.startsWith(char.repeat(3), i) ? char.repeat(3) : char;
      i += quote.length - 1;
      continue;
    } else if (char === '[' || char === '{') depth++;
    else if (char === ']' || char === '}') depth--;
    if (char === '\n' && depth === 0) { statements.push(content.slice(start, i + 1)); start = i + 1; }
  }
  if (quote || depth !== 0) throw new Error('.codex/config.toml has an unterminated TOML value');
  if (start < content.length) statements.push(content.slice(start));
  return statements;
}

function renderCodexSettings(path, bytes, settings) {
  const values = {};
  if (settings.model !== undefined) values.model = settings.model;
  if (settings.reasoningEffort !== undefined) values.model_reasoning_effort = settings.reasoningEffort;
  if (settings.permissionMode !== undefined) {
    values.approval_policy = settings.permissionMode === 'safe' ? 'on-request' : 'never';
    values.sandbox_mode = settings.permissionMode === 'safe' ? 'workspace-write' : 'danger-full-access';
  }
  // Env goes to `[shell_environment_policy.set]`, the map Codex 0.160 applies
  // to the commands it runs. That table is rebuilt at the end of the file:
  // undeclared authored variables are kept verbatim, declared ones replaced.
  const env = settings.env === undefined ? null : declaredEnv(settings);
  // The provider (#583 slice 4): `model_provider` at the root and its own
  // `[model_providers.<id>]` table, rebuilt whole; the secret is never here.
  const provider = declaredProvider('codex', settings);
  const codex = provider ? codexProviderConfig(provider) : null;
  if (codex) values.model_provider = codex.model_provider;
  const PROVIDERS_TABLE = 'model_providers', PROVIDER = codex ? `${PROVIDERS_TABLE}.${provider.id}` : null;
  const POLICY = 'shell_environment_policy', SET = `${POLICY}.set`;
  const setKept = [];
  let table = null;
  const keyOf = (statement) => {
    const key = statement.match(/^\s*(?:([\w-]+)|"([^"]*)"|'([^']*)')\s*[.=]/);
    return key && (key[1] ?? key[2] ?? key[3]);
  };
  const kept = tomlStatements(authoredText(path, bytes ?? Buffer.alloc(0))).filter((statement) => {
    if (statement.trim() === `# ${MARKER}`) return false;
    const header = statement.trim().match(/^\[\[?\s*([^\]]+?)\s*\]\]?[ \t]*(#.*)?$/);
    if (/^\s*\[/.test(statement)) table = header ? header[1].replace(/\s*\.\s*/g, '.').replace(/"([\w-]+)"/g, '$1') : '';
    const key = keyOf(statement);
    if (env) {
      const conflict = (table === null && key === POLICY) || (table === POLICY && key === 'set') || table?.startsWith(`${SET}.`);
      if (conflict) throw new Error(`${path}: ${POLICY}.set must be a [${SET}] table to merge the soul's env`);
      if (table === SET) {
        if (!header && statement.trim() && !(key && Object.hasOwn(env, key))) setKept.push(statement.replace(/\n?$/, '\n'));
        return false;
      }
    }
    if (PROVIDER) {
      const conflict = (table === null && key === PROVIDERS_TABLE) || (table === PROVIDERS_TABLE && key === provider.id);
      if (conflict) throw new Error(`${path}: ${PROVIDER} must be a [${PROVIDER}] table to merge the soul's provider`);
      if (table === PROVIDER || table?.startsWith(`${PROVIDER}.`)) return false;
    }
    return table !== null || !key || !Object.hasOwn(values, key);
  }).join('').replace(/^\n+|\n+$/g, '');
  const lines = Object.entries(values).map(([key, value]) => `${key} = ${quotedString(value)}`);
  const providerTable = codex
    ? `\n[${PROVIDER}]\n${Object.entries(codex.table).map(([key, value]) => `${key} = ${quotedString(value)}\n`).join('')}` : '';
  const envTable = env && (Object.keys(env).length || setKept.length)
    ? `\n[${SET}]\n${Object.keys(env).sort(compare).map((name) => `${name} = ${quotedString(env[name])}\n`).join('')}${setKept.join('')}` : '';
  const head = `# ${MARKER}\n${lines.length ? `${lines.join('\n')}\n` : ''}`;
  let out = `${head}${kept ? `${lines.length ? '\n' : ''}${kept}\n` : ''}`;
  let filled = lines.length > 0 || Boolean(kept);
  for (const section of [providerTable, envTable]) {
    if (!section) continue;
    out += filled ? section : section.slice(1);
    filled = true;
  }
  return Buffer.from(out);
}

function renderSettings(target, bytes, settings) {
  if (target.harness === 'codex') return renderCodexSettings(target.path, bytes, settings);
  const { _comment, ...value } = settingsObject(target.path, bytes);
  const keys = renderedKeys(target, settings);
  if (keys.includes('model')) value.model = settings.model;
  if (target.harness === 'claude') {
    if (keys.includes('reasoningEffort')) value.effortLevel = settings.reasoningEffort;
    // Declared variables replace their own names; other authored ones stay.
    if (keys.includes('env')) value.env = { ...nestedSettings(value, 'env', target.path), ...declaredEnv(settings) };
    // The provider's endpoint rides in the same `env`; its key never does.
    if (keys.includes('provider')) value.env = { ...nestedSettings(value, 'env', target.path), ...claudeProviderEnv(declaredProvider('claude', settings)) };
    if (keys.includes('permissionMode') || keys.includes('permissions')) {
      const permissions = { ...nestedSettings(value, 'permissions', target.path) };
      if (keys.includes('permissionMode')) permissions.defaultMode = settings.permissionMode === 'safe' ? 'default' : 'bypassPermissions';
      // A declared list replaces the native list; Claude itself lets deny win.
      for (const effect of ['allow', 'deny']) {
        if (keys.includes('permissions') && Array.isArray(settings.permissions[effect])) permissions[effect] = [...settings.permissions[effect]];
      }
      value.permissions = permissions;
    }
  }
  if (target.harness === 'opencode' && (keys.includes('permissionMode') || keys.includes('permissions'))) {
    const permission = { ...nestedSettings(value, 'permission', target.path) };
    const mode = keys.includes('permissionMode') ? (settings.permissionMode === 'safe' ? 'ask' : 'allow') : undefined;
    if (mode) { permission.edit = mode; permission.bash = mode; }
    const rules = keys.includes('permissions') ? permissionRules(settings).map((entry) => ({ ...entry, native: opencodeRule(entry.rule) })).filter(({ native }) => native) : [];
    const edits = rules.filter(({ native }) => native.tool === 'edit');
    if (edits.length) permission.edit = edits.some(({ effect }) => effect === 'deny') ? 'deny' : 'allow';
    const shells = rules.filter(({ native }) => native.tool === 'bash');
    if (shells.length) {
      // OpenCode applies the LAST matching pattern: the mode's `*` goes first
      // and every deny is (re)inserted last, so deny wins as it does in Claude.
      const bash = mode ? { '*': mode } : {};
      for (const { effect, native } of shells) {
        for (const pattern of native.patterns) {
          if (effect === 'deny') delete bash[pattern];
          bash[pattern] = effect;
        }
      }
      const patterns = Object.keys(bash);
      permission.bash = patterns.length === 1 && patterns[0] === '*' ? bash['*'] : bash;
    }
    value.permission = permission;
  }
  if (target.harness === 'opencode' && keys.includes('provider')) {
    value.provider = { ...nestedSettings(value, 'provider', target.path), ...opencodeProviderConfig(declaredProvider('opencode', settings)) };
  }
  return Buffer.from(`${JSON.stringify({ _comment: MARKER, ...value }, null, 2)}\n`);
}

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

// soul.json `skills.disabled` switches skills off without deleting them
// (GeniusBar#64): their `skills/<name>/` stays in the package and no harness
// gets a rendered copy. Read like the comms flag, straight from the bytes.
export function soulSkillsDisabled(source) {
  const bytes = source.get('soul.json');
  if (!bytes) return new Set();
  let manifest;
  try { manifest = JSON.parse(text(bytes)); } catch { return new Set(); } // the package reader validates it
  const disabled = manifest?.skills?.disabled;
  return new Set(Array.isArray(disabled) ? disabled.filter((name) => typeof name === 'string') : []);
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
  const servers = { ...(rest[target.key] ?? {}) };
  const own = mcpServer(target.style);
  const same = (entry) => entry && Object.keys(entry).length === Object.keys(own).length
    && Object.keys(own).every(key => JSON.stringify(entry[key]) === JSON.stringify(own[key]));
  if (Object.hasOwn(servers, MCP_SERVER_NAME) && !same(servers[MCP_SERVER_NAME])) {
    throw new Error(`${target.path} already declares a custom ${MCP_SERVER_NAME} MCP server; rename it before building`);
  }
  // Only our marked, unchanged former output is a migration candidate.
  // A server with extra fields (env, permissions, etc.) belongs to its author.
  if (_authored === MARKER && same(servers[LEGACY_MCP_SERVER_NAME])) delete servers[LEGACY_MCP_SERVER_NAME];
  return Buffer.from(`${JSON.stringify({
    _comment: MARKER,
    ...rest,
    [target.key]: { ...servers, [MCP_SERVER_NAME]: own },
  }, null, 2)}\n`);
}

// TOML has no parser here (zero dependencies), so only our exact generated
// section can be replaced/migrated. Custom sections stay byte-for-byte; a
// conflicting canonical server is refused before any file is written.
function tomlMerge(target, authored) {
  const content = authoredText(target.path, authored);
  const headerOf = (line) => {
    const match = line.trim().match(/^(?:\[([^\]]+)\]|\[\[([^\]]+)\]\])[ \t]*(#.*)?$/);
    return match ? { name: (match[1] ?? match[2]).replace(/"([A-Za-z0-9_-]+)"|'([A-Za-z0-9_-]+)'/g, '$1$2'), array: match[2] !== undefined } : null;
  };
  const sections = [{ name: null, lines: [] }];
  for (const line of tomlStatements(content)) {
    const header = headerOf(line);
    if (header) sections.push({ ...header, lines: [line] });
    else sections.at(-1).lines.push(line);
  }
  const isDefault = (section) => {
    const lines = section.lines.slice(1).map(line => line.trim()).filter(Boolean);
    return !section.array && lines.length === 2 && lines[0] === `command = "${MCP_COMMAND}"`
      && lines[1] === `args = ["${MCP_SUBCOMMAND}"]`;
  };
  const canonical = sections.filter(section => section.name === target.table || section.name?.startsWith(`${target.table}.`));
  if (canonical.length && (canonical.length !== 1 || !isDefault(canonical[0]))) {
    throw new Error(`${target.path} already declares a custom ${MCP_SERVER_NAME} MCP server; rename it before building`);
  }
  const legacyTable = `mcp_servers.${LEGACY_MCP_SERVER_NAME}`;
  const legacy = sections.filter(section => section.name === legacyTable || section.name?.startsWith(`${legacyTable}.`));
  const migrateLegacy = content.split('\n').some(line => line.trim() === `# ${MARKER}`)
    && legacy.length === 1 && isDefault(legacy[0]);
  const kept = [];
  for (const section of sections) {
    if (section.name === target.table || (migrateLegacy && section === legacy[0])) continue;
    for (const line of section.lines) {
      if (line.trim() === MARKER || line.trim() === `# ${MARKER}`) continue;
      kept.push(line);
    }
  }
  const body = kept.join('').replace(/^\n+|\n+$/g, '');
  const table = [`[${target.table}]`, `command = "${MCP_COMMAND}"`, `args = ["${MCP_SUBCOMMAND}"]`].join('\n');
  return `# ${MARKER}\n${body ? `${body}\n\n` : ''}${table}\n`;
}

// Soul-declared hooks (#378, slice 3). A soul declares a hook once, as an
// executable at `hooks/<event>/<name>` — the folder contract agent-hooks/
// already uses, with the same canonical events and the same verdict protocol.
// The builder renders one native entry per declared event into each harness
// whose hook dialect can express it; the entry runs the vendor-neutral
// agent-hook runner over the soul's own `hooks/` directory, so every harness
// hands the script the same normalized envelope and reads the same verdict.
//
// Ownership: these entries carry SOUL_HOOK_MARKER and are the builder's alone.
// The identity lifecycle entries (MANAGED_MARKER) stay with sync-hooks.mjs in
// the harness's user directory; neither recognizer matches the other's
// entries, and any other entry in a shared file is the soul's and kept.
//
// `spawn` is the daemon's own event and `pre-commit`/`pre-push` are served by
// the git layer, not a harness, so a soul hook on one of them could never fire:
// refused rather than accepted and silently dropped.
export const SOUL_HOOK_EVENTS = Object.freeze(CANONICAL_EVENTS.filter((event) => !['spawn', 'pre-commit', 'pre-push'].includes(event)));

// Each harness's native project hook file and the hook-dialects row that
// spells it. Devin CLI reads Claude's settings natively (the claude row's
// `alsoServes`), so it is served by the same entry and gets no file of its own.
// Copilot reads every `.github/hooks/*.json`; the builder owns one dedicated
// file there and never touches the others.
export const HOOK_TARGETS = Object.freeze([
  Object.freeze({ harness: 'claude', dialect: 'claude', path: '.claude/settings.json' }),
  Object.freeze({ harness: 'codex', dialect: 'codex', path: '.codex/hooks.json' }),
  Object.freeze({ harness: 'cursor', dialect: 'cursor', path: '.cursor/hooks.json' }),
  Object.freeze({ harness: 'copilot', dialect: 'copilot', path: '.github/hooks/agent-bot-soul.json' }),
]);
const HOOK_DIALECT_FOR = Object.freeze({ claude: 'claude', devin: 'claude', codex: 'codex', cursor: 'cursor', copilot: 'copilot' });
const hookTargetFor = (harness) => HOOK_TARGETS.find((target) => target.dialect === HOOK_DIALECT_FOR[harness]);

// The same name grammar as other primitives, plus an optional extension so a
// script may keep `.sh` or `.py`; a numeric prefix orders the runner (`10-`).
const HOOK_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*(?:\.[a-z0-9]+)?$/;

// The declared hooks, `<event>/<name>`, byte-sorted. Throws on anything under
// hooks/ that would not run: an unknown or non-harness event, a nested path, a
// bad name, or a file without its executable bit (the runner skips those, so
// accepting one would be a hook that silently never fires). `hooks/README.md`
// may document the folder.
export function declaredHooks(packageEntries) {
  const hooks = [];
  for (const { path, mode } of packageEntries) {
    if (path === 'hooks') {
      if (mode !== '040000') throw new Error('hooks must be a directory');
      continue;
    }
    if (!path.startsWith('hooks/') || path === 'hooks/README.md') continue;
    const [, event, name, ...rest] = path.split('/');
    if (!SOUL_HOOK_EVENTS.includes(event)) {
      throw new Error(CANONICAL_EVENTS.includes(event)
        ? `hooks/${event}: ${event} is not a harness hook event (${event === 'spawn' ? 'the daemon runs spawn hooks' : 'the git hook layer serves it'})`
        : `hooks/${event}: unknown hook event (use one of ${SOUL_HOOK_EVENTS.join(', ')})`);
    }
    if (name === undefined) {
      if (mode !== '040000') throw new Error(`hooks/${event} must be a directory of executables`);
      continue;
    }
    if (rest.length || mode === '040000') throw new Error(`${path}: hooks are files directly in hooks/<event>/, not nested directories`);
    if (name.length > 64 || !HOOK_NAME.test(name)) {
      throw new Error(`${path}: name must use lowercase letters, digits and single hyphens, with an optional extension (1–64 characters)`);
    }
    if (mode !== '100755') throw new Error(`${path} must be executable (chmod +x); the hook runner skips other files`);
    hooks.push(`${event}/${name}`);
  }
  return hooks.sort(compare);
}

// The command each rendered entry runs. Nothing machine-specific: `agent-bot`
// from PATH (as the MCP entry), and the soul's `hooks/` found from the project
// root — Claude's CLAUDE_PROJECT_DIR, which only the claude row may trust (a
// Codex launched from a Claude shell inherits it), else the git top level the
// home is. A missing agent-bot fails closed on a blocking event, never open.
// The executable goes through `$B` and `--event` comes first so the command
// never contains `agent-bot agent-hook` (MANAGED_MARKER) or
// `agent-hook --dialect`: any sync-hooks, including an older install's, reads
// those as its own lifecycle entries and would strip this one.
export function soulHookCommand(dialectKey, event) {
  const root = dialectKey === 'claude'
    ? '${CLAUDE_PROJECT_DIR:-$(git rev-parse --show-toplevel 2>/dev/null || pwd)}'
    : '$(git rev-parse --show-toplevel 2>/dev/null || pwd)';
  return `D="${root}"; B=agent-bot; command -v "$B" >/dev/null 2>&1 || { echo "agent-bot is not on PATH; soul ${event} hooks did not run" >&2; exit ${isBlocking(event) ? 2 : 0}; }; AGENT_BOT_HOOKS_DIR="$D/hooks" exec "$B" agent-hook --event ${event} --dialect ${dialectKey} # ${SOUL_HOOK_MARKER}`;
}

const isSoulHookEntry = (entry) => JSON.stringify(entry).includes(SOUL_HOOK_MARKER);

function hookConfig(path, bytes) {
  let content, value;
  try { content = text(bytes); } catch { throw new Error(`${path} must be UTF-8 text to merge soul hooks into it`); }
  try { value = JSON.parse(content); }
  catch (error) { throw new Error(`${path} is not valid JSON, so soul hooks cannot be merged into it (${error.message})`); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${path} must be a JSON object to merge soul hooks into it`);
  if (value.hooks !== undefined && (!value.hooks || typeof value.hooks !== 'object' || Array.isArray(value.hooks))) {
    throw new Error(`${path} hooks must be a JSON object to merge soul hooks into it`);
  }
  for (const [event, entries] of Object.entries(value.hooks ?? {})) {
    if (!Array.isArray(entries)) throw new Error(`${path} hooks.${event} must be an array to merge soul hooks into it`);
  }
  return value;
}

// Merge the declared events into one target's file. Only entries carrying
// SOUL_HOOK_MARKER are replaced; every other entry (the soul's own, or a
// lifecycle entry) keeps its place, and event keys keep their order so a
// rebuild over this output is byte-identical. With nothing declared, a file
// that still holds our entries is cleaned; one that held only ours is dropped.
function renderHookTarget(target, base, events, { fromOutput }) {
  const { _comment, ...rest } = base ? hookConfig(target.path, base) : {};
  const hooks = {};
  let stripped = false;
  const emptied = new Set();
  for (const [event, entries] of Object.entries(rest.hooks ?? {})) {
    hooks[event] = entries.filter((entry) => !isSoulHookEntry(entry));
    if (hooks[event].length < entries.length) {
      stripped = true;
      if (!hooks[event].length) emptied.add(event);
    }
  }
  if (!events.length && !stripped) return null;
  for (const event of SOUL_HOOK_EVENTS.filter((candidate) => events.includes(candidate))) {
    const native = nativeHookEntry(target.dialect, event, soulHookCommand(target.dialect, event));
    if (!native) continue;
    (hooks[native.vendorEvent] ??= []).push(native.entry);
  }
  for (const event of emptied) if (!hooks[event].length) delete hooks[event];
  const versioned = ['cursor', 'copilot'].includes(target.dialect);
  const value = { _comment: MARKER, ...(versioned && events.length && rest.version === undefined ? { version: 1 } : {}), ...rest, hooks };
  if (!Object.keys(hooks).length && (rest.hooks === undefined || stripped)) delete value.hooks;
  // A file that only ever held our entries goes away with them.
  const left = Object.keys(value).filter((key) => key !== '_comment' && !(versioned && key === 'version'));
  if (!events.length && !fromOutput && !left.length) return null;
  return Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
}

function renderHooks(events, output, authored) {
  for (const target of HOOK_TARGETS) {
    const fromOutput = output.has(target.path);
    const base = output.get(target.path) ?? authored.get(target.path);
    if (!base && !events.length) continue;
    const rendered = renderHookTarget(target, base, events, { fromOutput });
    if (rendered) output.set(target.path, rendered);
  }
}

// Claude renders every declared agent/command, so its output inventories the
// received names even for harnesses without adapters. No hidden Map metadata
// or source/disk access is needed by the report.
// `hooks` is declaredHooks(entries): rendered hooks share one runner entry per
// event, so the names come from the package, not the output.
export function harnessReport(output, { comms = true, manifest = {}, hooks = [] } = {}) {
  const skills = [...output.keys()].some((path) => Object.values(HARNESS_FILES).some((files) => files.skills && path.startsWith(files.skills)));
  const names = (prefix) => prefix ? [...output.keys()].filter((path) => path.startsWith(prefix))
    .map((path) => path.slice(prefix.length).replace(/(?:\.agent)?\.(md|toml)$/, '')).sort(compare) : [];
  const received = { subagents: names(HARNESS_FILES.claude.subagents), commands: names(HARNESS_FILES.claude.commands) };
  const report = {};
  for (const [harness, files] of Object.entries(HARNESS_FILES)) {
    const settingsTarget = SETTINGS_TARGETS.find((target) => target.harness === harness);
    const hookTarget = hookTargetFor(harness);
    const deliveredHooks = hookTarget && output.has(hookTarget.path)
      ? hooks.filter((name) => vendorEvent(hookTarget.dialect, name.slice(0, name.indexOf('/')))) : [];
    const paths = [...output.keys()].filter((path) => path === files.instructions
      || (files.skills && path.startsWith(files.skills)) || path === files.mcp || path === settingsTarget?.path
      || (files.subagents && path.startsWith(files.subagents)) || (files.commands && path.startsWith(files.commands))
      || (deliveredHooks.length > 0 && path === hookTarget.path));
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
      // A harness whose adapter cannot spell a declaration (a tool it has no
      // name for) lists it here too, not only a harness with no adapter.
      unsupported[kind] = received[kind].filter((name) => !delivered.includes(name));
      if (delivered.length) rendered.push(kind);
    }
    const settings = harnessSettings(manifest, harness);
    const settingKeys = Object.keys(settings).sort(compare);
    const deliveredSettings = settingsTarget && output.has(settingsTarget.path)
      ? renderedKeys(settingsTarget, settings).sort(compare) : [];
    // A provider whose non-secret parts are all defaults (Claude's built-in
    // endpoint) is launch-time only, not unsupported, where it is rendered.
    unsupported.settings = settingKeys.filter((key) => !deliveredSettings.includes(key) && !(key === 'provider' && Object.hasOwn(PROVIDERS, harness)));
    if (deliveredSettings.length) rendered.push('settings');
    // Per rule, so a partly expressible rule set never loses one in silence.
    const rulesRendered = deliveredSettings.includes('permissions');
    unsupported.permissions = permissionRules(settings)
      .filter(({ rule }) => !rulesRendered || (harness === 'opencode' && !opencodeRule(rule)));
    unsupported.hooks = hooks.filter((name) => !deliveredHooks.includes(name));
    if (deliveredHooks.length) rendered.push('hooks');
    report[harness] = { rendered, files: paths, ...primitives,
      settings: { received: settingKeys, rendered: deliveredSettings },
      hooks: { received: [...hooks], rendered: deliveredHooks }, unsupported };
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

// The declared Claude tool names, validated and deduplicated in declared order;
// undefined when the declaration has no `tools` field (inherit every tool).
function agentToolNames(fields, path) {
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
  return [...new Set(values)];
}

// Claude's tools field is an allowlist; disable unlisted OpenCode tools too.
// MultiEdit uses OpenCode's edit tool; other native names use lowercase.
const opencodeTools = (names) => [...new Set(names.map((name) => name === 'MultiEdit' ? 'edit' : name.toLowerCase()))].sort(compare);

// Native tool names for Claude's, where the harness documents one. Kiro's
// built-ins are category tags (`read` is reading, listing and searching);
// Devin's are its tool names (`read`, `edit`, `grep`, `glob`, `exec`; its
// `edit` covers file writes, and it has no `write`). A declared tool missing
// here cannot be spelled for that harness, so its subagent is unsupported
// there rather than widened or cut.
const KIRO_TOOLS = Object.freeze({ Read: 'read', NotebookRead: 'read', Grep: 'read', Glob: 'read', LS: 'read',
  Edit: 'write', MultiEdit: 'write', Write: 'write', NotebookEdit: 'write', Bash: 'shell',
  WebFetch: 'web', WebSearch: 'web', Task: 'subagent', TodoWrite: 'todo_list' });
const DEVIN_TOOLS = Object.freeze({ Read: 'read', Edit: 'edit', MultiEdit: 'edit', Write: 'edit', Grep: 'grep', Glob: 'glob', Bash: 'exec' });
// Qwen Code 0.25.0's canonical tool names, from its own converter for Claude
// agents (which drops BashOutput and KillShell; here they make the agent
// unsupported instead). MultiEdit uses its `edit`, as for Devin and Kiro.
const QWEN_TOOLS = Object.freeze({ Read: 'read_file', Write: 'write_file', Edit: 'edit', MultiEdit: 'edit',
  Grep: 'grep_search', Glob: 'glob', LS: 'list_directory', Bash: 'run_shell_command', WebFetch: 'web_fetch',
  WebSearch: 'web_search', TodoWrite: 'todo_write', Task: 'agent', NotebookEdit: 'notebook_edit', Skill: 'skill',
  AskUserQuestion: 'ask_user_question', ExitPlanMode: 'exit_plan_mode' });
// Qwen keeps an MCP tool's `mcp__<server>__<tool>` name only up to 63
// characters (longer ones get a hashed suffix), and refuses agent names
// shorter than 2 or longer than 50 characters, or reserved ones.
const QWEN_MCP_TOOL_MAX = 63;
const QWEN_RESERVED_AGENTS = Object.freeze(['self', 'system', 'user', 'model', 'tool', 'config', 'default', 'main']);
// Claude declarations name an MCP tool `mcp__<server>__<tool>`. Its server
// segment ends at the first `__` (`mcp__foo__bar__baz`: server `foo`, tool
// `bar__baz`). Kiro uses `@server/tool`; Devin keeps Claude's exact name.
// The declaration grammar admits no `*`, so no server-wide grant is invented.
const MCP_TOOL = /^mcp__([A-Za-z0-9-]+(?:_[A-Za-z0-9-]+)*)__([A-Za-z0-9_-]+)$/;
// Cursor has no per-tool allowlist, only `readonly`; it is set when every
// declared tool is one of these, so a read-only agent stays read-only.
const READ_ONLY_TOOLS = Object.freeze(['Glob', 'Grep', 'LS', 'NotebookRead', 'Read', 'TodoWrite', 'WebFetch', 'WebSearch']);

function nativeTools(map, names, { mcp = false } = {}) {
  const spelled = (name) => Object.hasOwn(map, name) ? map[name] : mcp && MCP_TOOL.test(name) ? name : null;
  if (names.some((name) => spelled(name) === null)) return null;
  return [...new Set(names.map(spelled))].sort(compare);
}
function qwenNativeTools(names) {
  const spelled = (name) => Object.hasOwn(QWEN_TOOLS, name) ? QWEN_TOOLS[name]
    : MCP_TOOL.test(name) && name.length <= QWEN_MCP_TOOL_MAX ? name : null;
  if (names.some((name) => spelled(name) === null)) return null;
  return [...new Set(names.map(spelled))].sort(compare);
}
function kiroNativeTools(names) {
  const spelled = (name) => {
    if (Object.hasOwn(KIRO_TOOLS, name)) return KIRO_TOOLS[name];
    const match = MCP_TOOL.exec(name);
    return match ? `@${match[1]}/${match[2]}` : null;
  };
  if (names.some((name) => spelled(name) === null)) return null;
  return [...new Set(names.map(spelled))].sort(compare);
}
const yamlList = (values) => `[${values.map(quotedString).join(', ')}]`;

// One subagent declaration in each adapter's own front matter. Returns the
// `[path, header]` pairs it can spell; a harness missing from the result is
// reported under `unsupported.subagents`.
function translatedAgents(name, { description, model, tools }) {
  const common = [`name: ${quotedString(name)}`, `description: ${quotedString(description)}`,
    ...(model === undefined ? [] : [`model: ${quotedString(model)}`])];
  const agents = [];
  // Cursor: `.cursor/agents/` wins over its Claude-compatible `.claude/agents/`.
  agents.push([`.cursor/agents/${name}.md`, [...common,
    ...(tools && tools.every((tool) => READ_ONLY_TOOLS.includes(tool)) ? ['readonly: true'] : [])]]);
  // Copilot CLI accepts Claude's tool names as case-insensitive aliases and
  // ignores names it does not recognize, which narrows rather than widens.
  agents.push([`.github/agents/${name}.agent.md`, [...common, ...(tools ? [`tools: ${yamlList(tools)}`] : [])]]);
  // Kiro (CLI 3.0 / IDE 1.0 Markdown agents): its default for an absent
  // `tools` is not documented, so inheriting every tool is spelled `*`.
  // includeMcpJson loads existing workspace/global MCP declarations; the
  // exact `tools` selectors remain the allowlist, with no permission changes.
  const kiro = tools ? kiroNativeTools(tools) : ['*'];
  if (kiro) agents.push([`.kiro/agents/${name}.md`, [...common,
    `tools: ${yamlList(kiro)}`,
    ...(tools?.some((tool) => MCP_TOOL.test(tool)) ? ['includeMcpJson: true'] : [])]]);
  // Devin: an absent `allowed-tools` is every tool, as in Claude.
  const devin = tools ? nativeTools(DEVIN_TOOLS, tools, { mcp: true }) : [];
  if (devin) agents.push([`.devin/agents/${name}.md`, [...common, ...(tools ? [`allowed-tools: ${yamlList(devin)}`] : [])]]);
  // Qwen Code: an absent `tools` inherits every tool, as in Claude.
  const qwen = tools ? qwenNativeTools(tools) : [];
  if (qwen && name.length >= 2 && name.length <= 50 && !QWEN_RESERVED_AGENTS.includes(name)) {
    agents.push([`.qwen/agents/${name}.md`, [...common, ...(tools ? [`tools: ${yamlList(qwen)}`] : [])]]);
  }
  return agents;
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
      const tools = agentToolNames(parsed.fields, path);
      if (tools) header.push('tools:', '  "*": false', ...opencodeTools(tools).map((tool) => `  ${quotedString(tool)}: true`));
      output.set(`.opencode/agent/${name}.md`, Buffer.from(mappedDeclaration(header, parsed.body)));
      for (const [target, native] of translatedAgents(name, { description, model, tools })) {
        output.set(target, Buffer.from(mappedDeclaration(native, parsed.body)));
      }
    } else {
      output.set(`.opencode/command/${name}.md`, Buffer.from(header.length ? mappedDeclaration(header, parsed.body) : `${MARKER}\n${parsed.body}`));
      const toml = [`# ${MARKER}`, ...(description === undefined ? [] : [`description = ${quotedString(description)}`]),
        `prompt = ${quotedString(parsed.body.replaceAll('$ARGUMENTS', '{{args}}'))}`];
      output.set(`.gemini/commands/${name}.toml`, Buffer.from(`${toml.join('\n')}\n`));
      // Qwen Code: Markdown with optional `description` front matter; like
      // Gemini it injects arguments at `{{args}}`, not `$ARGUMENTS`.
      const qwenBody = parsed.body.replaceAll('$ARGUMENTS', '{{args}}');
      output.set(`.qwen/commands/${name}.md`, Buffer.from(header.length ? mappedDeclaration(header, qwenBody) : `${MARKER}\n${qwenBody}`));
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
  const hookEvents = [...new Set(declaredHooks(packageEntries.filter((entry) => !isGeneratedPath(entry.path)))
    .map((name) => name.slice(0, name.indexOf('/'))))];
  output.set('CLAUDE.md', Buffer.from(`${MARKER}\n@AGENTS.md\n`));
  output.set('GEMINI.md', Buffer.from(`${MARKER}\n@AGENTS.md\n`));
  const disabled = soulSkillsDisabled(source);
  for (const [path, bytes] of source) {
    const skill = /^skills\/([^/]+)\/SKILL\.md$/.exec(path);
    // A disabled skill renders nothing, siblings included; the report then
    // lists `skills` only when some other skill was rendered.
    if (!skill || disabled.has(skill[1])) continue;
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
  const manifest = source.has('soul.json') ? JSON.parse(text(source.get('soul.json'))) : {};
  for (const target of settingsTargets(manifest)) {
    output.set(target.path, renderSettings(target, output.get(target.path) ?? authored.get(target.path), harnessSettings(manifest, target.harness)));
  }
  // After settings, so Claude's settings and its hooks share one file.
  renderHooks(hookEvents, output, authored);
  return new Map([...output].sort(([a], [b]) => compare(a, b)));
}
