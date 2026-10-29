// XRP Ledger testnet bridge (rippled JSON-RPC). Trusted relayer, testnet only. Keys never leave this module and are never logged.
//  - Deposits: ONE shared treasury address + a numeric destination tag per quote (1Click requires depositMode MEMO for XRP).
//    A global cursor over the treasury's validated incoming Payments attaches each payment to its swap by tag; there is no sweep.
//  - Payouts/refunds: sign-first and idempotent. The signed Payment (deterministic hash, LastLedgerSequence) is persisted
//    before it is submitted; retries only look the hash up and re-sign after the LastLedgerSequence provably passed.
import fs from 'node:fs';
import { Wallet } from 'xrpl';
import { XRP_CHAIN, XRP_DECIMALS, XRP_RESERVE_DROPS, parseXrpAddress, fromUnits } from './config.mjs';
import { db, save } from './store.mjs';

const RPCS = [...new Set([process.env.XRP_RPC_URL, 'https://testnet.xrpl-labs.com', 'https://s.altnet.rippletest.net:51234'].map(u => u?.trim()).filter(Boolean))];
const SECRETS = new URL('../../.secrets/', import.meta.url).pathname;
const LLS_WINDOW = 40; // ledgers (~3.5 s each, about 2.5 minutes)
const TF_PARTIAL = 0x00020000;
const LSF_REQUIRE_DEST_TAG = 0x00020000, LSF_DEPOSIT_AUTH = 0x01000000;

export class XrpError extends Error {
  constructor(message, { code, transient = false } = {}) { super(message); this.name = 'XrpError'; this.code = code; this.transient = transient; }
}

// ---- rippled JSON-RPC ----
const TRANSIENT_CODES = new Set(['slowDown', 'tooBusy', 'noNetwork', 'noCurrent', 'noClosed', 'internal', 'failedToForward']);
export async function rpc(method, params = {}, { allow = [] } = {}) {
  let last;
  for (const url of RPCS) {
    try {
      const r = await fetch(url, { method: 'POST', signal: AbortSignal.timeout(15_000), headers: { 'content-type': 'application/json' }, body: JSON.stringify({ method, params: [{ api_version: 1, ...params }] }) });
      const j = await r.json().catch(() => null);
      if (!r.ok || !j?.result) { last = new XrpError(`XRPL RPC ${r.status}`, { transient: true }); continue; }
      const res = j.result;
      if (res.status === 'error') {
        if (allow.includes(res.error)) return { error: res.error };
        const e = new XrpError(`XRPL ${method}: ${res.error}${res.error_message ? ' ' + res.error_message : ''}`, { code: res.error, transient: TRANSIENT_CODES.has(res.error) });
        if (!e.transient) throw e;
        last = e; continue;
      }
      return res;
    } catch (e) {
      if (e instanceof XrpError && !e.transient) throw e;
      last = e instanceof XrpError ? e : new XrpError(`XRPL RPC failed: ${e.message}`, { transient: true });
    }
  }
  throw last;
}

// ---- keys (env XRP_TREASURY_KEY = family seed, or the gitignored .secrets/xrp-treasury.key) ----
let wallet;
export function relayer() {
  if (wallet) return wallet;
  let seed = process.env.XRP_TREASURY_KEY?.trim();
  if (!seed) { try { seed = fs.readFileSync(SECRETS + 'xrp-treasury.key', 'utf8').trim(); } catch { /* not configured */ } }
  if (!seed) return null;
  const w = Wallet.fromSeed(seed);
  wallet = { w, address: w.classicAddress };
  return wallet;
}
export const relayerConfigured = () => Boolean(relayer() && XRP_CHAIN.treasury && relayer().address === XRP_CHAIN.treasury);
export const treasuryAddress = () => XRP_CHAIN.treasury;
export const txUrl = (h) => `${XRP_CHAIN.explorer}/transactions/${h}`;
export const accountUrl = (a) => `${XRP_CHAIN.explorer}/accounts/${a}`;

// ---- amounts (drops: 1 XRP = 1,000,000 drops) ----
export const dropsStr = (units) => BigInt(units).toString();
export const unitsOf = (s) => BigInt(s);
/** A destination tag is an unsigned 32-bit integer (1Click shows it as the deposit memo). 0 is avoided. */
export const newTag = () => { const b = new Uint32Array(1); crypto.getRandomValues(b); return String(b[0] === 0 ? 1 : b[0]); };

export async function account(addr, ledger = 'current') {
  const r = await rpc('account_info', { account: addr, ledger_index: ledger }, { allow: ['actNotFound'] });
  return r.error ? null : r.account_data;
}
export const balanceOf = (acc) => (acc ? BigInt(acc.Balance) : 0n);
async function ownerReserve(acc) { // base reserve + increment per owned object, from the validated ledger
  try {
    const s = (await rpc('server_info')).info.validated_ledger;
    return BigInt(Math.round((s.reserve_base_xrp + s.reserve_inc_xrp * (acc?.OwnerCount || 0)) * 1e6));
  } catch { return XRP_RESERVE_DROPS; }
}

/** Quote-time check of a payout/refund destination (a classic or testnet X-address). */
export async function checkDestination(to, amount, field) {
  const p = parseXrpAddress(to);
  if (!p) return `${field} is not a valid XRP Ledger testnet address.`;
  let acc;
  try { acc = await account(p.address); } catch { return null; } // RPC down: do not block the quote on a pre-check
  if (!acc) {
    if (amount < XRP_RESERVE_DROPS) return `${field} ${p.address} does not exist on ${XRP_CHAIN.name} yet; a payment to a new account must be at least ${fromUnits(XRP_RESERVE_DROPS, XRP_DECIMALS)} XRP (the base reserve). Fund it first (${XRP_CHAIN.faucet}) or raise the amount.`;
    return null;
  }
  if ((acc.Flags & LSF_DEPOSIT_AUTH) && p.address !== XRP_CHAIN.treasury) return `${field} ${p.address} has Deposit Authorization enabled, so it rejects payments from accounts it has not preauthorized. Use another XRP Ledger account.`;
  if ((acc.Flags & LSF_REQUIRE_DEST_TAG) && p.tag === undefined) return `${field} ${p.address} requires a destination tag. Pass it as a testnet X-address (T...) that encodes the tag, or use an account without that requirement.`;
  return null;
}

// ---- sign-first transaction driver ----
export async function prepare(to, amount, from = relayer()) {
  if (!from) throw new XrpError('XRP treasury key is not configured');
  const p = parseXrpAddress(to); if (!p) throw new XrpError('invalid XRP destination');
  const [acc, fee] = await Promise.all([account(from.address), rpc('fee')]);
  if (!acc) throw new XrpError(`${from.address} is not funded`);
  const lastLedger = fee.ledger_current_index + LLS_WINDOW;
  const open = Number(fee.drops?.open_ledger_fee || 10);
  const tx = { TransactionType: 'Payment', Account: from.address, Destination: p.address, Amount: dropsStr(amount), Fee: String(Math.min(5000, Math.max(12, open * 2))), Sequence: acc.Sequence, LastLedgerSequence: lastLedger };
  if (p.tag !== undefined) tx.DestinationTag = p.tag;
  const signed = from.w.sign(tx);
  return { hash: signed.hash, blob: signed.tx_blob, lastLedger, seq: acc.Sequence };
}
async function validatedSeq() { return (await rpc('server_info')).info.validated_ledger.seq; }
async function txStatus(rec) {
  const seq = await validatedSeq(); // read BEFORE the lookup: a tx still absent after the window closed can never land
  const t = await rpc('tx', { transaction: rec.hash }, { allow: ['txnNotFound'] });
  if (!t.error && t.validated) return t.meta?.TransactionResult === 'tesSUCCESS' ? 'confirmed' : 'failed';
  return seq > rec.lastLedger && (t.error || !t.validated) ? 'expired' : 'pending';
}
// One treasury account means one sequence number: only one signed-but-unresolved transaction at a time.
const busy = new Set();
let lock = null, lockAt = 0;
const release = (rec) => { if (lock === rec) lock = null; };
const clear = (rec) => { delete rec.hash; delete rec.blob; delete rec.lastLedger; delete rec.seq; };
async function submit(rec) { return rpc('submit', { tx_blob: rec.blob }, { allow: ['invalidTransaction'] }); }
/** Hash of the validated treasury transaction that used rec.seq, null when that sequence number is still unused or used by nobody we can see, undefined when unknown. */
async function consumedBy(rec) {
  const addr = relayer().address;
  const acc = await account(addr, 'validated');
  if (!acc) return undefined;
  if (acc.Sequence <= rec.seq) return null; // the sequence number is still free: our tx never landed
  const r = await rpc('account_tx', { account: addr, ledger_index_min: -1, ledger_index_max: -1, limit: 50, forward: false });
  for (const t of r.transactions || []) {
    const tx = t.tx || t.tx_json || {};
    if (t.validated !== false && tx.Account === addr && tx.Sequence === rec.seq) return t.hash || tx.hash;
  }
  return undefined; // consumed but not among the recent transactions: do not guess
}
/** Advances rec ({hash,blob,lastLedger,fails}) one step; returns 'confirmed' | 'pending'. Throws after repeated on-chain failures. */
export async function drive(rec, build, persist) {
  if (busy.has(rec)) return 'pending'; // one step at a time per payout: concurrent steps could sign two different transactions
  busy.add(rec);
  try { return await step(rec, build, persist); } finally { busy.delete(rec); }
}
async function step(rec, build, persist) {
  if (rec.hash) {
    const st = await txStatus(rec);
    if (st === 'confirmed') { release(rec); return 'confirmed'; }
    if (st === 'expired' && rec.seq !== undefined) {
      // The signed Payment looks absent, but its sequence number may have been consumed by a variant of it (a concurrent signing with a
      // different LastLedgerSequence): never pay twice. If the treasury's validated Sequence moved past ours, look for the tx that used it.
      const found = await consumedBy(rec).catch(() => undefined);
      if (found === undefined) return 'pending'; // cannot tell right now: stay safe and retry
      if (found) { rec.hash = found; persist(); return step(rec, build, persist); }
    }
    if (st === 'failed' || st === 'expired') {
      release(rec);
      rec.fails = (rec.fails || 0) + (st === 'failed' ? 1 : 0); // an expired tx never landed: free to re-sign
      clear(rec); persist();
      if (rec.fails >= 5) throw new XrpError(`XRP Ledger transaction failed on-chain ${rec.fails} times; needs operator attention`);
      return 'pending';
    }
    lockAt = Date.now();
    try {
      const r = await submit(rec); // same signed bytes: idempotent
      // tefPAST_SEQ means the sequence number was used: possibly by this very payment (or a variant of it). Never re-sign on that signal;
      // adopt the validated tx that used the sequence, and leave anything unclear to the LastLedgerSequence expiry check above.
      if (r.engine_result === 'tefPAST_SEQ') { const found = await consumedBy(rec).catch(() => undefined); if (found) { rec.hash = found; persist(); } }
    } catch (e) { if (!e.transient) console.error('xrp resubmit:', e.message); }
    return 'pending';
  }
  if (lock && lock !== rec && Date.now() - lockAt < 300_000) return 'pending'; // another transaction owns the sequence number
  lock = rec; lockAt = Date.now();
  try {
    Object.assign(rec, await build()); persist(); // persist the signed tx BEFORE sending
  } catch (e) { release(rec); throw e; }
  try { await submit(rec); }
  catch (e) { if (!e.transient) console.error('xrp submit:', e.message); } // result is resolved by hash on the next call
  return 'pending';
}

// ---- deposits: one cursor over the treasury's incoming Payments, matched to swaps by destination tag ----
let ingesting = null, ingestAt = 0;
export async function startCursor() {
  db.xrp ||= {};
  if (db.xrp.cursor || !XRP_CHAIN.treasury) return;
  db.xrp.cursor = await validatedSeq(); save();
}
/** onDeposit(tag, {id,hash,from,amount,asset}) is called synchronously per incoming payment; the cursor then advances. */
export function ingest(onDeposit) {
  if (ingesting) return ingesting;
  if (Date.now() - ingestAt < 2500) return Promise.resolve();
  ingesting = (async () => {
    await startCursor();
    const to = XRP_CHAIN.treasury;
    const upto = await validatedSeq();
    if (upto < db.xrp.cursor) return;
    let marker;
    for (let page = 0; page < 10; page++) {
      const r = await rpc('account_tx', { account: to, ledger_index_min: db.xrp.cursor, ledger_index_max: upto, forward: true, limit: 200, ...(marker ? { marker } : {}) });
      for (const it of r.transactions || []) {
        const tx = it.tx, meta = it.meta;
        if (!it.validated || tx?.TransactionType !== 'Payment' || tx.Destination !== to || tx.Account === to || meta?.TransactionResult !== 'tesSUCCESS' || tx.DestinationTag === undefined) continue;
        let amt = meta.delivered_amount ?? meta.DeliveredAmount;
        if (typeof amt !== 'string') amt = typeof tx.Amount === 'string' && !(Number(tx.Flags || 0) & TF_PARTIAL) ? tx.Amount : null;
        if (amt === null) continue; // issued currencies are not supported
        onDeposit(String(tx.DestinationTag), { id: tx.hash, hash: tx.hash, from: tx.Account, amount: amt, asset: 'XRP' });
      }
      marker = r.marker;
      if (!marker) break;
    }
    if (!marker) { db.xrp.cursor = upto; save(); } // a partially read window is simply re-read next time (deposits are deduplicated by hash)
  })().finally(() => { ingesting = null; ingestAt = Date.now(); });
  return ingesting;
}

// ---- faucet / treasury top-up ----
/** Official XRPL Testnet faucet (no captcha): funds `addr` with 100 test XRP. */
export async function faucet(addr) {
  const r = await fetch(XRP_CHAIN.faucet, { method: 'POST', signal: AbortSignal.timeout(60_000), headers: { 'content-type': 'application/json' }, body: JSON.stringify({ destination: addr, userAgent: 'tidepool' }) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new XrpError(`XRPL faucet ${r.status} ${j?.error || ''}`.trim());
  return j;
}
async function waitFunded(addr, ms = 60_000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { const a = await account(addr, 'validated').catch(() => null); if (a) return a; await new Promise(r => setTimeout(r, 2500)); }
  throw new XrpError('faucet account was not funded in time');
}
/** Fund the treasury with another ~99 XRP: faucet an ephemeral account, then pay almost all of it to the treasury. */
export async function topUpTreasury() {
  const w = Wallet.generate(), eph = { w, address: w.classicAddress };
  await faucet(eph.address);
  const acc = await waitFunded(eph.address);
  const rec = {};
  const end = Date.now() + 90_000;
  const amount = balanceOf(acc) - 1_100_000n; // keep the base reserve plus fee headroom on the throwaway account
  Object.assign(rec, await prepare(XRP_CHAIN.treasury, amount, eph));
  await submit(rec);
  while (Date.now() < end) { const st = await txStatus(rec); if (st === 'confirmed') return rec.hash; if (st !== 'pending') break; await new Promise(r => setTimeout(r, 2500)); }
  throw new XrpError('top-up payment was not confirmed in time');
}
const LOW_DROPS = 150_000_000n, MIN_PAYOUT_DROPS = 20_000_000n;
let topping = false, lastTop = 0;
export async function maybeTopUp() {
  if (topping || Date.now() - lastTop < 600_000 || !relayerConfigured()) return;
  topping = true;
  try {
    const bal = balanceOf(await account(XRP_CHAIN.treasury));
    if (bal < LOW_DROPS) { lastTop = Date.now(); const h = await topUpTreasury(); console.log('xrp treasury topped up from the official faucet:', h); }
  } catch (e) { lastTop = Date.now(); console.error('xrp top-up failed:', e.message); } finally { topping = false; }
}
export function startTreasuryWatch() {
  if (!XRP_CHAIN.deployed || !relayerConfigured()) return;
  startCursor().catch(e => console.error('xrp cursor:', e.message));
  setTimeout(maybeTopUp, 25_000); setInterval(maybeTopUp, 10 * 60_000);
}
/** Spendable XRP in the treasury (balance minus its reserve), or null when the RPC is unreachable. */
export async function spendable() {
  try { const acc = await account(XRP_CHAIN.treasury); const bal = balanceOf(acc); const res = await ownerReserve(acc); return bal > res ? bal - res : 0n; } catch { return null; }
}
export async function treasuryLow() { const s = await spendable(); return s !== null && s < MIN_PAYOUT_DROPS; }

export async function xrpHealth() {
  const r = relayer();
  const out = { ok: false, name: XRP_CHAIN.name, network: 'testnet', treasury: XRP_CHAIN.treasury, configured: relayerConfigured(), assets: XRP_CHAIN.tokens?.map(t => t.assetId) };
  try {
    const [acc, info] = await Promise.all([account(XRP_CHAIN.treasury), rpc('server_info')]);
    out.latestLedger = info.info.validated_ledger.seq;
    out.treasuryBalances = { XRP: fromUnits(balanceOf(acc), XRP_DECIMALS) };
    out.ok = Boolean(r) && balanceOf(acc) >= MIN_PAYOUT_DROPS;
  } catch (e) { out.error = String(e.message).slice(0, 200); }
  return out;
}
