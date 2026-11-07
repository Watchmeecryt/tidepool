// Tidepool server: 1Click-compatible API, faucet, settlement worker and the docs site.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { loadKeys, view, viewAccount, rpc } from './near.mjs';
import { ROOT, VERIFIER, MAKER, TOKENS, VERIFIER_WASM_SHA256, VERIFIER_RELEASE, fromUnits } from './config.mjs';
import { quote, tokens, statusOf, submitDeposit, startWorker, initEngine, BadRequest, makerBalance, anyInputWithdrawals } from './engine.mjs';
import { generateIntent, submitIntent } from './intents.mjs';
import { authenticate, refresh, balances, history, sessionOf } from './auth.mjs';
import { createOrder, getOrder, listOrders, cancelOrder, ApiError, errorDoc } from './orders.mjs';
import crypto from 'node:crypto';
import { drip } from './faucet.mjs';
import { assertHuman } from './faucet-guard.js';
import { authenticate as authenticatePartnerKey } from './agent-api/partner-keys.js';
import { prices } from './prices.mjs';
import { evmHealth } from './evm.mjs';
import { solHealth, startTreasuryWatch } from './solana.mjs';
import { SOL_CHAIN, STELLAR_CHAIN, SUI_CHAIN, BTC_CHAIN, ZEC_CHAIN, XRP_CHAIN } from './config.mjs';
import { suiHealth } from './sui.mjs';
import { btcHealth } from './btc.mjs';
import { zecHealth } from './zec.mjs';
import { stellarHealth, startTreasuryWatch as startStellarWatch } from './stellar.mjs';
import { xrpHealth, startTreasuryWatch as startXrpWatch } from './xrp.mjs';
import { db } from './store.mjs';
import { record } from './analytics.mjs';
import { admin } from './admin.mjs';
import { runDemo, demoInfo, DemoRefused } from './demo.mjs';
import { renderPage, docs, llmsTxt, llmsFull, agentsMd } from './site.mjs';
import { handleV1 } from './agent-api/router.js';

await loadKeys({ env: process.env.TIDEPOOL_KEYS, dir: process.env.TIDEPOOL_KEYS ? null : new URL('../../.secrets', import.meta.url).pathname });
await initEngine();
startWorker();
startTreasuryWatch();
startStellarWatch();
startXrpWatch();

const PUBLIC = new URL('../../site/public/', import.meta.url).pathname;
const DOCS = new URL('../../docs/out/', import.meta.url).pathname;
const TYPES = { '.html': 'text/html; charset=utf-8', '.xml': 'application/xml; charset=utf-8', '.webmanifest': 'application/manifest+json', '.txt': 'text/plain; charset=utf-8', '.md': 'text/markdown; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml', '.css': 'text/css', '.js': 'text/javascript', '.mjs': 'text/javascript', '.png': 'image/png', '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.webp': 'image/webp', '.mp4': 'video/mp4', '.webm': 'video/webm', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.vtt': 'text/vtt; charset=utf-8' };
const sendFile = (res, file, code = 200, req = null) => {
  const immutable = file.includes('/_next/static/');
  const headers = { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream', 'access-control-allow-origin': '*', 'cache-control': immutable ? 'public, max-age=31536000, immutable' : 'public, max-age=60' };
  // Media: stream with byte-range support so <video> can seek without downloading the whole file.
  if (/\.(mp4|webm)$/.test(file)) {
    const size = fs.statSync(file).size;
    headers['accept-ranges'] = 'bytes'; headers['cache-control'] = 'public, max-age=86400';
    const m = /^bytes=(\d*)-(\d*)$/.exec(req?.headers.range || '');
    if (m && code === 200) {
      let start = m[1] === '' ? size - Number(m[2]) : Number(m[1]);
      let end = m[1] !== '' && m[2] !== '' ? Math.min(Number(m[2]), size - 1) : size - 1;
      if (m[1] === '') start = Math.max(0, start);
      if (!(start >= 0 && start <= end && start < size)) { res.writeHead(416, { 'content-range': `bytes */${size}`, 'accept-ranges': 'bytes' }); return res.end(); }
      res.writeHead(206, { ...headers, 'content-range': `bytes ${start}-${end}/${size}`, 'content-length': end - start + 1 });
      if (req.method === 'HEAD') return res.end();
      return fs.createReadStream(file, { start, end }).pipe(res);
    }
    res.writeHead(code, { ...headers, 'content-length': size });
    if (req?.method === 'HEAD') return res.end();
    return fs.createReadStream(file).pipe(res);
  }
  res.writeHead(code, headers); res.end(fs.readFileSync(file));
};
const LEGACY = { '/quickstart': '/docs/quickstart', '/faucet': '/docs/guides/faucet', '/status': '/docs/status', '/guides/first-swap': '/docs/guides/first-swap', '/guides/sdk': '/docs/guides/sdk', '/guides/agents': '/docs/guides/agents' };
function serveDocs(req, res, p) {
  let rel = decodeURIComponent(p).replace(/\/+$/, '') || '/';
  if (LEGACY[rel]) { res.writeHead(301, { location: LEGACY[rel] }); return res.end(); }
  if (LEGACY[rel.replace(/\.md$/, '')]) { res.writeHead(301, { location: LEGACY[rel.replace(/\.md$/, '')] + '.md' }); return res.end(); }
  // Markdown view of any docs page: /docs/x.md or /docs/x.mdx -> /llms.mdx/docs/x/content.md
  const md = rel.match(/^\/docs(\/.*)?\.mdx?$/);
  if (md) rel = `/llms.mdx/docs${md[1] || ''}/content.md`;
  const safe = path.normalize(rel).replace(/^(\.\.[/\\])+/, '');
  for (const cand of [safe, safe + '.html', path.join(safe, 'index.html')]) {
    const file = path.join(DOCS, cand);
    if (file.startsWith(DOCS) && fs.existsSync(file) && fs.statSync(file).isFile()) return sendFile(res, file, 200, req);
  }
  return sendFile(res, DOCS + '404.html', 404);
}
const json = (res, code, body) => { res.writeHead(code, { 'content-type': 'application/json', 'access-control-allow-origin': '*', 'cache-control': 'no-store' }); res.end(JSON.stringify(body)); };
const text = (res, body, type = 'text/plain; charset=utf-8') => { res.writeHead(200, { 'content-type': type, 'access-control-allow-origin': '*' }); res.end(body); };
const readBody = (req) => new Promise((ok, bad) => { let b = ''; req.on('data', c => { b += c; if (b.length > 1e5) req.destroy(); }); req.on('end', () => { try { ok(req._body = b ? JSON.parse(b) : {}); } catch { bad(new BadRequest('Body must be JSON')); } }); });
const authed = (req) => Boolean(req.headers['x-api-key'] || /^Bearer\s+\S+/i.test(req.headers.authorization || '')); // any key/JWT gets the lower fee on testnet
const ip = (req) => String(req.headers['x-forwarded-for'] || req.socket.remoteAddress).split(',')[0].trim();

// Warn (never fail health) when the verifier's spare NEAR for storage is low: each new intents account, nonce and
// token balance costs 0.00001 NEAR/byte, and new-account deposits revert with LackBalanceForState at zero.
const LOW_SPARE_NEAR = Number(process.env.VERIFIER_LOW_SPARE_NEAR || 2);
function verifierStorage(out, a) {
  const near = (y) => Number(BigInt(y) / 10n ** 18n) / 1e6;
  const balance = near(a.amount), stake = Number(a.storage_usage) * 1e-5, spare = Math.round((balance - stake) * 1e4) / 1e4;
  out.verifierStorage = { balanceNear: balance, storageStakeNear: Math.round(stake * 1e4) / 1e4, spareNear: spare, storageBytes: a.storage_usage, lowSpareThresholdNear: LOW_SPARE_NEAR, low: spare < LOW_SPARE_NEAR };
  if (spare < LOW_SPARE_NEAR) (out.warnings ||= []).push(`Verifier ${VERIFIER} has only ${spare} NEAR spare for storage (threshold ${LOW_SPARE_NEAR}); new-account deposits will revert with LackBalanceForState when it reaches 0. Top it up.`);
}
async function health() {
  const out = { service: 'tidepool', network: 'testnet', verifier: VERIFIER, verifierWasmSha256: VERIFIER_WASM_SHA256, verifierRelease: VERIFIER_RELEASE, maker: MAKER, checks: {} };
  const t0 = Date.now();
  try { const b = await rpc('block', { finality: 'final' }); out.checks.rpc = { ok: true, height: b.header.height, ms: Date.now() - t0 }; } catch (e) { out.checks.rpc = { ok: false, error: e.message }; }
  try { const a = await viewAccount(VERIFIER); const code = Buffer.from(a.code_hash ? (await import('bs58')).default.decode(a.code_hash) : []).toString('hex'); out.checks.verifier = { ok: code === VERIFIER_WASM_SHA256, codeHashHex: code }; verifierStorage(out, a); } catch (e) { out.checks.verifier = { ok: false, error: e.message }; }
  const p = await prices(); out.checks.prices = { ok: p.source === 'coingecko', source: p.source, updatedAt: new Date(p.at).toISOString(), error: p.error };
  try { out.checks.makerInventory = { ok: true, balances: Object.fromEntries(await Promise.all(TOKENS.map(async t => [t.symbol, fromUnits(await makerBalance(t.assetId), t.decimals)]))) }; } catch (e) { out.checks.makerInventory = { ok: false, error: e.message }; }
  out.bridges = { note: 'Testnet bridges (EVM chains, Solana devnet, Stellar testnet, Sui testnet, Bitcoin testnet4, Zcash testnet and XRP Ledger testnet): trusted relayer run by Tidepool, testnet only.', chains: await evmHealth() };
  if (SOL_CHAIN.deployed) out.bridges.chains.sol = await solHealth();
  if (STELLAR_CHAIN.deployed) out.bridges.chains.stellar = await stellarHealth();
  if (XRP_CHAIN.deployed) out.bridges.chains.xrp = await xrpHealth();
  if (SUI_CHAIN.deployed) out.bridges.chains.sui = await suiHealth();
  if (BTC_CHAIN.deployed) out.bridges.chains.btc = await btcHealth();
  if (ZEC_CHAIN.deployed) out.bridges.chains.zec = await zecHealth();
  const all = Object.values(db.swaps);
  const count = (s) => all.filter(x => x.status === s).length;
  out.swaps = { total: all.length, success: count('SUCCESS'), refunded: count('REFUNDED'), failed: count('FAILED'), active: all.filter(x => ['PENDING_DEPOSIT', 'KNOWN_DEPOSIT_TX', 'INCOMPLETE_DEPOSIT', 'PROCESSING'].includes(x.status)).length };
  out.recent = all.filter(x => ['SUCCESS', 'REFUNDED'].includes(x.status)).slice(-5).reverse().map(x => ({ status: x.status, pair: `${x.quoteResponse.quoteRequest.originAsset.split(':')[1].split('.')[0]} → ${x.quoteResponse.quoteRequest.destinationAsset.split(':')[1].split('.')[0]}`, updatedAt: x.updatedAt, tx: x.txs.at(-1) && `https://testnet.nearblocks.io/txns/${x.txs.at(-1).hash}` }));
  out.recent.forEach(r => { if (r.tx?.includes('/txns/0x')) r.tx = undefined; });
  out.ok = Object.values(out.checks).every(c => c.ok || c.source === 'fallback' || c.source === 'coingecko-stale');
  return out;
}
let healthCache = { at: 0 };

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const p = url.pathname;
  // Bare apex -> www (301). Only the exact apex host; www and *.up.railway.app (health checks) are untouched.
  if (String(req.headers.host || '').toLowerCase().replace(/:\d+$/, '') === 'usetidepool.tech') { res.writeHead(301, { location: `https://www.usetidepool.tech${req.url}` }); return res.end(); }
  res.on('finish', () => { try { record(req, res, p, req._body, url); } catch (e) { console.error('analytics', e.message); } });
  try {
    if (await admin(req, res, p, url)) return;
    if (req.method === 'OPTIONS') { res.writeHead(204, { 'access-control-allow-origin': '*', 'access-control-allow-headers': 'content-type, authorization, x-api-key', 'access-control-allow-methods': 'GET, POST, OPTIONS' }); return res.end(); }
    // ---- Agent API (/v1, SDK-compatible, testnet) ----
    if (p === '/v1' || p.startsWith('/v1/')) return handleV1(req, res, url, { origin: origin(req), ip: ip(req), openapi: () => JSON.parse(fs.readFileSync(PUBLIC + 'agent-api.openapi.json', 'utf8')) });
    // ---- API (1Click-compatible) ----
    if (p === '/v0/tokens' && req.method === 'GET') return json(res, 200, await tokens());
    if (p === '/v0/quote' && req.method === 'POST') return json(res, 200, await quote(await readBody(req), { authed: authed(req) }));
    if (p === '/v0/deposit/submit' && req.method === 'POST') return json(res, 200, submitDeposit(await readBody(req)));
    if (p === '/v0/status' && req.method === 'GET') { const s = statusOf(url.searchParams.get('depositAddress'), url.searchParams.get('depositMemo')); return s ? json(res, 200, s) : json(res, 404, { message: 'Deposit address not found' }); }
    // ---- Tidepool extensions ----
    if (p === '/v0/demo/run' && ['GET', 'POST'].includes(req.method)) {
      // One-call demo: runs swap and/or LIMIT order with the server-held demo account (see demo.mjs). Tidepool extension.
      const flowQ = url.searchParams.get('flow');
      if (req.method === 'GET' && flowQ === null && url.searchParams.get('run') === null) return json(res, 200, demoInfo());
      try {
        const body = req.method === 'POST' ? await readBody(req) : { flow: flowQ || 'all' };
        const xff = String(req.headers['x-forwarded-for'] || '').split(',').map(x => x.trim()).filter(Boolean);
        const out = await runDemo({ body, ip: xff.at(-1) || req.socket.remoteAddress, origin: process.env.PUBLIC_URL || 'https://www.usetidepool.tech', base: `http://127.0.0.1:${process.env.PORT || 8080}` });
        return json(res, out.code, out.body);
      } catch (e) {
        if (e instanceof DemoRefused) { res._err = e.message; if (e.extra?.retryAfterSeconds) res.setHeader('retry-after', String(e.extra.retryAfterSeconds)); return json(res, e.code, { ok: false, message: e.message, ...e.extra }); }
        throw e;
      }
    }
    if (p === '/v0/faucet' && req.method === 'POST') {
      const body = await readBody(req);
      let keyOk = false;
      if (process.env.TURNSTILE_SECRET) { try { authenticatePartnerKey(req); keyOk = true; } catch {} }
      await assertHuman(body, ip(req), keyOk);
      return json(res, 200, await drip(body, ip(req)));
    }
    if (p === '/v0/health') { if (Date.now() - healthCache.at > 10_000) healthCache = { at: Date.now(), body: await health() }; return json(res, 200, healthCache.body); }
    if (p === '/v0/any-input/withdrawals' && req.method === 'GET') { const q = url.searchParams; if (!q.get('depositAddress')) throw new BadRequest('depositAddress is required'); const w = anyInputWithdrawals(q.get('depositAddress'), q.get('depositMemo'), { timestampFrom: q.get('timestampFrom'), page: q.get('page'), limit: q.get('limit'), sortOrder: q.get('sortOrder') || 'desc' }); return w ? json(res, 200, w) : json(res, 404, { message: 'Deposit address not found' }); }
    if (p === '/v0/generate-intent' && req.method === 'POST') return json(res, 200, generateIntent(await readBody(req)));
    if (p === '/v0/submit-intent' && req.method === 'POST') return json(res, 200, await submitIntent(await readBody(req)));
    if (p === '/v0/auth/authenticate' && req.method === 'POST') return json(res, 200, await authenticate(await readBody(req)));
    if (p === '/v0/auth/refresh' && req.method === 'POST') return json(res, 200, refresh(await readBody(req)));
    if (p.startsWith('/v0/account/')) {
      const sess = sessionOf(req);
      if (!sess) return json(res, 401, { message: 'Unauthorized: send Authorization: Bearer <accessToken> from /v0/auth/authenticate' });
      if (p === '/v0/account/balances' && req.method === 'GET') return json(res, 200, await balances(sess.sub, url.searchParams.get('tokenIds')?.split(',').filter(Boolean)));
      if (p === '/v0/account/history' && req.method === 'GET') return json(res, 200, history(sess.sub, url.searchParams));
    }
    if (p === '/v0/orders' || p.startsWith('/v0/orders/')) {
      try {
        const sess = sessionOf(req), key = req.headers['x-api-key'];
        const owner = sess ? sess.sub : key ? 'key:' + crypto.createHash('sha256').update(String(key)).digest('hex').slice(0, 32) : null;
        if (!owner) throw new ApiError(401, 'authentication-required', 'Authentication required', 'Send Authorization: Bearer <accessToken> (from /v0/auth/authenticate) or x-api-key');
        const m = /^\/v0\/orders(?:\/([^/]+))?(\/cancel)?$/.exec(p);
        if (m && !m[1] && req.method === 'POST') return json(res, 201, await createOrder(owner, await readBody(req).catch(() => { throw new ApiError(400, 'malformed-request', 'Malformed request', 'Body must be JSON'); })));
        if (m && !m[1] && req.method === 'GET') return json(res, 200, listOrders(owner, url.searchParams));
        if (m && m[1] && m[2] && req.method === 'POST') return json(res, 201, cancelOrder(owner, m[1]));
        if (m && m[1] && !m[2] && req.method === 'GET') return json(res, 200, getOrder(owner, m[1]));
        throw new ApiError(404, 'not-found', 'Not found', 'No such route');
      } catch (e) {
        if (e instanceof ApiError) { res._err = e.message; return json(res, e.status, errorDoc(e)); }
        console.error(p, e); res._err = 'Internal error'; return json(res, 500, errorDoc(new ApiError(500, 'internal-error', 'Internal error', 'Internal error')));
      }
    }
    if (p.startsWith('/v0/')) return json(res, 404, { message: 'Not found' });
    // ---- site ----
    if (p === '/openapi.json') return text(res, fs.readFileSync(PUBLIC + 'openapi.json'), 'application/json');
    if (p === '/AGENTS.md' || p === '/agents.md') return text(res, agentsMd(origin(req)), 'text/markdown; charset=utf-8');
    if (fs.existsSync(DOCS + 'index.html')) return serveDocs(req, res, p);
    // fallback: built-in renderer when the docs export is missing
    if (p === '/llms.txt') return text(res, llmsTxt(origin(req)));
    if (p === '/llms-full.txt') return text(res, llmsFull(origin(req)));
    const asMd = p.endsWith('.md');
    const slug = (asMd ? p.slice(0, -3) : p).replace(/\/$/, '') || '/';
    const page = docs(origin(req))[slug === '/index' ? '/' : slug];
    if (page) return asMd ? text(res, page.md, 'text/markdown; charset=utf-8') : text(res, renderPage(slug, page, origin(req)), 'text/html; charset=utf-8');
    const file = path.join(PUBLIC, path.normalize(p).replace(/^(\.\.[/\\])+/, ''));
    if (file.startsWith(PUBLIC) && fs.existsSync(file) && fs.statSync(file).isFile()) return sendFile(res, file);
    res.writeHead(404, { 'content-type': 'text/html' }); res.end(renderPage('/404', { title: 'Not found', md: '# Not found\n\nThat page is not in the pool. [Back home](/).' }, origin(req)));
  } catch (e) {
    const code = e.code && Number.isInteger(e.code) ? e.code : 500;
    if (code >= 500) console.error(p, e);
    res._err = e.message;
    if (e.extra?.retryAfterSeconds) res.setHeader('retry-after', String(e.extra.retryAfterSeconds));
    json(res, code, { message: e.message, ...(code < 500 && e.extra ? e.extra : {}) });
  }
});
const origin = (req) => process.env.PUBLIC_URL || `${req.headers['x-forwarded-proto'] || 'http'}://${req.headers.host}`;
server.listen(process.env.PORT || 8080, () => console.log('tidepool listening on', process.env.PORT || 8080));
