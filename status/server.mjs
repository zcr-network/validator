// ZCore validator, read-only status page.
// Runs in its own container, reads the node OVER THE INTERNAL DOCKER NETWORK
// (http://zcore-validator:9650) and serves a small HTML status page on :9055.
// The node's API (9650) stays bound to localhost, only this curated, read-only
// status is exposed. This app NEVER proxies arbitrary calls: it fetches a fixed
// set of endpoints and renders HTML.
import http from 'node:http';
import fs from 'node:fs';

const NODE_URL = (process.env.NODE_URL || 'http://zcore-validator:9650').replace(/\/$/, '');
const PORT = Number(process.env.PORT || 9055);
const LOGO = fs.readFileSync(new URL('./logo.png', import.meta.url));

async function nodeCall(path, body) {
  const opt = body
    ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }
    : {};
  const r = await fetch(NODE_URL + path, { ...opt, signal: AbortSignal.timeout(8000) });
  return r.json();
}

async function gather() {
  const out = { ok: false, healthy: false, nodeID: null, checks: {}, error: null };
  try {
    const h = await nodeCall('/ext/health');            // 503 while bootstrapping, body still JSON
    out.healthy = !!h.healthy;
    out.checks = h.checks || {};
    out.ok = true;
  } catch (e) { out.error = String(e?.message || e); return out; }
  try {
    const info = await nodeCall('/ext/info', { jsonrpc: '2.0', id: 1, method: 'info.getNodeID' });
    out.nodeID = info?.result?.nodeID || null;
  } catch { /* identity not ready yet */ }
  return out;
}

const esc = (s) => String(s).replace(/[<>&"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[c]));

function page(s) {
  const st = !s.ok
    ? { label: 'Node unreachable', cls: 'err', emo: '', sub: 'The validator container did not respond. Check that it is running.' }
    : s.healthy
      ? { label: 'Synced and validating', cls: 'ok', emo: '', sub: 'Your node is healthy and online. You can register now (1 ZEUS).' }
      : { label: 'Syncing...', cls: 'sync', emo: '', sub: 'Downloading the P-Chain and the ZCore L1. This takes a while. The page refreshes itself.' };
  const rows = Object.entries(s.checks).map(([k, v]) => {
    const good = !v?.error;
    return `<tr><td>${esc(k)}</td><td class="${good ? 'ok' : 'sync'}">${good ? 'ok' : 'waiting'}</td></tr>`;
  }).join('');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="refresh" content="5"><title>ZCore Validator status</title>
<style>
:root{color-scheme:dark}
*{box-sizing:border-box}
body{margin:0;background:#0b0f14;color:#e6edf3;font:15px/1.5 system-ui,-apple-system,sans-serif;display:flex;min-height:100vh;align-items:center;justify-content:center;padding:20px}
.card{background:#111823;border:1px solid #1e2a38;border-radius:20px;padding:30px 34px;max-width:520px;width:100%;box-shadow:0 24px 60px -24px #000}
.head{display:flex;align-items:center;gap:12px;margin-bottom:22px}
.head img{width:40px;height:40px;border-radius:11px}
.brand{font-size:16px;font-weight:800;letter-spacing:.01em}
.tag{font-size:11px;color:#4d5865;text-transform:uppercase;letter-spacing:.09em;font-weight:700}
.dot{width:11px;height:11px;border-radius:50%;display:inline-block;margin-right:4px;box-shadow:0 0 0 4px rgba(255,255,255,.04)}
.dot.ok{background:#3fb950}.dot.sync{background:#d29922}.dot.err{background:#f85149}
.big{font-size:23px;font-weight:800;display:flex;align-items:center;gap:11px;margin:0 0 6px}
.ok{color:#3fb950}.sync{color:#d29922}.err{color:#f85149}
.sub{color:#9aa5b1;font-size:13px;margin-bottom:20px}
.lbl{font-size:11px;color:#4d5865;text-transform:uppercase;letter-spacing:.06em;margin-bottom:5px}
.id{font-family:ui-monospace,SFMono-Regular,monospace;font-size:12px;background:#0b0f14;border:1px solid #1e2a38;border-radius:10px;padding:10px 12px;word-break:break-all;color:#adbac7}
table{width:100%;border-collapse:collapse;margin-top:16px;font-size:13px}
td{padding:7px 0;border-top:1px solid #1e2a38;color:#9aa5b1}td:last-child{text-align:right;font-weight:700}
.foot{margin-top:20px;color:#3d4653;font-size:11px;line-height:1.6}
</style></head><body><div class="card">
<div class="head"><img src="/logo.png" alt="ZCore"><div><div class="brand">ZCore Validator</div><div class="tag">Node status</div></div></div>
<div class="big ${st.cls}"><span class="dot ${st.cls}"></span>${st.label}</div>
<div class="sub">${st.sub}</div>
${s.nodeID ? `<div class="lbl">NodeID</div><div class="id">${esc(s.nodeID)}</div>` : ''}
${rows ? `<table>${rows}</table>` : ''}
<div class="foot">Auto-refreshes every 5s. Port ${PORT}. Read-only: the node API (9650) stays private on localhost.</div>
</div></body></html>`;
}

http.createServer(async (req, res) => {
  if (req.url === '/logo.png') {
    res.writeHead(200, { 'content-type': 'image/png', 'cache-control': 'public, max-age=86400' });
    return res.end(LOGO);
  }
  if (req.url === '/api') {
    const s = await gather();
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify(s));
  }
  if (req.url === '/healthz') { res.writeHead(200); return res.end('ok'); }
  const s = await gather();
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  res.end(page(s));
}).listen(PORT, () => console.log(`zcore-status on :${PORT}, reading ${NODE_URL} (read-only)`));
