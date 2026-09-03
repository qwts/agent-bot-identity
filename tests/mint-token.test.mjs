import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { generateKeyPairSync, createVerify } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { buildAppJwt, appConfig } from '../mint-token.mjs';

const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const pem = privateKey.export({ type: 'pkcs8', format: 'pem' });

const NOW = 1_753_228_800; // fixed instant so claims are deterministic

function decodeClaims(jwt) {
  return jwt
    .split('.')
    .slice(0, 2)
    .map((segment) => JSON.parse(Buffer.from(segment, 'base64url').toString('utf8')));
}

test('JWT carries the RS256 header and the GitHub App claims', () => {
  const jwt = buildAppJwt('12345', pem, NOW);
  const [header, payload] = decodeClaims(jwt);
  assert.deepEqual(header, { alg: 'RS256', typ: 'JWT' });
  assert.equal(payload.iss, '12345');
  assert.equal(payload.iat, NOW - 60);
  assert.equal(payload.exp, NOW + 540);
});

test('JWT lifetime stays inside GitHub\'s 10-minute cap', () => {
  const jwt = buildAppJwt('12345', pem, NOW);
  const [, payload] = decodeClaims(jwt);
  assert.ok(payload.exp - payload.iat <= 600);
});

test('signature verifies against the key pair', () => {
  const jwt = buildAppJwt('12345', pem, NOW);
  const [headerSeg, payloadSeg, signatureSeg] = jwt.split('.');
  const verifier = createVerify('RSA-SHA256');
  verifier.update(`${headerSeg}.${payloadSeg}`);
  assert.ok(verifier.verify(publicKey, Buffer.from(signatureSeg, 'base64url')));
});

test('numeric app ids are coerced to the string iss GitHub expects', () => {
  const jwt = buildAppJwt(12345, pem, NOW);
  const [, payload] = decodeClaims(jwt);
  assert.equal(payload.iss, '12345');
});

function fakeHome(slug) {
  const home = mkdtempSync(join(tmpdir(), 'agent-bot-'));
  const dir = join(home, '.config', slug);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'app-id'), '98765\n');
  writeFileSync(join(dir, 'private-key.pem'), pem);
  return home;
}

test('--app <slug> resolves app-id and key from ~/.config/<slug>/', () => {
  const home = fakeHome('you-claude-agent');
  const config = appConfig({
    argv: ['node', 'mint-token.mjs', '--app', 'you-claude-agent'],
    env: {},
    home,
    config: {},
  });
  assert.equal(config.appId, '98765');
  assert.equal(config.privateKeyPem, pem);
});

test('GH_AGENT_APP resolves the same lookup without a flag', () => {
  const home = fakeHome('you-codex-agent');
  const cwd = mkdtempSync(join(tmpdir(), 'agent-bot-plain-'));
  const config = appConfig({
    argv: ['node', 'mint-token.mjs'],
    env: { GH_AGENT_APP: 'you-codex-agent' },
    home,
    cwd,
    config: {},
  });
  assert.equal(config.appId, '98765');
});

// A checkout laid out under one harness's `.<tool>/worktrees` directory and
// pinned to another harness's App. Under ENG-0339 the layout is not an
// identity input: the pin names the App the commits are authored as, so the
// pin is what mints — credentials and authorship stay one identity.
function pinnedWorktree(tool, pin) {
  const root = mkdtempSync(join(tmpdir(), 'agent-bot-layout-'));
  const repo = join(root, `.${tool}`, 'worktrees', 'session', 'repo');
  mkdirSync(repo, { recursive: true });
  const git = (...args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' });
  git('init', '--quiet', '--initial-branch=main');
  if (pin) git('config', 'agentBot.app', pin);
  return repo;
}

test('an inferred mint follows the pin, whatever directory the checkout sits in', () => {
  const home = fakeHome('you-claude-opus-agent');
  const cwd = pinnedWorktree('codex', 'you-claude-opus-agent');
  const config = appConfig({
    argv: ['node', 'mint-token.mjs'],
    env: { AGENT_BOT_ACCOUNT: 'user' },
    home,
    cwd,
    config: { prefix: 'you' },
  });
  // you-codex-agent has no key material in this fake home, so resolving to the
  // layout's harness would throw. Reaching the pinned App's key proves the pin won.
  assert.equal(config.slug, 'you-claude-opus-agent');
  assert.equal(config.appId, '98765');
});

// GH_AGENT_APP is a stated identity and outranks the account and the
// directory alike (ENG-0339 acceptance b). No correction, no stderr note.
test('GH_AGENT_APP mints its own App in any checkout, with no correction note', () => {
  const home = fakeHome('you-claude-opus-agent');
  const cwd = pinnedWorktree('codex', null);
  const notes = [];
  const write = process.stderr.write;
  process.stderr.write = (chunk) => { notes.push(String(chunk)); return true; };
  let config;
  try {
    config = appConfig({
      argv: ['node', 'mint-token.mjs'],
      env: { GH_AGENT_APP: 'you-claude-opus-agent', AGENT_BOT_ACCOUNT: 'you-codex-agent' },
      home,
      cwd,
      config: { prefix: 'you' },
    });
  } finally {
    process.stderr.write = write;
  }
  assert.equal(config.slug, 'you-claude-opus-agent');
  assert.equal(config.appId, '98765');
  assert.equal(notes.join(''), '');
});

// ENG-0339 acceptance (c): the account is the fallback input, so an unpinned
// primary checkout in an agent account mints that account's App.
test('an agent account mints its App from an unpinned primary checkout', () => {
  const home = fakeHome('you-codex-agent');
  const cwd = pinnedWorktree('claude', null);
  const config = appConfig({
    argv: ['node', 'mint-token.mjs'],
    env: { AGENT_BOT_ACCOUNT: 'you-codex-agent' },
    home,
    cwd,
    config: { prefix: 'you' },
  });
  assert.equal(config.slug, 'you-codex-agent');
  assert.equal(config.appId, '98765');
});

test('a deliberate --app mints from any checkout, whatever the pin or layout', () => {
  // doctor mints every configured App in turn from whatever checkout it runs
  // in; --app outranks the launcher environment and the pin alike, and the
  // directory never throws on a mismatch.
  const home = fakeHome('you-copilot-agent');
  const cwd = pinnedWorktree('claude', 'you-claude-agent');
  const config = appConfig({
    argv: ['node', 'mint-token.mjs', '--app', 'you-copilot-agent'],
    env: { GH_AGENT_APP: 'you-codex-agent' },
    home,
    cwd,
    config: { prefix: 'you' },
  });
  assert.equal(config.slug, 'you-copilot-agent');
});

test('harness detection through config resolves without --app', () => {
  const home = fakeHome('you-claude-agent');
  const isolated = mkdtempSync(join(tmpdir(), 'agent-bot-cwd-'));
  const config = appConfig({
    argv: ['node', 'mint-token.mjs'],
    env: { CLAUDECODE: '1' },
    home,
    cwd: isolated,
    config: { prefix: 'you' },
  });
  assert.equal(config.slug, 'you-claude-agent');
  assert.equal(config.appId, '98765');
});

test('explicit GH_APP_ID/GH_APP_PRIVATE_KEY_PATH pair still works', () => {
  const home = fakeHome('you-cursor-agent');
  const keyPath = join(home, '.config', 'you-cursor-agent', 'private-key.pem');
  const config = appConfig({
    argv: ['node', 'mint-token.mjs'],
    env: { GH_APP_ID: '11111', GH_APP_PRIVATE_KEY_PATH: keyPath },
    home,
    config: {},
  });
  assert.equal(config.appId, '11111');
  assert.equal(config.privateKeyPem, pem);
});

test('explicit GH_APP_ID/GH_APP_PRIVATE_KEY accepts a CI secret directly', () => {
  const config = appConfig({
    argv: ['node', 'mint-token.mjs'],
    env: {
      GH_APP_ID: '22222',
      GH_APP_PRIVATE_KEY: pem,
      CODEX_SYNC_REPO: 'overlook',
    },
    home: mkdtempSync(join(tmpdir(), 'agent-bot-')),
    config: {},
  });
  assert.equal(config.appId, '22222');
  assert.equal(config.privateKeyPem, pem);
});

test('a slug with no config directory fails with the expected paths named', () => {
  const home = mkdtempSync(join(tmpdir(), 'agent-bot-'));
  assert.throws(
    () => appConfig({
      argv: ['node', 'mint-token.mjs', '--app', 'you-vscode-agent'],
      env: {},
      home,
      config: {},
    }),
    /no app config for "you-vscode-agent"/,
  );
});

test('no selection at all names every option in the error', () => {
  const isolated = mkdtempSync(join(tmpdir(), 'agent-bot-'));
  assert.throws(
    () => appConfig({
      argv: ['node', 'mint-token.mjs'],
      env: {},
      home: isolated,
      cwd: isolated,
      config: {},
    }),
    /--app <slug>.*GH_AGENT_APP.*GH_APP_ID/,
  );
});
