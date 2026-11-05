#!/usr/bin/env node

// Sanctioned CLI path to a live session binding for harnesses without
// MCP `bind` (#1170). It performs the same surrender as the MCP tool:
// read this worktree's single-use bind token, exchange it at the daemon,
// and report only the resulting identity. The binding secret stays in
// the private git dir (written by the daemon) and is never printed.

import { execFileSync } from 'node:child_process';
import { closeSync, existsSync, openSync, readSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { createRequire } from 'node:module';
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

import { discoverTranscript, readBinding, readBindToken, resolveAgentSlug } from './identity-cli.mjs';
import { daemonClient } from './daemon-client.mjs';
import { detectAgentHarness, detectHarness } from './detect-harness.mjs';

export const SESSION_BIND_USAGE = `usage: agent-bot session bind [--transcript-id ID] [--provider NAME] [--parent-agent-id ID] [--json]

Establish (or verify) this worktree's live session binding without MCP.
Note: [deprecated] Prefer \`agent-bot start [--branch <branch>]\` for routine task and worktree startup.
With an existing binding this validates it at the daemon and needs no
transcript id. Without one, the conversation is named by --transcript-id,
else by the harness: CODEX_THREAD_ID, CLAUDE_SESSION_ID,
CURSOR_CONVERSATION_ID, QWEN_CODE_SESSION_ID, OPENCODE_SESSION_ID, a
lifecycle hook's session id, Antigravity's active brain transcript,
OpenCode's active session database, or Devin's session list when it
names exactly one session for this worktree.
`;

const NO_TRANSCRIPT = '--transcript-id is required: no session id was found for this conversation '
  + '(run `agent-bot session bind --transcript-id <session-id>` in a plain shell, '
  + 'Qwen Code exports QWEN_CODE_SESSION_ID, OpenCode exports OPENCODE_SESSION_ID or records active sessions in opencode.db; '
  + 'for Devin, run `devin list --format json` in the directory '
  + 'the session started in), or bind with the MCP bind tool';

// Devin exports no session id, so its list is the only witness: the ids it
// shows for exactly this worktree, the same lookup a resume wake uses.
async function listDevinSessions(cwd, env) {
  const { RESUME_HARNESSES } = await import('./wake-resume.mjs');
  const row = RESUME_HARNESSES.devin;
  try {
    const stdout = execFileSync(row.command, row.listArgs, {
      cwd, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 15_000,
    });
    return row.sessionsIn(stdout, cwd);
  } catch {
    return null;
  }
}

function readFileTail(filePath, sizeBytes, maxBytes = 65_536) {
  let fd;
  try {
    fd = openSync(filePath, 'r');
    const len = Math.min(sizeBytes, maxBytes);
    const offset = Math.max(0, sizeBytes - len);
    const buf = Buffer.alloc(len);
    const bytesRead = readSync(fd, buf, 0, len, offset);
    return buf.subarray(0, bytesRead).toString('utf8');
  } catch {
    return '';
  } finally {
    if (fd !== undefined) {
      try { closeSync(fd); } catch { /* ignore */ }
    }
  }
}

function textMentionsPath(text, targetPath) {
  if (!text || !targetPath) return false;
  let pos = 0;
  while ((pos = text.indexOf(targetPath, pos)) !== -1) {
    const before = pos === 0 ? '' : text[pos - 1];
    const afterIdx = pos + targetPath.length;
    const after = afterIdx >= text.length ? '' : text[afterIdx];
    const validBefore = !before || /["'\s=:(]/.test(before);
    const validAfter = !after || /["'\s/:,;)]/.test(after);
    if (validBefore && validAfter) return true;
    pos += 1;
  }
  return false;
}

export function discoverAntigravityTranscript(home, { cwd = null, now = Date.now(), maxAgeMs = 60_000, env = null } = {}) {
  const explicitId = typeof env?.ANTIGRAVITY_CONVERSATION_ID === 'string' && env.ANTIGRAVITY_CONVERSATION_ID.trim()
    ? env.ANTIGRAVITY_CONVERSATION_ID.trim()
    : null;
  if (explicitId) return { provider: 'antigravity', id: explicitId };
  if (!home) return null;
  const brainDir = path.join(home, '.gemini', 'antigravity', 'brain');
  let entries;
  try {
    entries = readdirSync(brainDir, { withFileTypes: true });
  } catch {
    return null;
  }
  const candidates = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
    const logPath = path.join(brainDir, entry.name, '.system_generated', 'logs', 'transcript.jsonl');
    try {
      const st = statSync(logPath);
      candidates.push({ id: entry.name, logPath, mtimeMs: st.mtimeMs, size: st.size });
    } catch {
      /* ignore entries without transcript.jsonl */
    }
  }
  if (candidates.length === 0) return null;
  // Require the transcript to have been updated within maxAgeMs of `now`
  // (Antigravity writes the PLANNER_RESPONSE tool call immediately before
  // spawning the subprocess). An idle conversation never silently adopts
  // another conversation's transcript.
  const fresh = candidates.filter((c) => now - c.mtimeMs <= maxAgeMs && c.mtimeMs - now <= 60_000);
  if (fresh.length === 0) return null;
  if (cwd) {
    const cwdMatched = fresh.filter((c) => {
      const tail = readFileTail(c.logPath, c.size);
      return textMentionsPath(tail, cwd);
    });
    if (cwdMatched.length !== 1) return null;
    return { provider: 'antigravity', id: cwdMatched[0].id };
  }
  if (fresh.length !== 1) return null;
  return { provider: 'antigravity', id: fresh[0].id };
}

function realOrResolve(dir) {
  if (!dir || typeof dir !== 'string') return null;
  try {
    return realpathSync(dir);
  } catch {
    return path.resolve(dir);
  }
}

function primaryRepoRootFor(cwd, env = process.env) {
  if (!cwd) return null;
  try {
    const commonDir = execFileSync('git', ['-C', cwd, 'rev-parse', '--path-format=absolute', '--git-common-dir'], {
      env,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 5_000,
    }).trim();
    const realCommon = realOrResolve(commonDir);
    if (realCommon && path.basename(realCommon) === '.git') {
      return realOrResolve(path.dirname(realCommon));
    }
  } catch { /* not a git checkout */ }
  return null;
}

export function discoverOpencodeTranscript(home, { cwd = null, now = Date.now(), maxAgeMs = 60_000, env = null } = {}) {
  const explicitId = typeof env?.OPENCODE_SESSION_ID === 'string' && env.OPENCODE_SESSION_ID.trim()
    ? env.OPENCODE_SESSION_ID.trim()
    : null;
  if (explicitId) return { provider: 'opencode', id: explicitId };
  const explicitDb = typeof env?.OPENCODE_DB_PATH === 'string' && env.OPENCODE_DB_PATH.trim()
    ? path.resolve(env.OPENCODE_DB_PATH.trim())
    : null;
  const dataHome = typeof env?.XDG_DATA_HOME === 'string' && env.XDG_DATA_HOME.trim()
    ? path.resolve(env.XDG_DATA_HOME.trim())
    : (home ? path.join(home, '.local', 'share') : null);
  const dbPath = explicitDb ?? (dataHome ? path.join(dataHome, 'opencode', 'opencode.db') : null);
  if (!dbPath || !existsSync(dbPath)) return null;

  let db;
  try {
    const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite');
    db = new DatabaseSync(dbPath, { readOnly: true });
    const tables = new Set(
      db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((r) => r.name),
    );
    const sessionTable = tables.has('session_v2') ? 'session_v2' : (tables.has('session') ? 'session' : null);
    if (!sessionTable) return null;
    const hasMessages = tables.has('session_message');
    const hasWorktrees = tables.has('worktree');

    const rows = db.prepare(
      `SELECT s.id, s.project_id, s.parent_id, s.directory, s.time_created, s.time_updated, s.time_busy, s.time_idle, s.time_archived${
        hasMessages ? ', (SELECT MAX(m.time_updated) FROM session_message m WHERE m.session_id = s.id) AS last_msg_updated' : ''
      } FROM ${sessionTable} s WHERE s.time_archived IS NULL AND s.parent_id IS NULL ORDER BY s.time_updated DESC LIMIT 50`,
    ).all();
    if (!Array.isArray(rows) || rows.length === 0) return null;

    const worktreesByProject = new Map();
    if (hasWorktrees) {
      for (const wt of db.prepare('SELECT project_id, directory FROM worktree').all()) {
        if (!wt?.project_id || !wt?.directory) continue;
        const list = worktreesByProject.get(wt.project_id) ?? [];
        list.push(realOrResolve(wt.directory));
        worktreesByProject.set(wt.project_id, list);
      }
    }

    const msgStmt = hasMessages
      ? db.prepare('SELECT data FROM session_message WHERE session_id = ? ORDER BY time_updated DESC LIMIT 5')
      : null;

    const candidates = rows.map((row) => {
      const timeBusy = Number(row.time_busy) || 0;
      const timeIdle = Number(row.time_idle) || 0;
      const lastMod = Math.max(Number(row.time_updated) || 0, Number(row.last_msg_updated) || 0);
      const isBusy = timeBusy > 0 && (!timeIdle || timeBusy >= timeIdle) && (now - timeBusy <= 30 * 60_000) && (timeBusy - now <= 60_000);
      const isRecent = lastMod > 0 && (now - lastMod <= maxAgeMs) && (lastMod - now <= 60_000);
      return {
        id: String(row.id),
        projectId: row.project_id ? String(row.project_id) : null,
        sessionDir: realOrResolve(row.directory),
        isBusy,
        isRecent,
        lastMod,
      };
    });

    const fresh = candidates.filter((c) => c.isBusy || c.isRecent);
    if (fresh.length === 0) return null;

    if (cwd) {
      const realCwd = realOrResolve(cwd);
      const primaryRepo = primaryRepoRootFor(cwd, env ?? process.env);
      const evaluated = fresh.map((c) => {
        const wts = (c.projectId && worktreesByProject.get(c.projectId)) || [];
        const exactDir = Boolean(
          (c.sessionDir && (c.sessionDir === realCwd || (primaryRepo && c.sessionDir === primaryRepo)))
          || wts.some((wt) => wt === realCwd || (primaryRepo && wt === primaryRepo)),
        );
        let mentionsCwd = false;
        if (msgStmt) {
          const msgs = msgStmt.all(c.id);
          const recentText = msgs.map((m) => String(m?.data ?? '')).join('\n');
          mentionsCwd = textMentionsPath(recentText, realCwd) || (realCwd !== cwd && textMentionsPath(recentText, cwd));
        }
        return { ...c, exactDir, mentionsCwd };
      });

      const matched = evaluated.filter((c) => c.exactDir || c.mentionsCwd);
      if (matched.length === 1) return { provider: 'opencode', id: matched[0].id };
      if (matched.length > 1) {
        const byMention = matched.filter((c) => c.mentionsCwd);
        if (byMention.length === 1) return { provider: 'opencode', id: byMention[0].id };
        const byBusy = matched.filter((c) => c.isBusy);
        if (byBusy.length === 1) return { provider: 'opencode', id: byBusy[0].id };
        const byExact = matched.filter((c) => c.exactDir);
        if (byExact.length === 1) return { provider: 'opencode', id: byExact[0].id };
      }
      return null;
    }

    if (fresh.length === 1) return { provider: 'opencode', id: fresh[0].id };
    const busyOnly = fresh.filter((c) => c.isBusy);
    if (busyOnly.length === 1) return { provider: 'opencode', id: busyOnly[0].id };
    return null;
  } catch {
    return null;
  } finally {
    try { db?.close(); } catch { /* ignore */ }
  }
}

// Where this conversation's id comes from when no flag names it (#1275):
// the harness's own environment, then the lifecycle hook payload's session
// id, then (Devin only) a session list naming exactly one session for this
// worktree, Antigravity's most recently updated brain transcript, or
// OpenCode's active session in opencode.db.
export async function findTranscript({
  env = process.env,
  cwd = process.cwd(),
  home = env.HOME ?? (env === process.env ? homedir() : null),
  listDevinSessionsImpl = listDevinSessions,
} = {}) {
  const native = discoverTranscript(env);
  if (native) return native;
  const harness = detectHarness(env);
  if (env.AGENT_HOOK_SESSION_ID) {
    return { provider: harness ?? env.AGENT_HOOK_HARNESS ?? 'custom', id: env.AGENT_HOOK_SESSION_ID };
  }
  if (harness === 'devin') {
    const ids = await listDevinSessionsImpl(cwd, env);
    if (Array.isArray(ids) && ids.length === 1) return { provider: 'devin', id: ids[0] };
  }
  if (harness === 'antigravity') {
    const found = discoverAntigravityTranscript(home, { cwd, env });
    if (found) return found;
  }
  if (harness === 'opencode') {
    const found = discoverOpencodeTranscript(home, { cwd, env });
    if (found) return found;
  }
  return null;
}

export function parseSessionBindArgs(argv = []) {
  const options = { help: false, json: false, transcriptId: null, provider: null, parentAgentId: null };
  if (argv.length === 0 || argv[0] !== 'bind') throw new Error(SESSION_BIND_USAGE.trimEnd());
  for (let i = 1; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') options.help = true;
    else if (arg === '--json') options.json = true;
    else if (arg === '--transcript-id' || arg === '--provider' || arg === '--parent-agent-id') {
      const value = argv[i + 1];
      if (!value || value.startsWith('--')) throw new Error(`${arg} requires a value`);
      if (arg === '--transcript-id') options.transcriptId = value;
      if (arg === '--provider') options.provider = value;
      if (arg === '--parent-agent-id') options.parentAgentId = value;
      i += 1;
    } else {
      throw new Error(`unknown option: ${arg}`);
    }
  }
  return options;
}

function gitDirFor(cwd) {
  return execFileSync('git', ['rev-parse', '--absolute-git-dir'], {
    cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
  }).trim();
}

function claimedApp(env, cwd) {
  try { return resolveAgentSlug({ env, cwd, detect: false }); } catch { return null; }
}

function repin(cwd, key, value) {
  execFileSync('git', ['config', 'extensions.worktreeConfig', 'true'], { cwd });
  execFileSync('git', ['config', '--worktree', key, value], { cwd });
}

export async function sessionBind({
  cwd = process.cwd(),
  env = process.env,
  transcriptId = null,
  provider = null,
  parentAgentId = null,
  clientFactory = async (options) => daemonClient(options),
  readBindingImpl = readBinding,
  readBindTokenImpl = readBindToken,
  gitDirImpl = gitDirFor,
  resolveSlugImpl = claimedApp,
  repinImpl = repin,
  findTranscriptImpl = findTranscript,
} = {}) {
  const client = await clientFactory({ env, home: env.HOME, cwd });

  let existing = null;
  try {
    existing = readBindingImpl({ env, cwd });
  } catch {
    throw new Error('the soul binding in this checkout is unreadable — run `agent-bot doctor`, then `agent-bot setup-worktree` if it is corrupt');
  }
  if (existing) {
    // Already bound: validate at the daemon (no secret leaves this process),
    // then reconcile a differently selected App exactly as MCP bind does —
    // a binding outlives its session, so a session run as another App
    // reconciles here as a first bind would (#107). Without this the daemon
    // keeps minting the previously recorded App and the newly selected slug
    // is refused as an identity crossover. When a restarted daemon rejects
    // the stale binding secret (403) and `setup-worktree` has minted a fresh
    // bind token, fall through to surrender that token (#1179).
    let binding = null;
    try {
      binding = await client.binding(existing.secret);
    } catch (error) {
      if (error?.statusCode !== 403) throw error;
      let hasFreshToken = false;
      try { hasFreshToken = Boolean(readBindTokenImpl(gitDirImpl(cwd))); } catch { hasFreshToken = false; }
      if (!hasFreshToken) {
        throw new Error(
          'the daemon rejected this worktree\'s existing binding (it may have restarted) — '
          + 'run `agent-bot setup-worktree` to mint a fresh bind token, then re-run `agent-bot session bind`',
        );
      }
    }
    if (binding) {
      const result = {
        status: 'live',
        alreadyBound: true,
        agentId: binding.agentId,
        worktree: binding.worktree ?? cwd,
      };
      const claimed = resolveSlugImpl(env, cwd);
      if (claimed && typeof client.reconcileApp === 'function') {
        let app = null;
        try { ({ app = null } = await client.reconcileApp(existing.secret, claimed)); } catch { /* record unchanged */ }
        if (app) {
          result.app = app.status === 'reconciled'
            ? (repinImpl(cwd, 'agentBot.app', app.claimed),
              { ...app, next: 'run agent-bot setup-worktree in this checkout to commit as the reconciled App' })
            : app;
        }
      }
      return result;
    }
  }

  let transcript = transcriptId
    ? { provider: provider ?? detectAgentHarness(env) ?? 'custom', id: transcriptId }
    : await findTranscriptImpl({ env, cwd });
  if (!transcript) throw new Error(NO_TRANSCRIPT);
  if (provider) transcript = { ...transcript, provider };
  const gitDir = gitDirImpl(cwd);
  const record = readBindTokenImpl(gitDir);
  if (!record) {
    throw new Error('no bind token is minted for this worktree — run `agent-bot setup-worktree` first');
  }
  const result = await client.bind({
    gitDir,
    token: record.token,
    transcript,
    parentId: parentAgentId,
    app: resolveSlugImpl(env, cwd),
    expectedAgentId: env.AGENT_BOT_ID ?? env.QWTS_AGENT_ID ?? null,
  });
  // The daemon may repin attribution; mirror the MCP tool's follow-up.
  if (result.repinRequired) repinImpl(cwd, 'agentBot.agentId', result.agentId);
  if (result.app?.status === 'reconciled') repinImpl(cwd, 'agentBot.app', result.app.claimed);
  const { secret, ...safe } = result;
  return { status: 'live', alreadyBound: false, ...safe };
}

export async function main(argv = process.argv.slice(2)) {
  const options = parseSessionBindArgs(argv);
  if (options.help) {
    process.stdout.write(SESSION_BIND_USAGE);
    return;
  }
  const result = await sessionBind(options);
  if (options.json) {
    process.stdout.write(`${JSON.stringify({ schema_version: 1, command: 'session bind', ...result })}\n`);
  } else if (result.alreadyBound) {
    process.stdout.write(`live session binding: present (agent ${result.agentId})\n`);
  } else {
    process.stdout.write(`live session binding: established (agent ${result.agentId})\n`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(`session bind: ${error.message}\n`);
    process.exit(1);
  });
}
