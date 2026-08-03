// Detect which agent harness (IDE/CLI) is running from the ambient environment
// each tool sets on its own. Returns a harness *key* (`claude`, `codex`, …);
// config.mjs maps that key to the user's bot slug. This is what makes the bot
// identity match the IDE with zero per-tool setup beyond config.json.
//
// Order matters, and it is not a Cursor quirk. Every harness here either forks
// VS Code or runs inside it, so they all set TERM_PROGRAM=vscode and/or
// VSCODE_*: Cursor (com.todesktop…), Devin/Windsurf (com.exafunction.windsurf,
// /Applications/Devin.app), Copilot (com.microsoft.VSCode). `vscode` is the
// fallback meaning "a human in an editor terminal" and MUST stay last — a row
// appended after it can never match. Add a harness by adding a row above it;
// first row whose `match` returns true wins.
//
// Devin is keyed `devin`, not `windsurf`: Cognition acquired Windsurf, the app
// ships as Devin, and the key also names territory (`.devin/worktrees/`) and
// the bot slug. Only the env markers are still Codeium-era, so the matcher and
// the key deliberately differ.

import { loadConfig, slugForHarness } from './config.mjs';

const HARNESSES = [
  {
    key: 'claude',
    match: (e) => e.CLAUDECODE === '1' || (e.AI_AGENT ?? '').startsWith('claude') || (e.CLAUDE_CODE_ENTRYPOINT ?? '') !== '',
  },
  {
    key: 'codex',
    match: (e) =>
      Object.keys(e).some((k) => k.startsWith('CODEX_')) || (e.AI_AGENT ?? '').includes('codex'),
  },
  {
    key: 'cursor',
    match: (e) =>
      Object.keys(e).some((k) => k.startsWith('CURSOR_')) ||
      (e.__CFBundleIdentifier ?? '').toLowerCase().includes('cursor'),
  },
  {
    // Deliberately NOT a `COPILOT_` prefix test: the extension sets keys like
    // COPILOT_DEBUG_NONCE in a human's VS Code terminal too. COPILOT_AGENT=1
    // is the marker that means the agent itself is running.
    key: 'copilot',
    match: (e) => e.COPILOT_AGENT === '1' || (e.AI_AGENT ?? '').toLowerCase().includes('copilot'),
  },
  {
    key: 'devin',
    match: (e) =>
      Object.keys(e).some((k) => k.startsWith('WINDSURF_')) ||
      (e.ACP_BACKEND ?? '').toLowerCase() === 'windsurf' ||
      (e.__CFBundleIdentifier ?? '').toLowerCase().includes('exafunction') ||
      (e.AI_AGENT ?? '').toLowerCase().includes('devin'),
  },
  {
    key: 'vscode',
    match: (e) =>
      e.TERM_PROGRAM === 'vscode' ||
      Object.keys(e).some((k) => k.startsWith('VSCODE_')) ||
      (e.__CFBundleIdentifier ?? '').toLowerCase().includes('com.microsoft.vscode'),
  },
];

// Returns the harness key for the detected tool, or null if none matched.
export function detectHarness(env = process.env) {
  for (const h of HARNESSES) {
    try {
      if (h.match(env)) return h.key;
    } catch {
      /* a malformed env value must never throw the resolver */
    }
  }
  return null;
}

// Deliberately narrower than detectHarness: these markers identify an agent
// process, not merely a human terminal opened inside an editor.
//
// THE RULE for adding a harness here: key on that tool's `<NAME>_AGENT`-shaped
// marker (CLAUDECODE=1, CURSOR_AGENT=1, COPILOT_AGENT=1, DEVIN_AGENT=1) and
// nothing else. A human terminal never carries one. Ambient editor variables —
// VSCODE_*, CURSOR_TRACE_ID, WINDSURF_*, TERM_PROGRAM — say only that an editor
// is open, and keying on them would attribute a human's commits to a bot.
// Security
// guards use this resolver when allowing stock human credentials would cross
// the agent/human identity boundary. Returns a bot slug (via config) or null.
export function detectAgentHarness(env = process.env, config = loadConfig({ env })) {
  const explicit = typeof env.GH_AGENT_APP === 'string' ? env.GH_AGENT_APP.trim() : '';
  if (explicit) return explicit;

  const aiAgent = typeof env.AI_AGENT === 'string' ? env.AI_AGENT.toLowerCase() : '';
  let key = null;
  if (
    env.CLAUDECODE === '1' ||
    (typeof env.CLAUDE_CODE_ENTRYPOINT === 'string' && env.CLAUDE_CODE_ENTRYPOINT !== '') ||
    aiAgent.includes('claude')
  ) {
    key = 'claude';
  } else if (Object.keys(env).some((k) => k.startsWith('CODEX_')) || aiAgent.includes('codex')) {
    key = 'codex';
  } else if (env.CURSOR_AGENT === '1' || aiAgent.includes('cursor')) {
    key = 'cursor';
    // Copilot must precede the vscode test: it sets
    // AI_AGENT=github_copilot_vscode_agent, which *contains* "vscode", so the
    // generic editor test would otherwise claim it and attribute Copilot's
    // commits to the vscode App.
  } else if (env.COPILOT_AGENT === '1' || aiAgent.includes('copilot')) {
    key = 'copilot';
    // DEVIN_AGENT/WINDSURF_AGENT follow the rule above; neither is confirmed
    // from a Devin agent session yet, but an unset marker simply never matches,
    // whereas the ambient WINDSURF_*/ACP_BACKEND markers deliberately do NOT
    // appear here — those were measured from the IDE extension host and mean
    // the editor is open, not that an agent is running.
  } else if (
    env.DEVIN_AGENT === '1' ||
    env.WINDSURF_AGENT === '1' ||
    aiAgent.includes('devin') ||
    aiAgent.includes('windsurf')
  ) {
    key = 'devin';
  } else if (aiAgent.includes('vscode')) {
    key = 'vscode';
  }
  return slugForHarness(key, config);
}

export { HARNESSES };
