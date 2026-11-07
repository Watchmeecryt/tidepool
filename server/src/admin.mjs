// Private /admin usage dashboard. Password from env ADMIN_PASSWORD (constant-time compare),
// signed httpOnly session cookie, login rate limit. Disabled (404) when ADMIN_PASSWORD is unset.
import crypto from 'node:crypto';
import { db } from './store.mjs';
import { TOKENS, fromUnits } from './config.mjs';
import { log, isOurs, ourList, ourCount } from './analytics.mjs';
import { sql } from './agent-api/db.js';

const PW = process.env.ADMIN_PASSWORD || '';
const KEY = crypto.createHash('sha256').update('tidepool-admin-session:' + PW).digest();
const TTL = 12 * 3600_000;
const fails = new Map();
const sign = (v) => crypto.createHmac('sha256', KEY).update(v).digest('base64url');
const eq = (a, b) => { const x = crypto.createHash('sha256').update(String(a)).digest(), y = crypto.createHash('sha256').update(String(b)).digest(); return crypto.timingSafeEqual(x, y) && String(a).length === String(b).length; };
const cookie = (req) => Object.fromEntries(String(req.headers.cookie || '').split(';').map(c => c.trim().split('=')).filter(c => c[0]).map(([k, ...v]) => [k, v.join('=')]));
function session(req) { const c = cookie(req).tp_admin; if (!c) return false; const [exp, mac] = c.split('.'); return Boolean(exp && mac && Number(exp) > Date.now() && eq(mac, sign(exp))); }
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const H = { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'x-robots-tag': 'noindex', 'x-frame-options': 'DENY', 'referrer-policy': 'no-referrer' };
const readForm = (req) => new Promise((ok) => { let b = ''; req.on('data', c => { b += c; if (b.length > 4096) req.destroy(); }); req.on('end', () => ok(new URLSearchParams(b))); });
const fmtT = (t) => t ? new Date(t).toISOString().replace('T', ' ').slice(0, 16) + 'Z' : '-';
// Explorer link by wallet kind: NEAR testnet accounts -> nearblocks, Sui addresses (0x + 64 hex) -> suiscan testnet, Bitcoin testnet4 (tb1...) -> mempool.space, Zcash testnet (tm.../t2...) -> zcashexplorer; other chains' addresses are shown as text.
const walletUrl = (w) => /^0x[0-9a-fA-F]{64}$/.test(w) ? `https://suiscan.xyz/testnet/account/${w}` : /^tb1[a-z0-9]{20,80}$/.test(w) ? `https://mempool.space/testnet4/address/${w}` : /^t[m2][1-9A-HJ-NP-Za-km-z]{33}$/.test(w) ? `https://testnet.zcashexplorer.app/address/${w}` : /^[a-z0-9._-]{2,64}$/.test(w) && !/^0x[0-9a-f]{40}$/.test(w) ? `https://testnet.nearblocks.io/address/${encodeURIComponent(w)}` : null;
const nb = (w) => walletUrl(w) ? `<a href="${walletUrl(w)}" target="_blank" rel="noopener">${esc(w)}</a>` : esc(w);
const bySym = Object.fromEntries(TOKENS.map(t => [t.assetId, t]));

const CSS = `:root{color-scheme:light;--bg:#f7f5f1;--card:#fcfbf9;--line:#e9e6e2;--line2:#dcd7cf;--ink:#1d1b18;--mute:#696660;--brand:#a65f0c;--gold:#ffad24;--wash:#fff1d6;--ok:#17633f;--bad:#b4383c;--warn:#a65f0c;--btn:linear-gradient(180deg,#3f3933,#211d19);--onbtn:#fff;--hover:#f3f1ec}
@media (prefers-color-scheme:dark){:root{color-scheme:dark;--bg:#12100e;--card:#191613;--line:#3a332c;--line2:#4a4037;--ink:#f3efe8;--mute:#a8a094;--brand:#ffc052;--wash:rgba(255,173,36,.14);--ok:#7fd1a6;--bad:#f2777b;--warn:#ffc052;--btn:linear-gradient(180deg,#ffd078,#ffad24);--onbtn:#1d1b18;--hover:#211d19}}
*{box-sizing:border-box}body{margin:0;min-height:100vh;color:var(--ink);font:14px/1.45 Geist,ui-sans-serif,system-ui,-apple-system,Segoe UI,sans-serif;background:var(--bg)}
a{color:var(--brand);text-decoration:none}a:hover{text-decoration:underline}.wrap{max-width:none;width:100%;box-sizing:border-box;margin:0;padding:16px 20px}
header{display:flex;align-items:center;justify-content:space-between;gap:16px;margin-bottom:20px}h1{font-size:22px;margin:0;font-weight:600;letter-spacing:-.02em}h1 span{color:var(--brand)}h2{font-size:14px;margin:0 0 12px;color:var(--ink);font-weight:600}
.card{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:16px;margin-bottom:16px;overflow:auto}
.grid{display:grid;gap:16px;grid-template-columns:repeat(auto-fit,minmax(300px,1fr))}.stats{display:grid;gap:12px;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));margin-bottom:16px}
.stat{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:12px 14px}.stat b{display:block;font-size:22px;color:var(--ink);font-weight:600}.stat small{color:var(--mute)}
table{width:100%;border-collapse:collapse;font-size:12.5px}th,td{text-align:left;padding:6px 8px;border-bottom:1px solid var(--line);white-space:nowrap}th{color:var(--mute);font-weight:500;position:sticky;top:0;background:var(--card)}tr:hover td{background:var(--hover)}
.mono{font-family:"Geist Mono",ui-monospace,SFMono-Regular,Menlo,monospace}.mute{color:var(--mute)}.ok{color:var(--ok)}.bad{color:var(--bad)}.warn{color:var(--warn)}
.pill{display:inline-block;padding:2px 8px;border-radius:999px;border:1px solid var(--line);background:var(--wash);font-size:11px}.btn,button{background:var(--btn);color:var(--onbtn);border:0;border-radius:999px;padding:8px 16px;font-weight:600;cursor:pointer}
.btn.ghost{background:var(--card);color:var(--ink);border:1px solid var(--line2)}input{background:var(--bg);border:1px solid var(--line2);color:var(--ink);border-radius:10px;padding:10px 12px;width:100%;font-size:15px}
.legend span{margin-right:12px;font-size:12px}.legend i{display:inline-block;width:10px;height:10px;border-radius:2px;margin-right:4px;vertical-align:middle}svg text{fill:var(--mute);font-size:10px}.scroll{max-height:520px;overflow:auto}td.wrapcell{white-space:normal;overflow-wrap:anywhere;min-width:220px}td.ua{white-space:normal;overflow-wrap:anywhere;min-width:160px;max-width:320px}@media(max-width:900px){.wrap{padding:12px}}`;
const page = (title, body) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow"><title>${esc(title)} · Tidepool admin</title><link rel="icon" href="/favicon.ico"><style>${CSS}</style></head><body><div class="wrap">${body}</div></body></html>`;

function loginPage(msg = '') {
  return page('Sign in', `<div style="max-width:380px;margin:12vh auto"><div class="card"><h1 style="margin-bottom:6px">Tide<span>pool</span> admin</h1><p class="mute" style="margin:0 0 16px">Private usage dashboard.</p>${msg ? `<p class="bad">${esc(msg)}</p>` : ''}<form method="post" action="/admin/login"><input type="password" name="password" placeholder="Password" autocomplete="current-password" autofocus required><div style="height:12px"></div><button type="submit" style="width:100%">Sign in</button></form></div></div>`);
}

// ---------- data ----------
const swapWallets = (s) => { const q = s.quoteResponse.quoteRequest; return [...new Set([q.refundTo, q.recipient, s.sender].filter(Boolean))]; };
function walletStats() {
  const W = {};
  const get = (w) => W[w] ||= { wallet: w, first: Infinity, last: 0, quotes: 0, dryQuotes: 0, swaps: 0, success: 0, refunded: 0, failed: 0, active: 0, faucet: 0, volume: {}, requests: 0 };
  for (const s of Object.values(db.swaps)) {
    const q = s.quoteResponse.quoteRequest; const t0 = Date.parse(s.quoteResponse.timestamp), t1 = Date.parse(s.updatedAt);
    for (const w of swapWallets(s)) {
      const r = get(w); r.first = Math.min(r.first, t0); r.last = Math.max(r.last, t1); r.quotes++;
      if (s.status !== 'PENDING_DEPOSIT') r.swaps++;
      if (s.status === 'SUCCESS') { r.success++; const tk = bySym[q.originAsset]; const amt = s.amountIn || s.deposited || s.quoteResponse.quote.amountIn; if (tk && amt) r.volume[tk.symbol] = (r.volume[tk.symbol] || 0n) + BigInt(amt); }
      else if (s.status === 'REFUNDED') r.refunded++; else if (s.status === 'FAILED') r.failed++; else if (s.status !== 'PENDING_DEPOSIT') r.active++;
    }
  }
  const since = Date.parse(log.since);
  for (const [k, t] of Object.entries(db.faucet)) { const w = k.slice(0, k.lastIndexOf(':')); const r = get(w); r.first = Math.min(r.first, t); r.last = Math.max(r.last, t); if (t < since) r.faucet++; }
  for (const [w, l] of Object.entries(log.wallets)) { const r = get(w); r.first = Math.min(r.first, l.first); r.last = Math.max(r.last, l.last); r.dryQuotes += l.dryQuotes; r.faucet += l.faucet; r.requests += l.requests; r.uas = l.uas; }
  // Agent API (/v1) activity, from the SQLite store; kept apart from the 1Click columns. Faucet deposits are operations whose instructions start with testnet_faucet.
  const fmtVol = (v) => Object.entries(v).map(([a, x]) => bySym[a] ? `${fromUnits(x, bySym[a].decimals)} ${bySym[a].symbol}` : `${x} ${a}`).join(', ');
  for (const a of sql.prepare('SELECT id, tenant_id, wallet_account, created_at FROM agents').all()) { const r = get(a.wallet_account); const t = Date.parse(a.created_at); r.first = Math.min(r.first, t); r.last = Math.max(r.last, t); r.agent = a.id; }
  for (const o of sql.prepare("SELECT o.type, o.status, o.asset, o.amount, o.details_json, o.updated_at, a.wallet_account w FROM operations o JOIN agents a ON a.id = o.agent_id").all()) {
    const r = get(o.w); r.last = Math.max(r.last, Date.parse(o.updated_at)); r.agentVolume ||= {};
    if (o.type === 'transfer') { r.agentTransfers = (r.agentTransfers || 0) + 1; if (o.status === 'SUCCESS') { r.agentTransfersOk = (r.agentTransfersOk || 0) + 1; r.agentVolume[o.asset] = (r.agentVolume[o.asset] || 0n) + BigInt(o.amount || 0); } }
    else if (o.type === 'deposit' && String(JSON.parse(o.details_json || '{}').instructions || '').startsWith('testnet_faucet')) { if (o.status === 'SUCCESS') r.agentFaucet = (r.agentFaucet || 0) + 1; else if (o.status === 'FAILED') r.agentFaucetFailed = (r.agentFaucetFailed || 0) + 1; }
    else r.agentOther = (r.agentOther || 0) + 1;
  }
  for (const x of sql.prepare('SELECT wallet_account w, COUNT(*) n FROM faucet_rejects GROUP BY wallet_account').all()) { const r = get(x.w); r.agentFaucetFailed = (r.agentFaucetFailed || 0) + x.n; }
  for (const r of Object.values(W)) r.agentVolumeFmt = r.agentVolume ? fmtVol(r.agentVolume) : '';
  for (const r of Object.values(W)) { r.ours = isOurs(r.wallet); r.volumeFmt = Object.entries(r.volume).map(([sym, v]) => `${fromUnits(v, TOKENS.find(t => t.symbol === sym).decimals)} ${sym}`).join(', '); if (r.first === Infinity) r.first = r.last; }
  return Object.values(W).sort((a, b) => b.last - a.last);
}
const days = (n) => { const out = []; const d = new Date(); d.setUTCHours(0, 0, 0, 0); for (let i = n - 1; i >= 0; i--) out.push(new Date(d - i * 86400_000).toISOString().slice(0, 10)); return out; };
function daily(all, hide = new Set()) {
  const D = days(30); const row = Object.fromEntries(D.map(d => [d, { quotes: 0, dryQuotes: 0, faucet: 0, requests: 0, wallets: new Set(), SUCCESS: 0, REFUNDED: 0, FAILED: 0, PENDING: 0, ips: 0 }]));
  const keep = (ws) => all || ws.some(w => !isOurs(w));
  for (const s of Object.values(db.swaps)) {
    const ws = swapWallets(s); if (!keep(ws)) continue; const r = row[s.quoteResponse.timestamp.slice(0, 10)]; if (!r) continue;
    r.quotes++; r[['SUCCESS', 'REFUNDED', 'FAILED'].includes(s.status) ? s.status : 'PENDING']++; ws.forEach(w => (all || !isOurs(w)) && !hide.has(w) && r.wallets.add(w));
  }
  const since = Date.parse(log.since);
  for (const [k, t] of Object.entries(db.faucet)) { const w = k.slice(0, k.lastIndexOf(':')); if (!(all || !isOurs(w))) continue; const r = row[new Date(t).toISOString().slice(0, 10)]; if (!r) continue; if (t >= since) { if (hide.has(w)) r.faucet--; continue; } if (hide.has(w)) continue; r.faucet++; r.wallets.add(w); }
  for (const d of D) { const l = log.daily[d]; if (!l) continue; const c = all ? l.all : l.ext; const r = row[d]; r.dryQuotes += c.dryQuotes || 0; r.faucet += c.faucet || 0; r.requests += c.requests || 0; r.ips = l.ips.length; l.wallets.forEach(w => (all || !isOurs(w)) && !hide.has(w) && r.wallets.add(w)); r.faucet = Math.max(0, r.faucet); }
  return D.map(d => ({ day: d, ...row[d], wallets: row[d].wallets.size }));
}
function bars(rows, series, h = 120) {
  const W = 640, pad = 22, bw = (W - pad) / rows.length; const max = Math.max(1, ...rows.map(r => series.reduce((a, s) => a + (r[s.k] || 0), 0)));
  let g = `<svg viewBox="0 0 ${W} ${h + 18}" width="100%" preserveAspectRatio="none" role="img"><text x="0" y="10">${max}</text><line x1="${pad}" x2="${W}" y1="${h}" y2="${h}" stroke="var(--line)"/>`;
  rows.forEach((r, i) => { let y = h; for (const s of series) { const v = r[s.k] || 0; if (!v) continue; const bh = v / max * (h - 6); y -= bh; g += `<rect x="${pad + i * bw + 1}" y="${y}" width="${Math.max(1, bw - 2)}" height="${bh}" fill="${s.c}" rx="1.5"><title>${r.day} ${s.n}: ${v}</title></rect>`; } if (i % 5 === 0 || i === rows.length - 1) g += `<text x="${pad + i * bw}" y="${h + 14}">${r.day.slice(5)}</text>`; });
  return g + '</svg>' + `<div class="legend">${series.map(s => `<span><i style="background:${s.c}"></i>${s.n} (${rows.reduce((a, r) => a + (r[s.k] || 0), 0)})</span>`).join('')}</div>`;
}
const statusCls = (s) => s === 'SUCCESS' ? 'ok' : s === 'REFUNDED' ? 'warn' : s === 'FAILED' ? 'bad' : 'mute';

function agentSummary() {
  const keys = sql.prepare('SELECT COUNT(*) n FROM partner_keys').get().n, agents = sql.prepare('SELECT COUNT(*) n FROM agents').get().n;
  const per = sql.prepare('SELECT k.prefix, k.name, k.created_at, COUNT(a.id) n FROM partner_keys k JOIN agents a ON a.tenant_id = k.id GROUP BY k.id ORDER BY n DESC LIMIT 20').all();
  const ops = sql.prepare('SELECT type, status, COUNT(*) n FROM operations GROUP BY type, status ORDER BY type, status').all();
  const rej = sql.prepare('SELECT COUNT(*) n FROM faucet_rejects').get().n;
  return `<div class="grid"><div class="card"><h2>Agent API (/v1): ${keys} keys, ${agents} agents</h2><table><tr><th>Key</th><th>Name</th><th>Created</th><th>Agents</th></tr>${per.map(k => `<tr><td class="mono">${esc(k.prefix)}…</td><td>${esc(k.name || '')}</td><td>${fmtT(Date.parse(k.created_at))}</td><td>${k.n}</td></tr>`).join('')}</table></div>
<div class="card"><h2>Agent API operations</h2><table><tr><th>Type</th><th>Status</th><th>Count</th></tr>${ops.map(o => `<tr><td>${esc(o.type)}</td><td class="${statusCls(o.status)}">${esc(o.status)}</td><td>${o.n}</td></tr>`).join('')}<tr><td>faucet 429 (logged since this build)</td><td class="bad">rejected</td><td>${rej}</td></tr></table><p class="mute">Not counted as swaps. Deposits include faucet drips.</p></div></div>`;
}
function dashboard(all, fo = false) {
  const ws = walletStats();
  // Faucet-only: claimed from the faucet but never quoted (live or dry), swapped, or used the agent API beyond faucet drips.
  const faucetOnly = (w) => (w.faucet || w.agentFaucet || w.agentFaucetFailed) && !w.quotes && !w.dryQuotes && !w.swaps && !w.agentTransfers && !w.agentOther;
  const base = ws.filter(w => all || !w.ours); const hidden = fo ? [] : base.filter(faucetOnly); const hide = new Set(hidden.map(w => w.wallet));
  const shown = base.filter(w => !hide.has(w.wallet));
  const swaps = Object.values(db.swaps).filter(s => all || swapWallets(s).some(w => !isOurs(w)));
  const cnt = (st) => swaps.filter(s => s.status === st).length;
  const D = daily(all, hide);
  const ep = {}; for (const l of Object.values(log.daily)) for (const [k, v] of Object.entries(l.endpoints)) ep[k] = (ep[k] || 0) + v;
  const reqTotal = Object.values(log.daily).reduce((a, l) => a + ((all ? l.all : l.ext).requests || 0), 0);
  const recent = log.raw.filter(e => all || !e.w || e.w.some(w => !isOurs(w))).slice(-150).reverse();
  const qs = (a, f) => { const x = [a && 'all=1', f && 'fo=1'].filter(Boolean).join('&'); return x ? '?' + x : ''; }; const q = qs(all, fo);
  const stat = (n, l) => `<div class="stat"><b>${n}</b><small>${l}</small></div>`;
  return page('Usage', `<header><h1>Tide<span>pool</span> usage</h1><div style="display:flex;gap:8px;align-items:center"><a class="btn ghost" href="/admin${qs(!all, fo)}">${all ? 'Hide' : 'Show'} our wallets</a><a class="btn ghost" href="/admin${qs(all, !fo)}">${fo ? 'Hide' : 'Show'} faucet-only wallets</a><form method="post" action="/admin/logout" style="margin:0"><button class="btn ghost" type="submit">Sign out</button></form></div></header>
<p class="mute" style="margin-top:-8px">${all ? 'Showing <b>all</b> wallets, including ours.' : `Hiding our own wallets (${ourList().slice(0, 2 + 3 + 1).map(esc).join(', ')}, and ${ourCount()} listed treasury, relayer, example and test addresses).`} Request log since ${fmtT(Date.parse(log.since))}; swaps and faucet backfilled from the db. ${fo ? 'Showing faucet-only wallets.' : `Hiding ${hidden.length} faucet-only wallets (faucet claims but no quotes, dry quotes or swaps).`}</p>
<div class="stats">${stat(shown.length, 'wallets')}${stat(swaps.length, 'live quotes')}${stat(D.reduce((a, r) => a + r.dryQuotes, 0), 'dry quotes (30d)')}${stat(swaps.filter(s => s.status !== 'PENDING_DEPOSIT').length, 'swaps (deposit seen)')}${stat(`<span class="ok">${cnt('SUCCESS')}</span>`, 'success')}${stat(`<span class="warn">${cnt('REFUNDED')}</span>`, 'refunded')}${stat(`<span class="bad">${cnt('FAILED')}</span>`, 'failed')}${stat(shown.reduce((a, w) => a + w.faucet, 0), 'faucet claims')}${stat(reqTotal, 'logged requests')}</div>
<div class="grid"><div class="card"><h2>Swaps by status (by quote day)</h2>${bars(D, [{ k: 'SUCCESS', n: 'success', c: '#2f9e6a' }, { k: 'REFUNDED', n: 'refunded', c: '#ffad24' }, { k: 'FAILED', n: 'failed', c: '#d9534f' }, { k: 'PENDING', n: 'pending/expired', c: '#8a8278' }])}</div>
<div class="card"><h2>Quotes</h2>${bars(D, [{ k: 'quotes', n: 'live', c: '#a65f0c' }])}</div>
<div class="card"><h2>Dry quotes (logged)</h2>${bars(D, [{ k: 'dryQuotes', n: 'dry', c: '#ffd078' }])}</div>
<div class="card"><h2>Faucet claims</h2>${bars(D, [{ k: 'faucet', n: 'claims', c: '#ffad24' }])}</div>
<div class="card"><h2>Unique wallets / day</h2>${bars(D, [{ k: 'wallets', n: 'wallets', c: '#b8691a' }])}</div>
<div class="card"><h2>Requests / day</h2>${bars(D, [{ k: 'requests', n: 'requests', c: '#ffd078' }])}</div>
<div class="card"><h2>Unique IPs / day (all traffic)</h2>${bars(D, [{ k: 'ips', n: 'IPs', c: '#8a8278' }])}</div></div>
${agentSummary()}
<div class="card"><h2>Wallets (${shown.length})</h2><div class="scroll"><table><tr><th>Wallet</th><th>First seen</th><th>Last seen</th><th>Live quotes</th><th>Dry quotes</th><th>Swaps</th><th>Success</th><th>Refunded</th><th>Failed</th><th>Faucet</th><th>Volume in (success)</th><th>Agent transfers (ok/all)</th><th>Agent volume (ok)</th><th>Agent faucet (ok/failed)</th><th>Agent other ops</th><th></th></tr>
${shown.map(w => `<tr><td class="mono">${nb(w.wallet)}${w.ours ? ' <span class="pill">ours</span>' : ''}</td><td>${fmtT(w.first)}</td><td>${fmtT(w.last)}</td><td>${w.quotes}</td><td>${w.dryQuotes}</td><td>${w.swaps}</td><td class="ok">${w.success || ''}</td><td class="warn">${w.refunded || ''}</td><td class="bad">${w.failed || ''}</td><td>${w.faucet}</td><td>${esc(w.volumeFmt)}</td><td>${w.agentTransfers ? `${w.agentTransfersOk || 0}/${w.agentTransfers}` : ''}</td><td>${esc(w.agentVolumeFmt || '')}</td><td>${w.agent ? `${w.agentFaucet || 0}/${w.agentFaucetFailed || 0}` : ''}</td><td>${w.agentOther || ''}</td><td><a href="/admin/wallet/${encodeURIComponent(w.wallet)}${q}">details →</a></td></tr>`).join('')}</table></div></div>
<div class="card"><h2>Top endpoints (all traffic)</h2><table><tr><th>Endpoint</th><th>Requests</th></tr>${Object.entries(ep).sort((a, b) => b[1] - a[1]).map(([k, v]) => `<tr><td class="mono">${esc(k)}</td><td>${v}</td></tr>`).join('')}</table></div>
<div class="card"><h2>Recent events</h2><div class="scroll" style="max-height:420px">${events(recent)}</div></div>`);
}
const events = (list) => `<table><tr><th>Time</th><th>Method</th><th>Endpoint</th><th>Status</th><th>Reason</th><th>Wallets</th><th>IP hash</th><th>User agent</th></tr>${list.map(e => `<tr><td>${fmtT(e.t)}</td><td>${e.m}</td><td class="mono">${esc(e.ep)}${e.dry ? ' <span class="pill">dry</span>' : ''}</td><td class="${e.s < 400 ? 'ok' : 'bad'}">${e.s}</td><td class="mute wrapcell">${esc(e.err || '')}</td><td class="mono">${(e.w || []).map(w => `<a href="/admin/wallet/${encodeURIComponent(w)}">${esc(w)}</a>`).join(', ')}</td><td class="mono mute">${e.ip}</td><td class="mute ua">${esc(e.ua)}</td></tr>`).join('')}</table>`;

function walletPage(w) {
  const r = walletStats().find(x => x.wallet === w);
  if (!r) return page('Not found', `<p><a href="/admin">← back</a></p><div class="card">No activity for ${esc(w)}.</div>`);
  const sw = Object.entries(db.swaps).filter(([, s]) => swapWallets(s).includes(w)).sort((a, b) => b[1].quoteResponse.timestamp.localeCompare(a[1].quoteResponse.timestamp));
  const fc = Object.entries(db.faucet).filter(([k]) => k.slice(0, k.lastIndexOf(':')) === w);
  const evs = log.raw.filter(e => e.w?.includes(w)).slice(-200).reverse();
  const sym = (a) => bySym[a]?.symbol || a;
  return page(w, `<header><h1><a href="/admin">←</a> <span class="mono">${esc(w)}</span>${r.ours ? ' <span class="pill">ours</span>' : ''}</h1>${walletUrl(w) ? `<a class="btn ghost" href="${walletUrl(w)}" target="_blank" rel="noopener">${walletUrl(w).includes("suiscan") ? "suiscan" : "nearblocks"} ↗</a>` : ""}</header>
<div class="stats"><div class="stat"><b>${fmtT(r.first)}</b><small>first seen</small></div><div class="stat"><b>${fmtT(r.last)}</b><small>last seen</small></div><div class="stat"><b>${r.quotes}</b><small>live quotes</small></div><div class="stat"><b>${r.dryQuotes}</b><small>dry quotes</small></div><div class="stat"><b>${r.swaps}</b><small>swaps</small></div><div class="stat"><b class="ok">${r.success}</b><small>success</small></div><div class="stat"><b class="warn">${r.refunded}</b><small>refunded</small></div><div class="stat"><b>${r.faucet}</b><small>faucet claims</small></div></div>
<div class="card"><h2>Volume in (successful swaps)</h2>${esc(r.volumeFmt) || '<span class="mute">none</span>'}${r.uas?.length ? `<h2 style="margin-top:14px">User agents</h2>${r.uas.map(u => `<div class="mono mute">${esc(u)}</div>`).join('')}` : ''}</div>
<div class="card"><h2>Swaps (${sw.length})</h2><table><tr><th>Quoted</th><th>Updated</th><th>Status</th><th>Pair</th><th>Amount in</th><th>Amount out</th><th>Role</th><th>Deposit address</th><th>Last tx</th></tr>${sw.map(([da, s]) => { const q = s.quoteResponse.quoteRequest, qq = s.quoteResponse.quote; const role = [q.refundTo === w && 'refundTo', q.recipient === w && 'recipient', s.sender === w && 'sender'].filter(Boolean).join(', '); const tx = s.txs.at(-1); return `<tr><td>${fmtT(Date.parse(s.quoteResponse.timestamp))}</td><td>${fmtT(Date.parse(s.updatedAt))}</td><td class="${statusCls(s.status)}">${s.status}</td><td>${esc(sym(q.originAsset))} → ${esc(sym(q.destinationAsset))}</td><td>${esc(qq.amountInFormatted)}</td><td>${esc(qq.amountOutFormatted)}</td><td class="mute">${role}</td><td class="mono">${nb(da)}</td><td>${tx ? `<a href="https://testnet.nearblocks.io/txns/${encodeURIComponent(tx.hash)}" target="_blank" rel="noopener">${esc(tx.label || 'tx')}</a>` : ''}</td></tr>`; }).join('')}</table></div>
<div class="card"><h2>Faucet (last claim per mode)</h2><table><tr><th>Mode</th><th>Last claim</th></tr>${fc.map(([k, t]) => `<tr><td>${esc(k.slice(k.lastIndexOf(':') + 1))}</td><td>${fmtT(t)}</td></tr>`).join('')}</table></div>
<div class="card"><h2>Recent events</h2>${events(evs)}</div>`);
}

// Returns true if handled.
export async function admin(req, res, p, url) {
  if (p !== '/admin' && !p.startsWith('/admin/')) return false;
  if (!PW) { res.writeHead(404, H); res.end('Not found'); return true; }
  const ip = String(req.headers['x-forwarded-for'] || req.socket.remoteAddress).split(',')[0].trim();
  if (p === '/admin/login' && req.method === 'POST') {
    const f = (fails.get(ip) || []).filter(t => Date.now() - t < 15 * 60_000);
    if (f.length >= 5) { res.writeHead(429, H); res.end(loginPage('Too many attempts. Try again in 15 minutes.')); return true; }
    const form = await readForm(req);
    if (!eq(form.get('password') || '', PW)) { f.push(Date.now()); fails.set(ip, f); await new Promise(r => setTimeout(r, 400)); res.writeHead(401, H); res.end(loginPage('Wrong password.')); return true; }
    fails.delete(ip);
    const exp = String(Date.now() + TTL);
    res.writeHead(303, { ...H, location: '/admin', 'set-cookie': `tp_admin=${exp}.${sign(exp)}; Path=/admin; HttpOnly; Secure; SameSite=Strict; Max-Age=${TTL / 1000}` }); res.end(); return true;
  }
  if (p === '/admin/logout') { res.writeHead(303, { ...H, location: '/admin', 'set-cookie': 'tp_admin=; Path=/admin; HttpOnly; Secure; SameSite=Strict; Max-Age=0' }); res.end(); return true; }
  if (!session(req)) { res.writeHead(p === '/admin' ? 200 : 303, p === '/admin' ? H : { ...H, location: '/admin' }); res.end(p === '/admin' ? loginPage() : ''); return true; }
  const all = url.searchParams.get('all') === '1';
  if (p === '/admin' || p === '/admin/') { res.writeHead(200, H); res.end(dashboard(all, url.searchParams.get('fo') === '1')); return true; }
  const m = p.match(/^\/admin\/wallet\/(.+)$/);
  if (m) { res.writeHead(200, H); res.end(walletPage(decodeURIComponent(m[1]))); return true; }
  res.writeHead(404, H); res.end('Not found'); return true;
}
