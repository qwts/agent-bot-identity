// Detect which agent harness (IDE/CLI) is running, from the ambient
// environment each tool sets on its own. Returns a harness key — the user's
// config maps it to a bot slug (see config.mjs) — or null in a bare shell,
// which callers treat as "human, do nothing".
//
// Order matters: Cursor and VS Code both set TERM_PROGRAM=vscode (Cursor is a
// VS Code fork), so Cursor's own markers must be tested first. Add a harness
// by adding a row — first row whose `match` returns true wins.

const HARNESSES = [
  {
    key: 'claude',
    match: (e) => e.CLAUDECODE === '1' || (e.AI_AGENT ?? '').startsWith('claude') || (e.CLAUDE_CODE_ENTRYPOINT ?? '') !== '',
  },
  {
    key: 'codex',
    match: (e) => Object.keys(e).some((k) => k.startsWith('CODEX_')) || (e.AI_AGENT ?? '').includes('codex'),
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

export { HARNESSES };
