// Solana devnet bridge: trusted relayer, no on-chain program. Hand-rolled legacy transactions over JSON-RPC
// (tweetnacl + bs58 only, no web3.js). Devnet only, classic SPL Token program only (no Token-2022).
//  - deposit address = per-quote ed25519 key derived from the master seed (SOL goes to it; SPL to its associated token account)
//  - sweep: the deposit key signs, the relayer pays fees, funds move to the treasury (the relayer wallet / its ATAs)
//  - payouts/refunds: relayer signs. Transactions are SIGNED FIRST, the signature + last-valid block height is persisted, then sent;
//    a retry checks the signature status and only re-signs once the blockhash has provably expired, so nothing is paid twice.
import crypto from 'node:crypto';
import fs from 'node:fs';
import nacl from 'tweetnacl';
import bs58 from 'bs58';
import { SOL_CHAIN, TOKENS, SOL_PAYOUT_CAP_LAMPORTS } from './config.mjs';

// ---------- RPC with failover (SOLANA_DEVNET_RPC first, then the public devnet endpoint). URLs are never logged or put in errors. ----------
export class SolRpcError extends Error {
  constructor(message, { code, transient = false, data } = {}) { super(message); this.name = 'SolRpcError'; this.code = code; this.transient = transient; this.data = data; }
}
const urls = () => [process.env.SOLANA_DEVNET_RPC, 'https://api.devnet.solana.com'].map(s => s?.trim()).filter(Boolean);
export const rpcInfo = () => ({ custom: Boolean(process.env.SOLANA_DEVNET_RPC?.trim()), endpoints: urls().length });
const cooldown = new Map(); // endpoint index -> epoch ms until which we skip it
const TRANSIENT_CODES = new Set([-32005, -32004, -32007, -32009, -32014, -32016, 429, 503]);
async function once(i, method, params, timeout) {
  let r;
  try {
    r = await fetch(urls()[i], { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), signal: AbortSignal.timeout(timeout) });
  } catch { throw new SolRpcError(`${method}: rpc endpoint #${i} unreachable`, { transient: true }); }
  if (r.status === 429 || r.status >= 500) { cooldown.set(i, Date.now() + (r.status === 429 ? 30_000 : 10_000)); throw new SolRpcError(`${method}: rpc endpoint #${i} HTTP ${r.status}`, { code: r.status, transient: true }); }
  const j = await r.json().catch(() => null);
  if (!j) throw new SolRpcError(`${method}: rpc endpoint #${i} returned a non-JSON body (HTTP ${r.status})`, { transient: true });
  if (j.error) {
    const tr = TRANSIENT_CODES.has(j.error.code);
    if (tr) cooldown.set(i, Date.now() + 5_000);
    throw new SolRpcError(`${method}: ${String(j.error.message).slice(0, 300)}`, { code: j.error.code, transient: tr, data: j.error.data });
  }
  return j.result;
}
export async function rpc(method, params = [], { timeout = 15_000 } = {}) {
  const n = urls().length, now = Date.now();
  const order = [...Array(n).keys()].sort((a, b) => ((cooldown.get(a) > now) - (cooldown.get(b) > now)) || a - b);
  let last;
  for (const i of order) {
    try { return await once(i, method, params, timeout); } catch (e) { last = e; if (!(e instanceof SolRpcError) || !e.transient) throw e; }
  }
  throw last;
}

// ---------- keys ----------
const parseSecret = (raw) => { raw = raw.trim(); const sk = raw.startsWith('[') ? Uint8Array.from(JSON.parse(raw)) : bs58.decode(raw); if (sk.length !== 64) throw new Error('bad Solana secret key length'); return sk; };
let relayerKp;
export function relayer() {
  if (relayerKp) return relayerKp;
  let raw = process.env.SOLANA_RELAYER_KEY;
  if (!raw) { const f = new URL('../../.secrets/solana-relayer.key', import.meta.url); if (fs.existsSync(f)) raw = fs.readFileSync(f, 'utf8'); }
  if (!raw) throw new Error('SOLANA_RELAYER_KEY is not configured');
  const kp = nacl.sign.keyPair.fromSecretKey(parseSecret(raw));
  return relayerKp = { publicKey: kp.publicKey, secretKey: kp.secretKey, address: bs58.encode(kp.publicKey) };
}
export const relayerConfigured = () => { try { relayer(); return true; } catch { return false; } };
export function keypairFromFile(path) { const kp = nacl.sign.keyPair.fromSecretKey(parseSecret(fs.readFileSync(path, 'utf8'))); return { publicKey: kp.publicKey, secretKey: kp.secretKey, address: bs58.encode(kp.publicKey) }; }
/** Per-quote deposit keypair: HMAC-SHA256(master, "tidepool-sol-deposit:<id>") used as an ed25519 seed. Nothing per-quote is stored. */
export function depositKeypair(master, id) {
  const kp = nacl.sign.keyPair.fromSeed(crypto.createHmac('sha256', master).update(`tidepool-sol-deposit:${id}`).digest());
  return { publicKey: kp.publicKey, secretKey: kp.secretKey, address: bs58.encode(kp.publicKey) };
}
export const depositAddressFor = (master, id) => depositKeypair(master, id).address;

// ---------- addresses: program ids, PDA, associated token accounts ----------
const b58 = (s) => bs58.decode(s);
export const SYSTEM_PROGRAM = b58('11111111111111111111111111111111');
export const TOKEN_PROGRAM = b58('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
export const ATA_PROGRAM = b58('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL');
const P = 2n ** 255n - 19n;
const mod = (a) => ((a % P) + P) % P;
function pow(b, e) { let r = 1n; b = mod(b); while (e > 0n) { if (e & 1n) r = mod(r * b); b = mod(b * b); e >>= 1n; } return r; }
const D = mod(-121665n * pow(121666n, P - 2n));
/** true if the 32 bytes decode to a point on the ed25519 curve (a PDA must be OFF the curve). */
export function onCurve(bytes) {
  const b = Buffer.from(bytes); b[31] &= 0x7f;
  let y = 0n; for (let i = 31; i >= 0; i--) y = (y << 8n) | BigInt(b[i]);
  if (y >= P) return false;
  const y2 = mod(y * y), u = mod(y2 - 1n), v = mod(D * y2 + 1n);
  const x2 = mod(u * pow(v, P - 2n));
  return x2 === 0n || pow(x2, (P - 1n) / 2n) === 1n;
}
export function findProgramAddress(seeds, programId) {
  for (let bump = 255; bump >= 0; bump--) {
    const h = crypto.createHash('sha256').update(Buffer.concat([...seeds.map(s => Buffer.from(s)), Buffer.from([bump]), Buffer.from(programId), Buffer.from('ProgramDerivedAddress')])).digest();
    if (!onCurve(h)) return { address: new Uint8Array(h), bump };
  }
  throw new Error('no viable PDA bump');
}
const ataCache = new Map();
export function ataOf(owner, mint) { // base58 -> base58
  const k = owner + ':' + mint;
  let a = ataCache.get(k);
  if (!a) { a = bs58.encode(findProgramAddress([b58(owner), TOKEN_PROGRAM, b58(mint)], ATA_PROGRAM).address); if (ataCache.size > 5000) ataCache.clear(); ataCache.set(k, a); }
  return a;
}

// ---------- transaction building ----------
const cu16 = (n) => { const o = []; while (true) { let b = n & 0x7f; n >>= 7; if (n) o.push(b | 0x80); else { o.push(b); break; } } return Buffer.from(o); };
const u64 = (n) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(n)); return b; };
const meta = (pubkey, signer, writable) => ({ pubkey: typeof pubkey === 'string' ? b58(pubkey) : pubkey, signer, writable });
export const ix = {
  systemTransfer: (from, to, lamports) => ({ programId: SYSTEM_PROGRAM, keys: [meta(from, true, true), meta(to, false, true)], data: Buffer.concat([Buffer.from([2, 0, 0, 0]), u64(lamports)]) }),
  systemCreateAccount: (from, newAcct, lamports, space, owner) => ({ programId: SYSTEM_PROGRAM, keys: [meta(from, true, true), meta(newAcct, true, true)], data: Buffer.concat([Buffer.from([0, 0, 0, 0]), u64(lamports), u64(space), Buffer.from(owner)]) }),
  initializeMint2: (mint, decimals, authority) => ({ programId: TOKEN_PROGRAM, keys: [meta(mint, false, true)], data: Buffer.concat([Buffer.from([20, decimals]), Buffer.from(typeof authority === 'string' ? b58(authority) : authority), Buffer.from([0])]) }),
  createAtaIdempotent: (payer, owner, mint) => ({ programId: ATA_PROGRAM, keys: [meta(payer, true, true), meta(ataOf(owner, mint), false, true), meta(owner, false, false), meta(mint, false, false), meta(SYSTEM_PROGRAM, false, false), meta(TOKEN_PROGRAM, false, false)], data: Buffer.from([1]) }),
  transferChecked: (source, mint, dest, owner, amount, decimals) => ({ programId: TOKEN_PROGRAM, keys: [meta(source, false, true), meta(mint, false, false), meta(dest, false, true), meta(owner, true, false)], data: Buffer.concat([Buffer.from([12]), u64(amount), Buffer.from([decimals])]) }),
  mintTo: (mint, dest, authority, amount) => ({ programId: TOKEN_PROGRAM, keys: [meta(mint, false, true), meta(dest, false, true), meta(authority, true, false)], data: Buffer.concat([Buffer.from([7]), u64(amount)]) }),
};
const hex = (k) => Buffer.from(k).toString('hex');
/** Compile + sign a legacy transaction. signers: [{publicKey, secretKey}]. Returns { sig (base58), raw (base64), message }. */
export function buildTx({ feePayer, instructions, blockhash, signers }) {
  const metas = new Map();
  const add = (pk, signer, writable) => { const k = hex(pk), m = metas.get(k); if (m) { m.signer ||= signer; m.writable ||= writable; } else metas.set(k, { pubkey: Buffer.from(pk), signer, writable, order: metas.size }); };
  add(feePayer, true, true);
  for (const i of instructions) for (const k of i.keys) add(k.pubkey, k.signer, k.writable);
  for (const i of instructions) add(i.programId, false, false);
  const cls = (m) => m.signer ? (m.writable ? 0 : 1) : (m.writable ? 2 : 3);
  const list = [...metas.values()].sort((a, b) => cls(a) - cls(b) || a.order - b.order);
  const idx = new Map(list.map((m, i) => [hex(m.pubkey), i]));
  const header = Buffer.from([list.filter(m => m.signer).length, list.filter(m => cls(m) === 1).length, list.filter(m => cls(m) === 3).length]);
  const body = [cu16(list.length), ...list.map(m => m.pubkey), b58(blockhash), cu16(instructions.length)];
  for (const i of instructions) body.push(Buffer.from([idx.get(hex(i.programId))]), cu16(i.keys.length), Buffer.from(i.keys.map(k => idx.get(hex(k.pubkey)))), cu16(i.data.length), i.data);
  const message = Buffer.concat([header, ...body]);
  const sigs = list.filter(m => m.signer).map(m => {
    const s = signers.find(x => hex(x.publicKey) === hex(m.pubkey));
    if (!s) throw new Error('missing signer for ' + bs58.encode(m.pubkey));
    return Buffer.from(nacl.sign.detached(message, s.secretKey));
  });
  return { sig: bs58.encode(sigs[0]), raw: Buffer.concat([cu16(sigs.length), ...sigs, message]).toString('base64'), message };
}

// ---------- chain reads ----------
export async function latestBlockhash() { return (await rpc('getLatestBlockhash', [{ commitment: 'confirmed' }])).value; }
export const blockHeight = () => rpc('getBlockHeight', [{ commitment: 'confirmed' }]);
export async function minRent(space) { return BigInt(await rpc('getMinimumBalanceForRentExemption', [space])); }

// getMultipleAccounts, micro-batched: every balance wanted within ~40ms (across all active swaps) is fetched in ONE request.
let queue = null;
async function flush() {
  const q = queue; queue = null;
  const uniq = [...new Set(q.map(x => x.addr))];
  const found = new Map();
  try {
    for (let i = 0; i < uniq.length; i += 100) {
      const chunk = uniq.slice(i, i + 100);
      const r = await rpc('getMultipleAccounts', [chunk, { encoding: 'base64', commitment: 'confirmed' }]);
      chunk.forEach((a, j) => { const v = r.value[j]; found.set(a, v ? { lamports: BigInt(v.lamports), owner: v.owner, data: Buffer.from(v.data[0], 'base64') } : null); });
    }
    for (const x of q) x.res(found.get(x.addr) ?? null);
  } catch (e) { for (const x of q) x.rej(e); }
}
export function account(addr) {
  return new Promise((res, rej) => { if (!queue) { queue = []; setTimeout(flush, 40); } queue.push({ addr, res, rej }); });
}
/** Balance (base units) held by a deposit address for token t: lamports for native SOL, the ATA's token amount for SPL. */
export async function depositBalance(t, depositAddr) {
  if (t.native) return (await account(depositAddr))?.lamports ?? 0n;
  const a = await account(ataOf(depositAddr, t.mint));
  if (!a || a.data.length < 72 || a.data.subarray(0, 32).toString('hex') !== hex(b58(t.mint))) return 0n;
  return a.data.readBigUInt64LE(64);
}
export async function treasuryBalance(t) { return depositBalance(t, relayer().address); }
/** First confirmed, successful inbound-looking signature touching the account (for the deposit tx hash shown to users). */
export async function recentSignatures(addr, limit = 10) {
  const r = await rpc('getSignaturesForAddress', [addr, { limit, commitment: 'confirmed' }]);
  return r.filter(x => !x.err).map(x => x.signature);
}

// ---------- sign-first / record / check-signature sending ----------
export const txUrl = (sig) => `${SOL_CHAIN.explorer}/tx/${sig}?cluster=${SOL_CHAIN.cluster}`;
export const addrUrl = (a) => `${SOL_CHAIN.explorer}/address/${a}?cluster=${SOL_CHAIN.cluster}`;
export async function prepare(instructions, extraSigners = []) {
  const r = relayer(), bh = await latestBlockhash();
  const t = buildTx({ feePayer: r.publicKey, instructions, blockhash: bh.blockhash, signers: [r, ...extraSigners] });
  return { sig: t.sig, raw: t.raw, lastValid: bh.lastValidBlockHeight };
}
export const sendRaw = (raw, skipPreflight = false) => rpc('sendTransaction', [raw, { encoding: 'base64', skipPreflight, preflightCommitment: 'confirmed' }]);
/** 'confirmed' | 'failed' | 'pending' | 'expired' for a recorded {sig,lastValid}. */
export async function status(rec) {
  const st = (await rpc('getSignatureStatuses', [[rec.sig], { searchTransactionHistory: true }])).value[0];
  if (st) { if (st.err) return 'failed'; return ['confirmed', 'finalized'].includes(st.confirmationStatus) ? 'confirmed' : 'pending'; }
  return (await blockHeight()) > rec.lastValid + 20 ? 'expired' : 'pending';
}
/**
 * Idempotent driver for one transaction slot `rec` (a plain object persisted in the swap record).
 * rec holds {sig, raw, lastValid, fails}. Returns 'confirmed' or 'pending'. `build` returns prepare(...) output.
 * Never re-signs while a previously signed tx could still land.
 */
export async function drive(rec, build, persist) {
  if (rec.sig) {
    const st = await status(rec);
    if (st === 'confirmed') return 'confirmed';
    if (st === 'pending') { await sendRaw(rec.raw, true).catch(() => {}); return 'pending'; }
    rec.fails = (rec.fails || 0) + (st === 'failed' ? 1 : 0);
    delete rec.sig; delete rec.raw; delete rec.lastValid; // failed on-chain or blockhash provably expired: safe to re-sign
    persist();
    if (rec.fails >= 5) throw new Error('Solana transaction failed on-chain 5 times; needs operator attention');
  }
  const p = await build();
  rec.sig = p.sig; rec.raw = p.raw; rec.lastValid = p.lastValid;
  persist(); // record BEFORE sending
  try { await sendRaw(p.raw); } catch (e) {
    if (e instanceof SolRpcError && !e.transient) { delete rec.sig; delete rec.raw; delete rec.lastValid; persist(); } // rejected by preflight: it was never broadcast
    throw e; // transient errors keep the record; the next tick checks the signature
  }
  return 'pending';
}
/** Send and wait (used by the faucet and scripts). Re-signs only after expiry. */
export async function sendAndConfirm(instructions, extraSigners = [], { timeoutMs = 90_000 } = {}) {
  const rec = {}, until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    const r = await drive(rec, () => prepare(instructions, extraSigners), () => {});
    if (r === 'confirmed') return rec.sig;
    await new Promise(r => setTimeout(r, 1500));
  }
  throw new Error('Solana transaction not confirmed in time');
}

// ---------- bridge operations ----------
/** Sweep a deposit address into the treasury. amount is what we observed; the deposit key signs, the relayer pays fees. */
export function sweepInstructions(t, dep, amount) {
  const r = relayer();
  if (t.native) return [ix.systemTransfer(dep.publicKey, r.publicKey, amount)];
  return [ix.transferChecked(ataOf(dep.address, t.mint), t.mint, ataOf(r.address, t.mint), dep.publicKey, amount, t.decimals)];
}
/** Pay `amount` of t to `to` from the treasury. SPL: creates the recipient ATA (treasury pays rent) then transferChecked, minting the shortfall (we hold the mint authority). */
export async function payoutInstructions(t, to, amount) {
  const r = relayer();
  if (t.native) return [ix.systemTransfer(r.publicKey, to, amount)];
  const have = await treasuryBalance(t);
  const dest = ataOf(to, t.mint), out = [ix.createAtaIdempotent(r.publicKey, to, t.mint)];
  if (have >= BigInt(amount)) out.push(ix.transferChecked(ataOf(r.address, t.mint), t.mint, dest, r.publicKey, amount, t.decimals));
  else out.push(ix.mintTo(t.mint, dest, r.publicKey, amount));
  return out;
}
/** Faucet: mint test SPL tokens straight to a wallet (creating its ATAs). The relayer is the mint authority. */
export async function faucetMint(to, tokens) {
  const r = relayer(), ixs = [];
  for (const t of tokens) ixs.push(ix.createAtaIdempotent(r.publicKey, to, t.mint), ix.mintTo(t.mint, ataOf(to, t.mint), r.publicKey, t.dripUnits));
  return sendAndConfirm(ixs);
}

let healthCache = { at: 0 };
export async function solHealth() {
  if (Date.now() - healthCache.at < 10_000 && healthCache.v) return healthCache.v;
  const out = { ok: false, name: SOL_CHAIN.name, cluster: SOL_CHAIN.cluster, rpc: rpcInfo(), payoutCapSol: (Number(SOL_PAYOUT_CAP_LAMPORTS) / 1e9).toString() };
  try {
    if (!relayerConfigured()) throw new Error('relayer key not configured');
    const r = relayer(), spl = TOKENS.filter(t => t.kind === 'sol' && !t.native);
    const [height, accts] = await Promise.all([blockHeight(), Promise.all([account(r.address), ...spl.map(t => account(ataOf(r.address, t.mint)))])]);
    out.height = height; out.relayer = r.address;
    out.relayerSol = (Number(accts[0]?.lamports ?? 0n) / 1e9).toFixed(4);
    out.treasury = {};
    spl.forEach((t, i) => { const a = accts[i + 1]; out.treasury[t.symbol] = a && a.data.length >= 72 ? (Number(a.data.readBigUInt64LE(64)) / 10 ** t.decimals).toString() : '0'; });
    out.ok = Number(out.relayerSol) >= 0.01;
  } catch (e) { out.error = String(e.message).slice(0, 200); }
  healthCache = { at: Date.now(), v: out };
  return out;
}

// Best-effort devnet treasury refill. The treasury pays ATA rent and fees, and devnet SOL only comes from rate-limited airdrops.
// When the treasury drops below LOW SOL, request a 2 SOL airdrop from the public devnet RPC (never faucet.solana.com), at most once per
// interval, with backoff on failure. Disable with SOLANA_AUTO_AIRDROP=0. Logs balances only (never keys or RPC URLs).
const AIRDROP_LOW = BigInt(Math.round(Number(process.env.SOLANA_AIRDROP_LOW_SOL || 3) * 1e9));
// Endpoints that may run a devnet faucet: SOLANA_AIRDROP_RPC, then your SOLANA_DEVNET_RPC provider (Alchemy, Helius, QuickNode and Triton
// enable requestAirdrop on devnet), then the public node (its RPC faucet is currently closed; it points to the web faucet).
const airdropRpcs = () => [...(process.env.SOLANA_AIRDROP_RPC || '').split(','), process.env.SOLANA_DEVNET_RPC, 'https://api.devnet.solana.com'].map(s => s?.trim()).filter(Boolean);
let airdrop = { next: 0, fails: 0 };
export async function maybeTopUp() {
  if (process.env.SOLANA_AUTO_AIRDROP === '0' || !relayerConfigured() || Date.now() < airdrop.next) return;
  const addr = relayer().address;
  const bal = (await account(addr))?.lamports ?? 0n;
  if (bal >= AIRDROP_LOW) { airdrop = { next: Date.now() + 10 * 60_000, fails: 0 }; return; }
  try {
    const call = async (url, method, params) => {
      const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), signal: AbortSignal.timeout(20_000) });
      const j = await r.json();
      if (j.error) throw new Error(j.error.message);
      return j.result;
    };
    let sig, url, last;
    for (const u of airdropRpcs()) { try { sig = await call(u, 'requestAirdrop', [addr, 2_000_000_000]); url = u; break; } catch (e) { last = e; } }
    if (!sig) throw last || new Error('no airdrop endpoint');
    for (let i = 0; i < 20; i++) { await new Promise(r => setTimeout(r, 2000)); const st = (await call(url, 'getSignatureStatuses', [[sig]])).value[0]; if (st?.err) throw new Error('airdrop tx failed'); if (st?.confirmationStatus === 'confirmed' || st?.confirmationStatus === 'finalized') break; }
    airdrop = { next: Date.now() + 2 * 60_000, fails: 0 }; // top up again soon until we are above LOW
    console.log(`[solana] treasury airdrop requested (had ${(Number(bal) / 1e9).toFixed(3)} SOL)`);
  } catch (e) {
    airdrop.fails++; airdrop.next = Date.now() + Math.min(2 * 3600_000, 5 * 60_000 * 2 ** airdrop.fails);
    console.log(`[solana] treasury airdrop failed (${String(e.message).replace(/https?:\/\/\S+/g, '').slice(0, 80)}); retry later`);
  }
}
export function startTreasuryWatch() {
  if (process.env.SOLANA_AUTO_AIRDROP === '0') return;
  const run = () => maybeTopUp().catch(() => {});
  setTimeout(run, 10_000); setInterval(run, 60_000).unref?.();
}
