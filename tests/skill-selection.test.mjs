// Selected policy and immutable catalog/entry reads, with local repositories.
// No test consults GitHub, the real HOME, or the current agent binding.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { main, SkillError, selectedCatalog, resolveCatalogSkill } from '../skill.mjs';
import { acceptSopTrust, createRunGit, resolveSop } from '../sop.mjs';

const put = (file, text) => { mkdirSync(path.dirname(file), { recursive: true }); writeFileSync(file, text); };
const ID = 'agent_12345678-1234-4234-8234-123456789abc';
function fixture(t) {
  const home = mkdtempSync(path.join(tmpdir(), 'skill-selection-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const env = { HOME: home, PATH: '/usr/bin:/bin', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
  const repositories = new Map();
  const git = (dir, ...args) => execFileSync('git', ['-c', 'core.hooksPath=/dev/null', '-C', dir, ...args],
    { env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  function pack(owner) {
    const dir = path.join(home, owner);
    mkdirSync(dir);
    git(dir, 'init', '-q', '-b', 'main');
    const commit = () => { git(dir, 'add', '.'); git(dir, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'Fixture'); return git(dir, 'rev-parse', 'HEAD'); };
    put(path.join(dir, 'skills/shared/SKILL.md'), `# ${owner} skill\n`);
    const skillCommit = commit();
    // An unrelated catalog-looking link must not redirect the index read.
    put(path.join(dir, 'skills/README.md'), `# Catalog\n[Catalog elsewhere](https://github.com/intruder/policy/blob/main/skills/README.md)\n\n## Available skills\n\n- [shared](https://github.com/${owner}/skills/tree/${skillCommit}/skills/shared)\n  — owned by [${owner}/skills](https://github.com/${owner}/skills).\n`);
    const sopCommit = commit();
    put(path.join(dir, 'org.json'), JSON.stringify({ schema_version: 1,
      organization: { id: owner, account: owner, profile: 'profile.json' },
      sources: { sop: { repo: `${owner}/sop`, ref: sopCommit, entry: 'skills/README.md', summary: 'Skills' } }, capabilities: {} }));
    const orgCommit = commit();
    for (const name of ['org', 'sop', 'skills']) repositories.set(`${owner}/${name}`, dir);
    const config = `schema_version = 1\n[repos]\norg = "${owner}/org@${orgCommit}"\n`;
    return { dir, owner, config, skillCommit, sopCommit, orgCommit, commit };
  }
  const options = { env, home, cwd: home, currentAgentId: () => null, readBinding: () => null,
    runGit: createRunGit({ env, allowProtocols: 'file' }), remoteUrl: repo => {
      assert.ok(repositories.has(repo), `unexpected policy repository ${repo}`); return repositories.get(repo);
    } };
  const calls = [];
  const fetchContents = (repo, file, ref) => {
    calls.push({ repo, file, ref });
    assert.ok(repositories.has(repo), `unexpected content repository ${repo}`);
    assert.match(ref, /^[a-f0-9]{40}$/);
    try { return execFileSync('git', ['-C', repositories.get(repo), 'show', `${ref}:${file}`], { env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }); }
    catch { throw new SkillError('fixture HTTP 404', 1, 'skill-content-missing'); }
  };
  const configFile = path.join(home, '.config/agent-sop/config.toml');
  const run = (argv, extra = {}) => {
    let stdout = '', stderr = '';
    const status = main(argv, { sopOptions: options, fetchContents, stdout: { write: s => { stdout += s; } }, stderr: { write: s => { stderr += s; } }, ...extra });
    return { status, stdout, stderr };
  };
  return { home, env, options, pack, calls, fetchContents, configFile, run };
}

test('two organizations disclose only their selected immutable index and entry, even when the default branch advances', t => {
  const f = fixture(t);
  for (const owner of ['alpha', 'beta']) {
    const p = f.pack(owner);
    put(f.configFile, p.config);
    put(path.join(p.dir, 'skills/README.md'), '# changed default branch has no catalog\n');
    p.commit();
    f.calls.length = 0;
    const result = f.run(['shared', '--json']);
    assert.equal(result.status, 0, result.stderr);
    const skill = JSON.parse(result.stdout);
    assert.equal(skill.text, `# ${owner} skill\n`);
    assert.deepEqual(skill.catalog, { repository: `${owner}/sop`, commit: p.sopCommit, path: 'skills/README.md' });
    assert.deepEqual(f.calls, [
      { repo: `${owner}/sop`, file: 'skills/README.md', ref: p.sopCommit },
      { repo: `${owner}/skills`, file: 'skills/shared/SKILL.md', ref: p.skillCommit },
    ]);
  }
});

test('no selection and malformed selection refuse without a catalog read; bundled and path disclosure stay offline', t => {
  const f = fixture(t);
  f.options.runGit = () => assert.fail('no selection must not call git');
  let result = f.run(['shared']);
  assert.equal(result.status, 1);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /skill-catalog-unselected:.*config.toml/);
  put(f.configFile, 'schema_version = false');
  result = f.run(['shared']);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /skill-catalog-selection-failed/);
  for (const args of [['agent-bot'], ['agent-space'], ['thread-orders'], ['path'], ['agent-bot', '--for', 'mint-token']]) {
    result = f.run(args, { resolveSop: () => assert.fail('bundled disclosure must not resolve policy') });
    assert.equal(result.status, 0, result.stderr);
  }
  assert.deepEqual(f.calls, []);
});

test('a foreign soul catalog is withheld until its exact selection is trusted and then wins over the user catalog', t => {
  const f = fixture(t), user = f.pack('alpha'), soul = f.pack('beta');
  put(f.configFile, user.config);
  const soulDir = path.join(f.home, 'example.soul');
  put(path.join(soulDir, 'agent-sop.toml'), soul.config);
  Object.assign(f.options, { currentAgentId: () => ID, soulDirectory: () => soulDir });
  let result = f.run(['shared']);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /skill-catalog-untrusted:.*agent-bot sop trust beta\/sop --soul/);
  assert.deepEqual(f.calls, []);
  acceptSopTrust(resolveSop(f.options), 'beta/sop', f.options);
  result = f.run(['shared', '--json']);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).catalog.repository, 'beta/sop');
  assert.equal(f.calls[0].repo, 'beta/sop');
});

test('catalog and entry failures have distinct codes and never redirect the selected index', () => {
  const pin = 'a'.repeat(40), catalog = { repository: 'alpha/sop', commit: pin };
  const selection = { resolve: () => ({ inEffect: true, repositories: { sop: catalog } }) };
  const read = text => { const calls = []; return { calls, fetch: (...args) => { calls.push(args); return text; } }; };
  for (const [text, code] of [['', 'skill-catalog-invalid'], ['# no entries section', 'skill-catalog-invalid'], ['x'.repeat(1024 * 1024 + 1), 'skill-catalog-invalid'],
    [`## Available skills\n- [shared](https://github.com/other/skills/tree/main/skills/shared)`, 'skill-entry-unpinned']]) {
    const f = read(text);
    assert.throws(() => resolveCatalogSkill('shared', f.fetch, selection), error => error.code === code);
    assert.deepEqual(f.calls, [['alpha/sop', 'skills/README.md', pin]]);
  }
  for (const [cause, code] of [[new SkillError('404', 1, 'skill-content-missing'), 'skill-catalog-missing'], [new Error('offline'), 'skill-catalog-unreadable']]) {
    assert.throws(() => resolveCatalogSkill('shared', () => { throw cause; }, selection), error => error.code === code);
  }
  const calls = [];
  assert.throws(() => resolveCatalogSkill('shared', (...args) => {
    calls.push(args);
    if (calls.length === 1) return `## Available skills\n- [shared](https://github.com/other/skills/tree/${pin}/skills/shared)`;
    throw new Error('entry unavailable');
  }, selection), error => error.code === 'skill-entry-unreadable');
  assert.deepEqual(calls, [['alpha/sop', 'skills/README.md', pin], ['other/skills', 'skills/shared/SKILL.md', pin]]);
  assert.throws(() => selectedCatalog({ resolve: () => ({ inEffect: true, repositories: { sop: { repository: 'alpha/sop', commit: 'main' } } }) }), error => error.code === 'skill-catalog-selection-failed');
});


test('an explicit user SOP overrides the org pin without guessing another catalog', t => {
  const f = fixture(t), org = f.pack('alpha'), selected = f.pack('beta');
  put(f.configFile, `${org.config}sop = "beta/sop@${selected.sopCommit}"\n`);
  const result = f.run(['shared', '--json']);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).catalog.repository, 'beta/sop');
  assert.deepEqual(f.calls.map(call => call.repo), ['beta/sop', 'beta/skills']);
});
