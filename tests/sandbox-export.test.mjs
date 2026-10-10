import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { mintAgentIdentity, stateDirectory } from '../agent-identity.mjs';
import { upsertSoul } from '../agent-population.mjs';
import { auditFile } from '../agent-principals.mjs';
import { soulEnvExportCommand } from '../soul-env-export.mjs';
import { PACKAGE_IGNORE_LIST, computePackageRevision } from '../soul-package.mjs';
import { EXPORT_CATEGORIES, incomingRoot, outgoingRoot, runSandboxExport, sandboxExportCommand, verifySandboxExport } from '../sandbox-export.mjs';

const A = 'agent_12345678-1234-4234-8234-123456789abc';
const B = 'agent_12345678-1234-4234-8234-123456789def';
const NEVER_RAN = 'agent_12345678-1234-4234-8234-1234567890aa';
const ORPHAN = 'agent_12345678-1234-4234-8234-1234567890bb';
const NOW = new Date('2026-10-10T17:00:00Z');
const STAMP = '2026-10-10T17-00-00Z';
const put = (file, contents) => { mkdirSync(path.dirname(file), { recursive: true }); writeFileSync(file, contents); };
const mode = (file) => statSync(file).mode & 0o777;
const lines = (file) => { try { return readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line)); } catch { return []; } };

// The smallest archive `soul env export` would accept as a life: a ustar
// whose first entry is a valid manifest for the soul.
function fakeSoulArchive(agentId, target) {
  const dir = mkdtempSync(path.join(tmpdir(), 'soul-archive-'));
  try {
    writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({ schemaVersion: 1, agentId, name: null, displayName: null, components: [], excluded: [] }));
    execFileSync('tar', ['--format=ustar', '-czf', target, '-C', dir, 'manifest.json']);
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

// The persona account: two souls that ran, one census row that never did, a
// space no soul owns, and a Claude session store. The owner's account is a
// second scratch HOME. Nothing touches the real HOME or runs sudo.
function fixture(t) {
  const base = mkdtempSync(path.join(realpathSync(tmpdir()), 'sandbox-export-'));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const home = path.join(base, 'persona');
  const ownerHome = path.join(base, 'owner');
  mkdirSync(ownerHome, { recursive: true });
  const env = { HOME: home, XDG_STATE_HOME: path.join(home, 'state'), AGENT_BOT_SOULS_HOME: path.join(home, 'souls'),
    AGENT_BOT_SPACES_HOME: path.join(home, 'spaces'), AGENT_BOT_POPULATION_PATH: path.join(home, 'population.json'),
    AGENT_BOT_CONFIG: path.join(home, 'no-config') };
  for (const id of [A, B, NEVER_RAN]) {
    upsertSoul({ id, name: `soul-${id.slice(-4)}`, displayName: null, soulDir: path.join(env.AGENT_BOT_SOULS_HOME, `${id}.soul`), spacePath: path.join(env.AGENT_BOT_SPACES_HOME, id), status: 'active', parentId: null, appSlug: null }, { file: env.AGENT_BOT_POPULATION_PATH });
  }
  put(path.join(env.AGENT_BOT_SPACES_HOME, ORPHAN, 'notes.md'), 'an orphaned space\n');
  put(path.join(env.AGENT_BOT_SPACES_HOME, A, 'notes.md'), 'A\'s own space travels in its archive\n');
  put(path.join(home, '.claude', 'projects', 'p', 'session.jsonl'), '{"turn":1}\n');
  const gates = [];
  const exported = [];
  let failOn = null;
  const exportSoul = async (agentId, target) => {
    if (agentId === NEVER_RAN) throw Object.assign(new Error('no .soul-state'), { code: 'soul-state-missing' });
    if (agentId === failOn) throw Object.assign(new Error(`${agentId} is running`), { code: 'soul-running' });
    exported.push(agentId);
    fakeSoulArchive(agentId, target);
  };
  const options = { env, home, cwd: home, account: 'geniusbar-agent', now: () => NOW, exportSoul,
    gate: async (action) => { gates.push(action); } };
  const ownerOptions = { env: { HOME: ownerHome, XDG_STATE_HOME: path.join(ownerHome, 'state') }, home: ownerHome, cwd: ownerHome, owner: 'owner', now: () => NOW };
  // What the printed copy commands do, minus sudo: the drop lands privately
  // under the owner's exports, owned by the owner (here, the test's user).
  const copy = (drop) => {
    const into = path.join(incomingRoot('geniusbar-agent', { home: ownerHome }), path.basename(drop));
    mkdirSync(path.dirname(into), { recursive: true, mode: 0o700 });
    chmodSync(path.dirname(into), 0o700);
    cpSync(drop, into, { recursive: true });
    execFileSync('chmod', ['-R', 'go-rwx', into]);
    return into;
  };
  return { home, ownerHome, env, options, ownerOptions, gates, exported, copy, failOn: (id) => { failOn = id; },
    receipts: (h = home) => lines(auditFile({ env: { HOME: h, XDG_STATE_HOME: path.join(h, 'state') }, home: h })) };
}

test('an export writes each confirmed category privately with a manifest of hashes, and prints the copy for the owner to run (#750)', async (t) => {
  const f = fixture(t);
  const result = await runSandboxExport({ ...f.options, owner: 'owner' });
  const drop = path.join(outgoingRoot({ home: f.home }), STAMP);
  assert.equal(result.dropFolder, drop);
  // One owner gate per category, each before that category is written.
  assert.equal(f.gates.length, 3);
  assert.match(f.gates[0], /^export 3 soul\(s\) from geniusbar-agent/);
  assert.match(f.gates[1], /^export 1 workspaces archive/);
  assert.match(f.gates[2], /^export 1 transcripts archive/);
  assert.deepEqual(f.exported, [A, B]);
  // Private all the way down.
  for (const dir of [path.join(f.home, '.agent-bot', 'exports'), outgoingRoot({ home: f.home }), drop, path.join(drop, 'souls')]) assert.equal(mode(dir), 0o700, dir);
  const manifest = JSON.parse(readFileSync(path.join(drop, 'manifest.json'), 'utf8'));
  assert.equal(mode(path.join(drop, 'manifest.json')), 0o600);
  assert.deepEqual({ account: manifest.account, for: manifest.for }, { account: 'geniusbar-agent', for: 'owner' });
  assert.deepEqual(manifest.files.map((entry) => entry.path).sort(), [`souls/${A}.soul.tgz`, `souls/${B}.soul.tgz`, 'transcripts/claude-projects.tgz', `workspaces/${ORPHAN}.tgz`].sort());
  for (const entry of manifest.files) {
    assert.match(entry.sha256, /^[0-9a-f]{64}$/);
    assert.equal(statSync(path.join(drop, entry.path)).size, entry.bytes);
    assert.equal(mode(path.join(drop, entry.path)), 0o600);
  }
  assert.deepEqual(manifest.unexported, [{ agentId: NEVER_RAN, reason: 'no .soul-state: the soul never ran' }]);
  assert.deepEqual(Object.keys(manifest.categories), EXPORT_CATEGORIES);
  // A's own space is not a workspace of its own: it travels in A's archive.
  assert.ok(!manifest.files.some((entry) => entry.path.includes(`workspaces/${A}`)));
  // agent-bot prints sudo, never runs it; the copy ends with the verify.
  assert.ok(result.copy.some((command) => command.startsWith('sudo /usr/bin/ditto ')));
  assert.equal(result.copy[0], 'mkdir -p -m 700 ~/.agent-bot/exports ~/.agent-bot/exports/geniusbar-agent');
  assert.equal(result.copy.at(-1), `agent-bot sandbox export --verify geniusbar-agent --dir ~/.agent-bot/exports/geniusbar-agent/${STAMP}`);
  assert.equal(f.receipts().at(-1).decision, 'exported');
  // Nothing in the persona account was removed.
  assert.ok(existsSync(path.join(f.env.AGENT_BOT_SPACES_HOME, ORPHAN, 'notes.md')));
  assert.ok(existsSync(path.join(f.home, '.claude', 'projects', 'p', 'session.jsonl')));
});

test('verify reads every copied file back against the manifest and records it only when all match', async (t) => {
  const f = fixture(t);
  const { dropFolder } = await runSandboxExport({ ...f.options, owner: 'owner' });
  const copied = f.copy(dropFolder);
  const result = await verifySandboxExport('geniusbar-agent', f.ownerOptions);
  assert.deepEqual({ verified: result.verified, files: result.files, dir: result.dir }, { verified: true, files: 4, dir: copied });
  const verified = JSON.parse(readFileSync(path.join(copied, 'verified.json'), 'utf8'));
  assert.equal(verified.files, 4);
  assert.equal(f.receipts(f.ownerHome).at(-1).decision, 'verified');

  // A copy that differs from what was exported is refused and not recorded.
  rmSync(path.join(copied, 'verified.json'));
  writeFileSync(path.join(copied, 'souls', `${A}.soul.tgz`), 'not the archive');
  chmodSync(path.join(copied, 'souls', `${A}.soul.tgz`), 0o600);
  await assert.rejects(verifySandboxExport('geniusbar-agent', { ...f.ownerOptions, dir: copied }), (error) => error.code === 'sandbox-export-unverified' && error.message.includes('(changed)'));
  assert.ok(!existsSync(path.join(copied, 'verified.json')));
  rmSync(path.join(copied, 'transcripts', 'claude-projects.tgz'));
  await assert.rejects(verifySandboxExport('geniusbar-agent', { ...f.ownerOptions, dir: copied }), (error) => /\(missing\)/.test(error.message));
});

test('verify refuses a copy others can read, one made for someone else, and one outside the exports folder', async (t) => {
  const f = fixture(t);
  const { dropFolder } = await runSandboxExport({ ...f.options, owner: 'owner' });
  const copied = f.copy(dropFolder);
  chmodSync(copied, 0o755);
  await assert.rejects(verifySandboxExport('geniusbar-agent', f.ownerOptions), (error) => error.code === 'sandbox-export-not-private' && /chmod go-rwx/.test(error.action));
  chmodSync(copied, 0o700);
  await assert.rejects(verifySandboxExport('geniusbar-agent', { ...f.ownerOptions, owner: 'someone-else' }), { code: 'sandbox-export-wrong-owner' });
  await assert.rejects(verifySandboxExport('geniusbar-agent', { ...f.ownerOptions, dir: dropFolder }), { code: 'usage' });
  await assert.rejects(verifySandboxExport('other-account', f.ownerOptions), { code: 'sandbox-export-not-found' });
  await assert.rejects(verifySandboxExport('../etc', f.ownerOptions), { code: 'usage' });
});

test('a failure stops where it is, leaves everything in place, and --resume carries on from what was verified (#750)', async (t) => {
  const f = fixture(t);
  f.failOn(B);
  const failed = await runSandboxExport({ ...f.options, owner: 'owner' }).then(() => null, (error) => error);
  assert.equal(failed.code, 'soul-running');
  const drop = failed.dropFolder;
  assert.equal(failed.action, `agent-bot sandbox export --for owner --resume ${drop}`);
  assert.ok(!existsSync(path.join(drop, 'manifest.json')), 'an unfinished export has no manifest');
  assert.ok(existsSync(path.join(drop, 'souls', `${A}.soul.tgz`)), 'what was written stays');
  assert.equal(f.receipts().at(-1).decision, 'failed');
  assert.equal(f.gates.length, 1, 'later categories were never asked');

  // An unfinished export cannot be verified on the owner's side.
  await assert.rejects(verifySandboxExport('geniusbar-agent', { ...f.ownerOptions, dir: f.copy(drop) }), { code: 'sandbox-export-invalid' });

  f.failOn(null);
  f.gates.length = 0;
  f.exported.length = 0;
  const later = { ...f.options, now: () => new Date('2026-10-10T18:00:00Z') };
  const resumed = await runSandboxExport({ ...later, owner: 'owner', resume: drop });
  assert.equal(resumed.dropFolder, drop);
  assert.deepEqual(f.exported, [B], 'A is not exported twice');
  assert.equal(f.gates.length, 3);
  assert.match(f.gates[0], /^export 2 soul\(s\)/, 'the gate names only what is left');
  assert.equal(resumed.manifest.files.length, 4);
  await assert.rejects(runSandboxExport({ ...later, owner: 'owner', resume: drop }), { code: 'sandbox-export-complete' });
});

test('resume refuses a file that changed since it was written, and a folder that is not an unfinished export', async (t) => {
  const f = fixture(t);
  f.failOn(B);
  const { dropFolder: drop } = await runSandboxExport({ ...f.options, owner: 'owner' }).then(() => null, (error) => error);
  writeFileSync(path.join(drop, 'souls', `${A}.soul.tgz`), 'changed');
  f.failOn(null);
  await assert.rejects(runSandboxExport({ ...f.options, owner: 'owner', resume: drop }), { code: 'sandbox-export-changed' });
  await assert.rejects(runSandboxExport({ ...f.options, owner: 'someone-else', resume: drop }), { code: 'sandbox-export-resume-invalid' });
  await assert.rejects(runSandboxExport({ ...f.options, owner: 'owner', resume: f.home }), { code: 'usage' });
});

test('a declined category stops before it is written; --skip leaves one out; the owner\'s own account is refused', async (t) => {
  const f = fixture(t);
  const declined = Object.assign(new Error('the owner declined'), { code: 'owner-declined' });
  let asked = 0;
  const gate = async () => { asked += 1; if (asked === 2) throw declined; };
  const error = await runSandboxExport({ ...f.options, owner: 'owner', gate }).then(() => null, (e) => e);
  assert.equal(error.code, 'owner-declined');
  assert.deepEqual(readdirSync(error.dropFolder).sort(), ['progress.json', 'souls'], 'nothing of the declined category was written');

  const g = fixture(t);
  const skipped = await runSandboxExport({ ...g.options, owner: 'owner', skip: ['transcripts'] });
  assert.deepEqual(skipped.manifest.categories.transcripts, { state: 'skipped', count: 0 });
  assert.equal(g.gates.length, 2);
  await assert.rejects(runSandboxExport({ ...g.options, owner: 'geniusbar-agent' }), { code: 'sandbox-export-self' });
});

test('the command parses export and verify, and refuses mixed or unknown flags', async (t) => {
  const f = fixture(t);
  let out = '';
  const write = (text) => { out += text; };
  const run = (argv, extra = {}) => sandboxExportCommand(argv, { ...f.options, write, ...extra });
  for (const argv of [[], ['--for'], ['--for', 'owner', '--verify', 'x'], ['--for', 'owner', '--skip', 'everything'], ['--verify', 'x', '--skip', 'souls'],
    ['--verify', 'x', '--principal-stdin'], ['--for', 'owner', '--dir', 'x'], ['--for', 'owner', '--sudo']]) {
    await assert.rejects(run(argv), { code: 'usage' }, argv.join(' '));
  }
  await run(['--for', 'owner']);
  assert.match(out, /only this account can read it/);
  assert.match(out, /agent-bot never runs sudo/);
  assert.match(out, /sudo \/usr\/bin\/ditto /);
  out = '';
  f.copy(path.join(outgoingRoot({ home: f.home }), STAMP));
  const verified = await run(['--verify', 'geniusbar-agent', '--json'], f.ownerOptions);
  assert.equal(JSON.parse(out).verified, true);
  assert.equal(verified.files, 4);
});

test('a real soul goes through soul env export to the path the drop names, and verifies on the other side', async (t) => {
  const f = fixture(t);
  const env = { ...f.env, PATH: process.env.PATH };
  const stateDir = stateDirectory({ env, home: f.home });
  const dir = path.join(env.AGENT_BOT_SOULS_HOME, 'billy.soul');
  mintAgentIdentity({ stateDir, idFactory: () => A, harness: 'codex', appSlug: null, useGithub: false });
  const manifest = { formatVersion: 2, ignore: PACKAGE_IGNORE_LIST, name: 'Billy', description: 'Sandbox export', displaySeed: 'billy', preferredHarnesses: ['codex'],
    revision: `sha256:${'0'.repeat(64)}`, parentRevision: null, template: false, credentials: {}, runtimes: {} };
  put(path.join(dir, 'AGENTS.md'), '# Billy\n');
  put(path.join(dir, 'soul.json'), JSON.stringify(manifest));
  manifest.revision = computePackageRevision(dir);
  put(path.join(dir, 'soul.json'), JSON.stringify(manifest));
  put(path.join(dir, '.soul-state', 'agent-id'), `${A}\n`);
  put(path.join(dir, '.soul-state', 'space', 'notes', 'today.md'), 'the life\n');
  rmSync(env.AGENT_BOT_POPULATION_PATH);
  upsertSoul({ id: A, name: 'billy', displayName: 'Billy', soulDir: dir, spacePath: path.join(dir, '.soul-state', 'space'), status: 'active', parentId: null, appSlug: null }, { file: env.AGENT_BOT_POPULATION_PATH });
  const exportSoul = (agentId, target) => soulEnvExportCommand([agentId, '--to', target], { env, home: f.home, cwd: f.home, now: () => NOW,
    gate: async () => {}, write: () => {}, running: async () => false });
  const result = await runSandboxExport({ ...f.options, env, owner: 'owner', skip: ['workspaces', 'transcripts'], exportSoul });
  assert.deepEqual(result.manifest.files.map((entry) => entry.path), [`souls/${A}.soul.tgz`]);
  f.copy(result.dropFolder);
  assert.equal((await verifySandboxExport('geniusbar-agent', f.ownerOptions)).verified, true);
});
