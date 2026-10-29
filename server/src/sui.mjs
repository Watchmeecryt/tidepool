// Sui testnet bridge: trusted relayer, no on-chain program besides Tidepool's own test Move coins (published with the sui CLI).
// gRPC only (the public JSON-RPC is deprecated). Transactions are built offline from explicit object references, so a signed
// transaction has a deterministic digest and can only ever execute once (its inputs are consumed).
//  - deposit address = per-quote ed25519 key derived from the master seed (Sui has no memos). SUI and coin objects are sent to it.
//  - sweep: the deposit key is the sender, the treasury is the gas SPONSOR (gas owner), funds move to the treasury address.
//  - payouts/refunds: the treasury signs. SUI is split from the gas coins; test USDC/USDT are MINTED to the recipient (we hold the TreasuryCaps).
//  - every treasury-signed transaction is serialized through one lock; the signed bytes are persisted BEFORE they are executed, retries
//    look the digest up and re-submit the very same bytes, and a new signature is only made when the old one can never land.
// Keys, RPC URLs and secrets never leave this module and are never logged.
import crypto from 'node:crypto';
import fs from 'node:fs';
import { SuiGrpcClient } from '@mysten/sui/grpc';
import { exclusive } from './guard.mjs';
import { Transaction, Inputs, TransactionDataBuilder } from '@mysten/sui/transactions';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { decodeSuiPrivateKey } from '@mysten/sui/cryptography';
import { fromBase64 } from '@mysten/sui/utils';
import { SUI_CHAIN, SUI_COIN_TYPE, TOKENS, SUI_CAP_MIST } from './config.mjs';

const SECRETS = new URL('../../.secrets/', import.meta.url).pathname;
const GAS_BUDGET = 15_000_000n; // 0.015 SUI; only the gas actually used is charged
const MAX_COINS = 250;

export class SuiError extends Error {
  constructor(message, { code, transient = false } = {}) { super(message); this.name = 'SuiError'; this.code = code; this.transient = transient; }
}
const TRANSIENT = new Set(['UNAVAILABLE', 'DEADLINE_EXCEEDED', 'RESOURCE_EXHAUSTED', 'INTERNAL', 'UNKNOWN', 'ABORTED', 'CANCELLED']);
const scrub = (m) => String(m || '').replace(/https?:\/\/\S+/g, '').replace(/\s+/g, ' ').slice(0, 220);
const wrap = (e) => { if (e instanceof SuiError) return e; const code = e?.code; return new SuiError(`Sui RPC ${code || 'error'}: ${scrub(decodeURIComponent(e?.message || ''))}`, { code, transient: !code || TRANSIENT.has(code) || e?.name === 'TypeError' || e?.name === 'AbortError' }); };

// ---------- clients with failover (SUI_GRPC_URL first, then the public testnet fullnode). URLs are never logged. ----------
const urls = () => [process.env.SUI_GRPC_URL, 'https://fullnode.testnet.sui.io:443'].map(s => s?.trim()).filter(Boolean);
export const rpcInfo = () => ({ custom: Boolean(process.env.SUI_GRPC_URL?.trim()), endpoints: urls().length });
const clients = new Map();
const clientFor = (u) => { if (!clients.has(u)) clients.set(u, new SuiGrpcClient({ network: 'testnet', baseUrl: u })); return clients.get(u); };
const cooldown = new Map();
async function withClient(fn) {
  let last;
  const list = urls();
  for (let i = 0; i < list.length; i++) {
    if ((cooldown.get(i) || 0) > Date.now() && i < list.length - 1) continue;
    try { return await fn(clientFor(list[i])); } catch (e) {
      last = wrap(e);
      if (!last.transient) throw last;
      cooldown.set(i, Date.now() + 20_000);
    }
  }
  throw last || new SuiError('no Sui endpoint available', { transient: true });
}

// ---------- keys (env SUI_TREASURY_KEY = a suiprivkey1... bech32 string, or the gitignored .secrets/sui-treasury.key) ----------
let relayerKp;
export function relayer() {
  if (relayerKp) return relayerKp;
  let secret = process.env.SUI_TREASURY_KEY?.trim();
  if (!secret) { try { secret = fs.readFileSync(SECRETS + 'sui-treasury.key', 'utf8').trim(); } catch { /* not configured */ } }
  if (!secret) throw new Error('Sui treasury key not configured');
  const kp = Ed25519Keypair.fromSecretKey(decodeSuiPrivateKey(secret).secretKey);
  relayerKp = { kp, address: kp.toSuiAddress() };
  return relayerKp;
}
export const relayerConfigured = () => { try { return relayer().address === SUI_CHAIN.treasury; } catch { return false; } };
/** Per-quote deposit keypair: HMAC-SHA256(master, "tidepool-sui-deposit:<id>") used as an ed25519 seed. Nothing per-quote is stored. */
export function depositKeypair(master, id) {
  const kp = Ed25519Keypair.fromSecretKey(crypto.createHmac('sha256', master).update(`tidepool-sui-deposit:${id}`).digest());
  return { kp, address: kp.toSuiAddress() };
}
export const depositAddressFor = (master, id) => depositKeypair(master, id).address;
export const txUrl = (d) => `${SUI_CHAIN.explorer}/tx/${d}`;
export const addrUrl = (a) => `${SUI_CHAIN.explorer}/account/${a}`;

// ---------- reads ----------
/** Coin objects of one type owned by `address` (the spendable form: coin objects, not an address balance). */
export async function coinsOf(address, coinType, limit = MAX_COINS) {
  const out = [];
  let cursor = null;
  do {
    const r = await withClient(c => c.core.getCoins({ address, coinType, cursor, limit: 200 }));
    out.push(...r.objects.map(o => ({ id: o.id, version: o.version, digest: o.digest, balance: BigInt(o.balance), prev: o.previousTransaction })));
    cursor = r.hasNextPage ? r.cursor : null;
  } while (cursor && out.length < limit);
  return out.sort((a, b) => (a.balance < b.balance ? 1 : a.balance > b.balance ? -1 : 0)).slice(0, limit);
}
/** Balance (base units) of coin objects held by a deposit address for token t. */
export async function depositBalance(t, addr) { return (await coinsOf(addr, t.coinType)).reduce((a, c) => a + c.balance, 0n); }
export const treasuryBalance = (t) => depositBalance(t, relayer().address);
/** Digest of a transaction that delivered a coin to the address (shown to users as the deposit tx). */
export async function depositTx(t, addr) { return (await coinsOf(addr, t.coinType, 1))[0]?.prev || null; }
let gasPriceCache = { at: 0, v: 1000n };
async function gasPrice() {
  if (Date.now() - gasPriceCache.at < 60_000) return gasPriceCache.v;
  try { const r = await withClient(c => c.core.getReferenceGasPrice()); gasPriceCache = { at: Date.now(), v: BigInt(r.referenceGasPrice) }; } catch { /* keep the last known */ }
  return gasPriceCache.v;
}
const objRef = (o) => ({ objectId: o.id, version: o.version, digest: o.digest });

// ---------- transactions ----------
async function baseTx({ sender, gasCoins }) {
  const tx = new Transaction();
  tx.setSender(sender); tx.setGasOwner(relayer().address);
  tx.setGasPayment(gasCoins.slice(0, 10).map(objRef));
  tx.setGasPrice(await gasPrice()); tx.setGasBudget(GAS_BUDGET);
  return tx;
}
async function treasuryGas() {
  const g = await coinsOf(relayer().address, SUI_COIN_TYPE, 10);
  if (!g.length || g.reduce((a, c) => a + c.balance, 0n) < GAS_BUDGET * 2n) throw new SuiError('Sui treasury is out of gas; refill it from https://faucet.sui.io', { transient: true });
  return g;
}
async function finish(tx, signers) {
  const bytes = await tx.build();
  const sigs = [];
  for (const kp of signers) sigs.push((await kp.signTransaction(bytes)).signature);
  return { digest: TransactionDataBuilder.getDigestFromBytes(bytes), bytes: Buffer.from(bytes).toString('base64'), sigs };
}
/** Sweep every coin object of t at a deposit address into the treasury; the treasury sponsors gas. Returns the signed tx and the exact amount it moves. */
export async function prepareSweep(t, dep) {
  const coins = await coinsOf(dep.address, t.coinType);
  if (!coins.length) throw new Error('deposit address is empty; waiting for the previous sweep to confirm');
  const gas = await treasuryGas();
  const tx = await baseTx({ sender: dep.address, gasCoins: gas });
  const first = tx.object(Inputs.ObjectRef(objRef(coins[0])));
  if (coins.length > 1) tx.mergeCoins(first, coins.slice(1).map(c => tx.object(Inputs.ObjectRef(objRef(c)))));
  tx.transferObjects([first], tx.pure.address(relayer().address));
  const p = await finish(tx, [dep.kp, relayer().kp]);
  p.amount = coins.reduce((a, c) => a + c.balance, 0n);
  return p;
}
/** Pay `amount` of t to `to` from the treasury: SUI is split from the gas coins; test coins are minted straight to the recipient. */
export async function preparePayout(t, to, amount) {
  amount = BigInt(amount);
  const gas = await treasuryGas();
  const tx = await baseTx({ sender: relayer().address, gasCoins: gas });
  if (t.native) {
    if (gas.reduce((a, c) => a + c.balance, 0n) < amount + GAS_BUDGET) throw new SuiError('Sui treasury has too little SUI for this payout', { transient: true });
    const [c] = tx.splitCoins(tx.gas, [tx.pure.u64(amount)]);
    tx.transferObjects([c], tx.pure.address(to));
  } else mintInto(tx, await capRef(t), t, to, amount);
  return finish(tx, [relayer().kp]);
}
async function capRef(t) {
  const r = await withClient(c => c.core.getObject({ objectId: t.treasuryCap }));
  return Inputs.ObjectRef({ objectId: r.object.id, version: r.object.version, digest: r.object.digest });
}
const mintInto = (tx, cap, t, to, amount) => tx.moveCall({ target: '0x2::coin::mint_and_transfer', typeArguments: [t.coinType], arguments: [tx.object(cap), tx.pure.u64(BigInt(amount)), tx.pure.address(to)] });
/** Faucet: mint test coins straight to a wallet (one transaction). */
export async function prepareFaucetMint(to, tokens) {
  const gas = await treasuryGas();
  const tx = await baseTx({ sender: relayer().address, gasCoins: gas });
  for (const t of tokens) mintInto(tx, await capRef(t), t, to, t.dripUnits);
  return finish(tx, [relayer().kp]);
}

// ---------- submit / status / idempotent driver ----------
async function submit(p) {
  const { response } = await withClient(c => c.transactionExecutionService.executeTransaction({
    transaction: { bcs: { value: fromBase64(p.bytes) } },
    signatures: p.sigs.map(s => ({ bcs: { value: fromBase64(s) }, signature: { oneofKind: undefined } })),
    readMask: { paths: ['digest', 'effects.status'] },
  }));
  const st = response.transaction?.effects?.status;
  return { digest: response.transaction?.digest || p.digest, success: st ? Boolean(st.success) : true, error: st?.error ? scrub(JSON.stringify(st.error, (_, v) => (typeof v === 'bigint' ? v.toString() : v))) : null };
}
/** 'confirmed' | 'failed' | 'pending' (not found: not executed yet). */
export async function status(digest) {
  try {
    const { response } = await withClient(c => c.ledgerService.getTransaction({ digest, readMask: { paths: ['digest', 'effects.status', 'checkpoint'] } }));
    const st = response.transaction?.effects?.status;
    return st?.success === false ? 'failed' : 'confirmed';
  } catch (e) { const w = wrap(e); if (w.code === 'NOT_FOUND') return 'pending'; throw w; }
}
async function settle(digest) { // let the fullnode index the new object versions before the next signing
  for (let i = 0; i < 12; i++) {
    try { const { response } = await withClient(c => c.ledgerService.getTransaction({ digest, readMask: { paths: ['digest', 'checkpoint'] } })); if (response.transaction?.checkpoint !== undefined) return; } catch { /* not indexed yet */ }
    await new Promise(r => setTimeout(r, 700));
  }
}
let lockChain = Promise.resolve();
const withLock = (fn) => { const run = lockChain.then(fn, fn); lockChain = run.catch(() => {}); return run; };
const clear = (rec) => { delete rec.digest; delete rec.bytes; delete rec.sigs; };
/**
 * Idempotent driver for one transaction slot `rec` (a plain object persisted in the swap record): {digest, bytes, sigs, fails}.
 * `build` returns {digest, bytes, sigs, ...}. Returns 'confirmed' or 'pending'. Builds, signs and records under the treasury lock.
 */
export const drive = (rec, build, persist) => exclusive(rec, () => step(rec, build, persist)); // one step at a time per slot: see guard.mjs
async function step(rec, build, persist) {
  if (rec.digest) {
    const st = await status(rec.digest);
    if (st === 'confirmed') return 'confirmed';
    if (st === 'failed') { rec.fails = (rec.fails || 0) + 1; clear(rec); persist(); if (rec.fails >= 5) throw new Error('Sui transaction failed on-chain 5 times; needs operator attention'); }
    else { // not executed yet: re-submit the same signed bytes (idempotent). Fresh signing only if it can provably never land.
      try {
        const r = await submit(rec);
        if (r.success) return 'confirmed';
        rec.fails = (rec.fails || 0) + 1; clear(rec); persist(); // executed with an abort: gas spent, effects are failure
        if (rec.fails >= 5) throw new Error(`Sui transaction failed on-chain 5 times (${r.error || 'abort'}); needs operator attention`);
      } catch (e) {
        const w = wrap(e);
        if (w.transient) return 'pending';
        if (await status(rec.digest) === 'confirmed') return 'confirmed';
        clear(rec); persist(); // rejected on validation (inputs consumed or invalid): it was never and can never be executed
      }
    }
  }
  return withLock(async () => {
    const p = await build();
    rec.digest = p.digest; rec.bytes = p.bytes; rec.sigs = p.sigs;
    persist(); // record BEFORE executing
    try {
      const r = await submit(p);
      if (r.success) { await settle(p.digest); return 'confirmed'; }
      rec.fails = (rec.fails || 0) + 1; clear(rec); persist();
      if (rec.fails >= 5) throw new Error(`Sui transaction failed on-chain 5 times (${r.error || 'abort'}); needs operator attention`);
      return 'pending';
    } catch (e) {
      if (e instanceof SuiError && !e.transient) { clear(rec); persist(); } // rejected on validation: never executed
      throw e; // transient errors keep the record; the next tick checks the digest
    }
  });
}
/** Send and wait (faucet and scripts). */
export async function sendAndConfirm(build, { timeoutMs = 60_000 } = {}) {
  const rec = {}, until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    if (await drive(rec, build, () => {}) === 'confirmed') return rec.digest;
    await new Promise(r => setTimeout(r, 1500));
  }
  throw new Error('Sui transaction not confirmed in time');
}
export const faucetMint = (to, tokens) => sendAndConfirm(() => prepareFaucetMint(to, tokens));

let healthCache = { at: 0 };
export async function suiHealth() {
  if (Date.now() - healthCache.at < 10_000 && healthCache.v) return healthCache.v;
  const out = { ok: false, name: SUI_CHAIN.name, network: 'testnet', rpc: rpcInfo(), swapCapSui: (Number(SUI_CAP_MIST) / 1e9).toString() };
  try {
    if (!relayerConfigured()) throw new Error('treasury key not configured');
    out.treasury = relayer().address; out.package = SUI_CHAIN.package;
    const coins = await coinsOf(out.treasury, SUI_COIN_TYPE, 1000);
    const total = coins.reduce((a, c) => a + c.balance, 0n);
    out.treasurySui = (Number(total) / 1e9).toFixed(4);
    out.ok = total >= 200_000_000n;
  } catch (e) { out.error = scrub(e.message); }
  healthCache = { at: Date.now(), v: out };
  return out;
}
