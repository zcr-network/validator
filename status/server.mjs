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
// Rede ZCore ATUAL (atualizar no reset, junto do dashboard/src/network.json). Serve pra
// detectar quando o no esta preso numa rede ANTIGA (imagem/subnet velho).
const EXPECTED_CHAIN = process.env.EXPECTED_CHAIN || 'd6PKinJttxfYfif77EdoNKnotpk5fSfyPku9oJDU9co7oVkbS';
const EXPECTED_SUBNET = process.env.EXPECTED_SUBNET || '2pTqqpENtHTi118Dh4PSbLkjA6ySpBBeRTK9emcrfksDFytAdg';
const LOGO = fs.readFileSync(new URL('./logo.png', import.meta.url));

async function nodeCall(path, body) {
  const opt = body
    ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }
    : {};
  const r = await fetch(NODE_URL + path, { ...opt, signal: AbortSignal.timeout(8000) });
  return r.json();
}

// nomes de checks que NAO sao a L1 (primary chains + checks internos)
const NON_L1 = new Set(['P', 'C', 'X', 'bls', 'bootstrapped', 'database', 'diskspace', 'network', 'router', 'validation']);

async function gather() {
  const out = { ok: false, healthy: false, nodeID: null, checks: {},
    l1Chain: null, connected: null, peers: null, l1Error: null, height: null, error: null };
  try {
    const h = await nodeCall('/ext/health');            // 503 while bootstrapping, body still JSON
    out.healthy = !!h.healthy;
    out.checks = h.checks || {};
    out.ok = true;
    // acha o check da L1 (a chave e o blockchainID em cb58, ~49 chars, nao um dos nomes fixos)
    for (const [k, v] of Object.entries(out.checks)) {
      if (NON_L1.has(k) || k.length < 40) continue;
      out.l1Chain = k;
      const net = v?.message?.engine ? v.message : v?.message; // tolera formatos
      const pc = v?.message?.networking?.percentConnected;
      if (typeof pc === 'number') out.connected = pc;
      out.height = v?.message?.engine?.consensus?.lastAcceptedHeight ?? null;
      if (v?.error) out.l1Error = String(v.error);
      break;
    }
  } catch (e) { out.error = String(e?.message || e); return out; }
  try {
    const info = await nodeCall('/ext/info', { jsonrpc: '2.0', id: 1, method: 'info.getNodeID' });
    out.nodeID = info?.result?.nodeID || null;
  } catch { /* identity not ready yet */ }
  try {
    const p = await nodeCall('/ext/info', { jsonrpc: '2.0', id: 1, method: 'info.peers', params: {} });
    if (p?.result?.numPeers != null) out.peers = Number(p.result.numPeers);
  } catch { /* peers not ready */ }
  return out;
}

const esc = (s) => String(s).replace(/[<>&"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[c]));

function page(s) {
  // rede errada? (o no esta numa L1 que NAO e a atual) -> a causa #1 de ficar preso em "syncing"
  const wrongNet = s.ok && s.l1Chain && s.l1Chain !== EXPECTED_CHAIN;
  const pct = s.connected == null ? null : Math.round(s.connected * 1000) / 10; // 1 casa
  const lowStake = pct != null && pct < 80;

  const st = !s.ok
    ? { label: 'Node unreachable', cls: 'err', sub: 'The validator container did not respond. Check that it is running (docker ps).' }
    : wrongNet
      ? { label: 'Wrong network', cls: 'err', sub: 'This node is tracking an OLD/unknown ZCore network. Update the validator image and recreate the container (see below).' }
      : s.healthy
        ? { label: 'Synced and validating', cls: 'ok', sub: 'Your node is healthy and online. You can register now (1 ZEUS).' }
        : lowStake
          ? { label: 'Syncing (low connectivity)', cls: 'sync', sub: 'The node cannot reach enough of the network yet. It needs to connect to 80% of the stake to finish. Check the details below.' }
          : { label: 'Syncing...', cls: 'sync', sub: 'Downloading the P-Chain and the ZCore L1. This takes a while. The page refreshes itself.' };

  const rows = Object.entries(s.checks).map(([k, v]) => {
    const good = !v?.error;
    const name = (k.length >= 40) ? 'ZCore L1 (' + k.slice(0, 6) + '...)' : k;
    return `<tr><td>${esc(name)}</td><td class="${good ? 'ok' : 'sync'}">${good ? 'ok' : 'waiting'}</td></tr>`;
  }).join('');

  // painel de detalhes (o que o dono precisa pra diagnosticar)
  const metric = (label, value, cls) => `<div class="m"><div class="ml">${label}</div><div class="mv ${cls || ''}">${value}</div></div>`;
  const details = s.ok ? `
    <div class="metrics">
      ${metric('Connected to stake', pct == null ? '-' : pct + '%', lowStake ? 'err' : (pct != null ? 'ok' : ''))}
      ${metric('Required to sync', '80%', '')}
      ${metric('Peers', s.peers == null ? '-' : String(s.peers), (s.peers != null && s.peers < 3) ? 'err' : (s.peers != null ? 'ok' : ''))}
      ${metric('Block height', s.height == null ? '-' : String(s.height), '')}
    </div>` : '';

  const netBanner = wrongNet ? `
    <div class="warn">
      <b>Wrong / old network.</b> This node is tracking chain <code>${esc(s.l1Chain.slice(0, 12))}...</code>,
      but the current ZCore L1 is <code>${esc(EXPECTED_CHAIN.slice(0, 12))}...</code>.<br>
      Fix: <code>docker compose pull &amp;&amp; docker compose up -d --force-recreate</code> (pega a imagem nova, subnet <code>${esc(EXPECTED_SUBNET.slice(0, 10))}...</code>).
    </div>` : '';

  const errBox = (s.l1Error && !wrongNet) ? `<div class="warn">${esc(s.l1Error)}</div>` : '';

  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="refresh" content="5"><title>ZCore Validator status</title>
<style>
:root{color-scheme:dark}
*{box-sizing:border-box}
body{margin:0;background:#0b0f14;color:#e6edf3;font:15px/1.5 system-ui,-apple-system,sans-serif;display:flex;min-height:100vh;align-items:center;justify-content:center;padding:20px}
.card{background:#111823;border:1px solid #1e2a38;border-radius:20px;padding:30px 34px;max-width:540px;width:100%;box-shadow:0 24px 60px -24px #000}
.head{display:flex;align-items:center;gap:12px;margin-bottom:22px}
.head img{width:40px;height:40px;border-radius:11px}
.brand{font-size:16px;font-weight:800;letter-spacing:.01em}
.tag{font-size:11px;color:#4d5865;text-transform:uppercase;letter-spacing:.09em;font-weight:700}
.dot{width:11px;height:11px;border-radius:50%;display:inline-block;margin-right:4px;box-shadow:0 0 0 4px rgba(255,255,255,.04)}
.dot.ok{background:#3fb950}.dot.sync{background:#d29922}.dot.err{background:#f85149}
.big{font-size:23px;font-weight:800;display:flex;align-items:center;gap:11px;margin:0 0 6px}
.ok{color:#3fb950}.sync{color:#d29922}.err{color:#f85149}
.sub{color:#9aa5b1;font-size:13px;margin-bottom:20px}
.metrics{display:grid;grid-template-columns:1fr 1fr;gap:10px;margin:18px 0}
.m{background:#0b0f14;border:1px solid #1e2a38;border-radius:12px;padding:12px 14px}
.ml{font-size:11px;color:#4d5865;text-transform:uppercase;letter-spacing:.06em;margin-bottom:3px}
.mv{font-size:20px;font-weight:800}
.warn{background:#2a1618;border:1px solid #5c2b2f;color:#ffb4b0;border-radius:12px;padding:12px 14px;font-size:12.5px;margin:14px 0;line-height:1.55}
.warn code{background:#0b0f14;border:1px solid #3a2528;border-radius:6px;padding:1px 6px;color:#ffd7d4;font-family:ui-monospace,monospace;font-size:11.5px}
.lbl{font-size:11px;color:#4d5865;text-transform:uppercase;letter-spacing:.06em;margin-bottom:5px}
.id{font-family:ui-monospace,SFMono-Regular,monospace;font-size:12px;background:#0b0f14;border:1px solid #1e2a38;border-radius:10px;padding:10px 12px;word-break:break-all;color:#adbac7}
table{width:100%;border-collapse:collapse;margin-top:16px;font-size:13px}
td{padding:7px 0;border-top:1px solid #1e2a38;color:#9aa5b1}td:last-child{text-align:right;font-weight:700}
.foot{margin-top:20px;color:#3d4653;font-size:11px;line-height:1.6}
</style></head><body><div class="card">
<div class="head"><img src="/logo.png" alt="ZCore"><div><div class="brand">ZCore Validator</div><div class="tag">Node status</div></div></div>
<div class="big ${st.cls}"><span class="dot ${st.cls}"></span>${st.label}</div>
<div class="sub">${st.sub}</div>
${netBanner}
${details}
${errBox}
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
