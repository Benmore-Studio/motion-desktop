// Blitz Desktop — main process.
// Owns: window, config (userData/config.json), Blitz OAuth (PKCE), the agent
// engine (Claude Agent SDK ↔ Blitz MCP), and REST proxying for the context pane.
const { app, BrowserWindow, ipcMain, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const http = require('http');
const crypto = require('crypto');
const { execFile, spawn } = require('child_process');
const { MeterShim } = require('./meter-shim');
const imessage = require('./imessage');

const SYSTEM_PROMPT =
  'You are Blitz, the user\'s AI Rolodex assistant, embedded in the Blitz desktop app by Benmore Technologies. ' +
  'Use the blitz MCP tools for everything: log context (add_context), look people up (search, list_targets, get_brief), ' +
  'manage the follow-up queue (get_agenda, get_queue, queue_followup, start_sequence, due_sends, register_reply), ' +
  'and reach out (send_email, send_imessage — default to draft mode unless the user explicitly says send). ' +
  'IMPORTANT: when send_imessage returns an osascript block, THIS DESKTOP APP EXECUTES IT AUTOMATICALLY on ' +
  'the user\'s Mac. You have no shell and you do not need one — never try to run it, never ask the user to ' +
  'paste it into Terminal, and never say the send failed because you lack a Bash tool. Just confirm it sent. ' +
  'Channel tools: send_email, send_whatsapp, send_linkedin, send_imessage — each takes mode=send to dispatch now ' +
  'or mode=draft to file for review. queue_followup ONLY schedules a future reminder; it never sends anything, so ' +
  'never reach for it when the user asks you to send something now. ' +
  'To READ real conversations (\'what are my recent WhatsApp/LinkedIn/email messages?\') use the inbox tool — ' +
  'search only covers CRM notes, so never claim you cannot see a channel before trying inbox. ' +
  'Be concise. After acting, summarize what you did in one or two sentences.';
const BUILTIN_TOOLS_OFF = ['Bash', 'Read', 'Write', 'Edit', 'Glob', 'Grep', 'WebFetch', 'WebSearch', 'NotebookEdit'];

// Canonical host for new installs; a saved cfg.base still wins, so existing
// sign-ins on the old motion-v9t7fg URL keep working (same app, same data).
const DEFAULT_BASE = process.env.BLITZ_URL || process.env.MOTION_URL || 'https://www.getblitz.app';
// Platform AI ("Blitz credits"): the blitz-meter Benmore app, fronted locally
// by MeterShim (see meter-shim.js for why the shim is needed). Override with
// BLITZ_METER_URL or `meter` in userData/config.json.
const DEFAULT_METER = process.env.BLITZ_METER_URL || 'https://blitz-meter-v6fnp2.benmore.ai';
const meterUrl = (cfg) => (cfg.meter || DEFAULT_METER).replace(/\/$/, '');
const shim = new MeterShim();

let win = null;

// ---------- config ----------
const cfgPath = () => path.join(app.getPath('userData'), 'config.json');
function loadCfg() {
  try { return JSON.parse(fs.readFileSync(cfgPath(), 'utf8')); } catch { return {}; }
}
function saveCfg(cfg) {
  fs.mkdirSync(path.dirname(cfgPath()), { recursive: true });
  fs.writeFileSync(cfgPath(), JSON.stringify(cfg, null, 2), { mode: 0o600 });
}
const baseUrl = (cfg) => (cfg.base || DEFAULT_BASE).replace(/\/$/, '');

// ---------- tiny fetch helpers ----------
async function jfetch(url, opts = {}) {
  const r = await fetch(url, opts);
  const text = await r.text();
  let body; try { body = JSON.parse(text); } catch { body = text; }
  return { status: r.status, body };
}
function authed(cfg, extra = {}) {
  return { Authorization: 'Bearer ' + cfg.token, Accept: 'application/json', ...extra };
}

// ---------- OAuth PKCE (same dance as the CLI) ----------
const b64url = (b) => b.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

async function oauthLogin() {
  const cfg = loadCfg();
  const base = baseUrl(cfg);
  const { status, body: meta } = await jfetch(base + '/.well-known/oauth-authorization-server');
  if (status !== 200) throw new Error('Cannot reach Blitz OAuth server at ' + base);

  // Local callback server on a random port.
  const srv = http.createServer();
  await new Promise((res) => srv.listen(0, '127.0.0.1', res));
  const port = srv.address().port;
  const redirect = `http://127.0.0.1:${port}/callback`;

  // Dynamic client registration (public client, PKCE).
  const { body: reg } = await jfetch(meta.registration_endpoint || base + '/oauth/register', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_name: 'Blitz Desktop', redirect_uris: [redirect],
      grant_types: ['authorization_code'], response_types: ['code'],
      token_endpoint_auth_method: 'none',
    }),
  });
  if (!reg.client_id) { srv.close(); throw new Error('Client registration failed'); }

  const verifier = b64url(crypto.randomBytes(32));
  const challenge = b64url(crypto.createHash('sha256').update(verifier).digest());
  const state = b64url(crypto.randomBytes(16));
  const authUrl = meta.authorization_endpoint + '?' + new URLSearchParams({
    response_type: 'code', client_id: reg.client_id, redirect_uri: redirect,
    code_challenge: challenge, code_challenge_method: 'S256',
    state, scope: '*', resource: base + '/api/mcp',
  });

  const code = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { srv.close(); reject(new Error('Login timed out')); }, 300000);
    srv.on('request', (req, res) => {
      const u = new URL(req.url, `http://127.0.0.1:${port}`);
      if (u.pathname !== '/callback') { res.writeHead(404); res.end(); return; }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end('<html><head><meta charset="utf-8"></head><body style="font-family:system-ui;text-align:center;padding-top:20vh;background:#220710;color:#e4e4e7"><h2>Blitz connected ✓</h2><p style="color:#a67c85">You can close this tab and return to the app.</p></body></html>');
      clearTimeout(timer); srv.close();
      if (u.searchParams.get('state') !== state) return reject(new Error('State mismatch'));
      if (u.searchParams.get('error')) return reject(new Error(u.searchParams.get('error')));
      resolve(u.searchParams.get('code'));
    });
    shell.openExternal(authUrl);
  });

  const { status: ts, body: tok } = await jfetch(meta.token_endpoint, {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code', code, redirect_uri: redirect,
      client_id: reg.client_id, code_verifier: verifier,
    }).toString(),
  });
  if (ts !== 200 || !tok.access_token) throw new Error('Token exchange failed');

  cfg.base = base; cfg.token = tok.access_token;
  const { body: who } = await jfetch(base + '/api/_auth/profile', { headers: authed(cfg) });
  cfg.email = (who && who.email) || '';
  saveCfg(cfg);
  return { email: cfg.email };
}

// ---------- engine detection ----------
function detectClaudeCode() {
  return new Promise((resolve) => {
    execFile('claude', ['--version'], { timeout: 5000 }, (err, stdout) => {
      resolve(err ? null : String(stdout).trim());
    });
  });
}

// ---------- iMessage (native) ----------
// Probe Messages via AppleScript — triggers macOS's one-time Automation prompt.
function imessageCheck() {
  return new Promise((resolve) => {
    execFile('osascript', ['-e', 'tell application "Messages" to get name'], { timeout: 20000 },
      (err, _out, stderr) => resolve(err ? { ok: false, error: String(stderr || err.message).trim() } : { ok: true }));
  });
}
// When a tool result carries a ready-to-run osascript block (send_imessage mode=send),
// the desktop runs it right here — no copy-paste. Cloud drafts it, the Mac sends it.
function maybeExecImessage(text, send) {
  const m = String(text || '').match(/```bash\n(osascript <<'APPLESCRIPT'[\s\S]*?APPLESCRIPT)\n```/);
  if (!m) return false;
  execFile('/bin/bash', ['-c', m[1]], { timeout: 30000 }, (err, _out, stderr) => {
    send(err
      ? { kind: 'imessage_sent', ok: false, error: String(stderr || err.message).trim() }
      : { kind: 'imessage_sent', ok: true });
  });
  return true;
}

// ---------- agent engines ----------
let sessionId = null;
let currentAbort = null;   // BYOK (AbortController)
let currentChild = null;   // Claude Code (child process)

function mcpConfig(cfg) {
  return { blitz: { type: 'http', url: baseUrl(cfg) + '/api/mcp', headers: { Authorization: 'Bearer ' + cfg.token } } };
}
const sendToWin = (ev) => win && win.webContents.send('agent:event', ev);

async function agentSend(prompt) {
  const cfg = loadCfg();
  if (!cfg.token) return sendToWin({ kind: 'done', ok: false, error: 'Not signed in.' });
  const engine = cfg.engine || 'byok';
  if (engine === 'claude-code') return agentSendClaudeCode(cfg, prompt);
  if (engine === 'platform') {
    if (!meterUrl(cfg)) return sendToWin({ kind: 'done', ok: false, error: 'Blitz credits are unavailable — switch engines in Settings for now.' });
    try {
      await shim.start(() => ({ meterUrl: meterUrl(loadCfg()), token: loadCfg().token }));
    } catch (e) {
      return sendToWin({ kind: 'done', ok: false, error: 'Could not start the local Blitz bridge: ' + (e.message || e) });
    }
    return agentSendSdk(cfg, prompt, true);
  }
  if (!cfg.anthropicKey) return sendToWin({ kind: 'done', ok: false, error: 'No API key set — add one in Settings.' });
  return agentSendSdk(cfg, prompt, false);
}

// Modes B + C — the Claude Agent SDK, keyed two ways:
//   BYOK: the user's own Anthropic key, straight to api.anthropic.com.
//   Platform ("Blitz credits"): ANTHROPIC_BASE_URL → the metering proxy,
//   ANTHROPIC_AUTH_TOKEN → the user's Blitz session token. The proxy meters
//   usage and deducts wallet credits (cost × 1.5); no user key involved.
async function agentSendSdk(cfg, prompt, platform) {
  const { query } = await import('@anthropic-ai/claude-agent-sdk');
  const send = sendToWin;
  currentAbort = new AbortController();
  const env = { ...process.env };
  delete env.ANTHROPIC_API_KEY; delete env.ANTHROPIC_BASE_URL; delete env.ANTHROPIC_AUTH_TOKEN;
  if (platform) {
    env.ANTHROPIC_BASE_URL = shim.baseUrl;
    env.ANTHROPIC_AUTH_TOKEN = shim.authToken;
  } else {
    env.ANTHROPIC_API_KEY = cfg.anthropicKey;
  }
  const q = query({
    prompt,
    options: {
      model: cfg.model || 'claude-opus-5',
      env,
      resume: sessionId || undefined,
      abortController: currentAbort,
      includePartialMessages: true,
      systemPrompt: SYSTEM_PROMPT,
      mcpServers: mcpConfig(cfg),
      allowedTools: ['mcp__blitz__*'],
      disallowedTools: BUILTIN_TOOLS_OFF,
      maxTurns: 25,
    },
  });
  try {
    for await (const msg of q) handleAgentMessage(msg, send, true);
  } catch (e) {
    send({ kind: 'done', ok: false, error: String(e && e.message || e) });
  } finally {
    currentAbort = null;
  }
}

// Mode A — the user's installed Claude Code (their subscription, no API key).
function agentSendClaudeCode(cfg, prompt) {
  const send = sendToWin;
  const args = [
    '-p', prompt,
    '--output-format', 'stream-json', '--verbose',
    '--model', cfg.model || 'claude-opus-5',
    '--mcp-config', JSON.stringify({ mcpServers: mcpConfig(cfg) }),
    '--allowedTools', 'mcp__blitz__*',
    '--disallowedTools', BUILTIN_TOOLS_OFF.join(','),
    '--append-system-prompt', SYSTEM_PROMPT,
  ];
  if (sessionId) args.push('--resume', sessionId);
  const child = spawn('claude', args, { env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
  currentChild = child;
  let buf = '', errBuf = '', gotResult = false;
  child.stdout.on('data', (d) => {
    buf += d.toString();
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1);
      if (!line) continue;
      try { const msg = JSON.parse(line); if (msg.type === 'result') gotResult = true; handleAgentMessage(msg, send, false); } catch { /* non-JSON noise */ }
    }
  });
  child.stderr.on('data', (d) => { errBuf += d.toString(); });
  child.on('error', (e) => send({ kind: 'done', ok: false, error: 'Could not start Claude Code: ' + e.message }));
  child.on('close', (code) => {
    currentChild = null;
    if (!gotResult) send({ kind: 'done', ok: code === 0, error: code === 0 ? null : (errBuf.trim().slice(0, 400) || 'Claude Code exited with code ' + code) });
  });
}

// Shared message → UI-event mapping for both engines. `streamed` = deltas
// already arrived as stream_events (SDK), so skip full text blocks to avoid dupes.
function handleAgentMessage(msg, send, streamed) {
  if (msg.type === 'system' && msg.subtype === 'init') {
    sessionId = msg.session_id || sessionId;
  } else if (msg.type === 'stream_event') {
    const ev = msg.event;
    if (ev.type === 'content_block_delta' && ev.delta && ev.delta.type === 'text_delta') {
      send({ kind: 'text', text: ev.delta.text });
    }
  } else if (msg.type === 'assistant' && msg.message && Array.isArray(msg.message.content)) {
    for (const block of msg.message.content) {
      if (block.type === 'tool_use') send({ kind: 'tool_use', name: block.name, input: block.input });
      else if (block.type === 'text' && !streamed) send({ kind: 'text_full', text: block.text });
    }
  } else if (msg.type === 'user' && msg.message && Array.isArray(msg.message.content)) {
    for (const block of msg.message.content) {
      if (block.type === 'tool_result') {
        const text = Array.isArray(block.content)
          ? block.content.filter(c => c.type === 'text').map(c => c.text).join('\n')
          : String(block.content || '');
        send({ kind: 'tool_result', text: text.slice(0, 2000) });
        maybeExecImessage(text, send);   // native iMessage: run the returned command locally
      }
    }
  } else if (msg.type === 'result') {
    sessionId = msg.session_id || sessionId;
    send({
      kind: 'done',
      ok: msg.subtype === 'success',
      usage: msg.usage || null,
      cost: msg.total_cost_usd != null ? msg.total_cost_usd : null,
      error: msg.subtype !== 'success' ? (msg.result || msg.subtype) : null,
    });
  }
}

// ---------- IPC ----------
function registerIpc() {
  ipcMain.handle('cfg:get', () => {
    const c = loadCfg();
    return {
      base: baseUrl(c), email: c.email || '', loggedIn: !!c.token,
      hasKey: !!c.anthropicKey, model: c.model || 'claude-opus-5',
      engine: c.engine || '', onboarded: !!c.onboarded,
      platformReady: !!meterUrl(c),
    };
  });
  ipcMain.handle('cfg:setKey', (_e, key) => { const c = loadCfg(); c.anthropicKey = String(key || '').trim(); saveCfg(c); return true; });
  ipcMain.handle('cfg:setModel', (_e, m) => { const c = loadCfg(); c.model = String(m || 'claude-opus-5'); saveCfg(c); return true; });
  ipcMain.handle('cfg:setEngine', (_e, eng) => { const c = loadCfg(); c.engine = String(eng || 'byok'); saveCfg(c); sessionId = null; return true; });
  ipcMain.handle('cfg:setOnboarded', () => { const c = loadCfg(); c.onboarded = true; saveCfg(c); return true; });
  ipcMain.handle('auth:login', async () => oauthLogin());
  ipcMain.handle('auth:logout', () => { const c = loadCfg(); delete c.token; delete c.email; delete c.onboarded; saveCfg(c); sessionId = null; return true; });
  ipcMain.handle('engine:detect', async () => ({ claudeCode: await detectClaudeCode() }));
  ipcMain.handle('imessage:check', () => imessageCheck());
  ipcMain.handle('imessage:inbox', (_e, limit) => imessage.inbox(Number(limit) || 200));
  // Deep-link straight to the Full Disk Access pane; only the user can grant it.
  ipcMain.handle('imessage:grant', () => {
    shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles');
    return true;
  });
  ipcMain.handle('open:url', (_e, u) => { if (/^https?:\/\//.test(String(u))) shell.openExternal(String(u)); return true; });
  ipcMain.handle('agent:send', (_e, prompt) => { agentSend(String(prompt || '')); return true; });
  ipcMain.handle('agent:stop', () => {
    if (currentAbort) currentAbort.abort();
    if (currentChild) { try { currentChild.kill('SIGTERM'); } catch { } }
    return true;
  });
  ipcMain.handle('agent:reset', () => { sessionId = null; return true; });
  ipcMain.handle('api:get', async (_e, p) => {
    const c = loadCfg();
    if (!c.token) return { status: 401, body: { error: 'not_logged_in' } };
    return jfetch(baseUrl(c) + p, { headers: authed(c) });
  });
  ipcMain.handle('api:post', async (_e, p, body) => {
    const c = loadCfg();
    if (!c.token) return { status: 401, body: { error: 'not_logged_in' } };
    return jfetch(baseUrl(c) + p, { method: 'POST', headers: authed(c, { 'Content-Type': 'application/json' }), body: JSON.stringify(body || {}) });
  });
  ipcMain.handle('api:delete', async (_e, p) => {
    const c = loadCfg();
    if (!c.token) return { status: 401, body: { error: 'not_logged_in' } };
    return jfetch(baseUrl(c) + p, { method: 'DELETE', headers: authed(c) });
  });
  ipcMain.handle('api:patch', async (_e, p, body) => {
    const c = loadCfg();
    if (!c.token) return { status: 401, body: { error: 'not_logged_in' } };
    return jfetch(baseUrl(c) + p, { method: 'PATCH', headers: authed(c, { 'Content-Type': 'application/json' }), body: JSON.stringify(body || {}) });
  });
}

// ---------- window ----------
function createWindow() {
  win = new BrowserWindow({
    width: 1280, height: 820, minWidth: 980, minHeight: 620,
    title: 'Blitz',
    titleBarStyle: 'hiddenInset',
    backgroundColor: '#0c0d10',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  win.webContents.setWindowOpenHandler(({ url }) => { shell.openExternal(url); return { action: 'deny' }; });
}

app.whenReady().then(() => {
  // Benmore logo as the macOS dock icon (packaged builds use build.icon instead).
  if (process.platform === 'darwin' && app.dock) {
    try {
      const { nativeImage } = require('electron');
      const icon = nativeImage.createFromPath(path.join(__dirname, '..', 'renderer', 'assets', 'logo.png'));
      if (!icon.isEmpty()) app.dock.setIcon(icon);
    } catch { /* cosmetic only */ }
  }
  registerIpc(); createWindow();
});
app.on('before-quit', () => shim.stop());
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
