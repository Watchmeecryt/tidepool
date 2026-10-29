// Shared engine for the UTXO bridges (Bitcoin testnet4 and Zcash testnet): a trusted relayer, testnet only.
//  - deposit address = per-quote key HMAC-SHA256(master, "tidepool-<chain>-deposit:<id>"), no memo (like 1Click's plain deposit addresses).
//  - sweep: ONE transaction signed with the deposit key moves every confirmed, not-yet-swept output into the treasury. The treasury
//    absorbs the network fee (the credited amount is exactly what the user deposited).
//  - payouts/refunds: the treasury signs. Coin selection runs under one lock, and unconfirmed change of our own earlier transactions
//    is tracked locally (db.utxoPending) so back-to-back payouts never reuse an input.
//  - sign-first and idempotent (like sui.drive): the signed raw transaction + txid are persisted BEFORE broadcast; retries look the
//    txid up and re-broadcast the very same bytes. A fresh signature is only made when the old one was rejected, and it then re-spends
//    one of the same inputs (`must`) so the old and the new transaction can never both confirm.
// Keys, RPC URLs and secrets never leave these modules and are never logged.
import { db, save } from './store.mjs';
import { exclusive } from './guard.mjs';

export class UtxoError extends Error {
  constructor(message, { transient = false, fatal = false } = {}) { super(message); this.name = 'UtxoError'; this.transient = transient; this.fatal = fatal; }
}
export const scrub = (m) => String(m || '').replace(/https?:\/\/\S+/g, '').replace(/\s+/g, ' ').slice(0, 220);
const key = (u) => `${u.txid}:${u.vout}`;
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const PENDING_KEEP_MS = 15 * 60_000; // keep tracking a mined tx's spends/change this long (node indexes lag a little)
const REBUILD_AFTER_MS = 20 * 60_000; // a rejected-but-unseen tx is only replaced after this long

/**
 * A = chain adapter:
 *  name, minConf, dust (sats), treasury() -> {address, priv, pub, spk}, depositKey(master,id) -> {address, priv, pub, spk},
 *  utxos(address) -> [{txid, vout, value: bigint, conf}], txStatus(txid) -> 'confirmed'|'mempool'|'unknown',
 *  broadcast(hex) (throws UtxoError; "already known" must return normally), fee(nIn, nOut) -> bigint,
 *  sign({inputs:[{txid,vout,value,key:{priv,pub,spk}}], outputs:[{spk, value}]}) -> {txid, hex}, spkOf(address) -> Buffer
 */
export function makeBridge(A) {
  const pend = () => ((db.utxoPending ||= {})[A.name] ||= []);
  let lockChain = Promise.resolve();
  const withLock = (fn) => { const run = lockChain.then(fn, fn); lockChain = run.catch(() => {}); return run; };

  async function prunePending() {
    const now = Date.now();
    const list = pend();
    for (const p of [...list]) {
      if (now - p.at < PENDING_KEEP_MS) continue;
      const st = await A.txStatus(p.txid).catch(() => 'error');
      if (st === 'error' || st === 'mempool') continue; // still unconfirmed: keep tracking (its own change stays spendable)
      list.splice(list.indexOf(p), 1); // mined (the node's own view is authoritative now) or dropped
    }
  }
  /** Treasury outputs we may spend: chain view, minus outputs our pending txs already spend, plus their unconfirmed change. */
  async function treasuryUtxos() {
    await prunePending().catch(() => {});
    const t = A.treasury();
    const listed = await A.utxos(t.address);
    const spent = new Set(pend().flatMap(p => p.spends));
    const ours = new Set(pend().map(p => p.txid)); // unconfirmed outputs of our own sweeps/payouts (change) are safe to spend even once the node lists them
    const out = listed.filter(u => (u.conf >= A.minConf || ours.has(u.txid)) && !spent.has(key(u)));
    const have = new Set(listed.map(key));
    for (const p of pend()) for (const o of p.outs) if (!have.has(`${p.txid}:${o.vout}`) && !spent.has(`${p.txid}:${o.vout}`)) out.push({ txid: p.txid, vout: o.vout, value: BigInt(o.value), conf: 0, own: true });
    return out.sort((a, b) => (a.value < b.value ? 1 : a.value > b.value ? -1 : 0));
  }
  const treasuryBalance = async () => (await treasuryUtxos()).reduce((a, u) => a + u.value, 0n);

  /** Deposit-address outputs that are confirmed and not already swept by an earlier sweep of this quote. */
  async function depositUtxos(addr, s, except) { // `except`: the in-flight sweep record, whose own inputs may be re-spent by a rebuilt sweep
    const swept = new Set((s.bridgeIn || []).filter(b => b !== except).flatMap(b => b.inputs || []));
    const all = (await A.utxos(addr)).filter(u => !swept.has(key(u)));
    return { ready: all.filter(u => u.conf >= A.minConf), unconfirmed: all.filter(u => u.conf < A.minConf) };
  }

  function prepareSweep(dep, utxos) {
    if (!utxos.length) throw new UtxoError('deposit address has no confirmed outputs yet', { transient: true });
    const total = utxos.reduce((a, u) => a + u.value, 0n);
    const t = A.treasury();
    const fee = A.fee(utxos.length, 1);
    if (total <= fee + A.dust) throw new UtxoError(`deposit of ${total} base units is below the network fee + dust (${fee + A.dust}); it cannot be swept`, { fatal: true });
    const signed = A.sign({ inputs: utxos.map(u => ({ txid: u.txid, vout: u.vout, value: u.value, key: dep })), outputs: [{ spk: t.spk, value: total - fee }] });
    return { ...signed, amount: total, inputs: utxos.map(key), spends: utxos.map(key), outs: [{ vout: 0, value: (total - fee).toString() }] };
  }
  async function preparePayout(to, amount, { must = [] } = {}) {
    amount = BigInt(amount);
    const t = A.treasury();
    const spk = A.spkOf(to);
    if (amount < A.dust) throw new UtxoError(`payout of ${amount} is below the dust limit (${A.dust})`, { fatal: true });
    const all = await treasuryUtxos();
    const first = all.filter(u => must.includes(key(u))).slice(0, 1);
    const order = [...first, ...all.filter(u => !first.includes(u))];
    const picked = [];
    let sum = 0n, fee = 0n;
    for (const u of order) {
      if (picked.length >= 60) break;
      picked.push(u); sum += u.value; fee = A.fee(picked.length, 2);
      if (sum >= amount + fee) break;
    }
    if (sum < amount + fee) throw new UtxoError('the treasury has too little confirmed balance for this payout right now', { transient: true });
    let change = sum - amount - fee;
    const outputs = [{ spk, value: amount }];
    if (change >= A.dust) outputs.push({ spk: t.spk, value: change });
    else { change = 0n; fee = sum - amount; }
    const signed = A.sign({ inputs: picked.map(u => ({ txid: u.txid, vout: u.vout, value: u.value, key: t })), outputs });
    return { ...signed, amount, spends: picked.map(key), outs: change > 0n ? [{ vout: 1, value: change.toString() }] : [] };
  }

  async function seen(txid) { // let the node index the tx before the next signing
    for (let i = 0; i < 10; i++) { if ((await A.txStatus(txid).catch(() => 'error')) !== 'unknown') return; await sleep(700); }
  }
  const clear = (rec) => { const p = pend(); const i = p.findIndex(x => x.txid === rec.txid); if (i >= 0) p.splice(i, 1); delete rec.txid; delete rec.hex; delete rec.spends; delete rec.at; };
  /**
   * Idempotent driver for one transaction slot `rec` (a plain object persisted in the swap record): {txid, hex, spends, at, fails}.
   * `build({must})` returns the signed tx {txid, hex, spends, outs, ...}. Returns 'confirmed' (accepted by the network) or 'pending'.
   */
  const drive = (rec, build, persist) => exclusive(rec, () => step(rec, build, persist)); // one step at a time per slot: see guard.mjs
  async function step(rec, build, persist) {
    let must = [];
    if (rec.txid) {
      const st = await A.txStatus(rec.txid).catch(() => 'error');
      if (st === 'mempool' || st === 'confirmed') return 'confirmed';
      if (st === 'error') return 'pending';
      try { await A.broadcast(rec.hex); await seen(rec.txid); return 'confirmed'; } catch (e) {
        if (!(e instanceof UtxoError) || e.transient) return 'pending';
        if (await A.txStatus(rec.txid).catch(() => 'error') !== 'unknown') return 'confirmed';
        if (Date.now() - rec.at < REBUILD_AFTER_MS) return 'pending'; // rejected; maybe the node has not seen a parent yet: keep retrying the same bytes
        must = rec.spends || []; clear(rec); persist(); // old bytes: rejected for 20 min, so they are dead; re-spend one of the same inputs
      }
    }
    return withLock(async () => {
      const p = await build({ must });
      rec.txid = p.txid; rec.hex = p.hex; rec.spends = p.spends; rec.at = Date.now();
      pend().push({ txid: p.txid, at: rec.at, spends: p.spends, outs: p.outs || [] });
      persist(); // record BEFORE broadcasting
      try { await A.broadcast(p.hex); } catch (e) {
        if (e instanceof UtxoError && !e.transient) {
          rec.fails = (rec.fails || 0) + 1; clear(rec); persist();
          if (rec.fails >= 5) throw new Error(`${A.name} transaction was rejected 5 times (${scrub(e.message)}); needs operator attention`);
        }
        throw e; // transient: the record stays and the next tick re-broadcasts the same bytes
      }
      await seen(p.txid);
      return 'confirmed';
    });
  }
  /** Send and wait (scripts and tests). */
  async function sendAndConfirm(build, { timeoutMs = 60_000 } = {}) {
    const rec = {}, until = Date.now() + timeoutMs;
    while (Date.now() < until) {
      if (await drive(rec, build, () => save()) === 'confirmed') return rec.txid;
      await sleep(1500);
    }
    throw new Error(`${A.name} transaction not accepted in time`);
  }
  return { A, withLock, treasuryUtxos, treasuryBalance, depositUtxos, prepareSweep, preparePayout, drive, sendAndConfirm };
}
