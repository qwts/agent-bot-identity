// The soul's own MCP entry (#378): one native file per harness, rendered by
// soul-builder, merged into whatever the soul already declares, and reported by
// `soul build --check --json`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildHarnessFiles, harnessReport, MCP_SERVER_NAME, MCP_TARGETS, mergeableMcpServers, soulCommsDeclared } from '../soul-builder.mjs';
import { buildSoulDirectory } from '../soul-build.mjs';
import { computePackageRevision, readSoulPackageEntries, PACKAGE_IGNORE_LIST, GENERATED_HARNESS_MARKER as MARKER } from '../soul-package.mjs';
const cli = fileURLToPath(new URL('../agent-bot.mjs', import.meta.url));

const ENTRY = { command: 'agent-bot', args: ['reach-mcp'] };
const LOCAL = { type: 'local', command: ['agent-bot', 'reach-mcp'] };

// A minimal format-2 soul package: AGENTS.md, soul.json and nothing else, so
// every assertion below is about this slice's output alone.
function packageEntries(manifest = {}) {
  const soul = { formatVersion: 2, name: 'Ted', description: 'Engineer', displaySeed: 'ted',
    preferredHarnesses: [], parentRevision: null, revision: `sha256:${'0'.repeat(64)}`,
    ignore: PACKAGE_IGNORE_LIST, ...manifest };
  return [
    { path: 'AGENTS.md', mode: '100644', bytes: Buffer.from('# Ted\n') },
    { path: 'soul.json', mode: '100644', bytes: Buffer.from(`${JSON.stringify(soul, null, 2)}\n`) },
  ];
}

function put(root, path, bytes) {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), bytes);
}

// A real soul directory on disk, with the manifest revision recomputed the way
// a package edit does it, so revisions mean something in these assertions.
function fixture(t, manifest = {}) {
  const root = mkdtempSync(join(tmpdir(), 'soul-mcp-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const { path, bytes } of packageEntries(manifest)) put(root, path, bytes);
  reseal(root);
  return root;
}

function reseal(root) {
  const file = join(root, 'soul.json');
  const manifest = JSON.parse(readFileSync(file, 'utf8'));
  manifest.revision = computePackageRevision(root, { manifest });
  writeFileSync(file, `${JSON.stringify(manifest, null, 2)}\n`);
}

const cliRun = (root, ...args) => spawnSync(process.execPath, [cli, 'soul', 'build', ...args, ...(root ? [root] : [])],
  { encoding: 'utf8', env: { PATH: process.env.PATH, HOME: root } });

test('each harness gets the reach/comms server in its own native file', () => {
  const output = buildHarnessFiles(packageEntries());
  assert.deepEqual(JSON.parse(output.get('.mcp.json').toString()),
    { _comment: MARKER, mcpServers: { [MCP_SERVER_NAME]: ENTRY } });
  assert.deepEqual(JSON.parse(output.get('.gemini/settings.json').toString()),
    { _comment: MARKER, mcpServers: { [MCP_SERVER_NAME]: ENTRY } });
  assert.deepEqual(JSON.parse(output.get('opencode.json').toString()),
    { _comment: MARKER, mcp: { [MCP_SERVER_NAME]: LOCAL } });
  assert.equal(output.get('.codex/config.toml').toString(),
    `# ${MARKER}\n[mcp_servers.agent-bot]\ncommand = "agent-bot"\nargs = ["reach-mcp"]\n`);
  // Portable: no absolute path, no host-specific state, only PATH's agent-bot.
  for (const bytes of output.values()) {
    const content = bytes.toString();
    assert.equal(content.includes(process.cwd()), false);
    assert.equal(content.includes(process.env.HOME ?? '/'), false);
    assert.match(content, new RegExp(MARKER.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  }
  for (const path of ['.mcp.json', '.gemini/settings.json', '.codex/config.toml', 'opencode.json']) {
    assert.ok([...output.keys()].includes(path), path);
  }
});

test('comms off renders no MCP entry anywhere, and a rebuild removes the old ones', (t) => {
  const source = packageEntries({ comms: false });
  assert.equal(soulCommsDeclared(new Map([['soul.json', source[1].bytes]])), false);
  const output = buildHarnessFiles(source);
  for (const { path } of MCP_TARGETS) assert.equal(output.has(path), false, path);
  const report = harnessReport(output, { comms: false });
  assert.ok(Object.values(report).every((entry) => entry.rendered.includes('instructions')));
  // No AGENTS.md means no build at all, so nothing is reported as rendered.
  assert.ok(Object.values(harnessReport(new Map())).every((entry) => entry.rendered.length === 0 && entry.files.length === 0));

  const root = fixture(t);
  buildSoulDirectory(root);
  assert.equal(existsSync(join(root, '.mcp.json')), true);
  put(root, 'soul.json', Buffer.from(readFileSync(join(root, 'soul.json'), 'utf8').replace('"parentRevision"', '"comms": false,\n  "parentRevision"')));
  reseal(root);
  const removals = buildSoulDirectory(root, { check: true }).removals;
  assert.deepEqual(removals, ['.codex/config.toml', '.gemini/settings.json', '.mcp.json', 'opencode.json']);
  buildSoulDirectory(root);
  for (const { path } of MCP_TARGETS) assert.equal(existsSync(join(root, path)), false, path);
});

test('comms off leaves a soul\'s own MCP file alone and reports no merge', (t) => {
  const root = fixture(t, { comms: false });
  const own = `${JSON.stringify({ mcpServers: { postgres: { command: 'pg' } } }, null, 2)}\n`;
  put(root, '.mcp.json', own);
  reseal(root);
  const result = buildSoulDirectory(root);
  assert.deepEqual({ writes: result.writes, removals: result.removals, merged: result.merged },
    { writes: ['CLAUDE.md', 'GEMINI.md'], removals: [], merged: [] });
  assert.equal(readFileSync(join(root, '.mcp.json'), 'utf8'), own);
  assert.deepEqual(result.harnesses.claude.rendered, ['instructions']);
});

test('a soul that ships its own MCP file keeps its servers and gains ours', (t) => {
  const root = fixture(t);
  put(root, '.mcp.json', `${JSON.stringify({ mcpServers: { postgres: { command: 'pg-mcp' } } }, null, 2)}\n`);
  put(root, '.gemini/settings.json', `${JSON.stringify({ theme: 'Dracula' }, null, 2)}\n`);
  put(root, 'opencode.json', `${JSON.stringify({ model: 'anthropic/claude-sonnet-4-5', mcp: { files: LOCAL } }, null, 2)}\n`);
  put(root, '.codex/config.toml', 'model = "gpt-5"\n\n[mcp_servers.agent-bot]\ncommand = "stale"\n\n[mcp_servers.pg]\ncommand = "pg-mcp"\n');
  reseal(root);

  const checked = buildSoulDirectory(root, { check: true });
  assert.deepEqual(checked.merged, [
    { path: '.codex/config.toml', harness: 'codex', kept: ['agent-bot', 'pg'] },
    { path: '.gemini/settings.json', harness: 'gemini', kept: [] },
    { path: '.mcp.json', harness: 'claude', kept: ['postgres'] },
    { path: 'opencode.json', harness: 'opencode', kept: ['files'] },
  ]);
  assert.deepEqual(checked.writes, ['.codex/config.toml', '.gemini/settings.json', '.mcp.json', 'CLAUDE.md', 'GEMINI.md', 'opencode.json']);
  assert.equal(readFileSync(join(root, '.mcp.json'), 'utf8'), `${JSON.stringify({ mcpServers: { postgres: { command: 'pg-mcp' } } }, null, 2)}\n`,
    '--check never writes');
  buildSoulDirectory(root);

  assert.deepEqual(JSON.parse(readFileSync(join(root, '.mcp.json'), 'utf8')), {
    _comment: MARKER, mcpServers: { postgres: { command: 'pg-mcp' }, [MCP_SERVER_NAME]: ENTRY },
  });
  assert.deepEqual(JSON.parse(readFileSync(join(root, '.gemini/settings.json'), 'utf8')),
    { _comment: MARKER, theme: 'Dracula', mcpServers: { [MCP_SERVER_NAME]: ENTRY } });
  assert.deepEqual(JSON.parse(readFileSync(join(root, 'opencode.json'), 'utf8')), {
    _comment: MARKER, model: 'anthropic/claude-sonnet-4-5', mcp: { files: LOCAL, [MCP_SERVER_NAME]: LOCAL },
  });
  const toml = readFileSync(join(root, '.codex/config.toml'), 'utf8');
  assert.equal(toml, `# ${MARKER}\nmodel = "gpt-5"\n\n[mcp_servers.pg]\ncommand = "pg-mcp"\n\n[mcp_servers.agent-bot]\ncommand = "agent-bot"\nargs = ["reach-mcp"]\n`);
  assert.equal(toml.includes('stale'), false);

  // Rebuilding is a no-op: our own output is the merge base, byte for byte.
  const before = readFileSync(join(root, '.mcp.json'), 'utf8');
  const revision = computePackageRevision(root);
  assert.deepEqual(buildSoulDirectory(root, { check: true }).drift, []);
  assert.equal(buildSoulDirectory(root).merged.length, 0, 'our own output is not reported as a merge');
  assert.equal(readFileSync(join(root, '.mcp.json'), 'utf8'), before);
  assert.equal(computePackageRevision(root), revision, 'the merged file is stable across rebuilds');
});

test('unmergeable authored MCP content fails closed instead of being replaced', (t) => {
  const cases = [
    ['.mcp.json', '[1, 2]\n', /must be a JSON object/],
    ['.mcp.json', '{ not json\n', /not valid JSON/],
    ['.mcp.json', `${JSON.stringify({ mcpServers: [] })}\n`, /must be a JSON object of servers/],
    ['.codex/config.toml', Buffer.from('model = "x"\n\0\n'), /binary/],
  ];
  for (const [path, bytes, expected] of cases) {
    const root = fixture(t);
    put(root, path, bytes);
    reseal(root);
    const before = readFileSync(join(root, path));
    assert.throws(() => buildSoulDirectory(root), expected, path);
    assert.throws(() => buildSoulDirectory(root, { check: true }), expected, path);
    assert.deepEqual(readFileSync(join(root, path)), before, path);
  }
});

test('output is deterministic and every generated file carries the marker', (t) => {
  const root = fixture(t);
  const forward = buildHarnessFiles(packageEntries());
  const reversed = buildHarnessFiles([...packageEntries()].reverse());
  const minimal = buildHarnessFiles([{ path: 'AGENTS.md', mode: '100644', bytes: Buffer.from('# Ted\n') }]);
  assert.deepEqual([...forward], [...reversed]);
  assert.deepEqual([...forward], [...minimal], 'the soul.json revision is not build input');
  for (const bytes of forward.values()) assert.ok(bytes.toString().includes(MARKER));

  buildSoulDirectory(root);
  const revision = computePackageRevision(root);
  const rendered = MCP_TARGETS.map(({ path }) => readFileSync(join(root, path), 'utf8'));
  const result = buildSoulDirectory(root, { check: true });
  assert.deepEqual({ drift: result.drift, writes: result.writes, removals: result.removals, merged: result.merged },
    { drift: [], writes: [], removals: [], merged: [] });
  assert.deepEqual(result.harnesses, harnessReport(buildHarnessFiles(readEntries(root))));
  assert.deepEqual(MCP_TARGETS.map(({ path }) => readFileSync(join(root, path), 'utf8')), rendered);
  assert.equal(computePackageRevision(root), revision, 'a rebuild leaves the revision alone');
  // Rendered MCP output is package-ignored: it never reaches the revision.
  assert.deepEqual(readSoulPackageEntries(root).entries.filter((entry) => MCP_TARGETS.some(({ path }) => path === entry.path)), []);
});

function readEntries(root) {
  return packageEntries().map(({ path }) => ({ path, mode: '100644', bytes: readFileSync(join(root, path)) }));
}

test('a hand-edited generated MCP file is merged, and other unmarked paths still conflict', (t) => {
  const root = fixture(t);
  buildSoulDirectory(root);
  const edited = `${JSON.stringify({ mcpServers: { postgres: { command: 'pg' } } }, null, 2)}\n`;
  put(root, '.mcp.json', edited);
  const result = buildSoulDirectory(root);
  assert.deepEqual(result.merged, [{ path: '.mcp.json', harness: 'claude', kept: ['postgres'] }]);
  assert.deepEqual(result.writes, ['.mcp.json']);
  assert.deepEqual(JSON.parse(readFileSync(join(root, '.mcp.json'), 'utf8')).mcpServers,
    { postgres: { command: 'pg' }, [MCP_SERVER_NAME]: ENTRY });
  put(root, 'CLAUDE.md', 'authored\n');
  assert.throws(() => buildSoulDirectory(root), /unmarked.*CLAUDE.md/);
  assert.equal(readFileSync(join(root, 'CLAUDE.md'), 'utf8'), 'authored\n');
});

test('--check --json reports every harness and never leaves a primitive unreported', (t) => {
  const root = fixture(t);
  const dirty = cliRun(root, '--check', '--json');
  assert.equal(dirty.status, 1);
  const report = JSON.parse(dirty.stdout);
  assert.deepEqual(Object.keys(report).sort(), ['drift', 'harnesses', 'merged', 'removals', 'writes']);
  assert.deepEqual(report.drift.sort(), ['.codex/config.toml', '.gemini/settings.json', '.mcp.json', 'CLAUDE.md', 'GEMINI.md', 'opencode.json']);
  assert.deepEqual(report.merged, []);
  assert.deepEqual(report.harnesses.claude, {
    rendered: ['instructions', 'mcp'], files: ['.mcp.json', 'CLAUDE.md'],
    subagents: { received: [], rendered: [] }, commands: { received: [], rendered: [] },
    unsupported: { subagents: [], commands: [] },
  });
  assert.deepEqual(report.harnesses.codex.rendered, ['instructions', 'mcp']);
  assert.deepEqual(report.harnesses.gemini.files, ['.gemini/settings.json', 'GEMINI.md']);
  assert.deepEqual(report.harnesses.opencode.files, ['opencode.json']);
  // Every harness the toolkit knows is named, so nothing is dropped in silence.
  assert.deepEqual(Object.keys(report.harnesses).sort(), ['claude', 'codex', 'copilot', 'cursor', 'devin', 'gemini', 'muse', 'opencode']);
  assert.ok(Object.values(report.harnesses).every((entry) => entry.rendered.includes('instructions')
    && Object.values(entry.unsupported).every((names) => names.length === 0)));
  // Harnesses without an MCP adapter in this slice say so by omission.
  assert.deepEqual(report.harnesses.muse.rendered, ['instructions']);
  assert.equal(report.harnesses.cursor.mcp, undefined);

  assert.equal(cliRun(root).status, 0);
  const clean = cliRun(root, '--check', '--json');
  assert.equal(clean.status, 0);
  assert.deepEqual(JSON.parse(clean.stdout).drift, []);
  // The default output names the same primitives without JSON.
  const plain = spawnSync(process.execPath, [cli, 'soul', 'build', root], { encoding: 'utf8', env: { PATH: process.env.PATH, HOME: root } });
  assert.equal(plain.status, 0);
  assert.match(plain.stdout, /^agent-bot soul build: 0 written, 0 removed, 0 merged\n/);
  assert.match(plain.stdout, /^claude: instructions, mcp$/m);
});

test('skills stay the only other primitive, and the merge names what it kept', (t) => {
  const root = fixture(t);
  put(root, 'skills/hello/SKILL.md', '---\nname: hello\ndescription: Say hello\n---\nHello\n');
  put(root, '.mcp.json', `${JSON.stringify({ mcpServers: { postgres: {}, files: {} } }, null, 2)}\n`);
  reseal(root);
  const report = buildSoulDirectory(root, { check: true });
  assert.deepEqual(report.merged[0].kept, ['files', 'postgres']);
  assert.equal(mergeableMcpServers('.mcp.json', Buffer.from('{}\n')).length, 0);
  buildSoulDirectory(root);
  const rendered = harnessReport(buildHarnessFiles(readEntriesWithSkills(root)), { comms: true });
  assert.deepEqual(rendered.claude.rendered, ['instructions', 'skills', 'mcp']);
  assert.deepEqual(rendered.claude.files, ['.claude/skills/hello/SKILL.md', '.mcp.json', 'CLAUDE.md']);
  assert.deepEqual(rendered.gemini.files, ['.gemini/settings.json', '.gemini/skills/hello/SKILL.md', 'GEMINI.md']);
  assert.deepEqual(rendered.codex.rendered, ['instructions', 'skills', 'mcp']);
  assert.deepEqual(rendered.cursor.rendered, ['instructions', 'skills']);
  assert.deepEqual(rendered.cursor.files, ['.claude/skills/hello/SKILL.md']);
  assert.deepEqual(rendered.muse.rendered, ['instructions', 'skills'], 'a harness with no skills directory still counts shared skills');
});

function readEntriesWithSkills(root) {
  return [
    ...readEntries(root),
    { path: 'skills/hello/SKILL.md', mode: '100644', bytes: readFileSync(join(root, 'skills/hello/SKILL.md')) },
  ];
}
