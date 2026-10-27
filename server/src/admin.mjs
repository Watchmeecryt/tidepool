// Private /admin usage dashboard. Password from env ADMIN_PASSWORD (constant-time compare),
// signed httpOnly session cookie, login rate limit. Disabled (404) when ADMIN_PASSWORD is unset.
import crypto from 'node:crypto';
import { db } from './store.mjs';
import { TOKENS, fromUnits } from './config.mjs';
import { log, isOurs, ourList } from './analytics.mjs';

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
const nb = (w) => `<a href="https://testnet.nearblocks.io/address/${encodeURIComponent(w)}" target="_blank" rel="noopener">${esc(w)}</a>`;
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
  for (const r of Object.values(W)) { r.ours = isOurs(r.wallet); r.volumeFmt = Object.entries(r.volume).map(([sym, v]) => `${fromUnits(v, TOKENS.find(t => t.symbol === sym).decimals)} ${sym}`).join(', '); if (r.first === Infinity) r.first = r.last; }
  return Object.values(W).sort((a, b) => b.last - a.last);
}
const days = (n) => { const out = []; const d = new Date(); d.setUTCHours(0, 0, 0, 0); for (let i = n - 1; i >= 0; i--) out.push(new Date(d - i * 86400_000).toISOString().slice(0, 10)); return out; };
function daily(all) {
  const D = days(30); const row = Object.fromEntries(D.map(d => [d, { quotes: 0, dryQuotes: 0, faucet: 0, requests: 0, wallets: new Set(), SUCCESS: 0, REFUNDED: 0, FAILED: 0, PENDING: 0, ips: 0 }]));
  const keep = (ws) => all || ws.some(w => !isOurs(w));
  for (const s of Object.values(db.swaps)) {
    const ws = swapWallets(s); if (!keep(ws)) continue; const r = row[s.quoteResponse.timestamp.slice(0, 10)]; if (!r) continue;
    r.quotes++; r[['SUCCESS', 'REFUNDED', 'FAILED'].includes(s.status) ? s.status : 'PENDING']++; ws.forEach(w => (all || !isOurs(w)) && r.wallets.add(w));
  }
  const since = Date.parse(log.since);
  for (const [k, t] of Object.entries(db.faucet)) { const w = k.slice(0, k.lastIndexOf(':')); if (t >= since || !(all || !isOurs(w))) continue; const r = row[new Date(t).toISOString().slice(0, 10)]; if (r) { r.faucet++; r.wallets.add(w); } }
  for (const d of D) { const l = log.daily[d]; if (!l) continue; const c = all ? l.all : l.ext; const r = row[d]; r.dryQuotes += c.dryQuotes || 0; r.faucet += c.faucet || 0; r.requests += c.requests || 0; r.ips = l.ips.length; l.wallets.forEach(w => (all || !isOurs(w)) && r.wallets.add(w)); }
  return D.map(d => ({ day: d, ...row[d], wallets: row[d].wallets.size }));
}
function bars(rows, series, h = 120) {
  const W = 640, pad = 22, bw = (W - pad) / rows.length; const max = Math.max(1, ...rows.map(r => series.reduce((a, s) => a + (r[s.k] || 0), 0)));
  let g = `<svg viewBox="0 0 ${W} ${h + 18}" width="100%" preserveAspectRatio="none" role="img"><text x="0" y="10">${max}</text><line x1="${pad}" x2="${W}" y1="${h}" y2="${h}" stroke="var(--line)"/>`;
  rows.forEach((r, i) => { let y = h; for (const s of series) { const v = r[s.k] || 0; if (!v) continue; const bh = v / max * (h - 6); y -= bh; g += `<rect x="${pad + i * bw + 1}" y="${y}" width="${Math.max(1, bw - 2)}" height="${bh}" fill="${s.c}" rx="1.5"><title>${r.day} ${s.n}: ${v}</title></rect>`; } if (i % 5 === 0 || i === rows.length - 1) g += `<text x="${pad + i * bw}" y="${h + 14}">${r.day.slice(5)}</text>`; });
  return g + '</svg>' + `<div class="legend">${series.map(s => `<span><i style="background:${s.c}"></i>${s.n} (${rows.reduce((a, r) => a + (r[s.k] || 0), 0)})</span>`).join('')}</div>`;
}
const statusCls = (s) => s === 'SUCCESS' ? 'ok' : s === 'REFUNDED' ? 'warn' : s === 'FAILED' ? 'bad' : 'mute';

function dashboard(all) {
  const ws = walletStats(); const shown = ws.filter(w => all || !w.ours);
  const swaps = Object.values(db.swaps).filter(s => all || swapWallets(s).some(w => !isOurs(w)));
  const cnt = (st) => swaps.filter(s => s.status === st).length;
  const D = daily(all);
  const ep = {}; for (const l of Object.values(log.daily)) for (const [k, v] of Object.entries(l.endpoints)) ep[k] = (ep[k] || 0) + v;
  const reqTotal = Object.values(log.daily).reduce((a, l) => a + ((all ? l.all : l.ext).requests || 0), 0);
  const recent = log.raw.filter(e => all || !e.w || e.w.some(w => !isOurs(w))).slice(-150).reverse();
  const q = all ? '?all=1' : '';
  const stat = (n, l) => `<div class="stat"><b>${n}</b><small>${l}</small></div>`;
  return page('Usage', `<header><h1>Tide<span>pool</span> usage</h1><div style="display:flex;gap:8px;align-items:center"><a class="btn ghost" href="/admin${all ? '' : '?all=1'}">${all ? 'Hide' : 'Show'} our wallets</a><form method="post" action="/admin/logout" style="margin:0"><button class="btn ghost" type="submit">Sign out</button></form></div></header>
<p class="mute" style="margin-top:-8px">${all ? 'Showing <b>all</b> wallets, including ours.' : `Hiding our own wallets (${ourList().map(esc).join(', ')}).`} Request log since ${fmtT(Date.parse(log.since))}; swaps and faucet backfilled from the db.</p>
<div class="stats">${stat(shown.length, 'wallets')}${stat(swaps.length, 'live quotes')}${stat(swaps.filter(s => s.status !== 'PENDING_DEPOSIT').length, 'swaps (deposit seen)')}${stat(`<span class="ok">${cnt('SUCCESS')}</span>`, 'success')}${stat(`<span class="warn">${cnt('REFUNDED')}</span>`, 'refunded')}${stat(`<span class="bad">${cnt('FAILED')}</span>`, 'failed')}${stat(shown.reduce((a, w) => a + w.faucet, 0), 'faucet claims')}${stat(reqTotal, 'logged requests')}</div>
<div class="grid"><div class="card"><h2>Swaps by status (by quote day)</h2>${bars(D, [{ k: 'SUCCESS', n: 'success', c: '#2f9e6a' }, { k: 'REFUNDED', n: 'refunded', c: '#ffad24' }, { k: 'FAILED', n: 'failed', c: '#d9534f' }, { k: 'PENDING', n: 'pending/expired', c: '#8a8278' }])}</div>
<div class="card"><h2>Quotes</h2>${bars(D, [{ k: 'quotes', n: 'live', c: '#a65f0c' }, { k: 'dryQuotes', n: 'dry (logged)', c: '#ffd078' }])}</div>
<div class="card"><h2>Faucet claims</h2>${bars(D, [{ k: 'faucet', n: 'claims', c: '#ffad24' }])}</div>
<div class="card"><h2>Unique wallets / day</h2>${bars(D, [{ k: 'wallets', n: 'wallets', c: '#b8691a' }])}</div>
<div class="card"><h2>Requests / day</h2>${bars(D, [{ k: 'requests', n: 'requests', c: '#ffd078' }])}</div>
<div class="card"><h2>Unique IPs / day (all traffic)</h2>${bars(D, [{ k: 'ips', n: 'IPs', c: '#8a8278' }])}</div></div>
<div class="card"><h2>Wallets (${shown.length})</h2><div class="scroll"><table><tr><th>Wallet</th><th>First seen</th><th>Last seen</th><th>Live quotes</th><th>Dry quotes</th><th>Swaps</th><th>Success</th><th>Refunded</th><th>Failed</th><th>Faucet</th><th>Volume in (success)</th><th></th></tr>
${shown.map(w => `<tr><td class="mono">${nb(w.wallet)}${w.ours ? ' <span class="pill">ours</span>' : ''}</td><td>${fmtT(w.first)}</td><td>${fmtT(w.last)}</td><td>${w.quotes}</td><td>${w.dryQuotes}</td><td>${w.swaps}</td><td class="ok">${w.success || ''}</td><td class="warn">${w.refunded || ''}</td><td class="bad">${w.failed || ''}</td><td>${w.faucet}</td><td>${esc(w.volumeFmt)}</td><td><a href="/admin/wallet/${encodeURIComponent(w.wallet)}${q}">details →</a></td></tr>`).join('')}</table></div></div>
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
  return page(w, `<header><h1><a href="/admin">←</a> <span class="mono">${esc(w)}</span>${r.ours ? ' <span class="pill">ours</span>' : ''}</h1><a class="btn ghost" href="https://testnet.nearblocks.io/address/${encodeURIComponent(w)}" target="_blank" rel="noopener">nearblocks ↗</a></header>
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
  if (p === '/admin' || p === '/admin/') { res.writeHead(200, H); res.end(dashboard(all)); return true; }
  const m = p.match(/^\/admin\/wallet\/(.+)$/);
  if (m) { res.writeHead(200, H); res.end(walletPage(decodeURIComponent(m[1]))); return true; }
  res.writeHead(404, H); res.end('Not found'); return true;
}
