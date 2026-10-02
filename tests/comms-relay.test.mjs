import test from 'node:test';
import assert from 'node:assert/strict';

import { createCommsRelay, senderAddress } from '../comms-relay.mjs';

const soul = { agentId: 'agent_1', binding: { worktree: '/home/soul', file: '/state/bindings/agent_1.json' } };

test('a reply goes to a principal by name and to a soul by account and agent', () => {
  assert.equal(senderAddress({ principal: 'owner' }), 'owner');
  assert.equal(senderAddress({ account: 'acct', agentId: 'agent_2' }), 'acct/agent_2');
  assert.equal(senderAddress({ agentId: 'agent_2' }), 'agent_2');
  assert.throws(() => senderAddress({}), /no sender address/);
});

test('the relay runs agent-comms as the soul, in its worktree, with its binding', async () => {
  const calls = [];
  const run = (command, args, options, done) => {
    calls.push({ command, args, options });
    const out = args[0] === 'inbox' && args[1] === 'read' ? { ok: true, messages: [{ id: 'm1' }] } : { ok: true };
    done(null, JSON.stringify(out), '');
  };
  const relay = createCommsRelay({ env: { PATH: '/tools' }, run });
  assert.deepEqual(await relay.read(soul), [{ id: 'm1' }]);
  await relay.reply(soul, { to: 'owner', replyTo: 'm1', body: 'hi' });
  await relay.ack(soul, ['m1']);
  assert.deepEqual(calls.map((c) => c.args), [
    ['inbox', 'read'],
    ['send', 'owner', '--body', 'hi', '--reply-to', 'm1'],
    ['inbox', 'ack', 'm1'],
  ]);
  for (const { command, options } of calls) {
    assert.equal(command, 'agent-comms');
    assert.equal(options.cwd, '/home/soul');
    assert.deepEqual(options.env, { PATH: '/tools', AGENT_BOT_BINDING: soul.binding.file, AGENT_BOT_ID: 'agent_1', QWTS_AGENT_ID: 'agent_1' });
  }
});

test('a failed agent-comms call rejects with its error message', async () => {
  const run = (command, args, options, done) => done(Object.assign(new Error('exit 1'), { code: 1 }), JSON.stringify({ ok: false, error: { message: 'mailbox-full' } }), '');
  await assert.rejects(createCommsRelay({ env: {}, run }).ack(soul, ['m1']), { message: 'agent-comms inbox failed: mailbox-full', code: null });
  const refused = (command, args, options, done) => done(new Error('exit 1'), JSON.stringify({ ok: false, error: { code: 'reply-depth-exceeded', message: 'this conversation reached the reply-depth limit' } }), '');
  await assert.rejects(createCommsRelay({ env: {}, run: refused }).reply(soul, { to: 'owner', replyTo: 'm1', body: 'hi' }), { code: 'reply-depth-exceeded' });
});
