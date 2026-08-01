// Detect which agent harness (IDE/CLI) is running from the ambient environment
// each tool sets on its own. Returns a harness *key* (`claude`, `codex`, …);
// config.mjs maps that key to the user's bot slug. This is what makes the bot
// identity match the IDE with zero per-tool setup beyond config.json.
//
// Order matters: Cursor and VS Code both set TERM_PROGRAM=vscode (Cursor is a
// VS Code fork), so Cursor's own marker must be tested first. Add a harness by
// adding a row — first row whose `match` returns true wins.

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
// process, not merely a human terminal opened inside an editor. Security
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
  } else if (aiAgent.includes('cursor')) {
    key = 'cursor';
  } else if (aiAgent.includes('vscode')) {
    key = 'vscode';
  }
  return slugForHarness(key, config);
}

export { HARNESSES };
