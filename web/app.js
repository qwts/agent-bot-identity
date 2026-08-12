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

async function sendMessage(event) {
  event.preventDefault();
  const input = $('message-input');
  const message = input.value.trim();
  if (!message || !state.session) return;
  await api(`/ui/api/sessions/${encodeURIComponent(state.session)}/messages`, {
    method: 'POST',
    // Client-generated idempotency key: a retry of this exact submission can
    // never start duplicate work.
    body: { message, idempotencyKey: crypto.randomUUID() },
  });
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

// --- Jobs ---------------------------------------------------------------------

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
  if (state.view === 'conversation') await loadConversation();
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
