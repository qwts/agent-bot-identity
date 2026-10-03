#!/usr/bin/env node
// A stand-in for the agent-comms CLI with a JSON file as its broker
// ($FAKE_COMMS_BROKER). It resolves the calling soul the way agent-comms
// does without a binding file: QWTS_AGENT_ID, else the checkout's
// `agentBot.agentId` pin. Only the commands the join tests use.
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';

const file = process.env.FAKE_COMMS_BROKER;
const state = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : { joined: {}, messages: [] };
const save = () => writeFileSync(file, JSON.stringify(state));
const out = (value) => process.stdout.write(`${JSON.stringify(value)}\n`);
const fail = (code, message) => { out({ ok: false, error: { code, message } }); process.exit(1); };

function soul() {
  if (process.env.QWTS_AGENT_ID) return process.env.QWTS_AGENT_ID;
  try {
    const id = execFileSync('git', ['config', '--get', 'agentBot.agentId'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    if (id) return id;
  } catch { /* unbound */ }
  return fail('unbound', 'no soul here');
}

const flag = (name) => { const i = process.argv.indexOf(name); return i === -1 ? null : process.argv[i + 1]; };
const [command, sub] = process.argv.slice(2);
const me = soul();
if (command === 'join') {
  state.joined[me] = { name: flag('--name'), harness: flag('--harness') };
  save();
  out({ ok: true, address: `test/${me}`, verification: 'claimed' });
} else if (command === 'send') {
  const id = `msg_${randomUUID()}`;
  state.messages.push({ id, from: { account: 'test', agentId: me }, to: sub.split('/').pop(), body: flag('--body'), replyTo: flag('--reply-to'), acked: false });
  save();
  out({ ok: true, messageId: id });
} else if (command === 'inbox' && sub === 'read') {
  out({ ok: true, messages: state.messages.filter((m) => m.to === me && !m.acked) });
} else if (command === 'inbox' && sub === 'ack') {
  for (const m of state.messages) if (m.to === me && process.argv.slice(4).includes(m.id)) m.acked = true;
  save();
  out({ ok: true });
} else fail('unknown-command', `unknown command ${command}`);
