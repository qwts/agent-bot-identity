import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { acceptSopTrust, assertSopGitCommand, createRunGit, formatSopReport, gitSubcommand, listSopDocuments, main, parseSopArgs, resolveSop, showSopDocument } from '../sop.mjs';
import { upsertSoul } from '../agent-population.mjs';

const ID = 'agent_12345678-1234-4234-8234-123456789abc';
const runLocal = createRunGit({ allowProtocols: 'file' });
function git(dir, ...args) {
  const result = spawnSync('git', ['-c', 'core.hooksPath=/dev/null', '-C', dir, ...args], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}
function fixture(t) {
  const home = mkdtempSync(join(tmpdir(), 'sop-soul-'));
  t.after(() => {
    function thaw(dir) {
      chmodSync(dir, 0o700);
      for (const entry of readdirSync(dir, { withFileTypes: true })) if (entry.isDirectory()) thaw(join(dir, entry.name));
    }
    thaw(home);
    rmSync(home, { recursive: true, force: true });
  });
  const soulDir = join(home, 'soul');
  const stateDir = join(home, 'state');
  const userPath = join(home, '.config', 'agent-sop', 'config.toml');
  mkdirSync(soulDir);
  const calls = [];
  const options = {
    home, env: {}, cwd: home, stateDir,
    currentAgentId: () => null, readBinding: () => null,
    soulDirectory: (id) => { assert.equal(id, ID); return soulDir; },
    runGit: (args) => { assertSopGitCommand(args); calls.push(args); return runLocal(args); },
  };
  const put = (path, text) => { mkdirSync(join(path, '..'), { recursive: true }); writeFileSync(path, text); };
  return { home, soulDir, stateDir, userPath, calls, options, put };
}
function repository(f) {
  const src = join(f.home, 'src');
  mkdirSync(src);
  git(src, 'init', '-q', '-b', 'main');
  f.put(join(src, 'guide.md'), 'Repository guide\n');
  f.put(join(src, 'nested', 'review.md'), 'Review reference\n');
  f.put(join(src, 'notes.txt'), 'not documentation');
  f.put(join(src, '.gitattributes'), '*.md filter=evil diff=evil\n');
  git(src, 'add', '.');
  git(src, '-c', 'user.email=t@example.com', '-c', 'user.name=t', 'commit', '-qm', 'docs');
  const commit = git(src, 'rev-parse', 'HEAD');
  const bare = join(f.home, 'bare.git');
  git(f.home, 'clone', '--bare', '-q', src, bare);
  f.options.remoteUrl = () => bare;
  f.options.readOrgText = () => JSON.stringify({
    schema_version: 1, organization: { id: 'local', account: 'local', profile: 'profile.json' },
    sources: { sop: { repo: 'local/sop', ref: commit, entry: 'guide.md', summary: 'Docs' } }, capabilities: {},
  });
  const config = (org = 'local/org', sop = 'local/sop', ref = commit) => `schema_version = 1\n[repos]\norg = "${org}@${commit}"\nsop = "${sop}@${ref}"\n`;
  return { src, bare, commit, config };
}
// `trust` is async (owner gate); every other command returns synchronously.
function cli(argv, options) {
  let out = '', err = '';
  const code = main(argv, { ...options, writeStdout: (text) => { out += text; }, writeStderr: (text) => { err += text; } });
  return code instanceof Promise ? code.then((resolved) => ({ code: resolved, out, err })) : { code, out, err };
}

test('selection order is soul, user, none; no-soul text remains unchanged', (t) => {
  const f = fixture(t);
  let report = resolveSop(f.options);
  assert.deepEqual(report.selection, { source: 'none', path: null });
  assert.equal(cli([], f.options).out, 'No SOP is in effect.\n');
  const repo = repository(f);
  f.put(f.userPath, repo.config());
  report = resolveSop(f.options);
  assert.deepEqual(report.selection, { source: 'user', path: f.userPath });
  const original = formatSopReport(report);
  assert.equal(cli([], f.options).out, original);
  assert.equal(report.trust, undefined);
  const options = { ...f.options, soul: ID };
  assert.equal(resolveSop(options).selection.source, 'user');
  const soulPath = join(f.soulDir, 'agent-sop.toml');
  f.put(soulPath, repo.config());
  report = resolveSop(options);
  assert.deepEqual(report.selection, { source: 'soul', path: soulPath });
  assert.equal(report.trust, undefined);
  f.put(soulPath, 'schema_version = 2');
  assert.throws(() => resolveSop(options), /schema_version/);
});

test('repository Markdown is pinned, cached read-only, and layered under soul documents', (t) => {
  const f = fixture(t), repo = repository(f);
  f.put(f.userPath, repo.config());
  f.put(join(f.soulDir, 'sop', 'guide.md'), 'Soul guide\n');
  f.put(join(f.soulDir, 'sop', 'local.md'), 'Local reference\n');
  const options = { ...f.options, soul: ID }, report = resolveSop(options);
  assert.deepEqual(listSopDocuments(report, options), [
    { path: 'guide.md', source: 'soul' }, { path: 'local.md', source: 'soul' },
    { path: 'nested/review.md', source: 'sop', commit: repo.commit },
  ]);
  assert.equal(showSopDocument(report, 'guide.md', options), 'Soul guide\n');
  assert.equal(showSopDocument(report, 'nested/review.md', options), 'Review reference\n');
  const cache = join(f.stateDir, 'sop-cache', repo.commit);
  assert.equal(statSync(cache).mode & 0o777, 0o555);
  assert.equal(statSync(join(cache, 'nested')).mode & 0o777, 0o555);
  assert.equal(statSync(join(cache, 'guide.md')).mode & 0o777, 0o444);
  assert.equal(existsSync(join(cache, 'notes.txt')), false);
  const fetched = f.calls.filter((args) => gitSubcommand(args) === 'fetch');
  assert.equal(fetched.length, 1);
  assert.equal(fetched[0].at(-1), repo.commit);
  listSopDocuments(report, options);
  assert.equal(f.calls.filter((args) => gitSubcommand(args) === 'fetch').length, 1);
  const shown = cli(['show', 'guide.md', '--soul', ID], f.options);
  assert.equal(shown.code, 0, shown.err);
  assert.match(shown.out, /^Reference documentation \(ADR-0274\): does not override harness or user instructions\.\nSoul guide\n$/);
});

test('workflow TOML filters list and refuses show outside its paths', (t) => {
  const f = fixture(t);
  f.put(join(f.soulDir, 'sop', 'one.md'), 'one');
  f.put(join(f.soulDir, 'sop', 'two.md'), 'two');
  f.put(join(f.soulDir, 'workflows', 'review.toml'), '# review\nsop = [\n "one.md", # only this\n]\n');
  const options = { ...f.options, soul: ID, workflow: 'review' }, report = resolveSop(options);
  assert.deepEqual(listSopDocuments(report, options), [{ path: 'one.md', source: 'soul' }]);
  assert.equal(showSopDocument(report, 'one.md', options), 'one');
  assert.throws(() => showSopDocument(report, 'two.md', options), /outside workflow/);
  const result = cli(['list', '--soul', ID, '--workflow', 'review', '--json'], f.options);
  assert.equal(result.code, 0, result.err);
  assert.deepEqual(JSON.parse(result.out).documents, [{ path: 'one.md', source: 'soul' }]);
  assert.match(cli(['show', 'two.md', '--soul', ID, '--workflow', 'review'], f.options).err, /outside workflow/);
  f.put(join(f.soulDir, 'workflows', 'review.toml'), 'sop = ["one.md" "two.md"]');
  assert.throws(() => listSopDocuments(report, options), /comma separated/);
});

test('foreign soul repository is withheld until explicit owner trust, keyed by repo and commit', async (t) => {
  const f = fixture(t), repo = repository(f);
  f.put(f.userPath, repo.config());
  f.put(join(f.soulDir, 'agent-sop.toml'), repo.config('foreign/org', 'foreign/sop'));
  const options = { ...f.options, soul: ID };
  let report = resolveSop(options);
  assert.equal(report.trust.required, true);
  assert.equal(report.trust.accepted, false);
  assert.match(formatSopReport(report), /Trust decision:.*Documents withheld/);
  assert.deepEqual(listSopDocuments(report, options), []);
  assert.equal(f.calls.length, 0);
  assert.throws(() => showSopDocument(report, 'guide.md', options), /Documents withheld/);
  assert.throws(() => acceptSopTrust(report, 'local/sop', options), /selected SOP repository/);
  const refused = await cli(['trust', 'foreign/sop', '--soul', ID], { ...f.options,
    assertOwner: (action) => { throw new Error(`${action} is owner only; this caller has a soul's AGENT_BOT_ID`); } });
  assert.equal(refused.code, 1);
  assert.match(refused.err, /owner only/);
  assert.equal(existsSync(join(f.stateDir, 'sop-trust.json')), false, 'a soul cannot accept its own SOP');
  const accepted = await cli(['trust', 'foreign/sop', '--soul', ID], { ...f.options, assertOwner: () => {} });
  assert.equal(accepted.code, 0, accepted.err);
  assert.match(accepted.out, new RegExp(repo.commit));
  const file = join(f.stateDir, 'sop-trust.json');
  assert.equal(statSync(file).mode & 0o777, 0o600);
  assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')).accepted, [`foreign/sop@${repo.commit}`]);
  report = resolveSop(options);
  assert.equal(report.trust.accepted, true);
  assert.equal(listSopDocuments(report, options).length, 2);
  f.put(join(repo.src, 'new.md'), 'New commit');
  git(repo.src, 'add', '.');
  git(repo.src, '-c', 'user.email=t@example.com', '-c', 'user.name=t', 'commit', '-qm', 'next');
  const next = git(repo.src, 'rev-parse', 'HEAD');
  f.put(join(f.soulDir, 'agent-sop.toml'), repo.config('foreign/org', 'foreign/sop', next));
  assert.equal(resolveSop(options).trust.accepted, false);
});

test('a soul selection without user config requires trust; same SOP with foreign org also requires trust', (t) => {
  const f = fixture(t), repo = repository(f);
  f.put(join(f.soulDir, 'agent-sop.toml'), repo.config());
  const options = { ...f.options, soul: ID };
  assert.equal(resolveSop(options).trust.required, true);
  f.put(f.userPath, repo.config('other/org'));
  assert.equal(resolveSop(options).trust.required, true);
  f.put(f.userPath, `schema_version = 1\n[repos]\norg = "local/org@${repo.commit}"\n`);
  assert.equal(resolveSop(options).trust, undefined); // org.json selects the same SOP
});

test('traversal and escaping symlinks are refused in documents, workflows, and cache', (t) => {
  const f = fixture(t);
  f.put(join(f.soulDir, 'sop', 'ok.md'), 'okay');
  const options = { ...f.options, soul: ID }, report = resolveSop(options);
  for (const path of ['/etc/passwd', '../other.md', 'a/../ok.md', 'C:/secret.md', 'a\\b.md']) {
    assert.throws(() => showSopDocument(report, path, options), /unsafe relative/);
  }
  assert.throws(() => listSopDocuments(report, { ...options, workflow: '../review' }), /simple name/);
  f.put(join(f.home, 'secret.md'), 'secret');
  symlinkSync(join(f.home, 'secret.md'), join(f.soulDir, 'sop', 'escape.md'));
  assert.throws(() => listSopDocuments(report, options), /symlink escapes/);
  rmSync(join(f.soulDir, 'sop', 'escape.md'));
  mkdirSync(join(f.soulDir, 'workflows'));
  symlinkSync(join(f.home, 'secret.md'), join(f.soulDir, 'workflows', 'escape.toml'));
  assert.throws(() => listSopDocuments(report, { ...options, workflow: 'escape' }), /symlink escapes/);
  const repo = repository(f);
  f.put(f.userPath, repo.config());
  Object.assign(options, f.options, { soul: ID });
  const remote = resolveSop(options);
  listSopDocuments(remote, options);
  const cache = join(f.stateDir, 'sop-cache', repo.commit);
  chmodSync(cache, 0o755);
  symlinkSync(join(f.home, 'secret.md'), join(cache, 'escape.md'));
  assert.throws(() => listSopDocuments(remote, options), /symlink escapes/);
});

test('current Agent ID resolves through the population soul directory; explicit soul takes precedence', (t) => {
  const f = fixture(t), file = join(f.home, 'population.json');
  f.put(join(f.soulDir, '.soul-state', 'agent-id'), ID);
  upsertSoul({ id: ID, name: 'test-soul', soulDir: f.soulDir, spacePath: join(f.home, 'space'), status: 'active' }, { file });
  const { currentAgentId: unused, soulDirectory: injected, ...options } = f.options;
  options.env = { AGENT_BOT_ID: ID };
  options.populationOptions = { file };
  assert.equal(resolveSop(options).soul.directory, f.soulDir);
  assert.equal(resolveSop({ ...f.options, currentAgentId: () => ID }).soul.agentId, ID);
  assert.equal(resolveSop({ ...f.options, readBinding: () => ({ agentId: ID }) }).soul.agentId, ID);
  assert.equal(resolveSop({ ...f.options, soul: ID, currentAgentId: () => { throw new Error('must not run'); } }).soul.agentId, ID);
});

test('repository symlinks are refused and failed cache builds leave no published cache', (t) => {
  const f = fixture(t), repo = repository(f);
  symlinkSync('/etc/passwd', join(repo.src, 'escape.md'));
  git(repo.src, 'add', '.');
  git(repo.src, '-c', 'user.email=t@example.com', '-c', 'user.name=t', 'commit', '-qm', 'symlink');
  const commit = git(repo.src, 'rev-parse', 'HEAD');
  git(repo.bare, 'fetch', repo.src, 'main:main');
  f.put(f.userPath, repo.config('local/org', 'local/sop', commit));
  const report = resolveSop(f.options);
  assert.throws(() => listSopDocuments(report, f.options), /symlink in SOP repository/);
  assert.equal(existsSync(join(f.stateDir, 'sop-cache', commit)), false);
  assert.deepEqual(readdirSync(join(f.stateDir, 'sop-cache')), []);
});

test('argument forms and pinned Git read boundary fail closed', () => {
  assert.equal(parseSopArgs(['list', '--soul', ID, '--workflow', 'review', '--json']).command, 'list');
  for (const args of [['show'], ['trust'], ['--soul'], ['--workflow', 'review'], ['list', 'extra'], ['show', 'a.md', '--json']]) {
    assert.throws(() => parseSopArgs(args));
  }
  const sha = 'a'.repeat(40);
  assert.doesNotThrow(() => assertSopGitCommand(['-C', '/tmp/read', 'cat-file', 'blob', `${sha}:guide.md`]));
  assert.doesNotThrow(() => assertSopGitCommand(['-C', '/tmp/read', 'cat-file', '-p', sha]));
  for (const spec of [`${sha}:../secret.md`, `${sha}:/secret.md`, `${sha}:evil.sh`, 'main:guide.md']) {
    assert.throws(() => assertSopGitCommand(['-C', '/tmp/read', 'cat-file', 'blob', spec]), /refusing/);
  }
});
