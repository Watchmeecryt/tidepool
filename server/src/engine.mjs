// Quote engine, maker and settlement worker. The maker fills from its own inventory inside the
// verifier: each swap is one execute_intents batch with two NEP-413 signed payloads
// (deposit address + maker) whose token_diff intents balance exactly.
import crypto from 'node:crypto';
import { KeyPair } from 'near-api-js';
import bs58 from 'bs58';
import { call, view, viewAccount, sendNear, signIntents, deriveDepositKey, keyStore, NETWORK, TGAS, parseNear, txUrl } from './near.mjs';
import { ROOT, VERIFIER, MAKER, TOKENS, fromUnits } from './config.mjs';
import { prices } from './prices.mjs';
import { db, save } from './store.mjs';

const MASTER = process.env.DEPOSIT_MASTER_SEED;
const byAsset = Object.fromEntries(TOKENS.map(t => [t.assetId, t]));
const STABLE = new Set(['USDC', 'USDT']);
export class BadRequest extends Error { constructor(m, code = 400) { super(m); this.code = code; } }

// serialize transactions per signer so nonces never collide
const locks = {};
export function withSigner(id, fn) { const p = (locks[id] || Promise.resolve()).then(fn, fn); locks[id] = p.catch(() => {}); return p; }

const ACCOUNT_RE = /^(([a-z\d]+[-_])*[a-z\d]+\.)*([a-z\d]+[-_])*[a-z\d]+$/;
const isAccount = (s) => typeof s === 'string' && s.length >= 2 && s.length <= 64 && ACCOUNT_RE.test(s);

export function feeBps(inT, outT, authed) {
  if (inT.symbol === outT.symbol || (STABLE.has(inT.symbol) && STABLE.has(outT.symbol))) return authed ? 1 : 26; // 1 bp (+25 without key)
  return authed ? 20 : 45; // 20 bps (+25 without key)
}

function usd(units, t, p) { return (Number(fromUnits(units, t.decimals)) * p).toFixed(4); }
const ratio = (pIn, pOut) => BigInt(Math.round((pIn / pOut) * 1e18));
function convert(amountIn, inT, outT, px, fee) { // exact input -> output
  return amountIn * ratio(px[inT.assetId], px[outT.assetId]) * 10n ** BigInt(outT.decimals) * BigInt(10000 - fee) / (10n ** BigInt(inT.decimals) * 10n ** 18n * 10000n);
}
function invert(amountOut, inT, outT, px, fee) { // exact output -> required input (rounded up)
  const num = amountOut * 10n ** BigInt(inT.decimals) * 10n ** 18n * 10000n;
  const den = ratio(px[inT.assetId], px[outT.assetId]) * 10n ** BigInt(outT.decimals) * BigInt(10000 - fee);
  return (num + den - 1n) / den;
}
export const makerBalance = async (assetId) => BigInt(await view(VERIFIER, 'mt_balance_of', { account_id: MAKER, token_id: assetId }));

export async function tokens() {
  const p = await prices();
  const at = new Date(p.at).toISOString();
  return TOKENS.map(t => ({ assetId: t.assetId, decimals: t.decimals, blockchain: 'near', symbol: t.symbol, price: p.prices[t.assetId], priceUpdatedAt: at, contractAddress: t.contractAddress, coingeckoId: t.coingeckoId }));
}

function signQuote(obj) {
  const kp = makerKey();
  const sig = kp ? kp.sign(crypto.createHash('sha256').update(JSON.stringify(obj)).digest()).signature : crypto.randomBytes(64);
  return 'ed25519:' + bs58.encode(Buffer.from(sig));
}
let _mk; function makerKey() { return _mk; }
export async function initEngine() { _mk = await keyStore.getKey(NETWORK, MAKER); if (!MASTER) console.warn('DEPOSIT_MASTER_SEED missing: non-dry quotes disabled'); }

export async function quote(req, { authed }) {
  const need = ['dry', 'swapType', 'slippageTolerance', 'originAsset', 'depositType', 'destinationAsset', 'amount', 'refundTo', 'refundType', 'recipient', 'recipientType', 'deadline'];
  for (const k of need) if (req[k] === undefined || req[k] === null || req[k] === '') throw new BadRequest(`${k} is required`);
  const inT = byAsset[req.originAsset], outT = byAsset[req.destinationAsset];
  if (!inT) throw new BadRequest(`originAsset ${req.originAsset} is not supported. See GET /v0/tokens`);
  if (!outT) throw new BadRequest(`destinationAsset ${req.destinationAsset} is not supported. See GET /v0/tokens`);
  if (inT === outT) throw new BadRequest('originAsset and destinationAsset must differ');
  if (!['EXACT_INPUT', 'EXACT_OUTPUT', 'FLEX_INPUT'].includes(req.swapType)) throw new BadRequest(`swapType ${req.swapType} is not supported by Tidepool v1 (supported: EXACT_INPUT, EXACT_OUTPUT, FLEX_INPUT)`);
  if (!['ORIGIN_CHAIN', 'INTENTS'].includes(req.depositType)) throw new BadRequest(`depositType ${req.depositType} is not supported by Tidepool v1 (supported: ORIGIN_CHAIN, INTENTS)`);
  if (!['ORIGIN_CHAIN', 'INTENTS'].includes(req.refundType)) throw new BadRequest(`refundType ${req.refundType} is not supported by Tidepool v1`);
  if (!['DESTINATION_CHAIN', 'INTENTS'].includes(req.recipientType)) throw new BadRequest(`recipientType ${req.recipientType} is not supported by Tidepool v1`);
  if (req.depositMode && req.depositMode !== 'SIMPLE') throw new BadRequest('depositMode MEMO is not used on NEAR; use SIMPLE');
  if (!isAccount(req.recipient)) throw new BadRequest('recipient must be a NEAR testnet account id');
  if (!isAccount(req.refundTo)) throw new BadRequest('refundTo must be a NEAR testnet account id');
  const slip = Number(req.slippageTolerance);
  if (!(slip >= 0 && slip <= 5000)) throw new BadRequest('slippageTolerance is in basis points, 0..5000');
  if (!/^\d+$/.test(String(req.amount)) || BigInt(req.amount) === 0n) throw new BadRequest('amount must be a positive integer string in base units');
  const deadline = new Date(req.deadline);
  if (isNaN(deadline)) throw new BadRequest('deadline must be an ISO 8601 date');
  if (!req.dry && deadline.getTime() < Date.now() + 60_000) throw new BadRequest('deadline must be at least 60 seconds in the future');
  if (!req.dry && deadline.getTime() > Date.now() + 24 * 3600_000) throw new BadRequest('deadline must be within 24 hours');
  if (req.appFees?.length) throw new BadRequest('appFees are not supported by Tidepool v1');

  const p = await prices();
  const fee = feeBps(inT, outT, authed);
  const amt = BigInt(req.amount);
  const s = BigInt(Math.round(slip));
  let amountIn, minAmountIn, amountOut, minAmountOut;
  if (req.swapType === 'EXACT_OUTPUT') {
    amountOut = amt; minAmountOut = amt;
    minAmountIn = invert(amt, inT, outT, p.prices, fee);
    amountIn = minAmountIn * (10000n + s) / 10000n; // deposit this; any excess is refunded
  } else {
    amountIn = amt;
    minAmountIn = req.swapType === 'FLEX_INPUT' ? amt * (10000n - s) / 10000n : amt;
    amountOut = convert(amt, inT, outT, p.prices, fee);
    minAmountOut = amountOut * (10000n - s) / 10000n;
  }
  if (amountOut <= 0n) throw new BadRequest('amount is too low for this pair');
  const inv = await makerBalance(outT.assetId);
  if (inv < amountOut) throw new BadRequest(`Not enough maker liquidity for ${outT.symbol} (max ~${fromUnits(inv, outT.decimals)})`);

  const correlationId = crypto.randomUUID();
  const q = {
    amountIn: amountIn.toString(), amountInFormatted: fromUnits(amountIn, inT.decimals), amountInUsd: usd(amountIn, inT, p.prices[inT.assetId]), minAmountIn: minAmountIn.toString(),
    amountOut: amountOut.toString(), amountOutFormatted: fromUnits(amountOut, outT.decimals), amountOutUsd: usd(amountOut, outT, p.prices[outT.assetId]), minAmountOut: minAmountOut.toString(),
    timeEstimate: 10,
  };
  if (!req.dry) {
    if (!MASTER) throw new BadRequest('server is not configured for live quotes', 503);
    const { accountId } = deriveDepositKey(MASTER, correlationId);
    Object.assign(q, { depositAddress: accountId, deadline: deadline.toISOString(), timeWhenInactive: deadline.toISOString() });
  }
  const body = { correlationId, timestamp: new Date().toISOString(), quoteRequest: req, quote: q };
  const quoteResponse = { ...body, signature: signQuote(body) };
  if (!req.dry) {
    db.swaps[q.depositAddress] = { quoteResponse, status: 'PENDING_DEPOSIT', updatedAt: new Date().toISOString(), feeBps: fee, priceSource: p.source, txs: [], intentHashes: [], originTxs: [], destTxs: [] };
    save();
  }
  return quoteResponse;
}

export function statusOf(depositAddress) {
  const s = db.swaps[depositAddress];
  if (!s) return null;
  const { quoteResponse: qr } = s;
  const inT = byAsset[qr.quoteRequest.originAsset], outT = byAsset[qr.quoteRequest.destinationAsset];
  const d = { intentHashes: [...new Set(s.intentHashes)], nearTxHashes: s.txs.map(t => t.hash), originChainTxHashes: s.originTxs.map(h => ({ hash: h, explorerUrl: txUrl(h) })), destinationChainTxHashes: s.destTxs.map(h => ({ hash: h, explorerUrl: txUrl(h) })) };
  const px = s.prices || {};
  if (s.amountIn) Object.assign(d, { amountIn: s.amountIn, amountInFormatted: fromUnits(s.amountIn, inT.decimals), amountInUsd: usd(s.amountIn, inT, px.in || 0) });
  if (s.amountOut) Object.assign(d, { amountOut: s.amountOut, amountOutFormatted: fromUnits(s.amountOut, outT.decimals), amountOutUsd: usd(s.amountOut, outT, px.out || 0) });
  if (s.slippage !== undefined) d.slippage = s.slippage;
  if (s.deposited) Object.assign(d, { depositedAmount: s.deposited, depositedAmountFormatted: fromUnits(s.deposited, inT.decimals), depositedAmountUsd: usd(s.deposited, inT, px.in || 0) });
  if (s.refunded) Object.assign(d, { refundedAmount: s.refunded, refundedAmountFormatted: fromUnits(s.refunded, inT.decimals), refundedAmountUsd: usd(s.refunded, inT, px.in || 0) });
  if (s.refundReason) d.refundReason = s.refundReason;
  return { correlationId: qr.correlationId, quoteResponse: qr, status: s.status, updatedAt: s.updatedAt, swapDetails: d, tidepool: { explorer: s.txs.map(t => ({ label: t.label, url: txUrl(t.hash) })), note: s.note } };
}

export function submitDeposit({ txHash, depositAddress, nearSenderAccount }) {
  if (!txHash || !depositAddress) throw new BadRequest('txHash and depositAddress are required');
  const s = db.swaps[depositAddress];
  if (!s) throw new BadRequest('Unknown depositAddress', 404);
  if (!s.originTxs.includes(txHash)) s.originTxs.push(txHash);
  if (nearSenderAccount) s.sender = nearSenderAccount;
  if (s.status === 'PENDING_DEPOSIT') { s.status = 'KNOWN_DEPOSIT_TX'; s.updatedAt = new Date().toISOString(); }
  save();
  return statusOf(depositAddress);
}

// ---------- settlement worker ----------
const set = (s, status, extra = {}) => { Object.assign(s, extra, { status, updatedAt: new Date().toISOString() }); save(); };
const intentsBal = async (acct, assetId) => BigInt(await view(VERIFIER, 'mt_balance_of', { account_id: acct, token_id: assetId }));

async function ensureStorage(token, accountId) {
  if (await view(token, 'storage_balance_of', { account_id: accountId })) return;
  await withSigner(ROOT, () => call(ROOT, token, 'storage_deposit', { account_id: accountId, registration_only: true }, { deposit: parseNear(0.00125) }));
}
async function depositKey(addr, s) {
  const { keyPair, accountId } = deriveDepositKey(MASTER, s.quoteResponse.correlationId);
  if (accountId !== addr) throw new Error('deposit key mismatch');
  await keyStore.setKey(NETWORK, addr, keyPair);
  return keyPair;
}
function outIntent(kind, account, t, amount) {
  return kind === 'INTENTS'
    ? { intent: 'transfer', receiver_id: account, tokens: { [t.assetId]: amount.toString() } }
    : { intent: 'ft_withdraw', token: t.contractAddress, receiver_id: account, amount: amount.toString() };
}
const hashesFrom = (logs) => logs.flatMap(l => { try { const e = JSON.parse(l.replace(/^EVENT_JSON:/, '')); return (e.data || []).map(x => x.intent_hash).filter(Boolean); } catch { return []; } });

async function execute(signed) {
  return withSigner(MAKER, () => call(MAKER, VERIFIER, 'execute_intents', { signed }, { gas: 300n * TGAS }));
}

// ORIGIN_CHAIN: the user sent NEP-141 tokens to the deposit address itself. Move them into the verifier.
async function sweepOrigin(addr, s, inT) {
  const bal = BigInt(await view(inT.contractAddress, 'ft_balance_of', { account_id: addr }));
  if (bal === 0n) return;
  const acct = await viewAccount(addr);
  if (!acct || BigInt(acct.amount) < parseNear(0.1)) {
    // Prepaid gas is reserved up front (refunded after), so the address needs ~0.1 NEAR of headroom.
    const h = await withSigner(ROOT, () => sendNear(ROOT, addr, parseNear(0.12)));
    s.txs.push({ label: 'gas top-up for deposit address', hash: h });
  }
  await depositKey(addr, s);
  const r = await withSigner(addr, () => call(addr, inT.contractAddress, 'ft_transfer_call', { receiver_id: VERIFIER, amount: bal.toString(), msg: addr }, { deposit: 1n, gas: 60n * TGAS }));
  s.txs.push({ label: 'move deposit into verifier', hash: r.txHash });
  save();
}

async function refund(addr, s, inT, amount, reason, status = 'REFUNDED') {
  const req = s.quoteResponse.quoteRequest;
  if (amount > 0n) {
    if (req.refundType === 'ORIGIN_CHAIN') await ensureStorage(inT.contractAddress, req.refundTo);
    const kp = await depositKey(addr, s);
    const p = signIntents({ signerId: addr, verifier: VERIFIER, keyPair: kp, intents: [outIntent(req.refundType === 'INTENTS' ? 'INTENTS' : 'NEAR', req.refundTo, inT, amount)] });
    const r = await execute([p]);
    s.txs.push({ label: 'refund', hash: r.txHash });
    s.intentHashes.push(...hashesFrom(r.logs));
    if (!r.ok) { set(s, 'FAILED', { note: 'refund failed: ' + r.failures.join('; ').slice(0, 300) }); return; }
    s.destTxs.push(r.txHash);
  }
  set(s, status, { refunded: amount.toString(), refundReason: reason });
}

async function settle(addr, s, inT, outT, deposited) {
  const req = s.quoteResponse.quoteRequest, q = s.quoteResponse.quote;
  const p = await prices();
  const fee = s.feeBps;
  let swapIn, out;
  if (req.swapType === 'EXACT_OUTPUT') {
    out = BigInt(q.amountOut);
    swapIn = invert(out, inT, outT, p.prices, fee);
    if (swapIn > deposited) return refund(addr, s, inT, deposited, 'PRICE_MOVED');
  } else {
    swapIn = deposited < BigInt(q.amountIn) ? deposited : BigInt(q.amountIn);
    out = convert(swapIn, inT, outT, p.prices, fee);
    const minOut = BigInt(q.minAmountOut) * swapIn / BigInt(q.amountIn);
    if (out < minOut) return refund(addr, s, inT, deposited, 'SLIPPAGE_EXCEEDED');
    if (out > BigInt(q.amountOut) * swapIn / BigInt(q.amountIn)) out = BigInt(q.amountOut) * swapIn / BigInt(q.amountIn); // never pay above the quote
  }
  if ((await makerBalance(outT.assetId)) < out) return refund(addr, s, inT, deposited, 'INSUFFICIENT_LIQUIDITY');
  set(s, 'PROCESSING', { deposited: deposited.toString() });
  if (req.recipientType === 'DESTINATION_CHAIN') await ensureStorage(outT.contractAddress, req.recipient);
  const excess = deposited - swapIn;
  if (excess > 0n && req.refundType === 'ORIGIN_CHAIN') await ensureStorage(inT.contractAddress, req.refundTo);
  const kp = await depositKey(addr, s);
  const userIntents = [
    { intent: 'token_diff', diff: { [inT.assetId]: (-swapIn).toString(), [outT.assetId]: out.toString() } },
    outIntent(req.recipientType, req.recipient, outT, out),
  ];
  if (excess > 0n) userIntents.push(outIntent(req.refundType === 'INTENTS' ? 'INTENTS' : 'NEAR', req.refundTo, inT, excess));
  const user = signIntents({ signerId: addr, verifier: VERIFIER, keyPair: kp, intents: userIntents });
  const maker = signIntents({ signerId: MAKER, verifier: VERIFIER, keyPair: makerKey(), intents: [{ intent: 'token_diff', diff: { [inT.assetId]: swapIn.toString(), [outT.assetId]: (-out).toString() } }] });
  const r = await execute([maker, user]);
  s.txs.push({ label: 'swap (execute_intents)', hash: r.txHash });
  s.intentHashes.push(...hashesFrom(r.logs));
  if (!r.ok) { s.note = 'settlement failed: ' + r.failures.join('; ').slice(0, 300); save(); return refund(addr, s, inT, await intentsBal(addr, inT.assetId), 'SWAP_FAILED'); }
  s.destTxs.push(r.txHash);
  const quoted = Number(q.amountOut) * Number(swapIn) / Number(q.amountIn);
  set(s, 'SUCCESS', { amountIn: swapIn.toString(), amountOut: out.toString(), refunded: excess > 0n ? excess.toString() : undefined, slippage: Math.round((1 - Number(out) / quoted) * 10000) / 10000, prices: { in: p.prices[inT.assetId], out: p.prices[outT.assetId] } });
}

async function tick(addr, s) {
  const req = s.quoteResponse.quoteRequest, q = s.quoteResponse.quote;
  const inT = byAsset[req.originAsset], outT = byAsset[req.destinationAsset];
  const deadline = new Date(q.deadline).getTime();
  if (req.depositType === 'ORIGIN_CHAIN') await sweepOrigin(addr, s, inT);
  const bal = await intentsBal(addr, inT.assetId);
  if (bal > 0n) s.deposited = bal.toString();
  if (bal >= BigInt(q.minAmountIn) && Date.now() < deadline) return settle(addr, s, inT, outT, bal);
  if (bal > 0n && Date.now() >= deadline) return refund(addr, s, inT, bal, bal < BigInt(q.minAmountIn) ? 'PARTIAL_DEPOSIT' : 'DEADLINE_PASSED');
  if (bal > 0n && s.status !== 'INCOMPLETE_DEPOSIT') set(s, 'INCOMPLETE_DEPOSIT');
}

const ACTIVE = ['PENDING_DEPOSIT', 'KNOWN_DEPOSIT_TX', 'INCOMPLETE_DEPOSIT', 'PROCESSING'];
export function startWorker() {
  const busy = new Set();
  setInterval(() => {
    if (!MASTER) return;
    for (const [addr, s] of Object.entries(db.swaps)) {
      if (!ACTIVE.includes(s.status) || busy.has(addr)) continue;
      if (Date.now() > new Date(s.quoteResponse.quote.deadline).getTime() + 24 * 3600_000) continue; // stop watching stale quotes
      busy.add(addr);
      tick(addr, s).catch(e => { s.note = String(e.message).slice(0, 300); save(); console.error('tick', addr, e.message); }).finally(() => busy.delete(addr));
    }
  }, 4000);
}
