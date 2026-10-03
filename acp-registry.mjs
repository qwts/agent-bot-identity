// ACP spawn registry — the per-harness half of the drive plane (#144).
//
// The drive engine (acp-engine.mjs) is one harness-agnostic ACP client; every
// per-harness difference lives here as data: what to spawn, which inherited
// environment variables to strip, where the harness keeps its shared session
// store, and how operators authenticate it. Adding a harness to the drive
// plane means adding (or enabling) a row — never forking engine code.
//
// Per-harness enablement checklist (issue #144):
//   - claude   — ACP adapter `@zed-industries/claude-code-acp` over the shared
//                `~/.claude` store; auth is the operator's existing `claude`
//                login. The adapter refuses to run when it inherits the
//                CLAUDECODE nesting guard from a Claude Code parent, so the
//                row strips it: the daemon is the parent here, not a session.
//   - opencode — native `opencode acp`; shared store; `opencode auth login`.
//                Its own agent ruleset (OPENCODE_DAEMON_PERMISSION) makes
//                every privileged tool ask the daemon (#390).
//   - codex    — DECISION (this issue's checklist item): drive Codex through
//                the third-party ACP adapter lane (Zed's `codex-acp`) rather
//                than a first-party `codex mcp-server`/app-server shim. A shim
//                would embed a second protocol behind the engine and fork the
//                code path this plane exists to keep singular; the first-party
//                app-server socket remains the gated attach plane (#148). The
//                row ships disabled until the adapter spawn is verified on
//                this machine profile — the exact package pin is checked then.
//   - muse     — muse-acp (#145): the co-shipped adapter (muse-acp.mjs)
//                wraps `muse exec --json --session-id --workspace` per turn;
//                spawned via this repo's own node so the row works wherever
//                the daemon checkout lives. The row strips MUSE_AGENT for the
//                same reason claude strips CLAUDECODE: the daemon is the
//                parent, not a Muse session.
//   - cursor / copilot — deliberately no row. Their CLIs keep isolated session
//                stores, so driving them here would never surface in the
//                desktop apps this plane exists to reach (#141 census).
//                Revisit only if that changes.
import { accessSync, constants, existsSync, realpathSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const HARNESS_KEY_PATTERN = /^[a-z][a-z0-9-]{0,31}$/;

// How a row's adapter identifies an MCP tool call to the client (#384), so the
// engine can name a permission request `mcp__<server>__<tool>` for the
// servers it injected, whatever the harness. Each value is a verified wire
// shape, recorded against the adapter source pinned in the row's notes:
//   - claude-meta      — claude-code-acp: the tool_call update carries the
//                        name in `_meta.claudeCode.toolName`.
//   - codex-invocation — @zed-industries/codex-acp 0.x (deprecated): the
//                        tool_call update's rawInput is Codex's
//                        McpInvocation `{ server, tool, arguments }` and its
//                        title is `Tool: <server>/<tool>`; the approval request
//                        reuses that toolCallId and carries `server_name`.
//   - codex-mcp-title  — @agentclientprotocol/codex-acp 2.x: the tool_call is
//                        kind 'execute', titled `mcp.<server>.<tool>`, with
//                        rawInput `{ server, tool, arguments }` and
//                        `_meta.is_mcp_tool_call`; the approval request reuses
//                        that toolCallId and carries `_meta.is_mcp_tool_approval`.
//   - opencode-key     — `opencode acp`: an MCP tool's key is
//                        `<server>_<tool>`; it is the title (kind 'other') of
//                        both the tool_call and the permission request.
// A row without one gets no MCP naming: its permission requests are named by
// their ACP kind only, which the reach allow rules never match.
export const MCP_TOOL_NAMINGS = Object.freeze(['claude-meta', 'codex-invocation', 'codex-mcp-title', 'opencode-key']);

// OpenCode allows every tool by default ("*": "allow" in its built-in agent
// rules) and a machine config may say the same, so an OpenCode soul would
// rarely ask the daemon anything (#390). The row adds its own primary agent
// through OPENCODE_CONFIG_CONTENT and selects it as the session mode on every
// turn. An agent's own rules are evaluated after the user's (last match
// wins), so this ruleset decides: everything asks the daemon except
// read-only built-ins, and subagents (task) are off, since a subagent runs
// under its own agent's rules rather than these. Souls start teams through
// start_soul instead.
export const OPENCODE_DAEMON_AGENT = 'agent-bot';
const OPENCODE_DAEMON_PERMISSION = Object.freeze({
  '*': 'ask',
  read: { '*': 'allow', '*.env': 'ask', '*.env.*': 'ask', '*.env.example': 'allow' },
  glob: 'allow',
  grep: 'allow',
  list: 'allow',
  lsp: 'allow',
  todowrite: 'allow',
  todoread: 'allow',
  skill: 'allow',
  task: 'deny',
  question: 'deny',
  plan_enter: 'deny',
  plan_exit: 'deny',
});
const OPENCODE_DAEMON_CONFIG = JSON.stringify({
  default_agent: OPENCODE_DAEMON_AGENT,
  agent: {
    [OPENCODE_DAEMON_AGENT]: {
      mode: 'primary',
      description: 'Driven by the agent-bot daemon: every privileged tool asks the daemon policy.',
      permission: OPENCODE_DAEMON_PERMISSION,
    },
  },
});

const MUSE_ACP_PATH = fileURLToPath(new URL('./muse-acp.mjs', import.meta.url));

export const ACP_SPAWN_REGISTRY = Object.freeze({
  claude: Object.freeze({
    harness: 'claude',
    enabled: true,
    command: 'npx',
    args: Object.freeze(['--yes', '-p', '@zed-industries/claude-code-acp', 'claude-code-acp']),
    soulBin: 'claude-code-acp',
    // The Claude CLI the adapter installs with it; its store is ~/.claude.
    signIn: Object.freeze({ package: '@anthropic-ai/claude-agent-sdk', script: 'cli.js', command: 'claude',
      status: Object.freeze(['auth', 'status', '--json']), login: Object.freeze(['auth', 'login']) }),
    stripEnv: Object.freeze(['CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_CODE_SSE_PORT']),
    store: '~/.claude',
    mcpToolNaming: 'claude-meta',
    auth: 'existing `claude` login (shared credential store)',
    notes: 'adapter-provided ACP, spawn verified in the #141 spike; upstream is renaming toward @agentclientprotocol/claude-agent-acp — repin when the verified package moves',
  }),
  opencode: Object.freeze({
    harness: 'opencode',
    enabled: true,
    command: 'opencode',
    args: Object.freeze(['acp']),
    stripEnv: Object.freeze([]),
    // Set after stripEnv, so an inherited value never replaces the ruleset.
    setEnv: Object.freeze({ OPENCODE_CONFIG_CONTENT: OPENCODE_DAEMON_CONFIG }),
    sessionMode: OPENCODE_DAEMON_AGENT,
    store: '~/.local/share/opencode',
    mcpToolNaming: 'opencode-key',
    auth: '`opencode auth login`',
    notes: 'native ACP endpoint; proven end-to-end in the #141 spike (new turn + session/load resume); MCP naming verified against opencode v1.18.34 src/acp (#384)',
  }),
  muse: Object.freeze({
    harness: 'muse',
    enabled: true,
    command: process.execPath,
    args: Object.freeze([MUSE_ACP_PATH]),
    stripEnv: Object.freeze(['MUSE_AGENT']),
    store: '~/.local/share/muse',
    auth: 'existing `muse login` (meta provider credentials)',
    notes: 'co-shipped muse-acp adapter over `muse exec --json --session-id --workspace` (#145); spawn-per-turn, resume is workspace-bound',
  }),
  codex: Object.freeze({
    harness: 'codex',
    enabled: true,
    command: 'npx',
    args: Object.freeze(['--yes', '-p', '@agentclientprotocol/codex-acp@2.1.1', 'codex-acp']),
    soulBin: 'codex-acp',
    stripEnv: Object.freeze([]),
    store: '~/.codex',
    mcpToolNaming: 'codex-mcp-title',
    // The adapter's default mode ("agent") lets Codex's own reviewer approve
    // calls, so the daemon policy would never be asked; workspace-write routes
    // every approval, MCP tools included, to this client.
    sessionMode: 'workspace-write',
    auth: 'existing `codex` login (shared credential store)',
    notes: 'third-party ACP adapter lane, pinned to @agentclientprotocol/codex-acp 2.1.1 (the @zed-industries package is deprecated): spawn, injected agent-reach MCP and default-deny reach rules verified live (#384); first-party app-server attach stays #148',
  }),
});

function failRegistry(message) {
  throw new Error(`acp registry: ${message}`);
}

// A row must be complete before the engine will ever spawn from it; a defect
// here is a configuration bug, not a runtime condition to limp through.
export function validateSpawnRow(row) {
  if (!row || typeof row !== 'object') failRegistry('row must be an object');
  if (typeof row.harness !== 'string' || !HARNESS_KEY_PATTERN.test(row.harness)) {
    failRegistry('row requires a harness key');
  }
  if (typeof row.enabled !== 'boolean') failRegistry(`${row.harness}: enabled must be boolean`);
  if (typeof row.command !== 'string' || row.command.length === 0) {
    failRegistry(`${row.harness}: command must be a non-empty string`);
  }
  if (!Array.isArray(row.args) || row.args.some((arg) => typeof arg !== 'string')) {
    failRegistry(`${row.harness}: args must be an array of strings`);
  }
  if (!Array.isArray(row.stripEnv) || row.stripEnv.some((name) => typeof name !== 'string' || name.length === 0)) {
    failRegistry(`${row.harness}: stripEnv must be an array of variable names`);
  }
  if (row.setEnv !== undefined && (!row.setEnv || typeof row.setEnv !== 'object' || Array.isArray(row.setEnv)
    || Object.entries(row.setEnv).some(([name, value]) => !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) || typeof value !== 'string'))) {
    failRegistry(`${row.harness}: setEnv must map variable names to strings`);
  }
  if (row.soulBin !== undefined && (typeof row.soulBin !== 'string' || !/^[a-z0-9][a-z0-9._-]*$/.test(row.soulBin))) {
    failRegistry(`${row.harness}: soulBin must be an npm binary name`);
  }
  if (row.sessionMode !== undefined && (typeof row.sessionMode !== 'string' || !/^[a-z0-9][a-z0-9_-]*$/.test(row.sessionMode))) {
    failRegistry(`${row.harness}: sessionMode must be an ACP session mode id`);
  }
  if (row.mcpToolNaming !== undefined && !MCP_TOOL_NAMINGS.includes(row.mcpToolNaming)) {
    failRegistry(`${row.harness}: mcpToolNaming must be one of ${MCP_TOOL_NAMINGS.join(', ')}`);
  }
  return row;
}

/**
 * The command for a row in a working directory (ADR-0276): a soul home
 * that installed the row's npm binary runs it with this Node, so neither
 * npx nor a global install is needed; otherwise the registry command.
 */
export function spawnCommand(row, cwd, { node = process.execPath } = {}) {
  if (row.soulBin && cwd) {
    const bin = join(cwd, 'node_modules', '.bin', row.soulBin);
    if (existsSync(bin)) return { command: node, args: [realpathSync(bin)] };
  }
  return { command: row.command, args: [...row.args] };
}

/** Whether a bare command name is an executable on PATH. */
export function onPath(command, env = process.env) {
  if (!command || command.includes('/')) return false;
  return (env.PATH ?? '').split(delimiter).filter(Boolean).some((dir) => {
    try { accessSync(join(dir, command), constants.X_OK); return true; } catch { return false; }
  });
}

/**
 * A soul's harness when a launch names none (ADR-0276): its first
 * preferred harness the registry enables, else the first enabled registry
 * harness whose command is on PATH, else null.
 */
export function defaultHarnessFor(preferred = [], { registry = ACP_SPAWN_REGISTRY, available = (cmd) => onPath(cmd) } = {}) {
  const enabled = (key) => registry[key]?.enabled === true;
  return preferred.find(enabled)
    ?? Object.values(registry).find((row) => row.enabled && available(row.command))?.harness
    ?? null;
}

// Fail closed on both unknown and disabled harnesses: the caller learns why a
// row will not spawn instead of getting a half-configured child process.
export function resolveSpawn(registry, harness) {
  if (!registry || typeof registry !== 'object') failRegistry('registry must be an object');
  if (typeof harness !== 'string' || !HARNESS_KEY_PATTERN.test(harness)) {
    failRegistry('harness must be a registry key');
  }
  const row = registry[harness];
  if (!row) failRegistry(`no ACP drive entry for harness '${harness}'`);
  validateSpawnRow(row);
  if (row.harness !== harness) failRegistry(`row for '${harness}' is keyed as '${row.harness}'`);
  if (!row.enabled) {
    failRegistry(`harness '${harness}' is registered but not enabled: ${row.notes ?? 'no reason recorded'}`);
  }
  return row;
}
