import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildHarnessFiles, harnessReport } from '../soul-builder.mjs';
import { buildSoulDirectory } from '../soul-build.mjs';
import { computePackageRevision, expectedGeneratedFiles, readSoulPackageEntries, PACKAGE_IGNORE_LIST } from '../soul-package.mjs';
import { GENERATED_HARNESS_MARKER as MARKER, isGeneratedPath } from '../soul-harness-contract.mjs';

const agent = '---\nname: review\ndescription: Review code\ntools: Read, Grep, Bash\nmodel: provider/model\n---\nReview the code.\n';
const command = '---\ndescription: "Review: code"\nargument-hint: "[path]"\n---\nReview $ARGUMENTS.\nThen summarize $ARGUMENTS.\n';
const entry = (path, content) => ({ path, mode: '100644', bytes: Buffer.from(content) });
const entries = () => [entry('AGENTS.md', '# Soul\n'), entry('agents/review.md', agent), entry('commands/review.md', command)];
const primitivePaths = ['.claude/agents/review.md', '.claude/commands/review.md', '.gemini/commands/review.toml',
  '.opencode/agent/review.md', '.opencode/command/review.md'];
function put(root, path, content) {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), content);
}
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'soul-primitives-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const { path, bytes } of entries()) put(root, path, bytes);
  const manifest = { formatVersion: 2, name: 'Builder', description: 'Builder tests', displaySeed: 'builder',
    preferredHarnesses: ['codex'], parentRevision: null, revision: `sha256:${'0'.repeat(64)}`, ignore: PACKAGE_IGNORE_LIST };
  put(root, 'soul.json', JSON.stringify(manifest));
  manifest.revision = computePackageRevision(root);
  put(root, 'soul.json', JSON.stringify(manifest));
  return root;
}

test('agents and commands map to native formats and retain Claude source bytes apart from the marker', () => {
  const output = buildHarnessFiles(entries());
  assert.equal(output.get('.claude/agents/review.md').toString().replace(`${MARKER}\n`, ''), agent);
  assert.equal(output.get('.claude/commands/review.md').toString().replace(`${MARKER}\n`, ''), command);
  assert.equal(output.get('.opencode/agent/review.md').toString(),
    `---\ndescription: "Review code"\nmode: subagent\nmodel: "provider/model"\ntools:\n  "*": false\n  "bash": true\n  "grep": true\n  "read": true\n---\n${MARKER}\nReview the code.\n`);
  assert.equal(output.get('.opencode/command/review.md').toString(),
    `---\ndescription: "Review: code"\n---\n${MARKER}\nReview $ARGUMENTS.\nThen summarize $ARGUMENTS.\n`);
  assert.equal(output.get('.gemini/commands/review.toml').toString(),
    `# ${MARKER}\ndescription = "Review: code"\nprompt = "Review {{args}}.\\nThen summarize {{args}}.\\n"\n`);
  assert.deepEqual([...output.keys()].filter((path) => /\/(agents?|commands?)\//.test(path)), primitivePaths);
  for (const path of primitivePaths) assert.ok(isGeneratedPath(path), path);
});

for (const harness of ['claude', 'gemini', 'codex', 'opencode', 'cursor', 'copilot', 'devin', 'muse', 'kiro']) {
  test(`${harness} reports every received, rendered and unsupported primitive`, () => {
    const output = buildHarnessFiles(entries());
    const report = harnessReport(new Map(output))[harness];
    for (const [kind, supported] of [['subagents', ['claude', 'opencode']], ['commands', ['claude', 'gemini', 'opencode']]]) {
      const renders = supported.includes(harness);
      assert.deepEqual(report[kind], { received: ['review'], rendered: renders ? ['review'] : [] });
      assert.deepEqual(report.unsupported[kind], renders ? [] : ['review']);
      assert.equal(report.rendered.includes(kind), renders);
    }
    const prefix = harness === 'opencode' ? '.opencode/' : `.${harness}/`;
    assert.deepEqual(report.files.filter((path) => primitivePaths.includes(path)), primitivePaths.filter((path) => path.startsWith(prefix)));
  });
}

test('optional command front matter and optional agent tools/model can be absent', () => {
  const source = [entry('AGENTS.md', '# Soul'), entry('commands/review.md', 'Run $ARGUMENTS'),
    entry('agents/review.md', '---\nname: review\ndescription: Review\n---\nPrompt')];
  const output = buildHarnessFiles(source);
  assert.equal(output.get('.claude/commands/review.md').toString(), `${MARKER}\nRun $ARGUMENTS`);
  assert.equal(output.get('.opencode/command/review.md').toString(), `${MARKER}\nRun $ARGUMENTS`);
  assert.equal(output.get('.gemini/commands/review.toml').toString(), `# ${MARKER}\nprompt = "Run {{args}}"\n`);
  assert.equal(output.get('.opencode/agent/review.md').toString(), `---\ndescription: "Review"\nmode: subagent\n---\n${MARKER}\nPrompt`);
});

test('empty command front matter rebuilds cleanly and Claude-only argument hints stay opaque', (t) => {
  const root = fixture(t);
  for (const front of ['---\n---\n', '---\nargument-hint: [path]\n---\n']) {
    put(root, 'commands/review.md', `${front}Run $ARGUMENTS`);
    buildSoulDirectory(root);
    assert.deepEqual(buildSoulDirectory(root, { check: true }).drift, []);
    const claude = readFileSync(join(root, '.claude/commands/review.md'), 'utf8');
    assert.ok(claude.endsWith(`${MARKER}\nRun $ARGUMENTS`));
    if (front.includes('argument-hint')) assert.ok(claude.startsWith(front));
  }
});

test('YAML quotes, folded/literal scalars and tool lists translate without leaking source syntax', () => {
  for (const tools of ['[Read, "Bash", \'Grep\']', '\n  - Read\n  - Bash\n  - Grep', '"Read, Bash, Grep"']) {
    const output = buildHarnessFiles([entry('AGENTS.md', '# Soul'), entry('agents/review.md',
      `---\nname: 'review'\ndescription: >-\n  Review code\n  carefully.\nmodel: "provider/model" # a comment\ntools: ${tools}\n---\nPrompt\n`)]);
    assert.match(output.get('.opencode/agent/review.md').toString(), /^---\ndescription: "Review code carefully\."\n/);
    assert.match(output.get('.opencode/agent/review.md').toString(), /tools:\n  "\*": false\n  "bash": true\n  "grep": true\n  "read": true\n/);
  }
  const output = buildHarnessFiles([entry('AGENTS.md', '# Soul'), entry('commands/review.md',
    '---\ndescription: |\n  It\'s "quoted".\n  Next line.\n---\n"""\nC:\\code\t$ARGUMENTS\n')]);
  const toml = output.get('.gemini/commands/review.toml').toString();
  assert.equal(toml, `# ${MARKER}\ndescription = "It's \\"quoted\\".\\nNext line.\\n"\nprompt = "\\"\\"\\"\\nC:\\\\code\\t{{args}}\\n"\n`);
});

test('unsafe paths and invalid names fail; agents and commands may share a valid name', () => {
  for (const directory of ['agents', 'commands']) {
    for (const name of ['../escape', 'nested/name', '.', '', 'bad\\name', 'bad\nname', 'bad\x7fname', 'Upper', 'a--b', 'a'.repeat(65)]) {
      assert.throws(() => buildHarnessFiles([entry('AGENTS.md', '# Soul'), entry(`${directory}/${name}.md`, directory === 'agents' ? agent : command)]), /unsafe|name/);
    }
  }
  assert.throws(() => buildHarnessFiles([...entries(), entries()[1]]), /duplicate package path/);
  for (const name of ['../escape', 'bad\\name', 'other', 'Upper']) {
    assert.throws(() => buildHarnessFiles([entry('AGENTS.md', '# Soul'), entry('agents/review.md', agent.replace('name: review', `name: ${name}`))]), /name/);
  }
  assert.ok(buildHarnessFiles(entries()).has('.claude/commands/review.md'));
});

test('malformed declarations fail instead of silently losing translated fields', () => {
  for (const content of ['Prompt only', '---\nname: review\n---\nPrompt',
    agent.replace('description: Review code', 'description: [bad]'),
    agent.replace('name: review', 'name: review\nname: review'),
    agent.replace('Read, Grep, Bash', 'Bash(git:*)'),
    agent.replace('description: Review code', 'description: "unterminated'),
    agent.replace('description: Review code', 'description: false'),
    agent.replace('description: Review code', '"description": Review code'),
    agent.replace('description: Review code', 'description: Review\n  continuation'), `${agent}\0`]) {
    assert.throws(() => buildHarnessFiles([entry('AGENTS.md', '# Soul'), entry('agents/review.md', content)]), /agents\/review\.md/);
  }
  assert.throws(() => buildHarnessFiles([entry('AGENTS.md', '# Soul'), entry('commands/review.md', '---\ndescription: no closing delimiter')]), /front matter/);
  assert.throws(() => buildHarnessFiles([entry('AGENTS.md', '# Soul'), entry('agents/review.md', Buffer.from([255]))]), /UTF-8/);
});

test('rendering is pure, sorted, LF-normalized, and byte-identical over its own output', () => {
  const source = entries().map(({ path, bytes }) => entry(path, bytes.toString().replaceAll('\n', '\r\n')));
  const snapshot = source.map(({ path, bytes }) => [path, bytes.toString('base64')]);
  const output = buildHarnessFiles(source);
  assert.deepEqual(output, buildHarnessFiles([...source].reverse()));
  assert.deepEqual(output, buildHarnessFiles([...source, ...[...output].map(([path, bytes]) => entry(path, bytes))], { authored: output }));
  assert.deepEqual(output, buildHarnessFiles(source, { authored: new Map(primitivePaths.map((path) => [path, Buffer.from('authored override')])) }));
  assert.deepEqual([...output.keys()], [...output.keys()].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b))));
  assert.ok([...output.values()].every((bytes) => !bytes.includes(13)));
  assert.deepEqual(source.map(({ path, bytes }) => [path, bytes.toString('base64')]), snapshot);
});

test('expectedGeneratedFiles excludes new output from revisions and disk rebuilds preserve every byte', (t) => {
  const root = fixture(t), before = readSoulPackageEntries(root).entries, revision = computePackageRevision(root);
  const expected = expectedGeneratedFiles(before);
  buildSoulDirectory(root);
  for (const [path, bytes] of expected) assert.deepEqual(readFileSync(join(root, path)), bytes);
  assert.equal(computePackageRevision(root), revision);
  assert.deepEqual(readSoulPackageEntries(root).entries, before);
  assert.deepEqual(buildSoulDirectory(root, { check: true }).drift, []);
  buildSoulDirectory(root);
  for (const [path, bytes] of expected) assert.deepEqual(readFileSync(join(root, path)), bytes);
  for (const path of primitivePaths) {
    put(root, path, Buffer.concat([expected.get(path), Buffer.from('\nEdited\n')]));
    assert.notEqual(computePackageRevision(root), revision, path);
    buildSoulDirectory(root);
    assert.equal(computePackageRevision(root), revision, path);
  }
  rmSync(join(root, 'agents'), { recursive: true });
  rmSync(join(root, 'commands'), { recursive: true });
  assert.deepEqual(buildSoulDirectory(root, { check: true }).removals, primitivePaths);
  buildSoulDirectory(root);
  assert.ok(primitivePaths.every((path) => !existsSync(join(root, path))));
});

test('unmarked primitive files conflict and never become authored merge bases', (t) => {
  for (const path of primitivePaths) {
    const root = fixture(t);
    put(root, path, 'authored\n');
    for (const check of [true, false]) assert.throws(() => buildSoulDirectory(root, { check }), /unmarked generated path conflict/);
    assert.equal(readFileSync(join(root, path), 'utf8'), 'authored\n');
    assert.equal(existsSync(join(root, 'CLAUDE.md')), false);
  }
});

test('--check --json includes primitive and unsupported names before and after build', (t) => {
  const root = fixture(t), cli = fileURLToPath(new URL('../agent-bot.mjs', import.meta.url));
  for (const status of [1, 0]) {
    const result = spawnSync(process.execPath, [cli, 'soul', 'build', root, '--check', '--json'],
      { encoding: 'utf8', env: { PATH: process.env.PATH, HOME: root } });
    assert.equal(result.status, status, result.stderr);
    const report = JSON.parse(result.stdout);
    assert.deepEqual(report.harnesses, harnessReport(buildHarnessFiles(entries())));
    if (status) assert.ok(primitivePaths.every((path) => report.writes.includes(path)));
    else assert.deepEqual(report.drift, []);
    buildSoulDirectory(root);
  }
});
