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
export const save = () => { if (t) return; t = setTimeout(() => { t = null; try { fs.writeFileSync(FILE + '.tmp', JSON.stringify(log)); fs.renameSync(FILE + '.tmp', FILE); } catch (e) { console.error('analytics save', e.message); } }, 2000); };

// Our own wallets: everything we own, operate, or use in docs/examples/tests. These are hidden from the /admin
// wallet views by default so only genuinely new external wallets show (use "show ours" to see everything).
// Public addresses only, never keys. Matching rules (see isOurs): exact match after normalising 0x... addresses to
// lowercase (EVM and Sui hex are case-insensitive), the NEAR root account and any subaccount of it, suffix matches
// (OUR_SUFFIXES) and prefix matches (OUR_PREFIXES, for throwaway accounts we mint on the fly).
// Extra wallets can be added without a deploy via env ADMIN_OUR_WALLETS (comma separated; a trailing * makes a prefix).
const OUR_LISTS = {
  // NEAR: deployment accounts (root, verifier, maker and token contracts are covered by ROOT/*.ROOT in isOurs), bootstrap funders, token owner.
  'NEAR deployment / funders': ['privacei.testnet', 'tidepool-f1.testnet', 'tidepool-f2.testnet', 'tidepool-f3.testnet', 'tidepool-f4.testnet', 'tp-omft.testnet'],
  // NEAR: throwaway accounts we use for /v0/auth + example swaps, and local funding accounts (more are caught by OUR_PREFIXES).
  'NEAR example / throwaway accounts': ['tidepool-try-0937467b.testnet', 'tidepool-try-1637abf0.testnet', 'tp-fund-3132c6c5.testnet', 'tp-fund-9844d001.testnet', 'tp-fund-bd094968.testnet', 'tp-fund-fb0b8345.testnet', 'tp-fund-fb3f6772.testnet'],
  // NEAR: placeholder accounts used in docs, examples and the SDK guide.
  'NEAR doc placeholders': ['alice.testnet', 'bob.testnet', 'you.testnet', 'user.testnet', 'fees.testnet'],
  // EVM (Ethereum / Base / Arbitrum Sepolia): relayer + deposit-master deployer, e2e demo wallet, vaults, test tokens, doc placeholders.
  'EVM relayer / deployer': ['0x55F2c8044D790e1b8369508c31c756c0c2Ca0E93'],
  'EVM e2e / demo wallets': ['0x38A9D3dB2Daf0f623c0b9777B64d3Fbc42e444Ad', '0xfF5f621914D5aD12A04F3aDF6a59881A6E22B3E9'],
  'EVM vaults and test tokens': ['0x2e6AD9E6D59bB4585ea0E6762c3b637dde29DAD2', '0xc387E121e0aF273D83c20B1d286c12F5C3294f38', '0x38d81431B9f76d9699AF7517040D5221D9dEA252', '0xC15Cf5600225302675604310094f134e88705E62', '0x650F12bA31777DE8Ded47287a8CC86bE737646fe'],
  'EVM doc placeholders': ['0x2527D02599Ba641c19FEa793cD0F167589a0f10D', '0x000000000000000000000000000000000000dEaD', '0xYourAddress'],
  // Solana devnet: relayer/treasury (also the faucet payer), test token mints, doc placeholders.
  'Solana relayer / mints': ['BEijzwSQpWxbgQQ5NfBePxUzHgLoc2vrApPe8G4St55Q', '7pafEGXSmR35rLKNaD6inpfLYuEnRX9DyBc1c7M8r4Xr', 'H9ERDhrU8KDeXkMna2Lw6hYJT3LSyhvypiktDc6zmoeJ'],
  'Solana doc placeholders': ['13QkxhNMrTPxoCkRdYdJ65tFuwXPhL5gLS2Z5Nr6gjRK', 'YourSolanaAddress'],
  // Stellar testnet: treasury (relayer) and the USDC/USDT issuer.
  'Stellar treasury / issuer': ['GBWLJSU3XF6NKHBY25VSDVVKIYS2ATCHHUVYLNWSARHLOLDDXSP2BA4Z', 'GDXABUSRHP4YA5CELHLNJQ4M3TX2BSJ6PEMDFCG2RA4PQLAQLRMFFQAN', 'GYourStellarAddress'],
  // Sui testnet: treasury, test coin package, doc placeholders.
  'Sui treasury / package': ['0x565662f245d0a66f567aa71499589f70fee8c2a5af20e8614429371fbe4f252c', '0x71a32ced7702bba9a8d23a122971d5973baa610f1689306176ac4f364d68bb3c'],
  'Sui doc placeholders': ['0x0000000000000000000000000000000000000000000000000000000000000abc', '0xYourSuiAddress'],
  // Bitcoin testnet4 / Zcash testnet treasuries and doc placeholder (BIP-173 example address).
  'BTC / ZEC treasuries': ['tb1qy2tthlq2ntnjvk40payyuwpnzaf365h02ze0qr', 'tmQHJUqvNXfXD4DqVm2ohTtfCKCZa83EPt5'],
  'BTC doc placeholders': ['tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx'],
  // XRP Ledger testnet: treasury, doc placeholder (the XRPL genesis account) and the test-suite accounts.
  'XRP treasury / placeholders': ['rwJx1hzscZ6THJwhDwmtPQj4YjhvysFyLd', 'rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh', 'rBetwDyxSpfGx3MdGf7iBM6rMNaxfZ4Tz6', 'rPT1Sjq2YGrBMTttX4GZHjKu9dyfzbpAYe'],
  // NEAR implicit-account deposit addresses shown in the docs examples (deposit addresses are derived from our master seed).
  'Doc example deposit addresses': ['b3e013f41cee40b33296f5e0185feae34c2f95059a05482e07cb610acd067322', 'c47208de64cde76fc6803b5f26c137bc51fbf151eb1c0964488ea56704142151', '54e8db801fab4ec416719b8b3044c21bacb4652c698ad4c5846086e5cf27b3a4', 'c15f995960c9d8070ad228d7868662672dfc06c1d30397417e859c8733722f1b', '717a62ee78cf34325228b1767e0409b6f5671dc3e9c451a63e99e75d32f1c3e8', '1479dfce6931f61456a8abdac46f04574da520d5f71313339c292fda1be950f7'],
};
// Prefix matches: throwaway accounts minted by examples, the e2e suite and the app tests.
export const OUR_PREFIXES = ['tidepool-try-', 'tp-app-e2e-', 'tp-fund-'];
// Suffix matches: the bridged-asset (OMFT) token accounts, e.g. base-0x....tp-omft.testnet.
export const OUR_SUFFIXES = ['.tp-omft.testnet'];
const norm = (w) => { const s = String(w || '').trim(); return /^0x/i.test(s) ? s.toLowerCase() : s; };
const OURS = new Set(Object.values(OUR_LISTS).flat().map(norm));
for (const a of String(process.env.ADMIN_OUR_WALLETS || '').split(',').map(s => s.trim()).filter(Boolean)) { if (a.endsWith('*')) OUR_PREFIXES.push(a.slice(0, -1)); else OURS.add(norm(a)); }
export const isOurs = (w) => { if (typeof w !== 'string' || !w) return false; const n = norm(w); return n === ROOT || n.endsWith('.' + ROOT) || OURS.has(n) || OUR_PREFIXES.some(p => n.startsWith(p)) || OUR_SUFFIXES.some(x => n.endsWith(x)); };
export const ourList = () => [ROOT, `*.${ROOT}`, ...OUR_PREFIXES.map(p => p + '*'), ...OUR_SUFFIXES.map(x => '*' + x), ...OURS];
export const ourCount = () => OURS.size;

const ENDPOINTS = ['/v0/tokens', '/v0/quote', '/v0/deposit/submit', '/v0/status', '/v0/faucet', '/v0/health', '/openapi.json', '/llms.txt', '/llms-full.txt', '/AGENTS.md', '/agents.md'];
const bucket = (p) => ENDPOINTS.includes(p) ? p : p.startsWith('/v0/') ? '/v0/*' : p.startsWith('/docs') ? '/docs/*' : p.startsWith('/_next/') ? null : p.startsWith('/admin') ? null : p === '/' ? '/' : '/other';
const isAcct = (s) => typeof s === 'string' && /^[a-z0-9._-]{2,64}$/.test(s);

export function record(req, res, path, body, url) {
  const ep = bucket(path);
  if (!ep) return;
  const wallets = new Set();
  if (body && path === '/v0/quote') { if (isAcct(body.refundTo)) wallets.add(body.refundTo); if (isAcct(body.recipient)) wallets.add(body.recipient); }
  if (body && path === '/v0/faucet' && isAcct(body.accountId)) wallets.add(body.accountId);
  // direct-chain drips (chain + address): record the recipient address (EVM and Sui addresses lowercased like the faucet's cooldown key)
  if (body && path === '/v0/faucet' && typeof body.address === 'string' && /^[A-Za-z0-9]{20,100}$/.test(body.address)) wallets.add(/^0x/i.test(body.address) ? body.address.toLowerCase() : body.address);
  if (body && path === '/v0/deposit/submit') { if (isAcct(body.nearSenderAccount)) wallets.add(body.nearSenderAccount); const s = db.swaps[body.depositAddress]; if (s) wallets.add(s.quoteResponse.quoteRequest.refundTo); }
  if (path === '/v0/status') { const s = db.swaps[url.searchParams.get('depositAddress')]; if (s) wallets.add(s.quoteResponse.quoteRequest.refundTo); }
  const ev = { t: Date.now(), ep, m: req.method, s: res.statusCode, ip: crypto.createHash('sha256').update(log.salt + (String(req.headers['x-forwarded-for'] || req.socket.remoteAddress).split(',')[0].trim())).digest('hex').slice(0, 12), ua: String(req.headers['user-agent'] || '').slice(0, 160) };
  if (wallets.size) ev.w = [...wallets];
  if (res.statusCode >= 400 && res._err) ev.err = String(res._err).slice(0, 300);
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
  // Only successful calls create/update wallet entries. 4xx/5xx (e.g. site-only faucet 403) still
  // land in the raw request log above, but must not inflate the inactive-wallets list.
  for (const w of ok ? (ev.w || []) : []) {
    if (!d.wallets.includes(w)) d.wallets.push(w);
    const r = log.wallets[w] ||= { first: ev.t, last: ev.t, requests: 0, quotes: 0, dryQuotes: 0, faucet: 0, uas: [] };
    r.last = ev.t; r.requests++;
    if (path === '/v0/quote') r[ev.dry ? 'dryQuotes' : 'quotes']++;
    if (path === '/v0/faucet') r.faucet++;
    if (ev.ua && !r.uas.includes(ev.ua) && r.uas.length < 5) r.uas.push(ev.ua);
  }
  save();
}
