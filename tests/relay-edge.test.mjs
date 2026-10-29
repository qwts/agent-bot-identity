// Edge push transport behind nextEvents: a scripted SSE stream plus the
// same fake relay log the poll tests use.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { nextEvents, cursorKey } from '../identity/relay-events.mjs';
import { fakeServer } from './helpers/fake-identity-server.mjs';

const enc = (pos, sub = 'sub1') => Buffer.from(`v1.${sub}.${pos}`).toString('base64url');
const HARNESS = 'qwts-devin-agent';
const relay = (body, pos, extra = {}) => ({
  eventId: `msg-${pos}`, name: 'relay.message', timestamp: '2026-10-28T00:00:00Z', cursor: enc(pos),
  data: { body, id: `msg-${pos}`, from: 'Qwts', harness: HARNESS, untrusted: true, ...extra },
});

// A session stub: real fake /mcp for tickets+poll, scripted SSE for edge.
function session(srv, { poll } = {}) {
  return {
    opts: { env: {} },
    mcpEdgeTicket: async ({ cursor }) => {
      srv.ticketCalls = (srv.ticketCalls ?? 0) + 1;
      if (srv.noEdge) { const e = new Error('unsupported'); e.code = 'event-edge-unsupported'; throw e; }
      srv.tickets = srv.tickets ?? new Map();
      srv.tickets.set(`tkt_${srv.ticketCalls}`, {});
      return { ticket: `tkt_${srv.ticketCalls}`, expiresAt: new Date(Date.now() + 600000).toISOString(), cursor: enc(0), sse: srv.sseUrl ?? 'http://127.0.0.1/sse' };
    },
    edgeFetch: srv.sseFetch,
    mcpEventsPoll: poll ?? (async () => ({ events: [], cursor: enc(0), hasMore: false, nextPollMs: 5 })),
  };
}
const frames = (...list) => ({ sseScript: list.map((f) => ({ method: `notifications/events/${f[0]}`, params: f[1] })) });

test('an event arrives over the edge stream', async () => {
  const srv = fakeServer();
  Object.assign(srv, frames(['active', { cursor: enc(0) }], ['event', relay('hi edge', 1)]));
  const out = await nextEvents({ session: session(srv), harness: HARNESS, cursor: enc(0), waitMs: 3000, transport: 'edge' });
  assert.equal(out.transport, 'edge');
  assert.equal(out.events.length, 1);
  assert.equal(out.events[0].body, 'hi edge');
  assert.equal(out.cursor, enc(1));
});

test('maxEvents=1 returns the first of two stream events, cursor at it', async () => {
  const srv = fakeServer();
  Object.assign(srv, frames(['event', relay('one', 1)], ['event', relay('two', 2)]));
  const out = await nextEvents({ session: session(srv), harness: HARNESS, cursor: enc(0), waitMs: 3000, maxEvents: 1, transport: 'edge' });
  assert.equal(out.events.length, 1);
  assert.equal(out.events[0].body, 'one');
  assert.equal(out.cursor, enc(1));
});

test('heartbeat-only stream ends at the deadline with the heartbeat cursor', async () => {
  const srv = fakeServer();
  srv.sseScript = [
    { method: 'notifications/events/active', params: { cursor: enc(0) } },
    { method: 'notifications/events/heartbeat', params: { cursor: enc(3) } },
  ];
  srv.sseHold = true;
  const out = await nextEvents({ session: session(srv), harness: HARNESS, cursor: enc(0), waitMs: 60, transport: 'edge' });
  assert.equal(out.events.length, 0);
  assert.equal(out.cursor, enc(3));
});

test('-32026 falls back to poll and the memo skips re-minting', async () => {
  const srv = fakeServer();
  srv.noEdge = true;
  let polls = 0;
  const sess = session(srv, { poll: async () => { polls += 1; return { events: [relay('polled', 1)], cursor: enc(1), hasMore: false }; } });
  const out = await nextEvents({ session: sess, harness: HARNESS, cursor: enc(0), waitMs: 3000 });
  assert.equal(out.transport, 'poll');
  assert.equal(out.events[0].body, 'polled');
  assert.equal(srv.ticketCalls, 1);
  assert.ok(sess._edgeUnsupportedUntil > Date.now());
  await nextEvents({ session: sess, harness: HARNESS, cursor: enc(1), waitMs: 3000 });
  assert.equal(srv.ticketCalls, 1, 'the memo skipped another ticket mint');
  assert.equal(polls, 2);
});

test('a revoked error frame drops the ticket and falls back from the latest cursor', async () => {
  const srv = fakeServer();
  srv.sseScript = [
    { method: 'notifications/events/active', params: { cursor: enc(4) } },
    { method: 'notifications/events/error', params: { error: { code: 1, message: 'revoked', data: { reason: 'revoked' } } } },
  ];
  let pollCursor = null;
  const sess = session(srv, { poll: async (p) => { pollCursor = p.cursor; return { events: [relay('recovered', 5)], cursor: enc(5), hasMore: false }; } });
  const out = await nextEvents({ session: sess, harness: HARNESS, cursor: enc(0), waitMs: 3000 });
  assert.equal(out.transport, 'poll');
  assert.equal(pollCursor, enc(4), 'poll resumed from the advanced cursor');
  assert.equal(sess._edgeTickets.size, 0, 'the revoked ticket was dropped');
});

test('SSE 401 re-mints once then falls back', async () => {
  const srv = fakeServer();
  srv.sseStatus = 401;
  const sess = session(srv);
  const out = await nextEvents({ session: sess, harness: HARNESS, cursor: enc(0), waitMs: 500 });
  assert.equal(out.transport, 'poll');
  assert.equal(srv.ticketCalls, 2, 'one re-mint, then the second 401 fell back');
});

test('a non-https advertised sse url falls back without ever fetching it', async () => {
  const srv = fakeServer();
  srv.sseUrl = 'http://events.evil.example/sse';
  let fetched = false;
  const sess = session(srv);
  sess.edgeFetch = async () => { fetched = true; return srv.sseFetch(); };
  const out = await nextEvents({ session: sess, harness: HARNESS, cursor: enc(0), waitMs: 500 });
  assert.equal(out.transport, 'poll');
  assert.equal(fetched, false, 'the ticket was never sent to a non-https endpoint');
});

test('a malformed frame falls back to poll', async () => {
  const srv = fakeServer();
  srv.sseScript = [{ method: 'notifications/events/active', params: { cursor: enc(1) } }];
  // Corrupt the frame: sseFetch with a garbage payload.
  const real = srv.sseFetch;
  srv.sseFetch = async (url, init) => {
    const r = await real(url, init);
    return new Response(new ReadableStream({ start: (c) => { c.enqueue(Buffer.from('event: message\ndata: {bad json\n\n')); c.close(); } }), { status: 200 });
  };
  const sess = session(srv);
  const out = await nextEvents({ session: sess, harness: HARNESS, cursor: enc(0), waitMs: 3000 });
  assert.equal(out.transport, 'poll');
});

test('drops over the edge advance the cursor and are reported', async () => {
  const srv = fakeServer();
  srv.sseScript = [
    { method: 'notifications/events/event', params: { eventId: 'bad-1', name: 'relay.message', cursor: enc(1), data: { id: 'bad-1', from: 'bad!', harness: HARNESS, body: 'x', untrusted: true } } },
    { method: 'notifications/events/event', params: relay('good', 2) },
  ];
  const out = await nextEvents({ session: session(srv), harness: HARNESS, cursor: enc(0), waitMs: 3000, transport: 'edge' });
  assert.equal(out.dropped.length, 1);
  assert.equal(out.events[0].body, 'good');
  assert.equal(out.cursor, enc(2));
});

test('the cursor never rewinds on a stale frame cursor', async () => {
  const srv = fakeServer();
  srv.sseScript = [
    { method: 'notifications/events/heartbeat', params: { cursor: enc(9) } },
    { method: 'notifications/events/heartbeat', params: { cursor: enc(2) } },
  ];
  srv.sseHold = true;
  const out = await nextEvents({ session: session(srv), harness: HARNESS, cursor: enc(0), waitMs: 60, transport: 'edge' });
  assert.equal(out.cursor, enc(9));
});

test("transport 'poll' never mints a ticket; 'edge' surfaces errors", async () => {
  const srv = fakeServer();
  srv.noEdge = true;
  await nextEvents({ session: session(srv), harness: HARNESS, cursor: enc(0), waitMs: 100, transport: 'poll' });
  assert.equal(srv.ticketCalls ?? 0, 0);
  await assert.rejects(
    nextEvents({ session: session(srv), harness: HARNESS, cursor: enc(0), waitMs: 100, transport: 'edge' }),
    (e) => e?.code === 'event-edge-unsupported',
  );
});

test('the ticket string never reaches thrown errors', async () => {
  const srv = fakeServer();
  srv.sseStatus = 403;
  try {
    await nextEvents({ session: session(srv), harness: HARNESS, cursor: enc(0), waitMs: 100, transport: 'edge' });
    assert.fail('edge should surface');
  } catch (e) {
    assert.doesNotMatch(e.message, /tkt_/);
  }
});

test('a replayed event at/behind the start cursor is skipped entirely', async () => {
  const srv = fakeServer();
  srv.sseScript = [
    { method: 'notifications/events/active', params: { cursor: enc(2) } },
    { method: 'notifications/events/event', params: relay('replay', 2) },
    { method: 'notifications/events/event', params: relay('fresh', 3) },
  ];
  const out = await nextEvents({ session: session(srv), harness: HARNESS, cursor: enc(2), waitMs: 3000, transport: 'edge' });
  assert.equal(out.events.length, 1);
  assert.equal(out.events[0].body, 'fresh', 'only the new event is delivered');
  assert.equal(out.dropped.length, 0, 'the replay was skipped, not dropped');
  assert.equal(out.cursor, enc(3));
});

test('the SSE fetch never follows a redirect — the ticket stays with the edge', async () => {
  const srv = fakeServer();
  let sawRedirect = null;
  const sess = session(srv);
  sess.edgeFetch = async (url, init) => { sawRedirect = init?.redirect; return new Response('moved', { status: 302, headers: { location: 'https://evil.example/' } }); };
  const out = await nextEvents({ session: sess, harness: HARNESS, cursor: enc(0), waitMs: 500 });
  assert.equal(sawRedirect, 'error', 'fetch asks the platform to refuse redirects');
  assert.equal(out.transport, 'poll', 'a redirect is an edge failure');
});

test('a malformed config cannot enable the edge — transport resolves poll', async () => {
  const srv = fakeServer();
  const sess = session(srv, { poll: async () => ({ events: [relay('p', 1)], cursor: enc(1), hasMore: false }) });
  sess.opts = { env: { AGENT_BOT_CONFIG: '/dev/null' } }; // not JSON -> parse throws -> 'poll'
  const out = await nextEvents({ session: sess, harness: HARNESS, cursor: enc(0), waitMs: 3000 });
  assert.equal(out.transport, 'poll');
  assert.equal(srv.ticketCalls ?? 0, 0, 'no ticket was minted');
});

test('a single frame over 64 KiB without a terminator trips the cap', async () => {
  const srv = fakeServer();
  const real = srv.sseFetch;
  srv.sseFetch = async (url, init) => {
    await real(url, init);
    return new Response(new ReadableStream({ start: (c) => { c.enqueue(Buffer.from('data: ' + 'x'.repeat(70 * 1024))); c.close(); } }), { status: 200 });
  };
  const sess = session(srv);
  const out = await nextEvents({ session: sess, harness: HARNESS, cursor: enc(0), waitMs: 3000 });
  assert.equal(out.transport, 'poll', 'the oversize frame is an edge failure');
});

test('CRLF-framed events parse the same as LF frames', async () => {
  const srv = fakeServer();
  const real = srv.sseFetch;
  srv.sseFetch = async (url, init) => {
    await real(url, init);
    const body = 'event: message\r\ndata: ' + JSON.stringify({ method: 'notifications/events/event', params: relay('crlf', 1) }) + '\r\n\r\n';
    return new Response(new ReadableStream({ start: (c) => { c.enqueue(Buffer.from(body)); c.close(); } }), { status: 200 });
  };
  const sess = session(srv);
  const out = await nextEvents({ session: sess, harness: HARNESS, cursor: enc(0), waitMs: 3000, transport: 'edge' });
  assert.equal(out.events.length, 1);
  assert.equal(out.events[0].body, 'crlf');
});

test('explicit edge after a memoized -32026 throws, never polls', async () => {
  const srv = fakeServer();
  srv.noEdge = true;
  let polls = 0;
  const sess = session(srv, { poll: async () => { polls += 1; return { events: [], cursor: enc(0), hasMore: false, nextPollMs: 5 }; } });
  await nextEvents({ session: sess, harness: HARNESS, cursor: enc(0), waitMs: 100 }); // auto memoizes
  polls = 0;
  await assert.rejects(
    nextEvents({ session: sess, harness: HARNESS, cursor: enc(0), waitMs: 100, transport: 'edge' }),
    (e) => e?.code === 'event-edge-unsupported',
  );
  assert.equal(polls, 0, 'explicit edge never touches the poll path');
});

test('one chunk of many small frames is processed, not capped', async () => {
  const srv = fakeServer();
  const frames = [];
  for (let i = 1; i <= 100; i += 1) {
    frames.push(`event: message\ndata: ${JSON.stringify({ method: 'notifications/events/heartbeat', params: { cursor: enc(i) } })}\n\n`);
  }
  srv.sseFetch = async () => new Response(new ReadableStream({
    start: (c) => { c.enqueue(Buffer.from(frames.join(''))); c.close(); },
  }), { status: 200 });
  const sess = session(srv);
  const out = await nextEvents({ session: sess, harness: HARNESS, cursor: enc(0), waitMs: 3000, transport: 'edge' });
  assert.equal(out.transport, 'edge', `${frames.join('').length} bytes of small frames drained fine`);
  assert.equal(out.cursor, enc(100));
});
