// More harness adapters (#378): Cursor's and Kiro's MCP files, native
// subagent files for Cursor, Copilot CLI, Kiro and Devin CLI, and the shared
// Claude files Copilot CLI and Devin CLI read natively (`.mcp.json`,
// `.claude/commands/`). Each new path renders deterministically, rebuilds
// byte for byte, conflicts when an unmarked file sits there, and is reported.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildHarnessFiles, harnessReport } from '../soul-builder.mjs';
import { buildSoulDirectory } from '../soul-build.mjs';
import { computePackageRevision, validateSoulPackage, PACKAGE_IGNORE_LIST, PRIOR_PACKAGE_IGNORE_LISTS } from '../soul-package.mjs';
import { GENERATED_HARNESS_MARKER as MARKER, isGeneratedPath } from '../soul-harness-contract.mjs';

const cli = fileURLToPath(new URL('../agent-bot.mjs', import.meta.url));
const entry = (path, content) => ({ path, mode: '100644', bytes: Buffer.from(content) });
const declare = (name, tools) => `---\nname: ${name}\ndescription: Review code\n${tools === undefined ? '' : `tools: ${tools}\n`}model: provider/model\n---\nReview the code.\n`;
const source = (agents = { review: 'Read, Grep, Bash' }) => [entry('AGENTS.md', '# Soul\n'),
  ...Object.entries(agents).map(([name, tools]) => entry(`agents/${name}.md`, declare(name, tools)))];
const AGENT_PATHS = (name) => [`.cursor/agents/${name}.md`, `.devin/agents/${name}.md`, `.github/agents/${name}.agent.md`, `.kiro/agents/${name}.md`];
const NEW_PATHS = [...AGENT_PATHS('review'), '.cursor/mcp.json', '.kiro/settings/mcp.json'];

function put(root, path, content) {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), content);
}
function reseal(root) {
  const file = join(root, 'soul.json');
  const manifest = JSON.parse(readFileSync(file, 'utf8'));
  manifest.revision = computePackageRevision(root, { manifest });
  writeFileSync(file, `${JSON.stringify(manifest, null, 2)}\n`);
}
function fixture(t, { ignore = PACKAGE_IGNORE_LIST, agents } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'soul-adapters-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const { path, bytes } of source(agents)) put(root, path, bytes);
  put(root, 'soul.json', `${JSON.stringify({ formatVersion: 2, name: 'Adapters', description: 'Adapter tests', displaySeed: 'adapters',
    preferredHarnesses: [], parentRevision: null, revision: `sha256:${'0'.repeat(64)}`, ignore }, null, 2)}\n`);
  reseal(root);
  return root;
}

test('each subagent adapter writes its documented front matter', () => {
  const output = buildHarnessFiles(source());
  const head = '---\nname: "review"\ndescription: "Review code"\nmodel: "provider/model"\n';
  const body = `---\n${MARKER}\nReview the code.\n`;
  assert.equal(output.get('.cursor/agents/review.md').toString(), `${head}${body}`, 'Bash can write: no readonly flag');
  assert.equal(output.get('.github/agents/review.agent.md').toString(), `${head}tools: ["Read", "Grep", "Bash"]\n${body}`);
  assert.equal(output.get('.kiro/agents/review.md').toString(), `${head}tools: ["read", "shell"]\n${body}`);
  assert.equal(output.get('.devin/agents/review.md').toString(), `${head}allowed-tools: ["exec", "grep", "read"]\n${body}`);
  for (const path of NEW_PATHS) assert.ok(isGeneratedPath(path), path);
});

test('tool translation: inherit, read-only, empty, and names a harness cannot spell', () => {
  const output = buildHarnessFiles(source({ open: undefined, reader: '[Read, Grep, WebFetch]', none: '[]', mcp: 'Read, mcp__db__query' }));
  // No `tools`: every tool, as in Claude. Kiro's default is undocumented, so `*`.
  assert.doesNotMatch(output.get('.cursor/agents/open.md').toString(), /readonly|tools/);
  assert.doesNotMatch(output.get('.github/agents/open.agent.md').toString(), /tools/);
  assert.doesNotMatch(output.get('.devin/agents/open.md').toString(), /tools/);
  assert.match(output.get('.kiro/agents/open.md').toString(), /\ntools: \["\*"\]\n/);
  // Only read-only tools: Cursor's `readonly` keeps the agent read-only.
  assert.match(output.get('.cursor/agents/reader.md').toString(), /\nreadonly: true\n/);
  assert.match(output.get('.kiro/agents/reader.md').toString(), /\ntools: \["read", "web"\]\n/);
  assert.equal(output.has('.devin/agents/reader.md'), false, 'Devin documents no web tool name');
  // An empty allowlist stays empty.
  assert.match(output.get('.cursor/agents/none.md').toString(), /\nreadonly: true\n/);
  assert.match(output.get('.github/agents/none.agent.md').toString(), /\ntools: \[\]\n/);
  assert.match(output.get('.kiro/agents/none.md').toString(), /\ntools: \[\]\n/);
  assert.match(output.get('.devin/agents/none.md').toString(), /\nallowed-tools: \[\]\n/);
  // An MCP tool: Kiro cannot name it, so it is not rendered there and is
  // reported; Devin spells MCP tools as Claude does and keeps the exact name.
  assert.equal(output.has('.kiro/agents/mcp.md'), false);
  assert.match(output.get('.devin/agents/mcp.md').toString(), /\nallowed-tools: \["mcp__db__query", "read"\]\n/);
  assert.match(output.get('.github/agents/mcp.agent.md').toString(), /\ntools: \["Read", "mcp__db__query"\]\n/);
  const report = harnessReport(output);
  assert.deepEqual(report.kiro.subagents, { received: ['mcp', 'none', 'open', 'reader'], rendered: ['none', 'open', 'reader'] });
  assert.deepEqual(report.kiro.unsupported.subagents, ['mcp']);
  assert.deepEqual(report.devin.unsupported.subagents, ['reader']);
  assert.deepEqual(report.copilot.subagents.rendered, ['mcp', 'none', 'open', 'reader'], '`.agent.md` is not part of the name');
  assert.deepEqual(report.cursor.unsupported.subagents, []);
});

// Devin's documented tool names are read, edit, grep, glob and exec; `edit`
// covers file writes and there is no `write`. MCP tools keep Claude's
// `mcp__<server>__<tool>` name; anything else stays unsupported (#378).
test('Devin subagents spell Write as edit and keep exact MCP tool names', () => {
  const output = buildHarnessFiles(source({
    writer: 'Read, Write', editor: 'Edit, MultiEdit, Write', messenger: 'Read, mcp__agent-reach__send_message',
    mixed: 'Bash, mcp__agent-reach__fleet, mcp__agent-reach__send_message', fetcher: 'mcp__agent-reach__fleet, WebFetch',
    nameless: 'Read, mcp__agent-reach', empty: 'mcp____send', underscored: 'mcp___reach__send', nested: 'mcp__foo__bar__baz',
  }));
  const tools = (name) => output.get(`.devin/agents/${name}.md`)?.toString().match(/\nallowed-tools: (.*)\n/)?.[1];
  assert.equal(tools('writer'), '["edit", "read"]');
  assert.equal(tools('editor'), '["edit"]');
  assert.equal(tools('messenger'), '["mcp__agent-reach__send_message", "read"]');
  assert.equal(tools('mixed'), '["exec", "mcp__agent-reach__fleet", "mcp__agent-reach__send_message"]');
  assert.equal(tools('nested'), '["mcp__foo__bar__baz"]', 'the first __ ends the server; the name is kept verbatim');
  for (const name of ['fetcher', 'nameless', 'empty', 'underscored']) assert.equal(output.has(`.devin/agents/${name}.md`), false, name);
  const devinFiles = [...output].filter(([path]) => path.startsWith('.devin/agents/')).map(([, bytes]) => String(bytes)).join('');
  assert.doesNotMatch(devinFiles, /"write"/, 'Devin has no write tool name');
  const report = harnessReport(output);
  assert.deepEqual(report.devin.unsupported.subagents, ['empty', 'fetcher', 'nameless', 'underscored']);
  // Kiro is unchanged: an MCP tool still has no Kiro spelling.
  assert.deepEqual(report.kiro.unsupported.subagents, ['empty', 'fetcher', 'messenger', 'mixed', 'nameless', 'nested', 'underscored']);
  assert.match(output.get('.kiro/agents/writer.md').toString(), /\ntools: \["read", "write"\]\n/, 'Kiro keeps its write category');
});

test('Copilot CLI and Devin CLI are reported on the shared Claude MCP and command files', () => {
  const output = buildHarnessFiles([...source(), entry('commands/ship.md', 'Ship $ARGUMENTS\n')]);
  const report = harnessReport(output);
  for (const harness of ['copilot', 'devin']) {
    assert.deepEqual(report[harness].rendered, ['instructions', 'mcp', 'subagents', 'commands']);
    assert.deepEqual(report[harness].commands, { received: ['ship'], rendered: ['ship'] });
    assert.ok(report[harness].files.includes('.mcp.json') && report[harness].files.includes('.claude/commands/ship.md'));
  }
  // Cursor's commands were replaced by skills and Kiro documents no prompt file format.
  for (const harness of ['cursor', 'kiro', 'gemini']) {
    assert.deepEqual(report[harness].unsupported.commands, harness === 'gemini' ? [] : ['ship'], harness);
  }
  assert.deepEqual(report.gemini.unsupported.subagents, ['review']);
  assert.deepEqual(report.muse.unsupported.subagents, ['review']);
});

test('the new files build, rebuild byte for byte, and leave the revision alone', (t) => {
  const root = fixture(t);
  const revision = computePackageRevision(root);
  const result = buildSoulDirectory(root);
  for (const path of NEW_PATHS) assert.ok(result.writes.includes(path), path);
  const bytes = NEW_PATHS.map((path) => readFileSync(join(root, path)));
  assert.equal(computePackageRevision(root), revision);
  assert.equal(validateSoulPackage(root).revision, revision);
  assert.deepEqual(buildSoulDirectory(root, { check: true }).drift, []);
  buildSoulDirectory(root);
  assert.deepEqual(NEW_PATHS.map((path) => readFileSync(join(root, path))), bytes);
  // Dropping the declaration removes its files and the emptied folders.
  rmSync(join(root, 'agents'), { recursive: true });
  reseal(root);
  assert.deepEqual(buildSoulDirectory(root, { check: true }).removals.filter((path) => /agents?\//.test(path)),
    ['.claude/agents/review.md', '.cursor/agents/review.md', '.devin/agents/review.md', '.github/agents/review.agent.md', '.kiro/agents/review.md', '.opencode/agent/review.md']);
  buildSoulDirectory(root);
  for (const folder of ['.github/agents', '.kiro/agents', '.cursor/agents', '.devin']) assert.equal(existsSync(join(root, folder)), false, folder);
  assert.ok(existsSync(join(root, '.kiro/settings/mcp.json')), 'the MCP file stays');
});

test('an unmarked file at a new subagent path conflicts and is never overwritten', (t) => {
  for (const path of AGENT_PATHS('review')) {
    const root = fixture(t);
    put(root, path, 'authored\n');
    for (const check of [true, false]) assert.throws(() => buildSoulDirectory(root, { check }), /unmarked generated path conflict/, path);
    assert.equal(readFileSync(join(root, path), 'utf8'), 'authored\n');
  }
});

test('a soul\'s other files in .github/ and .kiro/ stay its own', (t) => {
  const root = fixture(t);
  put(root, '.github/agents/own.agent.md', '---\ndescription: Mine\n---\nMine.\n');
  put(root, '.kiro/steering/style.md', 'Style.\n');
  put(root, '.github/workflows/ci.yml', 'on: push\n');
  reseal(root);
  buildSoulDirectory(root);
  buildSoulDirectory(root);
  assert.equal(readFileSync(join(root, '.github/agents/own.agent.md'), 'utf8'), '---\ndescription: Mine\n---\nMine.\n');
  assert.equal(readFileSync(join(root, '.kiro/steering/style.md'), 'utf8'), 'Style.\n');
  for (const path of ['.kiro/steering/style.md', '.github/workflows/ci.yml', '.kiro/settings/cli.json']) assert.equal(isGeneratedPath(path), false, path);
  assert.equal(validateSoulPackage(root).revision, JSON.parse(readFileSync(join(root, 'soul.json'), 'utf8')).revision);
});

test('the ignore list only grows by the adapters\' paths; every list before it still validates and builds', (t) => {
  // #247 appended Qwen Code's settings file after this slice's list.
  const adapters = PRIOR_PACKAGE_IGNORE_LISTS[0].generatedPaths;
  const prior = PRIOR_PACKAGE_IGNORE_LISTS[1].generatedPaths;
  assert.deepEqual(PACKAGE_IGNORE_LIST.generatedPaths.slice(0, adapters.length), adapters);
  assert.deepEqual(adapters.slice(0, prior.length), prior);
  assert.deepEqual(adapters.slice(prior.length), ['.github/agents/', '.kiro/agents/', '.kiro/settings/mcp.json']);
  assert.equal(isGeneratedPath('.github/hooks/other.json'), false);
  for (const ignore of PRIOR_PACKAGE_IGNORE_LISTS) {
    const root = fixture(t, { ignore });
    const revision = JSON.parse(readFileSync(join(root, 'soul.json'), 'utf8')).revision;
    assert.equal(validateSoulPackage(root).revision, revision);
    buildSoulDirectory(root);
    for (const path of NEW_PATHS) assert.ok(existsSync(join(root, path)), path);
    assert.equal(validateSoulPackage(root).revision, revision, 'the new output is exact build bytes, not content');
  }
});

test('soul build --check --json and the plain summary name what each adapter could not spell', (t) => {
  const root = fixture(t, { agents: { review: 'Read, Grep, Bash', web: 'Read, WebSearch' } });
  const run = (...args) => spawnSync(process.execPath, [cli, 'soul', 'build', root, ...args], { encoding: 'utf8', env: { PATH: process.env.PATH, HOME: root } });
  const dirty = run('--check', '--json');
  assert.equal(dirty.status, 1, dirty.stderr);
  const report = JSON.parse(dirty.stdout).harnesses;
  assert.deepEqual(report.devin.subagents, { received: ['review', 'web'], rendered: ['review'] });
  assert.deepEqual(report.devin.unsupported.subagents, ['web']);
  assert.deepEqual(report.kiro.unsupported.subagents, []);
  assert.deepEqual(report.gemini.unsupported.subagents, ['review', 'web']);
  const plain = run();
  assert.equal(plain.status, 0, plain.stderr);
  assert.match(plain.stdout, /^devin: instructions, mcp, subagents \(unsupported: subagents web\)$/m);
  assert.match(plain.stdout, /^kiro: instructions, mcp, subagents$/m);
  assert.match(plain.stdout, /^cursor: instructions, mcp, subagents$/m);
  assert.match(plain.stdout, /^copilot: instructions, mcp, subagents$/m);
  assert.equal(run('--check').status, 0);
});
