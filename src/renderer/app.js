// Blitz desktop renderer — gate (login → key), chat pane, context DB pane.
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
let engines = { claudeCode: null };

const engineReady = () =>
  cfg.engine === 'claude-code' || (cfg.engine === 'byok' && cfg.hasKey);

// ================= onboarding wizard =================
let wstep = 1;
const WMAX = 4;
let bridgePoll = null;
let bridges = { channels: null, channelsAvailable: true, imessage: null };

async function boot() {
  cfg = await motion.cfg();
  engines = await motion.detectEngines();
  if (cfg.loggedIn && engineReady() && cfg.onboarded) { enterApp(); return; }
  wstep = !cfg.loggedIn ? 1 : (!engineReady() ? 2 : 3);
  renderGate();
}

function wdots() {
  let h = '';
  for (let i = 1; i <= WMAX; i++) h += `<span class="gdot ${i === wstep ? 'on' : i < wstep ? 'past' : ''}"></span>`;
  return `<div class="gdots">${h}</div>`;
}

function renderGate() {
  $('#gate').hidden = false; $('#app').hidden = true;
  const box = $('#gate-steps');
  const title = $('#gate-title'), sub = $('#gate-sub');

  if (wstep === 1) {
    title.textContent = 'Your AI Rolodex.';
    sub.textContent = 'Everyone you know, remembered — and reached — by your agent.';
    box.innerHTML = wdots() + `
      <div class="step">
        <span class="n">1</span>
        <div class="t"><b>Sign in to Blitz</b><span>Google sign-in — opens in your browser</span></div>
        <button id="g-login" class="primary">Sign in</button>
      </div>
      <div class="gate-err" id="g-err"></div>`;
    $('#g-login').addEventListener('click', async (e) => {
      e.target.disabled = true; e.target.textContent = 'Waiting…';
      try { await motion.login(); cfg = await motion.cfg(); wstep = 2; renderGate(); }
      catch (err) { $('#g-err').textContent = String(err.message || err); e.target.disabled = false; e.target.textContent = 'Sign in'; }
    });
    return;
  }

  if (wstep === 2) {
    title.textContent = 'Power your agent.';
    sub.textContent = 'Pick how Blitz thinks. You can change this anytime in Settings.';
    const cc = engines.claudeCode;
    box.innerHTML = wdots() + `
      <div class="engine-card ${cc ? '' : 'disabled'}" data-engine="claude-code">
        <div class="ec-head"><b>Use my Claude subscription</b>${cc ? '<span class="ec-tag ok">Detected · ' + esc(cc) + '</span>' : '<span class="ec-tag">Claude Code not found</span>'}</div>
        <span>Runs through your installed Claude Code — no extra cost, uses your Pro/Max plan.</span>
      </div>
      <div class="engine-card" data-engine="byok">
        <div class="ec-head"><b>Bring my own API key</b><span class="ec-tag">Metered via Anthropic</span></div>
        <span>Pay-per-use with your Anthropic key. Powered by Claude Opus 5.</span>
        <input id="g-key" type="password" placeholder="sk-ant-…" ${cfg.hasKey ? 'value="" placeholder="••••••••  (key saved — paste to replace)"' : ''}>
      </div>
      <div class="gate-err" id="g-err"></div>
      <div class="wnav"><button id="g-back" class="ghost">← Back</button><span class="spacer"></span><button id="g-next" class="primary wide">Continue</button></div>`;
    let chosen = cfg.engine || (cc ? 'claude-code' : 'byok');
    const mark = () => box.querySelectorAll('.engine-card[data-engine]').forEach((c) => c.classList.toggle('sel', c.dataset.engine === chosen));
    mark();
    box.querySelectorAll('.engine-card[data-engine]').forEach((c) => c.addEventListener('click', () => {
      if (c.classList.contains('disabled')) return;
      chosen = c.dataset.engine; mark();
      if (chosen === 'byok') box.querySelector('#g-key').focus();
    }));
    $('#g-back').addEventListener('click', () => { wstep = 1; renderGate(); });
    $('#g-next').addEventListener('click', async () => {
      if (chosen === 'byok') {
        const k = $('#g-key').value.trim();
        if (k) { if (!k.startsWith('sk-')) { $('#g-err').textContent = 'That does not look like an Anthropic API key.'; return; } await motion.setKey(k); }
        else if (!cfg.hasKey) { $('#g-err').textContent = 'Paste your Anthropic API key to continue.'; return; }
      }
      await motion.setEngine(chosen);
      cfg = await motion.cfg();
      wstep = 3; renderGate();
    });
    return;
  }

  if (wstep === 3) {
    title.textContent = 'Connect your bridges.';
    sub.textContent = 'Live checks — each turns green when the bridge is up. All optional.';
    box.innerHTML = wdots() + `
      <div class="bridge" id="br-rolodex">
        <span class="bstat ok"></span>
        <div class="t"><b>Rolodex</b><span>${esc(cfg.email || 'connected')}</span></div>
      </div>
      <div class="bridge" id="br-channels">
        <span class="bstat wait"></span>
        <div class="t"><b>Email &amp; LinkedIn</b><span id="br-ch-sub">Checking…</span></div>
        <div class="bactions">
          <button class="ghost" data-conn="GOOGLE">✉️ Email</button>
          <button class="ghost" data-conn="LINKEDIN">in LinkedIn</button>
        </div>
      </div>
      <div class="bridge" id="br-imsg">
        <span class="bstat wait"></span>
        <div class="t"><b>iMessage</b><span id="br-im-sub">Send texts from your own number — grant the one-time permission</span></div>
        <button id="g-imsg" class="ghost">Enable</button>
      </div>
      <div class="gate-err" id="g-err"></div>
      <div class="wnav"><button id="g-back" class="ghost">← Back</button><span class="spacer"></span><button id="g-next" class="primary wide">Continue</button></div>`;
    $('#g-back').addEventListener('click', () => { stopBridgePoll(); wstep = 2; renderGate(); });
    $('#g-next').addEventListener('click', () => { stopBridgePoll(); wstep = 4; renderGate(); });
    box.querySelectorAll('[data-conn]').forEach((b) => b.addEventListener('click', async () => {
      b.disabled = true; const old = b.textContent; b.textContent = 'Opening…';
      const { status, body } = await motion.post('/api/channels/connect', { provider: b.dataset.conn });
      if (status === 200 && body.url) { motion.openUrl(body.url); $('#br-ch-sub').textContent = 'Finish connecting in your browser — this turns green automatically.'; }
      else { bridges.channelsAvailable = false; $('#br-ch-sub').textContent = body.error || 'Channels service not configured yet — skip for now.'; }
      b.disabled = false; b.textContent = old;
    }));
    $('#g-imsg').addEventListener('click', async (e) => {
      e.target.disabled = true; e.target.textContent = 'Checking…';
      $('#br-im-sub').textContent = 'macOS may ask to allow controlling Messages — click OK.';
      const r = await motion.imessageCheck();
      bridges.imessage = r.ok;
      setBridge('#br-imsg', r.ok);
      $('#br-im-sub').textContent = r.ok ? 'Ready — your agent can text from your number.' : 'Not enabled: ' + (r.error || 'permission denied') + '. Retry, or fix in System Settings → Privacy → Automation.';
      e.target.disabled = false; e.target.textContent = r.ok ? 'Re-check' : 'Enable';
    });
    startBridgePoll();
    return;
  }

  // step 4 — done
  stopBridgePoll();
  title.textContent = 'You’re in motion.';
  sub.textContent = 'Talk to your agent — it works the Rolodex.';
  const sum = (ok, label, note) => `
    <div class="bridge slim"><span class="bstat ${ok ? 'ok' : 'off'}"></span>
      <div class="t"><b>${label}</b><span>${note}</span></div></div>`;
  box.innerHTML = wdots() +
    sum(true, 'Rolodex', esc(cfg.email || 'connected')) +
    sum(true, 'Agent', cfg.engine === 'claude-code' ? 'Claude Code (your subscription)'
      : 'API key · ' + esc((cfg.model || 'claude-opus-5').replace('claude-', ''))) +
    sum(!!(bridges.channels > 0), 'Email & LinkedIn', bridges.channels > 0 ? bridges.channels + ' channel(s) connected' : 'add anytime in Settings') +
    sum(!!bridges.imessage, 'iMessage', bridges.imessage ? 'ready — texts from your number' : 'enable anytime') + `
    <div class="wnav"><button id="g-back" class="ghost">← Back</button><span class="spacer"></span><button id="g-enter" class="primary wide">Enter Blitz →</button></div>`;
  $('#g-back').addEventListener('click', () => { wstep = 3; renderGate(); });
  $('#g-enter').addEventListener('click', async () => { await motion.setOnboarded(); cfg = await motion.cfg(); enterApp(); });
}

function setBridge(sel, ok) {
  const el = $(sel + ' .bstat');
  if (el) el.className = 'bstat ' + (ok ? 'ok' : 'wait');
}

function startBridgePoll() {
  stopBridgePoll();
  const tick = async () => {
    const { status, body } = await motion.get('/api/channel_accounts');
    if (status === 200) {
      const rows = Array.isArray(body) ? body : (body.rows || []);
      bridges.channels = rows.length;
      setBridge('#br-channels', rows.length > 0);
      if (rows.length > 0) { const s = $('#br-ch-sub'); if (s) s.textContent = rows.length + ' channel(s) connected'; }
      else if (bridges.channelsAvailable) { const s = $('#br-ch-sub'); if (s && s.textContent === 'Checking…') s.textContent = 'Connect an inbox or LinkedIn — opens in your browser.'; }
    }
  };
  tick();
  bridgePoll = setInterval(tick, 3500);
}
function stopBridgePoll() { if (bridgePoll) { clearInterval(bridgePoll); bridgePoll = null; } }


// ---------------- markdown ----------------
// The agent and every MCP tool return markdown. A CDN parser is impossible here
// (CSP is default-src 'self'), so this is a small renderer that escapes FIRST
// and only then introduces tags — no user text can ever become markup.
function md(src) {
  const esc0 = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const text = String(src ?? '').replace(/\r\n/g, '\n');

  // Pull fenced code out first so its contents are never marked up.
  const fences = [];
  let s = esc0(text).replace(/```(\w+)?\n?([\s\S]*?)```/g, (_m, lang, body) => {
    fences.push('<pre class="md-pre"><code>' + body.replace(/\n$/, '') + '</code></pre>');
    return '\u0000FENCE' + (fences.length - 1) + '\u0000';
  });

  const inline = (x) => x
    .replace(/`([^`\n]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[\s(])\*([^*\n]+)\*/g, '$1<em>$2</em>')
    .replace(/(^|[\s(])_([^_\n]+)_/g, '$1<em>$2</em>')
    // Links: href is already escaped; only http(s) is allowed through.
    .replace(/\[([^\]\n]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');

  const out = [];
  let list = null;                       // 'ul' | 'ol' | null
  const closeList = () => { if (list) { out.push('</' + list + '>'); list = null; } };

  for (const raw of s.split('\n')) {
    const line = raw.trimEnd();
    if (/^\u0000FENCE\d+\u0000$/.test(line.trim())) { closeList(); out.push(line.trim()); continue; }
    if (!line.trim()) { closeList(); continue; }

    const h = line.match(/^(#{1,4})\s+(.*)$/);
    if (h) { closeList(); out.push('<div class="md-h' + h[1].length + '">' + inline(h[2]) + '</div>'); continue; }

    if (/^\s*([-*+]|&gt;?)\s+/.test(line) && /^\s*[-*+]\s+/.test(line)) {
      if (list !== 'ul') { closeList(); out.push('<ul class="md-ul">'); list = 'ul'; }
      out.push('<li>' + inline(line.replace(/^\s*[-*+]\s+/, '')) + '</li>');
      continue;
    }
    const ol = line.match(/^\s*\d+\.\s+(.*)$/);
    if (ol) {
      if (list !== 'ol') { closeList(); out.push('<ol class="md-ol">'); list = 'ol'; }
      out.push('<li>' + inline(ol[1]) + '</li>');
      continue;
    }
    if (/^&gt;\s?/.test(line)) { closeList(); out.push('<blockquote>' + inline(line.replace(/^&gt;\s?/, '')) + '</blockquote>'); continue; }
    if (/^(-{3,}|\*{3,})$/.test(line.trim())) { closeList(); out.push('<hr>'); continue; }

    closeList();
    out.push('<p>' + inline(line) + '</p>');
  }
  closeList();
  return out.join('').replace(/\u0000FENCE(\d+)\u0000/g, (_m, i) => fences[Number(i)]);
}

// ================= app =================
function engineLabel() {
  return cfg.engine === 'claude-code'
    ? 'Claude Code'
    : (cfg.model || 'claude-opus-5').replace('claude-', '') + ' · key';
}
async function enterApp() {
  $('#gate').hidden = true; $('#app').hidden = false;
  $('#engine-badge').textContent = engineLabel();
  $('#engine-badge').classList.add('ok');
  loadContacts();
  startDataPoll();
}

// The right pane used to refresh ONLY when an agent turn finished, so rows
// created any other way (web app, CLI, another device) never showed up and the
// list looked stuck. Poll the active tab instead; pause while hidden.
let dataPoll = null;
function refreshActiveTab(soft) {
  if ($('#app').hidden) return;
  if (currentTab === 'contacts') loadContacts(soft);
  else if (currentTab === 'queue') loadQueue(soft);
  else loadMeetings(soft);
}
function startDataPoll() {
  if (dataPoll) clearInterval(dataPoll);
  dataPoll = setInterval(() => { if (!document.hidden) refreshActiveTab(true); }, 7000);
}
document.addEventListener('visibilitychange', () => { if (!document.hidden) refreshActiveTab(true); });

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
  wrap.innerHTML = '<div class="bubble md"></div>';
  threadEl().appendChild(wrap);
  botBubble = wrap.querySelector('.bubble');
  botBubble._raw = '';
  return botBubble;
}
// Streamed deltas are markdown fragments, so keep the raw text and re-render
// the whole bubble each chunk — half a bold marker can't be parsed alone.
function appendBotText(chunk) {
  const b = ensureBotBubble();
  b._raw = (b._raw || '') + chunk;
  b.innerHTML = md(b._raw);
}
function addActionCard(name, input) {
  clearHello();
  const nice = String(name || '').replace(/^mcp__(?:blitz|motion)__/, '');
  const detail = input ? esc(JSON.stringify(input)).slice(0, 220) : '';
  threadEl().insertAdjacentHTML('beforeend',
    `<div class="action-card"><span class="ic">⚙</span><div><span class="nm">${esc(nice)}</span>${detail ? `<div class="detail">${detail}</div>` : ''}</div></div>`);
  botBubble = null; // next text starts a fresh bubble under the card
  scrollThread();
}
function addResultCard(text) {
  const raw = String(text || '').trim();
  if (!raw) return;
  const clipped = raw.length > 1200 ? raw.slice(0, 1200) + '\n\n…' : raw;
  threadEl().insertAdjacentHTML('beforeend',
    `<div class="action-card result"><span class="ic">✓</span><div class="detail md">${md(clipped)}</div></div>`);
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
    appendBotText(ev.text);
    scrollThread();
  } else if (ev.kind === 'text_full') {
    setThinking(false);
    appendBotText(ev.text);
    botBubble = null;
    scrollThread();
  } else if (ev.kind === 'imessage_sent') {
    setThinking(false);
    threadEl().insertAdjacentHTML('beforeend', ev.ok
      ? '<div class="action-card result"><span class="ic">📱</span><div><span class="nm">iMessage sent from your Mac</span></div></div>'
      : `<div class="action-card"><span class="ic" style="color:var(--red)">✕</span><div><span class="nm">iMessage failed</span><div class="detail">${esc(ev.error || 'Is Messages signed in?')}</div></div></div>`);
    scrollThread();
    setThinking(true);
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
  threadEl().innerHTML = '<div class="hello"><img class="hello-logo" src="assets/logo.png" alt=""><h2>New conversation.</h2><p>Context cleared — your Rolodex data is unchanged.</p></div>';
  botBubble = null;
});

// ---------------- context DB pane ----------------
let currentTab = 'contacts';
let contacts = [];

$('#db-refresh').addEventListener('click', async () => {
  const b = $('#db-refresh');
  b.classList.add('spin');
  await refreshActiveTab(false);
  setTimeout(() => b.classList.remove('spin'), 350);
});

document.querySelectorAll('.tab').forEach((t) => t.addEventListener('click', () => {
  document.querySelectorAll('.tab').forEach((x) => x.classList.toggle('on', x === t));
  currentTab = t.dataset.tab;
  if (currentTab === 'contacts') loadContacts();
  else if (currentTab === 'queue') loadQueue();
  else loadMeetings();
}));


// ---- Meetings tab: Calendly-style booking-page setup + upcoming bookings ----
async function loadMeetings(soft) {
  const el = $('#db-body');
  // Never stomp a detail view or a booking form the user is mid-edit in.
  if (soft && (el.dataset.detail || el.querySelector('#bp-title'))) return;
  if (!soft) { delete el.dataset.detail; el.innerHTML = '<div class="empty">Loading…</div>'; }
  const [pg, bk] = await Promise.all([
    motion.get('/api/booking_pages?per_page=5'),
    motion.get('/api/bookings?per_page=100&orderBy=start_at:asc'),
  ]);
  const pages = pg.status === 200 ? (Array.isArray(pg.body) ? pg.body : (pg.body.rows || [])) : [];
  const now = new Date().toISOString().slice(0, 19).replace('T', ' ');
  const bookings = (bk.status === 200 ? (Array.isArray(bk.body) ? bk.body : (bk.body.rows || [])) : [])
    .filter((b) => b.status === 'confirmed' && String(b.start_at).replace('T', ' ') >= now);
  renderMeetings(pages[0] || null, bookings);
}

function renderMeetings(page, bookings) {
  const el = $('#db-body');
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const field = (label, inner) => `<div style="margin-bottom:10px"><label style="display:block;font-size:11.5px;color:var(--tx3);margin-bottom:4px">${label}</label>${inner}</div>`;
  const dayChecks = (sel) => [['1','Mon'],['2','Tue'],['3','Wed'],['4','Thu'],['5','Fri'],['6','Sat'],['7','Sun']]
    .map(([v, l]) => `<label style="display:inline-flex;align-items:center;gap:4px;margin-right:8px;font-size:12px;color:var(--tx2)"><input type="checkbox" class="bp-day" value="${v}" ${sel.includes(v) ? 'checked' : ''} style="width:auto">${l}</label>`).join('');
  const hourOpts = (v) => Array.from({ length: 24 }, (_, h) => `<option value="${h}" ${h === v ? 'selected' : ''}>${h === 0 ? '12 AM' : h < 12 ? h + ' AM' : h === 12 ? '12 PM' : (h - 12) + ' PM'}</option>`).join('');

  const p = page || { slug: '', title: 'Intro call', durations: '15,30', days: '1,2,3,4,5', start_hour: 9, end_hour: 17, timezone: tz, active: true };
  const link = cfg.base + '/book?u=' + (p.slug || '…');

  el.innerHTML = `
    <div class="section-h">Your booking page</div>
    <div class="entry" style="padding:14px">
      ${page ? `
        <div style="display:flex;align-items:center;gap:8px;margin-bottom:12px">
          <code style="flex:1;font-size:12px;background:var(--bg);border:1px solid var(--border);border-radius:7px;padding:7px 9px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(link)}</code>
          <button id="bp-copy" class="ghost" style="padding:6px 10px">Copy</button>
          <button id="bp-toggle" class="ghost" style="padding:6px 10px">${p.active ? 'Turn off' : 'Turn on'}</button>
        </div>` : `
        <div style="font-size:12.5px;color:var(--tx2);margin-bottom:12px">Share one link; booked meetings land on the contact's timeline automatically and stop any running sequences.</div>
        ${field('Your link', `<div style="display:flex;align-items:center;gap:6px"><span style="font-size:12px;color:var(--tx3)">/book?u=</span><input id="bp-slug" placeholder="your-name" style="flex:1"></div>`)}`}
      ${field('Title', `<input id="bp-title" value="${esc(p.title)}">`)}
      ${field('Durations (minutes, comma-separated)', `<input id="bp-durs" value="${esc(p.durations)}">`)}
      ${field('Days', `<div>${dayChecks(String(p.days).split(','))}</div>`)}
      <div style="display:flex;gap:10px">
        <div style="flex:1">${field('From', `<select id="bp-start" style="width:100%">${hourOpts(p.start_hour)}</select>`)}</div>
        <div style="flex:1">${field('Until', `<select id="bp-end" style="width:100%">${hourOpts(p.end_hour)}</select>`)}</div>
      </div>
      ${field('Timezone', `<input id="bp-tz" value="${esc(p.timezone)}">`)}
      <div style="display:flex;justify-content:flex-end;gap:8px;margin-top:4px">
        <span id="bp-err" style="flex:1;color:var(--red);font-size:12px;align-self:center"></span>
        <button id="bp-save" class="primary" style="padding:7px 16px">${page ? 'Save' : 'Create my page'}</button>
      </div>
    </div>
    <div class="section-h">Upcoming meetings · ${bookings.length}</div>
    ${bookings.length ? bookings.map((b) => `
      <div class="fu-row">
        <span class="ch">📅</span>
        <span>${esc(b.guest_name)} <span style="color:var(--tx3)">· ${esc(b.guest_email)}</span></span>
        <span class="due">${new Date(String(b.start_at).replace(' ', 'T') + (String(b.start_at).endsWith('Z') ? '' : 'Z')).toLocaleString([], { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}</span>
      </div>`).join('') : '<div class="empty">Nothing booked yet — share your link.</div>'}`;

  $('#bp-copy')?.addEventListener('click', function () { navigator.clipboard.writeText(link); this.textContent = 'Copied'; setTimeout(() => { this.textContent = 'Copy'; }, 1500); });
  $('#bp-toggle')?.addEventListener('click', async () => { await motion.patch('/api/booking_pages/' + page.id, { active: !p.active }); loadMeetings(); });
  $('#bp-save').addEventListener('click', async () => {
    const days = [...el.querySelectorAll('.bp-day:checked')].map((c) => c.value).join(',');
    const body = {
      title: $('#bp-title').value.trim() || 'Intro call',
      durations: $('#bp-durs').value.replace(/[^0-9,]/g, '') || '30',
      days: days || '1,2,3,4,5',
      start_hour: Number($('#bp-start').value),
      end_hour: Number($('#bp-end').value),
      timezone: $('#bp-tz').value.trim() || tz,
    };
    if (body.end_hour <= body.start_hour) { $('#bp-err').textContent = '"Until" must be after "From".'; return; }
    let res;
    if (page) res = await motion.patch('/api/booking_pages/' + page.id, body);
    else {
      const slug = ($('#bp-slug').value.trim().toLowerCase().replace(/[^a-z0-9-]/g, '-')) || '';
      if (!slug) { $('#bp-err').textContent = 'Pick a link name.'; return; }
      res = await motion.post('/api/booking_pages', { ...body, slug, active: true });
    }
    if (res.status >= 300) { $('#bp-err').textContent = (res.body && res.body.error) || 'Could not save — is that link name taken?'; return; }
    loadMeetings();
  });
}

async function loadContacts(soft) {
  const { status, body } = await motion.get('/api/targets?per_page=500&orderBy=updated_at:desc');
  if (status !== 200) { if (!soft) $('#db-body').innerHTML = '<div class="empty">Could not load contacts.</div>'; return; }
  contacts = Array.isArray(body) ? body : (body.rows || []);
  if (currentTab !== 'contacts') return;
  if (soft && $('#db-body').dataset.detail) return;
  renderContacts();
}
// ---------------- how to reach someone ----------------
// A contact has many identities: several emails, a phone, LinkedIn, an iMessage
// handle. `norm` is the matching key and MUST mirror the server's rule —
// lowercased email, last-10 phone digits, bare linkedin handle — so a handle
// taught here still resolves server-side.
const CH_KINDS = ['email', 'phone', 'whatsapp', 'imessage', 'linkedin', 'other'];
const CH_ICON = { email: '\u2709\uFE0F', phone: '\uD83D\uDCDE', whatsapp: '\uD83D\uDCAC', imessage: '\uD83D\uDCF1', linkedin: 'in', other: '\u2691' };

function normCh(kind, value) {
  const v = String(value || '').trim();
  if (!v) return '';
  if (kind === 'email') return v.toLowerCase();
  if (kind === 'linkedin') {
    const m = v.match(/\/in\/([^/?#]+)/);
    return (m ? m[1] : v).toLowerCase();
  }
  if (kind === 'phone' || kind === 'whatsapp' || kind === 'imessage') {
    const d = v.replace(/[^0-9]/g, '');
    return d.length >= 10 ? d.slice(-10) : d;
  }
  return v.toLowerCase();
}

async function loadChannelsFor(targetId) {
  const { status, body } = await motion.get('/api/contact_channels?per_page=200');
  if (status !== 200) return [];
  const rows = Array.isArray(body) ? body : (body.rows || []);
  return rows.filter((r) => Number(r.target_id) === Number(targetId));
}

function renderChannelBox(targetId, rows) {
  const list = rows.length ? rows.map((c) => `
    <div class="chan-row">
      <span class="prov">${CH_ICON[c.kind] || '\u2691'} ${esc(c.kind)}</span>
      <span class="who">${esc(c.value)}</span>
      ${c.is_primary ? '<span class="chan-badge ok">primary</span>'
        : `<button class="ghost mini cc-prim" data-id="${c.id}" data-kind="${esc(c.kind)}">make primary</button>`}
      <button class="ghost mini cc-del" data-id="${c.id}" title="Remove">\u00d7</button>
    </div>`).join('') : '<span class="chan-empty">No channels yet.</span>';

  return `<div class="section-h">Reachable on</div>
    <div class="entry">
      <div class="chan-list">${list}</div>
      <div style="display:flex;gap:6px;margin-top:8px">
        <select id="cc-kind" style="flex:0 0 110px">${CH_KINDS.map((k) => `<option value="${k}">${k}</option>`).join('')}</select>
        <input id="cc-val" placeholder="email, phone, or profile URL" style="flex:1">
        <button id="cc-add" class="primary">Add</button>
      </div>
      <div id="cc-err" class="chan-err"></div>
    </div>`;
}

function wireChannelBox(targetId) {
  const refresh = async () => {
    const rows = await loadChannelsFor(targetId);
    const host = $('#cc-host');
    if (!host) return;
    host.innerHTML = renderChannelBox(targetId, rows);
    wireChannelBox(targetId);
  };
  $('#cc-add')?.addEventListener('click', async () => {
    const kind = $('#cc-kind').value, value = $('#cc-val').value.trim();
    if (!value) { $('#cc-err').textContent = 'Enter a value first.'; return; }
    const norm = normCh(kind, value);
    if (!norm) { $('#cc-err').textContent = 'That is not usable for matching.'; return; }
    const rows = await loadChannelsFor(targetId);
    const res = await motion.post('/api/contact_channels', {
      target_id: Number(targetId), kind, value, norm,
      is_primary: !rows.some((r) => r.kind === kind), source: 'manual',
    });
    if (res.status >= 300) { $('#cc-err').textContent = 'Could not add that.'; return; }
    refresh();
  });
  document.querySelectorAll('.cc-del').forEach((b) => b.addEventListener('click', async () => {
    await motion.del('/api/contact_channels/' + b.dataset.id); refresh();
  }));
  document.querySelectorAll('.cc-prim').forEach((b) => b.addEventListener('click', async () => {
    const rows = await loadChannelsFor(targetId);
    await Promise.all(rows.filter((r) => r.kind === b.dataset.kind && r.is_primary)
      .map((r) => motion.patch('/api/contact_channels/' + r.id, { is_primary: false })));
    await motion.patch('/api/contact_channels/' + b.dataset.id, { is_primary: true });
    refresh();
  }));
}

const STAGES = ['new', 'engaged', 'qualified', 'active', 'won', 'lost', 'dormant'];
let stageFilter = 'all';

function renderContacts(list) {
  const el = $('#db-body');
  delete el.dataset.detail;
  const all = list || contacts;
  const rows = stageFilter === 'all' ? all : all.filter((t) => (t.stage || 'new') === stageFilter);

  // Only offer stages the user actually has, so the filter row stays honest.
  const counts = {};
  for (const t of all) counts[t.stage || 'new'] = (counts[t.stage || 'new'] || 0) + 1;
  const chips = ['all'].concat(STAGES.filter((s) => counts[s])).map((s) =>
    `<button class="ib-chip ${s === stageFilter ? 'on' : ''}" data-stage="${s}">${
      s === 'all' ? `All ${all.length}` : `${s} ${counts[s]}`}</button>`).join('');

  el.innerHTML = `
    <div class="ib-filters">${chips}</div>
    <div class="quick-add">
      <input id="qa-name" placeholder="Add someone — name">
      <input id="qa-co" placeholder="company (optional)">
      <button id="qa-go" class="primary">Add</button>
    </div>
    <div id="qa-err" class="chan-err"></div>` +
    (rows.length ? rows.map((t) => `
      <button class="list-row card" data-id="${t.id}">
        ${dot(t.stage)}
        <span class="mid">
          <span class="nm">${esc(t.name)}${t.priority === 'high' ? '<span class="pri">high</span>' : ''}</span>
          <span class="sub">${esc([t.title, t.company].filter(Boolean).join(' · ') || 'no company yet')}</span>
        </span>
        <span class="right">${t.last_touch ? rel(t.last_touch) + ' ago' : 'never'}</span>
      </button>`).join('')
      : `<div class="empty">${all.length ? 'Nobody at this stage.' : 'No contacts yet.<br>Add one above, or ask the agent to log someone.'}</div>`);

  el.querySelectorAll('[data-stage]').forEach((b) => b.addEventListener('click', () => {
    stageFilter = b.dataset.stage; renderContacts(list);
  }));
  el.querySelectorAll('[data-id]').forEach((b) => b.addEventListener('click', () => openBrief(Number(b.dataset.id))));
  $('#qa-go').addEventListener('click', quickAdd);
  $('#qa-name').addEventListener('keydown', (e) => { if (e.key === 'Enter') quickAdd(); });
}

async function quickAdd() {
  const name = $('#qa-name').value.trim();
  if (!name) { $('#qa-err').textContent = 'Give them a name.'; return; }
  const body = { name, stage: 'new' };
  const co = $('#qa-co').value.trim();
  if (co) body.company = co;
  const res = await motion.post('/api/targets', body);
  if (res.status >= 300) { $('#qa-err').textContent = 'Could not add that contact.'; return; }
  const id = res.body && (res.body.id || (res.body.rows && res.body.rows[0] && res.body.rows[0].id));
  await loadContacts(true);
  if (id) openBrief(id);
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

  const field = (k, label, val, ph) =>
    `<label class="f"><span>${label}</span><input data-f="${k}" value="${esc(val || '')}" placeholder="${ph || ''}"></label>`;

  el.innerHTML = `
    <a class="back" href="#">← ${currentTab === 'queue' ? 'Today' : 'All contacts'}</a>
    <div class="detail-head">
      <h2>${esc(t.name)}</h2>
      <div class="meta">${esc([t.title, t.company].filter(Boolean).join(' · ') || 'no company yet')}
        · last touch ${t.last_touch ? rel(t.last_touch) + ' ago' : 'never'}</div>
      <button id="ct-del" class="ghost mini danger" title="Delete this contact">Delete contact</button>
    </div>

    <div class="section-h">Contact info <button id="ci-edit" class="ghost mini">edit</button></div>
    <div class="entry" id="ci-view">
      ${[['Email', t.email], ['Phone', t.phone], ['LinkedIn', t.linkedin], ['Tags', t.tags]]
        .filter(([, v]) => v).map(([k, v]) => `<div class="kv"><span>${k}</span><b>${esc(v)}</b></div>`).join('')
        || '<span class="chan-empty">Nothing on file yet — hit edit.</span>'}
      <div class="kv"><span>Stage</span><b>${esc(t.stage || 'new')}</b></div>
    </div>
    <div class="entry" id="ci-form" hidden>
      ${field('name', 'Name', t.name)}
      ${field('company', 'Company', t.company)}
      ${field('title', 'Title', t.title)}
      ${field('email', 'Email', t.email)}
      ${field('phone', 'Phone', t.phone)}
      ${field('linkedin', 'LinkedIn', t.linkedin)}
      ${field('tags', 'Tags', t.tags, 'comma,separated')}
      <label class="f"><span>Stage</span><select data-f="stage">${
        STAGES.map((s) => `<option value="${s}" ${s === (t.stage || 'new') ? 'selected' : ''}>${s}</option>`).join('')}</select></label>
      <div style="display:flex;justify-content:flex-end;gap:8px;margin-top:6px">
        <span id="ci-err" class="chan-err" style="flex:1"></span>
        <button id="ci-cancel" class="ghost">Cancel</button>
        <button id="ci-save" class="primary">Save</button>
      </div>
    </div>

    <div id="cc-host"></div>

    <div class="section-h">Follow-ups · ${fus.length}</div>
    ${fus.map((f) => `<div class="fu-row">${dot(t.stage)}<span>${esc(f.note)}</span>
        <span class="due">${esc(String(f.due_at || f.scheduled_for || '').slice(0, 10))}</span>
        <button class="ghost mini fu-done" data-fu="${f.id}">done</button></div>`).join('')}
    <div class="entry">
      <div style="display:flex;gap:6px">
        <input id="fu-note" placeholder="Follow up on…" style="flex:1">
        <input id="fu-due" type="date" style="flex:0 0 140px">
        <button id="fu-add" class="primary">Schedule</button>
      </div>
    </div>

    <div class="section-h">Notes &amp; context · ${ctx.length}</div>
    <div class="entry">
      <textarea id="nt-body" rows="2" placeholder="Log a note, a call, what you talked about…"></textarea>
      <div style="display:flex;justify-content:flex-end;gap:8px;margin-top:6px">
        <select id="nt-kind" style="flex:0 0 110px">
          ${['note', 'call', 'email', 'meeting', 'signal'].map((k) => `<option>${k}</option>`).join('')}
        </select>
        <button id="nt-add" class="primary">Log it</button>
      </div>
    </div>
    ${ctx.length ? ctx.map((e) => `
      <div class="entry">
        <div class="eh"><span class="kind">${esc(e.kind)}</span><span>${rel(e.occurred_at)} ago</span><span>· ${esc(e.source || '')}</span></div>
        <div class="body md">${md(e.content || '')}</div>
      </div>`).join('') : '<div class="empty">Nothing logged yet.</div>'}`;

  el.querySelector('.back').addEventListener('click', (e) => {
    e.preventDefault();
    delete el.dataset.detail;
    if (currentTab === 'queue') loadQueue(false); else renderContacts();
  });

  // Deletion is permanent and takes the notes with it, so it's confirmed by
  // typing the name. NOTE: window.prompt() does not exist in Electron — it
  // silently does nothing — so this is an inline confirmation instead.
  $('#ct-del').addEventListener('click', () => {
    const head = el.querySelector('.detail-head');
    if (head.querySelector('#del-confirm')) return;
    head.insertAdjacentHTML('beforeend', `
      <div id="del-confirm" class="entry danger-box">
        <b style="font-size:13px">Delete ${esc(t.name)} permanently?</b>
        <div style="font-size:12.5px;color:var(--tx2);margin:4px 0 8px">
          Also removes ${ctx.length} note(s) and ${fus.length} follow-up(s). This cannot be undone.
          Type the contact's name to confirm.</div>
        <div style="display:flex;gap:6px">
          <input id="del-name" placeholder="${esc(t.name)}" style="flex:1" autocomplete="off">
          <button id="del-cancel" class="ghost">Cancel</button>
          <button id="del-go" class="primary" style="background:var(--red)">Delete</button>
        </div>
        <div id="del-err" class="chan-err"></div>
      </div>`);
    const input = $('#del-name');
    input.focus();
    $('#del-cancel').addEventListener('click', () => $('#del-confirm').remove());
    const go = async () => {
      if (input.value.trim().toLowerCase() !== String(t.name).trim().toLowerCase()) {
        $('#del-err').textContent = 'That does not match the contact name.';
        return;
      }
      $('#del-go').disabled = true;
      $('#del-go').textContent = 'Deleting…';
      // auto-CRUD only removes the contact row, so clear what hung off it first
      const kill = async (path) => {
        const r = await motion.get(path + '?per_page=300');
        const rows = Array.isArray(r.body) ? r.body : ((r.body || {}).rows || []);
        await Promise.all(rows.filter((x) => Number(x.target_id) === Number(id))
          .map((x) => motion.del(path + '/' + x.id)));
      };
      await kill('/api/context_entries');
      await kill('/api/follow_ups');
      await kill('/api/contact_channels');
      const res = await motion.del('/api/targets/' + id);
      if (res.status >= 300) {
        $('#del-err').textContent = 'Could not delete that contact.';
        $('#del-go').disabled = false; $('#del-go').textContent = 'Delete';
        return;
      }
      delete el.dataset.detail;
      await loadContacts(true);
      renderContacts();
    };
    $('#del-go').addEventListener('click', go);
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') go(); });
  });

  $('#ci-edit').addEventListener('click', () => { $('#ci-view').hidden = true; $('#ci-form').hidden = false; });
  $('#ci-cancel').addEventListener('click', () => { $('#ci-form').hidden = true; $('#ci-view').hidden = false; });
  $('#ci-save').addEventListener('click', async () => {
    const patch = {};
    document.querySelectorAll('#ci-form [data-f]').forEach((i) => { patch[i.dataset.f] = i.value.trim(); });
    const res = await motion.patch('/api/targets/' + id, patch);
    if (res.status >= 300) { $('#ci-err').textContent = 'Could not save.'; return; }
    await loadContacts(true);
    openBrief(id);
  });

  $('#nt-add').addEventListener('click', async () => {
    const content = $('#nt-body').value.trim();
    if (!content) return;
    await motion.post('/api/context_entries', { target_id: id, kind: $('#nt-kind').value, content, source: 'manual' });
    await motion.patch('/api/targets/' + id, { last_touch: new Date().toISOString() }).catch(() => {});
    openBrief(id);
  });

  $('#fu-add').addEventListener('click', async () => {
    const note = $('#fu-note').value.trim();
    if (!note) return;
    const due = $('#fu-due').value;
    await motion.post('/api/follow_ups', {
      target_id: id, note, status: 'open', source: 'manual',
      due_at: due ? due + 'T09:00:00Z' : new Date(Date.now() + 3 * 864e5).toISOString(),
    });
    openBrief(id);
  });

  document.querySelectorAll('.fu-done').forEach((b) => b.addEventListener('click', async () => {
    await motion.patch('/api/follow_ups/' + b.dataset.fu, { status: 'done', completed_at: new Date().toISOString() });
    openBrief(id);
  }));

  loadChannelsFor(id).then((rows) => {
    const host = $('#cc-host');
    if (!host) return;
    host.innerHTML = renderChannelBox(id, rows);
    wireChannelBox(id);
  });
}

// "Today" — the daily task list. Follow-ups bucketed by when they're due and
// labelled with the person, because the unit of work here is a person, not a
// ticket. Overdue first: those are the ones actually costing you something.
async function loadQueue(soft) {
  const el = $('#db-body');
  if (soft && el.dataset.detail) return;
  if (!soft) { delete el.dataset.detail; el.innerHTML = '<div class="empty">Loading…</div>'; }

  const { status, body } = await motion.get('/api/follow_ups?per_page=300&orderBy=due_at:asc');
  if (status !== 200) { el.innerHTML = '<div class="empty">Could not load your follow-ups.</div>'; return; }
  const rows = (Array.isArray(body) ? body : (body.rows || []))
    .filter((f) => f.status === 'open' || f.status === 'queued');

  const byId = {};
  for (const c of contacts) byId[c.id] = c;
  const day = (s) => String(s || '').slice(0, 10);
  const today = new Date().toISOString().slice(0, 10);
  const weekOut = new Date(Date.now() + 7 * 864e5).toISOString().slice(0, 10);

  const buckets = { Overdue: [], Today: [], 'This week': [], Later: [], 'No date': [] };
  for (const f of rows) {
    const d = day(f.due_at || f.scheduled_for);
    if (!d) buckets['No date'].push(f);
    else if (d < today) buckets.Overdue.push(f);
    else if (d === today) buckets.Today.push(f);
    else if (d <= weekOut) buckets['This week'].push(f);
    else buckets.Later.push(f);
  }

  const row = (f) => {
    const c = byId[f.target_id] || {};
    return `<div class="fu-row task">
      <button class="ghost mini tick" data-fu="${f.id}" title="Mark done">✓</button>
      <button class="who-link" data-go="${f.target_id}">${esc(c.name || 'Unknown')}</button>
      <span class="note">${esc(f.note)}</span>
      <span class="due">${esc(day(f.due_at || f.scheduled_for) || '—')}</span>
    </div>`;
  };

  const open = Object.values(buckets).reduce((n, b) => n + b.length, 0);
  el.innerHTML = Object.entries(buckets).filter(([, b]) => b.length).map(([k, b]) =>
    `<div class="section-h" ${k === 'Overdue' ? 'style="color:var(--red)"' : k === 'Today' ? 'style="color:var(--amber)"' : ''}>${k} · ${b.length}</div>`
    + b.map(row).join('')).join('')
    || '<div class="empty">Nothing scheduled.<br>Open a contact and add a follow-up, or ask the agent.</div>';

  if (open) el.insertAdjacentHTML('afterbegin',
    `<div class="ib-filters"><span class="ib-chip on">${open} open</span></div>`);

  el.querySelectorAll('[data-go]').forEach((b) =>
    b.addEventListener('click', () => openBrief(Number(b.dataset.go))));
  el.querySelectorAll('.tick').forEach((b) => b.addEventListener('click', async () => {
    await motion.patch('/api/follow_ups/' + b.dataset.fu, { status: 'done', completed_at: new Date().toISOString() });
    loadQueue(false);
  }));
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
  engines = await motion.detectEngines();
  $('#set-email').textContent = cfg.email || '(not signed in)';
  const engSel = $('#set-engine');
  engSel.value = cfg.engine || 'byok';
  engSel.querySelector('[value="claude-code"]').disabled = !engines.claudeCode;
  engSel.querySelector('[value="claude-code"]').textContent = engines.claudeCode
    ? `Claude Code (my subscription) — ${engines.claudeCode}` : 'Claude Code — not installed';
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
  await motion.setEngine($('#set-engine').value);
  cfg = await motion.cfg();
  $('#engine-badge').textContent = engineLabel();
  $('#modal').hidden = true;
});
$('#set-logout').addEventListener('click', async () => { await motion.logout(); location.reload(); });

boot();
