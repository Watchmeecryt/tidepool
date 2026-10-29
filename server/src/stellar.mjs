// Stellar testnet bridge (Horizon). Trusted relayer, testnet only. Keys never leave this module and are never logged.
//  - Deposits: ONE shared treasury address + a numeric memo per quote (1Click requires depositMode MEMO for Stellar).
//    A global cursor over the treasury's incoming payments attaches each payment to its swap by memo; there is no sweep.
//  - Payouts/refunds: sign-first and idempotent. The signed transaction (deterministic hash, 3 min time bounds) is persisted
//    before it is submitted; retries only look the hash up on Horizon and re-sign after the bounds provably expired.
import fs from 'node:fs';
import { Keypair, TransactionBuilder, Operation, Asset, Networks, Account, Memo } from '@stellar/stellar-base';
import { STELLAR_CHAIN, STELLAR_DECIMALS, XLM_CREATE_MIN_STROOPS, fromUnits, toUnits } from './config.mjs';
import { db, save } from './store.mjs';
import { exclusive } from './guard.mjs';

const PASSPHRASE = Networks.TESTNET;
const HORIZONS = [...new Set([process.env.STELLAR_HORIZON_URL, 'https://horizon-testnet.stellar.org'].map(u => u?.trim().replace(/\/$/, '')).filter(Boolean))];
const SECRETS = new URL('../../.secrets/', import.meta.url).pathname;
const TX_WINDOW_S = 180;

export class StellarError extends Error {
  constructor(message, { status, codes, transient = false } = {}) { super(message); this.name = 'StellarError'; this.status = status; this.codes = codes; this.transient = transient; }
}

// ---- Horizon ----
async function horizon(path, { method = 'GET', form, allow404 = false } = {}) {
  let last;
  for (const base of HORIZONS) {
    try {
      const r = await fetch(base + path, { method, signal: AbortSignal.timeout(15_000), headers: form ? { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' } : { accept: 'application/json' }, body: form ? new URLSearchParams(form).toString() : undefined });
      if (r.status === 404 && allow404) return null;
      const j = await r.json().catch(() => ({}));
      if (r.ok) return j;
      const codes = j?.extras?.result_codes;
      const transient = r.status === 429 || r.status >= 500 || codes?.transaction === 'tx_insufficient_fee' || codes?.transaction === 'tx_internal_error';
      last = new StellarError(`Horizon ${r.status} ${j?.title || ''}${codes ? ' ' + JSON.stringify(codes) : ''}`.trim(), { status: r.status, codes, transient });
      if (!transient) throw last;
    } catch (e) {
      if (e instanceof StellarError && !e.transient) throw e;
      last = e instanceof StellarError ? e : new StellarError(`Horizon request failed: ${e.message}`, { transient: true });
    }
  }
  throw last;
}

// ---- keys (env STELLAR_TREASURY_KEY, or the gitignored .secrets/stellar-treasury.key) ----
let kp;
export function relayer() {
  if (kp) return kp;
  let secret = process.env.STELLAR_TREASURY_KEY?.trim();
  if (!secret) { try { secret = fs.readFileSync(SECRETS + 'stellar-treasury.key', 'utf8').trim(); } catch { /* not configured */ } }
  if (!secret) return null;
  const k = Keypair.fromSecret(secret);
  kp = { kp: k, address: k.publicKey() };
  return kp;
}
export const relayerConfigured = () => Boolean(relayer() && STELLAR_CHAIN.treasury && relayer().address === STELLAR_CHAIN.treasury);
export const treasuryAddress = () => STELLAR_CHAIN.treasury;
export const txUrl = (h) => `${STELLAR_CHAIN.explorer}/tx/${h}`;
export const accountUrl = (a) => `${STELLAR_CHAIN.explorer}/account/${a}`;

// ---- assets / amounts ----
export const assetOf = (t) => (t.native ? Asset.native() : new Asset(t.code, t.issuer));
export const assetKey = (t) => (t.native ? 'native' : `${t.code}:${t.issuer}`);
export const amountStr = (units) => fromUnits(BigInt(units), STELLAR_DECIMALS).replace(/^(\d+)$/, '$1.0').replace(/\.(\d*)$/, (_, f) => '.' + f.padEnd(STELLAR_DECIMALS, '0'));
export const unitsOf = (s) => toUnits(String(s), STELLAR_DECIMALS);

export async function account(addr) { return horizon(`/accounts/${addr}`, { allow404: true }); }
export const hasTrustline = (acc, t) => acc.balances?.some(b => b.asset_code === t.code && b.asset_issuer === t.issuer);
export const balanceOf = (acc, t) => { const b = acc?.balances?.find(b => (t.native ? b.asset_type === 'native' : b.asset_code === t.code && b.asset_issuer === t.issuer)); return b ? unitsOf(b.balance) : 0n; };

/** Quote-time check of a payout/refund destination: the account must exist (and hold a trustline for issued assets). */
export async function checkDestination(addr, t, amount, field) {
  let acc;
  try { acc = await account(addr); } catch { return null; } // Horizon down: do not block the quote on a pre-check
  if (t.native) {
    if (!acc && amount < XLM_CREATE_MIN_STROOPS) return `${field} ${addr} does not exist on ${STELLAR_CHAIN.name} yet; an XLM payment to a new account must be at least ${fromUnits(XLM_CREATE_MIN_STROOPS, STELLAR_DECIMALS)} XLM (2 x base reserve). Fund it first (Friendbot: ${STELLAR_CHAIN.friendbot}/?addr=${addr}) or raise the amount.`;
    return null;
  }
  if (!acc) return `${field} ${addr} does not exist on ${STELLAR_CHAIN.name} yet. Create and fund it with Friendbot (${STELLAR_CHAIN.friendbot}/?addr=${addr}) and add a ${t.symbol} trustline (${t.code}:${t.issuer}) before swapping into ${t.symbol}.`;
  if (!hasTrustline(acc, t)) return `${field} ${addr} has no ${t.symbol} trustline. On Stellar a recipient must trust the asset first: add a changeTrust operation for ${t.code}:${t.issuer}, then retry.`;
  return null;
}

// ---- sign-first transaction driver ----
export async function prepare(addOps) {
  const r = relayer(); if (!r) throw new StellarError('Stellar treasury key is not configured');
  const acc = await horizon(`/accounts/${r.address}`);
  const maxTime = Math.floor(Date.now() / 1000) + TX_WINDOW_S;
  const b = new TransactionBuilder(new Account(r.address, acc.sequence), { fee: '2000', networkPassphrase: PASSPHRASE, timebounds: { minTime: 0, maxTime } });
  addOps(b);
  const tx = b.build(); tx.sign(r.kp);
  return { hash: tx.hash().toString('hex'), xdr: tx.toEnvelope().toXDR('base64'), maxTime };
}
export function payoutOps(t, to, amount, destExists) {
  return (b) => {
    if (t.native && !destExists) b.addOperation(Operation.createAccount({ destination: to, startingBalance: amountStr(amount) }));
    else b.addOperation(Operation.payment({ destination: to, asset: assetOf(t), amount: amountStr(amount) }));
  };
}
async function txStatus(rec) {
  const t = await horizon(`/transactions/${rec.hash}`, { allow404: true });
  if (t) return t.successful ? 'confirmed' : 'failed';
  const l = await horizon('/ledgers?order=desc&limit=1');
  return Date.parse(l._embedded.records[0].closed_at) / 1000 > rec.maxTime + 30 ? 'expired' : 'pending';
}
// One treasury account means one sequence number: only one signed-but-unresolved transaction at a time.
let lock = null, lockAt = 0;
const release = (rec) => { if (lock === rec) lock = null; };
/** Advances rec ({hash,xdr,maxTime,fails}) one step; returns 'confirmed' | 'pending'. Throws after repeated on-chain failures. */
export const drive = (rec, build, persist) => exclusive(rec, () => step(rec, build, persist)); // one step at a time per slot: see guard.mjs
async function step(rec, build, persist) {
  if (rec.hash) {
    const st = await txStatus(rec);
    if (st === 'confirmed') { release(rec); return 'confirmed'; }
    if (st === 'failed' || st === 'expired') {
      release(rec);
      rec.fails = (rec.fails || 0) + (st === 'failed' ? 1 : 0); // an expired tx never landed: free to re-sign
      delete rec.hash; delete rec.xdr; delete rec.maxTime; persist();
      if (rec.fails >= 5) throw new StellarError(`Stellar transaction failed on-chain ${rec.fails} times; needs operator attention`);
      return 'pending';
    }
    lockAt = Date.now();
    try { await horizon('/transactions', { method: 'POST', form: { tx: rec.xdr } }); } // same signed bytes: idempotent
    // tx_bad_seq is NOT proof the tx is dead: our own tx may already have consumed that sequence while Horizon has not ingested it yet.
    // Never re-sign on it (a re-sign would pay twice); the tx expires after its time window and only then is a fresh one signed.
    catch (e) { if (!e.transient && !e.codes) throw e; }
    return 'pending';
  }
  if (lock && lock !== rec && Date.now() - lockAt < 300_000) return 'pending'; // another transaction owns the sequence number
  lock = rec; lockAt = Date.now();
  try {
    Object.assign(rec, await build()); persist(); // persist the signed tx BEFORE sending
  } catch (e) { release(rec); throw e; }
  try { await horizon('/transactions', { method: 'POST', form: { tx: rec.xdr } }); }
  catch (e) { if (!(e.transient || e.codes)) console.error('stellar submit:', e.message); } // result is resolved by hash on the next call
  return 'pending';
}
/** Drives to completion inline (used by the faucet); returns the tx hash. */
export async function sendAndConfirm(build, timeoutMs = 60_000) {
  const rec = {}; const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (await drive(rec, build, () => {}) === 'confirmed') return rec.hash;
    await new Promise(r => setTimeout(r, 2500));
  }
  throw new StellarError('Stellar transaction not confirmed in time');
}

// ---- deposits: one cursor over the treasury's incoming payments, matched to swaps by memo ----
let ingesting = null, ingestAt = 0;
const INBOUND = new Set(['payment', 'path_payment_strict_send', 'path_payment_strict_receive']);
export async function startCursor() {
  db.stellar ||= {};
  if (db.stellar.cursor || !STELLAR_CHAIN.treasury) return;
  const r = await horizon(`/accounts/${STELLAR_CHAIN.treasury}/payments?order=desc&limit=1`);
  db.stellar.cursor = r._embedded.records[0]?.paging_token || 'now'; save();
}
/** onDeposit(memo, {id,hash,amount,asset}) is called synchronously per incoming payment; the cursor then advances. */
export function ingest(onDeposit) {
  if (ingesting) return ingesting;
  if (Date.now() - ingestAt < 2500) return Promise.resolve();
  ingesting = (async () => {
    await startCursor();
    const to = STELLAR_CHAIN.treasury;
    for (let page = 0; page < 5; page++) {
      const r = await horizon(`/accounts/${to}/payments?order=asc&limit=200&join=transactions&cursor=${encodeURIComponent(db.stellar.cursor)}`);
      const recs = r._embedded.records; if (!recs.length) break;
      for (const p of recs) {
        if (INBOUND.has(p.type) && p.to === to && p.from !== to && p.transaction_successful !== false) {
          const memo = p.transaction?.memo;
          if (memo && ['text', 'id'].includes(p.transaction?.memo_type)) onDeposit(String(memo), { id: p.id, hash: p.transaction_hash, from: p.from, amount: unitsOf(p.amount).toString(), asset: p.asset_type === 'native' ? 'native' : `${p.asset_code}:${p.asset_issuer}` });
        }
        db.stellar.cursor = p.paging_token;
      }
      save();
      if (recs.length < 200) break;
    }
  })().finally(() => { ingesting = null; ingestAt = Date.now(); });
  return ingesting;
}

// ---- faucet / treasury top-up ----
export async function friendbot(addr) {
  const r = await fetch(`${STELLAR_CHAIN.friendbot}/?addr=${addr}`, { signal: AbortSignal.timeout(60_000) });
  if (!r.ok) throw new StellarError(`friendbot ${r.status}`);
}
/** Fund the treasury with another 10,000 XLM: Friendbot an ephemeral account, then merge it into the treasury. */
export async function topUpTreasury() {
  const eph = Keypair.random();
  await friendbot(eph.publicKey());
  const acc = await horizon(`/accounts/${eph.publicKey()}`);
  const b = new TransactionBuilder(new Account(eph.publicKey(), acc.sequence), { fee: '1000', networkPassphrase: PASSPHRASE, timebounds: { minTime: 0, maxTime: Math.floor(Date.now() / 1000) + 120 } });
  b.addOperation(Operation.accountMerge({ destination: STELLAR_CHAIN.treasury }));
  const tx = b.build(); tx.sign(eph);
  await horizon('/transactions', { method: 'POST', form: { tx: tx.toEnvelope().toXDR('base64') } });
  return tx.hash().toString('hex');
}
const LOW_XLM = 1500_0000000n, MIN_PAYOUT_XLM = 25_0000000n;
let topping = false, lastTop = 0;
export async function maybeTopUp() {
  if (topping || Date.now() - lastTop < 600_000 || !relayerConfigured()) return;
  topping = true;
  try {
    const bal = balanceOf(await account(STELLAR_CHAIN.treasury), { native: true });
    if (bal < LOW_XLM) { lastTop = Date.now(); const h = await topUpTreasury(); console.log('stellar treasury topped up from Friendbot:', h); }
  } catch (e) { lastTop = Date.now(); console.error('stellar top-up failed:', e.message); } finally { topping = false; }
}
export function startTreasuryWatch() {
  if (!STELLAR_CHAIN.deployed || !relayerConfigured()) return;
  startCursor().catch(e => console.error('stellar cursor:', e.message));
  setTimeout(maybeTopUp, 20_000); setInterval(maybeTopUp, 10 * 60_000);
}
export async function treasuryLow() {
  try { return balanceOf(await account(STELLAR_CHAIN.treasury), { native: true }) < MIN_PAYOUT_XLM; } catch { return false; }
}

/** Faucet: drips issued test assets (USDC/USDT) to an existing account that already trusts them. */
export async function faucetPay(to, list) {
  return sendAndConfirm(async () => prepare((b) => { for (const t of list) b.addOperation(Operation.payment({ destination: to, asset: assetOf(t), amount: amountStr(t.dripUnits) })); }));
}

export async function stellarHealth() {
  const r = relayer();
  const out = { ok: false, name: STELLAR_CHAIN.name, network: 'testnet', treasury: STELLAR_CHAIN.treasury, issuer: STELLAR_CHAIN.issuer, configured: relayerConfigured(), assets: STELLAR_CHAIN.tokens?.map(t => t.assetId) };
  try {
    const [acc, led] = await Promise.all([account(STELLAR_CHAIN.treasury), horizon('/ledgers?order=desc&limit=1')]);
    out.latestLedger = led._embedded.records[0].sequence;
    out.treasuryBalances = Object.fromEntries((STELLAR_CHAIN.tokens || []).map(t => [t.symbol, fromUnits(balanceOf(acc, t), STELLAR_DECIMALS)]));
    out.ok = Boolean(r) && balanceOf(acc, { native: true }) >= MIN_PAYOUT_XLM;
  } catch (e) { out.error = String(e.message).slice(0, 200); }
  return out;
}
export { horizon };
