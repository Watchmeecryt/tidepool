// Quote engine, maker and settlement worker. The maker fills from its own inventory inside the
// verifier: each swap is one execute_intents batch with two NEP-413 signed payloads
// (deposit address + maker) whose token_diff intents balance exactly.
import crypto from 'node:crypto';
import { KeyPair } from 'near-api-js';
import bs58 from 'bs58';
import { rpc, call, view, viewAccount, sendNear, signIntents, deriveDepositKey, keyStore, NETWORK, TGAS, parseNear, txUrl } from './near.mjs';
import { ROOT, VERIFIER, MAKER, TOKENS, fromUnits, chainOf, isEvmAddress, BRIDGE_ACCOUNT } from './config.mjs';
import * as evm from './evm.mjs';
import { prices } from './prices.mjs';
import { db, save } from './store.mjs';

const MASTER = process.env.DEPOSIT_MASTER_SEED;
const byAsset = Object.fromEntries(TOKENS.map(t => [t.assetId, t]));
const STABLE = new Set(['USDC', 'USDT']);
export class BadRequest extends Error { constructor(m, code = 400, extra) { super(m); this.code = code; if (extra) this.extra = extra; } }

// ---- First-call hints: extra fields on 400s (the spec's `message` field is kept) ----
const DOCS_QUICKSTART = 'https://www.usetidepool.tech/docs/quickstart';
const tp = (sub) => `nep141:${sub}.${ROOT}`;
const evmTp = (chain, sym) => TOKENS.find(t => t.chain === chain && t.symbol === sym)?.assetId;
const MAINNET_MAP = {
  'nep141:wrap.near': tp('wnear'),
  'nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1': tp('usdc'),
  'nep141:a0b86991c6218b36c1d19d4a2e9eb0ce3606eb48.factory.bridge.near': tp('usdc'),
  'nep141:usdt.tether-token.near': tp('usdt'),
  'nep141:dac17f958d2ee523a2206206994597c13d831ec7.factory.bridge.near': tp('usdt'),
  'nep141:eth.omft.near': tp('eth'), 'nep141:aurora': tp('eth'), 'nep141:eth.bridge.near': tp('eth'),
  'nep141:btc.omft.near': tp('wbtc'), 'nep141:nbtc.bridge.near': tp('wbtc'),
  'nep141:2260fac5e5542a773aa44fbcfedf7c193bc2c599.factory.bridge.near': tp('wbtc'),
  'nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near': evmTp('base', 'USDC'),
  'nep141:arb-0xaf88d065e77c8cc2239327c5edb3a432268e5831.omft.near': evmTp('arb', 'USDC'),
  'nep141:arb-0xfd086bc7cd5c481dcc9c85ebe478a1c0b69fcbb9.omft.near': evmTp('arb', 'USDT'),
  'nep141:eth-0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48.omft.near': evmTp('eth', 'USDC'),
  'nep141:eth-0xdac17f958d2ee523a2206206994597c13d831ec7.omft.near': evmTp('eth', 'USDT'),
};
export function suggestAsset(id) {
  const s = String(id || '').toLowerCase();
  if (MAINNET_MAP[s]) return MAINNET_MAP[s];
  const chain = /^nep141:(base|arb|eth)-0x/.exec(s)?.[1];
  const pick = (sym) => (chain && evmTp(chain, sym)) || tp(sym.toLowerCase());
  if (/usdc|17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1/.test(s)) return pick('USDC');
  if (/usdt|tether/.test(s)) return pick('USDT');
  if (/wrap\.|wnear/.test(s)) return tp('wnear');
  if (/btc/.test(s)) return tp('wbtc');
  if (/xaut|gold/.test(s)) return tp('xaut');
  if (/eth|aurora/.test(s)) return tp('eth');
  return null;
}
const testnetAcct = (v) => (typeof v === 'string' && /\.testnet$/.test(v) ? v : 'alice.testnet');
export function exampleQuote(req = {}) {
  return { dry: true, swapType: 'EXACT_INPUT', slippageTolerance: 100, originAsset: tp('usdc'), depositType: 'INTENTS', destinationAsset: tp('wnear'), amount: '10000000', refundTo: testnetAcct(req.refundTo), refundType: 'INTENTS', recipient: testnetAcct(req.recipient), recipientType: 'DESTINATION_CHAIN', deadline: new Date(Date.now() + 15 * 60_000).toISOString() };
}
const hint = (h, req, more = {}) => ({ hint: h, docs: DOCS_QUICKSTART, ...more, exampleRequest: exampleQuote(req) });

// ---- Tidepool-only: opt-in swap failure simulation (`simulate` on POST /v0/quote). Real 1Click has no such field. ----
export const SIMULATE_VALUES = ['STUCK', 'FAILED'];
const DOCS_SIMULATE = 'https://www.usetidepool.tech/docs/guides/failure-cases#stuck-or-failed-swap-simulated-outage';
const FAILED_DELAY_MS = Number(process.env.SIMULATE_FAILED_DELAY_MS) || 10_000; // PROCESSING time before a simulated FAILED
const SIM_NOTE = {
  STUCK: 'Simulated STUCK (Tidepool-only, from the simulate field of the quote request): settlement is withheld, so the swap stays PROCESSING until the quote deadline, then the deposit is refunded.',
  FAILED: 'Simulated FAILED (Tidepool-only, from the simulate field of the quote request): the swap moves to PROCESSING, then FAILED, and the deposit is refunded.',
};
function checkSimulate(req) {
  if (req.simulate === undefined || req.simulate === null) return undefined; // absent: ignored, like real 1Click
  if (!SIMULATE_VALUES.includes(req.simulate)) {
    const near = typeof req.simulate === 'string' && SIMULATE_VALUES.find(v => v === req.simulate.trim().toUpperCase());
    throw new BadRequest(`simulate ${JSON.stringify(req.simulate)} is not supported (supported: ${SIMULATE_VALUES.join(', ')})${near ? `. Did you mean ${near}?` : ''}`, 400, hint(`simulate is a Tidepool-only testnet field and is optional: omit it for a normal swap, or set it to ${SIMULATE_VALUES.join(' or ')} (uppercase) to simulate a stuck or failed swap. Remove it when you move to mainnet 1Click.`, req, { field: 'simulate', supportedValues: SIMULATE_VALUES, docs: DOCS_SIMULATE }));
  }
  if (req.swapType === 'ANY_INPUT') throw new BadRequest('simulate is not supported for ANY_INPUT quotes (use EXACT_INPUT, EXACT_OUTPUT or FLEX_INPUT)', 400, hint('Failure simulation needs a swap that settles once; ANY_INPUT converts every deposit separately.', req, { field: 'simulate', docs: DOCS_SIMULATE }));
  return req.simulate;
}
const SUPPORTED_SHORT = () => TOKENS.filter(t => !t.chain).map(t => t.assetId);
function assetError(field, id, req) {
  const sug = suggestAsset(id);
  const mainnet = /\.near$/.test(String(id)) || /^nep141:[0-9a-f]{64}$/.test(String(id));
  const msg = `${field} ${id} is not supported${mainnet ? ' (mainnet asset ids do not exist on Tidepool testnet)' : ''}.${sug ? ` Did you mean ${sug}?` : ''} See GET /v0/tokens`;
  return new BadRequest(msg, 400, hint(`Tidepool is testnet only and uses its own test tokens. Use asset ids from GET /v0/tokens${sug ? `, e.g. ${sug}` : ''}.`, req, { field, ...(sug ? { suggestedAssetId: sug } : {}), supportedAssetIds: SUPPORTED_SHORT() }));
}
const isMainnetAcct = (v) => typeof v === 'string' && /\.near$/.test(v);

// serialize transactions per signer so nonces never collide
const locks = {};
export function withSigner(id, fn) { const p = (locks[id] || Promise.resolve()).then(fn, fn); locks[id] = p.catch(() => {}); return p; }

const ACCOUNT_RE = /^(([a-z\d]+[-_])*[a-z\d]+\.)*([a-z\d]+[-_])*[a-z\d]+$/;
const isAccount = (s) => typeof s === 'string' && s.length >= 2 && s.length <= 64 && ACCOUNT_RE.test(s);

export function feeBps(inT, outT, authed) {
  if (inT.symbol === outT.symbol || (STABLE.has(inT.symbol) && STABLE.has(outT.symbol))) return authed ? 1 : 26; // 1 bp (+25 without key)
  return authed ? 20 : 45; // 20 bps (+25 without key)
}

// USD unit prices for /v0/status. Settled swaps store the settlement prices; refunds never settle, so
// fall back to the unit prices implied by the signed quote (amount*Usd / amount*Formatted).
export function statusPrices(s) {
  const q = s.quoteResponse?.quote || {};
  const unit = (usdV, f) => { const a = Number(f), u = Number(usdV); return a > 0 && Number.isFinite(u) ? u / a : 0; };
  return { in: s.prices?.in || unit(q.amountInUsd, q.amountInFormatted), out: s.prices?.out || unit(q.amountOutUsd, q.amountOutFormatted) };
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
  return TOKENS.map(t => ({ assetId: t.assetId, decimals: t.decimals, blockchain: t.blockchain, symbol: t.symbol, price: p.prices[t.assetId], priceUpdatedAt: at, contractAddress: t.contractAddress, coingeckoId: t.coingeckoId }));
}

function signQuote(obj) {
  const kp = makerKey();
  const sig = kp ? kp.sign(crypto.createHash('sha256').update(JSON.stringify(obj)).digest()).signature : crypto.randomBytes(64);
  return 'ed25519:' + bs58.encode(Buffer.from(sig));
}
let _mk; function makerKey() { return _mk; }
export async function initEngine() { _mk = await keyStore.getKey(NETWORK, MAKER); if (!MASTER) console.warn('DEPOSIT_MASTER_SEED missing: non-dry quotes disabled'); }

export async function quote(req, { authed, maxDeadlineMs = 24 * 3600_000 } = {}) {
  const need = ['dry', 'swapType', 'slippageTolerance', 'originAsset', 'depositType', 'destinationAsset', 'amount', 'refundTo', 'refundType', 'recipient', 'recipientType', 'deadline'];
  const missing = need.filter(k => req[k] === undefined || req[k] === null || req[k] === '');
  if (missing.length) throw new BadRequest(`${missing[0]} is required${missing.length > 1 ? ` (missing: ${missing.join(', ')})` : ''}`, 400, hint('A quote needs all of these fields. Copy exampleRequest and adjust it.', req, { missingFields: missing }));
  const simulate = checkSimulate(req);
  const { simulate: _sim, ...quoteReq } = req; // simulate is Tidepool-only: kept out of the echoed (1Click-shaped) quoteRequest
  const inT = byAsset[req.originAsset], outT = byAsset[req.destinationAsset];
  if (!inT) throw assetError('originAsset', req.originAsset, req);
  if (!outT) throw assetError('destinationAsset', req.destinationAsset, req);
  if (inT === outT) throw new BadRequest('originAsset and destinationAsset must differ');
  if (!SWAP_TYPES.includes(req.swapType)) throw new BadRequest(`swapType ${req.swapType} is not supported (supported: ${SWAP_TYPES.join(', ')})`);
  if (!['ORIGIN_CHAIN', 'INTENTS'].includes(req.depositType)) throw new BadRequest(`depositType ${req.depositType} is not supported by Tidepool v1 (supported: ORIGIN_CHAIN, INTENTS)`);
  if (!['ORIGIN_CHAIN', 'INTENTS'].includes(req.refundType)) throw new BadRequest(`refundType ${req.refundType} is not supported by Tidepool v1`);
  if (!['DESTINATION_CHAIN', 'INTENTS'].includes(req.recipientType)) throw new BadRequest(`recipientType ${req.recipientType} is not supported by Tidepool v1`);
  if (req.depositMode && !['SIMPLE', 'MEMO'].includes(req.depositMode)) throw new BadRequest('depositMode must be SIMPLE or MEMO');
  const memoMode = req.depositMode === 'MEMO';
  if (memoMode && (inT.chain || req.depositType !== 'ORIGIN_CHAIN')) throw new BadRequest('depositMode MEMO is supported for ORIGIN_CHAIN deposits of NEAR-native tokens (shared address + ft_transfer memo); use SIMPLE otherwise');
  if (req.swapType === 'ANY_INPUT' && memoMode) throw new BadRequest('ANY_INPUT quotes use depositMode SIMPLE');
  // Address formats follow 1Click: chain-native addresses for *_CHAIN types, NEAR accounts for INTENTS.
  const addrOk = (t, onChain, v) => (onChain && t.chain ? isEvmAddress(v) : isAccount(v));
  const what = (t, onChain) => (onChain && t.chain ? `a ${chainOf(t.chain).name} address (0x...)` : 'a NEAR testnet account id');
  for (const f of ['recipient', 'refundTo']) if (isMainnetAcct(req[f])) throw new BadRequest(`${f} ${req[f]} is a mainnet account; Tidepool runs on NEAR testnet. Use a .testnet account such as alice.testnet`, 400, hint('Use a NEAR testnet account (ending in .testnet), or an implicit testnet account. Create one free at https://testnet.mynearwallet.com.', req, { field: f }));
  if (!addrOk(outT, req.recipientType === 'DESTINATION_CHAIN', req.recipient)) throw new BadRequest(`recipient must be ${what(outT, req.recipientType === 'DESTINATION_CHAIN')}`);
  if (!addrOk(inT, req.refundType === 'ORIGIN_CHAIN', req.refundTo)) throw new BadRequest(`refundTo must be ${what(inT, req.refundType === 'ORIGIN_CHAIN')}`);
  const slip = Number(req.slippageTolerance);
  if (!(slip >= 0 && slip <= 5000)) throw new BadRequest('slippageTolerance is in basis points, 0..5000');
  if (!/^\d+$/.test(String(req.amount)) || BigInt(req.amount) === 0n) throw new BadRequest('amount must be a positive integer string in base units');
  const deadline = new Date(req.deadline);
  if (isNaN(deadline)) throw new BadRequest('deadline must be an ISO 8601 date', 400, hint('Use an ISO 8601 UTC timestamp, e.g. the deadline in exampleRequest.', req, { field: 'deadline' }));
  if (!req.dry && deadline.getTime() < Date.now() + 60_000) throw new BadRequest(`deadline must be at least 60 seconds in the future${deadline.getTime() < Date.now() ? ' (it is in the past)' : ''}`, 400, hint('Set deadline 5-30 minutes ahead, e.g. new Date(Date.now() + 15*60e3).toISOString().', req, { field: 'deadline', serverTime: new Date().toISOString() }));
  if (!req.dry && deadline.getTime() > Date.now() + maxDeadlineMs) throw new BadRequest(`deadline must be within ${maxDeadlineMs / 3600_000} hours`);
  const appFees = validateAppFees(req.appFees);
  const A = BigInt(appFees.reduce((a, f) => a + f.fee, 0));

  const p = await prices();
  const fee = feeBps(inT, outT, authed);
  const amt = BigInt(req.amount);
  const s = BigInt(Math.round(slip));
  let amountIn, minAmountIn, amountOut, minAmountOut;
  // appFees (bps of amountIn) are taken from the input before conversion, like 1Click mainnet.
  if (req.swapType === 'EXACT_OUTPUT') {
    amountOut = amt; minAmountOut = amt;
    minAmountIn = grossUp(invert(amt, inT, outT, p.prices, fee), A);
    amountIn = minAmountIn * (10000n + s) / 10000n; // deposit this; any excess is refunded
  } else {
    amountIn = amt;
    minAmountIn = req.swapType === 'FLEX_INPUT' ? amt * (10000n - s) / 10000n : req.swapType === 'ANY_INPUT' ? 1n : amt;
    amountOut = convert(amt - amt * A / 10000n, inT, outT, p.prices, fee);
    minAmountOut = amountOut * (10000n - s) / 10000n;
  }
  if (amountOut <= 0n) throw new BadRequest('amount is too low for this pair');
  const inv = await makerBalance(outT.assetId);
  if (inv < amountOut) throw new BadRequest(`Not enough maker liquidity for ${outT.symbol} (max ~${fromUnits(inv, outT.decimals)})`);

  const correlationId = crypto.randomUUID();
  const q = {
    amountIn: amountIn.toString(), amountInFormatted: fromUnits(amountIn, inT.decimals), amountInUsd: usd(amountIn, inT, p.prices[inT.assetId]), minAmountIn: minAmountIn.toString(),
    amountOut: amountOut.toString(), amountOutFormatted: fromUnits(amountOut, outT.decimals), amountOutUsd: usd(amountOut, outT, p.prices[outT.assetId]), minAmountOut: minAmountOut.toString(),
    timeEstimate: (inT.chain && req.depositType === 'ORIGIN_CHAIN') || (outT.chain && req.recipientType === 'DESTINATION_CHAIN') ? 60 : 10,
  };
  if (!req.dry) {
    if (!MASTER) throw new BadRequest('server is not configured for live quotes', 503);
    const { accountId } = deriveDepositKey(MASTER, correlationId);
    // EVM origin: a CREATE2 address of the chain's Tidepool vault; the funds are credited to the
    // per-quote NEAR intents account (accountId) once the relayer sweeps them.
    let depositAddress = inT.chain && req.depositType === 'ORIGIN_CHAIN' ? evm.depositAddressFor(inT.chain, correlationId) : accountId;
    if (memoMode) { depositAddress = await memoAccount(inT); q.depositAddress = depositAddress; q.depositMemo = newMemo(); }
    Object.assign(q, { depositAddress, deadline: deadline.toISOString(), timeWhenInactive: deadline.toISOString() });
    if (q.depositMemo) { const { depositMemo } = q; delete q.depositMemo; Object.assign(q, { depositAddress, depositMemo }); }
    if (req.swapType === 'ANY_INPUT' && req.depositType === 'INTENTS') q.chainDepositAddresses = [{ blockchain: 'near', address: accountId }];
  }
  const body = { correlationId, timestamp: new Date().toISOString(), quoteRequest: quoteReq, quote: q };
  const quoteResponse = { ...body, signature: signQuote(body) };
  if (!req.dry) {
    db.swaps[keyOf(q.depositAddress, q.depositMemo)] = { quoteResponse, appFees, depositMemo: q.depositMemo, intentsAccount: deriveDepositKey(MASTER, correlationId).accountId, status: 'PENDING_DEPOSIT', ...(simulate ? { simulate } : {}), updatedAt: new Date().toISOString(), feeBps: fee, priceSource: p.source, txs: [], intentHashes: [], originTxs: [], destTxs: [] };
    save();
  }
  return simulate ? { ...quoteResponse, tidepool: { simulate } } : quoteResponse;
}

export const keyOf = (a, memo) => (isEvmAddress(a) ? a.toLowerCase() : a) + (memo ? `#${memo}` : '');
export const SWAP_TYPES = ['EXACT_INPUT', 'EXACT_OUTPUT', 'FLEX_INPUT', 'ANY_INPUT'];
const grossUp = (net, A) => (net * 10000n + (10000n - A) - 1n) / (10000n - A); // smallest gross with gross - fee >= net
export function validateAppFees(list) {
  if (list === undefined || list === null) return [];
  if (!Array.isArray(list)) throw new BadRequest('appFees must be an array');
  if (list.length > 10) throw new BadRequest('appFees: at most 10 recipients');
  const out = list.map((f, i) => {
    if (!f || !isAccount(f.recipient)) throw new BadRequest(`appFees[${i}].recipient must be a NEAR (Intents) account id`);
    if (!Number.isInteger(f.fee) || f.fee < 0) throw new BadRequest(`appFees[${i}].fee must be a non-negative integer (basis points)`);
    return { recipient: f.recipient, fee: f.fee };
  });
  if (out.reduce((a, f) => a + f.fee, 0) >= 10000) throw new BadRequest('appFees total must be below 10000 bps');
  return out;
}
// Split the app fee out of a gross input amount: [{recipient, amount}], total
export function appFeeSplit(gross, appFees = []) {
  const parts = appFees.map(f => ({ recipient: f.recipient, amount: gross * BigInt(f.fee) / 10000n })).filter(x => x.amount > 0n);
  return { parts, total: parts.reduce((a, x) => a + x.amount, 0n) };
}
// ---- depositMode MEMO: one shared NEAR address, deposits matched by ft_transfer memo ----
export const memoKey = () => deriveDepositKey(MASTER, 'tidepool-memo-shared');
async function memoAccount(inT) {
  const { accountId, keyPair } = memoKey();
  await keyStore.setKey(NETWORK, accountId, keyPair);
  const a = await viewAccount(accountId);
  if (!a || BigInt(a.amount) < parseNear(0.2)) await withSigner(ROOT, () => sendNear(ROOT, accountId, parseNear(0.3)));
  await ensureStorage(inT.nearContract, accountId);
  return accountId;
}
const newMemo = () => String(crypto.randomInt(100000000, 999999999)) + String(crypto.randomInt(100, 999));
const acctOf = (addr, s) => s.intentsAccount || addr;
// explorer link for a tx hash recorded on a swap (NEAR by default, EVM when tagged)
const urlOf = (s, h) => (s.evmTxs?.[h] ? evm.evmTxUrl(s.evmTxs[h], h) : txUrl(h));
const tagEvm = (s, chain, h) => { (s.evmTxs ||= {})[h] = chain; return h; };

export function statusOf(depositAddress, depositMemo) {
  const s = db.swaps[keyOf(depositAddress, depositMemo)];
  if (!s) { if (!depositMemo && depositAddress && depositAddress === (MASTER && memoKey().accountId)) throw new BadRequest('depositMemo is required for this depositAddress (depositMode MEMO)'); return null; }
  const { quoteResponse: qr } = s;
  const inT = byAsset[qr.quoteRequest.originAsset], outT = byAsset[qr.quoteRequest.destinationAsset];
  const d = { intentHashes: [...new Set(s.intentHashes)], nearTxHashes: s.txs.map(t => t.hash).filter(h => !s.evmTxs?.[h]), originChainTxHashes: s.originTxs.map(h => ({ hash: h, explorerUrl: urlOf(s, h) })), destinationChainTxHashes: s.destTxs.map(h => ({ hash: h, explorerUrl: urlOf(s, h) })) };
  const px = statusPrices(s);
  if (s.amountIn) Object.assign(d, { amountIn: s.amountIn, amountInFormatted: fromUnits(s.amountIn, inT.decimals), amountInUsd: usd(s.amountIn, inT, px.in || 0) });
  if (s.amountOut) Object.assign(d, { amountOut: s.amountOut, amountOutFormatted: fromUnits(s.amountOut, outT.decimals), amountOutUsd: usd(s.amountOut, outT, px.out || 0) });
  if (s.slippage !== undefined) d.slippage = s.slippage;
  if (s.deposited) Object.assign(d, { depositedAmount: s.deposited, depositedAmountFormatted: fromUnits(s.deposited, inT.decimals), depositedAmountUsd: usd(s.deposited, inT, px.in || 0) });
  if (s.refunded) Object.assign(d, { refundedAmount: s.refunded, refundedAmountFormatted: fromUnits(s.refunded, inT.decimals), refundedAmountUsd: usd(s.refunded, inT, px.in || 0) });
  if (s.refundReason) d.refundReason = s.refundReason;
  if (qr.quoteRequest.referral) d.referral = qr.quoteRequest.referral;
  d.withdrawFee = '0';
  const tp = { explorer: s.txs.map(t => ({ label: t.label, url: urlOf(s, t.hash) })), intentsAccount: acctOf(depositAddress, s), note: s.note };
  if (s.simulate) { tp.simulate = s.simulate; if (!tp.note) tp.note = SIM_NOTE[s.simulate]; }
  if (s.appFeePaid?.length) tp.appFees = s.appFeePaid;
  if (s.withdrawals?.length) tp.anyInputWithdrawals = s.withdrawals.length;
  return { correlationId: qr.correlationId, quoteResponse: qr, status: s.status, updatedAt: s.updatedAt, swapDetails: d, tidepool: tp };
}

export function submitDeposit({ txHash, depositAddress, nearSenderAccount, memo }) {
  if (!txHash || !depositAddress) throw new BadRequest('txHash and depositAddress are required');
  const s = db.swaps[keyOf(depositAddress, memo)];
  if (!s) throw new BadRequest(memo ? 'Unknown depositAddress/memo' : (MASTER && depositAddress === memoKey().accountId ? 'memo is required for depositMode MEMO deposits' : 'Unknown depositAddress'), 404);
  if (s.depositMemo) {
    if (!nearSenderAccount) throw new BadRequest('nearSenderAccount is required for depositMode MEMO deposits (used to look the transaction up)');
    (s.memoTxs ||= []).find(t => t.hash === txHash) || s.memoTxs.push({ hash: txHash, sender: nearSenderAccount, stage: 'submitted' });
  }
  return submitDepositCommon(s, depositAddress, memo, txHash, nearSenderAccount);
}
function submitDepositCommon(s, depositAddress, memo, txHash, nearSenderAccount) {
  if (!s.originTxs.includes(txHash)) s.originTxs.push(txHash);
  const inT = byAsset[s.quoteResponse.quoteRequest.originAsset];
  if (inT.chain && /^0x[0-9a-fA-F]{64}$/.test(txHash)) tagEvm(s, inT.chain, txHash);
  if (nearSenderAccount) s.sender = nearSenderAccount;
  if (s.status === 'PENDING_DEPOSIT') { s.status = 'KNOWN_DEPOSIT_TX'; s.updatedAt = new Date().toISOString(); }
  save();
  return statusOf(depositAddress, memo);
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
  if (accountId !== acctOf(addr, s)) throw new Error('deposit key mismatch');
  await keyStore.setKey(NETWORK, accountId, keyPair);
  return keyPair;
}
function outIntent(kind, account, t, amount) {
  if (kind === 'INTENTS') return { intent: 'transfer', receiver_id: account, tokens: { [t.assetId]: amount.toString() } };
  // EVM payout: withdraw the bridged NEP-141 to the bridge account; the relayer then releases the ERC-20.
  if (t.chain) return { intent: 'ft_withdraw', token: t.nearContract, receiver_id: BRIDGE_ACCOUNT, amount: amount.toString(), memo: `WITHDRAW_TO:${account}` };
  return { intent: 'ft_withdraw', token: t.nearContract, receiver_id: account, amount: amount.toString() };
}
// Queue an EVM payout for a bridged token that was withdrawn to the bridge account.
function queueRelease(s, tag, t, to, amount) {
  if (!t.chain || amount <= 0n) return;
  (s.releases ||= []).push({ id: evm.releaseId(`${s.quoteResponse.correlationId}:${tag}`), chain: t.chain, token: t.evmAddress, to, amount: amount.toString(), tag, done: false });
}
async function processReleases(s) {
  for (const r of s.releases.filter(r => !r.done)) {
    if (await evm.isReleased(r.chain, r.id)) { r.done = true; save(); continue; }
    const h = await evm.release(r.chain, r.id, r.token, r.to, BigInt(r.amount));
    tagEvm(s, r.chain, h);
    s.txs.push({ label: `${r.tag} payout on ${chainOf(r.chain).name}`, hash: h });
    s.destTxs.push(h);
    r.done = true; save();
  }
  if (s.final) { const { status, ...extra } = s.final; delete s.final; set(s, status, extra); }
}
const finish = (s, status, extra) => {
  if (s.releases?.some(r => !r.done)) { s.final = { status, ...extra }; set(s, 'PROCESSING'); return; }
  set(s, status, extra);
};
const hashesFrom = (logs) => logs.flatMap(l => { try { const e = JSON.parse(l.replace(/^EVENT_JSON:/, '')); return (e.data || []).map(x => x.intent_hash).filter(Boolean); } catch { return []; } });

async function execute(signed) {
  return withSigner(MAKER, () => call(MAKER, VERIFIER, 'execute_intents', { signed }, { gas: 300n * TGAS }));
}

// ORIGIN_CHAIN: the user sent NEP-141 tokens to the deposit address itself. Move them into the verifier.
async function sweepOrigin(addr, s, inT) {
  if (inT.chain) return bridgeIn(addr, s, inT);
  const bal = BigInt(await view(inT.nearContract, 'ft_balance_of', { account_id: addr }));
  if (bal === 0n) return;
  const acct = await viewAccount(addr);
  if (!acct || BigInt(acct.amount) < parseNear(0.1)) {
    // Prepaid gas is reserved up front (refunded after), so the address needs ~0.1 NEAR of headroom.
    const h = await withSigner(ROOT, () => sendNear(ROOT, addr, parseNear(0.12)));
    s.txs.push({ label: 'gas top-up for deposit address', hash: h });
  }
  await depositKey(addr, s);
  const r = await withSigner(addr, () => call(addr, inT.nearContract, 'ft_transfer_call', { receiver_id: VERIFIER, amount: bal.toString(), msg: addr }, { deposit: 1n, gas: 60n * TGAS }));
  s.txs.push({ label: 'move deposit into verifier', hash: r.txHash });
  save();
}

// EVM origin: sweep the per-quote CREATE2 deposit address into the vault, then credit the matching
// NEP-141 to the quote's intents account with a normal ft_transfer_call into the verifier.
async function bridgeIn(addr, s, inT) {
  const c = inT.chain;
  s.bridgeIn ||= [];
  for (const b of s.bridgeIn.filter(b => b.stage !== 'credited')) {
    if (b.stage === 'swept') {
      const m = await withSigner(ROOT, () => call(ROOT, inT.nearContract, 'mint', { account_id: BRIDGE_ACCOUNT, amount: b.amount }));
      if (!m.ok) throw new Error('bridge mint failed: ' + m.failures.join('; '));
      s.txs.push({ label: `mint bridged ${inT.symbol} (${chainOf(c).name} deposit)`, hash: m.txHash });
      b.stage = 'minted'; save();
    }
    if (b.stage === 'minted') {
      const r = await withSigner(ROOT, () => call(ROOT, inT.nearContract, 'ft_transfer_call', { receiver_id: VERIFIER, amount: b.amount, msg: acctOf(addr, s) }, { deposit: 1n, gas: 100n * TGAS }));
      if (!r.ok) throw new Error('bridge credit failed: ' + r.failures.join('; '));
      s.txs.push({ label: 'credit deposit into verifier (ft_transfer_call)', hash: r.txHash });
      b.stage = 'credited'; save();
    }
  }
  const bal = await evm.erc20Balance(c, inT.evmAddress, addr);
  if (bal === 0n) return;
  if (!s.originTxs.some(h => s.evmTxs?.[h])) for (const h of await evm.findDepositTxs(c, inT.evmAddress, addr)) { if (!s.originTxs.includes(h)) s.originTxs.push(h); tagEvm(s, c, h); }
  if (s.status === 'PENDING_DEPOSIT') set(s, 'KNOWN_DEPOSIT_TX');
  const sw = await evm.sweep(c, s.quoteResponse.correlationId, inT.evmAddress);
  tagEvm(s, c, sw.hash);
  s.txs.push({ label: `sweep deposit address into vault (${chainOf(c).name})`, hash: sw.hash });
  s.bridgeIn.push({ sweepTx: sw.hash, amount: sw.amount.toString(), stage: 'swept' }); save();
  return bridgeIn(addr, s, inT);
}

async function refund(addr, s, inT, amount, reason, status = 'REFUNDED') {
  const req = s.quoteResponse.quoteRequest;
  if (amount > 0n) {
    if (req.refundType === 'ORIGIN_CHAIN') await ensureStorage(inT.nearContract, inT.chain ? BRIDGE_ACCOUNT : req.refundTo);
    const kp = await depositKey(addr, s);
    const p = signIntents({ signerId: acctOf(addr, s), verifier: VERIFIER, keyPair: kp, intents: [outIntent(req.refundType === 'INTENTS' ? 'INTENTS' : 'NEAR', req.refundTo, inT, amount)] });
    const r = await execute([p]);
    s.txs.push({ label: 'refund', hash: r.txHash });
    s.intentHashes.push(...hashesFrom(r.logs));
    if (!r.ok) { set(s, 'FAILED', { note: 'refund failed: ' + r.failures.join('; ').slice(0, 300) }); return; }
    s.destTxs.push(r.txHash);
    if (req.refundType === 'ORIGIN_CHAIN') queueRelease(s, 'refund', inT, req.refundTo, amount);
  }
  if (s.releases?.length) await processReleases(s).catch(e => { s.note = 'payout pending: ' + String(e.message).slice(0, 200); save(); });
  finish(s, status, { refunded: amount.toString(), refundReason: reason });
}

async function settle(addr, s, inT, outT, deposited) {
  const req = s.quoteResponse.quoteRequest, q = s.quoteResponse.quote;
  const p = await prices();
  const fee = s.feeBps;
  let swapIn, out;
  const A = BigInt((s.appFees || []).reduce((a, f) => a + f.fee, 0));
  if (req.swapType === 'EXACT_OUTPUT') {
    out = BigInt(q.amountOut);
    swapIn = grossUp(invert(out, inT, outT, p.prices, fee), A);
    if (swapIn > deposited) return refund(addr, s, inT, deposited, 'PRICE_MOVED');
  } else {
    swapIn = deposited < BigInt(q.amountIn) ? deposited : BigInt(q.amountIn);
    out = convert(swapIn - swapIn * A / 10000n, inT, outT, p.prices, fee);
    const minOut = BigInt(q.minAmountOut) * swapIn / BigInt(q.amountIn);
    if (out < minOut) return refund(addr, s, inT, deposited, 'SLIPPAGE_EXCEEDED');
    if (out > BigInt(q.amountOut) * swapIn / BigInt(q.amountIn)) out = BigInt(q.amountOut) * swapIn / BigInt(q.amountIn); // never pay above the quote
  }
  if ((await makerBalance(outT.assetId)) < out) return refund(addr, s, inT, deposited, 'INSUFFICIENT_LIQUIDITY');
  set(s, 'PROCESSING', { deposited: deposited.toString() });
  if (req.recipientType === 'DESTINATION_CHAIN') await ensureStorage(outT.nearContract, outT.chain ? BRIDGE_ACCOUNT : req.recipient);
  const excess = deposited - swapIn;
  if (excess > 0n && req.refundType === 'ORIGIN_CHAIN') await ensureStorage(inT.nearContract, inT.chain ? BRIDGE_ACCOUNT : req.refundTo);
  const kp = await depositKey(addr, s);
  const af = appFeeSplit(swapIn, s.appFees);
  const tradeIn = swapIn - af.total;
  const userIntents = [
    ...af.parts.map(x => ({ intent: 'transfer', receiver_id: x.recipient, tokens: { [inT.assetId]: x.amount.toString() }, memo: 'appFee' })),
    { intent: 'token_diff', diff: { [inT.assetId]: (-tradeIn).toString(), [outT.assetId]: out.toString() } },
    outIntent(req.recipientType, req.recipient, outT, out),
  ];
  if (excess > 0n) userIntents.push(outIntent(req.refundType === 'INTENTS' ? 'INTENTS' : 'NEAR', req.refundTo, inT, excess));
  const user = signIntents({ signerId: acctOf(addr, s), verifier: VERIFIER, keyPair: kp, intents: userIntents });
  const maker = signIntents({ signerId: MAKER, verifier: VERIFIER, keyPair: makerKey(), intents: [{ intent: 'token_diff', diff: { [inT.assetId]: tradeIn.toString(), [outT.assetId]: (-out).toString() } }] });
  const r = await execute([maker, user]);
  s.txs.push({ label: af.parts.length ? 'swap + appFees (execute_intents)' : 'swap (execute_intents)', hash: r.txHash });
  if (r.ok && af.parts.length) s.appFeePaid = af.parts.map(x => ({ recipient: x.recipient, asset: inT.assetId, amount: x.amount.toString(), amountFormatted: fromUnits(x.amount, inT.decimals), txHash: r.txHash }));
  s.intentHashes.push(...hashesFrom(r.logs));
  if (!r.ok) { s.note = 'settlement failed: ' + r.failures.join('; ').slice(0, 300); save(); return refund(addr, s, inT, await intentsBal(acctOf(addr, s), inT.assetId), 'SWAP_FAILED'); }
  s.destTxs.push(r.txHash);
  if (req.recipientType === 'DESTINATION_CHAIN') queueRelease(s, 'swap', outT, req.recipient, out);
  if (excess > 0n && req.refundType === 'ORIGIN_CHAIN') queueRelease(s, 'excess refund', inT, req.refundTo, excess);
  if (s.releases?.length) await processReleases(s).catch(e => { s.note = 'payout pending: ' + String(e.message).slice(0, 200); save(); });
  const quoted = Number(q.amountOut) * Number(swapIn) / Number(q.amountIn);
  finish(s, 'SUCCESS', { amountIn: swapIn.toString(), amountOut: out.toString(), refunded: excess > 0n ? excess.toString() : undefined, slippage: Math.round((1 - Number(out) / quoted) * 10000) / 10000, prices: { in: p.prices[inT.assetId], out: p.prices[outT.assetId] } });
}

async function tick(addr, s) {
  const req = s.quoteResponse.quoteRequest, q = s.quoteResponse.quote;
  const inT = byAsset[req.originAsset], outT = byAsset[req.destinationAsset];
  const deadline = new Date(q.deadline).getTime();
  if (s.releases?.some(r => !r.done) || s.final) return processReleases(s); // settled on NEAR, EVM payout pending
  if (s.depositMemo) await sweepMemo(addr, s, inT);
  else if (req.depositType === 'ORIGIN_CHAIN') await sweepOrigin(addr, s, inT);
  if (s.order) return hooks.tickOrder(addr, s, inT, outT);
  if (req.swapType === 'ANY_INPUT') return tickAnyInput(addr, s, inT, outT, deadline);
  const bal = await intentsBal(acctOf(addr, s), inT.assetId);
  if (bal > 0n) s.deposited = bal.toString();
  if (s.simulate && (await simulateTick(addr, s, inT, bal, deadline))) return;
  if (bal >= BigInt(q.minAmountIn) && Date.now() < deadline) return settle(addr, s, inT, outT, bal);
  if (bal > 0n && Date.now() >= deadline) return refund(addr, s, inT, bal, bal < BigInt(q.minAmountIn) ? 'PARTIAL_DEPOSIT' : 'DEADLINE_PASSED');
  if (bal > 0n && s.status !== 'INCOMPLETE_DEPOSIT') set(s, 'INCOMPLETE_DEPOSIT');
}

// Simulated outage (opt-in `simulate` on the quote). Returns true when it handled this tick.
//  STUCK:  deposit seen -> PROCESSING and no settlement. At the deadline the normal late path refunds it (REFUNDED, DEADLINE_PASSED).
//  FAILED: deposit seen -> PROCESSING, then after FAILED_DELAY_MS -> FAILED with the deposit refunded (refundReason SWAP_FAILED).
async function simulateTick(addr, s, inT, bal, deadline) {
  const q = s.quoteResponse.quote;
  const funded = bal >= BigInt(q.minAmountIn) && Date.now() < deadline;
  if (s.simulate === 'STUCK') {
    if (!funded) return false; // underpaid or past the deadline: normal INCOMPLETE_DEPOSIT / refund handling
    if (s.status !== 'PROCESSING') set(s, 'PROCESSING', { deposited: bal.toString(), simulatedAt: new Date().toISOString() });
    return true;
  }
  if (s.simulate === 'FAILED') {
    if (s.status !== 'PROCESSING') {
      if (!funded) return false;
      set(s, 'PROCESSING', { deposited: bal.toString(), simulatedAt: new Date().toISOString() });
      return true;
    }
    if (Date.now() - new Date(s.simulatedAt || 0).getTime() < FAILED_DELAY_MS) return true;
    await refund(addr, s, inT, bal, 'SWAP_FAILED', 'FAILED'); // FAILED is final; the deposit still goes back to refundTo
    return true;
  }
  return false;
}

// ---- MEMO deposits: verify the user's ft_transfer to the shared address carried our memo, then forward ----
async function sweepMemo(addr, s, inT) {
  const { accountId: shared, keyPair } = memoKey();
  db.memoTxs ||= {};
  for (const t of (s.memoTxs || []).filter(t => t.stage === 'submitted')) {
    if (db.memoTxs[t.hash] && db.memoTxs[t.hash] !== addr) { t.stage = 'rejected'; t.reason = 'tx already credited to another memo'; save(); continue; }
    let tx;
    try { tx = await rpc('tx', { tx_hash: t.hash, sender_account_id: t.sender, wait_until: 'FINAL' }); } catch (e) { t.tries = (t.tries || 0) + 1; if (t.tries > 30) { t.stage = 'rejected'; t.reason = 'tx not found'; } save(); continue; }
    const ok = !tx.status?.Failure && !tx.receipts_outcome.some(r => r.outcome.status.Failure);
    let amount = 0n;
    if (ok && tx.transaction.receiver_id === inT.nearContract) for (const a of tx.transaction.actions) {
      const fc = a.FunctionCall; if (!fc || fc.method_name !== 'ft_transfer') continue;
      try { const args = JSON.parse(Buffer.from(fc.args, 'base64').toString()); if (args.receiver_id === shared && String(args.memo) === s.depositMemo) amount += BigInt(args.amount); } catch {}
    }
    if (amount === 0n) { t.stage = 'rejected'; t.reason = `no successful ft_transfer of ${inT.symbol} to ${shared} with memo ${s.depositMemo}`; save(); continue; }
    db.memoTxs[t.hash] = addr; t.amount = amount.toString(); t.stage = 'matched'; save();
  }
  for (const t of (s.memoTxs || []).filter(t => t.stage === 'matched')) {
    await keyStore.setKey(NETWORK, shared, keyPair);
    const r = await withSigner(shared, () => call(shared, inT.nearContract, 'ft_transfer_call', { receiver_id: VERIFIER, amount: t.amount, msg: acctOf(addr, s) }, { deposit: 1n, gas: 60n * TGAS }));
    s.txs.push({ label: `forward memo ${s.depositMemo} deposit into verifier`, hash: r.txHash });
    t.stage = r.ok ? 'credited' : 'matched'; save();
    if (!r.ok) throw new Error('memo forward failed: ' + r.failures.join('; '));
  }
}

// ---- ANY_INPUT: every deposit (any amount) is converted at the live price and sent to the recipient ----
async function tickAnyInput(addr, s, inT, outT, deadline) {
  const req = s.quoteResponse.quoteRequest;
  const bal = await intentsBal(acctOf(addr, s), inT.assetId);
  if (bal === 0n) return;
  if (Date.now() >= deadline) return refund(addr, s, inT, bal, 'DEADLINE_PASSED', s.withdrawals?.length ? 'SUCCESS' : 'REFUNDED');
  const p = await prices();
  const af = appFeeSplit(bal, s.appFees);
  const tradeIn = bal - af.total;
  const out = convert(tradeIn, inT, outT, p.prices, s.feeBps);
  if (out <= 0n) return; // dust: wait for more
  if ((await makerBalance(outT.assetId)) < out) { s.note = 'waiting for maker liquidity'; save(); return; }
  set(s, 'PROCESSING', { deposited: ((BigInt(s.deposited || 0)) + bal).toString() });
  if (req.recipientType === 'DESTINATION_CHAIN') await ensureStorage(outT.nearContract, outT.chain ? BRIDGE_ACCOUNT : req.recipient);
  const kp = await depositKey(addr, s);
  const user = signIntents({ signerId: acctOf(addr, s), verifier: VERIFIER, keyPair: kp, intents: [
    ...af.parts.map(x => ({ intent: 'transfer', receiver_id: x.recipient, tokens: { [inT.assetId]: x.amount.toString() }, memo: 'appFee' })),
    { intent: 'token_diff', diff: { [inT.assetId]: (-tradeIn).toString(), [outT.assetId]: out.toString() } },
    outIntent(req.recipientType, req.recipient, outT, out),
  ] });
  const maker = signIntents({ signerId: MAKER, verifier: VERIFIER, keyPair: makerKey(), intents: [{ intent: 'token_diff', diff: { [inT.assetId]: tradeIn.toString(), [outT.assetId]: (-out).toString() } }] });
  const r = await execute([maker, user]);
  s.txs.push({ label: 'ANY_INPUT conversion (execute_intents)', hash: r.txHash });
  s.intentHashes.push(...hashesFrom(r.logs));
  (s.withdrawals ||= []).push({ status: r.ok ? 'SUCCESS' : 'FAILED', amountOutFormatted: fromUnits(r.ok ? out : 0n, outT.decimals), amountOutUsd: usd(r.ok ? out : 0n, outT, p.prices[outT.assetId]), amountOut: (r.ok ? out : 0n).toString(), withdrawFeeFormatted: '0', withdrawFee: '0', withdrawFeeUsd: '0', timestamp: new Date().toISOString(), hash: r.txHash, amountIn: bal.toString() });
  if (!r.ok) { set(s, 'FAILED', { note: 'ANY_INPUT conversion failed: ' + r.failures.join('; ').slice(0, 300) }); return; }
  s.destTxs.push(r.txHash);
  if (af.parts.length) (s.appFeePaid ||= []).push(...af.parts.map(x => ({ recipient: x.recipient, asset: inT.assetId, amount: x.amount.toString(), amountFormatted: fromUnits(x.amount, inT.decimals), txHash: r.txHash })));
  if (req.recipientType === 'DESTINATION_CHAIN') queueRelease(s, `any-input ${s.withdrawals.length}`, outT, req.recipient, out);
  if (s.releases?.length) await processReleases(s).catch(e => { s.note = 'payout pending: ' + String(e.message).slice(0, 200); save(); });
  const sum = (k) => s.withdrawals.filter(w => w.status === 'SUCCESS').reduce((a, w) => a + BigInt(w[k]), 0n);
  finish(s, 'SUCCESS', { amountIn: sum('amountIn').toString(), amountOut: sum('amountOut').toString(), prices: { in: p.prices[inT.assetId], out: p.prices[outT.assetId] } });
}
export function anyInputWithdrawals(depositAddress, depositMemo, { timestampFrom, page = 1, limit = 50, sortOrder = 'desc' } = {}) {
  const s = db.swaps[keyOf(depositAddress, depositMemo)];
  if (!s) return null;
  const req = s.quoteResponse.quoteRequest;
  if (req.swapType !== 'ANY_INPUT') throw new BadRequest('depositAddress does not belong to an ANY_INPUT quote');
  let w = (s.withdrawals || []).map(({ amountIn, ...x }) => x);
  if (timestampFrom) { const t = new Date(timestampFrom).getTime(); if (isNaN(t)) throw new BadRequest('timestampFrom must be an ISO date'); w = w.filter(x => new Date(x.timestamp).getTime() >= t); }
  if (sortOrder === 'desc') w.reverse();
  limit = Math.min(Math.max(1, Number(limit) || 50), 50); page = Math.max(1, Number(page) || 1);
  const pageItems = w.slice((page - 1) * limit, page * limit);
  // Spec types `withdrawals` as a single AnyInputQuoteWithdrawal: we return the first one on the page there,
  // and the whole page under the `tidepool.withdrawals` extension.
  const out = { asset: req.destinationAsset, recipient: req.recipient, affiliateRecipient: s.appFees?.[0]?.recipient || '' };
  if (pageItems[0]) out.withdrawals = pageItems[0];
  out.tidepool = { withdrawals: pageItems, total: w.length, page, limit };
  return out;
}

// internals shared with orders.mjs / intents.mjs
export const hooks = { tickOrder: async () => {} };
export const internals = { convert, invert, grossUp, settle: (...a) => settle(...a), refund: (...a) => refund(...a), intentsBal, deriveDepositKey: (id) => deriveDepositKey(MASTER, id), execute, hashesFrom, byAsset, isAccount, set, MASTER: () => MASTER, feeBps, usd };

const ACTIVE = ['PENDING_DEPOSIT', 'KNOWN_DEPOSIT_TX', 'INCOMPLETE_DEPOSIT', 'PROCESSING'];
export function startWorker() {
  const busy = new Set();
  setInterval(() => {
    if (!MASTER) return;
    for (const [addr, s] of Object.entries(db.swaps)) {
      const anyLive = s.quoteResponse.quoteRequest.swapType === 'ANY_INPUT' && s.status === 'SUCCESS' && Date.now() < new Date(s.quoteResponse.quote.deadline).getTime() + 60_000;
      const orderLive = s.order && !['FILLED', 'CANCELED', 'EXPIRED'].includes(s.order.fillStatus);
      if (!(ACTIVE.includes(s.status) || anyLive || orderLive) || busy.has(addr)) continue;
      if (Date.now() > new Date(s.quoteResponse.quote.deadline).getTime() + 24 * 3600_000) continue; // stop watching stale quotes
      busy.add(addr);
      tick(addr, s).catch(e => { s.note = String(e.message).slice(0, 300); save(); console.error('tick', addr, e.message); }).finally(() => busy.delete(addr));
    }
  }, 4000);
}
