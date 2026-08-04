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

// Events a hook can subscribe to, by creating agent-hooks/<event>/.
export const CANONICAL_EVENTS = [
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
  ['toolArgs', 'path'],
  ['tool_info', 'file_path'],
  ['tool_input', 'path'],
  ['file_path'],
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
export const DIALECTS = [
  {
    key: 'claude',
    // Devin CLI reads .claude/settings.json natively, so this row serves it too
    // and no .devin file is ever written — writing one double-fires every hook.
    alsoServes: ['devin-cli'],
    file: '.claude/settings.json',
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
    nativeFailMode: 'closed',
    timeoutFailMode: 'closed',
    timeoutCapMs: null,
    status: 'unverified',
    evidence: ['https://docs.devin.ai/desktop/cascade/hooks'],
    verifiedOn: '2026-08-02',
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

// One shape for every dialect. `raw` is always the verbatim vendor payload, so
// a hook can reach past this normalization the day a vendor ships a field the
// table does not model yet.
export function normalizeEnvelope({ dialectKey, event, payload = {} }) {
  const vendor = vendorEvent(dialectKey, event);
  return {
    schema_version: 1,
    event,
    harness: dialectKey,
    vendor_event: vendor?.event ?? null,
    session_id: firstKey(payload, FIELD_KEYS.sessionId) ?? null,
    cwd: firstKey(payload, FIELD_KEYS.cwd) ?? null,
    tool_name: firstKey(payload, FIELD_KEYS.toolName) ?? null,
    command: firstPath(payload, COMMAND_KEYS) ?? null,
    file_path: firstPath(payload, PATH_KEYS) ?? null,
    prompt: firstKey(payload, FIELD_KEYS.prompt) ?? null,
    model: firstKey(payload, FIELD_KEYS.model) ?? null,
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

// Canonical decision -> what this dialect understands. Allow is always
// empty-stdout-exit-0, which every dialect reads as "no opinion" — that is what
// lets the sh fast path answer without starting Node.
export function encodeDecision({ dialectKey, event, decision, reason = '' }) {
  const d = dialect(dialectKey);
  if (decision === 'allow') return { stdout: '', stderr: '', exitCode: 0 };

  // `ask` is inexpressible on an exit-code-only dialect. Degrade toward closed
  // on blocking events rather than quietly toward open.
  let verdict = decision;
  if (verdict === 'ask' && d.decision === 'exit-code') verdict = isBlocking(event) ? 'deny' : 'allow';
  if (verdict === 'allow') return { stdout: '', stderr: '', exitCode: 0 };

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
