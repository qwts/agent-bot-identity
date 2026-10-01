import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  WAKE_FRAME_EVENT,
  WAKE_OUTCOMES,
  createWakeDispatcher,
  dispatchWake,
  wakeFrame,
} from '../wake-dispatch.mjs';

const AGENT_ID = 'agent_44444444-4444-4444-8444-444444444444';
const OTHER_AGENT_ID = 'agent_55555555-5555-4555-8555-555555555555';

function wakeEvent(overrides = {}) {
  return {
    event: 'wake',
    agentId: AGENT_ID,
    count: 2,
    cursor: 'cur-000042',
    messageIds: ['msg_1', 'msg_2'],
    ...overrides,
  };
}

// --- fakes -----------------------------------------------------------------

// A warm pool (#147) fake: sockets per soul, each send either takes the frame
// or throws, and a send that delivers to nobody is what "every socket failed"
// looks like from the dispatcher.
function fakePool({ sockets = {}, failing = [] } = {}) {
  const state = { frames: [], dropped: [], sends: [] };
  return {
    state,
    sockets,
    has(agentId) {
      return Object.hasOwn(sockets, agentId) && sockets[agentId] > 0;
    },
    async send(agentId, frame) {
      state.sends.push({ agentId, frame });
      state.frames.push(frame);
      if (failing.includes(agentId)) {
        throw new Error('socket closed during write');
      }
      return sockets[agentId] ?? 0;
    },
    drop(agentId) {
      state.dropped.push(agentId);
      delete sockets[agentId];
    },
  };
}

// The broker's `wake-report` port, plus the daemon's audit sink. Both record
// every call so a test can assert on the whole dispatch, not just the return.
function fakeSinks() {
  const reports = [];
  const receipts = [];
  return {
    reports,
    receipts,
    report(agentId, messageIds, outcome, detail) {
      reports.push({ agentId, messageIds, outcome, detail });
    },
    receipt(object) {
      receipts.push(object);
    },
  };
}

// Ports for a soul with warm sockets, and for one with none — the same
// dispatcher, the only difference being what the pool holds.
function warmPorts(overrides = {}) {
  return portsFor({ sockets: { [AGENT_ID]: 2 }, ...overrides });
}

function coldPorts(overrides = {}) {
  return portsFor({ sockets: {}, ...overrides });
}

function portsFor({ sockets, pool: givenPool, sinks: givenSinks, ...overrides }) {
  const pool = givenPool ?? fakePool({ sockets });
  const sinks = givenSinks ?? fakeSinks();
  return { pool, sinks, ports: { pool, coldWake: null, report: sinks.report, receipt: sinks.receipt, ...overrides } };
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

// --- requirement 1: warm, waiting, cold ------------------------------------

test('a warm soul gets the frame on every socket and is reported warm (#256)', async () => {
  const { pool, sinks, ports } = warmPorts();
  const result = await dispatchWake(wakeEvent(), ports);

  assert.equal(result.outcome, 'warm');
  assert.equal(pool.state.frames.length, 1);
  assert.deepEqual(pool.state.frames[0], {
    event: WAKE_FRAME_EVENT,
    agentId: AGENT_ID,
    count: 2,
    cursor: 'cur-000042',
    messageIds: ['msg_1', 'msg_2'],
  });
  assert.deepEqual(sinks.reports, [{
    agentId: AGENT_ID,
    messageIds: ['msg_1', 'msg_2'],
    outcome: 'warm',
    detail: 'delivered to 2 warm socket(s)',
  }]);
  assert.deepEqual(pool.state.dropped, [], 'a delivered wake drops nothing');
});

test('the frame is built field by field, so an unexpected event field is not forwarded', async () => {
  const { pool, ports } = warmPorts();
  await dispatchWake(wakeEvent({ binding: 'secret-value', token: 'ghs_leak' }), ports);
  assert.deepEqual(Object.keys(pool.state.frames[0]).sort(), [
    'agentId', 'count', 'cursor', 'event', 'messageIds',
  ]);
  assert.equal(JSON.stringify(pool.state.frames[0]).includes('secret-value'), false);
});

test('one socket of three is still warm — the frame reached the soul', async () => {
  const { pool, sinks, ports } = warmPorts({ pool: fakePool({ sockets: { [AGENT_ID]: 1 } }) });
  const result = await dispatchWake(wakeEvent(), ports);
  assert.equal(result.outcome, 'warm');
  assert.equal(sinks.reports[0].detail, 'delivered to 1 warm socket(s)');
});

test('no warm socket and no cold path is waiting, and nothing is sent', async () => {
  const { pool, sinks, ports } = coldPorts();
  const result = await dispatchWake(wakeEvent(), ports);

  assert.equal(result.outcome, 'waiting');
  assert.equal(pool.state.sends.length, 0, 'a soul with no sockets is never sent to');
  assert.deepEqual(sinks.reports[0].messageIds, ['msg_1', 'msg_2']);
  assert.equal(sinks.reports[0].outcome, 'waiting');
  assert.match(sinks.reports[0].detail, /no cold wake path configured/);
});

test('with a cold path asked and cold wake off, the outcome is waiting (#256)', async () => {
  const asked = [];
  const { pool, sinks, ports } = coldPorts();
  const result = await dispatchWake(wakeEvent(), {
    ...ports,
    coldWake: async (event) => { asked.push(event); return null; },
  });

  assert.equal(result.outcome, 'waiting');
  assert.equal(asked.length, 1);
  assert.equal(asked[0].agentId, AGENT_ID);
  assert.equal(asked[0].cursor, 'cur-000042');
  assert.equal(pool.state.sends.length, 0);
  assert.match(sinks.reports[0].detail, /cold wake is off for this soul/);
});

test('a cold wake is delegated to the cold path and its outcome is reported verbatim', async () => {
  const { sinks, ports } = coldPorts();
  const result = await dispatchWake(wakeEvent(), {
    ...ports,
    coldWake: async () => ({ outcome: 'cold', detail: 'started drive-plane turn' }),
  });

  assert.equal(result.outcome, 'cold');
  assert.deepEqual(sinks.reports[0], {
    agentId: AGENT_ID,
    messageIds: ['msg_1', 'msg_2'],
    outcome: 'cold',
    detail: 'started drive-plane turn',
  });
});

test('the cold path is asked only when there is no warm socket', async () => {
  let asked = 0;
  const { ports } = warmPorts();
  await dispatchWake(wakeEvent(), {
    ...ports,
    coldWake: async () => { asked += 1; return { outcome: 'cold' }; },
  });
  assert.equal(asked, 0, 'a warm soul is never also cold-woken');
});

// --- requirement 2: every socket failed is failed, and sockets drop --------

test('a send error on every socket is failed, and the sockets are dropped (#256)', async () => {
  const { pool, sinks, ports } = warmPorts({ pool: fakePool({ sockets: { [AGENT_ID]: 3 }, failing: [AGENT_ID] }) });
  const result = await dispatchWake(wakeEvent(), ports);

  assert.equal(result.outcome, 'failed');
  assert.deepEqual(pool.state.dropped, [AGENT_ID], 'the sockets are retired, not left to fail again');
  assert.equal(sinks.reports[0].outcome, 'failed');
  assert.match(sinks.reports[0].detail, /every warm socket failed/);
  // The pool's error text stays out of the broker-visible detail.
  assert.equal(sinks.reports[0].detail, 'every warm socket failed to take the frame: the warm pool threw');
});

test('a zero delivered count is failed even when send did not throw', async () => {
  // A pool that had sockets a moment ago and delivered to none reports 0.
  const pool = fakePool({ sockets: {} });
  pool.has = () => true;
  const { sinks, ports } = warmPorts({ pool });
  const result = await dispatchWake(wakeEvent(), ports);

  assert.equal(result.outcome, 'failed');
  assert.equal(sinks.reports[0].detail, 'every warm socket failed to take the frame');
  assert.deepEqual(pool.state.dropped, [AGENT_ID]);
});

test('a pool that refuses to drop still reports failed', async () => {
  const pool = fakePool({ sockets: { [AGENT_ID]: 1 }, failing: [AGENT_ID] });
  delete pool.drop;
  const { ports } = warmPorts({ pool });
  assert.equal((await dispatchWake(wakeEvent(), ports)).outcome, 'failed');
});

test('the next wake for a soul whose sockets all failed is waiting, not failed', async () => {
  const pool = fakePool({ sockets: { [AGENT_ID]: 2 }, failing: [AGENT_ID] });
  const { ports } = warmPorts({ pool });
  assert.equal((await dispatchWake(wakeEvent(), ports)).outcome, 'failed');
  // drop() removed the soul from the pool, so the soul is honestly cold now.
  assert.equal(pool.has(AGENT_ID), false);
  assert.equal((await dispatchWake(wakeEvent({ messageIds: ['msg_3'] }), ports)).outcome, 'waiting');
});

test('a cold path that throws is failed, not waiting', async () => {
  const { sinks, ports } = coldPorts();
  const result = await dispatchWake(wakeEvent(), {
    ...ports,
    coldWake: async () => { throw new Error('ACP executor unavailable'); },
  });
  assert.equal(result.outcome, 'failed');
  // An ACP error can carry stderr or payload: the broker only hears a fixed detail.
  assert.equal(sinks.reports[0].detail, 'cold wake failed');
});

test('a cold detail outside the printable bound is reported failed, not thrown', async () => {
  const { sinks, ports } = coldPorts();
  for (const detail of ['line one\nline two', 'x'.repeat(201), '', 7]) {
    const result = await dispatchWake(wakeEvent(), { ...ports, coldWake: async () => ({ outcome: 'cold', detail }) });
    assert.equal(result.outcome, 'failed');
  }
  assert.deepEqual(sinks.reports.map((entry) => entry.detail), Array(4).fill('cold wake returned a detail outside its contract'));
  assert.equal(sinks.receipts.length, 4);
});

test('a rejecting broker report still leaves a receipt and surfaces the error', async () => {
  const { sinks, ports } = warmPorts();
  await assert.rejects(
    () => dispatchWake(wakeEvent(), { ...ports, report: async () => { throw new Error('broker disconnected'); } }),
    /broker disconnected/,
  );
  assert.deepEqual(sinks.receipts, [{ event: 'wake', agentId: AGENT_ID, count: 2, outcome: 'warm' }]);
});

test('a cold path that answers outside its vocabulary fails closed', async () => {
  const { sinks, ports } = coldPorts();
  const result = await dispatchWake(wakeEvent(), { ...ports, coldWake: async () => ({ outcome: 'warm' }) });
  assert.equal(result.outcome, 'failed');
  assert.match(sinks.reports[0].detail, /outside its contract/);

  const junk = await dispatchWake(wakeEvent(), { ...ports, coldWake: async () => 'cold' });
  assert.equal(junk.outcome, 'failed');
  assert.deepEqual(sinks.reports.map((entry) => entry.outcome), ['failed', 'failed']);
});

// --- requirement 3: a secret-free receipt per dispatch ---------------------

test('every dispatch writes one receipt naming the agent, count, and outcome (#256)', async () => {
  const warm = warmPorts();
  await dispatchWake(wakeEvent(), warm.ports);
  const cold = coldPorts();
  await dispatchWake(wakeEvent({ messageIds: [], count: 0 }), { ...cold.ports, coldWake: async () => null });

  assert.deepEqual(warm.sinks.receipts, [
    { event: 'wake', agentId: AGENT_ID, count: 2, outcome: 'warm' },
  ]);
  assert.deepEqual(cold.sinks.receipts, [
    { event: 'wake', agentId: AGENT_ID, count: 0, outcome: 'waiting' },
  ]);
});

test('a receipt carries no message IDs, cursor, or detail (#256)', async () => {
  const { sinks, ports } = warmPorts();
  await dispatchWake(wakeEvent(), ports);
  const [receipt] = sinks.receipts;

  assert.deepEqual(Object.keys(receipt).sort(), ['agentId', 'count', 'event', 'outcome']);
  const serialised = JSON.stringify(receipt);
  assert.equal(serialised.includes('msg_1'), false, 'a receipt is not a second copy of the mailbox');
  assert.equal(serialised.includes('cur-000042'), false);
  for (const value of Object.values(receipt)) {
    assert.equal(typeof value === 'string' && /secret|token|ghs_|binding/i.test(value) && value !== 'wake', false);
  }
});

test('a failed dispatch still writes its receipt', async () => {
  const pool = fakePool({ sockets: { [AGENT_ID]: 1 }, failing: [AGENT_ID] });
  const { sinks, ports } = warmPorts({ pool });
  await dispatchWake(wakeEvent(), ports);
  assert.deepEqual(sinks.receipts, [{ event: 'wake', agentId: AGENT_ID, count: 2, outcome: 'failed' }]);
});

test('a missing receipt port is tolerated, since the sibling audit sink is not wired yet', async () => {
  const { sinks, ports } = warmPorts();
  const result = await dispatchWake(wakeEvent(), { ...ports, receipt: null });
  assert.equal(result.outcome, 'warm');
  assert.equal(sinks.receipts.length, 0);
  assert.equal(sinks.reports.length, 1, 'the broker is still answered');
});

// --- the dispatcher: per-soul serialisation --------------------------------

test('the dispatcher serialises per agentId, so reports never land out of order', async () => {
  const entered = [];
  const gates = [deferred(), deferred(), deferred()];
  let send = 0;
  const sinks = fakeSinks();
  const dispatch = createWakeDispatcher({
    pool: {
      has: () => true,
      async send() {
        const gate = gates[send];
        send += 1;
        entered.push(gate);
        await gate.promise;
        return 1;
      },
    },
    report: sinks.report,
    receipt: sinks.receipt,
  });

  // Three wakes for one soul issued back to back. Each send blocks until its
  // own gate opens, so any overlap would show as a second entry in `entered`
  // before the first gate is released.
  const runs = ['msg_a', 'msg_b', 'msg_c'].map((id) => dispatch(wakeEvent({
    messageIds: [id],
    count: 1,
  })));
  await Promise.resolve();
  assert.equal(entered.length, 1, 'only one wake for a soul is in flight at a time');

  gates[0].resolve();
  await new Promise((resolve) => { setImmediate(resolve); });
  assert.equal(entered.length, 2);
  gates[1].resolve();
  await new Promise((resolve) => { setImmediate(resolve); });
  assert.equal(entered.length, 3);
  gates[2].resolve();

  const results = await Promise.all(runs);
  assert.deepEqual(results.map((result) => result.outcome), ['warm', 'warm', 'warm']);
  assert.deepEqual(
    sinks.reports.map((entry) => entry.messageIds[0]),
    ['msg_a', 'msg_b', 'msg_c'],
    'the broker sees the wakes in the order the stream delivered them',
  );
});

test('a slow soul does not stall a different soul', async () => {
  const gates = { [AGENT_ID]: deferred(), [OTHER_AGENT_ID]: deferred() };
  const sinks = fakeSinks();
  const dispatch = createWakeDispatcher({
    pool: { has: () => false, send: async () => 0 },
    coldWake: async (event) => {
      await gates[event.agentId].promise;
      return { outcome: 'cold' };
    },
    report: sinks.report,
    receipt: sinks.receipt,
  });

  const slow = dispatch(wakeEvent({ agentId: AGENT_ID }));
  const fast = dispatch(wakeEvent({ agentId: OTHER_AGENT_ID }));
  // The second soul completes while the first is still inside its cold turn.
  gates[OTHER_AGENT_ID].resolve();
  assert.equal((await fast).outcome, 'cold');
  gates[AGENT_ID].resolve();
  assert.equal((await slow).outcome, 'cold');
});

test('a rejected dispatch does not poison the queue behind it', async () => {
  const sinks = fakeSinks();
  const dispatch = createWakeDispatcher({
    pool: fakePool({ sockets: { [AGENT_ID]: 1 } }),
    report: sinks.report,
    receipt: sinks.receipt,
  });

  const bad = dispatch({ event: 'wake', agentId: 'not-an-agent-id', count: 1, cursor: 'c', messageIds: [] });
  await assert.rejects(bad, /valid agentId/);
  // The next wake for that soul still runs, and the queue did not reject twice.
  assert.equal((await dispatch(wakeEvent())).outcome, 'warm');
  assert.equal(sinks.reports.length, 1);
});

test('the dispatcher forgets an idle soul instead of growing a queue per soul', async () => {
  const sinks = fakeSinks();
  const dispatch = createWakeDispatcher({
    pool: fakePool({ sockets: { [AGENT_ID]: 1 } }),
    report: sinks.report,
    receipt: sinks.receipt,
  });
  await dispatch(wakeEvent());
  await new Promise((resolve) => { setImmediate(resolve); });
  // A second dispatch after the first settled still runs, which is the
  // observable requirement; queue bookkeeping stays internal.
  assert.equal((await dispatch(wakeEvent())).outcome, 'warm');
  assert.equal(sinks.reports.length, 2);
});

// --- input validation ------------------------------------------------------

test('a malformed wake event is refused before any port is touched', async () => {
  const { pool, sinks, ports } = warmPorts();
  for (const bad of [
    null,
    { ...wakeEvent(), agentId: 'nope' },
    { ...wakeEvent(), count: -1 },
    { ...wakeEvent(), count: 1.5 },
    { ...wakeEvent(), cursor: '' },
    { ...wakeEvent(), messageIds: 'msg_1' },
    { ...wakeEvent(), messageIds: [1] },
    { ...wakeEvent(), event: 'inbox' },
  ]) {
    await assert.rejects(() => dispatchWake(bad, ports), /wake dispatch:/);
  }
  assert.equal(pool.state.sends.length, 0);
  assert.equal(sinks.reports.length, 0);
  assert.equal(sinks.receipts.length, 0);
});

test('an incomplete port set is refused at construction', () => {
  assert.throws(() => createWakeDispatcher({}), /pool must provide/);
  assert.throws(() => createWakeDispatcher({ pool: { has: () => true } }), /send\(agentId, frame\)/);
  assert.throws(
    () => createWakeDispatcher({ pool: fakePool(), coldWake: 'yes' }),
    /coldWake must be a function or null/,
  );
  assert.throws(() => createWakeDispatcher({ pool: fakePool() }), /report must be a function/);
  assert.throws(
    () => createWakeDispatcher({ pool: fakePool(), report: () => {}, receipt: 7 }),
    /receipt must be a function or null/,
  );
});

test('an oversized message ID list is refused rather than broadcast', async () => {
  const { pool, ports } = warmPorts();
  const many = Array.from({ length: 513 }, (_unused, i) => `msg_${i}`);
  await assert.rejects(
    () => dispatchWake(wakeEvent({ messageIds: many, count: many.length }), ports),
    /at most 512 message IDs/,
  );
  assert.equal(pool.state.sends.length, 0);
});

test('the frame is exactly the ADR-0008 decision 7 shape', () => {
  const frame = wakeFrame(wakeEvent());
  assert.deepEqual(frame, {
    event: 'wake',
    agentId: AGENT_ID,
    count: 2,
    cursor: 'cur-000042',
    messageIds: ['msg_1', 'msg_2'],
  });
  assert.deepEqual(WAKE_OUTCOMES, ['warm', 'cold', 'waiting', 'failed']);
});

test('a report never aliases the event it was dispatched from', async () => {
  const event = wakeEvent();
  const { pool, sinks, ports } = coldPorts();
  await dispatchWake(event, { ...ports, coldWake: async () => null });
  assert.equal(pool.state.sends.length, 0);
  assert.notEqual(sinks.reports[0].messageIds, event.messageIds);
  event.messageIds.push('msg_injected');
  assert.deepEqual(sinks.reports[0].messageIds, ['msg_1', 'msg_2']);
  assert.deepEqual(wakeFrame(event).messageIds, ['msg_1', 'msg_2', 'msg_injected'],
    'a frame is still built from the event as received');
});

// --- the daemon hook point --------------------------------------------------

test('the broker\'s numeric sequence cursor is accepted and forwarded (#256)', async () => {
  const sent = [];
  const reports = [];
  const result = await dispatchWake({ ...wakeEvent(), cursor: 42 }, {
    pool: { has: () => true, send: (agentId, frame) => { sent.push(frame); return 1; } },
    coldWake: null,
    report: async (...args) => { reports.push(args); },
  });
  assert.equal(result.outcome, 'warm');
  assert.equal(sent[0].cursor, 42);
  assert.equal(reports.length, 1);
});
