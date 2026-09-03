import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { importAgentSpacePack, initAgentSpace } from '../agent-space.mjs';
import {
  buildSpacePack,
  packContentHash,
  parseGistReference,
  parsePack,
  serializePack,
} from '../agent-space-pack.mjs';
import { startMockGistGitHub } from './helpers/mock-gist-github.mjs';

const CLI = fileURLToPath(new URL('../agent-bot.mjs', import.meta.url));
const ID = 'agent_11111111-1111-4111-8111-111111111111';
const OTHER_ID = 'agent_22222222-2222-4222-8222-222222222222';
const roots = [];

function scratch() {
  const root = mkdtempSync(path.join(tmpdir(), 'agent-space-pack-'));
  roots.push(root);
  return root;
}

function cleanEnv(extra = {}) {
  const env = { ...process.env };
  for (const key of [
    'AGENT_BOT_ID', 'QWTS_AGENT_ID', 'GH_AGENT_APP', 'GH_APP_ID', 'GH_APP_PRIVATE_KEY',
    'GH_APP_PRIVATE_KEY_PATH', 'GH_APP_INSTALLATION_ID', 'GITHUB_API_URL', 'AGENT_BOT_CONFIG',
  ]) delete env[key];
  return { ...env, ...extra };
}

function runCli(args, env = {}, cwd = undefined) {
  return spawnSync(process.execPath, [CLI, ...args], {
    cwd,
    encoding: 'utf8',
    env: cleanEnv(env),
  });
}

// Populate a marked space with a few belongings.
function seededSpace(spacesRoot, id = ID) {
  const env = { AGENT_BOT_SPACES_HOME: spacesRoot };
  const space = initAgentSpace(id, { env, now: () => new Date('2026-08-06T00:00:00.000Z') });
  writeFileSync(path.join(space.path, 'notes.md'), 'remember the suitcase\n');
  mkdirSync(path.join(space.path, 'nested', 'deep'), { recursive: true });
  writeFileSync(path.join(space.path, 'nested', 'deep', 'data.json'), '{"kept":true}\n');
  return space;
}

after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

test('export writes a deterministic manifest pack and import round-trips it', () => {
  const root = scratch();
  const spacesA = path.join(root, 'spaces-a');
  const spacesB = path.join(root, 'spaces-b');
  seededSpace(spacesA);
  const out = path.join(root, 'soul.pack.json');

  const exported = runCli(
    ['space', 'export', ID, '--out', out, '--json'],
    { AGENT_BOT_SPACES_HOME: spacesA },
  );
  assert.equal(exported.status, 0, exported.stderr);
  const summary = JSON.parse(exported.stdout);
  assert.equal(summary.agentId, ID);
  assert.equal(summary.out, out);
  assert.deepEqual(summary.excluded, []);
  assert.equal(summary.entries, 3);

  const pack = JSON.parse(readFileSync(out, 'utf8'));
  assert.equal(pack.schemaVersion, 1);
  assert.equal(pack.agentId, ID);
  assert.equal(new Date(pack.createdAt).toISOString(), pack.createdAt);
  assert.equal(pack.contentHash, packContentHash(pack.entries));
  assert.deepEqual(
    pack.entries.map((entry) => entry.path).sort(),
    ['nested/deep/data.json', 'notes.md', 'space.json'],
  );

  // Deterministic: an unchanged space hashes identically.
  const again = runCli(
    ['space', 'export', ID, '--out', path.join(root, 'again.pack.json'), '--json'],
    { AGENT_BOT_SPACES_HOME: spacesA },
  );
  assert.equal(again.status, 0, again.stderr);
  assert.equal(JSON.parse(again.stdout).contentHash, summary.contentHash);

  const imported = runCli(['space', 'import', out, '--json'], { AGENT_BOT_SPACES_HOME: spacesB });
  assert.equal(imported.status, 0, imported.stderr);
  const restored = JSON.parse(imported.stdout);
  assert.equal(restored.agentId, ID);
  assert.equal(restored.path, path.join(spacesB, ID));
  assert.equal(
    readFileSync(path.join(spacesB, ID, 'notes.md'), 'utf8'),
    'remember the suitcase\n',
  );
  assert.equal(
    readFileSync(path.join(spacesB, ID, 'nested', 'deep', 'data.json'), 'utf8'),
    '{"kept":true}\n',
  );
  // The restored marker is valid and bound to the id.
  const show = runCli(['space', 'show', ID], { AGENT_BOT_SPACES_HOME: spacesB });
  assert.equal(show.status, 0, show.stderr);
  assert.equal(JSON.parse(show.stdout).agentId, ID);
});

test('a planted private key aborts export, fails closed, and writes nothing', () => {
  const root = scratch();
  const spaces = path.join(root, 'spaces');
  const space = seededSpace(spaces);
  writeFileSync(path.join(space.path, 'private-key.pem'), 'FAKE KEY MATERIAL sentinel\n');
  mkdirSync(path.join(space.path, 'nested', 'tokens'), { recursive: true });
  const out = path.join(root, 'refused.pack.json');

  const refused = runCli(
    ['space', 'export', ID, '--out', out],
    { AGENT_BOT_SPACES_HOME: spaces },
  );
  assert.notEqual(refused.status, 0);
  assert.equal(refused.stdout, '');
  assert.match(refused.stderr, /refusing to export/);
  assert.match(refused.stderr, /private-key\.pem/);
  assert.match(refused.stderr, /nested\/tokens\//, 'secret-named directories are refused too');
  assert.doesNotMatch(refused.stderr, /FAKE KEY MATERIAL/);
  assert.equal(existsSync(out), false, 'a refused export must leave no pack behind');
});

test('documented cache exclusions are removed explicitly, never packed', () => {
  const root = scratch();
  const spaces = path.join(root, 'spaces');
  const space = seededSpace(spaces);
  writeFileSync(
    path.join(space.path, '.agent-bot-token.json'),
    '{"token":"cached-token-sentinel"}\n',
  );
  const out = path.join(root, 'excluded.pack.json');

  const exported = runCli(
    ['space', 'export', ID, '--out', out, '--json'],
    { AGENT_BOT_SPACES_HOME: spaces },
  );
  assert.equal(exported.status, 0, exported.stderr);
  assert.deepEqual(JSON.parse(exported.stdout).excluded, ['.agent-bot-token.json']);
  assert.match(exported.stderr, /excluded regenerable cache file \.agent-bot-token\.json/);
  const raw = readFileSync(out, 'utf8');
  assert.doesNotMatch(raw, /cached-token-sentinel/);
  assert.doesNotMatch(
    raw,
    new RegExp(Buffer.from('cached-token-sentinel').toString('base64').slice(0, 16)),
  );
  const paths = JSON.parse(raw).entries.map((entry) => entry.path);
  assert.equal(paths.includes('.agent-bot-token.json'), false);
});

test('import validates the manifest hash and restores nothing on tamper', () => {
  const root = scratch();
  const spacesA = path.join(root, 'spaces-a');
  const spacesB = path.join(root, 'spaces-b');
  seededSpace(spacesA);
  const out = path.join(root, 'tampered.pack.json');
  assert.equal(
    runCli(['space', 'export', ID, '--out', out], { AGENT_BOT_SPACES_HOME: spacesA }).status,
    0,
  );

  const pack = JSON.parse(readFileSync(out, 'utf8'));
  const target = pack.entries.find((entry) => entry.path === 'notes.md');
  target.data = Buffer.from('forget the suitcase\n').toString('base64');
  writeFileSync(out, `${JSON.stringify(pack)}\n`);

  const imported = runCli(['space', 'import', out], { AGENT_BOT_SPACES_HOME: spacesB });
  assert.notEqual(imported.status, 0);
  assert.match(imported.stderr, /content hash does not match/);
  assert.equal(existsSync(path.join(spacesB, ID)), false);
});

test('import validates the embedded marker against the pack Agent ID', () => {
  const root = scratch();
  const spacesA = path.join(root, 'spaces-a');
  const spacesB = path.join(root, 'spaces-b');
  seededSpace(spacesA);
  const out = path.join(root, 'rebound.pack.json');
  assert.equal(
    runCli(['space', 'export', ID, '--out', out], { AGENT_BOT_SPACES_HOME: spacesA }).status,
    0,
  );

  // The marker entry still binds to ID; relabeling the manifest must fail.
  const pack = JSON.parse(readFileSync(out, 'utf8'));
  pack.agentId = OTHER_ID;
  writeFileSync(out, `${JSON.stringify(pack)}\n`);

  const imported = runCli(['space', 'import', out], { AGENT_BOT_SPACES_HOME: spacesB });
  assert.notEqual(imported.status, 0);
  assert.match(imported.stderr, new RegExp(`bound to ${ID}, not ${OTHER_ID}`));
  assert.equal(existsSync(path.join(spacesB, OTHER_ID)), false);
  assert.equal(existsSync(path.join(spacesB, ID)), false);
});

test('import refuses to clobber an existing space without --force', () => {
  const root = scratch();
  const spacesA = path.join(root, 'spaces-a');
  const spacesB = path.join(root, 'spaces-b');
  seededSpace(spacesA);
  const out = path.join(root, 'clobber.pack.json');
  assert.equal(
    runCli(['space', 'export', ID, '--out', out], { AGENT_BOT_SPACES_HOME: spacesA }).status,
    0,
  );
  const env = { AGENT_BOT_SPACES_HOME: spacesB };

  assert.equal(runCli(['space', 'import', out], env).status, 0);
  writeFileSync(path.join(spacesB, ID, 'local-only.txt'), 'about to be replaced\n');

  const refused = runCli(['space', 'import', out], env);
  assert.notEqual(refused.status, 0);
  assert.match(refused.stderr, /already exists/);
  assert.match(refused.stderr, /--force/);
  assert.equal(existsSync(path.join(spacesB, ID, 'local-only.txt')), true);

  const forced = runCli(['space', 'import', out, '--force'], env);
  assert.equal(forced.status, 0, forced.stderr);
  assert.equal(existsSync(path.join(spacesB, ID, 'local-only.txt')), false);
  assert.equal(
    readFileSync(path.join(spacesB, ID, 'notes.md'), 'utf8'),
    'remember the suitcase\n',
  );
});

test('a failed promotion rename restores the original space (--force is recoverable)', () => {
  const root = scratch();
  const spacesA = path.join(root, 'spaces-a');
  const spacesB = path.join(root, 'spaces-b');
  const seeded = seededSpace(spacesA);
  const { pack } = buildSpacePack(seeded.path, ID);
  const env = { AGENT_BOT_SPACES_HOME: spacesB };

  importAgentSpacePack(pack, { env });
  writeFileSync(path.join(spacesB, ID, 'precious.txt'), 'irreplaceable\n');

  // Fail only the staged-tree promotion; the backup and restore renames run.
  const failingRename = (from, to) => {
    if (from.endsWith('.import')) throw new Error('simulated rename failure');
    renameSync(from, to);
  };
  assert.throws(
    () => importAgentSpacePack(pack, { env, force: true, rename: failingRename }),
    /simulated rename failure/,
  );

  // The original space survives intact — including the file the pack lacks.
  assert.equal(
    readFileSync(path.join(spacesB, ID, 'precious.txt'), 'utf8'),
    'irreplaceable\n',
  );
  assert.equal(
    readFileSync(path.join(spacesB, ID, 'notes.md'), 'utf8'),
    'remember the suitcase\n',
  );
  const litter = readdirSync(spacesB).filter(
    (name) => name !== ID && !name.startsWith('.'),
  );
  assert.deepEqual(litter, [], 'no staging or backup directories are left behind');

  // The same replacement succeeds once the rename works.
  const restored = importAgentSpacePack(pack, { env, force: true });
  assert.equal(restored.path, path.join(spacesB, ID));
  assert.equal(existsSync(path.join(spacesB, ID, 'precious.txt')), false);
  assert.equal(
    readFileSync(path.join(spacesB, ID, 'notes.md'), 'utf8'),
    'remember the suitcase\n',
  );
});

test('pack parsing fails closed on unsafe paths, secrets, and malformed documents', () => {
  const root = scratch();
  const spaces = path.join(root, 'spaces');
  const space = seededSpace(spaces);
  const { pack } = buildSpacePack(space.path, ID, { now: () => new Date('2026-08-06T00:00:00.000Z') });

  const withEntry = (entry) => {
    const entries = [...pack.entries, entry];
    return serializePack({ ...pack, entries, contentHash: packContentHash(entries) });
  };
  assert.throws(
    () => parsePack(withEntry({ path: '../escape.txt', data: Buffer.from('x').toString('base64') })),
    /unsafe path/,
  );
  assert.throws(
    () => parsePack(withEntry({ path: '/etc/passwd', data: Buffer.from('x').toString('base64') })),
    /unsafe path/,
  );
  assert.throws(
    () => parsePack(withEntry({ path: 'private-key.pem', data: Buffer.from('x').toString('base64') })),
    /known secret or excluded filename/,
  );
  assert.throws(
    () => parsePack(withEntry({ path: 'ok.txt', data: 'not base64!!' })),
    /must be base64/,
  );
  assert.throws(() => parsePack('not json'), /not valid JSON/);
  assert.throws(
    () => parsePack(serializePack({ ...pack, schemaVersion: 99 })),
    /unsupported schemaVersion/,
  );
  assert.equal(parsePack(serializePack(pack)).agentId, ID);
});

test('gist references parse strictly and never fall through to file reads', () => {
  assert.equal(parseGistReference('gist:abc123DEF456'), 'abc123DEF456');
  assert.equal(parseGistReference('https://gist.github.com/you/abc123DEF456'), 'abc123DEF456');
  assert.equal(parseGistReference('https://api.github.com/gists/abc123DEF456'), 'abc123DEF456');
  assert.equal(parseGistReference('./local/pack.json'), null);
  assert.throws(() => parseGistReference('gist:../etc'), /invalid gist reference/);
  assert.throws(() => parseGistReference('https://example.com/not-a-gist'), /invalid gist reference/);
});

// --- gist transport, end to end against a local GitHub API stub -----------

const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const APP_KEY_PEM = privateKey.export({ type: 'pkcs8', format: 'pem' });

function gistFixture(apiBase) {
  const root = scratch();
  const home = path.join(root, 'home');
  const appDir = path.join(home, '.config', 'you-claude-agent');
  mkdirSync(appDir, { recursive: true });
  writeFileSync(path.join(appDir, 'app-id'), '98765\n');
  writeFileSync(path.join(appDir, 'private-key.pem'), APP_KEY_PEM);
  const configPath = path.join(root, 'agent-bot-config.json');
  writeFileSync(configPath, `${JSON.stringify({ prefix: 'you', owner: 'you', apiBase })}\n`);
  const globalConfig = path.join(root, 'global.gitconfig');
  writeFileSync(globalConfig, '');
  // ENG-0339: the checkout's directory is not an identity input. The gist
  // handoff mints through the shared resolver, and here the identity is the
  // agent account (the fallback a linked or primary checkout resolves through).
  const checkout = path.join(root, 'checkout');
  mkdirSync(checkout, { recursive: true });
  const spaces = path.join(root, 'spaces');
  const env = {
    HOME: home,
    AGENT_BOT_CONFIG: configPath,
    AGENT_BOT_ACCOUNT: 'you-claude-agent',
    AGENT_BOT_SPACES_HOME: spaces,
    GIT_CONFIG_GLOBAL: globalConfig,
    GIT_CONFIG_NOSYSTEM: '1',
  };
  return { root, spaces, checkout, env };
}

test('space export --gist uploads the pack, records the pointer, and import restores it', async () => {
  const github = startMockGistGitHub(scratch(), 'ok');
  try {
    const fixture = gistFixture(github.apiBase);
    seededSpace(fixture.spaces);

    const exported = runCli(['space', 'export', ID, '--gist'], fixture.env, fixture.checkout);
    assert.equal(exported.status, 0, exported.stderr);
    assert.equal(exported.stdout, 'gist:abc123DEF456\n');
    assert.doesNotMatch(exported.stdout + exported.stderr, /installation-token-sentinel/);

    const state = await github.state();
    const stored = state.gists.abc123DEF456;
    assert.ok(stored, 'the pack reached the gist endpoint');
    assert.equal(stored.public, false, 'handoff gists are secret');
    const uploaded = JSON.parse(stored.files[`${ID}.agent-space-pack.json`].content);
    assert.equal(uploaded.agentId, ID);
    assert.equal(uploaded.contentHash, packContentHash(uploaded.entries));

    // Pointer only, recorded in the marker and visible in show.
    const show = runCli(['space', 'show', ID], fixture.env, fixture.checkout);
    assert.equal(show.status, 0, show.stderr);
    assert.equal(JSON.parse(show.stdout).handoff, 'gist:abc123DEF456');
    const marker = readFileSync(path.join(fixture.spaces, ID, 'space.json'), 'utf8');
    assert.doesNotMatch(marker, /suitcase/, 'the marker records a pointer, never contents');

    // Restore from the pointer and from a gist URL on a fresh machine.
    for (const [suffix, reference] of [
      ['pointer', 'gist:abc123DEF456'],
      ['url', 'https://gist.github.com/you/abc123DEF456'],
    ]) {
      const target = gistFixture(github.apiBase);
      const imported = runCli(['space', 'import', reference], target.env, target.checkout);
      assert.equal(imported.status, 0, `${suffix}: ${imported.stderr}`);
      assert.equal(
        readFileSync(path.join(target.spaces, ID, 'notes.md'), 'utf8'),
        'remember the suitcase\n',
      );
    }
  } finally {
    github.stop();
  }
});

test('a mint failure fails the gist export closed before any upload', async () => {
  const github = startMockGistGitHub(scratch(), 'fail-mint');
  try {
    const fixture = gistFixture(github.apiBase);
    seededSpace(fixture.spaces);

    const exported = runCli(['space', 'export', ID, '--gist'], fixture.env, fixture.checkout);
    assert.notEqual(exported.status, 0);
    assert.equal(exported.stdout, '');
    assert.match(exported.stderr, /could not mint a token for you-claude-agent/);

    const state = await github.state();
    assert.equal(state.hits.some((hit) => hit.includes('/gists')), false, 'no upload was attempted');
    const marker = JSON.parse(readFileSync(path.join(fixture.spaces, ID, 'space.json'), 'utf8'));
    assert.equal('handoff' in marker, false, 'no pointer is recorded on failure');
  } finally {
    github.stop();
  }
});

test('missing gist access fails closed and names the App permission', async () => {
  const github = startMockGistGitHub(scratch(), 'refuse-gists');
  try {
    const fixture = gistFixture(github.apiBase);
    seededSpace(fixture.spaces);

    const exported = runCli(['space', 'export', ID, '--gist'], fixture.env, fixture.checkout);
    assert.notEqual(exported.status, 0);
    assert.equal(exported.stdout, '');
    assert.match(exported.stderr, /gist creation was refused \(HTTP 404\)/);
    assert.match(exported.stderr, /"Gists" account permission/);
    assert.match(exported.stderr, /org policy may forbid gists/);

    const marker = JSON.parse(readFileSync(path.join(fixture.spaces, ID, 'space.json'), 'utf8'));
    assert.equal('handoff' in marker, false);
  } finally {
    github.stop();
  }
});
