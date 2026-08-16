import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const packageJson = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const formula = readFileSync(new URL('../Formula/agent-bot.rb', import.meta.url), 'utf8');

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

test('Homebrew formula pin matches package.json version', () => {
  const { version } = packageJson;
  const escaped = escapeRegExp(version);
  assert.match(formula, /^class AgentBot < Formula$/m);
  assert.match(formula, new RegExp(`/archive/refs/tags/v${escaped}\\.tar\\.gz`));
  assert.match(formula, /^  sha256 "[0-9a-f]{64}"$/m);
  assert.match(formula, /#\{opt_libexec\}\/agent-bot/);
  assert.match(formula, /AGENT_BOT_SYSTEM_NODE_DIRS/);
});
