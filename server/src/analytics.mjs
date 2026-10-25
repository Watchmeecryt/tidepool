// Private usage analytics for the /admin page: bounded request log persisted next to the swap db (DATA_DIR).
// Keeps daily aggregates forever (tiny) and the last MAX_RAW raw events. IPs are stored only as salted hashes.
import fs from 'node:fs';
import crypto from 'node:crypto';
import { DIR, db } from './store.mjs';
import { ROOT } from './config.mjs';

const FILE = DIR + '/events.json';
const MAX_RAW = 5000;
export const log = fs.existsSync(FILE) ? JSON.parse(fs.readFileSync(FILE, 'utf8')) : {};
log.salt ||= crypto.randomBytes(16).toString('hex');
log.since ||= new Date().toISOString();
log.raw ||= []; log.daily ||= {}; log.wallets ||= {};
let t = null;
const save = () => { if (t) return; t = setTimeout(() => { t = null; try { fs.writeFileSync(FILE + '.tmp', JSON.stringify(log)); fs.renameSync(FILE + '.tmp', FILE); } catch (e) { console.error('analytics save', e.message); } }, 2000); };

// Our own wallets: deployment accounts (root, verifier, maker, token contracts), bootstrap funders,
// token owner, the example throwaway account used by us, and doc placeholders.
const OURS = new Set(['privacei.testnet', 'tidepool-f1.testnet', 'tidepool-f2.testnet', 'tidepool-f3.testnet', 'tidepool-f4.testnet', 'tidepool-try-0937467b.testnet', 'alice.testnet', 'you.testnet', 'bob.testnet']);
for (const a of String(process.env.ADMIN_OUR_WALLETS || '').split(',').map(s => s.trim()).filter(Boolean)) OURS.add(a);
export const isOurs = (w) => w === ROOT || w.endsWith('.' + ROOT) || OURS.has(w);
export const ourList = () => [ROOT, `*.${ROOT}`, ...OURS];

const ENDPOINTS = ['/v0/tokens', '/v0/quote', '/v0/deposit/submit', '/v0/status', '/v0/faucet', '/v0/health', '/openapi.json', '/llms.txt', '/llms-full.txt', '/AGENTS.md', '/agents.md'];
const bucket = (p) => ENDPOINTS.includes(p) ? p : p.startsWith('/v0/') ? '/v0/*' : p.startsWith('/docs') ? '/docs/*' : p.startsWith('/_next/') ? null : p.startsWith('/admin') ? null : p === '/' ? '/' : '/other';
const isAcct = (s) => typeof s === 'string' && /^[a-z0-9._-]{2,64}$/.test(s);

export function record(req, res, path, body, url) {
  const ep = bucket(path);
  if (!ep) return;
  const wallets = new Set();
  if (body && path === '/v0/quote') { if (isAcct(body.refundTo)) wallets.add(body.refundTo); if (isAcct(body.recipient)) wallets.add(body.recipient); }
  if (body && path === '/v0/faucet' && isAcct(body.accountId)) wallets.add(body.accountId);
  if (body && path === '/v0/deposit/submit') { if (isAcct(body.nearSenderAccount)) wallets.add(body.nearSenderAccount); const s = db.swaps[body.depositAddress]; if (s) wallets.add(s.quoteResponse.quoteRequest.refundTo); }
  if (path === '/v0/status') { const s = db.swaps[url.searchParams.get('depositAddress')]; if (s) wallets.add(s.quoteResponse.quoteRequest.refundTo); }
  const ev = { t: Date.now(), ep, m: req.method, s: res.statusCode, ip: crypto.createHash('sha256').update(log.salt + (String(req.headers['x-forwarded-for'] || req.socket.remoteAddress).split(',')[0].trim())).digest('hex').slice(0, 12), ua: String(req.headers['user-agent'] || '').slice(0, 160) };
  if (wallets.size) ev.w = [...wallets];
  if (path === '/v0/quote' && body) ev.dry = Boolean(body.dry);
  log.raw.push(ev); if (log.raw.length > MAX_RAW) log.raw.splice(0, log.raw.length - MAX_RAW);
  const ext = !ev.w || ev.w.some(w => !isOurs(w));
  const day = new Date(ev.t).toISOString().slice(0, 10);
  const d = log.daily[day] ||= { all: {}, ext: {}, ips: [], wallets: [], endpoints: {} };
  const ok = ev.s < 400;
  for (const k of ['all', ...(ext ? ['ext'] : [])]) {
    const c = d[k]; c.requests = (c.requests || 0) + 1;
    if (path === '/v0/quote' && ok) c[ev.dry ? 'dryQuotes' : 'quotes'] = (c[ev.dry ? 'dryQuotes' : 'quotes'] || 0) + 1;
    if (path === '/v0/faucet' && ok) c.faucet = (c.faucet || 0) + 1;
    if (!ok) c.errors = (c.errors || 0) + 1;
  }
  d.endpoints[ep] = (d.endpoints[ep] || 0) + 1;
  if (!d.ips.includes(ev.ip) && d.ips.length < 5000) d.ips.push(ev.ip);
  for (const w of ev.w || []) {
    if (!d.wallets.includes(w)) d.wallets.push(w);
    const r = log.wallets[w] ||= { first: ev.t, last: ev.t, requests: 0, quotes: 0, dryQuotes: 0, faucet: 0, uas: [] };
    r.last = ev.t; r.requests++;
    if (path === '/v0/quote' && ok) r[ev.dry ? 'dryQuotes' : 'quotes']++;
    if (path === '/v0/faucet' && ok) r.faucet++;
    if (ev.ua && !r.uas.includes(ev.ua) && r.uas.length < 5) r.uas.push(ev.ua);
  }
  save();
}
