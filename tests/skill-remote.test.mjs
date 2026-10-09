import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { Agent, globalAgent } from 'node:https';
import { Readable } from 'node:stream';
import { chmodSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { acquireRemoteSkill, publicSkillAddress, skillSourceUrl } from '../skill-remote.mjs';
import { importSkill, checkSkill, showSkill, verifySkill } from '../skill-library.mjs';
import { main } from '../cli/soul-skill.mjs';
const URL = 'https://skills.example.com/demo/SKILL.md';
const skill = '---\r\nname: demo\r\ndescription: Remote fixture\r\n---\r\n[Guide](refs/guide.md)\r\n';
function transport(routes, overrides = {}) {
  const calls = [], resolved = [];
  return { calls, resolved,
    resolve: async host => { resolved.push(host); return overrides.addresses?.(host) ?? [{ address: '93.184.216.34', family: 4 }]; },
    requestImpl: (url, options, callback) => {
      const req = new EventEmitter();
      calls.push({ url: url.href, options });
      req.end = () => queueMicrotask(() => {
        const row = routes[url.href];
        if (!row) { req.emit('error', new Error('unavailable CANARY')); return; }
        if (row.hang) return;
        const response = Readable.from(row.chunks ?? [Buffer.from(row.body ?? '')]);
        response.statusCode = row.status ?? 200; response.headers = row.headers ?? {};
        callback(response);
      });
      return req;
    },
  };
}
function fixture(t) {
  const home = mkdtempSync(path.join(tmpdir(), 'skill-remote-'));
  t.after(() => { const thaw = dir => { chmodSync(dir, 0o700); for (const entry of readdirSync(dir, { withFileTypes: true })) if (entry.isDirectory()) thaw(path.join(dir, entry.name)); }; thaw(home); rmSync(home, { recursive: true, force: true }); });
  return { home, env: {}, now: () => new Date('2026-10-09T00:00:00Z') };
}

test('public address and source rules reject local/reserved targets and credential-bearing locators', () => {
  for (const ip of ['0.0.0.0', '10.1.2.3', '100.64.0.1', '127.0.0.1', '169.254.169.254', '172.16.0.1', '192.0.2.1', '192.168.0.1', '198.18.0.1', '198.51.100.1', '203.0.113.1', '224.0.0.1', '255.255.255.255', '::1', 'fc00::1', 'fe80::1', '::ffff:127.0.0.1', '64:ff9b::7f00:1', '2001:db8::1', '2002:7f00::1', '3fff::1']) assert.equal(publicSkillAddress(ip), false, ip);
  for (const ip of ['93.184.216.34', '8.8.8.8', '2001:4860:4860::8888', '2606:4700:4700::1111']) assert.equal(publicSkillAddress(ip), true, ip);
  for (const url of ['http://example.com/SKILL.md', 'https://user:CANARY@example.com/SKILL.md', 'https://example.com/SKILL.md?token=CANARY', 'https://127.1/SKILL.md', 'https://[::1]/SKILL.md', 'https://example.com:8443/SKILL.md', 'https://a.local/SKILL.md']) assert.throws(() => skillSourceUrl(url), error => error.code === 'skill-source-unsupported' && !error.message.includes('CANARY'));
});

test('the TLS request pins a checked DNS address, keeps SNI, and carries no ambient credentials', async () => {
  const net = transport({ [URL]: { body: skill.replace('[Guide](refs/guide.md)', '') } });
  await acquireRemoteSkill(URL, 'owner', net);
  assert.deepEqual(net.resolved, ['skills.example.com']);
  const options = net.calls[0].options;
  assert.ok(options.agent instanceof Agent); assert.notEqual(options.agent, globalAgent); assert.deepEqual(options.agent.options.proxyEnv, {}); assert.equal(options.servername, 'skills.example.com');
  assert.equal(options.rejectUnauthorized, true);
  assert.deepEqual(Object.keys(options.headers).sort(), ['Accept-Encoding', 'User-Agent']);
  await new Promise((done, reject) => options.lookup('skills.example.com', { all: true }, (error, rows) => { if (error) reject(error); else { assert.deepEqual(rows, [{ address: '93.184.216.34', family: 4 }]); done(); } }));
  assert.equal(net.resolved.length, 1, 'connection lookup does not re-resolve');
  const mixed = transport({}, { addresses: () => [{ address: '93.184.216.34', family: 4 }, { address: '127.0.0.1', family: 4 }] });
  await assert.rejects(acquireRemoteSkill(URL, 'owner', mixed), error => error.code === 'skill-fetch-address-refused');
  assert.equal(mixed.calls.length, 0);
});

test('redirects resolve references from final URLs and every hop revalidates destination authority', async () => {
  const final = 'https://cdn.example.com/pinned/SKILL.md', guide = 'https://cdn.example.com/pinned/refs/guide.md';
  const net = transport({ [URL]: { status: 302, headers: { location: final } }, [final]: { body: skill }, [guide]: { body: '[Back](../SKILL.md)\n' } });
  const result = await acquireRemoteSkill(URL, 'owner', net);
  assert.deepEqual(result.hosts, ['cdn.example.com', 'skills.example.com']);
  assert.equal(result.locations[0].url, URL); assert.equal(result.locations[0].resolvedUrl, final);
  assert.deepEqual(result.entries.map(e => e.path), ['SKILL.md', 'refs/guide.md']);
  assert.deepEqual(result.entries[0].bytes, Buffer.from(skill));
  assert.equal(result.dependencies.every(edge => edge.cycle), true);
  for (const target of ['http://example.com/a.md', 'https://user:CANARY@example.com/a.md', 'https://example.com/a.md?token=CANARY', 'https://127.0.0.1/a.md']) {
    const refused = transport({ [URL]: { status: 302, headers: { location: target } } });
    await assert.rejects(acquireRemoteSkill(URL, 'owner', refused), error => error.code === 'skill-fetch-redirect-refused' && !error.message.includes('CANARY'));
    assert.equal(refused.calls.length, 1);
  }
  const privateHop = transport({ [URL]: { status: 302, headers: { location: final } } }, { addresses: host => [{ address: host.startsWith('cdn') ? '10.0.0.1' : '93.184.216.34', family: 4 }] });
  await assert.rejects(acquireRemoteSkill(URL, 'owner', privateHop), /non-public/); assert.equal(privateHop.calls.length, 1);
});

test('root byte, redirect, deadline and encoding failures publish no import', async t => {
  const f = fixture(t), cases = [
    { ...transport({ [URL]: { body: skill } }), remoteLimits: { fileBytes: 8 } },
    { ...transport({ [URL]: { status: 302, headers: { location: URL } } }), remoteLimits: { redirects: 1 } },
    { ...transport({ [URL]: { hang: true } }), remoteLimits: { milliseconds: 10 } },
    transport({ [URL]: { body: skill, headers: { 'content-encoding': 'gzip' } } }),
  ];
  for (const net of cases) { await assert.rejects(importSkill(URL, { ...f, ...net })); assert.equal(existsSync(path.join(f.home, '.agent-bot/skills')), false); }
  await assert.rejects(importSkill(URL, { ...f, ...transport({ [URL]: { body: skill } }), remoteLimits: { files: 101 } }), /only lower/);
});

test('remote check preserves accepted and local bytes and reports nested failure as unavailable', async t => {
  const f = fixture(t), guide = 'https://skills.example.com/demo/refs/guide.md';
  const routes = { [URL]: { body: skill }, [guide]: { body: 'upstream\r\n' } }, net = transport(routes);
  const imported = await importSkill(URL, { ...f, ...net });
  assert.equal(imported.source.kind, 'https'); assert.equal(imported.coverage.universalRetrieval, false);
  assert.equal(verifySkill(imported.id, f).verification, 'verified');
  assert.equal((await checkSkill(imported.id, { ...f, ...net })).status, 'unchanged');
  writeFileSync(path.join(imported.path, 'refs/guide.md'), 'local adaptation');
  routes[guide].body = 'new upstream\n';
  const changed = await checkSkill(imported.id, { ...f, ...net });
  assert.equal(changed.status, 'changed'); assert.deepEqual(changed.changes.modified, ['refs/guide.md']);
  assert.ok(changed.textDiffs[0].text.includes('+new upstream'));
  assert.equal(readFileSync(path.join(imported.path, 'refs/guide.md'), 'utf8'), 'local adaptation');
  assert.equal(readFileSync(path.join(imported.snapshot, 'payload/refs/guide.md'), 'utf8'), 'upstream\r\n');
  delete routes[guide];
  assert.equal((await checkSkill(imported.id, { ...f, ...net })).status, 'unavailable');
  assert.equal(showSkill(imported.id, f).accepted, imported.accepted);
  let output = '';
  assert.equal(await main(['check', imported.id, '--json'], { ...f, ...net, stdout: { write: s => { output += s; } } }), 1);
  assert.equal(JSON.parse(output).status, 'unavailable'); assert.doesNotMatch(output, /CANARY/);
});

test('coverage is explicit and unsafe local mapping never publishes an invalid snapshot', async t => {
  const f = fixture(t);
  const extra = '[Secret](https://u:CANARY@example.com/a.md?x=CANARY)\n[Site](https://example.com/)\n[Script](scripts/run.js)\n';
  const net = transport({ [URL]: { body: skill.replace('[Guide](refs/guide.md)', '') + extra } });
  const imported = await importSkill(URL, { ...f, ...net });
  assert.equal(imported.coverage.unresolved, 1); assert.equal(imported.coverage.external, 2);
  assert.doesNotMatch(JSON.stringify(imported), /CANARY/);
  for (const name of ['.git/notes.md', 'node_modules/notes.md', 'con.md', 'unsafe%2fname%3f.md', '%E0%A4%A.md']) {
    const target = `https://skills.example.com/demo/${name}`;
    const bad = transport({ [URL]: { body: skill.replace('refs/guide.md', name) }, [target]: { body: 'text' } });
    const partial = await importSkill(URL, { ...f, ...bad });
    assert.equal(partial.coverage.acquisition, 'partial');
    assert.equal(partial.dependencies[0].status, 'unresolved');
    assert.equal(verifySkill(partial.id, f).verification, 'verified');
    assert.deepEqual(readdirSync(partial.path), ['SKILL.md']);
  }
  assert.equal(readdirSync(path.join(f.home, '.agent-bot/skills')).filter(name => !name.startsWith('.')).length, 6);
});

test('remote captured-edge provenance survives accepted and locally adapted learning material', async t => {
  const { readSkillMaterial } = await import('../skill-library.mjs');
  const f = fixture(t), remote = 'https://docs.example.com/guide.md';
  const net = transport({ [URL]: { body: skill.replace('refs/guide.md', remote) }, [remote]: { body: 'captured guide\n' } });
  const imported = await importSkill(URL, { ...f, ...net });
  const edge = imported.dependencies[0];
  assert.match(edge.target, /^remote\/[a-f0-9]{64}\/document.md$/);
  for (const selection of ['accepted', 'local']) {
    const material = readSkillMaterial(imported.id, { ...f, selection });
    assert.equal(material.dependencies[0].status, 'captured');
    assert.equal(material.dependencies[0].target, edge.target);
  }
  writeFileSync(path.join(imported.path, edge.target), 'local adaptation');
  const local = readSkillMaterial(imported.id, { ...f, selection: 'local' });
  assert.notEqual(local.digest, imported.accepted);
  assert.equal(local.dependencies[0].target, edge.target);
});

test('source-check redirect provenance changes are recorded even when retained bytes do not', async t => {
  const f = fixture(t), a = 'https://cdn.example.com/a/SKILL.md', b = 'https://cdn.example.com/b/SKILL.md';
  const body = skill.replace('[Guide](refs/guide.md)', '');
  const routes = { [URL]: { status: 302, headers: { location: a } }, [a]: { body }, [b]: { body } }, net = transport(routes);
  const imported = await importSkill(URL, { ...f, ...net });
  routes[URL].headers.location = b;
  const checked = await checkSkill(imported.id, { ...f, ...net });
  assert.equal(checked.status, 'unchanged'); assert.equal(checked.locations[0].resolvedUrl, b);
  assert.equal(showSkill(imported.id, f).locations[0].resolvedUrl, a, 'accepted acquisition receipt is immutable');
});

test('local learning resolves retained relative references outside the original URL directory', async t => {
  const { readSkillMaterial } = await import('../skill-library.mjs');
  const f = fixture(t), net = transport({ [URL]: { body: skill.replace('refs/guide.md', '../guide.md') },
    'https://skills.example.com/guide.md': { body: 'captured elsewhere\n' } });
  const imported = await importSkill(URL, { ...f, ...net });
  const material = readSkillMaterial(imported.id, { ...f, selection: 'local' });
  assert.equal(material.dependencies[0].status, 'captured');
  assert.equal(material.dependencies[0].target, imported.dependencies[0].target);
  assert.match(material.dependencies[0].target, /^remote\//);
});


test('proxy environment cannot select the HTTPS acquisition agent or add credentials', async t => {
  const names = ['NODE_USE_ENV_PROXY', 'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy'];
  const saved = Object.fromEntries(names.map(name => [name, process.env[name]]));
  t.after(() => { for (const [name, value] of Object.entries(saved)) if (value === undefined) delete process.env[name]; else process.env[name] = value; });
  for (const name of names) process.env[name] = name === 'NODE_USE_ENV_PROXY' ? '1' : 'http://user:CANARY@127.0.0.1:9000';
  const net = transport({ [URL]: { body: skill.replace('[Guide](refs/guide.md)', '') } });
  const result = await acquireRemoteSkill(URL, 'owner', net);
  const { agent, headers } = net.calls[0].options;
  assert.ok(agent instanceof Agent); assert.notEqual(agent, globalAgent);
  assert.deepEqual(agent.options.proxyEnv, {});
  assert.deepEqual(Object.keys(headers).sort(), ['Accept-Encoding', 'User-Agent']);
  assert.deepEqual(result.hosts, ['skills.example.com']);
  assert.doesNotMatch(JSON.stringify(result), /CANARY|127\.0\.0\.1/);
});


test('partial import retains good instructions and reports each unavailable dependency without leaking errors', async t => {
  const f = fixture(t), guide = 'https://skills.example.com/demo/refs/guide.md';
  const net = transport({ [URL]: { body: skill + '[Missing](missing.md)\n[Again](missing.md)\n[Private](https://private.example.com/secret.md)\n' },
    [guide]: { body: 'retained dependency\r\n' } }, { addresses: host => [{ address: host.startsWith('private') ? '10.0.0.1' : '93.184.216.34', family: 4 }] });
  let output = '';
  assert.equal(await main(['import', URL, '--json'], { ...f, ...net, stdout: { write: text => { output += text; } } }), 1);
  const result = JSON.parse(output);
  assert.equal(result.coverage.acquisition, 'partial');
  assert.equal(result.coverage.unresolved, 3);
  assert.deepEqual(result.dependencies.map(edge => edge.status), ['captured', 'unresolved', 'unresolved', 'unresolved']);
  assert.equal(result.dependencies.at(-1).reason, 'skill-fetch-address-refused');
  assert.equal(readFileSync(path.join(result.path, 'refs/guide.md'), 'utf8'), 'retained dependency\r\n');
  assert.equal(net.calls.filter(call => call.url.endsWith('/missing.md')).length, 1, 'failed locators are deduplicated');
  assert.equal(net.calls.some(call => new globalThis.URL(call.url).hostname === 'private.example.com'), false);
  assert.doesNotMatch(output, /CANARY/);
  assert.equal(verifySkill(result.id, f).verification, 'verified');
});

test('partial checks retain inspectable candidates but cannot claim freshness or replace accepted/local bytes', async t => {
  const f = fixture(t), guide = 'https://skills.example.com/demo/refs/guide.md';
  const routes = { [URL]: { body: skill }, [guide]: { body: 'original guide' } }, net = transport(routes);
  const imported = await importSkill(URL, { ...f, ...net });
  writeFileSync(path.join(imported.path, 'SKILL.md'), skill + 'local adaptation');
  routes[URL].body = skill + '[Missing](missing.md)\n';
  const checked = await checkSkill(imported.id, { ...f, ...net });
  assert.equal(checked.status, 'unavailable'); assert.equal(checked.reason, 'skill-capture-incomplete');
  assert.notEqual(checked.candidate, imported.accepted);
  assert.equal(checked.dependencies.at(-1).status, 'unresolved');
  assert.equal(readFileSync(path.join(checked.candidatePath, 'payload/SKILL.md'), 'utf8'), routes[URL].body);
  assert.equal(showSkill(imported.id, f).accepted, imported.accepted);
  assert.equal(readFileSync(path.join(imported.snapshot, 'payload/SKILL.md'), 'utf8'), skill);
  assert.equal(readFileSync(path.join(imported.path, 'SKILL.md'), 'utf8'), skill + 'local adaptation');
});

test('partial capture bounds attempted documents, failed response bytes, depth and reference discovery', async t => {
  const f = fixture(t), guide = 'https://skills.example.com/demo/refs/guide.md';
  const body = skill + '[Second](second.md)\n[Third](third.md)\n';
  const routes = { [URL]: { body }, [guide]: { body: 'X'.repeat(256) },
    'https://skills.example.com/demo/second.md': { body: 'Y'.repeat(256) }, 'https://skills.example.com/demo/third.md': { body: 'third' } };
  const limited = transport(routes);
  const partial = await importSkill(URL, { ...f, ...limited, remoteLimits: { documents: 2 } });
  assert.equal(limited.calls.length, 2); assert.equal(partial.coverage.documentAttempts, 2);
  assert.equal(partial.dependencies.at(-1).reason, 'skill-document-limit');
  const bytes = transport(routes);
  const budget = Buffer.byteLength(body) + 255;
  const charged = await importSkill(URL, { ...f, ...bytes, remoteLimits: { bytes: budget, fileBytes: 200 } });
  assert.equal(bytes.calls.length, 2, 'failed body consumes the total byte budget');
  assert.equal(charged.coverage.receivedBytes, Buffer.byteLength(body) + 256);
  assert.equal(charged.dependencies.at(-1).reason, 'skill-byte-limit');
  const refs = await importSkill(URL, { ...f, ...transport(routes), remoteLimits: { references: 1 } });
  assert.equal(refs.dependencies.length, 2); assert.equal(refs.dependencies.at(-1).reason, 'skill-reference-limit');
  assert.equal(refs.coverage.discoveryTruncated, true);
  const depth = await importSkill(URL, { ...f, ...transport({ [URL]: { body: skill }, [guide]: { body: '[Deep](deep.md)' } }), remoteLimits: { depth: 1 } });
  assert.equal(depth.dependencies.at(-1).reason, 'skill-depth-limit');
  assert.equal(depth.coverage.acquisition, 'partial');
});


test('depth-limited diamonds capture shallow paths and expand their descendants independent of link order', async () => {
  const base = 'https://skills.example.com/demo/';
  for (const links of ['[A](a.md)\n[X](x.md)', '[X](x.md)\n[A](a.md)']) {
    const net = transport({ [URL]: { body: skill.replace('[Guide](refs/guide.md)', links) },
      [`${base}a.md`]: { body: '[B](b.md)' }, [`${base}b.md`]: { body: '[X](x.md)' },
      [`${base}x.md`]: { body: '[Y](y.md)' }, [`${base}y.md`]: { body: 'retained within depth 2' } });
    const result = await acquireRemoteSkill(URL, 'owner', { ...net, remoteLimits: { depth: 2 } });
    assert.equal(result.coverage.acquisition, 'complete-within-boundary');
    assert.equal(result.dependencies.every(edge => edge.status === 'captured'), true);
    assert.deepEqual(result.entries.map(entry => entry.path).sort(), ['SKILL.md', 'a.md', 'b.md', 'x.md', 'y.md']);
    assert.equal(net.calls.filter(call => call.url === `${base}x.md`).length, 1);
    assert.equal(net.calls.filter(call => call.url === `${base}y.md`).length, 1);
  }
});
