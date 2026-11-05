import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseAgentBotArgs } from '../cli/parse.mjs';
import { helpText } from '../cli/output.mjs';
import { createDaemonServer } from '../agent-daemon.mjs';
import { discoverAntigravityTranscript, discoverOpencodeTranscript, findTranscript } from '../session-bind.mjs';
import { START_USAGE, formatStartReceipt, parseStartArgs, startTask } from '../start.mjs';
import { hermeticGitEnv } from './helpers/hermetic-git.mjs';
import { worktreeSoul } from './helpers/worktree-soul.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const CLI = path.join(ROOT, 'agent-bot.mjs');

function makeFixture(t, { harness = 'codex', serverMode = false, deviceHarnesses = null, createSoul = true, appSlug = undefined } = {}) {
  const home = realpathSync(mkdtempSync(path.join(tmpdir(), 'start-test-')));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const stateDir = path.join(home, 'state');
  const serverStateDir = path.join(home, 'server-state');
  mkdirSync(stateDir, { recursive: true });
  mkdirSync(serverStateDir, { recursive: true });

  const env = hermeticGitEnv({}, {
    HOME: home,
    PATH: process.env.PATH,
    AGENT_BOT_ACCOUNT: 'owner',
    AGENT_BOT_CONFIG: path.join(home, 'config.json'),
    AGENT_BOT_STATE_HOME: stateDir,
    AGENT_BOT_SERVER_STATE: serverStateDir,
    AGENT_BOT_POPULATION_PATH: path.join(home, 'population.json'),
    AGENT_BOT_SOULS_HOME: path.join(home, 'souls'),
    AGENT_BOT_SPACES_HOME: path.join(home, 'spaces'),
    ...(serverMode ? { AGENT_BOT_SERVER: 'https://agents.true-line.ai' } : {}),
  });

  const config = {
    prefix: 'test',
    apps: { [harness]: `test-${harness}-agent` },
    features: { 'github-identity': true },
    settings: {
      daemonPreference: 'off',
      ...(serverMode ? { agentBotServer: 'https://agents.true-line.ai' } : { legacyLocalCustody: true }),
    },
    identityApps: {
      [`test-${harness}-agent`]: {
        id: '123456',
        botUid: '999001',
        botAvatarUrl: 'https://avatars.githubusercontent.com/u/999001?v=4',
      },
    },
  };
  writeFileSync(env.AGENT_BOT_CONFIG, JSON.stringify(config));

  if (deviceHarnesses !== null) {
    writeFileSync(path.join(serverStateDir, 'device.json'), JSON.stringify({
      server: 'https://agents.true-line.ai',
      device_id: 'dev_test',
      harnesses: deviceHarnesses,
    }));
  }

  const originBare = path.join(home, 'test-org', 'my-repo.git');
  const repo = path.join(home, 'my-repo');
  mkdirSync(originBare, { recursive: true });
  mkdirSync(repo, { recursive: true });
  const git = (cwd, ...args) => execFileSync('git', args, {
    cwd,
    env,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();

  git(originBare, 'init', '--bare', '-q', '-b', 'main');
  git(repo, 'init', '-q', '-b', 'main');
  git(repo, 'config', 'user.name', 'Human Owner');
  git(repo, 'config', 'user.email', 'human@example.com');
  git(repo, 'config', 'core.hooksPath', '/dev/null');
  git(repo, 'remote', 'add', 'origin', originBare);
  writeFileSync(path.join(repo, 'README.md'), '# test\n');
  git(repo, 'add', 'README.md');
  git(repo, 'commit', '-q', '-m', 'initial main commit');
  git(repo, 'push', '-q', '-u', 'origin', 'main');

  const resolvedAppSlug = appSlug === undefined ? `test-${harness}-agent` : appSlug;
  const { identity, options } = createSoul
    ? worktreeSoul(env, null, { harness, appSlug: resolvedAppSlug })
    : { identity: null, options: null };
  return { home, env, config, repo, originBare, git, identity, options };
}

async function startTestDaemon(t, f) {
  const server = createDaemonServer({ env: f.env, home: f.home, config: f.config });
  await new Promise((resolve) => { server.listen(0, '127.0.0.1', resolve); });
  t.after(() => new Promise((resolve) => { server.closeAllConnections?.(); server.close(resolve); }));
  const url = `http://127.0.0.1:${server.address().port}`;
  const headers = { authorization: `Bearer ${server.token}`, 'content-type': 'application/json' };
  const clientFactory = async () => ({
    available: async () => true,
    ensureSpace: async (agentId) => {
      const res = await fetch(`${url}/v0/space/ensure`, { method: 'POST', headers, body: JSON.stringify({ agentId }) });
      return res.json();
    },
    registerSoul: async (agentId, spacePath, opts) => {
      const res = await fetch(`${url}/v0/population/register`, { method: 'POST', headers, body: JSON.stringify({ agentId, spacePath, ...opts }) });
      return res.json();
    },
    bind: async (body) => {
      const res = await fetch(`${url}/v0/bind`, { method: 'POST', headers, body: JSON.stringify(body) });
      const data = await res.json();
      if (!res.ok) throw Object.assign(new Error(data?.error ?? `HTTP ${res.status}`), { statusCode: res.status });
      return data;
    },
    binding: async (secret) => {
      const res = await fetch(`${url}/v0/binding`, { method: 'GET', headers: { ...headers, 'x-agent-binding': secret } });
      const data = await res.json();
      if (!res.ok) throw Object.assign(new Error(data?.error ?? `HTTP ${res.status}`), { statusCode: res.status });
      return data;
    },
  });
  return { server, clientFactory };
}

test('start is a public CLI command and --help explains what it is and is not without reading config', (t) => {
  assert.equal(parseAgentBotArgs(['start', '--branch', 'feat/x']).command, 'start');
  assert.match(helpText(), /^ {2}start +Check in this session/m);
  assert.match(helpText(), /setup-worktree .*\[deprecated: prefer 'agent-bot start'/);
  assert.match(helpText(), /join .*\[deprecated: prefer 'agent-bot start'/);
  assert.match(helpText(), /session .*\[deprecated: prefer 'agent-bot start'/);
  assert.match(START_USAGE, /What `agent-bot start` is NOT:/);
  assert.match(START_USAGE, /Not machine\/owner bootstrap/);
  assert.match(START_USAGE, /Not daemon process startup/);
  assert.match(START_USAGE, /Not project dependency or build setup/);

  const dir = mkdtempSync(path.join(tmpdir(), 'start-help-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const badConfig = path.join(dir, 'bad-config.json');
  writeFileSync(badConfig, '{not valid json');
  const res = spawnSync(process.execPath, [CLI, 'start', '--help'], {
    cwd: dir,
    env: { ...process.env, AGENT_BOT_CONFIG: badConfig },
    encoding: 'utf8',
  });
  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stdout, /usage: agent-bot start/);
});

test('parseStartArgs validates flags and worktree names', () => {
  assert.deepEqual(
    parseStartArgs(['-b', 'feat/a', '--base', 'origin/main', '--repo', 'qwts/repo', '--name', 'wt-1', '--harness', 'claude', '--soul', 's1', '--transcript-id', 't1', '--provider', 'claude', '--json']),
    {
      help: false,
      json: true,
      branch: 'feat/a',
      base: 'origin/main',
      repo: 'qwts/repo',
      name: 'wt-1',
      harness: 'claude',
      soul: 's1',
      transcriptId: 't1',
      provider: 'claude',
      noEnroll: false,
    },
  );
  assert.equal(parseStartArgs(['--worktree', '.worktrees/feat-auth']).name, 'feat-auth');
  assert.equal(parseStartArgs(['--worktree-dir', 'worktrees/my-wt/']).name, 'my-wt');
  assert.equal(parseStartArgs(['--no-enroll']).noEnroll, true);
  assert.throws(() => parseStartArgs(['--branch']), /--branch requires a value/);
  assert.throws(() => parseStartArgs(['--branch', 'a', '-b', 'b']), /may be passed only once/);
  assert.throws(() => parseStartArgs(['--unknown']), /unknown option: --unknown/);
  assert.throws(() => parseStartArgs(['--name', '../escape']), /invalid worktree name/);
  assert.throws(() => parseStartArgs(['--worktree', '../escape']), /invalid worktree name/);
  assert.throws(() => parseStartArgs(['--worktree-dir', '/tmp/worktrees/my-wt']), /invalid worktree name/);
  assert.equal(parseStartArgs(['--help', '--unknown']).help, true);
});

function buildTestOpencodeSqliteBuffer({ sessions = [], messages = [], worktrees = [] } = {}) {
  const encodeVarint = (n) => {
    let v = BigInt(n);
    if (v >= 0n && v <= 127n) return Buffer.from([Number(v)]);
    const bytes = [];
    for (let i = 0; i < 8 && v > 0n; i += 1) {
      bytes.unshift(Number(v & 0x7fn) | (bytes.length ? 0x80 : 0));
      v >>= 7n;
    }
    return Buffer.from(bytes);
  };
  const encodeRecord = (values) => {
    const serials = [];
    const bodies = [];
    for (const val of values) {
      if (val === null || val === undefined) {
        serials.push(encodeVarint(0));
      } else if (typeof val === 'number') {
        const b = Buffer.alloc(8);
        b.writeBigInt64BE(BigInt(Math.trunc(val)), 0);
        serials.push(encodeVarint(6));
        bodies.push(b);
      } else {
        const b = Buffer.from(String(val), 'utf8');
        serials.push(encodeVarint(b.length * 2 + 13));
        bodies.push(b);
      }
    }
    const serialBuf = Buffer.concat(serials);
    const hdrLen = encodeVarint(serialBuf.length + 1);
    return Buffer.concat([hdrLen, serialBuf, ...bodies]);
  };
  const buildLeafTablePage = (records, isPage1 = false) => {
    const page = Buffer.alloc(4096);
    const hdrOff = isPage1 ? 100 : 0;
    page[hdrOff] = 0x0d;
    page.writeUInt16BE(records.length, hdrOff + 3);
    let contentOff = 4096;
    records.forEach((rec, idx) => {
      const payload = encodeRecord(rec);
      const cell = Buffer.concat([encodeVarint(payload.length), encodeVarint(idx + 1), payload]);
      contentOff -= cell.length;
      cell.copy(page, contentOff);
      page.writeUInt16BE(contentOff, hdrOff + 8 + idx * 2);
    });
    page.writeUInt16BE(contentOff, hdrOff + 5);
    return page;
  };
  const masterRows = [
    ['table', 'session_v2', 'session_v2', 2, 'CREATE TABLE session_v2 (id TEXT PRIMARY KEY, project_id TEXT, parent_id TEXT, directory TEXT, time_created INTEGER, time_updated INTEGER, time_busy INTEGER, time_idle INTEGER, time_archived INTEGER)'],
    ['table', 'session_message', 'session_message', 3, 'CREATE TABLE session_message (id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER, time_updated INTEGER, data TEXT)'],
    ['table', 'worktree', 'worktree', 4, 'CREATE TABLE worktree (name TEXT, project_id TEXT, directory TEXT PRIMARY KEY)'],
  ];
  const p1 = buildLeafTablePage(masterRows, true);
  Buffer.from('SQLite format 3\0', 'utf8').copy(p1, 0);
  p1.writeUInt16BE(4096, 16);
  p1[18] = 1; p1[19] = 1; p1[20] = 0; p1[21] = 64; p1[22] = 32; p1[23] = 32;
  p1.writeUInt32BE(1, 24);
  p1.writeUInt32BE(4, 28);
  p1.writeUInt32BE(1, 40);
  p1.writeUInt32BE(4, 44);
  p1.writeUInt32BE(1, 56);
  p1.writeUInt32BE(1, 92);
  p1.writeUInt32BE(3054000, 96);
  const p2 = buildLeafTablePage(sessions);
  const p3 = buildLeafTablePage(messages);
  const p4 = buildLeafTablePage(worktrees);
  return Buffer.concat([p1, p2, p3, p4]);
}

test('discoverOpencodeTranscript picks the fresh active OpenCode SQLite session (via node:sqlite and Node-20 pure-JS B-tree fallback), falls back to storage/session JSON, matches cwd across multiple sessions, and refuses stale sessions', async (t) => {
  const home = mkdtempSync(path.join(tmpdir(), 'opencode-db-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const dbPath = path.join(home, '.local', 'share', 'opencode', 'opencode.db');
  mkdirSync(path.dirname(dbPath), { recursive: true });
  const nowMs = Date.now();
  writeFileSync(dbPath, buildTestOpencodeSqliteBuffer({
    sessions: [
      ['ses_home', 'proj_home', null, home, nowMs - 5_000, nowMs - 5_000, nowMs - 5_000, null, null],
      ['ses_older', 'proj_1', null, '/workspace/other', nowMs - 120_000, nowMs - 120_000, null, nowMs - 120_000, null],
      ['ses_newer', 'proj_2', null, '/workspace/target', nowMs - 10_000, nowMs - 5_000, nowMs - 5_000, null, null],
    ],
    messages: [
      ['msg_1', 'ses_newer', nowMs - 5_000, nowMs - 5_000, '{"path":{"cwd":"/workspace/target","root":"/workspace/target"}}'],
    ],
  }));

  // An unrelated session opened in $HOME does not match a child directory under $HOME.
  assert.equal(discoverOpencodeTranscript(home, { cwd: path.join(home, 'unmatched-project') }), null);
  assert.deepEqual(discoverOpencodeTranscript(home, { cwd: '/workspace/target' }), { provider: 'opencode', id: 'ses_newer' });
  // Explicitly verify the Node-20 pure-JS SQLite B-tree reader returns the exact same result even when node:sqlite is bypassed.
  assert.deepEqual(discoverOpencodeTranscript(home, { cwd: '/workspace/target', forceBufferReader: true }), { provider: 'opencode', id: 'ses_newer' });
  assert.deepEqual(
    await findTranscript({ env: { OPENCODE: '1', HOME: home }, cwd: '/workspace/target' }),
    { provider: 'opencode', id: 'ses_newer' },
  );

  // An unrelated session in another directory whose prose merely mentions /workspace/target does NOT match /workspace/target.
  writeFileSync(dbPath, buildTestOpencodeSqliteBuffer({
    sessions: [
      ['ses_prose_only', 'proj_other', null, '/workspace/unrelated', nowMs - 5_000, nowMs - 5_000, nowMs - 5_000, null, null],
    ],
    messages: [
      ['msg_prose', 'ses_prose_only', nowMs - 5_000, nowMs - 5_000, '{"text":"Let us discuss /workspace/target in prose"}'],
    ],
  }));
  assert.equal(discoverOpencodeTranscript(home, { cwd: '/workspace/target' }), null);
  assert.equal(discoverOpencodeTranscript(home, { cwd: '/workspace/target', forceBufferReader: true }), null);

  // When all SQLite sessions are stale (> 60s old), returns null so an idle session never steals another's id.
  writeFileSync(dbPath, buildTestOpencodeSqliteBuffer({
    sessions: [
      ['ses_newer', 'proj_2', null, '/workspace/target', nowMs - 180_000, nowMs - 180_000, null, nowMs - 180_000, null],
    ],
    messages: [
      ['msg_1', 'ses_newer', nowMs - 180_000, nowMs - 180_000, '{"path":{"cwd":"/workspace/target","root":"/workspace/target"}}'],
    ],
  }));
  assert.equal(discoverOpencodeTranscript(home, { cwd: '/workspace/target' }), null);
  assert.equal(discoverOpencodeTranscript(home, { cwd: '/workspace/target', forceBufferReader: true }), null);

  // When opencode.db is absent or stale, falls back to ~/.local/share/opencode/storage/session/<projectId>/*.json.
  rmSync(dbPath, { force: true });
  const storageSessDir = path.join(home, '.local', 'share', 'opencode', 'storage', 'session', 'proj_storage');
  mkdirSync(storageSessDir, { recursive: true });
  writeFileSync(path.join(storageSessDir, 'ses_json_1.json'), JSON.stringify({
    id: 'ses_json_1',
    projectID: 'proj_storage',
    directory: '/workspace/storage-target',
    time: { created: nowMs - 10_000, updated: nowMs - 3_000 },
  }));
  assert.deepEqual(
    discoverOpencodeTranscript(home, { cwd: '/workspace/storage-target' }),
    { provider: 'opencode', id: 'ses_json_1' },
  );

  // When node:sqlite is available (Node 22.5+), also verify both readers against a real WAL-mode SQLite database.
  let DatabaseSync = null;
  try {
    ({ DatabaseSync } = await import('node:sqlite'));
  } catch { /* Node 20 without node:sqlite */ }
  if (DatabaseSync) {
    const walHome = mkdtempSync(path.join(tmpdir(), 'opencode-wal-'));
    t.after(() => rmSync(walHome, { recursive: true, force: true }));
    const walDbPath = path.join(walHome, '.local', 'share', 'opencode', 'opencode.db');
    mkdirSync(path.dirname(walDbPath), { recursive: true });
    const db = new DatabaseSync(walDbPath);
    db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE session_v2 (
        id TEXT PRIMARY KEY,
        project_id TEXT,
        parent_id TEXT,
        directory TEXT,
        time_created INTEGER,
        time_updated INTEGER,
        time_busy INTEGER,
        time_idle INTEGER,
        time_archived INTEGER
      );
      CREATE TABLE session_message (
        id TEXT PRIMARY KEY,
        session_id TEXT,
        time_created INTEGER,
        time_updated INTEGER,
        data TEXT
      );
      CREATE TABLE worktree (
        name TEXT,
        project_id TEXT,
        directory TEXT PRIMARY KEY
      );
    `);
    db.prepare('INSERT INTO session_v2 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)').run(
      'ses_wal_live', 'proj_wal', null, '/workspace/wal-target', nowMs - 4_000, nowMs - 2_000, nowMs - 2_000, null, null,
    );
    assert.deepEqual(discoverOpencodeTranscript(walHome, { cwd: '/workspace/wal-target' }), { provider: 'opencode', id: 'ses_wal_live' });
    assert.deepEqual(discoverOpencodeTranscript(walHome, { cwd: '/workspace/wal-target', forceBufferReader: true }), { provider: 'opencode', id: 'ses_wal_live' });
    db.close();
  }
});

test('discoverAntigravityTranscript picks the fresh active brain transcript, matches cwd across multiple brains, refuses stale or ambiguous sessions, and stays hermetic without HOME', async (t) => {
  const home = mkdtempSync(path.join(tmpdir(), 'agy-brain-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const olderLog = path.join(home, '.gemini', 'antigravity', 'brain', 'conv-older', '.system_generated', 'logs', 'transcript.jsonl');
  const newerLog = path.join(home, '.gemini', 'antigravity', 'brain', 'conv-newer', '.system_generated', 'logs', 'transcript.jsonl');
  mkdirSync(path.dirname(olderLog), { recursive: true });
  mkdirSync(path.dirname(newerLog), { recursive: true });
  writeFileSync(olderLog, '{"cwd":"/workspace/other"}\n');
  writeFileSync(newerLog, '{"cwd":"/workspace/target"}\n');
  const nowSec = Math.floor(Date.now() / 1000);
  utimesSync(olderLog, nowSec - 120, nowSec - 120);
  utimesSync(newerLog, nowSec - 5, nowSec - 5);

  assert.deepEqual(discoverAntigravityTranscript(home, { cwd: '/workspace/target' }), { provider: 'antigravity', id: 'conv-newer' });
  assert.deepEqual(
    await findTranscript({ env: { ANTIGRAVITY_AGENT: '1', HOME: home }, cwd: '/workspace/target' }),
    { provider: 'antigravity', id: 'conv-newer' },
  );
  // Two concurrent transcripts modified within 60s without a unique cwd match are ambiguous.
  utimesSync(olderLog, nowSec - 20, nowSec - 20);
  assert.equal(discoverAntigravityTranscript(home), null);
  // With a unique cwd in one of the fresh transcripts, cwd disambiguates.
  assert.deepEqual(discoverAntigravityTranscript(home, { cwd: '/workspace/target' }), { provider: 'antigravity', id: 'conv-newer' });
  // Path boundary check: /workspace/target-other does not match /workspace/target, and one fresh brain with non-matching cwd (with or without a stale sibling) returns null.
  utimesSync(olderLog, nowSec - 120, nowSec - 120);
  assert.equal(discoverAntigravityTranscript(home, { cwd: '/workspace/target-other' }), null);
  assert.equal(discoverAntigravityTranscript(home, { cwd: '/workspace/tar' }), null);
  rmSync(path.join(home, '.gemini', 'antigravity', 'brain', 'conv-older'), { recursive: true, force: true });
  assert.equal(discoverAntigravityTranscript(home, { cwd: '/workspace/other' }), null);
  // When all transcripts are stale (> 60s old), returns null so an idle conversation never steals another's id.
  utimesSync(newerLog, nowSec - 180, nowSec - 180);
  assert.equal(discoverAntigravityTranscript(home, { cwd: '/workspace/target' }), null);
  // Without HOME in a synthetic env object, findTranscript never leaks the host HOME.
  assert.equal(await findTranscript({ env: { ANTIGRAVITY_AGENT: '1' } }), null);
});

test('startTask from a primary checkout auto-resolves soul, branches from origin/main, binds session, and leaves primary checkout untouched', async (t) => {
  const f = makeFixture(t, { harness: 'codex', serverMode: true, deviceHarnesses: ['test-codex-agent'] });
  const { clientFactory } = await startTestDaemon(t, f);

  // Advance local primary checkout onto a dirty local branch so we prove
  // `start --branch` branches from origin/main rather than the dirty primary HEAD.
  f.git(f.repo, 'checkout', '-q', '-b', 'local-wip');
  writeFileSync(path.join(f.repo, 'wip.txt'), 'uncommitted\n');
  f.git(f.repo, 'add', 'wip.txt');
  f.git(f.repo, 'commit', '-q', '-m', 'local wip commit not on origin/main');
  const originMainSha = f.git(f.repo, 'rev-parse', 'origin/main');

  const startEnv = {
    ...f.env,
    AGENT_BOT_ID: '',
    QWTS_AGENT_ID: '',
    CODEX_SANDBOX: 'seatbelt',
    CODEX_THREAD_ID: 'thread-1345',
  };

  const reconcileCredentials = async ({ slugs }) => slugs.map((slug) => ({
    slug,
    local: { status: 'ready' },
    live: { status: 'server-registered' },
  }));

  const receipt = await startTask({
    branch: 'feat/issue-1345',
    cwd: f.repo,
    env: startEnv,
    home: f.home,
    config: f.config,
    clientFactory,
    reconcileCredentials,
  });

  assert.equal(receipt.soul.id, f.identity.id);
  assert.equal(receipt.soul.resolution, 'auto-resolved: codex');
  assert.deepEqual(receipt.session, { provider: 'codex', id: 'thread-1345', source: 'auto-detected' });
  assert.equal(receipt.worktree.branch, 'feat/issue-1345');
  assert.equal(receipt.worktree.created, true);
  assert.ok(receipt.worktree.path.endsWith('my-repo-feat-issue-1345'));
  assert.equal(f.git(receipt.worktree.path, 'rev-parse', 'HEAD'), originMainSha);
  assert.equal(f.git(receipt.worktree.path, 'config', '--worktree', '--get', 'user.name'), 'test-codex-agent[bot]');
  assert.equal(f.git(receipt.worktree.path, 'config', '--worktree', '--get', 'agentBot.agentId'), f.identity.id);
  assert.equal(receipt.binding.status, 'live');
  assert.equal(receipt.binding.alreadyBound, false);
  assert.match(receipt.next, /cd /);
  assert.match(formatStartReceipt(receipt), /soul: .*auto-resolved: codex/);

  // Primary checkout remains human-attributed and does not track origin/main on the feature branch.
  assert.equal(f.git(f.repo, 'config', '--get', 'user.name'), 'Human Owner');
  assert.equal(existsSync(path.join(f.repo, '.git', 'config.worktree')), false);
  assert.doesNotMatch(readFileSync(path.join(f.repo, '.git', 'config'), 'utf8'), /\[branch "feat\/issue-1345"\]/);

  // Re-running inside the created soul worktree is a fast idempotent no-op.
  const rerun = await startTask({
    branch: 'feat/issue-1345',
    cwd: receipt.worktree.path,
    env: startEnv,
    home: f.home,
    config: f.config,
    clientFactory,
    reconcileCredentials,
  });
  assert.equal(rerun.worktree.path, receipt.worktree.path);
  assert.equal(rerun.worktree.created, false);
  assert.equal(rerun.binding.alreadyBound, true);
  assert.equal(rerun.next, null);

  // Passing --base when reusing in-place or when destination worktree already exists fails closed.
  await assert.rejects(
    () => startTask({
      branch: 'feat/issue-1345',
      base: 'origin/main',
      cwd: receipt.worktree.path,
      env: startEnv,
      home: f.home,
      config: f.config,
      clientFactory,
      reconcileCredentials,
    }),
    (err) => err.code === 'start-base-on-existing-branch',
  );
  await assert.rejects(
    () => startTask({
      branch: 'feat/issue-1345',
      base: 'origin/main',
      cwd: f.repo,
      env: startEnv,
      home: f.home,
      config: f.config,
      clientFactory,
      reconcileCredentials,
    }),
    (err) => err.code === 'start-base-on-existing-branch',
  );

  // Starting a second branch from inside the first branch's worktree branches
  // cleanly from origin/main into a sibling soul worktree and reuses the
  // session transcript even if CODEX_THREAD_ID is omitted.
  f.git(receipt.worktree.path, 'commit', '--allow-empty', '-q', '-m', 'work on first branch');
  const second = await startTask({
    branch: 'feat/second-task',
    cwd: receipt.worktree.path,
    env: { ...startEnv, CODEX_THREAD_ID: '' },
    home: f.home,
    config: f.config,
    clientFactory,
    reconcileCredentials,
  });
  assert.equal(second.worktree.created, true);
  assert.ok(second.worktree.path.endsWith('my-repo-feat-second-task'));
  assert.equal(f.git(second.worktree.path, 'rev-parse', 'HEAD'), originMainSha);
  assert.equal(second.session.id, 'thread-1345');
  assert.equal(second.session.source, 'reused-session');
});

test('startTask in server mode fails closed with server enroll guidance when device or harness scope is missing', async (t) => {
  const unenrolled = makeFixture(t, { harness: 'codex', serverMode: true, deviceHarnesses: null });
  await assert.rejects(
    () => startTask({
      branch: 'feat/unenrolled',
      transcriptId: 't-1',
      cwd: unenrolled.repo,
      env: { ...unenrolled.env, CODEX_SANDBOX: 'seatbelt' },
      home: unenrolled.home,
      config: unenrolled.config,
    }),
    (err) => err.code === 'server-device-not-enrolled' && /agent-bot server enroll --add-harness test-codex-agent/.test(err.message),
  );

  const wrongScope = makeFixture(t, { harness: 'codex', serverMode: true, deviceHarnesses: ['claude'] });
  await assert.rejects(
    () => startTask({
      branch: 'feat/wrong-scope',
      transcriptId: 't-1',
      cwd: wrongScope.repo,
      env: { ...wrongScope.env, CODEX_SANDBOX: 'seatbelt' },
      home: wrongScope.home,
      config: wrongScope.config,
    }),
    (err) => err.code === 'server-harness-not-enrolled' && /this device is not enrolled for test-codex-agent \(enrolled: claude\); run: agent-bot server enroll --add-harness test-codex-agent/.test(err.message),
  );

  // When enrollImpl is provided (or autoEnroll is enabled in CLI start), startTask automatically stages --add-harness enrollment and proceeds once enrolled.
  const { clientFactory } = await startTestDaemon(t, wrongScope);
  const enrollCalls = [];
  const enrolledReceipt = await startTask({
    branch: 'feat/auto-enrolled',
    transcriptId: 't-auto-enroll',
    cwd: wrongScope.repo,
    env: { ...wrongScope.env, CODEX_SANDBOX: 'seatbelt' },
    home: wrongScope.home,
    config: wrongScope.config,
    clientFactory,
    reconcileCredentials: async ({ slugs }) => slugs.map((slug) => ({
      slug,
      local: { status: 'ready' },
      live: { status: 'server-registered' },
    })),
    enrollImpl: async ({ addHarnesses }) => {
      enrollCalls.push({ addHarnesses });
      writeFileSync(path.join(wrongScope.home, 'server-state', 'device.json'), JSON.stringify({
        server: 'https://agents.true-line.ai',
        device_id: 'dev_test',
        harnesses: ['claude', ...addHarnesses],
      }));
    },
  });
  assert.deepEqual(enrollCalls, [{ addHarnesses: ['test-codex-agent'] }]);
  assert.equal(enrolledReceipt.worktree.branch, 'feat/auto-enrolled');
  assert.equal(enrolledReceipt.binding.status, 'live');
});

test('startTask fails closed before creating soul or worktree when transcript is missing, branch is occupied, or --repo mismatches origin', async (t) => {
  const f = makeFixture(t, { harness: 'codex', serverMode: true, deviceHarnesses: ['codex'], createSoul: false });
  f.git(f.repo, 'checkout', '-q', '-b', 'occupied-branch');

  const assertNoMutations = () => {
    assert.equal(existsSync(f.env.AGENT_BOT_POPULATION_PATH), false);
    assert.equal(existsSync(f.env.AGENT_BOT_SOULS_HOME), false);
    assert.equal(f.git(f.repo, 'worktree', 'list', '--porcelain').split('\n\n').filter(Boolean).length, 1);
  };

  // 1. Missing transcript when no soul exists yet must not auto-join a soul or create a worktree.
  await assert.rejects(
    () => startTask({
      branch: 'feat/no-transcript',
      cwd: f.repo,
      env: { ...f.env, CODEX_SANDBOX: 'seatbelt', CODEX_THREAD_ID: '' },
      home: f.home,
      config: f.config,
    }),
    (err) => err.code === 'start-transcript-required',
  );
  assertNoMutations();

  // 2. Branch already checked out in the primary worktree fails closed with start-branch-in-use.
  await assert.rejects(
    () => startTask({
      branch: 'occupied-branch',
      transcriptId: 't-1',
      cwd: f.repo,
      env: { ...f.env, CODEX_SANDBOX: 'seatbelt' },
      home: f.home,
      config: f.config,
    }),
    (err) => err.code === 'start-branch-in-use' && /already checked out at/.test(err.message),
  );
  assertNoMutations();

  // 3. Passing --base for an existing local branch fails closed with start-base-on-existing-branch.
  f.git(f.repo, 'branch', 'existing-local', 'origin/main');
  await assert.rejects(
    () => startTask({
      branch: 'existing-local',
      base: 'origin/main',
      transcriptId: 't-1',
      cwd: f.repo,
      env: { ...f.env, CODEX_SANDBOX: 'seatbelt' },
      home: f.home,
      config: f.config,
    }),
    (err) => err.code === 'start-base-on-existing-branch',
  );
  assertNoMutations();

  // 4. Passing --repo with a mismatched owner/name refuses the current checkout even if basename matches,
  //    even if AGENT_BOT_SERVER_REPO is set or a relative directory owner/name exists in cwd.
  mkdirSync(path.join(f.repo, 'other-org', 'my-repo'), { recursive: true });
  await assert.rejects(
    () => startTask({
      branch: 'feat/wrong-owner',
      repo: 'other-org/my-repo',
      transcriptId: 't-1',
      cwd: f.repo,
      env: { ...f.env, CODEX_SANDBOX: 'seatbelt', AGENT_BOT_SERVER_REPO: 'other-org/my-repo' },
      home: f.home,
      config: f.config,
    }),
    (err) => err.code === 'start-repo-not-found',
  );
  assertNoMutations();

  // 4b. Ambient editor markers (TERM_PROGRAM=vscode, CURSOR_TRACE_ID) do not auto-select a bot harness.
  await assert.rejects(
    () => startTask({
      branch: 'feat/ambient-editor',
      transcriptId: 't-1',
      cwd: f.repo,
      env: { ...f.env, TERM_PROGRAM: 'vscode', VSCODE_PID: '1234', CURSOR_TRACE_ID: 'trace-1' },
      home: f.home,
      config: f.config,
    }),
    /could not detect agent harness from environment/,
  );
  assertNoMutations();

  // 5. Existing soul initially minted without an appSlug gets backfilled before configuring the worktree.
  const noApp = makeFixture(t, { harness: 'codex', serverMode: true, deviceHarnesses: ['codex'], appSlug: null });
  const { clientFactory } = await startTestDaemon(t, noApp);
  const backfilled = await startTask({
    branch: 'feat/backfill-app',
    transcriptId: 't-backfill',
    cwd: noApp.repo,
    env: { ...noApp.env, CODEX_SANDBOX: 'seatbelt' },
    home: noApp.home,
    config: noApp.config,
    clientFactory,
    reconcileCredentials: async ({ slugs }) => slugs.map((slug) => ({
      slug,
      local: { status: 'ready' },
      live: { status: 'server-registered' },
    })),
  });
  assert.equal(backfilled.identity.appSlug, 'test-codex-agent');
  assert.equal(noApp.git(backfilled.worktree.path, 'config', '--worktree', '--get', 'user.name'), 'test-codex-agent[bot]');

  // 6. Bound session/checkout refuses cross-soul --soul or cross-harness --harness overrides.
  const otherSoul = worktreeSoul({ ...noApp.env }, null, { harness: 'codex', appSlug: 'test-codex-agent' });
  await assert.rejects(
    () => startTask({
      branch: 'feat/cross-soul',
      soul: otherSoul.identity.id,
      transcriptId: 't-cross',
      cwd: backfilled.worktree.path,
      env: { ...noApp.env, AGENT_BOT_ID: '', QWTS_AGENT_ID: '', CODEX_SANDBOX: 'seatbelt' },
      home: noApp.home,
      config: noApp.config,
      clientFactory,
    }),
    (err) => err.code === 'start-soul-mismatch',
  );
  await assert.rejects(
    () => startTask({
      branch: 'feat/cross-harness',
      harness: 'claude',
      transcriptId: 't-cross',
      cwd: backfilled.worktree.path,
      env: { ...noApp.env, AGENT_BOT_ID: '', QWTS_AGENT_ID: '', CODEX_SANDBOX: 'seatbelt' },
      home: noApp.home,
      config: noApp.config,
      clientFactory,
    }),
    (err) => err.code === 'start-harness-mismatch',
  );

  // 7. Multiple active installed souls for the same harness fail closed with start-ambiguous-soul unless --soul is specified.
  await assert.rejects(
    () => startTask({
      branch: 'feat/ambiguous',
      transcriptId: 't-ambig',
      cwd: noApp.repo,
      env: { ...noApp.env, AGENT_BOT_ID: '', QWTS_AGENT_ID: '', CODEX_SANDBOX: 'seatbelt' },
      home: noApp.home,
      config: noApp.config,
      clientFactory,
    }),
    (err) => err.code === 'start-ambiguous-soul',
  );
});

