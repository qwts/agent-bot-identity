import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  ambientSlug,
  explicitAppArg,
  ownerApprovalRequired,
  requireOwnerApproval,
} from '../owner-approval.mjs';

const OWNER = { AGENT_BOT_ACCOUNT: 'user' };
const CONFIG = { prefix: 'you' };

function plainCwd() {
  return mkdtempSync(join(tmpdir(), 'agent-bot-cwd-'));
}

function pinnedWorktree(pin) {
  const repo = mkdtempSync(join(tmpdir(), 'agent-bot-pinned-'));
  const git = (...args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' });
  git('init', '--quiet', '--initial-branch=main');
  if (pin) git('config', 'agentBot.app', pin);
  return repo;
}

test('an explicit --app in an unmarked owner account requires owner approval', () => {
  assert.equal(
    ownerApprovalRequired({
      argv: ['node', 'mint-token.mjs', '--app', 'you-devin-agent'],
      env: { ...OWNER },
      cwd: plainCwd(),
      config: CONFIG,
    }),
    true,
  );
});

test('an agent account mints freely — the owner dialog does not apply there', () => {
  assert.equal(
    ownerApprovalRequired({
      argv: ['node', 'mint-token.mjs', '--app', 'you-devin-agent'],
      env: { AGENT_BOT_ACCOUNT: 'you-codex-agent' },
      cwd: plainCwd(),
      config: CONFIG,
    }),
    false,
  );
});

test('GH_AGENT_APP is a stated identity — no dialog', () => {
  assert.equal(
    ownerApprovalRequired({
      argv: ['node', 'mint-token.mjs', '--app', 'you-devin-agent'],
      env: { ...OWNER, GH_AGENT_APP: 'you-devin-agent' },
      cwd: plainCwd(),
      config: CONFIG,
    }),
    false,
  );
});

test('a checkout pin is a stated identity — no dialog', () => {
  assert.equal(
    ownerApprovalRequired({
      argv: ['node', 'mint-token.mjs', '--app', 'you-devin-agent'],
      env: { ...OWNER },
      cwd: pinnedWorktree('you-devin-agent'),
      config: CONFIG,
    }),
    false,
  );
});

test('harness env markers that resolve a slug are stated identity — no dialog', () => {
  assert.equal(
    ownerApprovalRequired({
      argv: ['node', 'mint-token.mjs', '--app', 'you-devin-agent'],
      env: { ...OWNER, AI_AGENT: 'devin' },
      cwd: plainCwd(),
      config: CONFIG,
    }),
    false,
  );
});

test('an agent marker that resolves no identity still requires the dialog', () => {
  // DEVIN_AGENT says a Devin agent is running but names no App — in the
  // owner's account that is the delegate, and the delegate needs approval.
  assert.equal(
    ownerApprovalRequired({
      argv: ['node', 'mint-token.mjs', '--app', 'you-devin-agent'],
      env: { ...OWNER, DEVIN_AGENT: '1' },
      cwd: plainCwd(),
      config: CONFIG,
    }),
    true,
  );
});

test('caller-supplied App key material is its own credential path — no dialog', () => {
  assert.equal(
    ownerApprovalRequired({
      argv: ['node', 'mint-token.mjs'],
      env: { ...OWNER, GH_APP_ID: '11111', GH_APP_PRIVATE_KEY: 'pem' },
      cwd: plainCwd(),
      config: CONFIG,
    }),
    false,
  );
});

test('no --app and no ambient identity mints nothing — the gate is not the error path', () => {
  assert.equal(
    ownerApprovalRequired({
      argv: ['node', 'mint-token.mjs'],
      env: { ...OWNER },
      cwd: plainCwd(),
      config: CONFIG,
    }),
    false,
  );
});

test('ambientSlug resolves a pin; explicitAppArg reads the flag', () => {
  assert.equal(ambientSlug({ env: { ...OWNER }, cwd: pinnedWorktree('you-devin-agent'), config: CONFIG }), 'you-devin-agent');
  assert.equal(ambientSlug({ env: { ...OWNER }, cwd: plainCwd(), config: CONFIG }), null);
  assert.equal(explicitAppArg(['node', 'x', '--app', 'a']), 'a');
  assert.equal(explicitAppArg(['node', 'x']), null);
});

test('a granted dialog lets the mint proceed', () => {
  assert.doesNotThrow(() => requireOwnerApproval({ prompt: 'approve it', run: () => '' }));
});

test('a cancelled dialog fails closed with no token minted', () => {
  assert.throws(
    () => requireOwnerApproval({
      prompt: 'approve it',
      run: () => { const e = new Error('execution error: User canceled. (-128)'); e.stderr = 'User canceled. (-128)'; throw e; },
    }),
    /owner approval was cancelled — no token minted/,
  );
});

test('an unavailable dialog fails closed rather than minting', () => {
  assert.throws(
    () => requireOwnerApproval({
      prompt: 'approve it',
      run: () => { throw new Error('osascript: no such file'); },
    }),
    /owner approval could not be completed .*— no token minted/,
  );
});

test('non-macOS platforms have no consent gate and refuse', () => {
  assert.throws(
    () => requireOwnerApproval({ prompt: 'approve it', platform: 'linux', run: () => '' }),
    /refusing on this platform/,
  );
});
