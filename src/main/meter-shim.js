// Local Anthropic-compatible shim for Blitz platform AI ("Blitz credits").
//
// Why this exists: the metering endpoint is a Benmore app (blitz-meter), and
// Benmore flows can't read request headers, can't emit a raw SSE body, and cap
// a single inline request at 30s. So the meter runs the model call as an ASYNC
// job and hands back the transcript wrapped in JSON. This shim is the thin
// local translator that makes that look like api.anthropic.com to the SDK:
//
//   Agent SDK ──► 127.0.0.1:<port>/v1/messages          (this shim)
//                   │  POST  {meter}/t/<token>/v1/messages?rid&xbeta  → 202 job
//                   │  poll  {meter}<status_url>                      → completed
//                   │  GET   {meter}/t/<token>/v1/result?rid          → {sse}
//                   ▼
//                 raw text/event-stream back to the SDK
//
// Binds to 127.0.0.1 only, and every request must carry the loopback secret
// minted at startup, so nothing else on the machine can spend the user's
// credits through it.
const http = require('http');
const crypto = require('crypto');

const POLL_MS = 1000;
const MAX_WAIT_MS = 15 * 60 * 1000;

function anthropicError(type, message) {
  return JSON.stringify({ type: 'error', error: { type, message } });
}

// One SSE error event — the SDK surfaces this as a clean failure mid-stream.
function sseError(type, message) {
  return `event: error\ndata: ${JSON.stringify({ type: 'error', error: { type, message } })}\n\n`;
}

async function jfetch(url, opts = {}) {
  const r = await fetch(url, opts);
  const text = await r.text();
  let body; try { body = JSON.parse(text); } catch { body = text; }
  return { status: r.status, body };
}

class MeterShim {
  constructor() {
    this.server = null;
    this.port = 0;
    this.secret = '';
    this.getConfig = null;   // () => ({ meterUrl, token })
  }

  get baseUrl() { return `http://127.0.0.1:${this.port}`; }
  get authToken() { return this.secret; }

  // Starts (idempotently) and resolves once listening.
  async start(getConfig) {
    this.getConfig = getConfig;
    if (this.server) return this;
    this.secret = crypto.randomBytes(24).toString('hex');
    this.server = http.createServer((req, res) => this._handle(req, res));
    await new Promise((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(0, '127.0.0.1', resolve);
    });
    this.port = this.server.address().port;
    return this;
  }

  stop() {
    if (this.server) { try { this.server.close(); } catch { /* already down */ } }
    this.server = null; this.port = 0;
  }

  _handle(req, res) {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', async () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      try {
        await this._route(req, res, raw);
      } catch (e) {
        if (!res.headersSent) res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(anthropicError('api_error', String((e && e.message) || e)));
      }
    });
  }

  async _route(req, res, raw) {
    // Loopback guard: only our own agent process knows this token.
    const auth = req.headers['authorization'] || '';
    const presented = auth.startsWith('Bearer ') ? auth.slice(7) : (req.headers['x-api-key'] || '');
    if (presented !== this.secret) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      return res.end(anthropicError('authentication_error', 'Blitz shim: bad local token.'));
    }

    const { meterUrl, token } = this.getConfig() || {};
    if (!meterUrl || !token) {
      res.writeHead(503, { 'Content-Type': 'application/json' });
      return res.end(anthropicError('api_error', 'Blitz credits are not configured — sign in again or switch engines in Settings.'));
    }

    const path = (req.url || '').split('?')[0];
    const xbeta = req.headers['anthropic-beta'] || '';

    if (path === '/v1/messages/count_tokens') {
      const { status, body } = await jfetch(
        `${meterUrl}/t/${encodeURIComponent(token)}/v1/messages/count_tokens?xbeta=${encodeURIComponent(xbeta)}`,
        { method: 'POST', headers: { 'Content-Type': 'application/json', 'User-Agent': 'Blitz-Desktop/1.0' }, body: raw });
      res.writeHead(status, { 'Content-Type': 'application/json' });
      return res.end(typeof body === 'string' ? body : JSON.stringify(body));
    }

    if (path === '/v1/messages') return this._messages(res, raw, meterUrl, token, xbeta);

    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(anthropicError('not_found_error', `Blitz shim: unsupported path ${path}`));
  }

  async _messages(res, raw, meterUrl, token, xbeta) {
    const rid = crypto.randomUUID();
    const t = encodeURIComponent(token);

    // 1 — enqueue the job on the meter.
    const kick = await jfetch(
      `${meterUrl}/t/${t}/v1/messages?rid=${rid}&xbeta=${encodeURIComponent(xbeta)}`,
      { method: 'POST', headers: { 'Content-Type': 'application/json', 'User-Agent': 'Blitz-Desktop/1.0' }, body: raw });

    if (kick.status !== 202 || !kick.body || !kick.body.status_url) {
      const msg = (kick.body && kick.body.error) || `Blitz meter refused the request (HTTP ${kick.status}).`;
      res.writeHead(kick.status >= 400 ? kick.status : 502, { 'Content-Type': 'application/json' });
      return res.end(anthropicError(kick.status === 401 ? 'authentication_error' : 'api_error', msg));
    }

    // Stream from here on: the SDK gets SSE even if the job later fails.
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });

    // 2 — poll to completion.
    const deadline = Date.now() + MAX_WAIT_MS;
    let status = 'pending', jobErr = '';
    while (Date.now() < deadline) {
      await new Promise((s) => setTimeout(s, POLL_MS));
      const st = await jfetch(`${meterUrl}${kick.body.status_url}`, { headers: { 'User-Agent': 'Blitz-Desktop/1.0' } });
      status = (st.body && st.body.status) || status;
      if (status === 'completed') break;
      if (status === 'failed') { jobErr = (st.body && st.body.error) || 'metering job failed'; break; }
    }

    if (status !== 'completed') {
      return res.end(sseError('api_error', status === 'failed'
        ? `Blitz: ${jobErr}`
        : 'Blitz: the model took too long to respond. Try again.'));
    }

    // 3 — collect the transcript and unwrap it to raw SSE.
    const out = await jfetch(`${meterUrl}/t/${t}/v1/result?rid=${rid}`, { headers: { 'User-Agent': 'Blitz-Desktop/1.0' } });
    const sse = out.body && typeof out.body.sse === 'string' ? out.body.sse : '';
    if (!sse) return res.end(sseError('api_error', 'Blitz: the response could not be retrieved. Your credits were not charged for an empty result.'));
    res.end(sse);
  }
}

module.exports = { MeterShim };
