import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, createVerify } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { detectHarness } from '../src/detect-harness.mjs';
import { loadConfig, slugForHarness, resolveSlug, apiBase } from '../src/config.mjs';
import { buildAppJwt, appCredentials } from '../src/mint-token.mjs';
import { parseCredentialRequest } from '../src/git-credential-bot.mjs';

// --- harness detection ----------------------------------------------------

test('each harness is detected from its own environment markers', () => {
  assert.equal(detectHarness({ CLAUDECODE: '1' }), 'claude');
  assert.equal(detectHarness({ AI_AGENT: 'claude-code_2_agent' }), 'claude');
  assert.equal(detectHarness({ CODEX_SANDBOX: 'seatbelt' }), 'codex');
  assert.equal(detectHarness({ TERM_PROGRAM: 'vscode' }), 'vscode');
});

test('Cursor beats VS Code despite the shared vscode TERM_PROGRAM', () => {
  assert.equal(
    detectHarness({ TERM_PROGRAM: 'vscode', __CFBundleIdentifier: 'com.todesktop.x.cursor' }),
    'cursor',
  );
});

test('a bare shell resolves to no harness and malformed env never throws', () => {
  assert.equal(detectHarness({ PATH: '/usr/bin' }), null);
  assert.doesNotThrow(() => detectHarness({ __CFBundleIdentifier: undefined, AI_AGENT: 123 }));
});

// --- config and slug resolution ------------------------------------------

test('prefix pattern and per-harness overrides map harness to slug', () => {
  assert.equal(slugForHarness('claude', { prefix: 'alice' }), 'alice-claude-agent');
  assert.equal(slugForHarness('claude', { prefix: 'alice', apps: { claude: 'alice-bot' } }), 'alice-bot');
  assert.equal(slugForHarness('claude', {}), null);
  assert.equal(slugForHarness(null, { prefix: 'alice' }), null);
});

test('resolution precedence: --app, then GH_AGENT_APP, then git config, then detection', () => {
  const config = { prefix: 'alice' };
  const detected = { CLAUDECODE: '1' };
  assert.equal(resolveSlug({ argv: ['n', 's', '--app', 'x'], env: detected, config, gitConfigSlug: 'y' }), 'x');
  assert.equal(resolveSlug({ argv: [], env: { ...detected, GH_AGENT_APP: 'z' }, config, gitConfigSlug: 'y' }), 'z');
  assert.equal(resolveSlug({ argv: [], env: detected, config, gitConfigSlug: 'y' }), 'y');
  assert.equal(resolveSlug({ argv: [], env: detected, config }), 'alice-claude-agent');
  assert.equal(resolveSlug({ argv: [], env: {}, config }), null);
});

test('missing config file yields an empty config (tools stay inert)', () => {
  const home = mkdtempSync(join(tmpdir(), 'abi-'));
  assert.deepEqual(loadConfig({ home, env: {} }), {});
});

test('apiBase defaults to github.com and honors config for GHE', () => {
  assert.equal(apiBase({}), 'https://api.github.com');
  assert.equal(apiBase({ apiBase: 'https://ghe.example.com/api/v3/' }), 'https://ghe.example.com/api/v3');
});

// --- JWT ------------------------------------------------------------------

const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const pem = privateKey.export({ type: 'pkcs8', format: 'pem' });
const NOW = 1_753_228_800;

test('JWT carries RS256 header, GitHub App claims, and a <=10-minute lifetime', () => {
  const jwt = buildAppJwt(12345, pem, NOW);
  const [header, payload] = jwt
    .split('.')
    .slice(0, 2)
    .map((s) => JSON.parse(Buffer.from(s, 'base64url').toString('utf8')));
  assert.deepEqual(header, { alg: 'RS256', typ: 'JWT' });
  assert.equal(payload.iss, '12345');
  assert.ok(payload.exp - payload.iat <= 600);
});

test('JWT signature verifies against the key pair', () => {
  const jwt = buildAppJwt('12345', pem, NOW);
  const [h, p, sig] = jwt.split('.');
  const verifier = createVerify('RSA-SHA256');
  verifier.update(`${h}.${p}`);
  assert.ok(verifier.verify(publicKey, Buffer.from(sig, 'base64url')));
});

// --- credential material lookup ------------------------------------------

test('appCredentials reads app-id and key from ~/.config/<slug>/', () => {
  const home = mkdtempSync(join(tmpdir(), 'abi-'));
  const dir = join(home, '.config', 'alice-claude-agent');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'app-id'), '98765\n');
  writeFileSync(join(dir, 'private-key.pem'), pem);
  const creds = appCredentials({ argv: ['n', 's', '--app', 'alice-claude-agent'], env: {}, home, config: {} });
  assert.equal(creds.appId, '98765');
  assert.equal(creds.privateKeyPem, pem);
});

test('a slug with no credential directory fails naming the expected paths', () => {
  const home = mkdtempSync(join(tmpdir(), 'abi-'));
  assert.throws(
    () => appCredentials({ argv: ['n', 's', '--app', 'ghost'], env: {}, home, config: {} }),
    /no app config for "ghost"/,
  );
});

test('no resolution at all names every option in the error', () => {
  const home = mkdtempSync(join(tmpdir(), 'abi-'));
  assert.throws(() => appCredentials({ argv: [], env: {}, home, config: {} }), /--app <slug>|GH_AGENT_APP/);
});

// --- credential helper protocol ------------------------------------------

test('parses git credential key=value request lines, keeping = in values', () => {
  const request = parseCredentialRequest('protocol=https\nhost=github.com\npassword=a=b\n\n');
  assert.deepEqual(request, { protocol: 'https', host: 'github.com', password: 'a=b' });
});

test('a present-but-invalid config fails loudly instead of reading as absent', () => {
  const home = mkdtempSync(join(tmpdir(), 'abi-'));
  mkdirSync(join(home, '.config', 'agent-bot'), { recursive: true });
  writeFileSync(join(home, '.config', 'agent-bot', 'config.json'), '{ prefix: "oops", }');
  assert.throws(() => loadConfig({ home, env: {} }), /not valid JSON/);
});

test('a BOM-prefixed but valid config still parses', () => {
  const home = mkdtempSync(join(tmpdir(), 'abi-'));
  mkdirSync(join(home, '.config', 'agent-bot'), { recursive: true });
  writeFileSync(join(home, '.config', 'agent-bot', 'config.json'), '﻿{ "prefix": "ok" }');
  assert.deepEqual(loadConfig({ home, env: {} }), { prefix: 'ok' });
});
