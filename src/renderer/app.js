// Motion desktop renderer — gate (login → key), chat pane, context DB pane.
/* global motion */
const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const STAGE_DOT = { new: '#8a8f98', engaged: '#4c9aff', qualified: '#8b93e6', active: '#f2c94c', won: '#4cb782', lost: '#eb5757', dormant: '#9a9da6' };
const dot = (stage) => `<span class="dot" style="background:${STAGE_DOT[stage] || '#8a8f98'}"></span>`;
const rel = (iso) => {
  if (!iso) return '';
  const t = new Date(String(iso).includes('T') ? iso : String(iso).replace(' ', 'T') + 'Z').getTime();
  if (isNaN(t)) return '';
  const s = Math.max(0, (Date.now() - t) / 1000);
  if (s < 3600) return Math.max(1, Math.floor(s / 60)) + 'm';
  if (s < 86400) return Math.floor(s / 3600) + 'h';
  return Math.floor(s / 86400) + 'd';
};

let cfg = {};

// ================= gate =================
async function boot() {
  cfg = await motion.cfg();
  if (!cfg.loggedIn || !cfg.hasKey) { renderGate(); return; }
  enterApp();
}

function renderGate() {
  $('#gate').hidden = false; $('#app').hidden = true;
  const steps = $('#gate-steps');
  const s1done = cfg.loggedIn;
  steps.innerHTML = `
    <div class="step ${s1done ? 'done' : ''}">
      <span class="n">${s1done ? '✓' : '1'}</span>
      <div class="t"><b>Sign in to Motion</b><span>${s1done ? esc(cfg.email || 'connected') : 'Google sign-in, opens in your browser'}</span></div>
      ${s1done ? '' : '<button id="g-login" class="primary">Sign in</button>'}
    </div>
    <div class="step ${s1done ? '' : 'dim'}">
      <span class="n">2</span>
      <div class="t"><b>Power the agent</b><span>Paste an Anthropic API key (platform credits coming soon)</span>
        ${s1done ? '<input id="g-key" type="password" placeholder="sk-ant-…">' : ''}
      </div>
      ${s1done ? '<button id="g-key-save" class="primary">Save</button>' : ''}
    </div>
    <div class="gate-err" id="g-err"></div>`;
  $('#g-login')?.addEventListener('click', async (e) => {
    e.target.disabled = true; e.target.textContent = 'Waiting…';
    try { await motion.login(); cfg = await motion.cfg(); renderGate(); }
    catch (err) { $('#g-err').textContent = String(err.message || err); e.target.disabled = false; e.target.textContent = 'Sign in'; }
  });
  $('#g-key-save')?.addEventListener('click', async () => {
    const k = $('#g-key').value.trim();
    if (!k.startsWith('sk-')) { $('#g-err').textContent = 'That does not look like an Anthropic API key.'; return; }
    await motion.setKey(k); cfg = await motion.cfg();
    if (cfg.loggedIn && cfg.hasKey) enterApp(); else renderGate();
  });
}

// ================= app =================
async function enterApp() {
  $('#gate').hidden = true; $('#app').hidden = false;
  const eng = await motion.detectEngines();
  $('#engine-badge').textContent = (cfg.model || 'claude-opus-5').replace('claude-', '') + ' · BYOK' + (eng.claudeCode ? ' · CC available' : '');
  $('#engine-badge').classList.add('ok');
  loadContacts();
}

// ---------------- chat ----------------
let botBubble = null;   // current streaming bubble
let thinking = null;

function threadEl() { return $('#thread'); }
function scrollThread() { const t = threadEl(); t.scrollTop = t.scrollHeight; }
function clearHello() { $('.hello')?.remove(); }

function addUserMsg(text) {
  clearHello();
  threadEl().insertAdjacentHTML('beforeend', `<div class="msg user"><div class="bubble">${esc(text)}</div></div>`);
  scrollThread();
}
function ensureBotBubble() {
  if (botBubble) return botBubble;
  clearHello();
  const wrap = document.createElement('div');
  wrap.className = 'msg bot';
  wrap.innerHTML = '<div class="bubble"></div>';
  threadEl().appendChild(wrap);
  botBubble = wrap.querySelector('.bubble');
  return botBubble;
}
function addActionCard(name, input) {
  clearHello();
  const nice = String(name || '').replace(/^mcp__motion__/, '');
  const detail = input ? esc(JSON.stringify(input)).slice(0, 220) : '';
  threadEl().insertAdjacentHTML('beforeend',
    `<div class="action-card"><span class="ic">⚙</span><div><span class="nm">${esc(nice)}</span>${detail ? `<div class="detail">${detail}</div>` : ''}</div></div>`);
  botBubble = null; // next text starts a fresh bubble under the card
  scrollThread();
}
function addResultCard(text) {
  const short = esc(String(text || '').trim()).slice(0, 400);
  if (!short) return;
  threadEl().insertAdjacentHTML('beforeend',
    `<div class="action-card result"><span class="ic">✓</span><div class="detail">${short}</div></div>`);
  scrollThread();
}
function setThinking(on) {
  if (on && !thinking) {
    thinking = document.createElement('div');
    thinking.className = 'msg bot';
    thinking.innerHTML = '<div class="bubble"><span class="typing"><i></i><i></i><i></i></span></div>';
    threadEl().appendChild(thinking); scrollThread();
  } else if (!on && thinking) { thinking.remove(); thinking = null; }
}

motion.onAgent((ev) => {
  if (ev.kind === 'text') {
    setThinking(false);
    ensureBotBubble().textContent += ev.text;
    scrollThread();
  } else if (ev.kind === 'tool_use') {
    setThinking(false);
    addActionCard(ev.name, ev.input);
    setThinking(true);
  } else if (ev.kind === 'tool_result') {
    setThinking(false);
    addResultCard(ev.text);
    setThinking(true);
  } else if (ev.kind === 'done') {
    setThinking(false);
    botBubble = null;
    $('#send').disabled = false;
    if (ev.ok) {
      const u = ev.usage || {};
      const bits = [];
      if (u.input_tokens != null) bits.push(`${u.input_tokens}▸${u.output_tokens} tok`);
      if (ev.cost != null) bits.push(`<span class="cost">$${Number(ev.cost).toFixed(4)}</span>`);
      $('#statusline').innerHTML = bits.join(' · ');
    } else {
      $('#statusline').innerHTML = `<span style="color:var(--red)">${esc(ev.error || 'agent error')}</span>`;
    }
    loadContacts(true); // refresh DB pane — the agent may have changed data
    if (currentTab === 'queue') loadQueue();
  }
});

function sendPrompt() {
  const box = $('#input');
  const text = box.value.trim();
  if (!text) return;
  box.value = ''; box.style.height = 'auto';
  addUserMsg(text);
  setThinking(true);
  $('#send').disabled = true;
  $('#statusline').textContent = '';
  motion.send(text);
}
$('#send').addEventListener('click', sendPrompt);
$('#input').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendPrompt(); }
});
$('#input').addEventListener('input', function () { this.style.height = 'auto'; this.style.height = Math.min(this.scrollHeight, 140) + 'px'; });
$('#new-chat').addEventListener('click', async () => {
  await motion.resetChat();
  threadEl().innerHTML = '<div class="hello"><div class="hello-logo"></div><h2>New conversation.</h2><p>Context cleared — your Rolodex data is unchanged.</p></div>';
  botBubble = null;
});

// ---------------- context DB pane ----------------
let currentTab = 'contacts';
let contacts = [];

document.querySelectorAll('.tab').forEach((t) => t.addEventListener('click', () => {
  document.querySelectorAll('.tab').forEach((x) => x.classList.toggle('on', x === t));
  currentTab = t.dataset.tab;
  if (currentTab === 'contacts') loadContacts(); else loadQueue();
}));

async function loadContacts(soft) {
  const { status, body } = await motion.get('/api/targets?per_page=500&orderBy=updated_at:desc');
  if (status !== 200) { if (!soft) $('#db-body').innerHTML = '<div class="empty">Could not load contacts.</div>'; return; }
  contacts = Array.isArray(body) ? body : (body.rows || []);
  if (currentTab === 'contacts' && !$('#db-body').dataset.detail) renderContacts();
}
function renderContacts(list) {
  const rows = (list || contacts);
  const el = $('#db-body');
  delete el.dataset.detail;
  if (!rows.length) { el.innerHTML = '<div class="empty">No contacts yet.<br>Ask the agent to log your first one.</div>'; return; }
  el.innerHTML = rows.map((t) => `
    <button class="list-row" data-id="${t.id}">
      ${dot(t.stage)}
      <span class="nm">${esc(t.name)}</span>
      <span class="sub">${esc(t.company || t.title || '')}</span>
      <span class="right">${rel(t.last_touch)}</span>
    </button>`).join('');
  el.querySelectorAll('[data-id]').forEach((b) => b.addEventListener('click', () => openBrief(Number(b.dataset.id))));
}

async function openBrief(id) {
  const el = $('#db-body');
  el.dataset.detail = '1';
  el.innerHTML = '<div class="empty">Loading…</div>';
  const { status, body } = await motion.get('/api/brief/' + id);
  if (status !== 200) { el.innerHTML = '<div class="empty">Could not load this contact.</div>'; return; }
  const t = body.target || {};
  const ctx = body.context || [];
  const fus = (body.follow_ups || []).filter((f) => f.status === 'open' || f.status === 'queued');
  el.innerHTML = `
    <a class="back" href="#">← All contacts</a>
    <div class="detail-head">
      <h2>${esc(t.name)}</h2>
      <div class="meta">${esc([t.title, t.company].filter(Boolean).join(' · '))}</div>
      <div style="margin-top:7px">
        <span class="chip">${esc(t.stage || 'new')}</span>
        ${t.email ? `<span class="chip">${esc(t.email)}</span>` : ''}
        ${t.phone ? `<span class="chip">${esc(t.phone)}</span>` : ''}
      </div>
    </div>
    ${fus.length ? `<div class="section-h">Open follow-ups</div>` + fus.map((f) => `
      <div class="fu-row">${dot(t.stage)}<span>${esc(f.note)}</span>
        <span class="ch">${esc(f.channel || '')}</span>
        <span class="due">${esc(String(f.due_at || f.scheduled_for || '').slice(0, 10))}</span></div>`).join('') : ''}
    <div class="section-h">Timeline · ${ctx.length}</div>
    ${ctx.length ? ctx.map((e) => `
      <div class="entry">
        <div class="eh"><span class="kind">${esc(e.kind)}</span><span>${rel(e.occurred_at)} ago</span><span>· ${esc(e.source || '')}</span></div>
        <div class="body">${esc(e.content)}</div>
      </div>`).join('') : '<div class="empty">No context yet.</div>'}`;
  el.querySelector('.back').addEventListener('click', (e) => { e.preventDefault(); renderContacts(); });
}

async function loadQueue() {
  const el = $('#db-body');
  delete el.dataset.detail;
  el.innerHTML = '<div class="empty">Loading…</div>';
  const { status, body } = await motion.get('/api/queue');
  if (status !== 200) { el.innerHTML = '<div class="empty">Could not load the queue.</div>'; return; }
  const due = body.due || [], up = body.upcoming || [];
  const row = (q) => `
    <div class="fu-row">
      <span class="ch">${({ email: '✉️', linkedin: 'in', imessage: '📱', whatsapp: '💬' })[q.channel] || '⚑'}</span>
      <span>${esc(q.note)}</span>
      <span class="sub" style="color:var(--tx3)">· ${esc(q.target_name)}</span>
      <span class="due">${esc(String(q.scheduled_for || '').replace('T', ' ').slice(0, 16))}</span>
    </div>`;
  el.innerHTML = `
    <div class="section-h" style="color:var(--amber)">Due now · ${due.length}</div>
    ${due.length ? due.map(row).join('') : '<div class="empty">Nothing due.</div>'}
    <div class="section-h">Upcoming · ${up.length}</div>
    ${up.length ? up.map(row).join('') : '<div class="empty">No upcoming steps. A reply on any channel cancels a contact’s queued steps.</div>'}`;
}

// search — filters contacts locally, hits /api/search for context matches
let searchTimer;
$('#db-search').addEventListener('input', function () {
  clearTimeout(searchTimer);
  const q = this.value.trim();
  searchTimer = setTimeout(async () => {
    if (!q) { renderContacts(); return; }
    const local = contacts.filter((t) => (t.name + ' ' + (t.company || '') + ' ' + (t.email || '')).toLowerCase().includes(q.toLowerCase()));
    const { status, body } = await motion.get('/api/search?q=' + encodeURIComponent(q));
    const ctx = status === 200 && Array.isArray(body.context) ? body.context : [];
    const el = $('#db-body');
    delete el.dataset.detail;
    el.innerHTML =
      `<div class="section-h">Contacts · ${local.length}</div>` +
      (local.map((t) => `<button class="list-row" data-id="${t.id}">${dot(t.stage)}<span class="nm">${esc(t.name)}</span><span class="sub">${esc(t.company || '')}</span></button>`).join('') || '<div class="empty">No matching contacts.</div>') +
      `<div class="section-h">Context · ${ctx.length}</div>` +
      (ctx.map((x) => `<button class="list-row" data-id="${x.target_id}"><span class="sub">[${esc(x.kind)}]</span><span class="nm" style="font-weight:400">${esc(x.snippet)}</span></button>`).join('') || '<div class="empty">No context matches.</div>');
    el.querySelectorAll('[data-id]').forEach((b) => b.addEventListener('click', () => openBrief(Number(b.dataset.id))));
  }, 160);
});
document.addEventListener('keydown', (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); $('#db-search').focus(); }
});

// ---------------- settings ----------------
$('#settings-btn').addEventListener('click', async () => {
  cfg = await motion.cfg();
  const eng = await motion.detectEngines();
  $('#set-email').textContent = cfg.email || '(not signed in)';
  $('#set-engine').textContent = 'BYOK (Anthropic API key)' + (eng.claudeCode ? ` — Claude Code ${eng.claudeCode} detected (mode coming soon)` : '');
  $('#set-model').value = cfg.model || 'claude-opus-5';
  $('#set-key').value = '';
  $('#set-key').placeholder = cfg.hasKey ? '••••••••  (saved — paste to replace)' : 'sk-ant-…';
  $('#modal').hidden = false;
});
$('#set-cancel').addEventListener('click', () => { $('#modal').hidden = true; });
$('#set-save').addEventListener('click', async () => {
  const k = $('#set-key').value.trim();
  if (k) await motion.setKey(k);
  await motion.setModel($('#set-model').value);
  cfg = await motion.cfg();
  $('#engine-badge').textContent = (cfg.model || 'claude-opus-5').replace('claude-', '') + ' · BYOK';
  $('#modal').hidden = true;
});
$('#set-logout').addEventListener('click', async () => { await motion.logout(); location.reload(); });

boot();
