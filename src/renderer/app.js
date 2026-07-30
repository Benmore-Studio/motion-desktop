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
  cfg.engine === 'claude-code' ||
  (cfg.engine === 'byok' && cfg.hasKey) ||
  (cfg.engine === 'platform' && cfg.platformReady);

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
    const plat = cfg.platformReady;
    box.innerHTML = wdots() + `
      <div class="engine-card ${plat ? '' : 'disabled'}" ${plat ? 'data-engine="platform"' : ''}>
        <div class="ec-head"><b>Blitz credits</b><span class="ec-tag ${plat ? 'ok' : ''}">${plat ? 'Recommended · $5 free to start' : 'Almost live'}</span></div>
        <span>No key, no setup — works instantly. Powered by Claude Opus 5 · $5 free to start.</span>
      </div>
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
    let chosen = cfg.engine || (plat ? 'platform' : cc ? 'claude-code' : 'byok');
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
    sum(true, 'Agent', cfg.engine === 'platform' ? 'Blitz credits · $5 free to start'
      : cfg.engine === 'claude-code' ? 'Claude Code (your subscription)'
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
  if (cfg.engine === 'platform') return 'Blitz credits';
  return cfg.engine === 'claude-code'
    ? 'Claude Code'
    : (cfg.model || 'claude-opus-5').replace('claude-', '') + ' · key';
}
async function enterApp() {
  $('#gate').hidden = true; $('#app').hidden = false;
  $('#engine-badge').textContent = engineLabel();
  $('#engine-badge').classList.add('ok');
  loadContacts();
  refreshBalance();
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
  else if (currentTab === 'inbox') loadInbox(soft);
  else loadMeetings(soft);
}
function startDataPoll() {
  if (dataPoll) clearInterval(dataPoll);
  dataPoll = setInterval(() => { if (!document.hidden) refreshActiveTab(true); }, 7000);
}
document.addEventListener('visibilitychange', () => { if (!document.hidden) refreshActiveTab(true); });

// ---------------- billing (wallet chip + modal) ----------------
let walletCache = null;
const fmtCents = (c) => '$' + (Number(c || 0) / 100).toFixed(2);

async function refreshBalance() {
  const { status, body } = await motion.get('/api/billing/wallet');
  if (status !== 200) { $('#balance-chip').hidden = true; return null; }
  walletCache = body;
  const chip = $('#balance-chip');
  chip.hidden = false;
  chip.textContent = '⚡ ' + fmtCents(body.balance_cents);
  chip.classList.toggle('ok', body.balance_cents > 0);
  return body;
}

const LEDGER_ICON = { grant: '🎁', topup: '＋', ai: '✨', channel: '✉️' };
function openBilling() {
  $('#billing-modal').hidden = false;
  $('#bill-err').textContent = '';
  const render = (w) => {
    if (!w) return;
    $('#bill-balance').textContent = fmtCents(w.balance_cents);
    const rows = Array.isArray(w.ledger) ? w.ledger : [];
    $('#bill-ledger').innerHTML = rows.length ? rows.map((r) => `
      <div style="display:flex;gap:8px;align-items:center;padding:6px 2px;border-bottom:1px solid var(--border)">
        <span>${LEDGER_ICON[r.kind] || '·'}</span>
        <span style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--tx2)">${esc(r.meta || r.kind)}</span>
        <span style="color:${r.cents < 0 ? 'var(--tx2)' : 'var(--green, #4cb782)'};font-variant-numeric:tabular-nums">${r.cents < 0 ? '−' : '+'}${fmtCents(Math.abs(r.cents))}</span>
      </div>`).join('') : '<div style="color:var(--tx3)">No activity yet.</div>';
  };
  render(walletCache);
  refreshBalance().then(render);
}
$('#balance-chip').addEventListener('click', openBilling);
$('#bill-close').addEventListener('click', () => { $('#billing-modal').hidden = true; });
document.querySelectorAll('#billing-modal [data-pack]').forEach((b) => b.addEventListener('click', async () => {
  b.disabled = true; $('#bill-err').textContent = '';
  const { status, body } = await motion.post('/api/billing/topup', { pack: b.dataset.pack });
  if (status === 200 && body.url) motion.openUrl(body.url);
  else $('#bill-err').textContent = (body && body.error) || 'Could not start checkout.';
  b.disabled = false;
}));

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
      if (cfg.engine === 'platform') {
        const before = walletCache ? walletCache.balance_cents : null;
        refreshBalance().then((w) => {
          if (!w) return;
          const burned = before != null ? before - w.balance_cents : null;
          if (burned > 0) $('#statusline').innerHTML += ` · <span class="cost">−${fmtCents(burned)} credits</span>`;
        });
      } else if (ev.cost != null) bits.push(`<span class="cost">$${Number(ev.cost).toFixed(4)}</span>`);
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
  await Promise.all([refreshActiveTab(false), refreshBalance()]);
  setTimeout(() => b.classList.remove('spin'), 350);
});

document.querySelectorAll('.tab').forEach((t) => t.addEventListener('click', () => {
  document.querySelectorAll('.tab').forEach((x) => x.classList.toggle('on', x === t));
  currentTab = t.dataset.tab;
  if (currentTab === 'contacts') loadContacts();
  else if (currentTab === 'queue') loadQueue();
  else if (currentTab === 'inbox') loadInbox();
  else loadMeetings();
}));


// ---- Inbox tab: one aggregated feed across every connected channel ----
// Each channel is a separate Unipile call, so they're fetched in parallel and
// merged client-side, newest first. Rows resolved to a contact deep-link to the
// dossier; unresolved ones are flagged as leads not yet in the Rolodex.
const CH_GLYPH = { email: '\u2709\uFE0F', whatsapp: '\uD83D\uDCAC', linkedin: 'in', imessage: '\uD83D\uDCF1' };
let inboxFilter = 'all';
let inboxCache = [];

// Each channel is a separate multi-call round trip to Unipile, so this is slow
// by nature. Two things matter: never let a late response overwrite whatever
// the user navigated to (that was "it kicks me out after a bit"), and paint
// each channel the moment it lands rather than waiting for the slowest.
let inboxGen = 0;
let inboxLoading = false;
let inboxLoadedAt = 0;
const INBOX_MIN_AGE_MS = 45000;   // Unipile round trips are slow; don't refetch on the 7s tick
async function loadInbox(soft) {
  const el = $('#db-body');
  if (soft && (el.dataset.detail || el.dataset.thread)) return;
  // A load takes longer than the poll interval, so an unguarded poll kept
  // superseding the in-flight request and the list never rendered at all.
  if (soft && (inboxLoading || Date.now() - inboxLoadedAt < INBOX_MIN_AGE_MS)) return;
  const gen = ++inboxGen;
  inboxLoading = true;
  const stale = () => gen !== inboxGen || currentTab !== 'inbox' || !!$('#db-body').dataset.detail;

  if (!soft) {
    delete el.dataset.detail;
    el.innerHTML = '<div class="empty">Loading your inboxes…</div>';
  }

  await buildChannelIndex().catch(() => {});
  const { status, body } = await motion.get('/api/channel_accounts');
  if (stale()) { inboxLoading = false; return; }
  const rows = status === 200 ? (Array.isArray(body) ? body : (body.rows || [])) : [];
  const chans = [...new Set(rows.filter((r) => r.status === 'connected').map((r) =>
    r.provider === 'LINKEDIN' ? 'linkedin' : r.provider === 'WHATSAPP' ? 'whatsapp' : 'email'))];



  const acc = [];
  let done = 0;
  const total = chans.length + 1;   // +1 for the local iMessage read

  // iMessage is read from the Mac itself, not Unipile — merged in as a peer.
  const imsg = motion.imessageInbox(300).then((r) => {
    done++;
    if (stale()) return;
    imessageNeedsAccess = !!(r && r.needsAccess);
    if (r && r.ok && Array.isArray(r.messages)) {
      for (const m of r.messages) acc.push({ ...m, channel: 'imessage' });
    }
    acc.sort((a, b) => String(b.at || '').localeCompare(String(a.at || '')));
    inboxCache = resolveLocal(acc.slice());
    renderInbox(done < total ? total - done : 0);
  }).catch(() => { done++; });

  await Promise.all([imsg].concat(chans.map((ch) => motion.get('/api/inbox?channel=' + ch + '&limit=30')
    .catch(() => null)
    .then((r) => {
      done++;
      if (stale()) return;
      if (r && r.status === 200 && r.body && Array.isArray(r.body.messages)) {
        for (const m of r.body.messages) acc.push({ ...m, channel: ch });
      }
      acc.sort((a, b) => String(b.at || '').localeCompare(String(a.at || '')));
      inboxCache = resolveLocal(acc.slice());
      renderInbox(done < total ? total - done : 0);
    }))));
  inboxLoading = false;
  inboxLoadedAt = Date.now();
}



let imessageNeedsAccess = false;
let channelIndex = null;   // norm -> target_id, built from contact_channels

async function buildChannelIndex() {
  const { status, body } = await motion.get('/api/contact_channels?per_page=500');
  const idx = new Map();
  if (status === 200) {
    const rows = Array.isArray(body) ? body : (body.rows || []);
    for (const r of rows) if (r.norm) idx.set(String(r.norm).toLowerCase(), r.target_id);
  }
  for (const c of contacts) {
    if (c.phone) idx.set(normCh('phone', c.phone), c.id);
    if (c.email) idx.set(normCh('email', c.email), c.id);
  }
  channelIndex = idx;
  return idx;
}

// iMessage rows are resolved on this side (they never touch the server), using
// the same normalisation the backend matches on.
function resolveLocal(list) {
  if (!channelIndex) return list;
  for (const m of list) {
    if (m.target_id || !m.handle) continue;
    const k = /@/.test(m.handle) ? normCh('email', m.handle) : normCh('phone', m.handle);
    const hit = channelIndex.get(k);
    if (hit) m.target_id = hit;
  }
  return list;
}

// Collapse the raw message feed into conversations. A chat with one person (or
// one group) is ONE row showing its latest message — like Messages — and you
// click in to read the thread. Email threads group by thread id when the
// provider gives one, else by the counterpart's address.
function convKey(m) {
  if (m.chat_id) return m.channel + ':' + m.chat_id;
  if (m.handle) return m.channel + ':h:' + String(m.handle).toLowerCase();
  return m.channel + ':who:' + String(m.who || '?').toLowerCase();
}

function conversations(list) {
  const byKey = new Map();
  for (const m of list) {
    const k = convKey(m);
    let c = byKey.get(k);
    if (!c) {
      c = { key: k, channel: m.channel, is_group: !!m.is_group, group_name: m.group_name || '',
            target_id: 0, msgs: [], names: new Set() };
      byKey.set(k, c);
    }
    c.msgs.push(m);
    if (m.target_id) c.target_id = m.target_id;
    if (m.direction === 'in' && m.who) c.names.add(m.who);
    if (m.is_group) { c.is_group = true; if (m.group_name) c.group_name = m.group_name; }
  }
  const out = [];
  for (const c of byKey.values()) {
    c.msgs.sort((a, b) => String(a.at || '').localeCompare(String(b.at || '')));
    c.last = c.msgs[c.msgs.length - 1];
    c.title = c.is_group
      ? (c.group_name || 'Group chat')
      : ([...c.names][0] || c.last.who
         || (c.channel === 'linkedin' ? 'LinkedIn contact'
             : c.channel === 'whatsapp' ? 'WhatsApp contact'
             : c.channel === 'imessage' ? (c.last.handle || 'iMessage') : 'Unknown sender'));
    out.push(c);
  }
  out.sort((a, b) => String(b.last.at || '').localeCompare(String(a.last.at || '')));
  return out;
}

function openThread(key) {
  const el = $('#db-body');
  const c = conversations(inboxCache).find((x) => x.key === key);
  if (!c) return;
  el.dataset.detail = '1';
  el.dataset.thread = key;
  const bubbles = c.msgs.map((m) => `
    <div class="th-msg ${m.direction === 'out' ? 'out' : 'in'}">
      ${c.is_group && m.direction === 'in' ? `<div class="th-from">${esc(m.who || 'someone')}</div>` : ''}
      <div class="th-bubble">${esc(m.subject ? m.subject + '\n' : '')}${esc(m.text || '(no text)')}</div>
      <div class="th-at">${rel(m.at)}</div>
    </div>`).join('');

  el.innerHTML = `
    <a class="back" href="#">← Inbox</a>
    <div class="detail-head">
      <h2>${esc(c.title)}</h2>
      <div class="meta">
        ${c.is_group ? 'Group · ' : ''}${esc(c.channel)} · ${c.msgs.length} message${c.msgs.length === 1 ? '' : 's'}
      </div>
      <div style="margin-top:7px">
        ${c.target_id ? `<button class="ghost" id="th-contact">Open contact →</button>`
          : (!c.is_group ? `<button class="ghost" id="th-assign">Who is this? Assign →</button>` : '')}
      </div>
    </div>
    <div class="th-wrap">${bubbles}</div>`;

  el.querySelector('.back').addEventListener('click', (e) => {
    e.preventDefault(); delete el.dataset.detail; delete el.dataset.thread; renderInbox();
  });
  $('#th-contact')?.addEventListener('click', () => { delete el.dataset.thread; openBrief(c.target_id); });
  $('#th-assign')?.addEventListener('click', () => { delete el.dataset.thread; openAssign(c.last); });
  const w = el.querySelector('.th-wrap');
  if (w) w.scrollTop = w.scrollHeight;
}

function renderInbox(pending) {
  const el = $('#db-body');
  delete el.dataset.detail;
  delete el.dataset.thread;
  const all = conversations(inboxCache);
  const list = inboxFilter === 'all' ? all : all.filter((c) => c.channel === inboxFilter);
  const chips = ['all', 'email', 'whatsapp', 'imessage', 'linkedin'].map((c) =>
    `<button class="ib-chip ${c === inboxFilter ? 'on' : ''}" data-ibf="${c}">${
      c === 'all' ? 'All' : (CH_GLYPH[c] || '') + ' ' + (c === 'imessage' ? 'iMessage' : c.charAt(0).toUpperCase() + c.slice(1))}</button>`).join('');

  const named = (c) => !!(c.title && !/^(Unknown sender|LinkedIn contact|WhatsApp contact)$/.test(c.title));
  const unmatched = list.filter((c) => !c.target_id && !c.is_group && named(c)).length;

  el.innerHTML = `<div class="ib-filters">${chips}</div>` +
    (imessageNeedsAccess ? `<div class="entry" style="padding:11px;margin-bottom:8px">
       <b style="font-size:13px">iMessage isn't readable yet</b>
       <div style="font-size:12.5px;color:var(--tx2);margin:4px 0 8px">
         macOS keeps your Messages history behind Full Disk Access. Grant it to Blitz,
         then quit and reopen the app and your texts appear here with everything else.</div>
       <button id="ib-grant" class="primary" style="padding:6px 12px">Open Full Disk Access…</button>
     </div>` : '') +
    (pending ? `<div class="section-h">Loading ${pending} more channel(s)…</div>` : '') +
    (unmatched ? `<div class="section-h" style="color:var(--amber)">${unmatched} conversation(s) not linked to a contact</div>` : '') +
    (list.length ? list.map((c) => `
      <button class="ib-row ${c.target_id ? '' : 'unmatched'}" data-ibk="${esc(c.key)}">
        <span class="ch ${c.channel === 'linkedin' ? 'li' : ''}">${CH_GLYPH[c.channel] || '\u2691'}</span>
        <span class="mid">
          <span class="who">${c.is_group ? '<span class="grp">group</span> ' : ''}${esc(c.title)}${
            c.msgs.length > 1 ? `<span class="dirn">${c.msgs.length} messages</span>` : ''}${
            c.target_id || c.is_group || !named(c) ? '' : '<span class="newlead">not linked</span>'}</span>
          <span class="snip">${c.last.direction === 'out' ? 'You: ' : (c.is_group && c.last.who ? esc(c.last.who) + ': ' : '')}${
            esc(c.last.subject ? c.last.subject + ' — ' + (c.last.text || '') : (c.last.text || '(no text)'))}</span>
        </span>
        <span class="when">${rel(c.last.at)}</span>
      </button>`).join('') : '<div class="empty">Nothing here yet.</div>');

  $('#ib-grant')?.addEventListener('click', () => motion.imessageGrant());
  el.querySelectorAll('[data-ibf]').forEach((b) => b.addEventListener('click', () => {
    inboxFilter = b.dataset.ibf; renderInbox();
  }));
  el.querySelectorAll('[data-ibk]').forEach((b) => b.addEventListener('click', () => openThread(b.dataset.ibk)));
}

// An unmatched sender is the interesting case: either they're already a contact
// under a different handle (link it, so it matches forever after) or they're a
// new lead. Both write a contact_channels row — that's the organising spine.
function chKindFor(m) {
  if (m.channel === 'email') return 'email';
  if (m.channel === 'whatsapp') return 'whatsapp';
  if (m.channel === 'linkedin') return 'linkedin';
  return 'other';
}

function openAssign(m) {
  if (!m) return;
  const el = $('#db-body');
  el.dataset.detail = '1';
  const kind = chKindFor(m);
  const handle = m.handle || '';
  el.innerHTML = `
    <a class="back" href="#">← Inbox</a>
    <div class="detail-head">
      <h2>Who is this?</h2>
      <div class="meta">${esc(m.who || 'Unnamed sender')} · ${esc(kind)}${handle ? ' · ' + esc(handle) : ''}</div>
      <div class="ctx-quote" style="margin-top:8px;font-size:12.5px;color:var(--tx2)">${esc((m.text || '').slice(0, 220))}</div>
    </div>
    <div class="section-h">Link to an existing contact</div>
    <input id="as-filter" placeholder="Filter contacts…" style="margin-bottom:8px">
    <div id="as-list"></div>
    <div class="section-h">Or create a new contact</div>
    <div class="entry" style="padding:12px">
      <div style="display:flex;gap:6px">
        <input id="as-name" value="${esc(m.who && m.who !== 'Unknown' ? m.who : '')}" placeholder="Full name" style="flex:1">
        <button id="as-new" class="primary" style="padding:6px 14px">Create</button>
      </div>
      <div id="as-err" class="chan-err"></div>
    </div>`;

  const paint = (q) => {
    const rows = contacts.filter((c) => !q || (c.name + ' ' + (c.company || '')).toLowerCase().includes(q.toLowerCase())).slice(0, 40);
    $('#as-list').innerHTML = rows.length ? rows.map((c) => `
      <button class="list-row" data-as="${c.id}">${dot(c.stage)}<span class="nm">${esc(c.name)}</span>
        <span class="sub">${esc(c.company || '')}</span><span class="right">link →</span></button>`).join('')
      : '<div class="empty">No matching contacts.</div>';
    $('#as-list').querySelectorAll('[data-as]').forEach((b) =>
      b.addEventListener('click', () => linkHandle(Number(b.dataset.as), m, kind, handle)));
  };
  paint('');
  $('#as-filter').addEventListener('input', function () { paint(this.value.trim()); });
  el.querySelector('.back').addEventListener('click', (e) => { e.preventDefault(); delete el.dataset.detail; renderInbox(); });
  $('#as-new').addEventListener('click', async () => {
    const name = $('#as-name').value.trim();
    if (!name) { $('#as-err').textContent = 'Give them a name.'; return; }
    const res = await motion.post('/api/targets', { name, stage: 'engaged' });
    if (res.status >= 300) { $('#as-err').textContent = 'Could not create that contact.'; return; }
    const id = res.body && (res.body.id || (res.body.rows && res.body.rows[0] && res.body.rows[0].id));
    if (!id) { $('#as-err').textContent = 'Created, but no id came back.'; return; }
    linkHandle(id, m, kind, handle);
  });
}

async function linkHandle(targetId, m, kind, handle) {
  if (handle) {
    await motion.post('/api/contact_channels', {
      target_id: targetId, kind, value: handle, norm: normCh(kind, handle),
      is_primary: false, source: 'inbound',
    });
  }
  // File the message we were looking at so the contact has the history.
  await motion.post('/api/context_entries', {
    target_id: targetId,
    kind: m.channel === 'email' ? 'email' : 'note',
    content: (m.subject ? m.subject + ' — ' : '') + (m.text || ''),
    source: 'inbound',
  }).catch(() => {});
  delete $('#db-body').dataset.detail;
  await loadContacts(true);
  await loadInbox(false);
  openBrief(targetId);
}

// An inbound message from someone unknown is a lead — capture them in one click.
async function addToRolodex(m) {
  if (!m) return;
  const body = { name: m.who || 'Unknown', stage: 'engaged' };
  if (m.channel === 'email' && /@/.test(m.who || '')) body.email = m.who;
  const res = await motion.post('/api/targets', body);
  if (res.status < 300) {
    const id = res.body && (res.body.id || (res.body.rows && res.body.rows[0] && res.body.rows[0].id));
    await motion.post('/api/append', {
      target: body.name,
      content: (m.channel === 'email' ? 'Email' : m.channel === 'whatsapp' ? 'WhatsApp' : 'LinkedIn')
        + ' from ' + (m.who || 'them') + ': ' + (m.text || ''),
      kind: m.channel === 'email' ? 'email' : 'note',
    }).catch(() => {});
    loadContacts(true);
    if (id) openBrief(id); else loadInbox(false);
  }
}

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


// ---------------- contact channels (how to reach someone) ----------------
// A contact has many identities: several emails, a phone, LinkedIn, WhatsApp,
// iMessage. `norm` is the matching key and MUST match the server's rule —
// lowercased email, last-10 phone digits, bare linkedin handle — otherwise an
// assigned handle won't resolve on the next inbound message.
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
  const { status, body } = await motion.get('/api/contact_channels?per_page=100');
  if (status !== 200) return [];
  const rows = Array.isArray(body) ? body : (body.rows || []);
  return rows.filter((r) => Number(r.target_id) === Number(targetId));
}

function renderChannelBox(targetId, rows) {
  const list = rows.length ? rows.map((c) => `
    <div class="chan-row">
      <span class="prov">${CH_ICON[c.kind] || '\u2691'} ${esc(c.kind)}</span>
      <span class="who">${esc(c.value)}</span>
      ${c.is_primary ? '<span class="chan-badge ok">primary</span>' : `<button class="ghost cc-prim" data-id="${c.id}" data-kind="${esc(c.kind)}" style="padding:1px 7px;font-size:11px">make primary</button>`}
      <button class="ghost cc-del" data-id="${c.id}" title="Remove" style="padding:1px 7px">\u00d7</button>
    </div>`).join('') : '<span class="chan-empty">No channels yet — add one so inbound messages match this person.</span>';

  return `<div class="section-h">Reachable on</div>
    <div class="entry" style="padding:12px">
      <div class="chan-list">${list}</div>
      <div style="display:flex;gap:6px;margin-top:8px">
        <select id="cc-kind" style="flex:0 0 110px">${CH_KINDS.map((k) => `<option value="${k}">${k}</option>`).join('')}</select>
        <input id="cc-val" placeholder="email, phone, or profile URL" style="flex:1">
        <button id="cc-add" class="primary" style="padding:6px 14px">Add</button>
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
    if (!norm) { $('#cc-err').textContent = 'That does not look usable for matching.'; return; }
    const rows = await loadChannelsFor(targetId);
    const res = await motion.post('/api/contact_channels', {
      target_id: Number(targetId), kind, value, norm,
      is_primary: !rows.some((r) => r.kind === kind), source: 'manual',
    });
    if (res.status >= 300) { $('#cc-err').textContent = (res.body && res.body.error) || 'Could not add that.'; return; }
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
    <a class="back" href="#">← ${currentTab === 'inbox' ? 'Inbox' : currentTab === 'queue' ? 'Queue' : 'All contacts'}</a>
    <div class="detail-head">
      <h2>${esc(t.name)}</h2>
      <div class="meta">${esc([t.title, t.company].filter(Boolean).join(' · '))}</div>
      <div style="margin-top:7px">
        <span class="chip">${esc(t.stage || 'new')}</span>
        ${t.email ? `<span class="chip">${esc(t.email)}</span>` : ''}
        ${t.phone ? `<span class="chip">${esc(t.phone)}</span>` : ''}
      </div>
    </div>
    <div id="cc-host"></div>
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
  el.querySelector('.back').addEventListener('click', (e) => {
    e.preventDefault();
    delete el.dataset.detail;
    // Go back where they actually came from, not always to Contacts.
    if (currentTab === 'inbox') renderInbox();
    else if (currentTab === 'queue') loadQueue(false);
    else renderContacts();
  });
  loadChannelsFor(id).then((rows) => {
    const host = $('#cc-host');
    if (!host) return;
    host.innerHTML = renderChannelBox(id, rows);
    wireChannelBox(id);
  });
}

async function loadQueue(soft) {
  const el = $('#db-body');
  if (soft && el.dataset.detail) return;
  if (!soft) { delete el.dataset.detail; el.innerHTML = '<div class="empty">Loading…</div>'; }
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
// ---- connected accounts (Settings) ----
const PROV_LABEL = { GOOGLE: 'Email', OUTLOOK: 'Outlook', LINKEDIN: 'LinkedIn', WHATSAPP: 'WhatsApp' };
let chanPoll = null;

async function loadChannels() {
  const box = $('#set-channels');
  if (!box) return;
  const { status, body } = await motion.get('/api/channel_accounts');
  if (status !== 200) { box.innerHTML = '<span class="chan-empty">Could not load your accounts.</span>'; return; }
  const rows = Array.isArray(body) ? body : (body.rows || []);
  if (!rows.length) { box.innerHTML = '<span class="chan-empty">Nothing connected yet — add one below.</span>'; return; }
  box.innerHTML = rows.map((r) => {
    const paused = r.status === 'paused';
    return `<div class="chan-row">
      <span class="prov">${esc(PROV_LABEL[r.provider] || r.provider || '—')}</span>
      <span class="who">${esc(r.display || '')}</span>
      <span class="chan-badge ${paused ? 'paused' : 'ok'}">${paused ? 'paused' : 'connected'}</span>
    </div>`;
  }).join('');
}

document.querySelectorAll('#modal [data-conn]').forEach((b) => b.addEventListener('click', async () => {
  b.disabled = true; const old = b.textContent; b.textContent = 'Opening…';
  $('#set-chan-err').textContent = '';
  const { status, body } = await motion.post('/api/channels/connect', { provider: b.dataset.conn });
  if (status === 200 && body.url) {
    motion.openUrl(body.url);
    $('#set-chan-err').textContent = 'Finish connecting in your browser — this list updates automatically.';
    // Poll while the user completes the hosted auth wizard.
    if (chanPoll) clearInterval(chanPoll);
    let ticks = 0;
    chanPoll = setInterval(() => {
      if (++ticks > 60 || $('#modal').hidden) { clearInterval(chanPoll); chanPoll = null; return; }
      loadChannels();
    }, 3000);
  } else {
    $('#set-chan-err').textContent = (body && body.error) || 'Could not start the connection.';
  }
  b.disabled = false; b.textContent = old;
}));

$('#settings-btn').addEventListener('click', async () => {
  cfg = await motion.cfg();
  loadChannels();
  engines = await motion.detectEngines();
  $('#set-email').textContent = cfg.email || '(not signed in)';
  const engSel = $('#set-engine');
  engSel.value = cfg.engine || 'byok';
  engSel.querySelector('[value="platform"]').disabled = !cfg.platformReady;
  engSel.querySelector('[value="platform"]').textContent = cfg.platformReady
    ? 'Blitz credits (no key needed)' : 'Blitz credits — almost live';
  engSel.querySelector('[value="claude-code"]').disabled = !engines.claudeCode;
  engSel.querySelector('[value="claude-code"]').textContent = engines.claudeCode
    ? `Claude Code (my subscription) — ${engines.claudeCode}` : 'Claude Code — not installed';
  $('#set-model').value = cfg.model || 'claude-opus-5';
  $('#set-key').value = '';
  $('#set-key').placeholder = cfg.hasKey ? '••••••••  (saved — paste to replace)' : 'sk-ant-…';
  $('#modal').hidden = false;
});
$('#set-cancel').addEventListener('click', () => {
  $('#modal').hidden = true;
  if (chanPoll) { clearInterval(chanPoll); chanPoll = null; }
});
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
