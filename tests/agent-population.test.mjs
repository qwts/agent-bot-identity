import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  displayName,
  listSouls,
  populationFile,
  showSoul,
  showSoulByName,
  updateSoulStatus,
  upsertIdentitySoul,
  upsertSoul,
} from '../agent-population.mjs';
import { mintAgentIdentity } from '../agent-identity.mjs';

const CLI = fileURLToPath(new URL('../agent-bot.mjs', import.meta.url));
const FIRST_ID = 'agent_11111111-1111-4111-8111-111111111111';
const SECOND_ID = 'agent_22222222-2222-4222-8222-222222222222';
const LAST_SEEN = '2026-08-06T12:00:00.000Z';

function scratch() {
  return mkdtempSync(path.join(tmpdir(), 'agent-population-'));
}

function fixture(overrides = {}) {
  return {
    id: FIRST_ID,
    name: displayName(overrides.id ?? FIRST_ID),
    appSlug: 'qwts-codex-agent',
    parentId: null,
    status: 'active',
    spacePath: `/spaces/${FIRST_ID}`,
    worktree: null,
    transcriptLocator: { provider: 'codex', id: 'thread-1' },
    lastSeen: LAST_SEEN,
    ...overrides,
  };
}

function runCli(args, file) {
  return spawnSync(process.execPath, [CLI, ...args], {
    encoding: 'utf8',
    env: { ...process.env, AGENT_BOT_POPULATION_PATH: file },
  });
}

test('population path follows explicit override, XDG state, then home default', () => {
  assert.equal(
    populationFile({ env: { AGENT_BOT_POPULATION_PATH: '/tmp/custom-population.json' } }),
    '/tmp/custom-population.json',
  );
  assert.equal(
    populationFile({ env: { XDG_STATE_HOME: '/tmp/state' }, home: '/home/test' }),
    '/tmp/state/agent-bot/population.json',
  );
  assert.equal(
    populationFile({ env: {}, home: '/home/test' }),
    '/home/test/.local/state/agent-bot/population.json',
  );
});

test('upsert is idempotent by Agent ID and publishes private files', () => {
  const root = scratch();
  const file = path.join(root, 'state', 'population.json');
  const first = upsertSoul(fixture(), { file });
  const initial = readFileSync(file, 'utf8');
  const second = upsertSoul(fixture(), { file });

  assert.deepEqual(second, first);
  assert.equal(readFileSync(file, 'utf8'), initial, 'an identical upsert should not rewrite the store');
  assert.deepEqual(listSouls({ file }), [first]);
  if (process.platform !== 'win32') {
    assert.equal(statSync(path.dirname(file)).mode & 0o777, 0o700);
    assert.equal(statSync(file).mode & 0o777, 0o600);
  }

  const updated = upsertSoul(fixture({ status: 'finalized', lastSeen: '2026-08-06T13:00:00.000Z' }), { file });
  assert.equal(updated.status, 'finalized');
  assert.deepEqual(listSouls({ file }), [updated]);
});

test('status updates preserve registered soul fields and ignore unregistered identities', () => {
  const file = path.join(scratch(), 'population.json');
  assert.equal(updateSoulStatus(FIRST_ID, 'finalized', { file }), null);

  const first = upsertSoul(fixture(), { file });
  const updated = updateSoulStatus(FIRST_ID, 'finalized', {
    file,
    now: () => new Date('2026-08-06T14:00:00.000Z'),
  });

  assert.deepEqual(updated, {
    ...first,
    status: 'finalized',
    lastSeen: '2026-08-06T14:00:00.000Z',
  });
  assert.deepEqual(showSoul(FIRST_ID, { file }), updated);
});

test('upsert does not change permissions on an existing override parent', () => {
  const root = scratch();
  const file = path.join(root, 'population.json');
  if (process.platform !== 'win32') chmodSync(root, 0o755);

  upsertSoul(fixture(), { file });

  if (process.platform !== 'win32') assert.equal(statSync(root).mode & 0o777, 0o755);
});

test('list filters souls by status and App slug', () => {
  const file = path.join(scratch(), 'population.json');
  const first = upsertSoul(fixture(), { file });
  const second = upsertSoul(fixture({
    id: SECOND_ID,
    appSlug: 'qwts-claude-agent',
    parentId: FIRST_ID,
    status: 'finalized',
    spacePath: `/spaces/${SECOND_ID}`,
    transcriptLocator: null,
  }), { file });

  assert.deepEqual(listSouls({ status: 'active', file }), [first]);
  assert.deepEqual(listSouls({ status: 'finalized', file }), [second]);
  assert.deepEqual(listSouls({ app: 'qwts-codex-agent', file }), [first]);
  assert.deepEqual(listSouls({ app: 'qwts-claude-agent', status: 'active', file }), []);
  assert.deepEqual(showSoul(SECOND_ID, { file }), second);
});

test('upsert rejects an empty parent ID instead of treating it as absent', () => {
  const file = path.join(scratch(), 'population.json');
  assert.throws(() => upsertSoul(fixture({ parentId: '' }), { file }), /parentId/);
});

test('writes only a strict secret-free record and reads ignore unknown future fields', () => {
  const file = path.join(scratch(), 'population.json');
  upsertSoul(fixture({
    token: 'token-sentinel',
    privateKey: 'key-sentinel',
    secret: 'secret-sentinel',
    transcriptLocator: {
      provider: 'codex',
      id: 'thread-1',
      token: 'nested-token-sentinel',
    },
  }), { file });
  const stored = readFileSync(file, 'utf8');
  assert.doesNotMatch(stored, /(?:token|key|secret)-sentinel/);

  const document = JSON.parse(stored);
  document.futureIndexField = { ignored: true };
  document.souls[FIRST_ID].futureRecordField = { ignored: true };
  writeFileSync(file, `${JSON.stringify(document, null, 2)}\n`);
  assert.deepEqual(listSouls({ file }), [fixture()]);
  assert.doesNotMatch(JSON.stringify(listSouls({ file })), /future/);

  document.schemaVersion = 2;
  writeFileSync(file, `${JSON.stringify(document, null, 2)}\n`);
  assert.deepEqual(listSouls({ file }), [fixture()], 'future schema remains readable');
  assert.throws(
    () => upsertSoul(fixture({ status: 'finalized' }), { file }),
    /future schemaVersion/,
    'an older writer must not downgrade a future store',
  );
});

test('display names are deterministic, human-readable, and derived from the ID alone (#92)', () => {
  assert.equal(displayName(FIRST_ID), displayName(FIRST_ID));
  assert.match(displayName(FIRST_ID), /^[a-z]+-[a-z]+-[0-9a-f]{2}$/);
  assert.notEqual(displayName(FIRST_ID), displayName(SECOND_ID));
  // Stable, non-reflecting error: untrusted input must never be echoed back.
  assert.throws(() => displayName('agent_nope secret-looking-text'), (error) => {
    assert.equal(error.message, 'id must be a valid Agent ID');
    return true;
  });
});

test('rows written before names existed gain one on read, with no migration (#92)', () => {
  const file = path.join(scratch(), 'population.json');
  upsertSoul(fixture(), { file });
  // Simulate a pre-name store: strip the field from the raw document.
  const document = JSON.parse(readFileSync(file, 'utf8'));
  delete document.souls[FIRST_ID].name;
  writeFileSync(file, `${JSON.stringify(document, null, 2)}\n`);
  const [row] = listSouls({ file });
  assert.equal(row.name, displayName(FIRST_ID));
});

test('the census is authoritative for names: a recorded name outranks re-derivation (#92)', () => {
  const file = path.join(scratch(), 'population.json');
  upsertSoul(fixture({ name: 'chosen-handle-01' }), { file });
  assert.equal(showSoul(FIRST_ID, { file }).name, 'chosen-handle-01');
});

test('name lookup answers a unique handle and refuses ambiguity (#92)', () => {
  const file = path.join(scratch(), 'population.json');
  upsertSoul(fixture(), { file });
  upsertSoul(fixture({
    id: SECOND_ID,
    spacePath: `/spaces/${SECOND_ID}`,
  }), { file });
  assert.equal(showSoulByName(displayName(FIRST_ID), { file }).id, FIRST_ID);
  assert.throws(() => showSoulByName('no-such-handle-00', { file }), /no population record with that name/);

  upsertSoul(fixture({ id: SECOND_ID, name: displayName(FIRST_ID), spacePath: `/spaces/${SECOND_ID}` }), { file });
  assert.throws(
    () => showSoulByName(displayName(FIRST_ID), { file }),
    /shared by 2 souls/,
  );
});

test('the PARENT column tells no-parent apart from parent-unknown (#91)', () => {
  const file = path.join(scratch(), 'population.json');
  // Bound with no parent: lineage was observable and there was none.
  upsertSoul(fixture(), { file });
  // Never bound: the parent is unknown, not absent.
  upsertSoul(fixture({
    id: SECOND_ID,
    spacePath: `/spaces/${SECOND_ID}`,
    transcriptLocator: null,
  }), { file });
  const table = runCli(['population', 'list'], file);
  assert.equal(table.status, 0, table.stderr);
  const rowFor = (id) => table.stdout.split('\n').find((line) => line.includes(id)).split('\t');
  assert.equal(rowFor(FIRST_ID)[4], '-', 'bound + null parent reads as genuinely parentless');
  assert.equal(rowFor(SECOND_ID)[4], '?', 'unbound + null parent reads as unknown');
});

test('names must stay well-formed handles', () => {
  const file = path.join(scratch(), 'population.json');
  assert.throws(
    () => upsertSoul(fixture({ name: 'Not A Handle' }), { file }),
    /hyphen-separated segments of lowercase letters and digits/,
  );
});

test('lifecycle upserts carry a recorded name forward instead of regenerating it (#92)', () => {
  const root = scratch();
  const file = path.join(root, 'population.json');
  const stateDir = path.join(root, 'identities');
  const identity = mintAgentIdentity({
    appSlug: 'qwts-codex-agent',
    transcript: { provider: 'codex', id: 'thread-1' },
    stateDir,
    idFactory: () => FIRST_ID,
  });
  upsertSoul(fixture({ name: 'chosen-handle-01' }), { file });
  const after = upsertIdentitySoul(identity.id, `/spaces/${FIRST_ID}`, { file, stateDir });
  assert.equal(after.name, 'chosen-handle-01');
});

test('population CLI shows a record by name (#92)', () => {
  const file = path.join(scratch(), 'population.json');
  upsertSoul(fixture(), { file });
  const shown = runCli(['population', 'show', displayName(FIRST_ID)], file);
  assert.equal(shown.status, 0, shown.stderr);
  assert.equal(JSON.parse(shown.stdout).id, FIRST_ID);
  const missing = runCli(['population', 'show', 'no-such-handle-00'], file);
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /no population record with that name/);
});

test('population CLI lists, filters, and shows records', () => {
  const file = path.join(scratch(), 'population.json');
  upsertSoul(fixture(), { file });
  upsertSoul(fixture({
    id: SECOND_ID,
    appSlug: 'qwts-claude-agent',
    status: 'finalized',
    spacePath: `/spaces/${SECOND_ID}`,
    transcriptLocator: null,
  }), { file });

  const table = runCli(['population', 'list'], file);
  assert.equal(table.status, 0, table.stderr);
  assert.match(table.stdout, /^NAME\tID\tAPP\tSTATUS/m);
  assert.match(table.stdout, new RegExp(FIRST_ID));
  assert.match(table.stdout, new RegExp(SECOND_ID));

  const filtered = runCli(['population', 'list', '--status', 'active', '--app', 'qwts-codex-agent', '--json'], file);
  assert.equal(filtered.status, 0, filtered.stderr);
  assert.deepEqual(JSON.parse(filtered.stdout), [fixture()]);

  const shown = runCli(['population', 'show', SECOND_ID], file);
  assert.equal(shown.status, 0, shown.stderr);
  assert.equal(JSON.parse(shown.stdout).id, SECOND_ID);
});

test('population list counts souls that never bound a transcript (#91)', () => {
  const file = path.join(scratch(), 'population.json');
  upsertSoul(fixture(), { file });
  upsertSoul(fixture({
    id: SECOND_ID,
    spacePath: `/spaces/${SECOND_ID}`,
    transcriptLocator: null,
  }), { file });

  // Pending may not persist silently: the listing counts it and names the
  // repair.
  const table = runCli(['population', 'list'], file);
  assert.equal(table.status, 0, table.stderr);
  assert.match(table.stdout, /1 of 2 souls have never bound a transcript \(PARENT '\?'\)/);
  assert.match(table.stdout, /population backfill/);

  // A fully bound census carries no warning.
  const bound = path.join(scratch(), 'population.json');
  upsertSoul(fixture(), { file: bound });
  const clean = runCli(['population', 'list'], bound);
  assert.equal(clean.status, 0, clean.stderr);
  assert.doesNotMatch(clean.stdout, /never bound/);
});

test('population list shows retired souls in a separate section', () => {
  const file = path.join(scratch(), 'population.json');
  upsertSoul(fixture(), { file });
  upsertSoul(fixture({
    id: SECOND_ID,
    status: 'retired',
    spacePath: `/spaces/${SECOND_ID}`,
    transcriptLocator: null,
  }), { file });

  const table = runCli(['population', 'list'], file);
  assert.equal(table.status, 0, table.stderr);
  const lines = table.stdout.trimEnd().split('\n');
  const divider = lines.indexOf('RETIRED');
  assert.notEqual(divider, -1, 'a RETIRED section separates tombstones from the living census');
  assert.ok(
    lines.slice(1, divider).some((line) => line.includes(FIRST_ID)),
    'active souls appear above the divider',
  );
  assert.ok(
    lines.slice(divider + 1).some((line) => line.includes(SECOND_ID)),
    'retired souls appear below the divider',
  );

  const none = runCli(['population', 'list', '--status', 'active'], file);
  assert.equal(none.status, 0, none.stderr);
  assert.doesNotMatch(none.stdout, /RETIRED/, 'no section when nothing retired matches');

  const json = runCli(['population', 'list', '--json'], file);
  assert.equal(json.status, 0, json.stderr);
  assert.equal(JSON.parse(json.stdout).length, 2, 'JSON output is unchanged by the section');
});

test('population errors never reflect invalid record or store contents', () => {
  const file = path.join(scratch(), 'population.json');
  const secret = 'not-an-agent-id-secret-sentinel';
  const invalid = runCli(['population', 'show', secret], file);
  assert.notEqual(invalid.status, 0);
  assert.doesNotMatch(invalid.stderr, /secret-sentinel/);

  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, 'not JSON secret-store-sentinel\n');
  chmodSync(file, 0o600);
  const corrupt = runCli(['population', 'list'], file);
  assert.notEqual(corrupt.status, 0);
  assert.doesNotMatch(corrupt.stderr, /secret-store-sentinel/);
});

// A row remembers the checkout that pinned the soul, so an active soul no
// checkout references is discoverable (#192). Lifecycle upserts know nothing
// about place and carry the recorded checkout forward.
test('rows record the checkout that pinned the soul and carry it forward', () => {
  const root = scratch();
  const file = path.join(root, 'population.json');
  const stateDir = path.join(root, 'identities');
  assert.equal(upsertSoul(fixture({ worktree: '/checkouts/demo' }), { file }).worktree, '/checkouts/demo');
  assert.throws(() => upsertSoul(fixture({ worktree: 'checkouts/demo' }), { file }), /worktree must be absolute/);
  assert.equal(listSouls({ file })[0].worktree, '/checkouts/demo');

  const identity = mintAgentIdentity({ appSlug: 'qwts-codex-agent', stateDir });
  const bound = upsertIdentitySoul(identity.id, `/spaces/${identity.id}`, {
    file,
    stateDir,
    worktree: '/checkouts/bound',
  });
  assert.equal(bound.worktree, '/checkouts/bound');
  const lifecycle = upsertIdentitySoul(identity.id, `/spaces/${identity.id}`, { file, stateDir });
  assert.equal(lifecycle.worktree, '/checkouts/bound', 'an upsert that names no checkout keeps the recorded one');
  const cleared = upsertIdentitySoul(identity.id, `/spaces/${identity.id}`, { file, stateDir, worktree: null });
  assert.equal(cleared.worktree, null);
});
