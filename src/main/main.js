// Motion Desktop — main process.
// Owns: window, config (userData/config.json), Motion OAuth (PKCE), the agent
// engine (Claude Agent SDK ↔ Motion MCP), and REST proxying for the context pane.
const { app, BrowserWindow, ipcMain, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const http = require('http');
const crypto = require('crypto');
const { execFile } = require('child_process');

const DEFAULT_BASE = process.env.MOTION_URL || 'https://motion-v9t7fg.benmore.ai';

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
  if (status !== 200) throw new Error('Cannot reach Motion OAuth server at ' + base);

  // Local callback server on a random port.
  const srv = http.createServer();
  await new Promise((res) => srv.listen(0, '127.0.0.1', res));
  const port = srv.address().port;
  const redirect = `http://127.0.0.1:${port}/callback`;

  // Dynamic client registration (public client, PKCE).
  const { body: reg } = await jfetch(meta.registration_endpoint || base + '/oauth/register', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_name: 'Motion Desktop', redirect_uris: [redirect],
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
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end('<html><body style="font-family:system-ui;text-align:center;padding-top:20vh;background:#0c0d10;color:#e4e4e7"><h2>Motion connected ✓</h2><p>You can close this tab and return to the app.</p></body></html>');
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

// ---------- agent engine (BYOK via Agent SDK) ----------
let sessionId = null;
let currentAbort = null;

async function agentSend(prompt) {
  const cfg = loadCfg();
  if (!cfg.token) throw new Error('not_logged_in');
  if (!cfg.anthropicKey) throw new Error('no_api_key');

  const { query } = await import('@anthropic-ai/claude-agent-sdk');
  const send = (ev) => win && win.webContents.send('agent:event', ev);

  currentAbort = new AbortController();
  const q = query({
    prompt,
    options: {
      model: cfg.model || 'claude-opus-5',
      env: { ...process.env, ANTHROPIC_API_KEY: cfg.anthropicKey },
      resume: sessionId || undefined,
      abortController: currentAbort,
      includePartialMessages: true,
      systemPrompt:
        'You are Motion, the user\'s AI Rolodex assistant, embedded in the Motion desktop app. ' +
        'Use the motion MCP tools for everything: log context (add_context), look people up (search, list_targets, get_brief), ' +
        'manage the follow-up queue (get_agenda, get_queue, queue_followup, start_sequence, due_sends, register_reply), ' +
        'and reach out (send_email, send_imessage — default to draft mode unless the user explicitly says send). ' +
        'Be concise. After acting, summarize what you did in one or two sentences.',
      mcpServers: {
        motion: {
          type: 'http',
          url: baseUrl(cfg) + '/api/mcp',
          headers: { Authorization: 'Bearer ' + cfg.token },
        },
      },
      allowedTools: ['mcp__motion__*'],
      disallowedTools: ['Bash', 'Read', 'Write', 'Edit', 'Glob', 'Grep', 'WebFetch', 'WebSearch', 'NotebookEdit'],
      maxTurns: 25,
    },
  });

  try {
    for await (const msg of q) {
      if (msg.type === 'system' && msg.subtype === 'init') {
        sessionId = msg.session_id || sessionId;
      } else if (msg.type === 'stream_event') {
        const ev = msg.event;
        if (ev.type === 'content_block_delta' && ev.delta && ev.delta.type === 'text_delta') {
          send({ kind: 'text', text: ev.delta.text });
        } else if (ev.type === 'content_block_start' && ev.content_block && ev.content_block.type === 'tool_use') {
          send({ kind: 'tool_start', name: ev.content_block.name });
        }
      } else if (msg.type === 'assistant' && msg.message && Array.isArray(msg.message.content)) {
        for (const block of msg.message.content) {
          if (block.type === 'tool_use') send({ kind: 'tool_use', name: block.name, input: block.input });
        }
      } else if (msg.type === 'user' && msg.message && Array.isArray(msg.message.content)) {
        for (const block of msg.message.content) {
          if (block.type === 'tool_result') {
            const text = Array.isArray(block.content)
              ? block.content.filter(c => c.type === 'text').map(c => c.text).join('\n')
              : String(block.content || '');
            send({ kind: 'tool_result', text: text.slice(0, 2000) });
          }
        }
      } else if (msg.type === 'result') {
        send({
          kind: 'done',
          ok: msg.subtype === 'success',
          usage: msg.usage || null,
          cost: msg.total_cost_usd != null ? msg.total_cost_usd : null,
          error: msg.subtype !== 'success' ? (msg.result || msg.subtype) : null,
        });
      }
    }
  } catch (e) {
    send({ kind: 'done', ok: false, error: String(e && e.message || e) });
  } finally {
    currentAbort = null;
  }
}

// ---------- IPC ----------
function registerIpc() {
  ipcMain.handle('cfg:get', () => {
    const c = loadCfg();
    return { base: baseUrl(c), email: c.email || '', loggedIn: !!c.token, hasKey: !!c.anthropicKey, model: c.model || 'claude-opus-5' };
  });
  ipcMain.handle('cfg:setKey', (_e, key) => { const c = loadCfg(); c.anthropicKey = String(key || '').trim(); saveCfg(c); return true; });
  ipcMain.handle('cfg:setModel', (_e, m) => { const c = loadCfg(); c.model = String(m || 'claude-opus-5'); saveCfg(c); return true; });
  ipcMain.handle('auth:login', async () => oauthLogin());
  ipcMain.handle('auth:logout', () => { const c = loadCfg(); delete c.token; delete c.email; saveCfg(c); sessionId = null; return true; });
  ipcMain.handle('engine:detect', async () => ({ claudeCode: await detectClaudeCode() }));
  ipcMain.handle('agent:send', (_e, prompt) => { agentSend(String(prompt || '')); return true; });
  ipcMain.handle('agent:stop', () => { if (currentAbort) currentAbort.abort(); return true; });
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
    title: 'Motion',
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
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
