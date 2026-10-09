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
//   - kiro     — native `kiro-cli acp` (#523, GeniusBar#185); `kiro-cli login`
//                (Builder ID, Google, GitHub or Identity Center). The row ships
//                disabled: on a Mac without a Kiro sign-in, `initialize` on
//                stdin got no answer within 10 s and `kiro-cli whoami` hung,
//                so the wire shape, the MCP tool naming and the status reader
//                are verified with a signed-in Kiro before it is enabled. Until
//                then Kiro souls join from a running session (agent-bot join).
//   - cursor / copilot — deliberately no row. Their CLIs keep isolated session
//                stores, so driving them here would never surface in the
//                desktop apps this plane exists to reach (#141 census).
//                Revisit only if that changes.
import { accessSync, constants, existsSync, realpathSync, statSync } from 'node:fs';
import { delimiter, isAbsolute, join } from 'node:path';
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

// Codex's workspace-write sandbox turns network access off, and the
// agent-comms broker is a unix socket that counts as network: under the
// default sandbox `agent-comms task show` answers daemon-unreachable, Codex
// asks to escalate, and the daemon policy denies it, so a task turn can never
// accept or report its task. codex-acp merges CODEX_CONFIG (a JSON object)
// into the session config, key by key under sandbox_workspace_write, so the
// adapter's own writable_roots survive. The resume lane passes the same
// setting as `-c sandbox_workspace_write.network_access=true` (wake-resume.mjs).
const CODEX_DAEMON_CONFIG = JSON.stringify({ sandbox_workspace_write: { network_access: true } });

const MUSE_ACP_PATH = fileURLToPath(new URL('./muse-acp.mjs', import.meta.url));

export const ACP_SPAWN_REGISTRY = Object.freeze({
  claude: Object.freeze({
    harness: 'claude',
    enabled: true,
    command: 'claude-code-acp',
    args: Object.freeze([]),
    soulBin: 'claude-code-acp',
    // The version a soul's package pins (GeniusBar's Starter); named so a
    // missing adapter fails with its package, never through npx (#418).
    adapter: Object.freeze({ package: '@zed-industries/claude-code-acp', version: '0.16.2' }),
    cli: 'claude',
    installHint: 'install Claude Code (https://claude.com/claude-code) and run `claude` once to sign in',
    // The Claude CLI the adapter installs with it; its store is ~/.claude.
    signIn: Object.freeze({ package: '@anthropic-ai/claude-agent-sdk', script: 'cli.js', command: 'claude',
      status: Object.freeze(['auth', 'status', '--json']), login: Object.freeze(['auth', 'login']), read: 'json' }),
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
    cli: 'opencode',
    installHint: 'install OpenCode (https://opencode.ai) and run `opencode auth login`',
    // Any stored provider or provider environment variable can serve a turn.
    signIn: Object.freeze({ command: 'opencode', status: Object.freeze(['auth', 'list']),
      login: Object.freeze(['auth', 'login', '--provider', 'openai', '--method', 'ChatGPT Pro/Plus (headless)']),
      read: Object.freeze({ loggedIn: /(?:^|\n)\s*└\s+[1-9]\d* (?:credentials|environment variables?)\s*(?:\n|$)/,
        signedOut: /(?:^|\n)\s*└\s+0 credentials\s*(?:\n|$)/ }) }),
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
    command: 'codex-acp',
    args: Object.freeze([]),
    soulBin: 'codex-acp',
    // Pinned in the soul's package like the Claude adapter (#418); it brings
    // its own Codex binary, so only the `codex` login is needed.
    adapter: Object.freeze({ package: '@agentclientprotocol/codex-acp', version: '2.1.1' }),
    cli: 'codex',
    installHint: 'install Codex (https://developers.openai.com/codex) and run `codex login`',
    signIn: Object.freeze({ package: '@openai/codex', script: 'bin/codex.js', command: 'codex',
      status: Object.freeze(['login', 'status']), login: Object.freeze(['login', '--device-auth']), read: 'exit-code',
      // Checked against codex-cli 0.161.0: "Not logged in" exits 1, and so does
      // "Error checking login status" for an unreadable auth.json (#536).
      signedOut: /^Not logged in\b/m }),
    stripEnv: Object.freeze([]),
    // Set after stripEnv, like the OpenCode ruleset: the sandbox must reach
    // the agent-comms socket (see CODEX_DAEMON_CONFIG).
    setEnv: Object.freeze({ CODEX_CONFIG: CODEX_DAEMON_CONFIG }),
    store: '~/.codex',
    mcpToolNaming: 'codex-mcp-title',
    // The adapter's default mode ("agent") lets Codex's own reviewer approve
    // calls, so the daemon policy would never be asked; workspace-write routes
    // every approval, MCP tools included, to this client.
    sessionMode: 'workspace-write',
    auth: 'existing `codex` login (shared credential store)',
    notes: 'third-party ACP adapter lane, pinned to @agentclientprotocol/codex-acp 2.1.1 (the @zed-industries package is deprecated): spawn, injected agent-reach MCP and default-deny reach rules verified live (#384); first-party app-server attach stays #148',
  }),
  kiro: Object.freeze({
    harness: 'kiro',
    enabled: false,
    command: 'kiro-cli',
    args: Object.freeze(['acp']),
    cli: 'kiro-cli',
    installHint: 'install Kiro CLI (https://kiro.dev) and run `kiro-cli login`',
    stripEnv: Object.freeze([]),
    // Sessions, settings, skills and steering; the sign-in lives in
    // ~/Library/Application Support/kiro-cli on macOS.
    store: '~/.kiro',
    // No signIn row yet: `kiro-cli whoami --format json` is the status
    // command, but its JSON shape and signed-out behaviour (it hung without a
    // sign-in) are unverified, and a reader that guesses would report a
    // signed-in Kiro as signed out.
    auth: '`kiro-cli login` (Builder ID, Google, GitHub or Identity Center)',
    notes: 'native `kiro-cli acp` is unverified: initialize got no answer within 10 s on a Mac without a Kiro sign-in (#523); enable after a signed-in spike confirms the wire shape and MCP tool naming',
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
  if (row.adapter !== undefined && (!row.soulBin || !row.adapter || typeof row.adapter.package !== 'string'
    || !/^(@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/.test(row.adapter.package)
    || typeof row.adapter.version !== 'string' || !/^\d+\.\d+\.\d+$/.test(row.adapter.version))) {
    failRegistry(`${row.harness}: adapter must name an npm package and an exact version, with a soulBin`);
  }
  if (row.sessionMode !== undefined && (typeof row.sessionMode !== 'string' || !/^[a-z0-9][a-z0-9_-]*$/.test(row.sessionMode))) {
    failRegistry(`${row.harness}: sessionMode must be an ACP session mode id`);
  }
  if (row.mcpToolNaming !== undefined && !MCP_TOOL_NAMINGS.includes(row.mcpToolNaming)) {
    failRegistry(`${row.harness}: mcpToolNaming must be one of ${MCP_TOOL_NAMINGS.join(', ')}`);
  }
  if (row.signIn !== undefined) {
    const auth = row.signIn;
    if (!auth || typeof auth.command !== 'string' || !auth.command
      || ['status', 'login'].some((key) => !Array.isArray(auth[key]) || !auth[key].length
        || auth[key].some((arg) => typeof arg !== 'string' || !arg))
      || !(['json', 'exit-code'].includes(auth.read) || (auth.read?.loggedIn instanceof RegExp
        && (auth.read.signedOut === undefined || auth.read.signedOut instanceof RegExp)))
      || (auth.signedOut !== undefined && !(auth.signedOut instanceof RegExp))
      || ((auth.package !== undefined || auth.script !== undefined)
        && (typeof auth.package !== 'string' || !auth.package || typeof auth.script !== 'string' || !auth.script))) {
      failRegistry(`${row.harness}: signIn requires a command, status, login, read and paired package/script`);
    }
  }
  return row;
}

/**
 * The command for a row in a working directory (ADR-0276): a soul home
 * that installed the row's npm binary runs it with this Node, so neither
 * npx nor a global install is needed. A joined soul's checkout installs
 * nothing, so its own harness directory is tried next (`dirs`, #417). A row
 * with no adapter runs its registry command. An adapter row never falls back
 * to npx (#418): a GeniusBar Mac has none, and an unpinned download is not
 * what the soul declared. It throws, naming the package the soul must pin.
 */
export function spawnCommand(row, cwd, { node = process.execPath, dirs = [] } = {}) {
  if (row.soulBin) {
    for (const dir of [cwd, ...dirs]) {
      if (typeof dir !== 'string' || !dir) continue;
      const bin = join(dir, 'node_modules', '.bin', row.soulBin);
      if (existsSync(bin)) return { command: node, args: [realpathSync(bin)] };
    }
  }
  if (row.adapter) {
    throw new Error(`acp registry: the ${row.harness} harness needs its ACP adapter ${row.adapter.package}@${row.adapter.version}, `
      + 'which this soul\'s package does not install');
  }
  return { command: row.command, args: [...row.args] };
}

/**
 * The environment a harness process runs with: the caller's env without
 * the row's nested-session variables, then the row's own settings. The
 * engine's turn spawn and the sign-in probe/login share it (#536), so a
 * status read sees the config the turn will run with.
 */
export function harnessProcessEnv(row, baseEnv = {}) {
  const env = { ...baseEnv };
  for (const name of row.stripEnv ?? []) delete env[name];
  return Object.assign(env, row.setEnv ?? {});
}

/**
 * The file Windows runs for a command: `name.exe`, keeping a name that
 * already ends in .exe. Only .exe: npm's .cmd shims need a shell that
 * spawn() refuses, so finding one would pick a harness that cannot start
 * (#617). PATH lookup and runtime readiness share this one rule.
 */
export function windowsExecutable(name) {
  return /\.exe$/i.test(name) ? name : `${name}.exe`;
}

// `platform` is the host's process.platform, not a catalog platform like
// `win32-x64`.
function commandFile(name, platform) {
  return platform === 'win32' ? windowsExecutable(name) : name;
}

/** The first executable regular file `name` on an env's PATH, else null. */
export function whichOnPath(name, env = process.env, { platform = process.platform } = {}) {
  for (const dir of (env.PATH ?? '').split(delimiter).filter(Boolean)) {
    const file = join(dir, commandFile(name, platform));
    try { if (statSync(file).isFile()) { accessSync(file, constants.X_OK); return file; } } catch { /* next */ }
  }
  return null;
}

/** Whether a bare command name is an executable regular file on PATH (never a directory). */
export function onPath(command, env = process.env, { platform = process.platform } = {}) {
  if (!command || command.includes('/') || (platform === 'win32' && command.includes('\\'))) return false;
  return whichOnPath(command, env, { platform }) !== null;
}

/** Whether an absolute path is an executable regular file (#536). */
export function executableFile(file) {
  try { if (!isAbsolute(file) || !statSync(file).isFile()) return false; accessSync(file, constants.X_OK); return true; } catch { return false; }
}

/**
 * A soul's harness when a launch names none (ADR-0276): its first
 * preferred harness the registry enables, else the first enabled registry
 * harness whose CLI (`cli`, else its command) is on PATH, else null.
 */
export function defaultHarnessFor(preferred = [], { registry = ACP_SPAWN_REGISTRY, available = (cmd) => onPath(cmd) } = {}) {
  const enabled = (key) => registry[key]?.enabled === true;
  return preferred.find(enabled)
    ?? Object.values(registry).find((row) => row.enabled && available(row.cli ?? row.command))?.harness
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
