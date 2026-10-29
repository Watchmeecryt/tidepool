// Zcash testnet bridge: trusted relayer, no on-chain program. Native TAZ only (like 1Click's nep141:zec.omft.near), TRANSPARENT pool only.
//  - deposit address = per-quote transparent p2pkh address (tm..., no memo) from a key derived from the master seed.
//  - sweep / payout / refund transactions are v5 transparent transactions built and signed here (ZIP-225 format, ZIP-244 signature
//    digest, SIGHASH_ALL, consensus branch id read from lightwalletd, 0x77190ad9 = NU7 as a fallback).
//  - reads: lightwalletd gRPC (GetAddressUtxos; the keyless public Zebra JSON-RPC has no address index). Mempool/tx lookups and
//    broadcast: the keyless public Tatum JSON-RPC gateway, with lightwalletd SendTransaction as a broadcast fallback.
// Keys, RPC URLs and secrets never leave this module and are never logged.
import crypto from 'node:crypto';
import fs from 'node:fs';
import * as bitcoin from 'bitcoinjs-lib';
import { BIP32Factory } from 'bip32';
import * as ecc from 'tiny-secp256k1';
import bs58check from 'bs58check';
import { blake2b } from '@noble/hashes/blake2b';
import grpc from '@grpc/grpc-js';
import protoLoader from '@grpc/proto-loader';
import { ZEC_CHAIN, ZEC_CAP_ZAT, ZEC_MIN_ZAT, ZEC_P2PKH, decodeZecAddress } from './config.mjs';
import { makeBridge, UtxoError, scrub } from './utxo.mjs';

const bip32 = BIP32Factory(ecc);
const SECRETS = new URL('../../.secrets/', import.meta.url).pathname;
export const TREASURY_PATH = "m/44'/1'/0'/0/0";
const DUST = 5_000n;
export const NU7_BRANCH_ID = 0x77190ad9;
const EXPIRY_DELTA = 200; // ~4 h at 75 s blocks

// ---------- ZIP-225 / ZIP-244 primitives (exported for tests) ----------
const pers = (s) => Buffer.from(s, 'latin1');
const H = (p, ...parts) => Buffer.from(blake2b(Buffer.concat(parts), { dkLen: 32, personalization: pers(p) }));
const u32 = (n) => { const b = Buffer.alloc(4); b.writeUInt32LE(n >>> 0); return b; };
const u64 = (n) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(n)); return b; };
const cs = (n) => (n < 253 ? Buffer.from([n]) : n < 0x10000 ? Buffer.from([253, n & 255, n >> 8]) : (() => { const b = Buffer.alloc(5); b[0] = 254; b.writeUInt32LE(n, 1); return b; })());
const withLen = (b) => Buffer.concat([cs(b.length), b]);
const txidBytes = (txid) => Buffer.from(txid, 'hex').reverse(); // wire order = reversed display order
const SEQUENCE = 0xffffffff;
export const HEADER_V5 = 0x80000005, VERSION_GROUP_V5 = 0x26a7270a;
const EMPTY_SAPLING = () => H('ZTxIdSaplingHash');
const EMPTY_ORCHARD = () => H('ZTxIdOrchardHash');
const headerDigest = (t) => H('ZTxIdHeadersHash', u32(HEADER_V5), u32(VERSION_GROUP_V5), u32(t.branchId), u32(t.lockTime || 0), u32(t.expiry));
const prevoutsDigest = (ins) => H('ZTxIdPrevoutHash', ...ins.map(i => Buffer.concat([txidBytes(i.txid), u32(i.vout)])));
const sequenceDigest = (ins) => H('ZTxIdSequencHash', ...ins.map(() => u32(SEQUENCE)));
const outputsDigest = (outs) => H('ZTxIdOutputsHash', ...outs.map(o => Buffer.concat([u64(o.value), withLen(o.spk)])));
const topHash = (t, transparent) => Buffer.concat([pers('ZcashTxHash_'), u32(t.branchId)]);
/** ZIP-244 transaction id (display order hex) of a transparent-only v5 tx {branchId, expiry, lockTime, inputs:[{txid,vout}], outputs:[{spk,value}]}. */
export function txidV5(t) {
  const transparent = H('ZTxIdTranspaHash', prevoutsDigest(t.inputs), sequenceDigest(t.inputs), outputsDigest(t.outputs));
  const d = Buffer.from(blake2b(Buffer.concat([headerDigest(t), transparent, EMPTY_SAPLING(), EMPTY_ORCHARD()]), { dkLen: 32, personalization: topHash(t) }));
  return Buffer.from(d).reverse().toString('hex');
}
/** ZIP-244 signature digest for transparent input `n` (SIGHASH_ALL); inputs carry the spent output's {value, spk}. */
export function sighashV5(t, n) {
  const ins = t.inputs;
  const sigT = H('ZTxIdTranspaHash', Buffer.from([1]), prevoutsDigest(ins),
    H('ZTxTrAmountsHash', ...ins.map(i => u64(i.value))), H('ZTxTrScriptsHash', ...ins.map(i => withLen(i.prevSpk))),
    sequenceDigest(ins), outputsDigest(t.outputs),
    H('Zcash___TxInHash', Buffer.concat([txidBytes(ins[n].txid), u32(ins[n].vout), u64(ins[n].value), withLen(ins[n].prevSpk), u32(SEQUENCE)])));
  return Buffer.from(blake2b(Buffer.concat([headerDigest(t), sigT, EMPTY_SAPLING(), EMPTY_ORCHARD()]), { dkLen: 32, personalization: topHash(t) }));
}
const pushData = (b) => Buffer.concat([Buffer.from([b.length]), b]);
/** Serialize a v5 transparent-only tx; scriptSigs[i] is the final unlocking script of input i. */
export function serializeV5(t, scriptSigs) {
  return Buffer.concat([u32(HEADER_V5), u32(VERSION_GROUP_V5), u32(t.branchId), u32(t.lockTime || 0), u32(t.expiry),
    cs(t.inputs.length), ...t.inputs.map((i, n) => Buffer.concat([txidBytes(i.txid), u32(i.vout), withLen(scriptSigs[n]), u32(SEQUENCE)])),
    cs(t.outputs.length), ...t.outputs.map(o => Buffer.concat([u64(o.value), withLen(o.spk)])),
    Buffer.from([0, 0, 0])]); // no sapling spends/outputs, no orchard actions
}
/** Sign every input (each carries its own key {priv,pub}) and return {txid, hex}. */
export function signV5(t) {
  const scriptSigs = t.inputs.map((i, n) => {
    const sig = Buffer.from(ecc.sign(sighashV5(t, n), i.key.priv));
    return Buffer.concat([pushData(Buffer.from(bitcoin.script.signature.encode(sig, 1))), pushData(i.key.pub)]);
  });
  return { txid: txidV5(t), hex: serializeV5(t, scriptSigs).toString('hex') };
}
export const p2pkhSpk = (hash) => Buffer.concat([Buffer.from([0x76, 0xa9, 0x14]), hash, Buffer.from([0x88, 0xac])]);
export const p2shSpk = (hash) => Buffer.concat([Buffer.from([0xa9, 0x14]), hash, Buffer.from([0x87])]);
export const spkOfAddress = (address) => { const d = decodeZecAddress(address); if (!d) throw new UtxoError('not a Zcash transparent testnet address', { fatal: true }); return d.type === 'p2pkh' ? p2pkhSpk(d.hash) : p2shSpk(d.hash); };
export const addressOfKey = (pub) => bs58check.encode(Buffer.concat([ZEC_P2PKH, Buffer.from(bitcoin.crypto.hash160(pub))]));
/** ZIP-317 conventional fee for transparent txs of standard-size p2pkh inputs/outputs: 5000 zat per logical action, at least 2 actions. */
export const feeZip317 = (nIn, nOut) => 5000n * BigInt(Math.max(2, nIn, nOut));

// ---------- keys (env ZEC_TREASURY_KEY = 32-byte hex HD seed, or the gitignored .secrets/zec-treasury.key; m/44'/1'/0'/0/0) ----------
const keyOf = (priv) => { const privB = Buffer.from(priv); const pub = Buffer.from(ecc.pointFromScalar(privB, true)); const address = addressOfKey(pub); return { priv: privB, pub, address, spk: p2pkhSpk(Buffer.from(bitcoin.crypto.hash160(pub))) }; };
let treasuryKey;
export function treasury() {
  if (treasuryKey) return treasuryKey;
  let seed = process.env.ZEC_TREASURY_KEY?.trim();
  if (!seed) { try { seed = fs.readFileSync(SECRETS + 'zec-treasury.key', 'utf8').trim(); } catch { /* not configured */ } }
  if (!seed) throw new Error('Zcash treasury key not configured');
  treasuryKey = keyOf(bip32.fromSeed(Buffer.from(seed, 'hex')).derivePath(TREASURY_PATH).privateKey);
  return treasuryKey;
}
export const relayerConfigured = () => { try { return treasury().address === ZEC_CHAIN.treasury; } catch { return false; } };
/** Per-quote deposit key: HMAC-SHA256(master, "tidepool-zec-deposit:<id>") (re-hashed in the ~2^-128 case it is not a valid scalar). */
export function depositKeypair(master, id) {
  let h = crypto.createHmac('sha256', master).update(`tidepool-zec-deposit:${id}`).digest();
  while (!ecc.isPrivate(h)) h = crypto.createHash('sha256').update(h).digest();
  return keyOf(h);
}
export const depositAddressFor = (master, id) => depositKeypair(master, id).address;
export const txUrl = (txid) => `${ZEC_CHAIN.explorer}/transactions/${txid}`;
export const addrUrl = (a) => `${ZEC_CHAIN.explorer}/address/${a}`;

// ---------- JSON-RPC (Zebra via Tatum; ZEC_RPC_URLS = comma separated overrides, may contain keys) and lightwalletd gRPC ----------
const rpcUrls = () => [...(process.env.ZEC_RPC_URLS || '').split(',').map(s => s.trim()).filter(Boolean), 'https://zcash-testnet.gateway.tatum.io'];
const lwdUrls = () => [...(process.env.ZEC_LWD_URLS || '').split(',').map(s => s.trim()).filter(Boolean), 'testnet.zec.rocks:443'];
export const rpcInfo = () => ({ customRpc: Boolean(process.env.ZEC_RPC_URLS?.trim()), rpcEndpoints: rpcUrls().length, lightwalletd: lwdUrls().length });
const cooldown = new Map();
async function rpc(method, params = []) {
  let last;
  const list = rpcUrls();
  for (let i = 0; i < list.length; i++) {
    if ((cooldown.get('r' + i) || 0) > Date.now() && i < list.length - 1) continue;
    try {
      const r = await fetch(list[i], { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), signal: AbortSignal.timeout(20_000) });
      if (r.status >= 500 || r.status === 429) { cooldown.set('r' + i, Date.now() + 20_000); last = new UtxoError(`Zcash RPC ${r.status}`, { transient: true }); continue; }
      const j = await r.json().catch(() => null);
      if (!j) { last = new UtxoError(`Zcash RPC ${r.status}`, { transient: true }); continue; }
      if (j.error) { const e = new UtxoError(`Zcash RPC ${j.error.code}: ${scrub(j.error.message)}`); e.code = j.error.code; throw e; }
      return j.result;
    } catch (e) {
      if (e instanceof UtxoError && !e.transient) throw e;
      last = e instanceof UtxoError ? e : new UtxoError(`Zcash RPC ${e?.name || 'error'}: ${scrub(e?.message)}`, { transient: true });
      cooldown.set('r' + i, Date.now() + 20_000);
    }
  }
  throw last || new UtxoError('no Zcash RPC available', { transient: true });
}
let _lwd;
const lwdClients = new Map();
function lwdClient(url) {
  if (!_lwd) {
    const def = protoLoader.loadSync(new URL('./lightwalletd.proto', import.meta.url).pathname, { keepCase: true, longs: String, defaults: true });
    _lwd = grpc.loadPackageDefinition(def).cash.z.wallet.sdk.rpc.CompactTxStreamer;
  }
  if (!lwdClients.has(url)) lwdClients.set(url, new _lwd(url, grpc.credentials.createSsl(), { 'grpc.keepalive_time_ms': 60_000 }));
  return lwdClients.get(url);
}
async function lwd(method, arg) {
  let last;
  for (const [i, url] of lwdUrls().entries()) {
    if ((cooldown.get('l' + i) || 0) > Date.now() && i < lwdUrls().length - 1) continue;
    try {
      return await new Promise((res, rej) => lwdClient(url)[method](arg, { deadline: Date.now() + 20_000 }, (e, r) => (e ? rej(e) : res(r))));
    } catch (e) { last = new UtxoError(`lightwalletd ${e?.code ?? 'error'}: ${scrub(e?.details || e?.message)}`, { transient: true }); cooldown.set('l' + i, Date.now() + 20_000); }
  }
  throw last || new UtxoError('no lightwalletd available', { transient: true });
}

// ---------- chain adapter ----------
let tipCache = { at: 0, v: 0 };
async function tip() {
  if (Date.now() - tipCache.at < 15_000) return tipCache.v;
  const h = Number(await rpc('getblockcount'));
  if (!Number.isFinite(h) || h <= 0) throw new UtxoError('bad tip height', { transient: true });
  tipCache = { at: Date.now(), v: h };
  return h;
}
let branchCache = { at: 0, v: NU7_BRANCH_ID };
async function branchId() {
  if (Date.now() - branchCache.at < 3_600_000) return branchCache.v;
  try { const v = parseInt((await lwd('GetLightdInfo', {})).consensusBranchId, 16); if (v > 0) branchCache = { at: Date.now(), v }; } catch { branchCache.at = Date.now() - 3_000_000; /* retry in 10 min, keep the last known */ }
  return branchCache.v;
}
const adapter = {
  name: 'zec', minConf: ZEC_CHAIN.confirmations, dust: DUST,
  treasury,
  async utxos(address) {
    const [r, h] = await Promise.all([lwd('GetAddressUtxos', { addresses: [address], startHeight: 0, maxEntries: 0 }), tip()]);
    return (r.addressUtxos || []).map(u => ({ txid: Buffer.from(u.txid).reverse().toString('hex'), vout: Number(u.index), value: BigInt(u.valueZat), conf: Math.max(1, h - Number(u.height) + 1) }));
  },
  async txStatus(txid) {
    try { const t = await rpc('getrawtransaction', [txid, 1]); return t.height > 0 || t.confirmations > 0 || t.in_active_chain ? 'confirmed' : 'mempool'; }
    catch (e) { if (e.code === -5) return 'unknown'; throw e; }
  },
  async broadcast(hex) {
    let first;
    try { await rpc('sendrawtransaction', [hex]); return; } catch (e) {
      if (/already (in|known|exists)|duplicate|AlreadyInState|InMempool|already have/i.test(e.message)) return;
      if (!e.transient) throw new UtxoError(`transaction rejected: ${scrub(e.message)}`);
      first = e;
    }
    const r = await lwd('SendTransaction', { data: Buffer.from(hex, 'hex') }).catch(() => { throw first; });
    if (r.errorCode && !/already (in|known|exists)|duplicate/i.test(r.errorMessage)) throw new UtxoError(`transaction rejected: ${scrub(r.errorMessage)}`);
  },
  fee: feeZip317,
  spkOf: spkOfAddress,
  sign({ inputs, outputs }) {
    // branch id and expiry are fixed by the caller through the cached values (branchId() is awaited in warm()/utxos refresh)
    return signV5({ branchId: branchCache.v, expiry: tipCache.v + EXPIRY_DELTA, lockTime: 0,
      inputs: inputs.map(i => ({ txid: i.txid, vout: i.vout, value: i.value, prevSpk: i.key.spk, key: i.key })), outputs });
  },
};
export const warm = async () => { await Promise.all([tip(), branchId()]); };
// every utxo read goes through here first so the branch id / tip used for signing are fresh
const _utxos = adapter.utxos;
adapter.utxos = async (a) => { const r = await _utxos(a); await branchId(); return r; };
export const bridge = makeBridge(adapter);
export const { prepareSweep, preparePayout, drive, depositUtxos, treasuryBalance, treasuryUtxos } = bridge;
export const send = (to, amount) => bridge.sendAndConfirm(() => preparePayout(to, amount));
export const depositTx = async (addr) => (await adapter.utxos(addr).catch(() => []))[0]?.txid || null;
export const feeEstimate = (nIn = 1, nOut = 2) => feeZip317(nIn, nOut);

let healthCache = { at: 0, v: null };
export async function zecHealth() {
  if (Date.now() - healthCache.at < 10_000 && healthCache.v) return healthCache.v;
  const out = { ok: false, name: ZEC_CHAIN.name, network: ZEC_CHAIN.network, rpc: rpcInfo(), swapCapZec: (Number(ZEC_CAP_ZAT) / 1e8).toString(), minZec: (Number(ZEC_MIN_ZAT) / 1e8).toString(), confirmations: ZEC_CHAIN.confirmations, pool: 'transparent' };
  try {
    if (!relayerConfigured()) throw new Error('treasury key not configured');
    out.treasury = treasury().address;
    const bal = await treasuryBalance();
    out.treasuryZec = (Number(bal) / 1e8).toFixed(8);
    out.ok = bal >= ZEC_CAP_ZAT / 5n;
  } catch (e) { out.error = scrub(e.message); }
  healthCache = { at: Date.now(), v: out };
  return out;
}
