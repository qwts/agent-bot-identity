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

import { execFileSync } from 'node:child_process';
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
    `${indent}[ "$OPENCODE" = "1" ] && ${action}`,
    `${indent}case "$OPENCODE_CLIENT" in *[![:space:]]*) ${action} ;; esac`,
    `${indent}case "$OPENCODE_SESSION_ID" in *[![:space:]]*) ${action} ;; esac`,
    `${indent}case "$ZCODE_SESSION_ID" in *[![:space:]]*) ${action} ;; esac`,
    `${indent}case "$ZCODE_PROJECT_DIR" in *[![:space:]]*) ${action} ;; esac`,
    `${indent}if [ -x /usr/bin/awk ] && /usr/bin/awk 'BEGIN { for (k in ENVIRON) if (k ~ /^OPENCODE_EXPERIMENTAL_[A-Za-z0-9_]+$/ && ENVIRON[k] ~ /[^[:space:]]/) exit 0; exit 1 }'; then ${action}; fi`,
  ].join('\n');
}

function buildProcessTreeShellFunction(fnName = 'agent_bot_process_tree_context', psPath = '/bin/ps') {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(fnName)) {
    throw new Error(`Invalid shell function name: ${fnName}`);
  }
  const quotedPs = `'${String(psPath).replaceAll("'", "'\\''")}'`;
  return `${fnName}() {
  [ -x ${quotedPs} ] && [ -x /usr/bin/awk ] || return 1
  ${quotedPs} -axo pid=,ppid=,command= 2>/dev/null | /usr/bin/awk -v self="$$" -v ppid="$PPID" '
    function base(path,    n, parts) {
      n = split(path, parts, "/")
      return parts[n]
    }
    function is_interp(bin,    b) {
      b = base(bin)
      return (b == "sh" || b == "bash" || b == "zsh" || b == "dash" || b == "ksh" || b == "node" || b ~ /^[Pp]ython([0-9.]*)?$/)
    }
    function verify_zcode(pid,    req, cmd) {
      if (pid <= 1) return 0
      req = "anchor apple generic and (identifier \\"dev.zcode.app\\" or identifier \\"dev.zcode.app.helper\\" or identifier \\"dev.zcode.app.helper.GPU\\" or identifier \\"dev.zcode.app.helper.Plugin\\" or identifier \\"dev.zcode.app.helper.Renderer\\") and certificate leaf[field.1.2.840.113635.100.6.1.13] exists and certificate leaf[subject.OU] = \\"8A5X4JJ39T\\""
      cmd = "[ -x /usr/bin/codesign ] && /usr/bin/codesign -dv " pid " 2>&1 | /usr/bin/grep -q \\"^Executable=/Applications/ZCode.app/Contents/\\" && /usr/bin/codesign --verify -R=\\047" req "\\047 " pid " >/dev/null 2>&1"
      return (system(cmd) == 0)
    }
    function match_harness(line,    n, tok, t1, t2, b1, b2, i) {
      n = split(line, tok, /[[:space:]]+/)
      if (n < 1) return 0
      t1 = tok[1]
      b1 = base(t1)
      if (b1 == "mirror-agent" || t1 ~ /\\/mirror\\/bin\\/mirror$/) return 1
      if (b1 == "vibe-rs" || b1 == "vibe-app-server" || t1 ~ /\\/bin\\/vibe$/) return 1
      if (b1 == "opencode" || b1 == "opencode-cli" || t1 ~ /\\/(opencode\\/)?bin\\/opencode(-cli)?$/ || line ~ /^\\/.*\\/OpenCode\\.app\\/Contents\\/MacOS\\/(OpenCode|opencode-cli)([[:space:]]|$)/ || line ~ /^\\/.*\\/Application Support\\/ai\\.opencode\\.desktop\\/cli\\/[^\\/]+\\/opencode(-cli)?([[:space:]]|$)/) return 1
      if (b1 == "zcode" || b1 == "zcode-cli" || b1 ~ /^zcode-host-/ || t1 ~ /\\/(zcode\\/)?bin\\/zcode(-cli)?$/ || line ~ /^\\/.*\\/ZCode\\.app\\/Contents\\/(MacOS\\/ZCode|Frameworks\\/ZCode Helper( \\((Renderer|Plugin|GPU)\\))?\\.app\\/Contents\\/MacOS\\/ZCode Helper( \\((Renderer|Plugin|GPU)\\))?)([[:space:]]|$)/) return 2
      if (is_interp(t1)) {
        for (i = 2; i <= n; i++) {
          if (tok[i] ~ /^-[a-zA-Z]*c/ || tok[i] == "-e" || tok[i] == "--eval" || tok[i] == "-m") break
          if (substr(tok[i], 1, 1) == "-") continue
          t2 = tok[i]
          b2 = base(t2)
          if (b2 == "mirror-agent" || t2 ~ /\\/(mirror\\/)?bin\\/mirror$/) return 1
          if (b2 == "vibe-rs" || b2 == "vibe-app-server" || t2 ~ /\\/bin\\/vibe$/) return 1
          if (b2 == "opencode" || b2 == "opencode-cli" || t2 ~ /\\/(opencode\\/)?bin\\/opencode(-cli)?$/) return 1
          if (b2 == "zcode" || b2 == "zcode-cli" || b2 == "zcode.cjs" || t2 ~ /\\/(zcode\\/)?bin\\/zcode(-cli)?$/ || t2 ~ /\\/ZCode\\.app\\/Contents\\/Resources\\/.*\\/zcode\\.cjs$/) return 2
          break
        }
      }
      return 0
    }
    function is_test_runner(line,    n, tok, t1, b1, i) {
      n = split(line, tok, /[[:space:]]+/)
      if (n < 1) return 0
      t1 = tok[1]
      b1 = base(t1)
      if (t1 ~ /\\.test\\.sh$/) return 1
      if (b1 == "bash" || b1 == "sh") {
        for (i = 2; i <= n; i++) {
          if (tok[i] ~ /^-[a-zA-Z]*c/) break
          if (substr(tok[i], 1, 1) == "-") continue
          return (tok[i] ~ /\\.test\\.sh$/)
        }
      }
      if (b1 == "node") {
        for (i = 2; i <= n; i++) {
          if (tok[i] == "-e" || tok[i] == "--eval" || tok[i] == "-p" || tok[i] == "--print") break
          if (tok[i] == "--test" || tok[i] ~ /\\.test\\.(mjs|cjs|js)$/) return 1
        }
      }
      return 0
    }
    {
      pid = $1 + 0
      p = $2 + 0
      $1 = ""; $2 = ""
      sub(/^[[:space:]]+/, "")
      parent[pid] = p
      cmd[pid] = $0
    }
    END {
      cur = (self + 0 in cmd) ? (self + 0) : (ppid + 0)
      for (depth = 0; cur > 1 && depth < 32; depth++) {
        if (!(cur in cmd)) break
        m = match_harness(cmd[cur])
        if (m == 1 || (m == 2 && verify_zcode(cur))) exit 0
        if (is_test_runner(cmd[cur])) exit 1
        if (parent[cur] == cur) break
        cur = parent[cur]
      }
      exit 1
    }
  '
}`;
}

function baseName(token) {
  const idx = token.lastIndexOf('/');
  return idx === -1 ? token : token.slice(idx + 1);
}

function isProcessInterpreter(token) {
  const b = baseName(token);
  return (
    b === 'sh' ||
    b === 'bash' ||
    b === 'zsh' ||
    b === 'dash' ||
    b === 'ksh' ||
    b === 'node' ||
    /^[Pp]ython(?:[0-9.]*)?$/.test(b)
  );
}

export const ZCODE_APP_BUNDLE_PATH = '/Applications/ZCode.app';
export const ZCODE_TEAM_ID = '8A5X4JJ39T';
export const ZCODE_IDENTIFIERS = Object.freeze([
  'dev.zcode.app',
  'dev.zcode.app.helper',
  'dev.zcode.app.helper.GPU',
  'dev.zcode.app.helper.Plugin',
  'dev.zcode.app.helper.Renderer',
]);
export const ZCODE_CODESIGN_REQUIREMENT =
  'anchor apple generic and (identifier "dev.zcode.app" or identifier "dev.zcode.app.helper" or identifier "dev.zcode.app.helper.GPU" or identifier "dev.zcode.app.helper.Plugin" or identifier "dev.zcode.app.helper.Renderer") and certificate leaf[field.1.2.840.113635.100.6.1.13] exists and certificate leaf[subject.OU] = "8A5X4JJ39T"';

export function inspectSignedZcodeProcess(
  pid,
  { codesignPath = '/usr/bin/codesign', codesignRunner } = {},
) {
  const targetPid = Number(pid);
  if (!Number.isInteger(targetPid) || targetPid <= 1) {
    return { valid: false, reason: 'invalid-pid' };
  }
  if (typeof codesignRunner !== 'function' && process.platform !== 'darwin') {
    return { valid: false, reason: 'unsupported-platform' };
  }
  let infoOutput = '';
  if (typeof codesignRunner === 'function') {
    try {
      const res = codesignRunner(['-dv', String(targetPid)], { codesignPath, pid: targetPid });
      infoOutput = typeof res === 'string' ? res : String(res?.stderr ?? res?.stdout ?? '');
    } catch {
      return { valid: false, reason: 'codesign-display-failed' };
    }
  } else {
    try {
      // `codesign -dv <pid>` writes its key=value output to stderr on exit 0.
      infoOutput = execFileSync(
        '/bin/sh',
        ['-c', 'exec "$1" -dv "$2" 2>&1', 'sh', codesignPath, String(targetPid)],
        { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 2_000 },
      );
    } catch {
      return { valid: false, reason: 'codesign-display-failed' };
    }
  }
  const executableMatch = infoOutput.match(/^Executable=(.+)$/m);
  const identifierMatch = infoOutput.match(/^Identifier=(.+)$/m);
  const teamMatch = infoOutput.match(/^TeamIdentifier=(.+)$/m);
  const executablePath = executableMatch ? executableMatch[1].trim() : '';
  const identifier = identifierMatch ? identifierMatch[1].trim() : '';
  const teamIdentifier = teamMatch ? teamMatch[1].trim() : '';
  if (!executablePath.startsWith(`${ZCODE_APP_BUNDLE_PATH}/Contents/`)) {
    return {
      valid: false,
      reason: 'executable-outside-zcode-bundle',
      executablePath: executablePath || null,
      identifier: identifier || null,
      teamIdentifier: teamIdentifier || null,
    };
  }
  if (!ZCODE_IDENTIFIERS.includes(identifier)) {
    return {
      valid: false,
      reason: 'unexpected-identifier',
      executablePath,
      identifier: identifier || null,
      teamIdentifier: teamIdentifier || null,
    };
  }
  if (teamIdentifier !== ZCODE_TEAM_ID) {
    return {
      valid: false,
      reason: 'unexpected-team-identifier',
      executablePath,
      identifier,
      teamIdentifier: teamIdentifier || null,
    };
  }
  try {
    if (typeof codesignRunner === 'function') {
      codesignRunner(['--verify', `-R=${ZCODE_CODESIGN_REQUIREMENT}`, String(targetPid)], {
        codesignPath,
        pid: targetPid,
      });
    } else {
      execFileSync(codesignPath, ['--verify', `-R=${ZCODE_CODESIGN_REQUIREMENT}`, String(targetPid)], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: 2_000,
      });
    }
  } catch {
    return {
      valid: false,
      reason: 'codesign-requirement-failed',
      executablePath,
      identifier,
      teamIdentifier,
    };
  }
  return {
    valid: true,
    pid: targetPid,
    executablePath,
    bundlePath: ZCODE_APP_BUNDLE_PATH,
    identifier,
    teamIdentifier,
  };
}

function matchProcessHarnessCommand(command) {
  if (typeof command !== 'string' || !command.trim()) return null;
  const trimmed = command.trim();
  const tokens = trimmed.split(/\s+/);
  const t1 = tokens[0] ?? '';
  const b1 = baseName(t1);
  if (b1 === 'mirror-agent' || /\/mirror\/bin\/mirror$/.test(t1)) return 'mirror';
  if (b1 === 'vibe-rs' || b1 === 'vibe-app-server' || /\/bin\/vibe$/.test(t1)) return 'vibe';
  if (
    b1 === 'opencode' ||
    b1 === 'opencode-cli' ||
    /\/(?:opencode\/)?bin\/opencode(?:-cli)?$/.test(t1) ||
    /^\/.*\/OpenCode\.app\/Contents\/MacOS\/(?:OpenCode|opencode-cli)(?:\s|$)/.test(trimmed) ||
    /^\/.*\/Application Support\/ai\.opencode\.desktop\/cli\/[^/]+\/opencode(?:-cli)?(?:\s|$)/.test(trimmed)
  ) {
    return 'opencode';
  }
  if (
    b1 === 'zcode' ||
    b1 === 'zcode-cli' ||
    /^zcode-host-/.test(b1) ||
    /\/(?:zcode\/)?bin\/zcode(?:-cli)?$/.test(t1) ||
    /^\/.*\/ZCode\.app\/Contents\/(?:MacOS\/ZCode|Frameworks\/ZCode Helper(?: \((?:Renderer|Plugin|GPU)\))?\.app\/Contents\/MacOS\/ZCode Helper(?: \((?:Renderer|Plugin|GPU)\))?)(?:\s|$)/.test(trimmed)
  ) {
    return 'zcode';
  }
  if (isProcessInterpreter(t1)) {
    for (let i = 1; i < tokens.length; i += 1) {
      const tok = tokens[i];
      if (/^-[a-zA-Z]*c/.test(tok) || tok === '-e' || tok === '--eval' || tok === '-m') break;
      if (tok.startsWith('-')) continue;
      const b2 = baseName(tok);
      if (b2 === 'mirror-agent' || /\/(?:mirror\/)?bin\/mirror$/.test(tok)) return 'mirror';
      if (b2 === 'vibe-rs' || b2 === 'vibe-app-server' || /\/bin\/vibe$/.test(tok)) return 'vibe';
      if (b2 === 'opencode' || b2 === 'opencode-cli' || /\/(?:opencode\/)?bin\/opencode(?:-cli)?$/.test(tok)) return 'opencode';
      if (
        b2 === 'zcode' ||
        b2 === 'zcode-cli' ||
        b2 === 'zcode.cjs' ||
        /\/(?:zcode\/)?bin\/zcode(?:-cli)?$/.test(tok) ||
        /\/ZCode\.app\/Contents\/Resources\/.*\/zcode\.cjs$/.test(tok)
      ) {
        return 'zcode';
      }
      break;
    }
  }
  return null;
}

function isProcessTestRunnerCommand(command) {
  if (typeof command !== 'string' || !command.trim()) return false;
  const tokens = command.trim().split(/\s+/);
  const t1 = tokens[0] ?? '';
  const b1 = baseName(t1);
  if (/\.test\.sh$/.test(t1)) return true;
  if (b1 === 'bash' || b1 === 'sh') {
    for (let i = 1; i < tokens.length; i += 1) {
      const tok = tokens[i];
      if (/^-[a-zA-Z]*c/.test(tok)) break;
      if (tok.startsWith('-')) continue;
      return /\.test\.sh$/.test(tok);
    }
  }
  if (b1 === 'node') {
    for (let i = 1; i < tokens.length; i += 1) {
      const tok = tokens[i];
      if (tok === '-e' || tok === '--eval' || tok === '-p' || tok === '--print') break;
      if (tok === '--test' || /\.test\.[cm]?js$/.test(tok)) return true;
    }
  }
  return false;
}

let cachedLiveProcessHarness;

export function detectProcessTreeHarness({
  env = process.env,
  pid = process.pid,
  psOutput,
  psPath = '/bin/ps',
  codesignPath = '/usr/bin/codesign',
  codesignRunner,
  verifyZcodeSignature,
} = {}) {
  try {
    if (psOutput === undefined) {
      if (env !== process.env) return null;
      if (process.argv.some((arg) => arg === '--test' || /\.test\.[cm]?js$/.test(arg))) {
        return null;
      }
      if (
        cachedLiveProcessHarness !== undefined &&
        pid === process.pid &&
        psPath === '/bin/ps' &&
        codesignPath === '/usr/bin/codesign' &&
        codesignRunner === undefined &&
        verifyZcodeSignature === undefined
      ) {
        return cachedLiveProcessHarness;
      }
    }
    const raw =
      typeof psOutput === 'string'
        ? psOutput
        : execFileSync(psPath, ['-axo', 'pid=,ppid=,command='], {
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'ignore'],
            timeout: 2_000,
          });
    const table = new Map();
    for (const line of raw.split('\n')) {
      const m = line.match(/^\s*(\d+)\s+(\d+)\s+(.*)$/);
      if (!m) continue;
      table.set(Number(m[1]), { ppid: Number(m[2]), command: m[3] });
    }
    const shouldVerifyZcode =
      verifyZcodeSignature !== undefined ? Boolean(verifyZcodeSignature) : true;
    let cur = Number(pid);
    let found = null;
    for (let depth = 0; cur > 1 && depth < 32; depth += 1) {
      const entry = table.get(cur);
      if (!entry) break;
      const harness = matchProcessHarnessCommand(entry.command);
      if (harness === 'zcode' && shouldVerifyZcode) {
        const verified = inspectSignedZcodeProcess(cur, { codesignPath, codesignRunner });
        if (verified.valid) {
          found = 'zcode';
          break;
        }
      } else if (harness) {
        found = harness;
        break;
      }
      if (isProcessTestRunnerCommand(entry.command)) {
        break;
      }
      if (entry.ppid === cur) break;
      cur = entry.ppid;
    }
    if (
      psOutput === undefined &&
      env === process.env &&
      pid === process.pid &&
      psPath === '/bin/ps' &&
      codesignPath === '/usr/bin/codesign' &&
      codesignRunner === undefined &&
      verifyZcodeSignature === undefined
    ) {
      cachedLiveProcessHarness = found;
    }
    return found;
  } catch {
    return null;
  }
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

export function isOpencodeDirectEnv(e) {
  return (
    e?.OPENCODE === '1' ||
    e?.OPENCODE_AGENT === '1' ||
    (typeof e?.OPENCODE_CLIENT === 'string' && e.OPENCODE_CLIENT.trim() !== '') ||
    (typeof e?.OPENCODE_SESSION_ID === 'string' && e.OPENCODE_SESSION_ID.trim() !== '')
  );
}

export function hasOpencodeExperimentalEnv(e) {
  return Object.keys(e ?? {}).some(
    (k) => /^OPENCODE_EXPERIMENTAL_[A-Za-z0-9_]+$/.test(k) && typeof e[k] === 'string' && e[k].trim() !== '',
  );
}

export function isOpencodeAgentEnv(e) {
  return isOpencodeDirectEnv(e) || hasOpencodeExperimentalEnv(e);
}

export function isZcodeDirectEnv(e) {
  return (
    e?.ZCODE_AGENT === '1' ||
    (typeof e?.ZCODE_SESSION_ID === 'string' && e.ZCODE_SESSION_ID.trim() !== '') ||
    (typeof e?.ZCODE_PROJECT_DIR === 'string' && e.ZCODE_PROJECT_DIR.trim() !== '')
  );
}

const HARNESSES = [
  {
    // ZCode Desktop (`/Applications/ZCode.app`, `dev.zcode.app`) exports
    // `ZCODE_SESSION_ID` and `ZCODE_PROJECT_DIR` alongside Claude-compatible
    // `CLAUDE_SESSION_ID`, `CLAUDE_CODE_SESSION_ID`, and `CLAUDE_PROJECT_DIR`
    // in every Bash tool invocation (`zcode.cjs`). Placing `zcode` ahead of
    // `claude` ensures direct ZCode session markers win even if a future ZCode
    // build also sets `CLAUDECODE=1` for hook compatibility.
    key: 'zcode',
    match: (e) =>
      isZcodeDirectEnv(e) ||
      hasHarnessToken(e.AI_AGENT, 'zcode') ||
      (typeof e.__CFBundleIdentifier === 'string' && e.__CFBundleIdentifier.toLowerCase() === 'dev.zcode.app'),
  },
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
    key: 'opencode',
    match: (e) =>
      isOpencodeAgentEnv(e) ||
      hasHarnessToken(e.AI_AGENT, 'opencode') ||
      (typeof e.__CFBundleIdentifier === 'string' && e.__CFBundleIdentifier.toLowerCase() === 'ai.opencode.desktop'),
  },
  {
    // Reflection.ai Mirror CLI (`mirror` -> `mirror-agent`) and Mistral Vibe
    // (`vibe` -> `vibe-rs` / `vibe-app-server`) are terminal CLI harnesses
    // that do not export `<HARNESS>_AGENT=1` into tool subprocesses by default.
    // Like `qwen`, they sit above ambient editor rows so a CLI session launched
    // inside an editor's integrated terminal resolves to the CLI agent rather
    // than the surrounding editor.
    key: 'mirror',
    match: (e) =>
      e.MIRROR_AGENT === '1' ||
      hasHarnessToken(e.AI_AGENT, 'mirror'),
  },
  {
    key: 'vibe',
    match: (e) =>
      e.VIBE_AGENT === '1' ||
      hasHarnessToken(e.AI_AGENT, 'vibe'),
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

// ENG-0339: the account short name is itself a viewer input. Agent
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
export function detectHarness(env = process.env, options = {}) {
  try {
    const aiAgent = typeof env?.AI_AGENT === 'string' ? env.AI_AGENT.toLowerCase() : '';
    if (
      isZcodeDirectEnv(env) ||
      hasHarnessToken(aiAgent, 'zcode')
    ) {
      return 'zcode';
    }
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
    if (
      isOpencodeDirectEnv(env) ||
      hasHarnessToken(aiAgent, 'opencode')
    ) {
      return 'opencode';
    }

    // Explicit <HARNESS>_AGENT=1 outranks ambient editor markers (CURSOR_*,
    // WINDSURF_*, MUSE_*, VSCODE_*) and OPENCODE_EXPERIMENTAL_* flags,
    // avoiding split attribution between detectHarness and detectAgentHarness.
    const explicitHarness = detectExplicitHarnessAgent(env);
    if (explicitHarness) return explicitHarness;

    if (hasOpencodeExperimentalEnv(env)) {
      return 'opencode';
    }

    // AI_AGENT naming any harness (except vscode, which stays with editor fallback).
    const aiHarness = detectAiAgentHarness(env?.AI_AGENT);
    if (aiHarness && aiHarness !== 'vscode') return aiHarness;

    // Process-ancestry CLI harnesses (`mirror-agent`, `vibe-rs`, `vibe-app-server`, `zcode-cli`)
    // outrank ambient surrounding-editor markers just like `qwen`.
    const processHarness = detectProcessTreeHarness({ env, ...options });
    if (processHarness) return processHarness;

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
  options = {},
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
    isZcodeDirectEnv(env) ||
    hasHarnessToken(aiAgent, 'zcode')
  ) {
    key = 'zcode';
  } else if (
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
  } else if (
    isOpencodeDirectEnv(env) ||
    hasHarnessToken(aiAgent, 'opencode')
  ) {
    key = 'opencode';
  } else {
    const explicitHarness = detectExplicitHarnessAgent(env);
    if (explicitHarness) {
      key = explicitHarness;
    } else if (hasOpencodeExperimentalEnv(env)) {
      key = 'opencode';
    } else {
      const aiHarness = detectAiAgentHarness(env?.AI_AGENT);
      if (aiHarness && aiHarness !== 'vscode') {
        key = aiHarness;
      } else {
        key = detectProcessTreeHarness({ env, ...options }) ?? aiHarness;
      }
    }
  }
  return slugForHarness(key, config);
}

export {
  HARNESSES,
  HARNESS_AGENT_ENV_VARS,
  buildHarnessAgentShellChecks,
  buildProcessTreeShellFunction,
  detectAiAgentHarness,
  detectExplicitHarnessAgent,
  harnessEnvKey,
  matchProcessHarnessCommand,
};
