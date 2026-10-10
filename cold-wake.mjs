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
// A soul that handed work to a teammate waits for its reply rather than
// pinging it again or sending progress notes (#427): the prompt names the
// teammates it is still waiting on, and the reach server refuses a second
// message to one of them in the same thread (daemon-mcp.mjs).
// Each relayed turn records asides (#404, soul-asides.mjs): what entered the
// soul's context (the woken message and the thread shown with it), once the
// turn's harness session exists, and the reply the relay sent from it.
// A turn that fails because the harness is signed out or its sign-in expired
// (#84) is reported through `authStatus`, so the census can show it, and each
// waiting sender gets one short notice. Those messages stay unacked, so they
// are answered on a wake after the owner signs the soul in again; the next
// turn that runs clears the status.

import { randomUUID } from 'node:crypto';
import { assertSoulUnpaused } from './agent-population.mjs';

import { wakeSetting } from './cold-wake-settings.mjs';
import { FINAL_REPLY_ERRORS, senderAddress } from './comms-relay.mjs';
import { NO_REPLY, formatThread, pendingReplies, recordThreadMessage, sameAddress, sentMarks, sentSince, stripNoReply, threadContext, threadKey } from './soul-threads.mjs';
import { bindTurnSession, recordAside } from './soul-asides.mjs';
import { harnessAuthFailure, harnessAuthNotice } from './harness-auth.mjs';
import { RESUME_KEPT_REFUSALS } from './wake-resume.mjs';

// The final answer a soul gives when a teammate's message needs no answer
// back. Every relayed turn's answer is otherwise a reply, so two souls would
// trade acknowledgements until the broker's reply-depth limit.
export { NO_REPLY };

export function relayPrompt(message, thread = [], waitingOn = []) {
  const fromSoul = typeof message.from?.principal !== 'string';
  const sender = senderAddress(message.from);
  return `You have an agent-comms message from ${sender}${fromSoul ? ', another agent' : ''}. Your final answer is sent back to them as your reply, so write it as the reply itself, not notes on what you did; you do not need to run agent-comms.`
    + (fromSoul ? ` If it needs no answer (a thanks, or a result you only had to receive), make your final answer exactly ${NO_REPLY} and nothing is sent. Use send_message to tell anyone else, such as the person who asked you for this work, what came of it. If you use send_message in this turn, your final answer is not sent at all, so send ${sender} anything they need to hear with send_message too. A start_soul brief does not count: after one, your final answer is still sent, so if it would only say the work is under way, make it exactly ${NO_REPLY}; the teammate's reply wakes you, and you answer then. Send results, questions and blockers; skip thanks, acknowledgements and progress notes, since each message wakes its reader.` : '')
    + (thread.length > 0 ? ' This session does not remember earlier turns, so the conversation so far is below. If this message answers something you asked for on someone else\'s behalf, pass the result on to them with send_message.' : '')
    + (waitingOn.length > 0 ? ` You are still waiting on ${waitingOn.join(', ')} in this conversation; ${waitingOn.length === 1 ? 'its reply wakes' : 'their replies wake'} you in a later turn. Do not message ${waitingOn.length === 1 ? 'it' : 'them'} again or send other agents progress notes meanwhile${fromSoul ? `; if you need ${waitingOn.length === 1 ? 'that reply' : 'those replies'} before answering, make your final answer exactly ${NO_REPLY}` : ''}.` : '')
    + `\n\n${formatThread(thread)}${thread.length > 0 ? 'The new message:\n\n' : ''}${message.body}`;
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

function threadNow(threads) {
  return typeof threads?.now === 'function' ? threads.now() : new Date();
}

// The asides for what a relayed turn's prompt put into the session: the
// thread it re-showed, then the woken message.
function recordDelivered(agentId, message, thread, { turnId, harnessSessionId }, threads) {
  for (const entry of thread) {
    recordAside(agentId, {
      dir: entry.dir, via: 'thread-context', peer: entry.dir === 'out' ? entry.to : entry.from, messageId: entry.id,
      replyTo: entry.replyTo, correlation: entry.correlation, body: entry.body, sentAt: entry.at, turnId, harnessSessionId,
    }, threads);
  }
  recordAside(agentId, {
    dir: 'in', via: 'relay-prompt', peer: senderAddress(message.from), messageId: message.id, replyTo: message.replyTo,
    correlation: message.correlation, body: message.body, turnId, harnessSessionId,
  }, threads);
}

function recordInbound(agentId, message, threads) {
  recordThreadMessage(agentId, {
    dir: 'in', id: message.id, from: senderAddress(message.from), replyTo: message.replyTo, correlation: message.correlation, body: message.body,
  }, threads);
}

// One line's worth of a turn error for the daemon log: its code (or class)
// and a bounded message. The audit receipt never carries this (a turn's
// error can quote the model or a message); the log is where it is read.
function describeError(error) {
  const code = typeof error?.code === 'string' ? error.code : (error?.name ?? 'Error');
  const message = String(error?.message ?? error).replace(/\s+/g, ' ').trim();
  return `${code}: ${message.length > 200 ? `${message.slice(0, 200)}…` : message}`;
}

export function createColdWaker({ isPaused = () => false, executor, settings, lookupBinding, identities, receipt, relay = null, webhook = null, taskReporter = null, authStatus = null, threads = {}, log = (line) => process.stderr.write(`cold-wake: ${line}\n`) }) {
  if (typeof executor !== 'function') throw new Error('cold waker requires an executor');
  if (typeof lookupBinding !== 'function') throw new Error('cold waker requires lookupBinding');
  if (typeof identities !== 'function') throw new Error('cold waker requires identities');
  if (typeof receipt !== 'function') throw new Error('cold waker requires receipt');
  const runTurn = (input) => {
    assertSoulUnpaused(isPaused(input.invocation.agentId));
    return executor(input);
  };
  const pausedWake = (agentId) => {
    receipt({ event: 'cold-wake', agentId, decision: 'paused' });
    return { outcome: 'waiting', detail: 'soul is paused' };
  };
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
    if (isPaused(agentId)) return pausedWake(agentId);
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
      if (isPaused(agentId)) { land(); return pausedWake(agentId); }
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
      if (sent) recordThreadMessage(agentId, { dir: 'out', id: sent.messageId, to, replyTo: message.id, correlation, kind: 'reply', body }, threads);
      return sent;
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
      await reply(message, senderAddress(message.from), harnessAuthNotice(identity.harness, signedOut, agentId), threadKey(message));
    };
    const relayed = async () => {
      for (let messages = await relay.read(soul); messages.length; messages = await relay.read(soul)) {
        for (const message of messages) {
          assertSoulUnpaused(isPaused(agentId));
          if (signedOut) { await tell(message); continue; }
          if (message.kind === 'task-event') {
            const brief = await relay.brief?.(soul, message.id);
            assertSoulUnpaused(isPaused(agentId));
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
                const result = await runTurn({ invocation: brief.linked ? linked : invocation, message: brief.prompt, attachments: [], env, wake });
                ran = true;
                await report('ended', result?.cancelled ? 'cancelled' : 'completed');
              } catch (error) {
                await report('ended', error?.name === 'AbortError' ? 'cancelled' : 'failed');
                // A refusal about the recorded resume session leaves the
                // event unacked, to run once it is fixed (#617).
                if (error?.name !== 'AbortError' && error?.code !== 'soul-paused' && !RESUME_KEPT_REFUSALS.includes(error?.code)) {
                  log(`task ${brief.taskId} turn for ${agentId} failed: ${describeError(error)}`);
                  await relay.ack(soul, [message.id]);
                }
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
          const turnId = `turn_${randomUUID()}`;
          const turn = correlation ? { ...invocation, correlation, turnId } : { ...invocation, turnId };
          const before = sentMarks(agentId, { correlation }, threads);
          // The prompt enters the context once the turn's harness session
          // exists; a lane that names no session ran the turn, so it did too.
          // A turn that fails before either leaves no aside.
          let delivered = null;
          const deliver = (harnessSessionId = null) => {
            if (delivered) return;
            delivered = { harnessSessionId: typeof harnessSessionId === 'string' ? harnessSessionId : null };
            // The turn's own sends (reach server) look this up (#404).
            if (delivered.harnessSessionId) bindTurnSession(agentId, turnId, delivered.harnessSessionId, threads);
            recordDelivered(agentId, message, thread, { turnId, ...delivered }, threads);
          };
          const waitingOn = pendingReplies(agentId, { correlation, now: threadNow(threads) }, threads).map((entry) => entry.to);
          let result;
          try {
            result = await runTurn({ invocation: turn, message: relayPrompt(message, thread, waitingOn), attachments: [], env, wake, onSession: deliver });
          } catch (error) {
            // A signed-out harness never read the prompt, so no aside (#84).
            signedOut = harnessAuthFailure(error);
            if (!signedOut) throw error;
            await tell(message);
            continue;
          }
          deliver();
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
          if (body) {
            const sent = await reply(message, to, body, correlation);
            if (sent) {
              recordAside(agentId, {
                dir: 'out', via: 'final-reply', peer: to, messageId: sent.messageId, replyTo: message.id, correlation, body,
                turnId, harnessSessionId: delivered.harnessSessionId,
              }, threads);
            }
          }
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
      turn = relay ? relayed() : Promise.resolve(runTurn({ invocation, message: prompt, attachments: [], env, wake }));
    } catch (error) {
      if (error?.code === 'soul-paused') { land(); return pausedWake(agentId); }
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
        if (error?.code === 'soul-paused') { pausedWake(agentId); return; }
        if (error?.name === 'AbortError') {
          receipt({ event: 'cold-wake', agentId, decision: 'cancelled' });
          return;
        }
        const failure = harnessAuthFailure(error);
        if (failure) recordAuth(agentId, failure, identity.harness);
        log(`cold wake turn for ${agentId} failed: ${describeError(error)}`);
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
