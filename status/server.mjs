// ZCore validator — read-only status page.
// Runs in its own container, reads the node OVER THE INTERNAL DOCKER NETWORK
// (http://zcore-validator:9650), and serves a small HTML status page on :9055.
// The node's API (9650) stays bound to localhost — only this curated, read-only
// status is exposed. This app NEVER proxies arbitrary calls: it fetches a fixed
// set of endpoints and renders HTML.
import http from 'node:http';

const NODE_URL = (process.env.NODE_URL || 'http://zcore-validator:9650').replace(/\/$/, '');
const PORT = Number(process.env.PORT || 9055);

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
    const h = await nodeCall('/ext/health');            // 503 while bootstrapping — body still JSON
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
    ? { label: 'Nó inacessível', cls: 'err', emo: '🔌', sub: 'O container do validador não respondeu. Confira se ele está rodando.' }
    : s.healthy
      ? { label: 'Sincronizado e validando', cls: 'ok', emo: '✅', sub: 'Seu nó está saudável e no ar. Já dá pra registrar (1 ZEUS).' }
      : { label: 'Sincronizando…', cls: 'sync', emo: '⏳', sub: 'Baixando a P-Chain + a L1 ZCore. Leva um tempo — esta página atualiza sozinha.' };
  const rows = Object.entries(s.checks).map(([k, v]) => {
    const good = !v?.error;
    return `<tr><td>${esc(k)}</td><td class="${good ? 'ok' : 'sync'}">${good ? 'ok' : 'aguardando'}</td></tr>`;
  }).join('');
  return `<!doctype html><html lang="pt"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="refresh" content="5"><title>ZCore validator · status</title>
<style>
:root{color-scheme:dark}
*{box-sizing:border-box}
body{margin:0;background:#0b0f14;color:#e6edf3;font:15px/1.5 system-ui,-apple-system,sans-serif;display:flex;min-height:100vh;align-items:center;justify-content:center;padding:20px}
.card{background:#111823;border:1px solid #1e2a38;border-radius:20px;padding:30px 34px;max-width:520px;width:100%;box-shadow:0 24px 60px -24px #000}
h1{font-size:12px;color:#7d8794;font-weight:700;margin:0 0 18px;letter-spacing:.08em;text-transform:uppercase}
.big{font-size:24px;font-weight:800;display:flex;align-items:center;gap:12px;margin:0 0 6px}
.ok{color:#3fb950}.sync{color:#d29922}.err{color:#f85149}
.sub{color:#9aa5b1;font-size:13px;margin-bottom:20px}
.lbl{font-size:11px;color:#4d5865;text-transform:uppercase;letter-spacing:.06em;margin-bottom:5px}
.id{font-family:ui-monospace,SFMono-Regular,monospace;font-size:12px;background:#0b0f14;border:1px solid #1e2a38;border-radius:10px;padding:10px 12px;word-break:break-all;color:#adbac7}
table{width:100%;border-collapse:collapse;margin-top:16px;font-size:13px}
td{padding:7px 0;border-top:1px solid #1e2a38;color:#9aa5b1}td:last-child{text-align:right;font-weight:700}
.foot{margin-top:20px;color:#3d4653;font-size:11px}
</style></head><body><div class="card">
<h1>ZCore Validator · node status</h1>
<div class="big ${st.cls}">${st.emo} ${st.label}</div>
<div class="sub">${st.sub}</div>
${s.nodeID ? `<div class="lbl">NodeID</div><div class="id">${esc(s.nodeID)}</div>` : ''}
${rows ? `<table>${rows}</table>` : ''}
<div class="foot">atualiza a cada 5s · porta ${PORT} · somente leitura — a API 9650 continua privada no localhost</div>
</div></body></html>`;
}

http.createServer(async (req, res) => {
  if (req.url === '/api') {
    const s = await gather();
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify(s));
  }
  if (req.url === '/healthz') { res.writeHead(200); return res.end('ok'); }
  const s = await gather();
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  res.end(page(s));
}).listen(PORT, () => console.log(`zcore-status on :${PORT} — reading ${NODE_URL} (read-only)`));
