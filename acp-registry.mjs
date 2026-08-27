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
//   - codex    — DECISION (this issue's checklist item): drive Codex through
//                the third-party ACP adapter lane (Zed's `codex-acp`) rather
//                than a first-party `codex mcp-server`/app-server shim. A shim
//                would embed a second protocol behind the engine and fork the
//                code path this plane exists to keep singular; the first-party
//                app-server socket remains the gated attach plane (#148). The
//                row ships disabled until the adapter spawn is verified on
//                this machine profile — the exact package pin is checked then.
//   - muse     — no row yet; it lands with muse-acp (#145).
//   - cursor / copilot — deliberately no row. Their CLIs keep isolated session
//                stores, so driving them here would never surface in the
//                desktop apps this plane exists to reach (#141 census).
//                Revisit only if that changes.
export const HARNESS_KEY_PATTERN = /^[a-z][a-z0-9-]{0,31}$/;

export const ACP_SPAWN_REGISTRY = Object.freeze({
  claude: Object.freeze({
    harness: 'claude',
    enabled: true,
    command: 'npx',
    args: Object.freeze(['--yes', '-p', '@zed-industries/claude-code-acp', 'claude-code-acp']),
    stripEnv: Object.freeze(['CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_CODE_SSE_PORT']),
    store: '~/.claude',
    auth: 'existing `claude` login (shared credential store)',
    notes: 'adapter-provided ACP, spawn verified in the #141 spike; upstream is renaming toward @agentclientprotocol/claude-agent-acp — repin when the verified package moves',
  }),
  opencode: Object.freeze({
    harness: 'opencode',
    enabled: true,
    command: 'opencode',
    args: Object.freeze(['acp']),
    stripEnv: Object.freeze([]),
    store: '~/.local/share/opencode',
    auth: '`opencode auth login`',
    notes: 'native ACP endpoint; proven end-to-end in the #141 spike (new turn + session/load resume)',
  }),
  codex: Object.freeze({
    harness: 'codex',
    enabled: false,
    command: 'npx',
    args: Object.freeze(['--yes', '-p', '@zed-industries/codex-acp', 'codex-acp']),
    stripEnv: Object.freeze([]),
    store: '~/.codex',
    auth: 'existing `codex` login (shared credential store)',
    notes: 'decided: third-party ACP adapter lane; disabled until the spawn (and exact package pin) is verified — first-party app-server attach stays #148',
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
  return row;
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
