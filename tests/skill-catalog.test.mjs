// agent-bot skill <name> through the fleet catalog, and agent-bot skill
// agent-bot --for <subcommand> (#226). Every fetch is injected: no test here
// touches the network, gh, or the real HOME.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MODULES } from '../cli/dispatch.mjs';
import { PUBLIC_COMMANDS } from '../cli/parse.mjs';
import { NO_SKILL_REFERENCE, SKILL_REFERENCES } from '../cli/skill-references.mjs';
import {
  BUNDLED_SKILLS, CATALOG_PATH, SkillError, decodeContents, main, parseCatalog, resolveCatalogEntry, sourceCommit,
} from '../skill.mjs';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const REFERENCES = join(ROOT, 'skills', 'agent-bot', 'references');
const PIN_A = '436631ede68f2315df84f04a613c974095fbf29a';
const PIN_B = '29e7e99ac8649bffc643bd9c43c05f4ef06add83';

function entry(name, repository, ref, owner = repository) {
  return `- [${name}](https://github.com/${repository}/tree/${ref}/skills/${name})
  — owned by
  [${owner}](https://github.com/${owner}).
  Does a thing. Load only when a procedure names this skill.`;
}

function catalog(...entries) {
  return `# Shared agent skills

Do not read this file at session start.

## Available skills

${entries.join('\n')}

The signed-commit skill previously lived here.

## Adding a skill

- [not-a-skill](https://github.com/qwts/x/tree/${PIN_A}/skills/not-a-skill)
`;
}

const CATALOG_TEXT = catalog(
  entry('managed-machine', 'qwts/managed-machine', PIN_A),
  entry('add-zsh-function', 'qwts/zsh-functions', PIN_B),
  entry('on-a-branch', 'qwts/zsh-functions', 'main'),
  entry('on-a-tag', 'qwts/zsh-functions', 'v1.2.3'),
  entry('short-sha', 'qwts/zsh-functions', PIN_B.slice(0, 7)),
  entry('twice', 'qwts/managed-machine', PIN_A),
  entry('twice', 'qwts/zsh-functions', PIN_B),
  entry('mislabelled', 'qwts/zsh-functions', PIN_B, 'qwts/managed-machine'),
  '- [no-pin](https://github.com/qwts/zsh-functions) — owned by [qwts/zsh-functions](https://github.com/qwts/zsh-functions).',
  entry('agent-bot', 'someone/else', PIN_A),
);

function fakeFetcher(files = {}) {
  const calls = [];
  const fetchContents = (repository, path, ref) => {
    calls.push({ repository, path, ref });
    const key = `${repository}:${path}@${ref ?? ''}`;
    if (key in files) {
      if (files[key] instanceof Error) throw files[key];
      return files[key];
    }
    throw new SkillError(`cannot read ${repository}/${path}${ref ? ` at ${ref}` : ''}: HTTP 404`);
  };
  return { fetchContents, calls };
}

const CATALOG = { repository: 'example/team-sop', path: CATALOG_PATH, commit: 'a'.repeat(40) };
const catalogKey = `${CATALOG.repository}:${CATALOG.path}@${CATALOG.commit}`;
const MANAGED = '---\nname: managed-machine\n---\n\n# managed-machine\n';

function runMain(argv, files) {
  const { fetchContents, calls } = fakeFetcher(files);
  let stdout = '';
  let stderr = '';
  const status = main(argv, {
    fetchContents,
    resolveSop: () => ({ inEffect: true, repositories: { sop: CATALOG } }),
    stdout: { write: (text) => { stdout += text; } },
    stderr: { write: (text) => { stderr += text; } },
  });
  return { status, stdout, stderr, calls };
}

test('the catalog parser reads only Available skills and keeps the pin', () => {
  const entries = parseCatalog(CATALOG_TEXT);
  assert.equal(entries.find((e) => e.name === 'not-a-skill'), undefined);
  assert.deepEqual(entries.find((e) => e.name === 'managed-machine'), {
    name: 'managed-machine', repository: 'qwts/managed-machine', owner: 'qwts/managed-machine',
    ref: PIN_A, commit: PIN_A, directory: 'skills/managed-machine',
  });
  assert.equal(entries.find((e) => e.name === 'on-a-branch').commit, null);
  assert.throws(() => parseCatalog('# nothing\n'), /no "Available skills" section/u);
});

test('bundled names are served locally and never consult the catalog', () => {
  for (const name of BUNDLED_SKILLS) {
    // The fixture catalog lists agent-bot under another repository; the
    // bundled copy still wins and no fetch happens.
    const result = runMain([name, '--json'], { [catalogKey]: CATALOG_TEXT });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(result.calls, []);
    const path = join(ROOT, 'skills', name, 'SKILL.md');
    assert.deepEqual(JSON.parse(result.stdout), {
      name, repository: 'qwts/agent-bot-identity', commit: sourceCommit(), path, text: readFileSync(path, 'utf8'),
    });
  }
});

test('a catalogued name prints its SKILL.md fetched at the pinned commit', () => {
  const files = { [catalogKey]: CATALOG_TEXT, [`qwts/managed-machine:skills/managed-machine/SKILL.md@${PIN_A}`]: MANAGED };
  const plain = runMain(['managed-machine'], files);
  assert.equal(plain.status, 0, plain.stderr);
  assert.equal(plain.stderr, '');
  assert.equal(plain.stdout, MANAGED);
  assert.deepEqual(plain.calls, [
    { repository: CATALOG.repository, path: CATALOG.path, ref: CATALOG.commit },
    { repository: 'qwts/managed-machine', path: 'skills/managed-machine/SKILL.md', ref: PIN_A },
  ]);
  const json = runMain(['managed-machine', '--json'], files);
  assert.equal(json.status, 0, json.stderr);
  assert.deepEqual(JSON.parse(json.stdout), {
    name: 'managed-machine', repository: 'qwts/managed-machine', commit: PIN_A,
    path: 'skills/managed-machine/SKILL.md', text: MANAGED, catalog: CATALOG,
  });
});

test('absent, ambiguous, unpinned, and inconsistent names fail without a fetch of any skill', () => {
  const cases = [
    ['missing', /no skill named missing in the fleet catalog/u],
    ['twice', /skill name twice is ambiguous: the fleet catalog lists it 2 times \(qwts\/managed-machine, qwts\/zsh-functions\)/u],
    ['on-a-branch', /catalog entry on-a-branch is not pinned: ref main is not a 40-hex commit; a branch or tag is never followed/u],
    ['on-a-tag', /ref v1\.2\.3 is not a 40-hex commit/u],
    ['short-sha', /ref 29e7e99 is not a 40-hex commit/u],
    ['no-pin', /catalog entry no-pin is not a GitHub tree link/u],
    ['mislabelled', /links qwts\/zsh-functions but says it is owned by qwts\/managed-machine/u],
  ];
  for (const [name, message] of cases) {
    for (const flags of [[], ['--json']]) {
      const result = runMain([name, ...flags], { [catalogKey]: CATALOG_TEXT });
      assert.equal(result.status, 1, name);
      assert.equal(result.stdout, '', name);
      assert.match(result.stderr, message, name);
      assert.deepEqual(result.calls.map((call) => call.path), [CATALOG.path], name);
    }
  }
});

test('a network failure is a clear resolution error and never partial output', () => {
  const offline = runMain(['managed-machine'], {
    [catalogKey]: new SkillError('cannot read qwts/qwts-agent-sop/skills/README.md: error connecting to api.github.com'),
  });
  assert.equal(offline.status, 1);
  assert.equal(offline.stdout, '');
  assert.match(offline.stderr, /skill-catalog-unreadable:.*example\/team-sop.*error connecting to api.github.com/u);
  const timeout = runMain(['managed-machine', '--json'], {
    [catalogKey]: CATALOG_TEXT,
    [`qwts/managed-machine:skills/managed-machine/SKILL.md@${PIN_A}`]: new SkillError('timed out after 20s reading qwts/managed-machine/skills/managed-machine/SKILL.md'),
  });
  assert.equal(timeout.status, 1);
  assert.equal(timeout.stdout, '');
  assert.match(timeout.stderr, /timed out after 20s/u);
});

test('a truncated or non-file contents response is refused', () => {
  const text = 'hello skill\n';
  const good = JSON.stringify({ type: 'file', encoding: 'base64', size: text.length, content: Buffer.from(text).toString('base64') });
  assert.equal(decodeContents(good, 'x'), text);
  assert.throws(() => decodeContents(good.slice(0, 40), 'x'), /incomplete or invalid response reading x/u);
  assert.throws(() => decodeContents(JSON.stringify({ type: 'dir' }), 'x'), /not a file/u);
  const short = JSON.stringify({ type: 'file', encoding: 'base64', size: 99, content: Buffer.from(text).toString('base64') });
  assert.throws(() => decodeContents(short, 'x'), /incomplete content reading x: 12 of 99 bytes/u);
});

test('the resolver never follows a default branch for an unpinned entry', () => {
  const entries = parseCatalog(catalog(entry('x', 'qwts/zsh-functions', 'main')));
  assert.throws(() => resolveCatalogEntry(entries, 'x'), /not pinned/u);
});

test('--for prints exactly one reference file, in both formats', () => {
  for (const [subcommand, file] of [['mint-token', 'operations.md'], ['signed-commit', 'verified-publish.md'], ['identity', 'execution-identities.md'], ['space', 'storage-surfaces.md']]) {
    const path = join(REFERENCES, file);
    const plain = runMain(['agent-bot', '--for', subcommand]);
    assert.equal(plain.status, 0, plain.stderr);
    assert.equal(plain.stdout, readFileSync(path, 'utf8'));
    assert.deepEqual(plain.calls, []);
    const json = runMain(['agent-bot', '--json', '--for', subcommand]);
    assert.deepEqual(JSON.parse(json.stdout), {
      name: 'agent-bot', for: subcommand, repository: 'qwts/agent-bot-identity', commit: sourceCommit(), path, text: readFileSync(path, 'utf8'),
    });
  }
});

test('--for refuses unknown subcommands, other skills, and malformed use without guessing', () => {
  const unknown = runMain(['agent-bot', '--for', 'mint']);
  assert.equal(unknown.status, 2);
  assert.equal(unknown.stdout, '');
  assert.equal(unknown.stderr, `agent-bot skill: unknown subcommand mint; --for knows: ${Object.keys(SKILL_REFERENCES).sort().join(', ')}\n`);
  const none = runMain(['agent-bot', '--for', 'approvals']);
  assert.equal(none.status, 2);
  assert.match(none.stderr, /approvals has no reference file; read the agent-bot skill itself or `agent-bot approvals --help`; --for knows: /u);
  for (const name of ['agent-space', 'thread-orders', 'managed-machine']) {
    const other = runMain([name, '--for', 'mint-token'], { [catalogKey]: CATALOG_TEXT });
    assert.equal(other.status, 2);
    assert.equal(other.stdout, '');
    assert.equal(other.stderr, `agent-bot skill: --for applies only to the agent-bot skill, not ${name}\n`);
    assert.deepEqual(other.calls, []);
  }
  for (const argv of [['agent-bot', '--for'], ['agent-bot', '--for', 'doctor', '--for', 'install'], ['path', '--for', 'doctor'], ['agent-bot', '--json', '--json']]) {
    const bad = runMain(argv);
    assert.equal(bad.status, 2, argv.join(' '));
    assert.equal(bad.stdout, '');
    assert.match(bad.stderr, /usage: agent-bot skill/u);
  }
});

test('every dispatched command has a reference or is explicitly listed as having none', () => {
  const commands = new Set([...MODULES.keys(), ...PUBLIC_COMMANDS, 'hook']);
  const referenced = Object.keys(SKILL_REFERENCES);
  for (const command of commands) {
    assert.ok(referenced.includes(command) !== NO_SKILL_REFERENCE.includes(command),
      `${command} must be in exactly one of SKILL_REFERENCES and NO_SKILL_REFERENCE (cli/skill-references.mjs)`);
  }
  for (const command of [...referenced, ...NO_SKILL_REFERENCE]) {
    assert.ok(commands.has(command), `${command} is not an agent-bot command`);
  }
  const files = readdirSync(REFERENCES).filter((name) => name.endsWith('.md')).sort();
  for (const file of new Set(Object.values(SKILL_REFERENCES))) assert.ok(existsSync(join(REFERENCES, file)), file);
  assert.deepEqual([...new Set(Object.values(SKILL_REFERENCES))].sort(), files, 'every reference file is reachable through --for');
});
