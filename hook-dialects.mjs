// The one hand-maintained description of how each agent harness spells its
// lifecycle hooks. Everything else in the agent-hook layer is generic: the
// runner, the folder convention and the hook scripts never name a vendor.
//
// This file is pure data plus two pure functions. No I/O, no process, no fs —
// so the whole dialect surface is unit-testable without a harness present.
//
// Why canonical event names are kebab-case and match no vendor's spelling: if
// they looked like Claude's PascalCase, the day Claude renames one the name
// would silently mean two things. A vendor spelling appears only in a `events`
// map below.

import { isAbsolute, resolve } from 'node:path';

// Events a hook can subscribe to, by creating agent-hooks/<event>/.
export const CANONICAL_EVENTS = [
  'spawn',
  'session-start',
  'session-end',
  'prompt-submit',
  'pre-tool-use',
  'pre-command',
  'pre-file-write',
  'post-tool-use',
  'agent-stop',
  'pre-commit',
  'pre-push',
];

// Fail mode is a property of the EVENT, never of the hook. That is what lets a
// hook be nothing but an executable file: there is no manifest to declare a
// fail mode in, so there is no fail mode to declare wrongly. On these events a
// hook that errors, times out, or prints garbage DENIES.
export const BLOCKING_EVENTS = new Set([
  'prompt-submit',
  'pre-tool-use',
  'pre-command',
  'pre-file-write',
  'agent-stop',
  'pre-commit',
  'pre-push',
]);

export function isBlocking(event) {
  return BLOCKING_EVENTS.has(event);
}

// Candidate key lists, first present wins. Deliberately not one hard path per
// dialect: two cells in the table below are documented weakly (Cursor's CLI
// event coverage comes from a forum post that contradicts the docs; Copilot's
// PascalCase aliases appear on one page only), and vendors add fields without
// warning. A list degrades to "field absent" instead of to a crash.
const FIELD_KEYS = {
  sessionId: ['session_id', 'sessionId', 'conversation_id', 'conversationId', 'trajectory_id'],
  cwd: ['cwd', 'workspace_root', 'workspaceRoot', 'working_directory'],
  toolName: ['tool_name', 'toolName', 'agent_action_name'],
  prompt: ['prompt', 'user_prompt', 'transformed_prompt'],
  // Coverage is partial by nature: Codex and Cursor document a model field
  // (Cursor sends both `model` and `model_id`), Windsurf sends `model_name`,
  // and Claude's documented common fields do not include one. A hook that
  // wants the model must therefore tolerate its absence — which is the same
  // contract as every other optional field here.
  model: ['model', 'model_id', 'modelId', 'model_name'],
};

// Nested places a shell command may hide, by dialect family.
const COMMAND_KEYS = [
  ['tool_input', 'command'],
  ['toolArgs', 'command'],
  ['tool_info', 'command_line'],
  ['tool_input', 'cmd'],
  ['command'],
];

const PATH_KEYS = [
  ['tool_input', 'file_path'],
  ['tool_input', 'notebook_path'],
  ['toolArgs', 'file_path'],
  ['toolArgs', 'filePath'],
  ['toolArgs', 'path'],
  ['tool_info', 'file_path'],
  ['tool_input', 'path'],
  ['file_path'],
  ['path'],
];

function dig(payload, keys) {
  let node = payload;
  for (const key of keys) {
    if (node === null || typeof node !== 'object') return undefined;
    node = node[key];
  }
  return typeof node === 'string' && node !== '' ? node : undefined;
}

function firstKey(payload, keys) {
  if (payload === null || typeof payload !== 'object') return undefined;
  for (const key of keys) {
    const value = payload[key];
    if (typeof value === 'string' && value !== '') return value;
  }
  return undefined;
}

function firstPath(payload, paths) {
  for (const keys of paths) {
    const value = dig(payload, keys);
    if (value !== undefined) return value;
  }
  return undefined;
}

// `decisions` records what the dialect's channel can express. `nativeFailMode`
// and `timeoutFailMode` are SEPARATE on purpose: Copilot's preToolUse fails
// closed when a hook errors but OPEN when it times out, and collapsing those
// into one field is exactly how a guard silently stops guarding under load.
export const CLAUDE_WORKTREE_CREATE_COMMAND = 'B="$HOME/.local/bin/agent-bot"; A=$("$B" worktree-token --account-slug) || exit $?; [ -n "$A" ] || exit 0; GH_AGENT_APP="${GH_AGENT_APP:-$A}" exec "$B" claude-worktree-create';

// `contextChannel` records, per canonical event, whether this dialect can hand
// a hook's text to the model as CONTEXT rather than as a verdict. It is a
// separate axis from `decision`: a permission answer travels the other way
// (hook -> harness -> enforced), while context is advisory text the model may
// read. Most dialects have no such channel at all, and an empty map is a
// declared gap the runner reports — never a silent drop of what a hook said.
//
// Only SessionStart is modelled, because that is the one event where a hook
// legitimately needs to tell the model something standing ("arm the wake
// listener") instead of allowing or denying an action.
export const DIALECTS = [
  {
    key: 'claude',
    // Devin CLI reads .claude/settings.json natively, so this row serves it too
    // and no .devin file is ever written — writing one double-fires every hook.
    alsoServes: ['devin-cli'],
    file: '.claude/settings.json',
    homeFile: '.claude/settings.json',
    format: 'claude',
    events: {
      'session-start': 'SessionStart',
      'session-end': 'SessionEnd',
      'prompt-submit': 'UserPromptSubmit',
      'pre-tool-use': 'PreToolUse',
      'pre-command': { event: 'PreToolUse', matcher: 'Bash' },
      'pre-file-write': { event: 'PreToolUse', matcher: 'Write|Edit|MultiEdit' },
      'post-tool-use': 'PostToolUse',
      'agent-stop': 'Stop',
    },
    decision: 'claude-json',
    // SessionStart and PreToolUse can carry advisory text through
    // `hookSpecificOutput.additionalContext`, without changing permission.
    contextChannel: { 'session-start': 'claude-json', 'pre-tool-use': 'claude-json' },
    nativeFailMode: 'closed',
    timeoutFailMode: 'closed',
    timeoutCapMs: null,
    status: 'verified',
    evidence: ['https://code.claude.com/docs/en/hooks'],
    verifiedOn: '2026-08-02',
  },
  {
    key: 'codex',
    file: '.codex/hooks.json',
    homeFile: '.codex/hooks.json',
    format: 'claude',
    events: {
      'session-start': 'SessionStart',
      'session-end': 'SessionEnd',
      'prompt-submit': 'UserPromptSubmit',
      'pre-tool-use': 'PreToolUse',
      'pre-command': { event: 'PreToolUse', matcher: '^Bash$' },
      'pre-file-write': { event: 'PreToolUse', matcher: '^(Write|Edit)$' },
      'post-tool-use': 'PostToolUse',
      'agent-stop': 'Stop',
    },
    decision: 'claude-json',
    // This row already speaks the claude-json stdout channel for decisions, so
    // context rides the same envelope. Codex documents no context field of its
    // own; if it ignores `additionalContext` the injection is a no-op there and
    // nothing else changes — the runner's own stderr note still says it sent it.
    contextChannel: { 'session-start': 'claude-json' },
    nativeFailMode: 'closed',
    timeoutFailMode: 'closed',
    // Codex caps SessionEnd hard. The runner budgets under this; a hook that
    // needs longer must not be given the impression it ran.
    timeoutCapMs: { 'session-end': 3000 },
    handlerTypes: ['command'],
    status: 'verified',
    evidence: ['https://developers.openai.com/codex/hooks'],
    verifiedOn: '2026-08-02',
  },
  {
    key: 'cursor',
    file: '.cursor/hooks.json',
    homeFile: '.cursor/hooks.json',
    format: 'cursor',
    events: {
      'session-start': 'sessionStart',
      'prompt-submit': 'beforeSubmitPrompt',
      'pre-tool-use': 'preToolUse',
      'pre-command': 'beforeShellExecution',
      'pre-file-write': { event: 'preToolUse', matcher: 'Write|Edit' },
      'post-tool-use': 'postToolUse',
      'agent-stop': 'stop',
      'session-end': 'sessionEnd',
    },
    decision: 'cursor-json',
    // No context field is documented for sessionStart. stdout there is the
    // permission answer, so injecting text would mean inventing a field — which
    // the harness would ignore, silently, and we would have reported otherwise.
    contextChannel: {},
    contextNote: 'no context field is documented for sessionStart — stdout is the permission answer',
    // Cursor fails OPEN unless the config sets failClosed. The generator emits
    // that flag on every blocking event rather than documenting the hazard.
    nativeFailMode: 'open',
    timeoutFailMode: 'open',
    requiresFlag: { failClosed: true },
    timeoutCapMs: null,
    // Per-event CLI coverage is a forum claim that contradicts the docs. Wired
    // anyway — a wrong cell means a hook that does not fire there, never a
    // guard that silently passes, because blocking policy also lives in the git
    // layer via pre-commit/pre-push.
    status: 'unverified',
    evidence: [
      'https://cursor.com/docs/hooks',
      'https://forum.cursor.com/t/cursor-cli-doesnt-send-all-events-defined-in-hooks/148316',
    ],
    verifiedOn: '2026-08-02',
  },
  {
    key: 'copilot',
    file: '.github/hooks/agent-bot.json',
    homeFile: '.copilot/hooks/agent-bot.json',
    format: 'copilot',
    events: {
      'session-start': 'sessionStart',
      'session-end': 'sessionEnd',
      'prompt-submit': 'userPromptSubmitted',
      'pre-tool-use': 'preToolUse',
      'pre-command': { event: 'preToolUse', matcher: 'bash|powershell' },
      'pre-file-write': { event: 'preToolUse', matcher: 'create|edit' },
      'post-tool-use': 'postToolUse',
      'agent-stop': 'agentStop',
    },
    decision: 'copilot-json',
    // No context field is documented for sessionStart either, and the row's
    // decision envelope is a permission object — the wrong shape to smuggle
    // advisory text through.
    contextChannel: {},
    contextNote: 'no context field is documented for sessionStart — nothing to carry context in',
    nativeFailMode: 'closed',
    // The one that matters: preToolUse fails CLOSED on a hook error but OPEN on
    // a hook timeout. The runner therefore answers on its own clock, strictly
    // below the vendor's, so the open path is never reached.
    timeoutFailMode: 'open',
    timeoutCapMs: { default: 30000 },
    status: 'verified',
    evidence: ['https://docs.github.com/en/copilot/reference/hooks-configuration'],
    verifiedOn: '2026-08-02',
  },
  {
    key: 'devin-desktop',
    file: '.windsurf/hooks.json',
    homeFile: '.windsurf/hooks.json',
    format: 'windsurf',
    // LEGACY. Cognition acquired Windsurf; the app ships as Devin and its CLI
    // already speaks the claude dialect. This snake_case, no-matcher,
    // exit-code-only surface is a waypoint, not a destination. Retirement is
    // detectable: the runner records the vendor event names it actually
    // receives, so the day this sends PreToolUse the row can simply be deleted.
    legacy: true,
    retirementSignal: 'receives a PascalCase vendor event',
    events: {
      'session-start': 'post_setup_worktree',
      'pre-command': 'pre_run_command',
      'pre-file-write': 'pre_write_code',
      'post-tool-use': 'post_run_command',
      'agent-stop': 'post_cascade_response',
    },
    // No stdout protocol at all: exit code is the entire channel, and there is
    // no matcher field, so every filter must live inside the hook.
    decision: 'exit-code',
    contextChannel: {},
    contextNote: 'exit code is the entire channel — there is no stdout to carry context',
    nativeFailMode: 'closed',
    timeoutFailMode: 'closed',
    timeoutCapMs: null,
    status: 'unverified',
    evidence: ['https://docs.devin.ai/desktop/cascade/hooks'],
    verifiedOn: '2026-08-02',
  },
  {
    // OpenCode has no hook config file. It loads every `{plugin,plugins}/*.{ts,js}`
    // under `.opencode/` as a plugin module (config/plugin.ts) and awaits its
    // hooks inside its own process, so the adapter is a generated plugin
    // (soul-builder's `opencodeHookPlugin`, #378) rather than a JSON entry, and
    // this row is the contract that plugin speaks. Both spellings load; `plugins/` is the one the docs
    // name for a project, so `pluginFile` uses it. Checked against
    // OpenCode 1.18.34 (anomalyco/opencode@aec0b9a6): `Hooks` in
    // packages/plugin/src/index.ts, and the call sites in session/tools.ts,
    // session/prompt.ts and plugin/index.ts. Subagents run the same prompt
    // loop, so their tool calls reach the same hooks.
    //
    // Stdin is the hook's own `input` and `output` objects merged into one,
    // plus the plugin's `directory`: `{tool, sessionID, callID, args}` around
    // a tool call, `{sessionID, model, message, parts, …}` on chat.message,
    // and `{event}` from the bus. The plugin renames nothing; `fields` below
    // is the whole translation, so a hook reads the same envelope as anywhere.
    key: 'opencode',
    file: null,
    pluginFile: '.opencode/plugins/agent-bot-soul.js',
    format: 'opencode-plugin',
    events: {
      // From the `event` bus, which OpenCode fires without awaiting: right for
      // an advisory event. A subagent's child session is created there too.
      'session-start': { event: 'event', matcher: '^session\\.created$' },
      // No session-end: the bus has `session.deleted` (the user removed the
      // session) and `session.idle` (one turn finished), and neither is the
      // end of a session. A declared gap beats a hook that fires on deletion.
      'prompt-submit': 'chat.message',
      'pre-tool-use': 'tool.execute.before',
      // ShellID.ToolID is literally "bash", whatever shell actually runs.
      'pre-command': { event: 'tool.execute.before', matcher: '^bash$' },
      // Some models get apply_patch in place of write and edit. Its argument
      // is patch text with no single path, so `file_path` stays null for it.
      'pre-file-write': { event: 'tool.execute.before', matcher: '^(write|edit|apply_patch)$' },
      'post-tool-use': 'tool.execute.after',
    },
    // Where this row's payload keeps each envelope field. A list here replaces
    // the generic one for that field rather than extending it, so nothing a
    // tool's own `args` happen to contain is mistaken for another harness's key.
    fields: {
      sessionId: [['sessionID'], ['event', 'properties', 'sessionID'], ['event', 'properties', 'info', 'id']],
      cwd: [['directory']],
      toolName: [['tool']],
      command: [['args', 'command']],
      filePath: [['args', 'filePath']],
      // chat.message sends the model as `{providerID, modelID}`.
      model: [['model', 'modelID']],
    },
    // The prompt is the user's text parts, not one string.
    promptParts: ['parts'],
    // The plugin sends a write as pre-tool-use and pre-file-write alike, and a
    // generated adapter must not be the reason a write goes unchecked, so
    // confinement checks a file tool on either event here.
    confinementEvents: ['pre-tool-use', 'pre-file-write'],
    // OpenCode's shell tool. Its call is command-scanned on pre-tool-use as
    // well as pre-command, so the identity guard never rests on the plugin
    // also sending the narrower event.
    shellTool: 'bash',
    // bash runs in `args.workdir` resolved against the instance directory
    // (tool/shell.ts), not in `directory`. The identity guard places a
    // `git push` by the envelope's cwd, so cwd must be where the shell runs,
    // or a bound session could push from an unbound checkout unseen.
    shellWorkdir: ['args', 'workdir'],
    // The verdict is the exit code, and the plugin is what reads it: exit 2
    // is a deny with the reason on stderr; any other nonzero exit, a crash or
    // the plugin's own timeout is an error. The plugin throws on a deny, and
    // on an error for a blocking event, which is how OpenCode aborts a tool
    // call or a prompt. A hook can only throw or return, so `ask` closes.
    decision: 'exit-code',
    contextChannel: {},
    contextNote: 'a plugin hook can only throw or return — nothing carries context to the model',
    nativeFailMode: 'closed',
    // OpenCode awaits a plugin hook with no clock of its own, so the only
    // timeout is the plugin's, and the plugin denies on it.
    timeoutFailMode: 'closed',
    timeoutCapMs: null,
    status: 'verified',
    evidence: [
      'https://github.com/anomalyco/opencode/blob/aec0b9a6d8898f68f923aaf08b7306d931fd9d76/packages/plugin/src/index.ts#L222-L281',
      'https://github.com/anomalyco/opencode/blob/aec0b9a6d8898f68f923aaf08b7306d931fd9d76/packages/opencode/src/plugin/index.ts#L255-L297',
      'https://github.com/anomalyco/opencode/blob/aec0b9a6d8898f68f923aaf08b7306d931fd9d76/packages/opencode/src/config/plugin.ts#L18-L29',
      'https://github.com/anomalyco/opencode/blob/aec0b9a6d8898f68f923aaf08b7306d931fd9d76/packages/web/src/content/docs/plugins.mdx#L18-L23',
      'https://github.com/anomalyco/opencode/blob/aec0b9a6d8898f68f923aaf08b7306d931fd9d76/packages/opencode/src/session/tools.ts#L103-L125',
      'https://github.com/anomalyco/opencode/blob/aec0b9a6d8898f68f923aaf08b7306d931fd9d76/packages/opencode/src/session/prompt.ts#L999-L1009',
      'https://github.com/anomalyco/opencode/blob/aec0b9a6d8898f68f923aaf08b7306d931fd9d76/packages/opencode/src/tool/shell.ts#L612-L614',
      'https://github.com/anomalyco/opencode/blob/aec0b9a6d8898f68f923aaf08b7306d931fd9d76/packages/opencode/src/tool/shell/id.ts#L15-L17',
    ],
    verifiedOn: '2026-10-11',
  },
  {
    // The universal backstop. No vendor, no drift, 100% availability, and an
    // exit-code channel that cannot fail open. Blocking policy that must hold
    // everywhere lives here as well as in a harness event.
    key: 'git',
    file: null,
    format: 'git',
    events: { 'pre-commit': 'pre-commit', 'pre-push': 'pre-push' },
    decision: 'exit-code',
    contextChannel: {},
    contextNote: 'git has no session-start event to inject into',
    nativeFailMode: 'closed',
    timeoutFailMode: 'closed',
    timeoutCapMs: null,
    status: 'verified',
    evidence: ['githooks(5)'],
    verifiedOn: '2026-08-02',
  },
];

export function dialect(key) {
  const found = DIALECTS.find((d) => d.key === key);
  if (!found) throw new Error(`unknown dialect: ${key}`);
  return found;
}

// The vendor event (and matcher, where the dialect has one) for a canonical
// event, or null when this dialect cannot express it. A null is a declared gap,
// reported by `doctor`, never a silent no-op.
export function vendorEvent(dialectKey, event) {
  const spec = dialect(dialectKey).events[event];
  if (!spec) return null;
  return typeof spec === 'string' ? { event: spec, matcher: null } : { matcher: null, ...spec };
}

// The seconds a native entry asks its harness to wait, from the row's cap.
// Shared by both writers of native entries: the lifecycle adapters
// (sync-hooks.mjs) and the soul builder's soul-declared hooks.
export function hookTimeoutSeconds(dialectKey, event) {
  const row = dialect(dialectKey);
  const cap = row.timeoutCapMs?.[event] ?? row.timeoutCapMs?.default;
  return cap ? Math.ceil(cap / 1000) : 60;
}

// One native config entry that runs `run` (a shell command) on a canonical
// event, in the row's own entry shape, or null when the row cannot express the
// event. The caller owns the command, and with it the marker that says whose
// entry this is: `agent-bot agent-hook` for the lifecycle adapters,
// SOUL_HOOK_MARKER for hooks a soul declared.
export function nativeHookEntry(dialectKey, event, run) {
  const row = dialect(dialectKey);
  const mapped = vendorEvent(dialectKey, event);
  if (!mapped) return null;
  if (row.format === 'claude') {
    return {
      vendorEvent: mapped.event,
      entry: {
        ...(mapped.matcher ? { matcher: mapped.matcher } : {}),
        hooks: [{ type: 'command', command: run, timeout: hookTimeoutSeconds(dialectKey, event) }],
      },
    };
  }
  if (row.format === 'cursor') {
    return { vendorEvent: mapped.event, entry: { command: run, ...(isBlocking(event) ? row.requiresFlag : {}) } };
  }
  if (row.format === 'copilot') {
    return {
      vendorEvent: mapped.event,
      entry: {
        type: 'command',
        bash: run,
        ...(mapped.matcher ? { matcher: mapped.matcher } : {}),
        timeoutSec: hookTimeoutSeconds(dialectKey, event),
      },
    };
  }
  if (row.format === 'windsurf') return { vendorEvent: mapped.event, entry: { command: run, show_output: false } };
  // OpenCode's adapter is one generated plugin, not an entry in a config file.
  if (row.format === 'opencode-plugin') throw new Error(`${dialectKey} hooks are a generated plugin, not a config entry`);
  throw new Error(`unsupported hook format: ${row.format}`);
}

// The marker on every native entry the soul builder renders for a soul's own
// hooks (#378). Deliberately disjoint from sync-hooks' MANAGED_MARKER and its
// `agent-hook --dialect` recognizer, so neither owner ever strips the other's
// entries out of a file they both write into.
export const SOUL_HOOK_MARKER = 'agent-bot soul hook';

// Can this dialect hand a hook's text to the model on this event? A false here
// is a declared gap, and the caller must say so rather than drop the text
// quietly — a hook that believes it armed a session and did not is worse than
// no hook at all.
export function supportsContext(dialectKey, event) {
  return Boolean(dialect(dialectKey).contextChannel?.[event]);
}

// Is this the moment to scan a shell command? Always on pre-command; on
// pre-tool-use too where the row names its shell tool, so a guard that reads
// the command does not depend on an adapter also firing the narrower event.
export function scansCommand(envelope) {
  if (envelope.event === 'pre-command') return true;
  const shell = dialect(envelope.harness).shellTool;
  return envelope.event === 'pre-tool-use' && Boolean(shell) && envelope.tool_name === shell;
}

// The events confinement checks a file tool on. One by default, the generic
// event where the dialect has it, so an adapter that fires both for one write
// is checked once; a row may list both.
export function confinementEvents(dialectKey) {
  const row = dialect(dialectKey);
  return row.confinementEvents ?? [vendorEvent(dialectKey, 'pre-tool-use') ? 'pre-tool-use' : 'pre-file-write'];
}

// The row's own words for why it cannot inject context, or null when it can.
// Surfaced by `doctor` so a harness that silently lacks the channel is visible
// in a readiness report instead of only in this file.
export function contextNote(dialectKey) {
  return dialect(dialectKey).contextNote ?? null;
}

export function budgetMs(dialectKey, event, requested = 10000) {
  const cap = dialect(dialectKey).timeoutCapMs;
  if (!cap) return requested;
  const limit = cap[event] ?? cap.default;
  if (!limit) return requested;
  // Answer strictly inside the vendor's window; on Copilot the margin is what
  // keeps a slow hook from reaching the fail-open timeout path. The floor
  // guards a pathologically small cap — it must not inflate a caller that
  // deliberately asked for less.
  return Math.min(requested, Math.max(250, limit - 500));
}

// The user's text from a list of message parts, skipping what the harness
// added on its own (`synthetic`) or set aside (`ignored`).
function textParts(payload, keys) {
  let node = payload;
  for (const key of keys) node = node && typeof node === 'object' ? node[key] : undefined;
  if (!Array.isArray(node)) return undefined;
  const text = node
    .filter((part) => part?.type === 'text' && typeof part.text === 'string' && !part.synthetic && !part.ignored)
    .map((part) => part.text)
    .join('\n');
  return text === '' ? undefined : text;
}

// Where a shell tool actually runs, the way the harness resolves it: an
// absolute workdir as is, a relative one against an absolute base. A workdir
// that cannot be placed leaves the base, never a relative path. (OpenCode's
// Windows cygpath translation is not modelled.)
function shellCwd(row, payload, toolName, base) {
  if (!row.shellWorkdir || toolName !== row.shellTool) return base;
  const workdir = dig(payload, row.shellWorkdir);
  if (workdir === undefined) return base;
  if (isAbsolute(workdir)) return resolve(workdir);
  return base && isAbsolute(base) ? resolve(base, workdir) : base;
}

// One shape for every dialect. `raw` is always the verbatim vendor payload, so
// a hook can reach past this normalization the day a vendor ships a field the
// table does not model yet. A row's own `fields` list, where it has one, is
// the whole translation for that field.
export function normalizeEnvelope({ dialectKey, event, payload = {} }) {
  const row = dialect(dialectKey);
  const vendor = vendorEvent(dialectKey, event);
  const own = row.fields ?? {};
  const field = (name, generic) => (own[name] ? firstPath(payload, own[name]) : generic());
  const toolName = field('toolName', () => firstKey(payload, FIELD_KEYS.toolName)) ?? null;
  const cwd = field('cwd', () => firstKey(payload, FIELD_KEYS.cwd)) ?? null;
  const prompt = row.promptParts
    ? textParts(payload, row.promptParts)
    : firstKey(payload, FIELD_KEYS.prompt);
  return {
    schema_version: 1,
    event,
    harness: dialectKey,
    vendor_event: vendor?.event ?? null,
    session_id: field('sessionId', () => firstKey(payload, FIELD_KEYS.sessionId)) ?? null,
    cwd: shellCwd(row, payload, toolName, cwd) ?? null,
    tool_name: toolName,
    command: field('command', () => firstPath(payload, COMMAND_KEYS)) ?? null,
    file_path: field('filePath', () => firstPath(payload, PATH_KEYS)) ?? null,
    prompt: prompt ?? null,
    model: field('model', () => firstKey(payload, FIELD_KEYS.model)) ?? null,
    blocking: isBlocking(event),
    raw: payload,
  };
}

// The env mirror, so a five-line sh hook never parses JSON.
export function envelopeEnv(envelope) {
  const env = {
    AGENT_HOOK_EVENT: envelope.event,
    AGENT_HOOK_HARNESS: envelope.harness,
    AGENT_HOOK_BLOCKING: envelope.blocking ? '1' : '0',
  };
  const optional = {
    AGENT_HOOK_SESSION_ID: envelope.session_id,
    AGENT_HOOK_CWD: envelope.cwd,
    AGENT_HOOK_TOOL_NAME: envelope.tool_name,
    AGENT_HOOK_TOOL_COMMAND: envelope.command,
    AGENT_HOOK_TOOL_PATH: envelope.file_path,
    AGENT_HOOK_PROMPT: envelope.prompt,
    AGENT_HOOK_MODEL: envelope.model,
    AGENT_HOOK_GIT_STDIN: envelope.raw?.git_stdin,
  };
  for (const [key, value] of Object.entries(optional)) if (value) env[key] = value;
  return env;
}

// Canonical decision -> what this dialect understands. Most dialects read an
// empty stdout with exit 0 as "no opinion". Cursor rejects empty stdout when
// failClosed is enabled, so its neutral response must be a valid JSON object.
export function encodeDecision({ dialectKey, event, decision, reason = '' }) {
  const d = dialect(dialectKey);
  const allow = {
    stdout: d.decision === 'cursor-json' ? '{}' : '',
    stderr: '',
    exitCode: 0,
  };
  if (decision === 'allow') return allow;

  // `ask` is inexpressible on an exit-code-only dialect. Degrade toward closed
  // on blocking events rather than quietly toward open.
  let verdict = decision;
  if (verdict === 'ask' && d.decision === 'exit-code') verdict = isBlocking(event) ? 'deny' : 'allow';
  if (verdict === 'allow') return allow;

  const vendor = vendorEvent(dialectKey, event);
  switch (d.decision) {
    case 'claude-json':
      return {
        stdout: JSON.stringify({
          hookSpecificOutput: {
            hookEventName: vendor?.event ?? event,
            permissionDecision: verdict === 'ask' ? 'ask' : 'deny',
            permissionDecisionReason: reason,
          },
        }),
        stderr: reason,
        exitCode: 0,
      };
    case 'cursor-json':
      return {
        stdout: JSON.stringify({
          permission: verdict === 'ask' ? 'ask' : 'deny',
          agent_message: reason,
          user_message: reason,
        }),
        stderr: '',
        exitCode: 0,
      };
    case 'copilot-json':
      return {
        stdout: JSON.stringify({
          permissionDecision: verdict === 'ask' ? 'ask' : 'deny',
          permissionDecisionReason: reason,
        }),
        stderr: '',
        exitCode: 0,
      };
    case 'exit-code':
    default:
      // Exit 2 is the Claude/Codex native "block", and the only thing Windsurf
      // and git can say at all.
      return { stdout: '', stderr: reason, exitCode: 2 };
  }
}

// Advisory text -> what this dialect understands, in the same three-field shape
// as encodeDecision. Context is never a verdict: it exits 0 and denies nothing,
// so a hook that injects text can only ever add to a session.
//
// Returns null when the dialect has no channel for this event. That is
// deliberately distinguishable from an empty encoding — a caller that wrote ''
// and moved on would be reporting an injection that never happened.
export function encodeContext({ dialectKey, event, contexts = [] }) {
  if (!supportsContext(dialectKey, event)) return null;
  const text = contexts
    .filter((entry) => typeof entry === 'string' && entry.trim() !== '')
    .map((entry) => entry.trim())
    .join('\n\n');
  if (!text) return { stdout: '', stderr: '', exitCode: 0 };
  const vendor = vendorEvent(dialectKey, event);
  switch (dialect(dialectKey).contextChannel[event]) {
    case 'claude-json':
      return {
        stdout: JSON.stringify({
          hookSpecificOutput: {
            hookEventName: vendor?.event ?? event,
            additionalContext: text,
          },
        }),
        stderr: '',
        exitCode: 0,
      };
    default:
      return null;
  }
}
