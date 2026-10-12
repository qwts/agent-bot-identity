// Optional OTLP/HTTP JSON trace export of diagnostics (ADR-0983 decisions 3
// and 4, #983). Hand-written with Node built-ins; no OpenTelemetry SDK, and
// nothing here installs a global exporter.
//
// Off unless the user config sets `settings.diagnosticsOtlpEndpoint`; ambient
// OTEL_* variables never enable it. Headers (a collector's API key, say) come
// from AGENT_BOT_OTLP_HEADERS as `name=value,name=value`, are read when the
// exporter starts, and never appear in a log or error.
//
// Metrics (#983 decision 3): one cumulative counter, `agent_bot.operations`,
// of finished operations by component, operation, outcome and code, and
// `agent_bot.export.dropped`, what this exporter dropped. At most
// MAX_SERIES attribute sets are kept; an operation past that is counted as
// dropped. Counters are sent with the traces on each flush when they
// changed; a failed send is simply tried again on the next flush, since the
// values are cumulative.
//
// What is sent is fixed here: an operation's span with its name, trace and
// span IDs, start and end time, status, and the attributes component,
// outcome, stage, code, duration and the hashed agent; its stages as span
// events with stage and duration. The resource names the service, its
// version and the OS type. A stored event's `detail`, and anything else, is
// never sent.
//
// Bounded and non-blocking: a fixed queue (overflow is dropped and counted),
// fixed batches, one request in flight with a timeout, one retry for a
// network error, 429 or 5xx, then the batch is dropped and counted. The
// exporter never throws into its caller, and no task or security decision
// waits on it.

import process from 'node:process';

export const MAX_QUEUE = 512;
export const BATCH_SIZE = 128;
export const FLUSH_INTERVAL_MS = 5_000;
export const REQUEST_TIMEOUT_MS = 5_000;
export const MAX_SERIES = 256;
const MAX_OPEN_SPANS = 64;
const MAX_SPAN_EVENTS = 32;
const HEADER_NAME = /^[A-Za-z0-9!#$%&'*+.^_`|~-]{1,64}$/;
// Headers a collector may not be told to change; the exporter sets these itself.
const RESERVED_HEADERS = new Set(['content-type', 'content-length', 'host', 'connection', 'transfer-encoding']);
const STATUS = { ok: 0, refused: 0, failed: 2 }; // UNSET, UNSET, ERROR

/** `{ name: value }` from AGENT_BOT_OTLP_HEADERS; malformed pairs are skipped. */
export function otlpHeaders(env = process.env) {
  const headers = {};
  for (const pair of String(env.AGENT_BOT_OTLP_HEADERS ?? '').split(',')) {
    const at = pair.indexOf('=');
    if (at <= 0) continue;
    const name = pair.slice(0, at).trim();
    let value;
    try { value = decodeURIComponent(pair.slice(at + 1).trim()); } catch { continue; }
    if (!HEADER_NAME.test(name) || RESERVED_HEADERS.has(name.toLowerCase()) || /[\r\n\0]/.test(value)) continue;
    headers[name] = value;
  }
  return headers;
}

const text = (key, value) => ({ key, value: { stringValue: value } });
const int = (key, value) => ({ key, value: { intValue: String(value) } });
const nanos = (ms) => `${BigInt(Math.round(ms)) * 1_000_000n}`;

function attributes(event) {
  const out = [text('agent_bot.component', event.component)];
  if (event.outcome) out.push(text('agent_bot.outcome', event.outcome));
  if (event.stage) out.push(text('agent_bot.stage', event.stage));
  if (event.code) out.push(text('agent_bot.code', event.code));
  if (event.agent) out.push(text('agent_bot.agent_hash', event.agent));
  if (event.durationMs !== undefined) out.push(int('agent_bot.duration_ms', event.durationMs));
  return out;
}

/**
 * The OTLP span for a finished operation event and the stage events seen for
 * its span. Built only from allowlisted fields; `detail` is never read.
 */
export function spanFor(event, stages = []) {
  const end = Date.parse(event.at);
  const start = end - (event.durationMs ?? 0);
  const span = {
    traceId: event.traceId,
    spanId: event.spanId,
    name: event.event,
    kind: 1,
    startTimeUnixNano: nanos(start),
    endTimeUnixNano: nanos(end),
    attributes: attributes(event),
    events: stages.map((stage) => ({
      timeUnixNano: nanos(Date.parse(stage.at)),
      name: stage.event,
      attributes: [
        ...(stage.stage ? [text('agent_bot.stage', stage.stage)] : []),
        ...(stage.durationMs !== undefined ? [int('agent_bot.duration_ms', stage.durationMs)] : []),
      ],
    })),
    status: { code: STATUS[event.outcome] ?? 0 },
  };
  if (event.parentSpanId) span.parentSpanId = event.parentSpanId;
  return span;
}

export function tracesPayload(spans, { version = null, platform = process.platform } = {}) {
  const resource = [text('service.name', 'agent-bot'), text('os.type', platform)];
  if (version) resource.push(text('service.version', version));
  return {
    resourceSpans: [{
      resource: { attributes: resource },
      scopeSpans: [{ scope: { name: 'agent-bot', ...(version ? { version } : {}) }, spans }],
    }],
  };
}

/** The OTLP metrics body for the operation counters and the dropped count. */
export function metricsPayload(series, { dropped = 0, startMs, nowMs, version = null, platform = process.platform } = {}) {
  const resource = [text('service.name', 'agent-bot'), text('os.type', platform)];
  if (version) resource.push(text('service.version', version));
  const sum = (dataPoints) => ({ aggregationTemporality: 2, isMonotonic: true, dataPoints });
  const point = (attrs, value) => ({ attributes: attrs, startTimeUnixNano: nanos(startMs), timeUnixNano: nanos(nowMs), asInt: String(value) });
  return {
    resourceMetrics: [{
      resource: { attributes: resource },
      scopeMetrics: [{
        scope: { name: 'agent-bot', ...(version ? { version } : {}) },
        metrics: [
          {
            name: 'agent_bot.operations', unit: '{operation}', description: 'Finished operations by outcome and code',
            sum: sum([...series.values()].map(({ labels, count }) => point([
              text('agent_bot.component', labels.component), text('agent_bot.operation', labels.event),
              text('agent_bot.outcome', labels.outcome), ...(labels.code ? [text('agent_bot.code', labels.code)] : []),
            ], count))),
          },
          { name: 'agent_bot.export.dropped', unit: '{item}', description: 'Spans, stages and operations this exporter dropped', sum: sum([point([], dropped)]) },
        ],
      }],
    }],
  };
}

/**
 * An exporter for one OTLP/HTTP base URL. `enqueue(event)` takes a stored
 * diagnostics event (the store's sink); `flush()` sends what is queued;
 * `stop()` cancels the timer. `stats()` reports `{ sent, dropped, queued }`.
 */
export function createOtlpExporter({
  endpoint, headers = {}, version = null, platform = process.platform, fetch: send = globalThis.fetch,
  maxQueue = MAX_QUEUE, batchSize = BATCH_SIZE, intervalMs = FLUSH_INTERVAL_MS, timeoutMs = REQUEST_TIMEOUT_MS,
  setInterval: every = setInterval, clearInterval: cancel = clearInterval, now = () => Date.now(), maxSeries = MAX_SERIES,
}) {
  const base = endpoint.replace(/\/+$/, '');
  const url = `${base}/v1/traces`;
  const metricsUrl = `${base}/v1/metrics`;
  const startMs = now();
  const series = new Map(); // attribute-set key -> { labels, count }
  let metricsChanged = false;
  let metricsInFlight = null;
  let metricsSent = 0;
  let droppedReported = 0;
  const queue = [];
  const open = new Map(); // spanId -> stage events awaiting their operation
  let sent = 0;
  let dropped = 0;
  let inFlight = null;

  const count = (event) => {
    const labels = { component: event.component, event: event.event, outcome: event.outcome, ...(event.code ? { code: event.code } : {}) };
    const key = JSON.stringify(labels);
    const entry = series.get(key);
    if (entry) entry.count += 1;
    else if (series.size < maxSeries) series.set(key, { labels, count: 1 });
    else { dropped += 1; }
    metricsChanged = true;
  };
  const push = (span) => {
    if (queue.length >= maxQueue) { dropped += 1; return; }
    queue.push({ span, attempts: 0 });
  };
  const enqueue = (event) => {
    try {
      if (!event?.traceId || !event.spanId || typeof event.event !== 'string') return;
      if (event.event.endsWith('-stage')) {
        if (!open.has(event.spanId)) {
          if (open.size >= MAX_OPEN_SPANS) { open.delete(open.keys().next().value); dropped += 1; }
          open.set(event.spanId, []);
        }
        const stages = open.get(event.spanId);
        if (stages.length < MAX_SPAN_EVENTS) stages.push(event); else dropped += 1;
        return;
      }
      if (!event.outcome) return;
      count(event);
      const stages = open.get(event.spanId) ?? [];
      open.delete(event.spanId);
      push(spanFor(event, stages));
      if (queue.length >= batchSize) void flushTraces();
    } catch { dropped += 1; }
  };

  const post = async (batch) => postJson(url, tracesPayload(batch.map((item) => item.span), { version, platform }));
  const postJson = async (target, payload) => {
    try {
      const response = await send(target, {
        method: 'POST',
        headers: { ...headers, 'content-type': 'application/json' },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(timeoutMs),
        redirect: 'error',
      });
      if (response.ok) return 'sent';
      return response.status === 429 || response.status >= 500 ? 'retry' : 'drop';
    } catch {
      return 'retry';
    }
  };

  const flushMetrics = () => {
    if (metricsInFlight) return metricsInFlight;
    if (!metricsChanged && dropped === droppedReported) return Promise.resolve();
    metricsChanged = false;
    const reporting = dropped;
    const payload = metricsPayload(series, { dropped, startMs, nowMs: now(), version, platform });
    metricsInFlight = postJson(metricsUrl, payload).then((result) => {
      if (result === 'sent') { metricsSent += 1; droppedReported = reporting; }
      else if (result === 'retry') metricsChanged = true;
    }).catch(() => { metricsChanged = true; }).finally(() => { metricsInFlight = null; });
    return metricsInFlight;
  };

  const flush = () => Promise.all([flushTraces(), flushMetrics()]).then(() => {});

  const flushTraces = () => {
    if (inFlight) return inFlight;
    if (queue.length === 0) return Promise.resolve();
    const batch = queue.splice(0, batchSize);
    inFlight = post(batch).then((result) => {
      if (result === 'sent') { sent += batch.length; return; }
      const again = result === 'retry' ? batch.filter((item) => (item.attempts += 1) < 2) : [];
      dropped += batch.length - again.length;
      // Retried spans go back to the front, within the queue's bound.
      const room = Math.max(0, maxQueue - queue.length);
      dropped += Math.max(0, again.length - room);
      queue.unshift(...again.slice(0, room));
    }).catch(() => { dropped += batch.length; }).finally(() => { inFlight = null; });
    return inFlight;
  };

  const timer = every(() => { void flush(); }, intervalMs);
  timer?.unref?.();
  return {
    enqueue,
    flush,
    stop: () => cancel(timer),
    stats: () => ({ sent, dropped, queued: queue.length, series: series.size, metricsSent }),
  };
}
