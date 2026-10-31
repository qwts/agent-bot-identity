// agent-bot private web client. Vanilla JS, no build step, no dependencies.
// The daemon is the only authority: this page holds no tokens (the session is
// an HttpOnly cookie it cannot read), keeps no durable state, and rebuilds
// every projection from the daemon's APIs. All rendering goes through
// textContent — daemon data is never interpreted as markup.

const CSRF = { 'x-agent-bot-ui': '1' };

const state = {
  me: null,
  souls: [],
  soul: null, // selected soul id
  session: null, // active conversation session id
  invocations: [], // conversation invocations (public records)
  jobs: [],
  proposals: [],
  openJob: null, // invocation id expanded in the Jobs view
  cursors: new Map(), // invocationId -> last seen event seq (reconnect cursor)
  events: new Map(), // invocationId -> rendered events
  view: 'population',
};

const $ = (id) => document.getElementById(id);

function el(tag, props = {}, children = []) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (key === 'class') node.className = value;
    else if (key === 'text') node.textContent = value;
    else node.setAttribute(key, value);
  }
  for (const child of children) node.append(child);
  return node;
}

function setBanner(message) {
  const banner = $('banner');
  banner.hidden = !message;
  if (message) banner.textContent = message;
}

async function api(pathname, { method = 'GET', body } = {}) {
  let response;
  try {
    response = await fetch(pathname, {
      method,
      headers: { ...CSRF, ...(body ? { 'content-type': 'application/json' } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
  } catch {
    setBanner('daemon unreachable — showing the offline shell; nothing here is authoritative');
    throw new Error('daemon unreachable');
  }
  setBanner(null);
  if (response.status === 401) {
    showPairingRequired();
    throw new Error('no active web session');
  }
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error ?? `HTTP ${response.status}`);
  return payload;
}

function showPairingRequired() {
  $('nav').hidden = true;
  $('whoami').textContent = '';
  for (const section of document.querySelectorAll('main section')) section.hidden = true;
  $('view-pairing').hidden = false;
}

function showView(view) {
  state.view = view;
  for (const section of document.querySelectorAll('main section')) section.hidden = true;
  $(`view-${view}`).hidden = false;
  for (const button of document.querySelectorAll('#nav button')) {
    button.classList.toggle('active', button.dataset.view === view);
  }
  refresh().catch(() => {});
}

function statusCell(status) {
  return el('td', { class: `status-${status}`, text: status });
}

// --- Population -------------------------------------------------------------

async function loadPopulation() {
  const { souls } = await api('/ui/api/population');
  state.souls = souls;
  const rows = $('population-rows');
  rows.replaceChildren(...souls.map((soul) => el('tr', {}, [
    el('td', { class: 'mono', text: soul.id }),
    el('td', { text: soul.appSlug }),
    el('td', { class: 'mono', text: soul.parentId ?? '—' }),
    statusCell(soul.status),
    el('td', { text: soul.lastSeen }),
    el('td', {}, [button('Converse', 'action primary', () => selectSoul(soul.id))]),
  ])));
}

function button(label, className, onClick) {
  const node = el('button', { class: className, type: 'button', text: label });
  node.addEventListener('click', onClick);
  return node;
}

// --- Conversation -----------------------------------------------------------

async function selectSoul(agentId) {
  state.soul = agentId;
  state.session = null;
  // Continue the most recent web session with this soul, or start a new one.
  const { sessions } = await api(`/ui/api/sessions?agentId=${encodeURIComponent(agentId)}`);
  const latest = sessions.at(-1) ?? null;
  const opened = await api('/ui/api/sessions', {
    method: 'POST',
    body: { agentId, sessionId: latest ? latest.sessionId : null },
  });
  state.session = opened.session.sessionId;
  showView('conversation');
}

async function loadConversation() {
  const soulLine = $('conversation-soul');
  const form = $('message-form');
  if (!state.session) {
    soulLine.textContent = 'Select a soul from Population first.';
    form.hidden = true;
    return;
  }
  soulLine.textContent = `${state.soul} — session ${state.session}`;
  form.hidden = false;
  const { invocations } = await api(`/ui/api/invocations?sessionId=${encodeURIComponent(state.session)}`);
  state.invocations = invocations;
  const list = $('conversation-invocations');
  list.replaceChildren(...invocations.map((invocation) => el('div', { class: 'mono' }, [
    el('span', { class: `status-${invocation.status}`, text: `[${invocation.status}] ` }),
    el('span', { text: `${invocation.invocationId} (${invocation.createdAt})` }),
  ])));
  const latest = invocations.at(-1);
  if (latest) await pollEvents(latest.invocationId, $('conversation-events'));
}

// One idempotency key per logical submission. The key is minted when the
// user initiates a send and is reused verbatim on every retry of that same
// submission (same session, same text), so a resend after a network failure
// can never start duplicate work; only a genuinely new submission mints a
// new key. Kept as a pure function so tests can exercise the policy.
function nextSubmission(pending, sessionId, message, mintKey) {
  if (pending && pending.sessionId === sessionId && pending.message === message) return pending;
  return { sessionId, message, key: mintKey() };
}

let pendingSubmission = null; // survives failed sends until one succeeds

async function sendMessage(event) {
  event.preventDefault();
  const input = $('message-input');
  const message = input.value.trim();
  if (!message || !state.session) return;
  pendingSubmission = nextSubmission(
    pendingSubmission,
    state.session,
    message,
    () => crypto.randomUUID(),
  );
  await api(`/ui/api/sessions/${encodeURIComponent(state.session)}/messages`, {
    method: 'POST',
    body: { message, idempotencyKey: pendingSubmission.key },
  });
  pendingSubmission = null; // consumed only by a successful submission
  input.value = '';
  await refresh();
}

// --- Events (resumable projection) -------------------------------------------

// Poll with an afterSeq cursor. A page refresh resets the in-memory cursor to
// zero and replays the daemon's durable log — position is never lost because
// the daemon, not the browser, owns the event history.
async function pollEvents(invocationId, container) {
  const after = state.cursors.get(invocationId) ?? 0;
  const { events } = await api(
    `/ui/api/invocations/${encodeURIComponent(invocationId)}/events?after=${after}`,
  );
  if (after === 0) {
    state.events.set(invocationId, []);
    container.replaceChildren();
  }
  if (events.length === 0) return;
  state.cursors.set(invocationId, events.at(-1).seq);
  const known = state.events.get(invocationId) ?? [];
  for (const entry of events) {
    known.push(entry);
    container.append(el('div', {
      text: `#${entry.seq} ${entry.at} ${entry.type} ${JSON.stringify(entry.data)}`,
    }));
  }
  state.events.set(invocationId, known);
  container.scrollTop = container.scrollHeight;
}

// --- Server (machine view, #1295) ------------------------------------------

async function loadServer() {
  const data = await api('/ui/api/machine/server');
  const rows = $('server-rows');
  rows.textContent = '';
  const kv = [
    ['Server mode', data.server_mode ? 'on' : 'off'],
    ['Base', data.base ?? '-'],
    ['Enrolled', data.enrolled ? 'yes' : 'no'],
    ['Device', data.device_name ?? data.device_id ?? '-'],
    ['Approved identities', (data.approved_harnesses ?? []).join(', ') || '-'],
  ];
  for (const [k, v] of kv) {
    const tr = el('tr');
    tr.append(el('th', { text: k }), el('td', { text: v }));
    rows.append(tr);
  }
  const outcomes = $('server-mint-outcomes');
  if (outcomes) {
    outcomes.textContent = '';
    const map = data.last_mint_outcomes ?? {};
    const names = [...new Set([...(data.approved_harnesses ?? []), ...Object.keys(map)])];
    for (const identity of names) {
      const entry = map[identity] ?? null;
      const tr = el('tr');
      const detail = entry
        ? [entry.reason, entry.issuance_id, entry.reconciled ? 'reconciled' : null, entry.replayed ? 'replayed' : null].filter(Boolean).join(' · ')
        : '';
      tr.append(
        el('td', { class: 'mono', text: identity }),
        statusCell(entry?.state ?? 'none'),
        el('td', { class: 'mono', text: entry?.repo ?? '-' }),
        el('td', { text: entry?.updated_at ?? '-' }),
        el('td', { text: detail }),
      );
      outcomes.append(tr);
    }
  }
  const readiness = data.readiness ?? {};
  $('server-readiness-summary').textContent = readiness.error
    ? `readiness unavailable (${readiness.error})`
    : (readiness.ready === true ? 'ready' : (readiness.first_actionable_failure?.action ?? readiness.first_actionable_failure?.check ?? 'not ready'));
  const checks = $('server-checks');
  checks.textContent = '';
  for (const check of readiness.machine?.checks ?? []) {
    const tr = el('tr');
    tr.append(el('td', { text: check.id ?? check.name ?? '' }),
      statusCell(check.status ?? (check.ok === false ? 'fail' : 'ok')),
      el('td', { text: check.action ?? '' }));
    checks.append(tr);
  }
}

// --- Agent machine (read-only machine view, #1295) -------------------------

async function loadAgentMachine() {
  const data = await api('/ui/api/machine/agent-machine');
  const pairing = data.pairing ?? {};
  const rows = $('am-pairing');
  rows.textContent = '';
  for (const [k, v] of [
    ['Client key', pairing.client_key ? 'present' : 'absent'],
    ['Pinned daemon.pub', pairing.pin_fingerprint ?? '-'],
    ['agent-daemon peer', (pairing.agent_daemon_peer ?? []).join(', ') || 'none'],
    ['Terminal paired', pairing.terminal_paired ? 'yes' : 'no'],
  ]) {
    const tr = el('tr'); tr.append(el('th', { text: k }), el('td', { text: v })); rows.append(tr);
  }
  $('am-pair-command').hidden = !(pairing.pin_fingerprint === null);
  $('am-pair-command').textContent = pairing.pin_fingerprint === null ? `pair first: ${pairing.pair_command}` : '';
  for (const [id, section] of [['status', data.status], ['receipts', data.receipts]]) {
    const errEl = $(`am-${id}-error`);
    errEl.hidden = !section.error;
    errEl.textContent = section.error ? `${section.message ?? ''} [${section.error}]` : '';
  }
  const status = $('am-status');
  status.textContent = '';
  if (!data.status.error) {
    for (const [k, v] of [['ok', data.status.ok], ['state', data.status.state], ['diagnostic', data.status.diagnostic], ['message', data.status.message]]) {
      const tr = el('tr'); tr.append(el('th', { text: k }), el('td', { text: String(v ?? '-') })); status.append(tr);
    }
  }
  const receipts = $('am-receipts');
  receipts.textContent = '';
  if (!data.receipts.error) {
    for (const row of data.receipts.records ?? []) {
      const tr = el('tr');
      for (const f of ['plan', 'command', 'outcome', 'soul', 'harness', 'session_id', 'at']) {
        tr.append(el('td', { text: String(row[f] ?? '-') }));
      }
      receipts.append(tr);
    }
  }
}

// --- Agent machine writes: plan now, apply/update via proposals (#1295) ----

function wireAgentMachineForms() {
  $('am-plan-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    $('am-plan-result').textContent = 'planning…';
    try {
      const body = { name: $('am-plan-name').value.trim() };
      for (const [id, key] of [['am-plan-option', 'option'], ['am-plan-target', 'target']]) {
        const v = $(id).value.trim(); if (v) body[key] = v;
      }
      const res = await api('/ui/api/machine/agent-machine/plan', { method: 'POST', body });
      $('am-plan-result').textContent = res.ok ? `plan ${res.plan_id ?? res.state}` : `${res.diagnostic ?? res.message ?? res.state}`;
      state.amPlanId = res.ok ? (res.plan_id ?? null) : null;
      $('am-plan-actions').hidden = !res.ok;
    } catch (error) {
      $('am-plan-result').textContent = error.message;
      $('am-plan-actions').hidden = true;
    }
  });
  const propose = async (verb, extra = {}) => {
    try {
      const res = await api('/ui/api/machine/agent-machine/proposals', { method: 'POST', body: { verb, ...extra } });
      const id = res.proposal.proposalId;
      $('am-proposal-status').textContent = `proposal ${id} — approve it in the Approvals tab`;
      showView('approvals');
      state.amProposalId = id;
    } catch (error) {
      $('am-proposal-status').textContent = error.message;
    }
  };
  $('am-apply').addEventListener('click', () => propose('apply', { plan_id: state.amPlanId }));
  $('am-update').addEventListener('click', () => propose('update', { name: $('am-plan-name').value.trim() }));
  $('am-pair').addEventListener('click', () => propose('pair'));
  $('am-repin').addEventListener('click', () => propose('pair', { repin: true }));
  $('am-unpair').addEventListener('click', () => propose('unpair'));
}

// --- Souls (read-only, #1295) ------------------------------------------------

async function loadSouls() {
  const { souls } = await api('/ui/api/souls');
  const list = $('souls-list');
  list.textContent = '';
  // A specialist whose parent isn't in the returned collection renders as
  // a root labelled with its (unseen) parent id.
  const visible = new Set(souls.map((s) => s.id));
  const roots = souls.filter((o) => !o.parentId || !visible.has(o.parentId));
  const render = (soul, nested, orphanOf = null) => {
    const box = el('div', { class: nested ? 'soul soul-nested' : 'soul' });
    box.append(el('h3', { text: `${soul.role === 'lead' ? '● ' : '○ '}${soul.id}` }),
      el('p', { class: 'hint', text: `${soul.appSlug ?? '-'} · ${soul.status ?? '-'} · ${soul.role}${orphanOf ? ` · specialist of ${orphanOf}` : ''}` }));
    const st = el('table');
    const sh = el('tr');
    for (const h of ['session', 'harness', 'status', 'started', 'last seen', 'ended']) sh.append(el('th', { text: h }));
    st.append(sh);
    const tb = el('tbody');
    for (const s of soul.sessions ?? []) {
      const tr = el('tr');
      for (const v of [s.session_id, s.harness, s.status, s.started_at, s.last_seen, s.ended_at]) tr.append(el('td', { text: String(v ?? '-') }));
      tb.append(tr);
    }
    st.append(tb); box.append(st);
    const bt = el('table');
    const bh = el('tr');
    for (const h of ['harness', 'session', 'worktree', 'bound', 'last used']) bh.append(el('th', { text: h }));
    bt.append(bh);
    const bb = el('tbody');
    for (const b of soul.bindings ?? []) {
      const tr = el('tr');
      for (const v of [b.harness, b.sessionId, b.worktree, b.boundAt, b.lastUsedAt]) tr.append(el('td', { text: String(v ?? '-') }));
      bb.append(tr);
    }
    bt.append(bb); box.append(bt);
    // Write controls (#1295): pending revisions with Approve/Reject, a
    // cold-wake checkbox, and Remove — each creates a proposal.
    const revBox = el('div', { class: 'soul-revisions' });
    api(`/ui/api/souls/${soul.id}/revisions`).then(({ proposals }) => {
      for (const p of proposals ?? []) {
        const row = el('p', { class: 'revision-row' });
        row.append(el('span', { text: `pending revision ${p.proposalId} ` }));
        row.append(el('button', { type: 'button', text: 'Approve',
          'data-soul-action': 'revision.approve', 'data-agent': soul.id, 'data-revision': p.proposalId }));
        row.append(el('button', { type: 'button', text: 'Reject',
          'data-soul-action': 'revision.reject', 'data-agent': soul.id, 'data-revision': p.proposalId }));
        revBox.append(row);
      }
    }).catch(() => {});
    const cw = el('input', { id: `cw-${soul.id}`, type: 'checkbox' });
    const controls = el('p', { class: 'soul-controls' });
    controls.append(el('label', { text: ' cold wake ' }));
    controls.querySelector('label').append(cw);
    controls.append(el('button', { type: 'button', text: 'Propose cold-wake change',
      'data-soul-action': 'cold-wake', 'data-agent': soul.id, 'data-cw': `cw-${soul.id}` }));
    controls.append(el('button', { type: 'button', text: 'Remove…',
      'data-soul-action': 'remove', 'data-agent': soul.id }));
    box.append(revBox, controls);
    list.append(box);
    for (const child of souls.filter((o) => o.parentId === soul.id)) render(child, true);
  };
  for (const soul of roots) render(soul, false, soul.parentId && !visible.has(soul.parentId) ? soul.parentId : null);
}

// --- Souls write controls (#1295) — one delegated listener ---------------

function wireSoulsActions() {
  $('souls-list').addEventListener('click', async (event) => {
    const btn = event.target.closest('button[data-soul-action]');
    if (!btn) return;
    const agentId = btn.dataset.agent;
    const action = btn.dataset.soulAction;
    try {
      if (action === 'cold-wake') {
        const enabled = $(btn.dataset.cw)?.checked === true;
        await api(`/ui/api/souls/${agentId}/proposals`, { method: 'POST', body: { verb: 'cold-wake', enabled } });
      } else if (action === 'remove') {
        if (!window.confirm(`Propose removing ${agentId}? The proposal shows the archive plan; the owner approves in Approvals.`)) return;
        await api(`/ui/api/souls/${agentId}/proposals`, { method: 'POST', body: { verb: 'remove' } });
      } else {
        await api(`/ui/api/souls/${agentId}/proposals`, { method: 'POST',
          body: { verb: action, revision_id: btn.dataset.revision } });
      }
      showView('approvals');
    } catch (error) { setBanner(error.message); }
  });
}

// --- Catalog (verified relay to agent-machine, #1295) -----------------------

async function loadCatalog() {
  const res = await api('/ui/api/machine/catalog');
  if (res.error) { $('catalog-meta').textContent = `catalog: ${res.error} — ${res.message ?? ''}`; return; }
  $('catalog-meta').textContent = `key ${res.key_id} · version ${res.version ?? '-'} · issued ${res.issued_at ?? '-'} · floor ${res.floor_min_version}`;
  $('catalog-digest').textContent = res.delivered ? `last delivery: ${res.delivered.outcome} at ${res.delivered.at}` : '';
  const tb = $('catalog-items').querySelector('tbody'); tb.textContent = '';
  for (const it of res.items ?? []) {
    const tr = el('tr');
    tr.append(el('td', { text: String(it.name ?? '-') }), el('td', { text: String(it.provider ?? '-') }),
      el('td', { text: String(it.version ?? '-') }), el('td', { text: String(it.installed ?? '-') }));
    const btn = el('button', { text: 'Update', type: 'button' });
    btn.addEventListener('click', async () => {
      try {
        const r = await api('/ui/api/machine/agent-machine/proposals', { method: 'POST', body: { verb: 'update', name: it.name } });
        $('catalog-status').textContent = `proposal ${r.proposal.proposalId} — approve in Approvals`;
        showView('approvals');
      } catch (e) { $('catalog-status').textContent = e.message; }
    });
    tr.append(el('td')).lastChild.append(btn);
    tb.append(tr);
  }
}

function wireCatalog() {
  $('catalog-deliver').addEventListener('click', async () => {
    $('catalog-status').textContent = 'delivering…';
    try {
      const res = await api('/ui/api/machine/catalog/deliver', { method: 'POST', body: {} });
      $('catalog-status').textContent = res.ok ? `delivered: ${res.state}` : `refused: ${res.diagnostic ?? res.message}`;
      await loadCatalog();
    } catch (e) { $('catalog-status').textContent = e.message; }
  });
}

// --- Settings (proposed writes through immutable proposals, #1295) ----------

async function loadSettings() {
  const res = await api('/ui/api/machine/settings');
  $('settings-path').textContent = `${res.exists ? 'Config' : 'No config yet'}: ${res.path}`;
  $('settings-error').textContent = res.error ? `config invalid: ${res.error}` : '';
  const cfg = res.config;
  state.settingsConfig = cfg;
  const editable = $('settings-editable');
  editable.textContent = '';
  const pref = el('select', { id: 'set-daemonPreference' });
  for (const v of ['off', 'prefer', 'required']) {
    const opt = el('option', { text: v, attributes: { value: v } });
    if ((cfg.settings.daemonPreference?.value ?? 'off') === v) opt.selected = true;
    pref.append(opt);
  }
  const adapter = el('select', { id: 'set-skillSearchAdapter' });
  for (const v of ['local-text']) {
    const opt = el('option', { text: v, attributes: { value: v } });
    if ((cfg.settings.skillSearchAdapter?.value ?? 'local-text') === v) opt.selected = true;
    adapter.append(opt);
  }
  editable.append(el('label', { text: 'daemonPreference ' }), pref, el('br'),
    el('label', { text: 'skillSearchAdapter ' }), adapter);
  for (const [gate, row] of Object.entries(cfg.features)) {
    const box = el('input', { id: `set-features.${gate}`, type: 'checkbox' });
    box.checked = !!row.value;
    editable.append(el('br'), el('label', { text: `features.${gate} ` }), box);
  }
  const rows = [
    ['prefix', cfg.prefix], ['apps', JSON.stringify(cfg.apps)], ['owner', cfg.owner],
    ['scope', JSON.stringify(cfg.scope)],
    ...Object.entries(cfg.settings).map(([k, r]) => [`settings.${k}`, `${JSON.stringify(r.value)}${r.editable ? ' (editable)' : ''}`]),
  ];
  const table = $('settings-table'); table.textContent = '';
  const tb = el('tbody');
  for (const [k, v] of rows) {
    const tr = el('tr');
    tr.append(el('td', { text: String(k) }), el('td', { text: String(v ?? '-') }));
    tb.append(tr);
  }
  table.append(tb);
}

function wireSettingsForm() {
  $('settings-propose').addEventListener('click', async () => {
    const changes = {};
    const cur = state.settingsConfig ?? { settings: {}, features: {} };
    // Selecting the default when a value is set proposes an unset (null).
    const pref = $('set-daemonPreference').value;
    const curPref = cur.settings?.daemonPreference?.value ?? 'off';
    if (pref !== curPref) changes['settings.daemonPreference'] = pref === 'off' ? null : pref;
    const adapter = $('set-skillSearchAdapter').value;
    const curAdapter = cur.settings?.skillSearchAdapter?.value ?? 'local-text';
    if (adapter !== curAdapter) changes['settings.skillSearchAdapter'] = adapter === 'local-text' ? null : adapter;
    for (const input of document.querySelectorAll('#settings-editable input[type=checkbox]')) {
      const gate = input.id.slice('set-'.length);
      const curGate = cur.features?.[gate.slice('features.'.length)]?.value ?? false;
      if (input.checked !== !!curGate) changes[gate] = input.checked;
    }
    if (Object.keys(changes).length === 0) { $('settings-status').textContent = 'nothing changed'; return; }
    try {
      const res = await api('/ui/api/machine/settings/proposals', { method: 'POST', body: { changes } });
      $('settings-status').textContent = `proposal ${res.proposal.proposalId} — approve it in the Approvals tab`;
      showView('approvals');
    } catch (error) { $('settings-status').textContent = error.message; }
  });
}

// --- Jobs ---------------------------------------------------------------------

// --- Server actions (reconcile directly; re-enroll via proposal, #1295) ----

function wireServerActions() {
  $('server-reconcile').addEventListener('click', async () => {
    $('server-action-status').textContent = 'reconciling…';
    try {
      const res = await api('/ui/api/machine/server/reconcile', { method: 'POST', body: {} });
      $('server-action-status').textContent = res.reconciled === 0
        ? 'no pending credential operations'
        : `reconciled ${res.reconciled}: ` + res.results.map((r) => `${r.operation_id}=${r.state}`).join(', ');
    } catch (error) { $('server-action-status').textContent = error.message; }
  });
  $('server-enroll').addEventListener('click', async () => {
    try {
      const res = await api('/ui/api/machine/server/enroll', { method: 'POST', body: {} });
      $('server-action-status').textContent = `proposal ${res.proposal.proposalId} — approve it in the Approvals tab`;
      state.enrollProposalId = res.proposal.proposalId;
      showView('approvals');
    } catch (error) { $('server-action-status').textContent = error.message; }
  });
}

async function pollEnrollOutcome() {
  if (!state.enrollProposalId) return;
  try {
    const out = await api(`/ui/api/machine/agent-machine/proposals/${state.enrollProposalId}`);
    if (out.status === 'pending-approval') {
      $('server-action-status').textContent =
        `approve this device at ${out.verification_uri} — code ${out.user_code} (key ${out.thumbprint})`;
    } else if (out.status !== 'open') {
      $('server-action-status').textContent = `enroll ${out.status}${out.error ? `: ${out.error}` : ''}`;
      state.enrollProposalId = null;
    }
  } catch { /* next poll */ }
}

async function loadJobs() {
  const { invocations } = await api('/ui/api/invocations');
  state.jobs = invocations;
  const rows = $('jobs-rows');
  rows.replaceChildren(...invocations.map((invocation) => {
    const actions = el('td');
    actions.append(button('Events', 'action', () => openJob(invocation.invocationId)));
    if (['queued', 'running', 'waiting-approval'].includes(invocation.status)) {
      actions.append(' ');
      actions.append(button('Cancel', 'action danger', () => cancelJob(invocation.invocationId)));
    }
    return el('tr', {}, [
      el('td', { class: 'mono', text: invocation.invocationId }),
      el('td', { class: 'mono', text: invocation.agentId }),
      statusCell(invocation.status),
      el('td', { text: invocation.updatedAt }),
      actions,
    ]);
  }));
  if (state.openJob) await loadJobDetail();
}

async function openJob(invocationId) {
  state.openJob = invocationId;
  state.cursors.delete(invocationId);
  await loadJobDetail();
}

async function loadJobDetail() {
  const invocationId = state.openJob;
  $('job-detail').hidden = false;
  $('job-detail-title').textContent = invocationId;
  await pollEvents(invocationId, $('job-detail-events'));
  const { artifacts } = await api(`/ui/api/invocations/${encodeURIComponent(invocationId)}/artifacts`);
  const list = $('job-detail-artifacts');
  list.replaceChildren(...artifacts.map((artifact) => el('li', {}, [
    el('a', {
      href: `/ui/api/invocations/${encodeURIComponent(invocationId)}/artifacts/${encodeURIComponent(artifact.name)}`,
      download: artifact.name,
      text: artifact.name,
    }),
    el('span', { class: 'hint', text: ` ${artifact.bytes} bytes, sha256 ${artifact.sha256.slice(0, 12)}…` }),
  ])));
  if (artifacts.length === 0) list.replaceChildren(el('li', { class: 'hint', text: 'none' }));
}

async function cancelJob(invocationId) {
  await api(`/ui/api/invocations/${encodeURIComponent(invocationId)}/cancel`, { method: 'POST', body: {} });
  await refresh();
}


// --- Approvals -----------------------------------------------------------------

async function loadApprovals() {
  const { proposals } = await api('/ui/api/approvals');
  state.proposals = proposals;
  const badge = $('approvals-badge');
  badge.hidden = proposals.length === 0;
  badge.textContent = String(proposals.length);
  const list = $('approvals-list');
  const canApprove = state.me?.operations.includes('approve');
  list.replaceChildren(...proposals.map((proposal) => {
    const card = el('div', { class: 'proposal' }, [
      el('div', { text: proposal.summary }),
      // Every digest-covered field is rendered — the owner approves the
      // exact operation, not just the prose summary.
      el('div', { class: 'mono hint', text: Object.entries(proposal.operation ?? {})
        .map(([k, v]) => `${k}: ${typeof v === 'object' ? JSON.stringify(v) : v}`).join('\n') }),
      el('div', { class: 'mono hint', text: `${proposal.invocationId} · ${proposal.agentId}` }),
      el('div', { class: 'mono digest', text: `sha256 ${proposal.operationDigest}` }),
      el('div', { class: 'hint', text: `expires ${proposal.expiresAt}` }),
    ]);
    const buttons = el('div', { class: 'buttons' });
    if (canApprove) {
      // The decision echoes the exact digest rendered above; the daemon
      // refuses anything that does not match the immutable proposal.
      buttons.append(
        button('Approve', 'action primary', () => decide(proposal, 'approve')),
        button('Deny', 'action danger', () => decide(proposal, 'deny')),
      );
    } else {
      buttons.append(el('span', { class: 'hint', text: 'this principal cannot approve' }));
    }
    card.append(buttons);
    return card;
  }));
  if (proposals.length === 0) {
    list.replaceChildren(el('p', { class: 'hint', text: 'No open proposals.' }));
  }
}

async function decide(proposal, decision) {
  await api(`/ui/api/approvals/${encodeURIComponent(proposal.proposalId)}/decision`, {
    method: 'POST',
    body: { decision, digest: proposal.operationDigest },
  });
  await refresh();
}

// --- Boot / refresh loop ----------------------------------------------------------

async function refresh() {
  if (!state.me) return;
  if (state.view === 'population') await loadPopulation();
  if (state.view === 'agent-machine') await loadAgentMachine();
  if (state.view === 'catalog') await loadCatalog();
  if (state.view === 'souls') await loadSouls();
  if (state.view === 'conversation') await loadConversation();
  if (state.view === 'settings') await loadSettings();
  if (state.view === 'server') { await loadServer(); await pollEnrollOutcome(); }
  if (state.view === 'jobs') await loadJobs();
  await loadApprovals();
}

async function exchangePairingCode(code) {
  const response = await fetch('/ui/session', {
    method: 'POST',
    headers: { ...CSRF, 'content-type': 'application/json' },
    body: JSON.stringify({ code }),
  });
  return response.ok;
}

async function boot() {
  $('message-form').addEventListener('submit', (event) => {
    sendMessage(event).catch((error) => setBanner(error.message));
  });
  for (const navButton of document.querySelectorAll('#nav button')) {
    navButton.addEventListener('click', () => showView(navButton.dataset.view));
  }
  wireAgentMachineForms();
  wireSettingsForm();
  wireServerActions();
  wireCatalog();
  wireSoulsActions();

  // A one-time pairing code arrives in the URL fragment (never sent to any
  // server in a request line) and is scrubbed from the address bar and
  // history before it is exchanged.
  const code = window.location.hash.slice(1);
  if (code) {
    history.replaceState(null, '', window.location.pathname);
    await exchangePairingCode(code).catch(() => false);
  }

  try {
    const { principal } = await api('/ui/api/me');
    state.me = principal;
  } catch {
    return; // api() already routed to the pairing screen or offline banner
  }
  $('nav').hidden = false;
  $('whoami').textContent = `${state.me.label} · ${state.me.operations.join(', ') || 'no operations'}`;
  showView('population');

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('/ui/sw.js').catch(() => {});
  }

  setInterval(() => { refresh().catch(() => {}); }, 2500);
}

boot();
