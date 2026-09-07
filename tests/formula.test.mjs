import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const packageJson = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const formula = readFileSync(new URL('../Formula/agent-bot.rb', import.meta.url), 'utf8');

function versionParts(version) {
  assert.match(version, /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/);
  return version.split('.').map(BigInt);
}

function assertReleasePin(text, runtimeVersion) {
  const match = /^  url "https:\/\/github\.com\/qwts\/agent-bot-identity\/archive\/refs\/tags\/v([^"/]+)\.tar\.gz"$/m.exec(text);
  assert.ok(match, 'formula must pin a versioned archive from this repository');
  const pinned = versionParts(match[1]);
  const runtime = versionParts(runtimeVersion);
  const different = pinned.findIndex((part, index) => part !== runtime[index]);
  assert.ok(different < 0 || pinned[different] < runtime[different], 'formula must not be newer than the runtime');
  const checksum = /^  sha256 "([0-9a-f]{64})"$/m.exec(text)?.[1];
  assert.ok(checksum, 'formula must include a SHA-256 checksum');
  assert.notEqual(checksum, '0'.repeat(64), 'placeholder checksums must never reach the tap');
}

test('Homebrew formula keeps a checksummed release pin while the runtime advances', () => {
  assertReleasePin(formula, packageJson.version);
  assert.match(formula, /^class AgentBot < Formula$/m);
  assert.match(formula, /#\{opt_libexec\}\/agent-bot/);
  assert.match(formula, /AGENT_BOT_SYSTEM_NODE_DIRS/);
});

test('release pin validation allows staged releases but rejects future pins and placeholders', () => {
  const pin = (version, checksum = 'a1'.repeat(32)) => `  url "https://github.com/qwts/agent-bot-identity/archive/refs/tags/v${version}.tar.gz"\n  sha256 "${checksum}"\n`;
  for (const version of ['0.4.0', '0.4.10', '0.5.0']) assertReleasePin(pin(version), '0.5.0');
  for (const version of ['0.5.1', '0.6.0', '1.0.0']) {
    assert.throws(() => assertReleasePin(pin(version), '0.5.0'), /newer than the runtime/);
  }
  for (const checksum of ['0'.repeat(64), '', 'pending']) {
    assert.throws(() => assertReleasePin(pin('0.5.0', checksum), '0.5.0'), /checksum/);
  }
  for (const version of ['main', '0.5', '0.05.0']) {
    assert.throws(() => assertReleasePin(pin(version), '0.5.0'));
  }
});
