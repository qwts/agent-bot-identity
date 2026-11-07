#!/usr/bin/env node

// Sanctioned CLI path to a live session binding for harnesses without
// MCP `bind` (#1170). It performs the same surrender as the MCP tool:
// read this worktree's single-use bind token, exchange it at the daemon,
// and report only the resulting identity. The binding secret stays in
// the private git dir (written by the daemon) and is never printed.

import { execFileSync } from 'node:child_process';
import { closeSync, existsSync, openSync, readFileSync, readSync, readdirSync, realpathSync, statSync } from 'node:fs';
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

function primaryRepoRootFor(cwd) {
  if (!cwd) return null;
  let dir = realOrResolve(cwd);
  for (let depth = 0; depth < 32 && dir; depth += 1) {
    const dotGit = path.join(dir, '.git');
    try {
      const st = statSync(dotGit);
      if (st.isDirectory()) return dir;
      if (st.isFile()) {
        const text = readFileSync(dotGit, 'utf8');
        const m = /^gitdir:\s*(.+)$/m.exec(text);
        if (m) {
          const gitDir = realOrResolve(path.resolve(dir, m[1].trim()));
          const marker = `${path.sep}.git${path.sep}worktrees${path.sep}`;
          const idx = gitDir.indexOf(marker);
          if (idx > 0) return realOrResolve(gitDir.slice(0, idx));
        }
      }
    } catch { /* keep walking up */ }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

function readSqliteVarint(buf, offset) {
  let val = 0n;
  for (let i = 0; i < 9; i += 1) {
    const b = buf[offset + i];
    if (b === undefined) return [0, offset + 1];
    if (i === 8) {
      val = (val << 8n) | BigInt(b);
      return [Number(val), offset + 9];
    }
    val = (val << 7n) | BigInt(b & 0x7f);
    if ((b & 0x80) === 0) return [Number(val), offset + i + 1];
  }
  return [Number(val), offset + 9];
}

function readSqliteSerialValue(buf, offset, serialType) {
  if (serialType === 0) return [null, offset];
  if (serialType === 8) return [0, offset];
  if (serialType === 9) return [1, offset];
  if (serialType === 10 || serialType === 11) {
    throw new Error(`unsupported SQLite reserved serial type: ${serialType}`);
  }
  if (serialType >= 1 && serialType <= 6) {
    const lens = [0, 1, 2, 3, 4, 6, 8];
    const len = lens[serialType];
    let v = BigInt(buf.readInt8(offset));
    for (let i = 1; i < len; i += 1) v = (v << 8n) | BigInt(buf[offset + i]);
    return [Number(v), offset + len];
  }
  if (serialType === 7) return [buf.readDoubleBE(offset), offset + 8];
  if (serialType >= 12) {
    const len = Math.floor((serialType - (serialType % 2 === 0 ? 12 : 13)) / 2);
    const slice = buf.subarray(offset, offset + len);
    return [serialType % 2 === 1 ? slice.toString('utf8') : slice, offset + len];
  }
  return [null, offset];
}

function parseCreateTableColumns(sql) {
  if (typeof sql !== 'string') return [];
  const open = sql.indexOf('(');
  const close = sql.lastIndexOf(')');
  if (open < 0 || close <= open) return [];
  const inner = sql.slice(open + 1, close);
  const parts = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < inner.length; i += 1) {
    const ch = inner[i];
    if (ch === '(') depth += 1;
    else if (ch === ')') depth = Math.max(0, depth - 1);
    else if (ch === ',' && depth === 0) {
      parts.push(inner.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(inner.slice(start));
  const cols = [];
  for (const raw of parts) {
    const trimmed = raw.trim();
    if (!trimmed || /^(?:CONSTRAINT|PRIMARY\s+KEY|FOREIGN\s+KEY|UNIQUE|CHECK)\b/i.test(trimmed)) continue;
    const m = /^[`"'[]?([A-Za-z_][A-Za-z0-9_]*)[`"'\]]?/.exec(trimmed);
    if (m) cols.push(m[1]);
  }
  return cols;
}

const MAX_SQLITE_DB_BYTES = 64 * 1024 * 1024;
const MAX_SQLITE_WAL_BYTES = 32 * 1024 * 1024;

function walChecksum(buf, start, end, s0, s1, bigEndian) {
  let c0 = s0 >>> 0;
  let c1 = s1 >>> 0;
  for (let i = start; i + 8 <= end; i += 8) {
    const w0 = bigEndian ? buf.readUInt32BE(i) : buf.readUInt32LE(i);
    const w1 = bigEndian ? buf.readUInt32BE(i + 4) : buf.readUInt32LE(i + 4);
    c0 = (c0 + w0 + c1) >>> 0;
    c1 = (c1 + w1 + c0) >>> 0;
  }
  return [c0, c1];
}

// Node-20-compatible pure-JS SQLite3 B-tree + WAL reader for when node:sqlite
// is unavailable on older Node 20 runtimes (#1362).
export function readOpencodeSqliteFromBuffer(dbPath) {
  const dbStat = statSync(dbPath);
  if (!dbStat.isFile() || dbStat.size < 100 || dbStat.size > MAX_SQLITE_DB_BYTES) return null;
  const raw = readFileSync(dbPath);
  if (raw.length < 100 || raw.subarray(0, 16).toString('utf8') !== 'SQLite format 3\0') return null;
  let pageSize = raw.readUInt16BE(16);
  if (pageSize === 1) pageSize = 65536;
  if (pageSize < 512) return null;
  const reserved = raw[20] || 0;
  const usableSize = pageSize - reserved;
  const pages = new Map();
  const totalPages = Math.floor(raw.length / pageSize);
  for (let p = 1; p <= totalPages; p += 1) {
    pages.set(p, raw.subarray((p - 1) * pageSize, p * pageSize));
  }
  const walPath = `${dbPath}-wal`;
  if (existsSync(walPath)) {
    try {
      const walStat = statSync(walPath);
      if (walStat.isFile() && walStat.size >= 32 && walStat.size <= MAX_SQLITE_WAL_BYTES) {
        const wal = readFileSync(walPath);
        const magic = wal.readUInt32BE(0);
        const version = wal.readUInt32BE(4);
        if ((magic === 0x377f0682 || magic === 0x377f0683) && version === 3007000) {
          const bigEndian = magic === 0x377f0683;
          let [s0, s1] = walChecksum(wal, 0, 24, 0, 0, bigEndian);
          const hdrCk0 = wal.readUInt32BE(24);
          const hdrCk1 = wal.readUInt32BE(28);
          let walPageSize = wal.readUInt32BE(8) || pageSize;
          if (walPageSize === 1) walPageSize = 65536;
          const salt1 = wal.readUInt32BE(16);
          const salt2 = wal.readUInt32BE(20);
          if (walPageSize === pageSize && s0 === hdrCk0 && s1 === hdrCk1) {
            const pendingPages = new Map();
            for (let off = 32; off + 24 + pageSize <= wal.length; off += 24 + pageSize) {
              const pgno = wal.readUInt32BE(off);
              const dbSizeAfterCommit = wal.readUInt32BE(off + 4);
              const frameSalt1 = wal.readUInt32BE(off + 8);
              const frameSalt2 = wal.readUInt32BE(off + 12);
              if (frameSalt1 !== salt1 || frameSalt2 !== salt2) break;
              [s0, s1] = walChecksum(wal, off, off + 8, s0, s1, bigEndian);
              [s0, s1] = walChecksum(wal, off + 24, off + 24 + pageSize, s0, s1, bigEndian);
              if (s0 !== wal.readUInt32BE(off + 16) || s1 !== wal.readUInt32BE(off + 20)) break;
              if (pgno >= 1) pendingPages.set(pgno, wal.subarray(off + 24, off + 24 + pageSize));
              if (dbSizeAfterCommit > 0) {
                for (const [k, v] of pendingPages) pages.set(k, v);
                for (const k of pages.keys()) if (k > dbSizeAfterCommit) pages.delete(k);
                pendingPages.clear();
              }
            }
          }
        }
      }
    } catch { /* ignore unreadable wal */ }
  }
  const getPage = (pgno) => pages.get(pgno) || null;
  const maxPayloadBytes = Math.min(4 * 1024 * 1024, Math.max(pageSize, pages.size * pageSize));
  const readPayload = (page, cellOffset, payloadSize, isLeaf) => {
    if (!Number.isInteger(payloadSize) || payloadSize < 0 || payloadSize > maxPayloadBytes) {
      throw new Error('SQLite cell payload exceeds bounds');
    }
    const maxLocal = isLeaf ? usableSize - 35 : Math.floor(((usableSize - 12) * 64) / 255) - 23;
    const minLocal = Math.floor(((usableSize - 12) * 32) / 255) - 23;
    if (payloadSize <= maxLocal) return page.subarray(cellOffset, cellOffset + payloadSize);
    let localSize = minLocal + ((payloadSize - minLocal) % (usableSize - 4));
    if (localSize > maxLocal) localSize = minLocal;
    const out = Buffer.alloc(payloadSize);
    page.copy(out, 0, cellOffset, cellOffset + localSize);
    let written = localSize;
    let nextPg = page.readUInt32BE(cellOffset + localSize);
    let guard = 0;
    while (nextPg > 0 && written < payloadSize && guard < 1024) {
      guard += 1;
      const ovf = getPage(nextPg);
      if (!ovf) break;
      nextPg = ovf.readUInt32BE(0);
      const chunk = Math.min(payloadSize - written, usableSize - 4);
      ovf.copy(out, written, 4, 4 + chunk);
      written += chunk;
    }
    return out;
  };
  const decodeRecord = (payload) => {
    const [hdrLen, pos0] = readSqliteVarint(payload, 0);
    const serials = [];
    let pos = pos0;
    while (pos < hdrLen && pos < payload.length) {
      const [st, next] = readSqliteVarint(payload, pos);
      serials.push(st);
      pos = next;
    }
    let bodyPos = hdrLen;
    const values = [];
    for (const st of serials) {
      const [val, next] = readSqliteSerialValue(payload, bodyPos, st);
      values.push(val);
      bodyPos = next;
    }
    return values;
  };
  const scanTable = (rootPgno, out = [], seen = new Set(), depth = 0) => {
    if (!rootPgno || depth > 16 || seen.size > 4096 || seen.has(rootPgno)) return out;
    seen.add(rootPgno);
    const page = getPage(rootPgno);
    if (!page) return out;
    const hdrOff = rootPgno === 1 ? 100 : 0;
    const pageType = page[hdrOff];
    const cellCount = page.readUInt16BE(hdrOff + 3);
    if (pageType === 0x0d) {
      for (let i = 0; i < cellCount; i += 1) {
        try {
          const ptr = page.readUInt16BE(hdrOff + 8 + i * 2);
          const [payloadSize, p1] = readSqliteVarint(page, ptr);
          const [, p2] = readSqliteVarint(page, p1);
          const payload = readPayload(page, p2, payloadSize, true);
          out.push(decodeRecord(payload));
        } catch { /* skip corrupt row */ }
      }
    } else if (pageType === 0x05) {
      for (let i = 0; i < cellCount; i += 1) {
        const ptr = page.readUInt16BE(hdrOff + 12 + i * 2);
        const leftChild = page.readUInt32BE(ptr);
        scanTable(leftChild, out, seen, depth + 1);
      }
      const rightChild = page.readUInt32BE(hdrOff + 8);
      scanTable(rightChild, out, seen, depth + 1);
    }
    return out;
  };
  const masterRows = scanTable(1);
  const tables = new Map();
  for (const vals of masterRows) {
    const [type, name, , rootpage, sql] = vals;
    if (type === 'table' && typeof name === 'string') {
      tables.set(name, { rootpage: Number(rootpage), columns: parseCreateTableColumns(sql) });
    }
  }
  const readNamedTable = (tableName) => {
    const meta = tables.get(tableName);
    if (!meta || !meta.rootpage) return [];
    const cols = meta.columns;
    return scanTable(meta.rootpage).map((vals) => {
      const obj = {};
      for (let i = 0; i < cols.length; i += 1) obj[cols[i]] = vals[i] ?? null;
      return obj;
    });
  };
  const sessionTable = tables.has('session_v2') ? 'session_v2' : (tables.has('session') ? 'session' : null);
  if (!sessionTable) return null;
  const rawSessions = readNamedTable(sessionTable);
  const rawMessages = tables.has('session_message') ? readNamedTable('session_message') : [];
  const rawWorktrees = tables.has('worktree') ? readNamedTable('worktree') : [];

  const msgsBySession = new Map();
  for (const m of rawMessages) {
    if (!m?.session_id) continue;
    const list = msgsBySession.get(m.session_id) ?? [];
    list.push({ time_updated: Number(m.time_updated) || 0, data: String(m.data ?? '') });
    msgsBySession.set(m.session_id, list);
  }
  for (const list of msgsBySession.values()) {
    list.sort((a, b) => b.time_updated - a.time_updated);
  }
  const rows = rawSessions
    .filter((s) => s && s.id && (s.time_archived === null || s.time_archived === undefined) && (s.parent_id === null || s.parent_id === undefined))
    .map((s) => {
      const msgs = msgsBySession.get(s.id) ?? [];
      return {
        ...s,
        last_msg_updated: msgs[0]?.time_updated ?? 0,
      };
    })
    .sort((a, b) => (Number(b.time_updated) || 0) - (Number(a.time_updated) || 0))
    .slice(0, 50);

  const worktreesByProject = new Map();
  for (const wt of rawWorktrees) {
    if (!wt?.project_id || !wt?.directory) continue;
    const list = worktreesByProject.get(wt.project_id) ?? [];
    list.push(realOrResolve(wt.directory));
    worktreesByProject.set(wt.project_id, list);
  }
  return {
    rows,
    worktreesByProject,
    getRecentMessages: (sessionId) => (msgsBySession.get(sessionId) ?? []).slice(0, 5),
  };
}

function readOpencodeSqlite(dbPath, { forceBufferReader = false } = {}) {
  if (!forceBufferReader) {
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

      const worktreesByProject = new Map();
      if (hasWorktrees) {
        for (const wt of db.prepare('SELECT project_id, directory FROM worktree').all()) {
          if (!wt?.project_id || !wt?.directory) continue;
          const list = worktreesByProject.get(wt.project_id) ?? [];
          list.push(realOrResolve(wt.directory));
          worktreesByProject.set(wt.project_id, list);
        }
      }

      const msgsBySession = new Map();
      if (hasMessages && Array.isArray(rows) && rows.length > 0) {
        const msgStmt = db.prepare('SELECT data FROM session_message WHERE session_id = ? ORDER BY time_updated DESC LIMIT 5');
        for (const r of rows) {
          msgsBySession.set(r.id, msgStmt.all(r.id));
        }
      }
      return {
        rows: Array.isArray(rows) ? rows : [],
        worktreesByProject,
        getRecentMessages: (sessionId) => msgsBySession.get(sessionId) ?? [],
      };
    } catch {
      // Fall through to pure-JS SQLite3 B-tree reader (Node 20 compatibility).
    } finally {
      try { db?.close(); } catch { /* ignore */ }
    }
  }
  try {
    return readOpencodeSqliteFromBuffer(dbPath);
  } catch {
    return null;
  }
}

function readOpencodeStorageSessions(dataHome) {
  if (!dataHome) return null;
  const sessionRoot = path.join(dataHome, 'opencode', 'storage', 'session');
  if (!existsSync(sessionRoot)) return null;
  const messageRoot = path.join(dataHome, 'opencode', 'storage', 'message');
  const rows = [];
  const collectJsonFiles = (dir, depth = 0) => {
    if (depth > 2) return [];
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return []; }
    const files = [];
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) files.push(...collectJsonFiles(full, depth + 1));
      else if (entry.isFile() && entry.name.endsWith('.json')) files.push(full);
    }
    return files;
  };
  for (const file of collectJsonFiles(sessionRoot).slice(0, 200)) {
    try {
      const st = statSync(file);
      if (!st.isFile() || st.size > 2 * 1024 * 1024) continue;
      const parsed = JSON.parse(readFileSync(file, 'utf8'));
      const id = parsed?.id;
      if (typeof id !== 'string' || !id.trim()) continue;
      const parentId = parsed.parentID ?? parsed.parent_id ?? null;
      const archived = parsed.time?.archived ?? parsed.time_archived ?? null;
      if (parentId || archived) continue;
      const timeCreated = Number(parsed.time?.created ?? parsed.time_created) || Math.floor(st.mtimeMs);
      const timeUpdated = Number(parsed.time?.updated ?? parsed.time_updated) || Math.floor(st.mtimeMs);
      const timeBusy = Number(parsed.time?.busy ?? parsed.time_busy ?? 0) || null;
      const timeIdle = Number(parsed.time?.idle ?? parsed.time_idle ?? 0) || null;
      rows.push({
        id: id.trim(),
        project_id: parsed.projectID ?? parsed.project_id ?? null,
        parent_id: null,
        directory: parsed.directory ?? parsed.path?.cwd ?? parsed.cwd ?? null,
        time_created: timeCreated,
        time_updated: timeUpdated,
        time_busy: timeBusy,
        time_idle: timeIdle,
        time_archived: null,
        last_msg_updated: 0,
      });
    } catch { /* ignore malformed session file */ }
  }
  if (rows.length === 0) return null;
  rows.sort((a, b) => (Number(b.time_updated) || 0) - (Number(a.time_updated) || 0));
  const getRecentMessages = (sessionId) => {
    const dir = path.join(messageRoot, sessionId);
    if (!existsSync(dir)) return [];
    try {
      return readdirSync(dir)
        .filter((f) => f.endsWith('.json'))
        .slice(-5)
        .map((f) => ({ data: readFileSync(path.join(dir, f), 'utf8') }));
    } catch {
      return [];
    }
  };
  return {
    rows: rows.slice(0, 50),
    worktreesByProject: new Map(),
    getRecentMessages,
  };
}

function selectOpencodeCandidate({ rows, worktreesByProject, getRecentMessages, cwd, now, maxAgeMs }) {
  if (!Array.isArray(rows) || rows.length === 0) return null;
  const candidates = rows.map((row) => {
    const timeBusy = Number(row.time_busy) || 0;
    const timeIdle = Number(row.time_idle) || 0;
    const lastMod = Math.max(Number(row.time_updated) || 0, Number(row.last_msg_updated) || 0);
    const isBusy = timeBusy > 0 && (!timeIdle || timeBusy >= timeIdle) && (now - timeBusy <= 30 * 60_000) && (timeBusy - now <= 60_000);
    const isRecent = lastMod > 0 && (now - lastMod <= maxAgeMs) && (lastMod - now <= 60_000);
    return {
      id: String(row.id),
      projectId: row.project_id ? String(row.project_id) : null,
      sessionDir: row.directory ? realOrResolve(row.directory) : null,
      isBusy,
      isRecent,
      lastMod,
    };
  });

  const fresh = candidates.filter((c) => c.isBusy || c.isRecent);
  if (fresh.length === 0) return null;

  if (cwd) {
    const realCwd = realOrResolve(cwd);
    const primaryRepo = primaryRepoRootFor(cwd);
    const evaluated = fresh.map((c) => {
      const wts = (c.projectId && worktreesByProject.get(c.projectId)) || [];
      let mentionsCwd = false;
      const msgDirs = [];
      if (typeof getRecentMessages === 'function') {
        const msgs = getRecentMessages(c.id);
        for (const m of msgs) {
          const rawData = String(m?.data ?? '');
          try {
            const parsed = JSON.parse(rawData);
            if (typeof parsed?.path?.cwd === 'string' && parsed.path.cwd) msgDirs.push(realOrResolve(parsed.path.cwd));
            if (typeof parsed?.path?.root === 'string' && parsed.path.root) msgDirs.push(realOrResolve(parsed.path.root));
          } catch { /* ignore non-JSON message payload */ }
        }
        const recentText = msgs.map((m) => String(m?.data ?? '')).join('\n');
        mentionsCwd = textMentionsPath(recentText, realCwd) || (realCwd !== cwd && textMentionsPath(recentText, cwd));
      }
      const directDir = Boolean(
        (c.sessionDir && c.sessionDir === realCwd)
        || wts.some((wt) => wt === realCwd)
        || msgDirs.some((d) => d === realCwd),
      );
      const exactDir = Boolean(
        directDir
        || (primaryRepo && c.sessionDir === primaryRepo)
        || (primaryRepo && wts.some((wt) => wt === primaryRepo))
        || (primaryRepo && msgDirs.some((d) => d === primaryRepo)),
      );
      return { ...c, directDir, exactDir, mentionsCwd };
    });

    // Fail closed: require an exact directory / worktree / structured message.path match.
    // Message text mentions and busy state only disambiguate among exact matches.
    const matched = evaluated.filter((c) => c.exactDir);
    if (matched.length === 1) return { provider: 'opencode', id: matched[0].id };
    if (matched.length > 1) {
      const byDirect = matched.filter((c) => c.directDir);
      if (byDirect.length === 1) return { provider: 'opencode', id: byDirect[0].id };
      const byMention = matched.filter((c) => c.mentionsCwd);
      if (byMention.length === 1) return { provider: 'opencode', id: byMention[0].id };
      const byBusy = matched.filter((c) => c.isBusy);
      if (byBusy.length === 1) return { provider: 'opencode', id: byBusy[0].id };
    }
    return null;
  }

  if (fresh.length === 1) return { provider: 'opencode', id: fresh[0].id };
  const busyOnly = fresh.filter((c) => c.isBusy);
  if (busyOnly.length === 1) return { provider: 'opencode', id: busyOnly[0].id };
  return null;
}

export function discoverOpencodeTranscript(home, { cwd = null, now = Date.now(), maxAgeMs = 60_000, env = null, forceBufferReader = false } = {}) {
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
  if (dbPath && existsSync(dbPath)) {
    const sqliteData = readOpencodeSqlite(dbPath, { forceBufferReader });
    if (sqliteData) {
      const found = selectOpencodeCandidate({ ...sqliteData, cwd, now, maxAgeMs });
      if (found) return found;
    }
  }
  const storageData = readOpencodeStorageSessions(dataHome);
  if (storageData) {
    return selectOpencodeCandidate({ ...storageData, cwd, now, maxAgeMs });
  }
  return null;
}

export function discoverZcodeTranscript(home, { cwd = null, now = Date.now(), maxAgeMs = 60_000, env = null, forceBufferReader = false } = {}) {
  const explicitId = typeof env?.ZCODE_SESSION_ID === 'string' && env.ZCODE_SESSION_ID.trim()
    ? env.ZCODE_SESSION_ID.trim()
    : null;
  if (explicitId) return { provider: 'zcode', id: explicitId };
  const explicitDb = typeof env?.ZCODE_DB_PATH === 'string' && env.ZCODE_DB_PATH.trim()
    ? path.resolve(env.ZCODE_DB_PATH.trim())
    : null;
  const dbPath = explicitDb ?? (home ? path.join(home, '.zcode', 'cli', 'db', 'db.sqlite') : null);
  if (dbPath && existsSync(dbPath)) {
    const sqliteData = readOpencodeSqlite(dbPath, { forceBufferReader });
    if (sqliteData) {
      const projectDir = typeof env?.ZCODE_PROJECT_DIR === 'string' && env.ZCODE_PROJECT_DIR.trim()
        ? env.ZCODE_PROJECT_DIR.trim()
        : null;
      const found = selectOpencodeCandidate({ ...sqliteData, cwd: cwd ?? projectDir, now, maxAgeMs })
        ?? (cwd && projectDir && projectDir !== cwd
          ? selectOpencodeCandidate({ ...sqliteData, cwd: projectDir, now, maxAgeMs })
          : null);
      if (found) return { provider: 'zcode', id: found.id };
    }
  }
  return null;
}

// Where this conversation's id comes from when no flag names it (#1275):
// the harness's own environment, then the lifecycle hook payload's session
// id, then (Devin only) a session list naming exactly one session for this
// worktree, Antigravity's most recently updated brain transcript,
// OpenCode's active session in opencode.db, or ZCode's active session in
// ~/.zcode/cli/db/db.sqlite.
export async function findTranscript({
  env = process.env,
  cwd = process.cwd(),
  home = env.HOME ?? (env === process.env ? homedir() : null),
  listDevinSessionsImpl = listDevinSessions,
} = {}) {
  let detectedHarness;
  const getHarness = () => (detectedHarness === undefined ? (detectedHarness = detectHarness(env)) : detectedHarness);
  const native = discoverTranscript(env);
  if (native) {
    if (native.provider === 'claude' && getHarness() === 'zcode') {
      return { provider: 'zcode', id: native.id };
    }
    return native;
  }
  const harness = getHarness();
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
  if (harness === 'zcode') {
    const found = discoverZcodeTranscript(home, { cwd, env });
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
      const expectedAgentId = env.AGENT_BOT_ID || env.QWTS_AGENT_ID || null;
      if (expectedAgentId && binding.agentId && binding.agentId !== expectedAgentId) {
        throw new Error(
          `this worktree is bound to ${binding.agentId}, which does not match expected Agent ID ${expectedAgentId}`,
        );
      }
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
    expectedAgentId: env.AGENT_BOT_ID || env.QWTS_AGENT_ID || null,
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
