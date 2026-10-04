// Opt-in, per-soul cold wake adapter. The dispatcher owns warm-socket
// selection; this port handles only the cold path and keeps one turn in
// flight per soul. Binding lookup is injected because bindings are owned by
// the daemon's private-git-dir registry: it resolves a soul to its worktree
// and the binding file the turn presents as AGENT_BOT_BINDING.
//
// With a `relay` (comms-relay.mjs) the waker reads the soul's inbox itself,
// runs one turn per message, and sends each turn's answer back as the reply,
// because a cold turn cannot get a tool call approved.
//
// A webhook soul (#334) runs no turn here: its harness's routine reads and
// acks its own inbox, so the waker only calls the webhook.
//
// Each relayed turn is a fresh session, so the waker journals the messages a
// soul receives and answers (soul-threads.mjs) and puts the woken message's
// earlier thread into the prompt (#392): a soul woken by a teammate's answer
// still knows who asked for the work.
//
// The final text is sent only when the turn did not already speak for itself
// (#407): a turn woken by another soul that used send_message has said what
// it meant to, and its final text is usually narration; a turn that messaged
// the sender directly would otherwise send the same answer twice. A turn the
// policy stopped with nothing said gets a short notice naming the refused
// tools instead of silence (#408).
//
// A turn that fails because the harness is signed out or its sign-in expired
// (#84) is reported through `authStatus`, so the census can show it, and each
// waiting sender gets one short notice. Those messages stay unacked, so they
// are answered on a wake after the owner signs the soul in again; the next
// turn that runs clears the status.

import { randomUUID } from 'node:crypto';

import { wakeSetting } from './cold-wake-settings.mjs';
import { FINAL_REPLY_ERRORS, senderAddress } from './comms-relay.mjs';
import { harnessAuthFailure, harnessAuthNotice } from './harness-auth.mjs';
import { NO_REPLY, formatThread, recordThreadMessage, sentMarks, sentSince, stripNoReply, threadContext, threadKey } from './soul-threads.mjs';

// The final answer a soul gives when a teammate's message needs no answer
// back. Every relayed turn's answer is otherwise a reply, so two souls would
// trade acknowledgements until the broker's reply-depth limit.
export { NO_REPLY };

export function relayPrompt(message, thread = []) {
  const fromSoul = typeof message.from?.principal !== 'string';
  const sender = senderAddress(message.from);
  return `You have an agent-comms message from ${sender}${fromSoul ? ', another agent' : ''}. Your final answer is sent back to them as your reply, so write it as the reply itself, not notes on what you did; you do not need to run agent-comms.`
    + (fromSoul ? ` If it needs no answer (a thanks, or a result you only had to receive), make your final answer exactly ${NO_REPLY} and nothing is sent. Use send_message to tell anyone else, such as the person who asked you for this work, what came of it. If you use send_message in this turn, your final answer is not sent at all, so send ${sender} anything they need to hear with send_message too. A start_soul brief does not count: after one, your final answer is still sent. Send results, questions and blockers; skip thanks, acknowledgements and progress notes, since each message wakes its reader.` : '')
    + (thread.length > 0 ? ' This session does not remember earlier turns, so the conversation so far is below. If this message answers something you asked for on someone else\'s behalf, pass the result on to them with send_message.' : '')
    + `\n\n${formatThread(thread)}${thread.length > 0 ? 'The new message:\n\n' : ''}${message.body}`;
}

// Two spellings of one recipient: a bare agent id, or `account/agentId`.
function sameAddress(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  return a === b || a.split('/').pop() === b.split('/').pop();
}

const DENIED_NOTICE_TOOLS = 3;

// The reply a turn gets when the policy refused its tools and it said
// nothing: which tools, never the rules behind them.
export function deniedNotice(tools) {
  const names = [...new Set((Array.isArray(tools) ? tools : [])
    .map((name) => (typeof name === 'string' ? name.replace(/[^\w.:*/-]/g, '').slice(0, 64) : ''))
    .filter(Boolean))];
  if (names.length === 0) return null;
  const shown = names.slice(0, DENIED_NOTICE_TOOLS);
  const more = names.length - shown.length;
  const list = shown.join(', ') + (more > 0 ? ` and ${more} more` : '');
  return `I couldn't finish this: ${list} ${names.length === 1 ? 'is' : 'are'} not allowed for me here (my owner's policy for this agent).`;
}

function recordInbound(agentId, message, threads) {
  recordThreadMessage(agentId, {
    dir: 'in', id: message.id, from: senderAddress(message.from), replyTo: message.replyTo, correlation: message.correlation, body: message.body,
  }, threads);
}

export function createColdWaker({ executor, settings, lookupBinding, identities, receipt, relay = null, webhook = null, taskReporter = null, authStatus = null, threads = {}, log = (line) => process.stderr.write(`cold-wake: ${line}\n`) }) {
  if (typeof executor !== 'function') throw new Error('cold waker requires an executor');
  if (typeof lookupBinding !== 'function') throw new Error('cold waker requires lookupBinding');
  if (typeof identities !== 'function') throw new Error('cold waker requires identities');
  if (typeof receipt !== 'function') throw new Error('cold waker requires receipt');
  const active = new Map();
  // Messages already told about a sign-in failure, per soul, until a turn runs.
  const noticed = new Map();
  // A failing recorder never fails the turn.
  const recordAuth = (agentId, failure, harness) => {
    try {
      if (failure) authStatus?.failed(agentId, { status: failure, harness });
      else { noticed.delete(agentId); authStatus?.cleared(agentId); }
    } catch (error) { log(`harness sign-in status for ${agentId} not recorded: ${error?.message ?? String(error)}`); }
  };
  async function coldWake(event) {
    const { agentId, count, cursor, messageIds } = event ?? {};
    const currentSettings = typeof settings === 'function' ? await settings() : settings;
    // The setting picks the lane (#323): an ACP turn or a resumed harness
    // session. The executor receives it as `wake`.
    const wake = wakeSetting(currentSettings?.[agentId]);
    if (wake === null) return { outcome: 'waiting', detail: 'cold wake is disabled' };
    if (active.has(agentId)) {
      active.get(agentId).ids.push(...(Array.isArray(messageIds) ? messageIds : []));
      return { outcome: 'cold', detail: 'merged into the active turn' };
    }
    // `done` covers the whole flight, setup included, so idle() never
    // returns while a wake is still resolving its binding.
    let settle;
    const flight = { ids: Array.isArray(messageIds) ? [...messageIds] : [], done: new Promise((resolve) => { settle = resolve; }) };
    active.set(agentId, flight);
    const land = () => { active.delete(agentId); settle(); };
    let binding;
    let identity;
    try {
      binding = await lookupBinding(agentId);
      // A resume turn can run on a worktree alone: a soul bound by its own
      // session pins its identity in the worktree's git config (#323).
      // A webhook needs only the worktree its routine reads the inbox in.
      if (!binding?.worktree || (!binding.file && wake.lane === 'acp')) throw new Error('soul binding is unavailable');
      if (wake.lane === 'webhook' && !webhook) throw new Error('webhook wake is not available in this daemon');
      identity = wake.lane === 'webhook' ? null : await identities(agentId);
      if (wake.lane !== 'webhook' && !identity?.harness) throw new Error('soul harness identity is unavailable');
    } catch (error) {
      land();
      receipt({ event: 'cold-wake', agentId, decision: 'failed', detail: error?.message || 'cold wake failed' });
      return { outcome: 'failed', detail: error?.message || 'cold wake failed' };
    }
    if (wake.lane === 'webhook') {
      // The call is the whole flight: the routine runs on the harness's side,
      // and the messages stay unacked until the soul acks them.
      try {
        await webhook({ agentId, worktree: binding.worktree });
        receipt({ event: 'cold-wake', agentId, decision: 'webhook' });
        return { outcome: 'cold', detail: 'webhook accepted' };
      } catch (error) {
        receipt({ event: 'cold-wake', agentId, decision: 'failed', detail: error?.message || 'webhook wake failed' });
        return { outcome: 'failed', detail: error?.message || 'webhook wake failed' };
      } finally {
        land();
      }
    }
    const invocation = { agentId, harness: identity.harness, cwd: binding.worktree, cursor };
    const env = binding.file ? { AGENT_BOT_BINDING: binding.file } : {};
    const soul = { agentId, binding };
    // Each read returns everything still unacked, so messages that merge
    // into this flight are answered before it lands.
    const reply = async (message, to, body, correlation) => {
      const sent = await relay.reply(soul, { to, replyTo: message.id, body, correlation }).catch((error) => {
        if (!FINAL_REPLY_ERRORS.has(error?.code)) throw error;
        return null;
      });
      if (sent) recordThreadMessage(agentId, { dir: 'out', id: sent.messageId, to, replyTo: message.id, correlation, body }, threads);
    };
    // Once the harness is signed out, the rest of the batch is not run: each
    // sender is told once, and every message stays unacked.
    let signedOut = null;
    let ran = false;
    const tell = async (message) => {
      const told = noticed.get(agentId) ?? new Set();
      noticed.set(agentId, told);
      if (told.has(message.id) || message.kind === 'task-event') return;
      told.add(message.id);
      await reply(message, senderAddress(message.from), harnessAuthNotice(identity.harness, signedOut), threadKey(message));
    };
    const relayed = async () => {
      for (let messages = await relay.read(soul); messages.length; messages = await relay.read(soul)) {
        for (const message of messages) {
          if (signedOut) { await tell(message); continue; }
          if (message.kind === 'task-event') {
            const brief = await relay.brief?.(soul, message.id);
            if (brief?.turn) {
              const linked = { ...invocation, invocationId: `invocation_${randomUUID()}`, taskId: brief.taskId };
              const report = async (phase, outcome) => {
                if (!brief.linked) return;
                try {
                  if (taskReporter) await taskReporter[phase](linked, outcome);
                  else await relay.report?.(soul, { ...linked, phase, ...(outcome ? { outcome } : {}) });
                } catch (error) { log(`task invocation ${linked.invocationId} ${phase} report failed: ${error?.message ?? String(error)}`); }
              };
              await report('started');
              try {
                const result = await executor({ invocation: brief.linked ? linked : invocation, message: brief.prompt, attachments: [], env, wake });
                ran = true;
                await report('ended', result?.cancelled ? 'cancelled' : 'completed');
              } catch (error) {
                await report('ended', error?.name === 'AbortError' ? 'cancelled' : 'failed');
                if (error?.name !== 'AbortError') await relay.ack(soul, [message.id]);
                throw error;
              }
            }
            await relay.ack(soul, [message.id]);
            continue;
          }
          // The thread is read before this message joins the journal, and
          // the turn's own sends (send_message) carry its thread key.
          const thread = threadContext(agentId, message, threads);
          recordInbound(agentId, message, threads);
          const correlation = threadKey(message);
          const turn = correlation ? { ...invocation, correlation } : invocation;
          const before = sentMarks(agentId, { correlation }, threads);
          let result;
          try {
            result = await executor({ invocation: turn, message: relayPrompt(message, thread), attachments: [], env, wake });
          } catch (error) {
            signedOut = harnessAuthFailure(error);
            if (!signedOut) throw error;
            await tell(message);
            continue;
          }
          ran = true;
          const to = senderAddress(message.from);
          const own = sentSince(agentId, { before, correlation }, threads);
          const fromSoul = typeof message.from?.principal !== 'string';
          // A start_soul brief briefs the teammate, not the requester, so
          // only a send_message (or a brief to the requester) holds back the
          // final answer to another soul.
          const spoke = own.some((entry) => sameAddress(entry.to, to))
            || (fromSoul && own.some((entry) => entry.kind !== 'brief'));
          const said = typeof result?.reply === 'string' ? result.reply.trim() : '';
          const body = spoke ? '' : (stripNoReply(result?.reply) || (said === '' ? deniedNotice(result?.denied) : null));
          if (body) await reply(message, to, body, correlation);
          await relay.ack(soul, [message.id]);
        }
        // Unacked messages would come back on every read.
        if (signedOut) throw Object.assign(new Error('harness sign-in failed'), { harnessAuth: signedOut });
      }
      return { ran };
    };
    const prompt = `There are ${Number.isSafeInteger(count) ? count : flight.ids.length} agent-comms messages waiting (IDs: ${flight.ids.join(', ')}). Read them with agent-comms inbox read, act, and ack them with agent-comms inbox ack.`;
    // The wake is reported `cold` once the turn starts (#259 req 3); the
    // turn itself runs on, and wakes that arrive meanwhile merge into it.
    let turn;
    try {
      turn = relay ? relayed() : Promise.resolve(executor({ invocation, message: prompt, attachments: [], env, wake }));
    } catch {
      // A launch that throws started no turn, so the wake is not `cold`.
      land();
      receipt({ event: 'cold-wake', agentId, decision: 'failed', detail: 'cold wake turn could not start' });
      return { outcome: 'failed', detail: 'cold wake turn could not start' };
    }
    turn.then(
      (value) => {
        // A turn that ran proves the sign-in; an empty relay read does not.
        if (!relay || value?.ran) recordAuth(agentId, null);
        receipt({ event: 'cold-wake', agentId, decision: 'finished' });
      },
      // A turn's own error can quote the model or a message, so its receipt
      // says only that the turn failed, or that its harness is signed out.
      (error) => {
        const failure = harnessAuthFailure(error);
        if (failure) recordAuth(agentId, failure, identity.harness);
        receipt({ event: 'cold-wake', agentId, decision: 'failed', detail: failure ? `harness ${failure}` : 'cold wake turn failed' });
      },
    ).finally(land);
    receipt({ event: 'cold-wake', agentId, decision: 'started' });
    return { outcome: 'cold', detail: 'turn started' };
  }
  // Resolves when every turn in flight has ended (tests and shutdown).
  coldWake.idle = () => Promise.all([...active.values()].map((flight) => flight.done));
  // Souls with a turn in flight right now (`agent-bot soul comms` refuses
  // to change a running soul's setting).
  coldWake.busy = () => [...active.keys()];
  return coldWake;
}
