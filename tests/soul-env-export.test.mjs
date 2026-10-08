import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync, gzipSync } from 'node:zlib';
import { mintAgentIdentity, readAgentIdentity, stateDirectory } from '../agent-identity.mjs';
import { listSouls, showSoul, upsertSoul } from '../agent-population.mjs';
import { auditFile } from '../agent-principals.mjs';
import { initAgentSpace } from '../agent-space.mjs';
import { CLASSIFICATIONS, classifyPath, retentionOf } from '../soul-env-contract.mjs';
import { EXPORT_MANIFEST, IMPORTS_DIRECTORY, LIFE_IMPORT_STEP_ID, planSoulExport, readExportManifest, soulEnvExportCommand, soulEnvImportCommand, writeSoulExport } from '../soul-env-export.mjs';
import { ENV_CAPABILITIES, readSoulEnvironment } from '../soul-env.mjs';
import { readMigrationStep } from '../soul-migration-journal.mjs';
import { PACKAGE_IGNORE_LIST, computePackageRevision } from '../soul-package.mjs';
import { adoptSoulPackage, revisionHistory } from '../soul-revisions.mjs';
import { INSTALL_STAMP } from '../soul-runtimes.mjs';

const ID = 'agent_12345678-1234-4234-8234-123456789abc';
const SECRET = 'NEVER-IN-THE-ARCHIVE';
const LIFE = 'THIS-IS-THE-LIFE';
// Generated output is reconstructible, not secret: it never travels as the
// root's file, but the revision journal's stored packages carry it by design.
const GENERATED = 'GENERATED-OUTPUT';
const ROOT = fileURLToPath(new URL('..', import.meta.url));
const NOW = new Date('2026-10-07T10:00:00Z');
const put = (file, contents) => { mkdirSync(path.dirname(file), { recursive: true }); writeFileSync(file, contents); };
const lines = (file) => { try { return readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line)); } catch { return []; } };
const component = (result, id) => result.components.find((entry) => entry.id === id);
const git = (cwd, ...args) => {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@x', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@x', GIT_CONFIG_GLOBAL: '/dev/null', HOME: cwd } });
  if (result.status !== 0) throw new Error(`git ${args.join(' ')}: ${result.stderr}`);
  return result.stdout.trim();
};

// What must travel (durable life) and what must never (secrets, sign-ins,
// reconstructible or disposable state), each with content the tests can
// look for in the archive's bytes.
const CARRIED = Object.freeze({
  'AGENTS.md': `# Billy\n${LIFE} instructions\n`, 'skills/hello/SKILL.md': '---\nname: hello\ndescription: hi\n---\nhi\n',
  'worktrees/workspace/.git/HEAD': 'ref: refs/heads/main\n', 'worktrees/workspace/uncommitted.txt': `work in progress ${LIFE}\n`,
  '.soul-state/home/AGENTS.md': '# Billy\n', '.soul-state/home/.codex/sessions/rollout.jsonl': `{"turn":"${LIFE} session"}\n`,
  '.soul-state/tools/codex/sessions/2026/one.jsonl': `{"turn":"${LIFE} codex state"}\n`,
  '.soul-state/tools/claude/.claude.json': `{"theme":"dark","note":"${LIFE} claude state"}`,
  '.soul-state/runs/turns.jsonl': `{"id":"inv-1","note":"${LIFE} history"}\n`, '.soul-state/home-harness': '"codex"',
  '.soul-state/confinement.log': `${LIFE} confinement\n`,
});
const NEVER = Object.freeze({
  '.soul-state/credentials/github-app-billy.json': `${SECRET} credential`, '.soul-state/credentials/secrets/github-models': `${SECRET} provider secret`,
  '.soul-state/tools/codex/auth.json': `{"OPENAI_API_KEY":"${SECRET} codex sign-in"}`, '.soul-state/tools/claude/.credentials.json': `{"token":"${SECRET} claude sign-in"}`,
  '.soul-state/tools/opencode/data/opencode/auth.json': `{"token":"${SECRET} opencode sign-in"}`, '.soul-state/tools/opencode/cache/opencode/index': `${SECRET} opencode cache`,
  '.soul-state/runtimes/node/24.0.0/bin/node': `#!/bin/sh\n# ${SECRET} runtime\n`, [`.soul-state/runtimes/node/24.0.0/${INSTALL_STAMP}`]: JSON.stringify({ name: 'node', version: '24.0.0', bin: 'bin' }),
  '.soul-state/cache/index.db': `${SECRET} cache`, '.soul-state/tmp/scratch.txt': `${SECRET} temp`,
  '.soul-state/home/node_modules/@agentclientprotocol/codex-acp/package.json': `{"version":"2.1.1","note":"${SECRET} install"}`,
  '.soul-state/.space-migrate.lock': 'lock', 'CLAUDE.md': `<!-- agent-bot soul-builder: generated -->\n# Billy ${GENERATED}\n`,
});

// One soul under a scratch HOME: identity record, census row, a soul
// folder with every kind of state, its Agent Space inside, a revision
// journal, and a linked worktree whose checkout is a real git repository
// with a tracked change and an untracked file. Nothing touches the real
// HOME, a keychain or a secret store.
function fixture(t, { running = false, linkedSpace = false, journal = true } = {}) {
  const home = mkdtempSync(path.join(realpathSync(tmpdir()), 'sx-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const env = { PATH: process.env.PATH, HOME: home, XDG_STATE_HOME: path.join(home, 'state'), AGENT_BOT_SOULS_HOME: path.join(home, 'souls'),
    AGENT_BOT_SPACES_HOME: path.join(home, 'spaces'), AGENT_BOT_POPULATION_PATH: path.join(home, 'population.json'),
    AGENT_BOT_DAEMON_STATE_PATH: path.join(home, 'daemon.json'), AGENT_BOT_CONFIG: path.join(home, 'no-config') };
  const file = env.AGENT_BOT_POPULATION_PATH;
  const stateDir = stateDirectory({ env, home });
  const dir = path.join(env.AGENT_BOT_SOULS_HOME, 'billy.soul');
  mintAgentIdentity({ stateDir, idFactory: () => ID, harness: 'codex', appSlug: null, useGithub: false });
  const manifest = { formatVersion: 2, ignore: PACKAGE_IGNORE_LIST, name: 'Billy', description: 'Export tests', displaySeed: 'billy', preferredHarnesses: ['codex'],
    revision: `sha256:${'0'.repeat(64)}`, parentRevision: null, template: false, credentials: { github: { app: 'billy-app', store: 'file' } }, runtimes: { node: '24' } };
  for (const [relative, contents] of Object.entries(CARRIED)) put(path.join(dir, relative), contents);
  for (const [relative, contents] of Object.entries(NEVER)) put(path.join(dir, relative), contents);
  put(path.join(dir, '.soul-state', 'migration.json'), '{"schemaVersion":1,"steps":[]}\n');
  put(path.join(dir, 'soul.json'), JSON.stringify(manifest));
  manifest.revision = computePackageRevision(dir);
  put(path.join(dir, 'soul.json'), JSON.stringify(manifest));
  put(path.join(dir, '.soul-state', 'agent-id'), `${ID}\n`);
  mkdirSync(path.join(dir, '.soul-state', 'cache', 'empty-dir'), { recursive: true });
  mkdirSync(path.join(dir, 'sop'), { recursive: true });
  // Memory: inside (slice 5) or linked from the spaces root (before it).
  let space;
  if (linkedSpace) {
    space = initAgentSpace(ID, { env, home }).path;
    symlinkSync(space, path.join(dir, '.soul-state', 'space'), 'dir');
  } else {
    space = path.join(dir, '.soul-state', 'space');
    put(path.join(space, 'space.json'), JSON.stringify({ schemaVersion: 1, agentId: ID, createdAt: NOW.toISOString() }));
  }
  put(path.join(space, 'notes', 'today.md'), `# Today\n${LIFE} memory\n`);
  upsertSoul({ id: ID, name: 'billy', displayName: 'Billy', soulDir: dir, spacePath: space, status: 'active', parentId: null, appSlug: null }, { file });
  if (journal) adoptSoulPackage(ID, dir, { stateDir, now: () => NOW, soulDir: dir, reason: 'Adopt starting package' });
  // The linked worktree: a real checkout outside the soul with one tracked
  // change and one untracked file; a symlink to it under worktrees/.
  const repo = path.join(home, 'Code', 'app');
  mkdirSync(repo, { recursive: true });
  git(repo, 'init', '-q', '-b', 'main');
  put(path.join(repo, 'README.md'), 'hello\n');
  put(path.join(repo, 'secret.env'), `${SECRET} ignored by git\n`);
  put(path.join(repo, '.gitignore'), 'secret.env\n');
  git(repo, 'add', '.');
  git(repo, 'commit', '-q', '-m', 'init');
  const head = git(repo, 'rev-parse', 'HEAD');
  put(path.join(repo, 'README.md'), `hello\n${LIFE} tracked change\n`);
  put(path.join(repo, 'notes', 'new.txt'), `${LIFE} untracked\n`);
  symlinkSync(repo, path.join(dir, 'worktrees', 'app'), 'dir');
  // A link to somewhere else entirely: a pointer, never followed.
  put(path.join(home, 'elsewhere', 'host-file.txt'), `${SECRET} host file`);
  symlinkSync(path.join(home, 'elsewhere', 'host-file.txt'), path.join(dir, 'host-link'));
  const gates = [];
  const options = { env, home, cwd: home, file, stateDir, config: {}, now: () => NOW,
    gate: async (action, { principal }) => { gates.push([action, principal]); return { method: 'consent' }; },
    running: async () => running };
  return { home, env, dir, file, stateDir, space, repo, head, manifest, options, gates, archive: path.join(home, 'out', 'billy.soul.tgz'),
    receipts: () => lines(auditFile({ env, home })) };
}

// Every entry name of a tar.gz, as `tar -tzf` would list them (ustar and
// GNU long names), with each entry's type and bytes.
function listArchive(file) {
  const tar = gunzipSync(readFileSync(file));
  const entries = [];
  let offset = 0, longName = null;
  for (;;) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    const field = (at, length) => header.subarray(at, at + length).toString('utf8').replace(/\0.*$/s, '');
    const size = parseInt(field(124, 12), 8) || 0;
    const type = field(156, 1) || '0';
    const body = tar.subarray(offset + 512, offset + 512 + size);
    offset += 512 + Math.ceil(size / 512) * 512;
    if (type === 'L') { longName = body.toString('utf8').replace(/\0+$/, ''); continue; }
    const prefix = field(345, 155);
    entries.push({ name: longName ?? (prefix ? `${prefix}/${field(0, 100)}` : field(0, 100)), type, body });
    longName = null;
  }
  return entries;
}

// A tampered copy of an archive: `edit(entries)` changes the parsed entries
// and they are written back as plain ustar entries (short names only).
function rewriteArchive(from, to, edit) {
  const entries = listArchive(from);
  edit(entries);
  const blocks = [];
  const header512 = (name, size, type, linkname = null) => {
    const header = Buffer.alloc(512);
    header.write(name, 0, 100, 'utf8');
    header.write('0000600\0', 100, 8, 'ascii');
    header.write('0000000\0', 108, 8, 'ascii');
    header.write('0000000\0', 116, 8, 'ascii');
    header.write(`${size.toString(8).padStart(11, '0')}\0`, 124, 12, 'ascii');
    header.write('00000000000\0', 136, 12, 'ascii');
    header.write('        ', 148, 8, 'ascii');
    header.write(type, 156, 1, 'ascii');
    if (linkname) header.write(linkname, 157, 100, 'utf8');
    header.write('ustar\0', 257, 6, 'ascii');
    header.write('00', 263, 2, 'ascii');
    let sum = 0;
    for (const byte of header) sum += byte;
    header.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 8, 'ascii');
    return header;
  };
  for (const entry of entries) {
    if (Buffer.byteLength(entry.name) > 100) {
      const long = Buffer.from(`${entry.name}\0`);
      blocks.push(header512('././@LongLink', long.length, 'L'), long, Buffer.alloc((512 - (long.length % 512)) % 512));
    }
    blocks.push(header512(entry.name.slice(0, 100), entry.body.length, entry.type, entry.linkname), entry.body, Buffer.alloc((512 - (entry.body.length % 512)) % 512));
  }
  blocks.push(Buffer.alloc(1024));
  mkdirSync(path.dirname(to), { recursive: true });
  writeFileSync(to, gzipSync(Buffer.concat(blocks)));
}

async function exportIt(f, { plan = false } = {}) {
  let out = '';
  const result = await soulEnvExportCommand([ID, '--to', f.archive, '--json', ...(plan ? ['--plan'] : [])], { ...f.options, write: (v) => { out += v; } });
  return { result, out };
}

test('the capabilities name the slice and the plan lists every classification with its reason for staying or going', async (t) => {
  const f = fixture(t);
  assert.ok(ENV_CAPABILITIES.includes('env-export') && ENV_CAPABILITIES.includes('env-import'));
  assert.deepEqual(ENV_CAPABILITIES.slice(-4), ['env-export', 'env-import', 'harnesses-into-runtimes', 'env-history']);
  const { result, out } = await exportIt(f, { plan: true });
  assert.deepEqual(JSON.parse(out), result);
  assert.deepEqual([result.schemaVersion, result.agentId, result.soulDir, result.applied, result.decision, result.file], [1, ID, f.dir, false, 'planned', f.archive]);
  assert.ok(!existsSync(f.archive), 'a plan writes nothing');
  assert.deepEqual(f.gates, [], 'a plan asks nobody');
  assert.deepEqual(f.receipts(), []);
  const m = result.manifest;
  assert.deepEqual(Object.keys(m), ['schemaVersion', 'agentId', 'name', 'displayName', 'exportedAt', 'engineVersion', 'root', 'identity', 'memory', 'workspaces', 'journal', 'components', 'excluded', 'totals']);
  assert.deepEqual([m.schemaVersion, m.agentId, m.name, m.displayName, m.exportedAt, m.root], [1, ID, 'billy', 'Billy', NOW.toISOString(), f.dir]);
  assert.equal(m.engineVersion, JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version);
  assert.deepEqual(m.identity, { harness: 'codex', parentId: null, genesis: null, createdAt: readAgentIdentity(ID, { stateDir: f.stateDir }).createdAt });
  assert.deepEqual(m.memory, { location: 'inside', target: null });
  // Every component is classified by the contract, durable, with a hash.
  for (const row of m.components) {
    assert.ok(CLASSIFICATIONS.includes(row.classification), row.entry);
    assert.equal(row.retention, retentionOf(row.classification), row.entry);
    assert.equal(row.retention, 'durable', `${row.entry ?? row.relative} travels only when durable`);
    if (row.relative) assert.equal(row.classification, classifyPath(row.relative), row.relative);
    if (row.kind !== 'dir' && row.entry) assert.match(row.sha256, /^[a-f0-9]{64}$/);
  }
  const relatives = m.components.map((row) => row.relative);
  for (const relative of Object.keys(CARRIED)) assert.ok(relatives.includes(relative), `${relative} travels`);
  assert.ok(relatives.includes('soul.json') && relatives.includes('.soul-state/space/notes/today.md') && relatives.includes('.soul-state/space/space.json') && relatives.includes('.soul-state/migration.json'));
  assert.ok(m.components.some((row) => row.relative === 'sop' && row.kind === 'dir'), 'an empty definition directory travels as itself');
  // What never travels is listed with a reason that names the rule.
  const excluded = Object.fromEntries(m.excluded.map((row) => [row.relative, row.reason]));
  assert.equal(excluded['.soul-state/credentials'], 'credentials never travel');
  assert.equal(excluded['.soul-state/tools/codex/auth.json'], 'codex sign-in file never travels');
  assert.equal(excluded['.soul-state/tools/claude/.credentials.json'], 'claude sign-in file never travels');
  assert.equal(excluded['.soul-state/tools/opencode/data/opencode/auth.json'], 'opencode sign-in file never travels');
  assert.equal(excluded['.soul-state/tools/opencode/cache'], 'opencode cache (reconstructible)');
  assert.equal(excluded['.soul-state/runtimes'], 'runtime (reconstructible)');
  assert.equal(excluded['.soul-state/cache'], 'cache (reconstructible)');
  assert.equal(excluded['.soul-state/tmp'], 'temp (disposable)');
  assert.equal(excluded['CLAUDE.md'], 'generated output (reconstructible; the next build regenerates it)');
  assert.equal(excluded['.soul-state/home/node_modules'], 'harness install (reconstructible; the next launch installs it again)');
  assert.equal(excluded['.soul-state/agent-id'], 'the marker; the import writes it for the imported identity');
  assert.equal(excluded['.soul-state/.space-migrate.lock'], 'transient (a lock or a staging of a run under way)');
  for (const relative of Object.keys(NEVER)) assert.ok(!relatives.includes(relative), `${relative} never travels`);
  // A link elsewhere is a pointer, never followed.
  assert.deepEqual(m.components.find((row) => row.relative === 'host-link'), { area: 'root', entry: null, relative: 'host-link', classification: 'definition', retention: 'durable', kind: 'pointer',
    target: path.join(f.home, 'elsewhere', 'host-file.txt'), bytes: 0, sha256: null, mode: null });
  // The revision journal travels: the adopt event and its stored object.
  assert.ok(m.journal.entries >= 2);
  assert.ok(m.components.some((row) => row.entry === 'journal/0000000000.json' && row.classification === 'history'));
  assert.ok(!JSON.stringify(result).includes(SECRET), 'nothing secret is in the plan');
  // Byte-identical on a rerun.
  assert.deepEqual((await exportIt(f, { plan: true })).result, result);
});

test('a linked worktree becomes a pointer, a patch of tracked changes and its untracked files; the repository never travels', async (t) => {
  const f = fixture(t);
  const { result } = await exportIt(f, { plan: true });
  const m = result.manifest;
  assert.deepEqual(m.workspaces, [
    { name: 'app', location: 'linked', target: f.repo, head: f.head, branch: 'main', remote: null, patch: true, untracked: 1, note: null },
    { name: 'workspace', location: 'inside', target: null, head: null, branch: null, remote: null, patch: false, untracked: 0, note: null },
  ]);
  const app = m.components.filter((row) => row.workspace === 'app');
  assert.deepEqual(app.map((row) => [row.entry, row.kind, row.relative, row.classification]), [
    ['workspaces/app/pointer.json', 'pointer', 'worktrees/app', 'workspace'],
    ['workspaces/app/changes.patch', 'patch', 'worktrees/app', 'workspace'],
    ['workspaces/app/untracked/notes/new.txt', 'file', 'worktrees/app/notes/new.txt', 'workspace'],
  ]);
  assert.equal(app[0].target, f.repo);
  assert.ok(!m.components.some((row) => row.relative?.startsWith('worktrees/app/README.md') || row.entry?.includes('secret.env') || row.entry?.startsWith('workspaces/app/untracked/.git')), 'tracked files, ignored files and the repository stay home');
  assert.ok(!m.components.some((row) => row.area === 'root' && row.relative?.startsWith('worktrees/app/')), 'nothing of the linked checkout is a root entry');
  // The soul-owned workspace travels whole, admin directory included.
  assert.ok(m.components.some((row) => row.relative === 'worktrees/workspace/.git/HEAD'));
  assert.ok(m.components.some((row) => row.relative === 'worktrees/workspace/uncommitted.txt'));
});

test('the export writes one archive the owner approved, never while the soul runs, with sign-ins, credentials, runtimes, caches and temp absent from it', async (t) => {
  const busy = fixture(t, { running: true });
  await assert.rejects(exportIt(busy), (error) => {
    assert.deepEqual([error.code, error.action], ['soul-running', `agent-bot soul stop ${ID}`]);
    return true;
  });
  assert.deepEqual(busy.gates, []);
  assert.ok(!existsSync(busy.archive));
  // A soul that starts between the gate and the write is refused too.
  let asked = 0;
  await assert.rejects(soulEnvExportCommand([ID, '--to', busy.archive], { ...busy.options, write: () => {}, running: async () => asked++ > 0 }), (error) => error.code === 'soul-running');
  await assert.rejects(soulEnvExportCommand([ID, '--to', busy.archive], { ...busy.options, write: () => {}, running: async () => false,
    gate: async () => { throw Object.assign(new Error('owner only'), { code: 'owner-required' }); } }), /owner only/);
  assert.ok(!existsSync(busy.archive));

  const f = fixture(t);
  const { result, out } = await exportIt(f);
  assert.deepEqual(JSON.parse(out), result);
  assert.deepEqual([result.applied, result.decision, result.file], [true, 'exported', f.archive]);
  assert.deepEqual(f.gates, [[`export ${ID}'s life to ${f.archive}`, null]]);
  assert.equal(statSync(f.archive).mode & 0o777, 0o600);
  const entries = listArchive(f.archive);
  assert.equal(entries[0].name, EXPORT_MANIFEST, 'the manifest is the first entry');
  const manifest = JSON.parse(entries[0].body.toString('utf8'));
  assert.deepEqual(manifest, result.manifest);
  const names = entries.map((entry) => entry.name);
  assert.deepEqual(names.filter((name) => !name.startsWith('life/') && !name.startsWith('workspaces/') && !name.startsWith('journal/')), [EXPORT_MANIFEST]);
  for (const relative of Object.keys(NEVER)) assert.ok(!names.some((name) => name === `life/${relative}`), `${relative} is not in the archive`);
  assert.ok(!names.some((name) => /credentials|auth\.json|\.credentials\.json|runtimes|\/cache\/|\/tmp\/|node_modules/.test(name)), names.join('\n'));
  for (const relative of Object.keys(CARRIED)) assert.ok(names.includes(`life/${relative}`), `${relative} is in the archive`);
  assert.ok(names.includes('life/sop/'), 'an empty directory is a directory entry');
  assert.ok(names.includes('workspaces/app/pointer.json') && names.includes('workspaces/app/changes.patch') && names.includes('workspaces/app/untracked/notes/new.txt'));
  assert.ok(entries.every((entry) => entry.type === '0' || entry.type === '5'), 'no symlink or other entry type');
  const raw = gunzipSync(readFileSync(f.archive)).toString('latin1');
  assert.ok(!raw.includes(SECRET), 'no secret byte is in the archive');
  assert.ok(!names.includes('life/CLAUDE.md') && names.some((name) => /^journal\/objects\/.+\/CLAUDE\.md$/.test(name)), 'generated output travels only inside the stored revision packages');
  assert.ok(raw.includes(`${LIFE} memory`) && raw.includes(`${LIFE} history`) && raw.includes(`${LIFE} tracked change`) && raw.includes(`${LIFE} untracked`));
  // Every hash in the manifest is the entry's.
  const { createHash } = await import('node:crypto');
  for (const row of manifest.components) {
    if (!row.entry || row.kind === 'dir') continue;
    const entry = entries.find((e) => e.name === row.entry);
    assert.equal(createHash('sha256').update(entry.body).digest('hex'), row.sha256, row.entry);
    assert.equal(entry.body.length, row.bytes, row.entry);
  }
  // The system tar reads it too.
  const listed = spawnSync('tar', ['-tzf', f.archive], { encoding: 'utf8' });
  if (listed.status === 0) assert.ok(listed.stdout.includes('life/AGENTS.md') && listed.stdout.includes('life/.soul-state/tools/codex/sessions/2026/one.jsonl'));
  // One receipt with counts and the path, never contents.
  const receipts = f.receipts();
  assert.equal(receipts.length, 1);
  assert.deepEqual([receipts[0].event, receipts[0].agentId, receipts[0].operation, receipts[0].decision], ['soul-env-export', ID, 'export', 'exported']);
  assert.ok(receipts[0].detail.includes(f.archive) && receipts[0].detail.includes('1 linked workspace(s)') && !receipts[0].detail.includes(LIFE));
  // The soul is untouched and a second export to the same file is refused.
  assert.equal(readFileSync(path.join(f.dir, '.soul-state', 'credentials', 'github-app-billy.json'), 'utf8'), `${SECRET} credential`);
  await assert.rejects(exportIt(f), (error) => error.code === 'export-target-exists');
  await assert.rejects(soulEnvExportCommand([ID, '--to', path.join(f.dir, 'x.tgz')], { ...f.options, write: () => {} }), (error) => error.code === 'export-target-inside-root');
  await assert.rejects(soulEnvExportCommand(['nobody', '--to', path.join(f.home, 'y.tgz')], { ...f.options, write: () => {} }), (error) => error.code === 'soul-not-found');
  await assert.rejects(soulEnvExportCommand([ID], f.options), /usage: agent-bot soul env export/);
});

test('a linked Agent Space is read through its link, so the life carries the memory and it lands inside on import', async (t) => {
  const f = fixture(t, { linkedSpace: true });
  const { result } = await exportIt(f);
  assert.deepEqual(result.manifest.memory, { location: 'linked', target: f.space });
  assert.ok(result.manifest.components.some((row) => row.relative === '.soul-state/space/notes/today.md' && row.classification === 'memory'));
  assert.ok(!result.manifest.components.some((row) => row.relative === '.soul-state/space' && row.kind === 'pointer'));
});

// A second scratch host: a different HOME with nothing registered, where
// the archive is imported.
function host(t) {
  const home = mkdtempSync(path.join(realpathSync(tmpdir()), 'sx-host-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const env = { PATH: process.env.PATH, HOME: home, XDG_STATE_HOME: path.join(home, 'state'), AGENT_BOT_SOULS_HOME: path.join(home, 'souls'),
    AGENT_BOT_SPACES_HOME: path.join(home, 'spaces'), AGENT_BOT_POPULATION_PATH: path.join(home, 'population.json'),
    AGENT_BOT_DAEMON_STATE_PATH: path.join(home, 'daemon.json'), AGENT_BOT_CONFIG: path.join(home, 'no-config') };
  const gates = [];
  const options = { env, home, cwd: home, file: env.AGENT_BOT_POPULATION_PATH, stateDir: stateDirectory({ env, home }), config: {}, now: () => NOW,
    gate: async (action, { principal }) => { gates.push([action, principal]); return { method: 'consent' }; }, running: async () => false };
  return { home, env, options, gates, file: env.AGENT_BOT_POPULATION_PATH, stateDir: options.stateDir, receipts: () => lines(auditFile({ env, home })) };
}

async function importIt(h, archive, args = []) {
  let out = '';
  const result = await soulEnvImportCommand([archive, '--json', ...args], { ...h.options, write: (v) => { out += v; } });
  return { result, out };
}

test('import round-trip on another host keeps the Agent ID and restores the life: memory, history, tool state, journal, linked workspaces as pointers', async (t) => {
  const f = fixture(t);
  await exportIt(f);
  const h = host(t);
  // The plan decides identity and destination without extracting.
  const { result: planned, out } = await importIt(h, f.archive, ['--plan']);
  assert.deepEqual(JSON.parse(out), planned);
  assert.deepEqual(planned.identity, { decision: 'keep', agentId: ID, importedFrom: ID, existing: null });
  assert.deepEqual([planned.applied, planned.decision, planned.soulDir, planned.replaced, planned.name, planned.displayName, planned.journal, planned.migration],
    [false, 'planned', path.join(h.env.AGENT_BOT_SOULS_HOME, 'billy.soul'), null, 'billy', 'Billy', null, LIFE_IMPORT_STEP_ID]);
  assert.ok(planned.restored.files > 10 && planned.restored.byClassification.memory.files === 2 && planned.restored.byClassification.history.files >= 3);
  assert.deepEqual(planned.pointers, [{ relative: 'host-link', target: path.join(f.home, 'elsewhere', 'host-file.txt') }]);
  assert.deepEqual(planned.workspaces.map((w) => [w.name, w.target, w.patch, w.untracked, w.imported]), [['app', f.repo, true, 1, `${IMPORTS_DIRECTORY}/app`]]);
  assert.deepEqual(h.gates, []);
  assert.deepEqual(readdirSync(h.home).sort(), [], 'a plan writes nothing');

  const { result } = await importIt(h, f.archive);
  assert.deepEqual([result.applied, result.decision, result.identity.agentId, result.journal, result.replaced], [true, 'imported', ID, 'restored', null]);
  assert.deepEqual(h.gates, [[`import ${ID}'s life from ${f.archive}`, null]]);
  const dir = result.soulDir;
  assert.equal(dir, path.join(h.env.AGENT_BOT_SOULS_HOME, 'billy.soul'));
  // The census row, the identity record and the marker all name the kept ID.
  const soul = showSoul(ID, { file: h.file });
  assert.deepEqual([soul.name, soul.displayName, soul.status, soul.soulDir, soul.spacePath], ['billy', 'Billy', 'active', dir, path.join(dir, '.soul-state', 'space')]);
  assert.equal(readAgentIdentity(ID, { stateDir: h.stateDir }).harness, 'codex');
  assert.equal(readFileSync(path.join(dir, '.soul-state', 'agent-id'), 'utf8'), `${ID}\n`);
  for (const [relative, contents] of Object.entries(CARRIED)) assert.equal(readFileSync(path.join(dir, relative), 'utf8'), contents, relative);
  assert.equal(readFileSync(path.join(dir, '.soul-state', 'space', 'notes', 'today.md'), 'utf8'), `# Today\n${LIFE} memory\n`);
  assert.equal(JSON.parse(readFileSync(path.join(dir, '.soul-state', 'space', 'space.json'), 'utf8')).agentId, ID);
  assert.ok(statSync(path.join(dir, 'sop')).isDirectory());
  for (const relative of Object.keys(NEVER)) assert.ok(!existsSync(path.join(dir, relative)), `${relative} was never restored`);
  assert.ok(!existsSync(path.join(dir, 'host-link')), 'a pointer is not recreated as a link');
  assert.ok(!existsSync(path.join(dir, '.journal')));
  // The revision journal continues where it left off.
  assert.deepEqual(revisionHistory(ID, { stateDir: h.stateDir }).map((e) => e.reason), ['Adopt starting package']);
  // The linked workspace is a pointer with the patch and untracked files, not a clone.
  const imports = path.join(dir, '.soul-state', 'imports', 'app');
  const pointer = JSON.parse(readFileSync(path.join(imports, 'pointer.json'), 'utf8'));
  assert.deepEqual([pointer.name, pointer.target, pointer.head, pointer.branch, pointer.patch, pointer.untracked], ['app', f.repo, f.head, 'main', 'changes.patch', ['notes/new.txt']]);
  assert.ok(readFileSync(path.join(imports, 'changes.patch'), 'utf8').includes(`+${LIFE} tracked change`));
  assert.equal(readFileSync(path.join(imports, 'untracked', 'notes', 'new.txt'), 'utf8'), `${LIFE} untracked\n`);
  assert.ok(!existsSync(path.join(dir, 'worktrees', 'app')), 'nothing is cloned or linked');
  assert.equal(readFileSync(path.join(dir, 'worktrees', 'workspace', 'uncommitted.txt'), 'utf8'), CARRIED['worktrees/workspace/uncommitted.txt']);
  // The migration journal records the import; the descriptor shows the soul and the workspace to link again.
  const step = readMigrationStep(dir, LIFE_IMPORT_STEP_ID);
  assert.deepEqual([step.status, step.from, step.to, step.identity, step.journal, step.workspaces, step.space], ['done', f.archive, dir, { decision: 'keep', agentId: ID, importedFrom: ID }, 'restored', ['app'], 'restored']);
  const descriptor = readSoulEnvironment(ID, { env: h.env, home: h.home, config: {} });
  assert.deepEqual([descriptor.root.registered, descriptor.root.marker, component(descriptor, 'memory').contained], [true, 'ok', true]);
  assert.deepEqual(component(descriptor, 'workspaces').imported.map((w) => [w.name, w.target, w.branch, w.linked]), [['app', f.repo, 'main', false]]);
  const unlinked = descriptor.readiness.problems.find((p) => p.code === 'workspace-unlinked');
  assert.equal(unlinked.severity, 'warning');
  assert.ok(unlinked.action.includes(path.join(dir, 'worktrees', 'app')));
  assert.ok(descriptor.migration.steps.some((s) => s.id === LIFE_IMPORT_STEP_ID && s.status === 'done'));
  const receipts = h.receipts();
  assert.equal(receipts.length, 1);
  assert.deepEqual([receipts[0].event, receipts[0].agentId, receipts[0].decision], ['soul-env-import', ID, 'imported']);
  assert.ok(!JSON.stringify(receipts).includes(LIFE));
  // The same ID, now active here, is refused a second time.
  await assert.rejects(importIt(h, f.archive), (error) => {
    assert.deepEqual([error.code, error.action], ['import-id-active', 'add --replace to overwrite its life, or --fork to import as a new soul']);
    return true;
  });
  assert.equal(h.gates.length, 1, 'a refused import asks nobody');
  assert.deepEqual(readdirSync(h.env.AGENT_BOT_SOULS_HOME).sort(), ['billy.soul'], 'no staging is left behind');
});

test('--replace moves the active root aside (never deletes) once the soul is stopped and the owner agreed', async (t) => {
  const f = fixture(t);
  await exportIt(f);
  // The exported soul keeps living: a newer memory note that the replace must keep aside, not destroy.
  put(path.join(f.dir, '.soul-state', 'space', 'notes', 'later.md'), 'written after the export\n');
  f.gates.length = 0;
  const busy = { ...f.options, running: async () => true };
  await assert.rejects(soulEnvImportCommand([f.archive, '--replace'], { ...busy, write: () => {} }), (error) => {
    assert.deepEqual([error.code, error.action], ['soul-running', `agent-bot soul stop ${ID}`]);
    return true;
  });
  assert.deepEqual(f.gates, []);
  // Without --replace the active ID is refused; the plan says what --replace would do.
  await assert.rejects(importIt({ options: f.options }, f.archive), (error) => error.code === 'import-id-active');
  const { result: planned } = await importIt({ options: f.options }, f.archive, ['--replace', '--plan']);
  assert.deepEqual(planned.identity, { decision: 'replace', agentId: ID, importedFrom: ID, existing: { status: 'active', soulDir: f.dir } });
  assert.deepEqual([planned.soulDir, planned.replaced], [f.dir, f.dir]);
  let asked = 0;
  await assert.rejects(soulEnvImportCommand([f.archive, '--replace'], { ...f.options, write: () => {}, running: async () => asked++ > 0 }), (error) => error.code === 'soul-running');
  f.gates.length = 0;
  const { result } = await importIt({ options: f.options }, f.archive, ['--replace']);
  assert.deepEqual([result.decision, result.identity.decision, result.identity.agentId, result.soulDir, result.journal], ['replaced', 'replace', ID, f.dir, 'kept-local']);
  assert.deepEqual(f.gates, [[`import ${ID}'s life from ${f.archive}, replacing the soul here`, null]]);
  assert.equal(result.replaced, `${f.dir}.replaced-${NOW.toISOString().replace(/[:.]/g, '-')}`);
  assert.ok(statSync(result.replaced).isDirectory());
  assert.equal(readFileSync(path.join(result.replaced, '.soul-state', 'space', 'notes', 'later.md'), 'utf8'), 'written after the export\n', 'the previous root is aside, whole');
  assert.equal(readFileSync(path.join(result.replaced, '.soul-state', 'credentials', 'github-app-billy.json'), 'utf8'), `${SECRET} credential`);
  assert.ok(!existsSync(path.join(f.dir, '.soul-state', 'space', 'notes', 'later.md')), 'the restored root is the archive, not a merge');
  assert.ok(!existsSync(path.join(f.dir, '.soul-state', 'credentials')), 'credentials were not carried over');
  assert.equal(readFileSync(path.join(f.dir, 'AGENTS.md'), 'utf8'), CARRIED['AGENTS.md']);
  const soul = showSoul(ID, { file: f.file });
  assert.deepEqual([soul.status, soul.soulDir, soul.spacePath], ['active', f.dir, path.join(f.dir, '.soul-state', 'space')]);
  assert.deepEqual(revisionHistory(ID, { stateDir: f.stateDir }).length, 1, 'the local revision chain is kept');
  assert.deepEqual(f.receipts().map((r) => [r.event, r.decision]), [['soul-env-export', 'exported'], ['soul-env-import', 'replaced']]);
});

test('--fork mints a new Agent ID with its own identity, revision chain and space binding; the census shows both souls', async (t) => {
  const f = fixture(t);
  await exportIt(f);
  const { result: planned } = await importIt({ options: f.options }, f.archive, ['--fork', '--plan']);
  assert.deepEqual(planned.identity, { decision: 'fork', agentId: null, importedFrom: ID, existing: { status: 'active', soulDir: f.dir } });
  assert.equal(planned.soulDir, path.join(f.env.AGENT_BOT_SOULS_HOME, 'billy-<agent id tail>.soul'), 'the default folder is the original\'s, so the fork gets the minted ID\'s tail');
  f.gates.length = 0;
  const { result } = await importIt({ options: f.options }, f.archive, ['--fork', '--name', 'Billy Two']);
  assert.deepEqual([result.decision, result.identity.decision, result.identity.importedFrom, result.journal, result.displayName], ['forked', 'fork', ID, 'adopted', 'Billy Two']);
  const forked = result.identity.agentId;
  assert.notEqual(forked, ID);
  assert.match(forked, /^agent_/);
  assert.deepEqual(f.gates, [[`import a fork of ${ID}'s life from ${f.archive}`, null]]);
  assert.equal(result.soulDir, path.join(f.env.AGENT_BOT_SOULS_HOME, `billy-${forked.slice(-8)}.soul`), 'the default name is taken, so the folder carries the ID tail');
  const dir = result.soulDir;
  assert.equal(readFileSync(path.join(dir, '.soul-state', 'agent-id'), 'utf8'), `${forked}\n`);
  assert.equal(JSON.parse(readFileSync(path.join(dir, '.soul-state', 'space', 'space.json'), 'utf8')).agentId, forked, 'the memory is bound to the fork');
  assert.equal(readFileSync(path.join(dir, '.soul-state', 'space', 'notes', 'today.md'), 'utf8'), `# Today\n${LIFE} memory\n`);
  assert.equal(readFileSync(path.join(dir, '.soul-state', 'runs', 'turns.jsonl'), 'utf8').startsWith(CARRIED['.soul-state/runs/turns.jsonl']), true);
  const manifest = JSON.parse(readFileSync(path.join(dir, 'soul.json'), 'utf8'));
  assert.deepEqual([manifest.credentials, manifest.template, manifest.displaySeed, manifest.name], [undefined, false, forked, 'Billy']);
  const identity = readAgentIdentity(forked, { stateDir: f.stateDir });
  assert.deepEqual([identity.harness, identity.parentId, identity.status], ['codex', null, 'active']);
  assert.equal(identity.genesis.revision, revisionHistory(forked, { stateDir: f.stateDir })[0].revision);
  assert.deepEqual(revisionHistory(forked, { stateDir: f.stateDir }).map((e) => e.reason), [`Import as a fork of ${ID}`, 'Initialize display seed from imported identity']);
  assert.equal(manifest.revision, revisionHistory(forked, { stateDir: f.stateDir }).at(-1).revision);
  const both = listSouls({ file: f.file });
  assert.deepEqual(both.map((s) => [s.id, s.status, s.displayName]).sort(), [[ID, 'active', 'Billy'], [forked, 'active', 'Billy Two']].sort());
  assert.equal(showSoul(forked, { file: f.file }).soulDir, dir);
  assert.equal(showSoul(ID, { file: f.file }).soulDir, f.dir, 'the original is untouched');
  assert.equal(readFileSync(path.join(f.dir, '.soul-state', 'agent-id'), 'utf8'), `${ID}\n`);
  assert.ok(readSoulEnvironment(forked, { env: f.env, home: f.home, config: {} }).root.registered);
  assert.deepEqual(readMigrationStep(dir, LIFE_IMPORT_STEP_ID).identity, { decision: 'fork', agentId: forked, importedFrom: ID });
  assert.deepEqual(f.receipts().at(-1).decision, 'forked');
  // The same archive forked again is another soul with another ID.
  const again = await importIt({ options: f.options }, f.archive, ['--fork']);
  assert.notEqual(again.result.identity.agentId, forked);
  assert.equal(listSouls({ file: f.file }).length, 3);
});

test('a retired ID comes back only as a fork, and a moved life with no journal in the archive is adopted', async (t) => {
  const f = fixture(t, { journal: false });
  await exportIt(f);
  const h = host(t);
  const { result } = await importIt(h, f.archive);
  assert.equal(result.journal, 'adopted');
  assert.deepEqual(revisionHistory(ID, { stateDir: h.stateDir }).map((e) => e.reason), [`Import of a moved life from ${f.dir}`]);
  // Retire it there: the tombstone refuses the ID, even with --replace.
  const { retireIdentityWithPopulation } = await import('../agent-population.mjs');
  retireIdentityWithPopulation(ID, { file: h.file, stateDir: h.stateDir, now: () => NOW });
  await assert.rejects(importIt(h, f.archive, ['--replace']), (error) => {
    assert.deepEqual([error.code, error.action], ['import-id-retired', 'add --fork to import it as a new soul']);
    return true;
  });
  const forked = await importIt(h, f.archive, ['--fork']);
  assert.equal(forked.result.decision, 'forked');
});

test('a tampered hash, a traversal entry, a symlink entry, a stranger entry and a missing manifest are refused before anything reaches the souls root', async (t) => {
  const f = fixture(t);
  await exportIt(f);
  const h = host(t);
  const tampered = path.join(h.home, 'tampered.tgz');
  const cases = [
    ['import-checksum-mismatch', (entries) => { const e = entries.find((x) => x.name === 'life/AGENTS.md'); e.body = Buffer.from(`${e.body.toString()}tampered\n`); }],
    ['import-checksum-mismatch', (entries) => { const e = entries.find((x) => x.name === 'life/AGENTS.md'); e.body = Buffer.from('changed with the same length'.padEnd(e.body.length, '!')); }],
    ['import-unsafe-archive', (entries) => { entries.push({ name: 'life/../escape.txt', type: '0', body: Buffer.from('x') }); }],
    ['import-unsafe-archive', (entries) => { entries.push({ name: '/etc/passwd', type: '0', body: Buffer.from('x') }); }],
    ['import-unsafe-archive', (entries) => { entries.push({ name: 'life/link', type: '2', linkname: '/etc', body: Buffer.alloc(0) }); }],
    ['import-unsafe-archive', (entries) => { entries.push({ name: 'life/stranger.txt', type: '0', body: Buffer.from('not in the manifest') }); }],
    ['import-unsafe-archive', (entries) => { entries.push({ name: 'other/outside-prefix.txt', type: '0', body: Buffer.from('x') }); }],
    ['import-unsafe-archive', (entries) => { const m = entries[0]; const manifest = JSON.parse(m.body.toString()); manifest.components.push({ area: 'root', entry: 'life/../../x', relative: '../../x', classification: 'definition', retention: 'durable', kind: 'file', bytes: 1, sha256: 'a'.repeat(64), mode: 0o600 }); m.body = Buffer.from(JSON.stringify(manifest)); }],
    ['import-unsafe-archive', (entries) => { entries.shift(); }],
    ['import-archive-incomplete', (entries) => { const at = entries.findIndex((x) => x.name === 'life/AGENTS.md'); entries.splice(at, 1); }],
    ['import-manifest-invalid', (entries) => { entries[0].body = Buffer.from('{"schemaVersion":2}'); }],
    ['import-manifest-invalid', (entries) => { const m = entries[0]; const manifest = JSON.parse(m.body.toString()); manifest.components[1].classification = 'cache'; m.body = Buffer.from(JSON.stringify(manifest)); }],
  ];
  for (const [code, edit] of cases) {
    rmSync(tampered, { force: true });
    rewriteArchive(f.archive, tampered, edit);
    await assert.rejects(importIt(h, tampered), (error) => { assert.equal(error.code, code, `${code}: ${error.message}`); return true; });
    assert.ok(!existsSync(path.join(h.env.AGENT_BOT_SOULS_HOME, 'billy.soul')), `${code}: nothing restored`);
    assert.deepEqual(readdirSync(h.env.AGENT_BOT_SOULS_HOME).filter((n) => n.startsWith('.import-')), [], `${code}: no staging left`);
    assert.throws(() => showSoul(ID, { file: h.file }), /no population record/);
  }
  writeFileSync(path.join(h.home, 'not-an-archive.tgz'), 'plain text');
  await assert.rejects(importIt(h, path.join(h.home, 'not-an-archive.tgz')), (error) => error.code === 'import-archive-invalid');
  await assert.rejects(importIt(h, path.join(h.home, 'missing.tgz')), (error) => error.code === 'import-archive-missing');
  await assert.rejects(soulEnvImportCommand([f.archive, '--fork', '--replace'], h.options), /usage: agent-bot soul env export/);
  // A rewritten archive with short ustar names and nothing tampered still imports.
  rmSync(tampered, { force: true });
  rewriteArchive(f.archive, tampered, () => {});
  assert.equal((await importIt(h, tampered)).result.decision, 'imported');
});

test('the library surface: the plan maps entries to sources and the writer refuses a file that changed; the manifest reader needs only the first entry', async (t) => {
  const f = fixture(t);
  const soul = showSoul(ID, { file: f.file });
  const plan = planSoulExport(f.dir, { agentId: ID, name: soul.name, displayName: soul.displayName, spacePath: soul.spacePath, stateDir: f.stateDir, env: f.env, home: f.home, now: () => NOW });
  assert.ok(plan.sources.get('life/AGENTS.md').file === path.join(f.dir, 'AGENTS.md'));
  assert.ok(Buffer.isBuffer(plan.sources.get('workspaces/app/pointer.json').bytes));
  put(path.join(f.dir, 'AGENTS.md'), '# changed after the plan\n');
  const target = path.join(f.home, 'changed.tgz');
  await assert.rejects(writeSoulExport(plan, target, { now: () => NOW }), (error) => error.code === 'export-changed');
  assert.ok(!existsSync(target) && !readdirSync(f.home).some((n) => n.includes('.tmp')), 'no partial archive is left');
  const fresh = planSoulExport(f.dir, { agentId: ID, name: soul.name, displayName: soul.displayName, spacePath: soul.spacePath, stateDir: f.stateDir, env: f.env, home: f.home, now: () => NOW });
  await writeSoulExport(fresh, target, { now: () => NOW });
  const manifest = await readExportManifest(target);
  assert.deepEqual(manifest, fresh.manifest);
});

test('the CLI entry prints JSON errors with code, message and action, and text otherwise', (t) => {
  const f = fixture(t);
  const run = (args) => spawnSync(process.execPath, [path.join(ROOT, 'soul-env-export.mjs'), ...args], { encoding: 'utf8', env: f.env, cwd: f.home });
  const planned = run(['export', ID, '--to', f.archive, '--plan']);
  assert.equal(planned.status, 0, planned.stderr);
  assert.ok(planned.stdout.includes(`agentId: ${ID}`) && planned.stdout.includes('excluded (') && planned.stdout.includes('app: linked ->'));
  assert.ok(!planned.stdout.includes(SECRET));
  const missing = run(['import', path.join(f.home, 'nope.tgz'), '--json']);
  assert.equal(missing.status, 1);
  assert.deepEqual(Object.keys(JSON.parse(missing.stdout).error), ['code', 'message', 'action']);
  assert.equal(JSON.parse(missing.stdout).error.code, 'import-archive-missing');
  const usage = run(['frobnicate']);
  assert.equal(usage.status, 1);
  assert.match(usage.stderr, /usage: agent-bot soul env export/);
  const dispatched = spawnSync(process.execPath, [path.join(ROOT, 'agent-bot.mjs'), 'soul', 'env', 'export', ID, '--plan', '--json'], { encoding: 'utf8', env: f.env, cwd: f.home });
  assert.equal(dispatched.status, 0, dispatched.stderr);
  assert.equal(JSON.parse(dispatched.stdout).decision, 'planned');
  assert.ok(lstatSync(f.dir).isDirectory());
});
