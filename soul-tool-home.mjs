#!/usr/bin/env node
// `agent-bot soul tool-home` (#617): show or set, per harness, whether a
// soul's harness keeps its config, sign-in and sessions in the soul's own
// tool home (`soul`) or uses the host's global install and store (`global`).
//
// Who may set it:
// - the owner, for any soul, through the owner gate (owner-gate.mjs): a
//   caller without soul markers is not thereby the owner, so every owner
//   change is proven;
// - the soul itself, for its own soul only, proven by its live binding,
//   which the daemon resolves to an Agent ID. A stated Agent ID or git
//   config is not proof: a soul could name another.
// For a soul, `soul` keeps the harness inside itself, which never widens
// what it can reach, so the binding is enough. `global` gives it the host's
// shared sign-in and sessions, so it waits for the owner's presence (Touch
// ID, the login password, else the administrator dialog). A "no" changes
// nothing. Every change writes an audit receipt; showing and a no-op do not.
//
// `--fresh-session` (#617) sets aside the soul's recorded resume session for
// the harness, so its next resume wake starts a new one in the store it uses
// now: the way on after a tool-home move, instead of switching back. The old
// session's id stays in the wake sessions record and its transcript in its
// store; nothing is deleted. It never widens what the soul reaches, so the
// soul's binding is enough for its own soul; the owner runs it for any soul.
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import process from 'node:process';
import { pathToFileURL } from 'node:url';
import { appendAuditReceipt } from './agent-principals.mjs';
import { readBinding } from './agent-binding.mjs';
import { validateAgentId, withLock } from './agent-identity.mjs';
import { daemonClient } from './daemon-client.mjs';
import { assertOwnerAction, presenceOrConsent, soulMarkers } from './owner-action.mjs';
import { prepareToolHomeChoice, readToolHomeRecord, setToolHomeChoice, toolHomeRecordPath } from './soul-tool-home-record.mjs';
import { TOOL_HOME_CHOICES, toolHomeFor } from './soul-tool-homes.mjs';
import { createWakeSessions, wakeSessionsFile } from './wake-resume.mjs';

export const TOOL_HOME_USAGE = 'usage: agent-bot soul tool-home <harness> [soul|global] --soul <agentId|name> [--fresh-session] [--json] [--principal-stdin]';

const fail = (code, message, statusCode = 400) => { throw Object.assign(new Error(message), { code, statusCode }); };

function parse(argv) {
  const positional = [];
  let target = null, json = false, presented = false, fresh = false;
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === '--json' && !json) json = true;
    else if (arg === '--principal-stdin' && !presented) presented = true;
    else if (arg === '--fresh-session' && !fresh) fresh = true;
    else if (arg === '--soul' && target === null && argv[index + 1] && !argv[index + 1].startsWith('--')) target = argv[++index];
    else if (!arg.startsWith('--')) positional.push(arg);
    else fail('usage', TOOL_HOME_USAGE);
  }
  const [harness, choice = null, ...rest] = positional;
  if (!harness || !target || rest.length || (choice !== null && !TOOL_HOME_CHOICES.includes(choice))
    || (choice === null && !fresh && presented)) fail('usage', TOOL_HOME_USAGE);
  return { harness, choice, target, json, presented, fresh };
}

// Where a set-aside session was recorded; a damaged record's store is
// named as such, never as one it does not say.
const storeLabel = (store) => (store === 'host' || store === 'soul' ? `the ${store} store` : 'a damaged record');

// The census row and the soul's folder, as `soul env` resolves them.
async function resolveSoul(target, { env, home }) {
  const { populationFile, showSoul, showSoulByName, soulDirectory } = await import('./agent-population.mjs');
  const file = populationFile({ env, home });
  let soul;
  try { soul = target.startsWith('agent_') ? showSoul(validateAgentId(target), { file }) : showSoulByName(target, { file }); }
  catch (error) {
    if (/no population record|id must be a valid Agent ID/.test(error.message)) fail('soul-not-found', 'Soul not found.', 404);
    throw error;
  }
  let soulDir = typeof soul.soulDir === 'string' ? soul.soulDir : null;
  try { soulDir ??= soulDirectory(soul.id, { env, home, readOnly: true }); } catch { soulDir = null; }
  if (!soulDir) fail('soul-dir-missing', `${soul.id} has no soul folder on this Mac`, 404);
  return { id: soul.id, soulDir };
}

// The Agent ID a soul caller has proven: its binding, presented to the
// daemon and resolved there. Null without a binding, without a daemon, or
// when the daemon does not know the binding.
async function provenSoulId({ env, cwd, client }) {
  let binding;
  try { binding = readBinding({ env, cwd }); } catch { return null; }
  if (!binding) return null;
  try {
    const live = await client.binding(binding.secret);
    return live?.agentId === binding.agentId ? live.agentId : null;
  } catch { return null; }
}

export async function soulToolHomeCommand(argv, {
  ownerGate = (action, options) => assertOwnerAction(action, { ...options, detect: false }),
  askOwner = presenceOrConsent,
  markers = (options) => soulMarkers({ ...options, detect: false }),
  provenSoul = provenSoulId,
  readStdin = () => readFileSync(0, 'utf8'),
  write = (text) => process.stdout.write(text),
  env = process.env,
  home = homedir(),
  cwd = process.cwd(),
  now = () => new Date(),
  client = daemonClient({ env, home, cwd }),
  sessions = createWakeSessions({ file: wakeSessionsFile({ env, home }) }),
} = {}) {
  const { harness: name, choice, target, json, presented, fresh } = parse(argv);
  const row = toolHomeFor(name);
  if (!row.routable) fail('tool-home-unsupported', `${row.harness} has no tool home to choose: ${row.reason}`);
  const soul = await resolveSoul(target, { env, home });
  const current = readToolHomeRecord(soul.soulDir)?.harnesses[row.harness] ?? null;
  const result = { agentId: soul.id, harness: row.harness, choice: current, changed: false };
  const setting = choice !== null && choice !== current;
  if (setting || fresh) {
    const found = markers({ env, cwd });
    const caller = found.length ? 'soul' : 'owner';
    if (caller === 'soul') {
      if (presented) fail('tool-home-principal-not-accepted', '--principal-stdin is the owner\'s; a soul asks the owner instead', 403);
      const proven = await provenSoul({ env, cwd, client });
      if (proven === null) fail('tool-home-soul-unproven', `a soul changes its tool homes with its live binding, and this caller has none the daemon knows (it has a soul's ${found.join(', ')})`, 403);
      if (proven !== soul.id) fail('tool-home-not-own-soul', `a soul may change only its own tool homes; this caller is bound as ${proven}`, 403);
    }
    let principal = null;
    if (presented) {
      try { principal = JSON.parse(readStdin()); }
      catch { fail('tool-home-principal-invalid', '--principal-stdin needs the principal credential as JSON on stdin'); }
    }
    const action = [`soul tool-home ${soul.id} ${row.harness}`, setting ? choice : null, fresh ? '--fresh-session' : null].filter(Boolean).join(' ');
    let authorization = { method: 'binding' };
    if (caller === 'owner' || (setting && choice === 'global')) {
      try {
        authorization = caller === 'owner'
          ? await ownerGate(action, { principal, env, cwd })
          : await askOwner(action, { env });
      } catch (error) {
        throw Object.assign(new Error(`${action} needs the owner and was not approved: ${error.message}`),
          { code: error.code === 'owner-credential-required' ? error.code : 'tool-home-owner-not-approved', statusCode: 403, cause: error });
      }
    }
    const method = authorization?.method ?? 'none';
    let retired = null;
    // Hold both writers' locks through the combined operation. Both files
    // are staged before the choice changes; a failed session commit restores
    // the exact old choice (including an absent record). Receipts follow success.
    withLock(`${toolHomeRecordPath(soul.soulDir)}.lock`, 'soul tool-homes record', () => {
      if (setting && fresh) {
        const staged = prepareToolHomeChoice(soul.soulDir, row.harness, choice);
        try {
          retired = sessions.retire(soul.id, row.harness, { now,
            beforeCommit: () => { staged.commit(); return () => staged.rollback(); } });
        } finally { staged.cleanup(); }
      } else if (setting) setToolHomeChoice(soul.soulDir, row.harness, choice);
      else if (fresh) retired = sessions.retire(soul.id, row.harness, { now });
    });
    if (setting) {
      appendAuditReceipt({ event: 'tool-home', agentId: soul.id, operation: 'set', decision: choice,
        detail: `${row.harness}: ${current ?? 'unset'} -> ${choice} by ${caller} (${method})` }, { env, home, now });
      Object.assign(result, { choice, changed: true, previous: current });
    }
    if (fresh) {
      result.freshSession = retired ? { retired: true, store: retired.store } : { retired: false };
      if (retired) {
        appendAuditReceipt({ event: 'tool-home', agentId: soul.id, operation: 'fresh-session', decision: 'fresh-session',
          detail: `${row.harness}: resume session in ${storeLabel(retired.store)} set aside by ${caller} (${method})` }, { env, home, now });
      }
    }
    Object.assign(result, { caller, authorization: method });
  }
  const lines = [`${row.harness}: ${result.choice ?? 'unset (current setup)'}${result.changed ? ` (was ${result.previous ?? 'unset'})` : ''}`];
  if (result.freshSession) {
    lines.push(result.freshSession.retired
      ? `${row.harness}: the next resume wake starts a new session; the old one is kept in ${storeLabel(result.freshSession.store)}`
      : `${row.harness}: no recorded resume session; the next resume wake starts a new one`);
  }
  write(json ? `${JSON.stringify(result)}\n` : `${lines.join('\n')}\n`);
  return result;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) soulToolHomeCommand(process.argv.slice(2)).catch((error) => {
  const code = error.code ?? 'soul-tool-home-failed';
  if (process.argv.includes('--json')) process.stdout.write(`${JSON.stringify({ error: { code, message: error.message } })}\n`);
  else process.stderr.write(`agent-bot soul tool-home: ${error.message}\n`);
  process.exitCode = 1;
});
