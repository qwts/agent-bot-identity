import assert from 'node:assert/strict';
import { test } from 'node:test';
import { delimiter } from 'node:path';
import { hostToolsFirst } from '../agent-bot.mjs';

test('AGENT_BOT_TOOL_PATH goes first on the process PATH, once, and only when absolute', () => {
  const env = { AGENT_BOT_TOOL_PATH: '/App/Contents/Resources/bin', PATH: ['/usr/bin', '/bin', '/App/Contents/Resources/bin'].join(delimiter) };
  assert.equal(hostToolsFirst(env), ['/App/Contents/Resources/bin', '/usr/bin', '/bin'].join(delimiter));
  assert.equal(env.PATH, ['/App/Contents/Resources/bin', '/usr/bin', '/bin'].join(delimiter));
  // Idempotent: a second pass (the daemon spawning the CLI) changes nothing.
  assert.equal(hostToolsFirst(env), env.PATH);

  const bare = { AGENT_BOT_TOOL_PATH: '/App/bin' };
  assert.equal(hostToolsFirst(bare), '/App/bin');

  for (const tools of [undefined, '', 'relative/bin']) {
    const untouched = { ...(tools === undefined ? {} : { AGENT_BOT_TOOL_PATH: tools }), PATH: '/usr/bin' };
    assert.equal(hostToolsFirst(untouched), '/usr/bin');
    assert.equal(untouched.PATH, '/usr/bin');
  }
});
