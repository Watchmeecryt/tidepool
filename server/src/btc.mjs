// Bitcoin testnet4 bridge: trusted relayer, no on-chain program. Native tBTC only (like 1Click's nep141:btc.omft.near).
//  - deposit address = per-quote native segwit (p2wpkh, tb1q...) key derived from the master seed, plain (no memo).
//  - sweep / payout / refund transactions are built and signed here (bitcoinjs-lib) and broadcast via public Esplora APIs
//    (mempool.space/testnet4, blockstream.info/testnet4, mempool.ninja/testnet4) with failover, caching and 429 backoff. Signing + idempotence live in utxo.mjs.
// Keys, API URLs and secrets never leave this module and are never logged.
import crypto from 'node:crypto';
import fs from 'node:fs';
import * as bitcoin from 'bitcoinjs-lib';
import { ECPairFactory } from 'ecpair';
import { BIP32Factory } from 'bip32';
import * as ecc from 'tiny-secp256k1';
import { BTC_CHAIN, BTC_CAP_SATS, BTC_MIN_SATS } from './config.mjs';
import { makeBridge, UtxoError, scrub } from './utxo.mjs';

bitcoin.initEccLib(ecc);
const ECPair = ECPairFactory(ecc);
const bip32 = BIP32Factory(ecc);
const NET = bitcoin.networks.testnet; // testnet4 uses the same address/version bytes as testnet3
const SECRETS = new URL('../../.secrets/', import.meta.url).pathname;
export const TREASURY_PATH = "m/84'/1'/0'/0/0";
const DUST = 294n; // p2wpkh dust at 3 sat/vB

// ---------- Esplora endpoints with failover (BTC_API_URLS = comma separated overrides, tried first). URLs are never logged. ----------
// Public Esplora hosts rate-limit shared cloud IPs (Railway) hard, so every request goes through: a response cache with in-flight dedupe,
// a global pacing gap, and a per-endpoint exponential backoff that honours Retry-After. An endpoint that answered last stays preferred.
const urls = () => [...(process.env.BTC_API_URLS || '').split(',').map(s => s.trim().replace(/\/$/, '')).filter(Boolean),
  'https://mempool.space/testnet4/api', 'https://blockstream.info/testnet4/api', 'https://mempool.ninja/testnet4/api'];
export const rpcInfo = () => ({ custom: Boolean(process.env.BTC_API_URLS?.trim()), endpoints: urls().length });
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const EP = new Map(); // endpoint url -> { until, fails }
let preferred = 0, nextSlot = 0;
const PACE_MS = Number(process.env.BTC_API_GAP_MS) || 250;
async function pace() { const now = Date.now(), at = Math.max(now, nextSlot); nextSlot = at + PACE_MS; if (at > now) await sleep(at - now); }
function backoff(u, { retryAfter, base }) {
  const st = EP.get(u) || { until: 0, fails: 0 };
  st.fails++;
  const wait = retryAfter ? Math.min(300, Math.max(1, retryAfter)) * 1000 : Math.min(120_000, base * 2 ** Math.min(st.fails - 1, 6));
  st.until = Date.now() + wait; EP.set(u, st);
}
export const resetApiState = () => { EP.clear(); preferred = 0; nextSlot = 0; cache.clear(); };
async function api(path, { method = 'GET', body, json = true } = {}) {
  let last;
  const list = urls();
  for (let n = 0; n < list.length; n++) {
    const i = (preferred + n) % list.length, u = list[i];
    if ((EP.get(u)?.until || 0) > Date.now()) { last ||= new UtxoError('Bitcoin API 429 (backing off)', { transient: true }); continue; }
    try {
      await pace();
      const r = await fetch(u + path, { method, body, headers: body ? { 'content-type': 'text/plain' } : undefined, signal: AbortSignal.timeout(15_000) });
      const text = await r.text();
      if (r.status >= 500 || r.status === 429) { backoff(u, { retryAfter: Number(r.headers.get('retry-after')) || 0, base: r.status === 429 ? 30_000 : 10_000 }); last = new UtxoError(`Bitcoin API ${r.status}`, { transient: true }); continue; }
      if (!r.ok) { const e = new UtxoError(`Bitcoin API ${r.status}: ${scrub(text)}`); e.status = r.status; e.body = text; throw e; }
      EP.delete(u); preferred = i;
      return json ? JSON.parse(text) : text;
    } catch (e) {
      if (e instanceof UtxoError && !e.transient) throw e;
      last = e instanceof UtxoError ? e : new UtxoError(`Bitcoin API ${e?.name || 'error'}: ${scrub(e?.message)}`, { transient: true });
      backoff(u, { base: 10_000 });
    }
  }
  throw last || new UtxoError('no Bitcoin API available', { transient: true });
}
// Shared read cache: one network read serves every swap that asks for the same thing within the TTL (concurrent calls share the promise).
const cache = new Map();
function cached(k, ttl, fn) {
  const hit = cache.get(k);
  if (hit && (!hit.done || Date.now() - hit.at < hit.ttl)) return hit.p; // still in flight (shared) or fresh
  if (cache.size > 400) for (const [key, v] of cache) if (v.done && Date.now() - v.at >= v.ttl) cache.delete(key);
  const e = { at: Date.now(), ttl: 0, done: false, p: null };
  e.p = fn().then(v => { e.at = Date.now(); e.ttl = typeof ttl === 'function' ? ttl(v) : ttl; e.done = true; return v; }, err => { if (cache.get(k) === e) cache.delete(k); throw err; });
  cache.set(k, e);
  return e.p;
}

// ---------- keys (env BTC_TREASURY_KEY = 32-byte hex HD seed, or the gitignored .secrets/btc-treasury.key; m/84'/1'/0'/0/0) ----------
const keyOf = (priv) => { const pair = ECPair.fromPrivateKey(Buffer.from(priv)); const pub = Buffer.from(pair.publicKey); const p = bitcoin.payments.p2wpkh({ pubkey: pub, network: NET }); return { priv: Buffer.from(priv), pub, pair, address: p.address, spk: Buffer.from(p.output) }; };
let treasuryKey;
export function treasury() {
  if (treasuryKey) return treasuryKey;
  let seed = process.env.BTC_TREASURY_KEY?.trim();
  if (!seed) { try { seed = fs.readFileSync(SECRETS + 'btc-treasury.key', 'utf8').trim(); } catch { /* not configured */ } }
  if (!seed) throw new Error('Bitcoin treasury key not configured');
  treasuryKey = keyOf(bip32.fromSeed(Buffer.from(seed, 'hex')).derivePath(TREASURY_PATH).privateKey);
  return treasuryKey;
}
export const relayerConfigured = () => { try { return treasury().address === BTC_CHAIN.treasury; } catch { return false; } };
/** Per-quote deposit key: HMAC-SHA256(master, "tidepool-btc-deposit:<id>") (re-hashed in the ~2^-128 case it is not a valid scalar). */
export function depositKeypair(master, id) {
  let h = crypto.createHmac('sha256', master).update(`tidepool-btc-deposit:${id}`).digest();
  while (!ecc.isPrivate(h)) h = crypto.createHash('sha256').update(h).digest();
  return keyOf(h);
}
export const depositAddressFor = (master, id) => depositKeypair(master, id).address;
export const txUrl = (txid) => `${BTC_CHAIN.explorer}/tx/${txid}`;
export const addrUrl = (a) => `${BTC_CHAIN.explorer}/address/${a}`;

// ---------- chain adapter ----------
let feeRate = 2n; // sat/vB, refreshed every few minutes
const tip = () => cached('tip', 15_000, async () => {
  const h = Number(await api('/blocks/tip/height', { json: false }));
  if (!Number.isFinite(h) || h <= 0) throw new UtxoError('bad tip height', { transient: true });
  cached('fees', 300_000, () => api('/v1/fees/recommended')).then(r => { const n = Math.ceil(Number(r.halfHourFee) || 2); feeRate = BigInt(Math.min(50, Math.max(2, n))); }).catch(() => {});
  return h;
});
const vsize = (nIn, nOut) => 11n + 68n * BigInt(nIn) + 31n * BigInt(nOut); // p2wpkh in/out (slight overestimate)
const adapter = {
  name: 'btc', minConf: BTC_CHAIN.confirmations, dust: DUST,
  treasury,
  async utxos(address) {
    const [list, h] = await Promise.all([cached(`utxo:${address}`, 8_000, () => api(`/address/${address}/utxo`)), tip()]);
    return list.map(u => ({ txid: u.txid, vout: u.vout, value: BigInt(u.value), conf: u.status?.confirmed ? Math.max(1, h - u.status.block_height + 1) : 0 }));
  },
  async txStatus(txid) {
    // confirmed is final (cached for good); mempool/unknown are re-read after a few seconds, and every broadcast drops the cache
    return cached(`tx:${txid}`, v => (v === 'confirmed' ? 3_600_000 : v === 'mempool' ? 6_000 : 2_000), async () => {
      try { const t = await api(`/tx/${txid}`); return t.status?.confirmed ? 'confirmed' : 'mempool'; }
      catch (e) { if (e.status === 404) return 'unknown'; throw e; }
    });
  },
  async broadcast(hex) {
    try { await api('/tx', { method: 'POST', body: hex, json: false }); cache.clear(); }
    catch (e) {
      const m = String(e.body || e.message || '');
      if (/already (in|known)|txn-already|already in block chain|already exists/i.test(m)) return;
      if (e instanceof UtxoError && e.transient) throw e;
      if (/missingorspent|missing-inputs|bad-txns-inputs/i.test(m)) throw new UtxoError(`transaction rejected: ${scrub(m)}`); // maybe a parent is not indexed yet: utxo.mjs retries the same bytes
      throw new UtxoError(`transaction rejected: ${scrub(m)}`);
    }
  },
  fee: (nIn, nOut) => vsize(nIn, nOut) * feeRate,
  spkOf: (address) => Buffer.from(bitcoin.address.toOutputScript(address, NET)),
  sign({ inputs, outputs }) {
    const psbt = new bitcoin.Psbt({ network: NET });
    for (const i of inputs) psbt.addInput({ hash: i.txid, index: i.vout, witnessUtxo: { script: i.key.spk, value: i.value } });
    for (const o of outputs) psbt.addOutput({ script: o.spk, value: o.value });
    inputs.forEach((i, n) => psbt.signInput(n, i.key.pair));
    psbt.finalizeAllInputs();
    const tx = psbt.extractTransaction();
    return { txid: tx.getId(), hex: tx.toHex() };
  },
};
export const bridge = makeBridge(adapter);
export const { prepareSweep, preparePayout, drive, depositUtxos, treasuryBalance, treasuryUtxos } = bridge;
export const warm = () => tip().catch(() => {});
/** Treasury-signed payout of `amount` sats to `to`, waiting until the network accepted it (scripts/tests; the engine uses drive()). */
export const send = (to, amount) => bridge.sendAndConfirm(() => preparePayout(to, amount));
export const depositTx = async (addr) => (await adapter.utxos(addr).catch(() => []))[0]?.txid || null;
export const feeEstimate = (nIn = 1, nOut = 2) => adapter.fee(nIn, nOut);

let healthCache = { at: 0, v: null };
export async function btcHealth() {
  if (Date.now() - healthCache.at < 10_000 && healthCache.v) return healthCache.v;
  const out = { ok: false, name: BTC_CHAIN.name, network: BTC_CHAIN.network, rpc: rpcInfo(), swapCapBtc: (Number(BTC_CAP_SATS) / 1e8).toString(), minBtc: (Number(BTC_MIN_SATS) / 1e8).toString(), confirmations: BTC_CHAIN.confirmations };
  try {
    if (!relayerConfigured()) throw new Error('treasury key not configured');
    out.treasury = treasury().address;
    const bal = await treasuryBalance();
    out.treasuryBtc = (Number(bal) / 1e8).toFixed(8);
    out.ok = bal >= BTC_CAP_SATS / 5n;
  } catch (e) { out.error = scrub(e.message); }
  healthCache = { at: Date.now(), v: out };
  return out;
}
