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
  listSouls,
  populationFile,
  showSoul,
  upsertSoul,
} from '../agent-population.mjs';

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
    appSlug: 'qwts-codex-agent',
    parentId: null,
    status: 'active',
    spacePath: `/spaces/${FIRST_ID}`,
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
  assert.match(table.stdout, /^ID\tAPP\tSTATUS/m);
  assert.match(table.stdout, new RegExp(FIRST_ID));
  assert.match(table.stdout, new RegExp(SECOND_ID));

  const filtered = runCli(['population', 'list', '--status', 'active', '--app', 'qwts-codex-agent', '--json'], file);
  assert.equal(filtered.status, 0, filtered.stderr);
  assert.deepEqual(JSON.parse(filtered.stdout), [fixture()]);

  const shown = runCli(['population', 'show', SECOND_ID], file);
  assert.equal(shown.status, 0, shown.stderr);
  assert.equal(JSON.parse(shown.stdout).id, SECOND_ID);
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
