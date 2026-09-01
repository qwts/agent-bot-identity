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

import { userInfo } from 'node:os';
import { loadConfig, slugForHarness } from './config.mjs';
import { PROFILE_HARNESSES } from './organization-profile.mjs';

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
    // Meta Muse is keyed `muse`: the key names territory, and the app's
    // worktrees live under `.muse/worktrees/`, matching its `~/.muse` config
    // home and the qwts-muse-agent App slug.
    // MUSE_RELEASE_INFO is ambient — the app sets it for any terminal it
    // opens — but a terminal outside Muse never carries a MUSE_* key, so the
    // prefix test is safe here, same as the CODEX_/CURSOR_ rows. Ambient
    // markers stop at this broad detector; agent attribution needs the
    // MUSE_AGENT marker in detectAgentHarness below.
    key: 'muse',
    match: (e) =>
      Object.keys(e).some((k) => k.startsWith('MUSE_')) ||
      (e.AI_AGENT ?? '').toLowerCase().includes('muse'),
  },
  {
    key: 'vscode',
    match: (e) =>
      e.TERM_PROGRAM === 'vscode' ||
      Object.keys(e).some((k) => k.startsWith('VSCODE_')) ||
      (e.__CFBundleIdentifier ?? '').toLowerCase().includes('com.microsoft.vscode'),
  },
];

// The OS account short name, or null when the platform cannot say. Never
// throws: the resolver must degrade to the other inputs, not crash.
export function accountName() {
  try {
    return userInfo().username || null;
  } catch {
    return null;
  }
}

// ENG-0339: the account short name is itself a detection input. Agent
// accounts are named by their harness-level App slug (account
// `qwts-goose-agent` is the goose persona), so an account whose name IS the
// slug a harness resolves to identifies that harness with no per-tool env
// research — this is the rule that covers harnesses with no matcher above.
// The comparison runs through slugForHarness so config `apps` overrides and
// the `prefix` convention both count, and so no-config stays inert: without a
// mapping nothing can match, and an account matching no configured slug
// (the owner's account included — delegate mode, human persona) yields null.
export function accountHarness(config = loadConfig(), account = accountName()) {
  if (!account) return null;
  for (const harness of PROFILE_HARNESSES) {
    if (slugForHarness(harness, config) === account) return harness;
  }
  return null;
}

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
export function detectAgentHarness(
  env = process.env,
  config = loadConfig({ env }),
  account = accountName(),
) {
  const explicit = typeof env.GH_AGENT_APP === 'string' ? env.GH_AGENT_APP.trim() : '';
  if (explicit) return explicit;

  // ENG-0339 moved bot territory up to the account: in an agent account every
  // process is that persona, human terminals included, so the account input
  // sits above the env markers. In any other account it yields null and the
  // marker chain below is unchanged.
  const accountKey = accountHarness(config, account);
  if (accountKey) return slugForHarness(accountKey, config);

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
    // MUSE_AGENT follows the <NAME>_AGENT rule (Meta Muse, keyed `muse` — see
    // the HARNESSES row). MUSE_RELEASE_INFO is ambient (present whenever the
    // app is open, agent or human) and deliberately does NOT appear here.
  } else if (env.MUSE_AGENT === '1' || aiAgent.includes('muse')) {
    key = 'muse';
  } else if (aiAgent.includes('vscode')) {
    key = 'vscode';
  }
  return slugForHarness(key, config);
}

export { HARNESSES };
