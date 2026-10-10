import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { KEYD_PINNED_VERSION, keydPaths, keydStatus } from '../keyd-client.mjs';
import { keydCommand } from '../keyd-supervisor.mjs';
import { keydVersionCheck } from '../readiness.mjs';

// #767 step 3: an agent-bot release pins the agent-bot-keyd it is built and
// tested with, and reports any other keyd instead of quietly using it.

const keydDir = new URL('../keyd/', import.meta.url);

test('the pinned keyd version is the version keyd/ builds', () => {
  const manifest = readFileSync(new URL('Cargo.toml', keydDir), 'utf8');
  assert.equal(manifest.match(/^\[package\][^[]*?^version = "([^"]+)"/ms)?.[1], KEYD_PINNED_VERSION);
  const lock = readFileSync(new URL('Cargo.lock', keydDir), 'utf8');
  assert.match(lock, new RegExp(`name = "agent-bot-keyd"\\nversion = "${KEYD_PINNED_VERSION.replaceAll('.', '\\.')}"\\n`));
});

function fixture(t) {
  const home = mkdtempSync(path.join(tmpdir(), 'keyd-pin-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  return { home, env: { HOME: home, XDG_STATE_HOME: path.join(home, 'state') } };
}

test('keyd status reports the pin and whether the running keyd matches it', async (t) => {
  const { home, env } = fixture(t);
  const at = (version) => keydStatus({ home, env, request: async () => ({ pinned: true, version }) });
  assert.equal((await at(KEYD_PINNED_VERSION)).versionMatches, true);
  const old = await at('0.1.0');
  assert.equal(old.versionMatches, false);
  assert.equal(old.expectedVersion, KEYD_PINNED_VERSION);
  assert.equal((await at(undefined)).versionMatches, null);
  const down = await keydStatus({ home, env, request: async () => { throw new Error('down'); } });
  assert.deepEqual([down.running, down.expectedVersion, down.versionMatches], [false, KEYD_PINNED_VERSION, null]);
});

test('keyd status text names a running keyd that reports no version', async (t) => {
  const { home, env } = fixture(t);
  const { ownerSocket } = keydPaths({ env, home });
  mkdirSync(path.dirname(ownerSocket), { recursive: true });
  const server = createServer((connection) => connection.once('data', (chunk) => {
    const request = JSON.parse(String(chunk));
    connection.end(`${JSON.stringify({ jsonrpc: '2.0', id: request.id, result: { pinned: true } })}\n`);
  }));
  await new Promise((resolve) => server.listen(ownerSocket, resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  let text = '';
  await keydCommand(['status'], { env, home, write: (chunk) => { text += chunk; } });
  assert.match(text, /^agent-bot-keyd unknown version running; daemon key pinned\n/);
  assert.match(text, /did not report a version/);
  assert.doesNotMatch(text, /null/);
  let json = '';
  const result = await keydCommand(['status', '--json'], { env, home, write: (chunk) => { json += chunk; } });
  assert.deepEqual(JSON.parse(json), result);
  assert.deepEqual([result.version, result.versionMatches], [null, null]);
});

const probe = (status) => async () => ({ bin: null, pinned: true, expectedVersion: KEYD_PINNED_VERSION, ...status });

test('doctor skips keyd.version when no keyd is installed', async () => {
  const check = await keydVersionCheck({ probe: probe({ running: false, version: null, versionMatches: null }) });
  assert.equal(check.id, 'keyd.version');
  assert.equal(check.status, 'not_applicable');
});

test('doctor is ready when the running keyd is the pinned version', async () => {
  const check = await keydVersionCheck({ probe: probe({ running: true, version: KEYD_PINNED_VERSION, versionMatches: true }) });
  assert.equal(check.status, 'ready');
  assert.equal(check.evidence.expected_version, KEYD_PINNED_VERSION);
});

test('doctor warns about another keyd version with the update to make', async () => {
  const check = await keydVersionCheck({ probe: probe({ running: true, version: '0.1.0', versionMatches: false }) });
  assert.equal(check.status, 'warning');
  assert.equal(check.code, 'keyd-version-mismatch');
  assert.match(check.message, new RegExp(`0\\.1\\.0 is running; this agent-bot is pinned to ${KEYD_PINNED_VERSION.replaceAll('.', '\\.')}`));
  assert.match(check.action, /update the app that ships keyd/);
  assert.match(check.action, /agent-bot keyd install --bin PATH/);
  const silent = await keydVersionCheck({ probe: probe({ running: true, version: null, versionMatches: null }) });
  assert.equal(silent.code, 'keyd-version-mismatch');
  assert.match(silent.message, /did not report a version/);
});

test('doctor warns when an installed keyd does not answer', async () => {
  const check = await keydVersionCheck({ probe: probe({ running: false, bin: '/Applications/Host.app/keyd', version: null, versionMatches: null }) });
  assert.equal(check.status, 'warning');
  assert.equal(check.code, 'keyd-not-running');
  assert.equal(check.action, 'run: agent-bot keyd install --bin /Applications/Host.app/keyd');
});
