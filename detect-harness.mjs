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
// ships as Devin, and the key also names the worktree layout (`.devin/worktrees/`) and
// the bot slug. Only the env markers are still Codeium-era, so the matcher and
// the key deliberately differ.

import { userInfo } from 'node:os';
import { loadConfig, rosterScope, slugForHarness } from './config.mjs';
import { PROFILE_HARNESSES, runtimeProfileInfo } from './organization-profile-schema.mjs';

function harnessEnvKey(harness) {
  return `${harness.toUpperCase()}_AGENT`;
}

const HARNESS_AGENT_ENV_VARS = Object.freeze([
  ...PROFILE_HARNESSES.map(harnessEnvKey),
  'WINDSURF_AGENT',
]);

function buildHarnessAgentShellChecks(action = 'return 0', indent = '  ') {
  return [
    ...HARNESS_AGENT_ENV_VARS.map((envVar) => `${indent}[ "$${envVar}" = "1" ] && ${action}`),
    `${indent}[ "$QWEN_CODE" = "1" ] && ${action}`,
  ].join('\n');
}

const HARNESS_TOKEN_RES = new Map(
  PROFILE_HARNESSES.map((harness) => [
    harness,
    new RegExp(`(?:^|[^a-z0-9])${harness}(?:[^a-z0-9]|$)`, 'i'),
  ]),
);
const WINDSURF_TOKEN_RE = /(?:^|[^a-z0-9])windsurf(?:[^a-z0-9]|$)/i;

function hasHarnessToken(text, harness) {
  if (typeof text !== 'string') return false;
  return HARNESS_TOKEN_RES.get(harness)?.test(text) ?? false;
}

const HARNESSES = [
  {
    key: 'claude',
    match: (e) =>
      e.CLAUDECODE === '1' ||
      (typeof e.CLAUDE_CODE_ENTRYPOINT === 'string' && e.CLAUDE_CODE_ENTRYPOINT !== '') ||
      (typeof e.AI_AGENT === 'string' && (e.AI_AGENT.toLowerCase().startsWith('claude') || hasHarnessToken(e.AI_AGENT, 'claude'))) ||
      e.CLAUDE_AGENT === '1',
  },
  {
    key: 'codex',
    match: (e) =>
      Object.keys(e).some((k) => k.startsWith('CODEX_')) ||
      hasHarnessToken(e.AI_AGENT, 'codex') ||
      e.CODEX_AGENT === '1',
  },
  {
    // Qwen Code is keyed `qwen`: the key names the worktree layout
    // (~/.qwen/worktrees/), matching its ~/.qwen config home and the
    // qwts-qwen-agent App slug.
    //
    // Measured from a live Qwen Code 0.24.6 session: QWEN_CODE=1 plus a
    // QWEN_CODE_* family (CLI, SESSION_ID, PROJECT_DIR, MODEL, …), with
    // AI_AGENT unset. It is a terminal CLI agent rather than an editor, so
    // QWEN_CODE=1 is the CLAUDECODE=1 analogue and a human terminal never
    // carries it — which is why broad detection and agent attribution below
    // may both key on it, as they do for claude. QWEN_CODE_AGENT_ID is
    // exported but EMPTY at top level, so it is deliberately not a marker:
    // an existence test would attribute every session and a non-empty test
    // would attribute none.
    //
    // Placed above cursor/copilot/devin/muse, not merely above the vscode
    // fallback. Qwen is a CLI a contributor runs in whatever integrated
    // terminal they already have open, and those rows match on ambient editor
    // markers (CURSOR_*, WINDSURF_*/ACP_BACKEND, MUSE_*) that the editor
    // exports to every child process. Below them, one session resolved two
    // ways: detectHarness answered `cursor` while detectAgentHarness — which
    // deliberately excludes ambient markers — answered `qwen`, the split
    // attribution this resolver exists to prevent. QWEN_CODE=1 names the
    // process actually running, so it wins over a marker that only says which
    // editor is open around it.
    //
    // claude and codex stay ahead. Their markers name another agent CLI
    // rather than a surrounding editor, and on those both resolvers already
    // agree, so there is no split to repair; which of two nested agents
    // should win is a separate question this row does not answer.
    key: 'qwen',
    match: (e) =>
      e.QWEN_CODE === '1' ||
      hasHarnessToken(e.AI_AGENT, 'qwen') ||
      e.QWEN_AGENT === '1',
  },
  {
    key: 'cursor',
    match: (e) =>
      e.CURSOR_AGENT === '1' ||
      Object.keys(e).some((k) => k.startsWith('CURSOR_')) ||
      (typeof e.__CFBundleIdentifier === 'string' && e.__CFBundleIdentifier.toLowerCase().includes('cursor')),
  },
  {
    // Deliberately NOT a `COPILOT_` prefix test: the extension sets keys like
    // COPILOT_DEBUG_NONCE in a human's VS Code terminal too. COPILOT_AGENT=1
    // is the marker that means the agent itself is running.
    key: 'copilot',
    match: (e) => e.COPILOT_AGENT === '1' || hasHarnessToken(e.AI_AGENT, 'copilot'),
  },
  {
    key: 'devin',
    match: (e) =>
      e.DEVIN_AGENT === '1' ||
      e.WINDSURF_AGENT === '1' ||
      Object.keys(e).some((k) => k.startsWith('WINDSURF_')) ||
      (typeof e.ACP_BACKEND === 'string' && e.ACP_BACKEND.toLowerCase() === 'windsurf') ||
      (typeof e.__CFBundleIdentifier === 'string' && e.__CFBundleIdentifier.toLowerCase().includes('exafunction')) ||
      hasHarnessToken(e.AI_AGENT, 'devin') ||
      (typeof e.AI_AGENT === 'string' && WINDSURF_TOKEN_RE.test(e.AI_AGENT)),
  },
  {
    // Meta Muse is keyed `muse`: the key names the worktree layout, and the app's
    // worktrees live under `.muse/worktrees/`, matching its `~/.muse` config
    // home and the qwts-muse-agent App slug.
    // MUSE_RELEASE_INFO is ambient — the app sets it for any terminal it
    // opens — but a terminal outside Muse never carries a MUSE_* key, so the
    // prefix test is safe here, same as the CODEX_/CURSOR_ rows. Ambient
    // markers stop at this broad detector; agent attribution needs the
    // MUSE_AGENT marker in detectAgentHarness below.
    key: 'muse',
    match: (e) =>
      e.MUSE_AGENT === '1' ||
      Object.keys(e).some((k) => k.startsWith('MUSE_')) ||
      hasHarnessToken(e.AI_AGENT, 'muse'),
  },
  {
    key: 'vscode',
    match: (e) =>
      e.VSCODE_AGENT === '1' ||
      e.TERM_PROGRAM === 'vscode' ||
      Object.keys(e).some((k) => k.startsWith('VSCODE_')) ||
      (typeof e.__CFBundleIdentifier === 'string' && e.__CFBundleIdentifier.toLowerCase().includes('com.microsoft.vscode')) ||
      hasHarnessToken(e.AI_AGENT, 'vscode'),
  },
];

// The OS account short name, or null when the platform cannot say. Never
// throws: the resolver must degrade to the other inputs, not crash.
//
// AGENT_BOT_ACCOUNT names the account explicitly. It exists for tests and for
// launchers that run a persona from a shell the kernel does not attribute to
// it; it is the same kind of stated input as GH_AGENT_APP (and confers no more
// — minting still needs that App's key in this home). The shell hooks and the
// gh shim read the same variable, so shell and JS never disagree about which
// account a process is in. Empty means unset.
export function accountName(env = process.env) {
  const override = typeof env?.AGENT_BOT_ACCOUNT === 'string' ? env.AGENT_BOT_ACCOUNT.trim() : '';
  if (override) return override;
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
export function configuredAccountIdentity(config = loadConfig(), account = accountName()) {
  const scope = rosterScope(config);
  if (!account || (scope && !scope.includes(account))) return null;
  const profile = runtimeProfileInfo(config);
  const identity = profile?.identities.find(({ slug, status }) => slug === account && status === 'active');
  const harness = profile ? identity?.harness : accountHarness(config, account);
  return harness ? { slug: account, harness } : null;
}

export function accountHarness(config = loadConfig(), account = accountName()) {
  if (!account) return null;
  for (const harness of PROFILE_HARNESSES) {
    if (slugForHarness(harness, config) === account) return harness;
  }
  return null;
}

// Detect explicit <HARNESS>_AGENT === '1' for any harness in PROFILE_HARNESSES
// (plus legacy WINDSURF_AGENT === '1' -> 'devin').
function detectExplicitHarnessAgent(env = process.env) {
  if (!env || typeof env !== 'object') return null;
  for (const harness of PROFILE_HARNESSES) {
    if (env[harnessEnvKey(harness)] === '1') return harness;
  }
  if (env.WINDSURF_AGENT === '1') return 'devin';
  return null;
}

// Match AI_AGENT containing any harness name across PROFILE_HARNESSES
// (copilot before vscode; legacy windsurf -> devin), bounded by token delimiters.
function detectAiAgentHarness(aiAgent) {
  if (!aiAgent || typeof aiAgent !== 'string') return null;
  for (const harness of PROFILE_HARNESSES) {
    if (harness === 'vscode') continue;
    if (hasHarnessToken(aiAgent, harness)) return harness;
  }
  if (WINDSURF_TOKEN_RE.test(aiAgent)) return 'devin';
  if (hasHarnessToken(aiAgent, 'vscode')) return 'vscode';
  return null;
}

// Returns the harness key for the detected tool, or null if none matched.
export function detectHarness(env = process.env) {
  try {
    const aiAgent = typeof env?.AI_AGENT === 'string' ? env.AI_AGENT.toLowerCase() : '';
    if (
      env?.CLAUDECODE === '1' ||
      (typeof env?.CLAUDE_CODE_ENTRYPOINT === 'string' && env.CLAUDE_CODE_ENTRYPOINT !== '') ||
      aiAgent.startsWith('claude') ||
      hasHarnessToken(aiAgent, 'claude')
    ) {
      return 'claude';
    }
    if (
      Object.keys(env ?? {}).some((k) => k.startsWith('CODEX_')) ||
      hasHarnessToken(aiAgent, 'codex')
    ) {
      return 'codex';
    }
    if (
      env?.QWEN_CODE === '1' ||
      hasHarnessToken(aiAgent, 'qwen')
    ) {
      return 'qwen';
    }

    // Explicit <HARNESS>_AGENT=1 outranks ambient editor markers (CURSOR_*,
    // WINDSURF_*, MUSE_*, VSCODE_*), avoiding split attribution between
    // detectHarness and detectAgentHarness.
    const explicitHarness = detectExplicitHarnessAgent(env);
    if (explicitHarness) return explicitHarness;

    // AI_AGENT naming any harness (except vscode, which stays with editor fallback).
    const aiHarness = detectAiAgentHarness(env?.AI_AGENT);
    if (aiHarness && aiHarness !== 'vscode') return aiHarness;

    for (const h of HARNESSES) {
      if (h.match(env)) return h.key;
    }
  } catch {
    /* a malformed env value must never throw the resolver */
  }
  return null;
}

// Deliberately narrower than detectHarness: these markers identify an agent
// process, not merely a human terminal opened inside an editor.
//
// THE RULE for adding a harness here: key on that tool's `<NAME>_AGENT`-shaped
// marker (CLAUDECODE=1, CURSOR_AGENT=1, COPILOT_AGENT=1, DEVIN_AGENT=1,
// ANTIGRAVITY_AGENT=1, …) and nothing else. A human terminal never carries one.
// Ambient editor variables — VSCODE_*, CURSOR_TRACE_ID, WINDSURF_*, TERM_PROGRAM —
// say only that an editor is open, and keying on them would attribute a human's
// commits to a bot. Security guards use this resolver when allowing stock human
// credentials would cross the agent/human identity boundary. Returns a bot
// slug (via config) or null.
export function detectAgentHarness(
  env = process.env,
  config = loadConfig({ env }),
  account = accountName(env),
) {
  const explicit = typeof env?.GH_AGENT_APP === 'string' ? env.GH_AGENT_APP.trim() : '';
  if (explicit) return explicit;

  // ENG-0339 moved bot territory up to the account: in an agent account every
  // process is that persona, human terminals included, so the account input
  // sits above the env markers. In any other account it yields null and the
  // marker chain below is unchanged — that chain still says "an agent process
  // is running", which is what this function answers; whether that process
  // may act as a bot is resolveAgentSlug's question, and in the owner's
  // account the answer is no unless the identity is stated.
  const accountKey = accountHarness(config, account);
  if (accountKey) return slugForHarness(accountKey, config);

  const aiAgent = typeof env?.AI_AGENT === 'string' ? env.AI_AGENT.toLowerCase() : '';
  let key = null;
  if (
    env?.CLAUDECODE === '1' ||
    (typeof env?.CLAUDE_CODE_ENTRYPOINT === 'string' && env.CLAUDE_CODE_ENTRYPOINT !== '') ||
    env?.CLAUDE_AGENT === '1' ||
    aiAgent.startsWith('claude') ||
    hasHarnessToken(aiAgent, 'claude')
  ) {
    key = 'claude';
  } else if (
    Object.keys(env ?? {}).some((k) => k.startsWith('CODEX_')) ||
    env?.CODEX_AGENT === '1' ||
    hasHarnessToken(aiAgent, 'codex')
  ) {
    key = 'codex';
  } else if (
    env?.QWEN_CODE === '1' ||
    env?.QWEN_AGENT === '1' ||
    hasHarnessToken(aiAgent, 'qwen')
  ) {
    key = 'qwen';
  } else {
    const explicitHarness = detectExplicitHarnessAgent(env);
    if (explicitHarness) {
      key = explicitHarness;
    } else {
      key = detectAiAgentHarness(env?.AI_AGENT);
    }
  }
  return slugForHarness(key, config);
}

export {
  HARNESSES,
  HARNESS_AGENT_ENV_VARS,
  buildHarnessAgentShellChecks,
  detectAiAgentHarness,
  detectExplicitHarnessAgent,
  harnessEnvKey,
};
