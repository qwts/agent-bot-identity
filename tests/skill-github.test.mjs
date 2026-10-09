import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import { chmodSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { acquireGithubSkill, githubSkillSource } from '../skill-github.mjs';
import { importSkill, checkSkill, showSkill } from '../skill-library.mjs';
import { main } from '../cli/soul-skill.mjs';
const SOURCE = 'https://github.com/example/skills/tree/main/skills/demo';
const API = 'https://api.github.com/repos/example/skills';
const COMMIT = 'a'.repeat(40);
const sha = bytes => createHash('sha1').update(bytes).digest('hex');
const blob = bytes => createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
const skill = text => Buffer.from(`---\r\nname: demo\r\ndescription: Repository fixture\r\n---\r\n${text}\r\n`);
function routes(files, commit = COMMIT, ref = 'main') {
  const nodes = new Map(), result = {};
  for (const [file, spec] of Object.entries(files)) {
    const bytes = Buffer.isBuffer(spec) ? spec : spec.bytes, mode = spec.mode ?? '100644';
    const full = `skills/demo/${file}`, parts = full.split('/');
    let dir = '';
    for (let i = 0; i < parts.length - 1; i++) { if (!nodes.has(dir)) nodes.set(dir, new Map()); dir = dir ? `${dir}/${parts[i]}` : parts[i]; }
    if (!nodes.has(dir)) nodes.set(dir, new Map());
    nodes.get(dir).set(parts.at(-1), { path: parts.at(-1), mode, type: mode === '160000' ? 'commit' : 'blob', size: bytes.length, sha: blob(bytes) });
    result[`https://raw.githubusercontent.com/example/skills/${commit}/${full}`] = { body: bytes };
  }
  const treeIds = new Map();
  for (const dir of [...nodes.keys()].sort((a, b) => b.length - a.length)) {
    const tree = [...nodes.get(dir).values()], id = sha(JSON.stringify(tree)); treeIds.set(dir, id);
    result[`${API}/git/trees/${id}`] = { body: JSON.stringify({ sha: id, tree, truncated: false }) };
    if (dir) { const parent = path.posix.dirname(dir), key = parent === '.' ? '' : parent; nodes.get(key).set(path.posix.basename(dir), { path: path.posix.basename(dir), mode: '040000', type: 'tree', sha: id }); }
  }
  result[`${API}/git/trees/${commit}`] = result[`${API}/git/trees/${treeIds.get('')}`];
  result[`${API}/commits/${encodeURIComponent(ref)}`] = { body: commit };
  return { result, treeIds };
}
function transport(map) {
  const calls = [];
  return { calls, resolve: async () => [{ address: '93.184.216.34', family: 4 }], requestImpl: (url, options, callback) => {
    const req = new EventEmitter(); calls.push({ url: url.href, options });
    req.end = () => queueMicrotask(() => {
      const row = typeof map[url.href] === 'function' ? map[url.href]() : map[url.href];
      if (!row) { req.emit('error', new Error('unavailable CANARY')); return; }
      if (row.hang) return;
      const stream = Readable.from(row.chunks ?? [Buffer.from(row.body ?? '')]);
      stream.statusCode = row.status ?? 200; stream.headers = row.headers ?? {}; callback(stream);
    }); return req;
  } };
}
function fixture(t) {
  const home = mkdtempSync(path.join(tmpdir(), 'skill-github-'));
  t.after(() => { const thaw = dir => { chmodSync(dir, 0o700); for (const item of readdirSync(dir, { withFileTypes: true })) if (item.isDirectory()) thaw(path.join(dir, item.name)); }; thaw(home); rmSync(home, { recursive: true, force: true }); });
  return { home, env: {} };
}

test('GitHub locator has one explicit ref component and rejects unsupported or unsafe directories', () => {
  assert.deepEqual(githubSkillSource(SOURCE), { owner: 'example', repo: 'skills', ref: 'main', path: 'skills/demo', url: SOURCE });
  assert.equal(githubSkillSource(SOURCE.replace('/main/', '/feature%2Fskills/')).ref, 'feature/skills');
  assert.equal(githubSkillSource('https://raw.githubusercontent.com/o/r/main/SKILL.md'), null);
  for (const url of [SOURCE.replace('/tree/', '/blob/'), `${SOURCE}?token=CANARY`, SOURCE.replace('/skills/demo', '/node_modules/demo'), SOURCE.replace('/main/', '/main%2F..%2Fbad/'), `${SOURCE}/a%2Fb`, `${SOURCE}/%zz`]) {
    assert.throws(() => githubSkillSource(url), error => /^skill-/.test(error.code) && !error.message.includes('CANARY'));
  }
});

test('directory import pins a commit and preserves binary assets, executable mode and nested references', async t => {
  const f = fixture(t), files = { 'SKILL.md': skill('[Guide](refs/guide.md) [Tool](scripts/run)'), 'refs/guide.md': Buffer.from('[Back](../SKILL.md)'),
    'scripts/run': { bytes: Buffer.from('#!/bin/sh\nexit 7\n'), mode: '100755' }, 'assets/icon.bin': Buffer.from([0, 255, 128]), 'node_modules/package.txt': Buffer.from('excluded') };
  const map = routes(files), net = transport(map.result), imported = await importSkill(SOURCE, { ...f, ...net });
  assert.equal(imported.repository.commit, COMMIT); assert.equal(imported.repository.tree, map.treeIds.get('skills/demo'));
  assert.equal(imported.source.url, SOURCE); assert.equal(imported.coverage.acquisition, 'complete-within-boundary');
  assert.deepEqual(readFileSync(path.join(imported.path, 'assets/icon.bin')), files['assets/icon.bin']);
  assert.equal(imported.localBaseline.files['scripts/run'].mode, '100755');
  assert.deepEqual(imported.excluded, ['node_modules']);
  assert.ok(imported.dependencies.some(edge => edge.target === 'scripts/run' && edge.status === 'captured'));
  assert.ok(imported.dependencies.filter(edge => edge.target?.endsWith('.md')).every(edge => edge.cycle));
  assert.ok(net.calls.every(call => !Object.keys(call.options.headers).some(key => /authorization|cookie/i.test(key))));
  assert.equal(net.calls[0].options.headers.Accept, 'application/vnd.github.sha');
  assert.ok(net.calls.filter(call => new URL(call.url).hostname === 'raw.githubusercontent.com').every(call => new URL(call.url).pathname.includes(`/${COMMIT}/`)));
  assert.equal(net.calls.some(call => call.url.includes('node_modules')), false);
});

test('external nested instructions share the repository acquisition request and byte budgets', async () => {
  const map = routes({ 'SKILL.md': skill('[External](https://docs.example.com/guide.md)') });
  map.result['https://docs.example.com/guide.md'] = { body: '[Nested](child.md)' };
  map.result['https://docs.example.com/child.md'] = { body: 'child' };
  const fullNet = transport(map.result), full = await acquireGithubSkill(SOURCE, 'owner', fullNet);
  assert.equal(full.entries.length, 3); assert.equal(full.coverage.acquisition, 'complete-within-boundary');
  const boundedNet = transport(map.result), bounded = await acquireGithubSkill(SOURCE, 'owner', { ...boundedNet, remoteLimits: { documents: 6 } });
  assert.equal(boundedNet.calls.length, 6); assert.equal(bounded.coverage.documentAttempts, 6);
  assert.ok(bounded.dependencies.some(edge => edge.reason === 'skill-document-limit'));
  assert.equal(bounded.coverage.acquisition, 'partial');
  assert.equal(full.coverage.receivedBytes, fullNet.calls.reduce((sum, call) => sum + Buffer.byteLength(map.result[call.url].body), 0));
});

test('ancestor navigation permits unrelated nonportable filenames while captured trees still refuse them', async t => {
  const unrelated = ['aux.c', 'README', 'readme', 'trailing.', 'colon:name'].map(name => ({ path: name, mode: '100644', type: 'blob', size: 0, sha: blob(Buffer.alloc(0)) }));
  for (const directory of ['', 'skills', 'skills/demo']) {
    const f = fixture(t), map = routes({ 'SKILL.md': skill('root') });
    const route = map.result[`${API}/git/trees/${map.treeIds.get(directory)}`];
    const tree = JSON.parse(route.body); tree.tree.push(...unrelated); route.body = JSON.stringify(tree);
    const net = transport(map.result);
    if (directory === 'skills/demo') {
      await assert.rejects(importSkill(SOURCE, { ...f, ...net }), error => error.code === 'skill-path-unsafe');
      assert.equal(existsSync(path.join(f.home, '.agent-bot/skills')), false);
    } else {
      const imported = await importSkill(SOURCE, { ...f, ...net });
      assert.equal(imported.coverage.acquisition, 'complete-within-boundary');
      assert.deepEqual(readdirSync(imported.path), ['SKILL.md']);
      assert.equal(net.calls.some(call => unrelated.some(item => call.url.endsWith(`/${item.path}`))), false);
    }
  }
  // Selecting the repository root captures that tree, so portability applies.
  const root = routes({ 'SKILL.md': skill('root') });
  const route = root.result[`${API}/git/trees/${COMMIT}`], tree = JSON.parse(route.body);
  tree.tree.push(...unrelated); route.body = JSON.stringify(tree);
  await assert.rejects(acquireGithubSkill('https://github.com/example/skills/tree/main', 'owner', transport(root.result)), error => error.code === 'skill-path-unsafe');
});

test('ancestor trees still refuse malformed entries and ambiguous exact directory names', async () => {
  for (const damage of ['duplicate', 'invalid-sha', 'invalid-type']) {
    const map = routes({ 'SKILL.md': skill('root') }), route = map.result[`${API}/git/trees/${COMMIT}`], tree = JSON.parse(route.body);
    if (damage === 'duplicate') tree.tree.push({ ...tree.tree[0] });
    if (damage === 'invalid-sha') tree.tree[0].sha = 'invalid';
    if (damage === 'invalid-type') tree.tree[0].type = 'unknown';
    route.body = JSON.stringify(tree);
    await assert.rejects(acquireGithubSkill(SOURCE, 'owner', transport(map.result)), error => error.code === 'skill-repository-invalid');
  }
});

test('missing files, blob mismatch, symlinks and submodules are explicit partial outcomes without raw retry', async t => {
  const f = fixture(t), map = routes({ 'SKILL.md': skill('[Link](link.md)'), 'link.md': { bytes: Buffer.from('../elsewhere'), mode: '120000' },
    'submodule': { bytes: Buffer.from('commit'), mode: '160000' }, 'bad.bin': Buffer.from('good'), 'missing.txt': Buffer.from('missing') });
  map.result[`https://raw.githubusercontent.com/example/skills/${COMMIT}/skills/demo/bad.bin`] = { body: 'tampered' };
  delete map.result[`https://raw.githubusercontent.com/example/skills/${COMMIT}/skills/demo/missing.txt`];
  const net = transport(map.result); let output = '';
  assert.equal(await main(['import', SOURCE, '--json'], { ...f, ...net, stdout: { write: value => { output += value; } }, stderr: { write() {} } }), 1);
  const imported = JSON.parse(output);
  assert.equal(imported.coverage.acquisition, 'partial');
  for (const reason of ['skill-repository-entry-unsupported', 'skill-repository-blob-mismatch', 'skill-fetch-unavailable', 'skill-repository-entry-unavailable']) assert.ok(imported.dependencies.some(edge => edge.reason === reason), reason);
  assert.equal(net.calls.some(call => call.url.endsWith('/link.md') || call.url.endsWith('/submodule')), false);
  assert.deepEqual(readdirSync(imported.path), ['SKILL.md']);
});

test('root failures and private-address redirects publish nothing; fixed commits cannot resolve elsewhere', async t => {
  for (const failure of ['root-bytes', 'truncated-tree', 'private-address', 'wrong-commit']) {
    const f = fixture(t), map = routes({ 'SKILL.md': skill('root') });
    let source = SOURCE;
    if (failure === 'root-bytes') map.result[`https://raw.githubusercontent.com/example/skills/${COMMIT}/skills/demo/SKILL.md`].body = 'wrong';
    if (failure === 'truncated-tree') map.result[`${API}/git/trees/${COMMIT}`].body = JSON.stringify({ sha: map.treeIds.get(''), tree: [], truncated: true });
    if (failure === 'private-address') map.result[`${API}/commits/main`] = { status: 302, headers: { location: 'https://127.0.0.1/secret' } };
    if (failure === 'wrong-commit') { source = SOURCE.replace('/main/', `/${'b'.repeat(40)}/`); map.result[`${API}/commits/${'b'.repeat(40)}`] = { body: COMMIT }; }
    await assert.rejects(importSkill(source, { ...f, ...transport(map.result) }), error => /^skill-/.test(error.code));
    assert.equal(existsSync(path.join(f.home, '.agent-bot/skills')), false);
  }
});

test('recheck resolves a mutable ref afresh while accepted snapshots and local edits retain their commit', async t => {
  const f = fixture(t), first = routes({ 'SKILL.md': skill('original'), 'guide.md': Buffer.from('guide') });
  const imported = await importSkill(SOURCE, { ...f, ...transport(first.result) });
  writeFileSync(path.join(imported.path, 'guide.md'), 'local edit');
  const nextCommit = 'b'.repeat(40), next = routes({ 'SKILL.md': skill('changed'), 'guide.md': Buffer.from('guide') }, nextCommit);
  const check = await checkSkill(imported.id, { ...f, ...transport(next.result) });
  assert.equal(check.status, 'changed'); assert.equal(check.repository.commit, nextCommit);
  assert.equal(showSkill(imported.id, f).repository.commit, COMMIT);
  assert.equal(readFileSync(path.join(imported.path, 'guide.md'), 'utf8'), 'local edit');
  const same = routes({ 'SKILL.md': skill('original'), 'guide.md': Buffer.from('guide') }, nextCommit);
  const unchanged = await checkSkill(imported.id, { ...f, ...transport(same.result) });
  assert.equal(unchanged.status, 'unchanged'); assert.equal(unchanged.repository.commit, nextCommit);
  assert.equal(showSkill(imported.id, f).repository.commit, COMMIT, 'content-addressed snapshot retains its original capture provenance');
});

test('GitHub API and raw requests stay on their exact hosts; LFS pointers are retained but incomplete', async t => {
  const f = fixture(t), pointer = Buffer.from(`version https://git-lfs.github.com/spec/v1\noid sha256:${'f'.repeat(64)}\nsize 10\n`);
  const map = routes({ 'SKILL.md': skill('root'), 'asset.bin': pointer });
  const imported = await importSkill(SOURCE, { ...f, ...transport(map.result) });
  assert.equal(imported.coverage.acquisition, 'partial');
  assert.ok(imported.dependencies.some(edge => edge.reason === 'skill-repository-lfs-pointer'));
  assert.deepEqual(readFileSync(path.join(imported.path, 'asset.bin')), pointer);
  assert.equal(imported.locations.find(item => item.path === 'asset.bin').gitBlob, blob(pointer));
  const external = 'https://public.example.com/moved';
  for (const url of [`${API}/commits/main`, `https://raw.githubusercontent.com/example/skills/${COMMIT}/skills/demo/SKILL.md`]) {
    const other = routes({ 'SKILL.md': skill('root') }); other.result[url] = { status: 302, headers: { location: external } };
    const net = transport(other.result);
    await assert.rejects(acquireGithubSkill(SOURCE, 'owner', net), error => error.code === 'skill-fetch-host-refused');
    assert.equal(net.calls.some(call => call.url === external), false);
  }
});

test('rate-limited and inaccessible rechecks have distinct bounded diagnostics without credential retries', async t => {
  const f = fixture(t), map = routes({ 'SKILL.md': skill('root') }), imported = await importSkill(SOURCE, { ...f, ...transport(map.result) });
  const now = () => new Date('2026-10-09T00:00:00Z');
  for (const [status, headers, reason, retryAt] of [
    [404, {}, 'skill-fetch-not-found'], [403, {}, 'skill-fetch-forbidden'],
    [403, { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '1791526000' }, 'skill-fetch-rate-limited', new Date(1791526000000).toISOString()],
    [403, { 'x-ratelimit-remaining': '50', 'retry-after': '120' }, 'skill-fetch-rate-limited', '2026-10-09T00:02:00.000Z'],
    [429, { 'retry-after': 'Fri, 09 Oct 2026 01:00:00 GMT' }, 'skill-fetch-rate-limited', '2026-10-09T01:00:00.000Z'],
    [429, { 'retry-after': '9'.repeat(1000) }, 'skill-fetch-rate-limited'],
    [403, { 'retry-after': 'CANARY invalid' }, 'skill-fetch-forbidden'],
  ]) {
    const net = transport({ [`${API}/commits/main`]: { status, headers, body: 'CANARY must not persist' } });
    const check = await checkSkill(imported.id, { ...f, ...net, now });
    assert.equal(check.status, 'unavailable'); assert.equal(check.reason, reason);
    assert.equal(net.calls.length, 1); assert.equal(JSON.stringify(check).includes('CANARY'), false);
    assert.equal(check.retryAt, retryAt);
    assert.equal(showSkill(imported.id, f).accepted, imported.accepted);
  }
});

test('GitHub web instruction links and redirects are unresolved rather than captured as HTML', async () => {
  const web = `https://github.com/example/skills/blob/${COMMIT}/skills/demo/guide.md`;
  const mutable = 'https://github.com/example/skills/blob/main/skills/demo/guide.md';
  const redirect = 'https://docs.example.com/guide.md';
  const map = routes({ 'SKILL.md': skill(`[Pinned](${web}) [Branch](${mutable}) [Redirect](${redirect})`) });
  map.result[web] = map.result[mutable] = { body: '<html>not source bytes</html>' };
  map.result[redirect] = { status: 302, headers: { location: web } };
  const net = transport(map.result), result = await acquireGithubSkill(SOURCE, 'owner', net);
  assert.equal(result.coverage.acquisition, 'partial');
  assert.equal(result.dependencies.length, 3);
  assert.ok(result.dependencies.every(edge => edge.status === 'unresolved' && edge.reason === 'skill-source-unsupported'));
  assert.deepEqual(result.entries.map(entry => entry.path), ['SKILL.md']);
  assert.equal(net.calls.some(call => new URL(call.url).hostname === 'github.com'), false);
});

test('directory references cannot fetch omitted entries or escape the selected repository root', async () => {
  const map = routes({ 'SKILL.md': skill('[Outside](../outside.md) [Excluded](node_modules/guide.md)'), 'node_modules/guide.md': Buffer.from('excluded') });
  const outside = `https://raw.githubusercontent.com/example/skills/${COMMIT}/skills/outside.md`;
  map.result[outside] = { body: 'must not fetch' };
  const net = transport(map.result), result = await acquireGithubSkill(SOURCE, 'owner', net);
  assert.ok(result.dependencies.some(edge => edge.reason === 'skill-repository-outside-root'));
  assert.ok(result.dependencies.some(edge => edge.reason === 'skill-repository-entry-unavailable'));
  assert.equal(net.calls.some(call => call.url === outside || call.url.includes('node_modules')), false);
});

test('external captures cannot introduce portable directory aliases into a valid repository payload', async t => {
  const f = fixture(t), map = routes({ 'SKILL.md': skill('[External](https://docs.example.com/guide.md)'), 'Remote/keep.bin': Buffer.from('keep') });
  map.result['https://docs.example.com/guide.md'] = { body: 'guide' };
  const imported = await importSkill(SOURCE, { ...f, ...transport(map.result) });
  assert.equal(imported.coverage.acquisition, 'partial');
  assert.ok(imported.dependencies.some(edge => edge.reason === 'skill-path-unsafe'));
  assert.equal(readFileSync(path.join(imported.path, 'Remote/keep.bin'), 'utf8'), 'keep');
  assert.equal(Object.keys(imported.localBaseline.files).length, 2);
});
