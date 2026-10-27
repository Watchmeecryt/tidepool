// /v0/orders: LIMIT orders (1Click JSON:API shape). Each order is backed by a Tidepool deposit address;
// the worker fills it against the maker once the live price reaches the limit. confidentiality is accepted and ignored.
import crypto from 'node:crypto';
import { TOKENS, fromUnits, toUnits } from './config.mjs';
import { db, save } from './store.mjs';
import { BadRequest, quote, hooks, internals, validateAppFees, appFeeSplit, keyOf } from './engine.mjs';
import { prices } from './prices.mjs';

export class ApiError extends Error { constructor(status, code, title, detail, pointer) { super(detail); Object.assign(this, { status, code, title, pointer }); } }
const meta = (extra) => ({ correlationId: crypto.randomUUID(), timestamp: new Date().toISOString(), ...extra });
export const errorDoc = (e) => ({ errors: [{ status: String(e.status), code: e.code, title: e.title, detail: e.message, ...(e.pointer ? { source: { pointer: e.pointer } } : {}) }], meta: meta() });
const invalid = (detail, field) => new ApiError(400, 'validation-failed', 'Validation failed', detail, field ? `/data/attributes/${field}` : undefined);
const byAsset = Object.fromEntries(TOKENS.map(t => [t.assetId, t]));
const FINAL = ['FILLED', 'CANCELED', 'EXPIRED'];

function owned(owner, id) {
  const e = Object.entries(db.swaps).find(([, s]) => s.order?.id === id);
  if (!e || e[1].order.owner !== owner) throw new ApiError(404, 'order-not-found', 'Order not found', `No order ${id}`);
  return e;
}

export async function createOrder(owner, body) {
  if (!body?.data || typeof body.data !== 'object') throw new ApiError(400, 'malformed-request', 'Malformed request', 'body must be {data:{type:"orders",attributes}}');
  if (body.data.id !== undefined) throw new ApiError(403, 'client-generated-id', 'Client generated id', 'Client-generated ids are not supported');
  if (body.data.type !== 'orders') throw new ApiError(409, 'resource-type-mismatch', 'Resource type mismatch', 'data.type must be "orders"', '/data/type');
  const a = body.data.attributes || {};
  for (const k of ['orderType', 'baseAsset', 'quoteAsset', 'quantity', 'side', 'price', 'depositType', 'refundTo', 'refundType', 'recipient', 'recipientType', 'confidentiality']) if (a[k] === undefined || a[k] === '') throw invalid(`${k} is required`, k);
  if (a.orderType !== 'LIMIT') throw invalid('orderType must be LIMIT', 'orderType');
  if (!['SELL', 'BUY'].includes(a.side)) throw invalid('side must be SELL or BUY', 'side');
  if (!['public', 'basic', 'advanced'].includes(a.confidentiality)) throw invalid('confidentiality must be public, basic or advanced', 'confidentiality');
  if (a.timeInForce && a.timeInForce !== 'GTC') throw invalid('timeInForce must be GTC', 'timeInForce');
  const base = byAsset[a.baseAsset], qt = byAsset[a.quoteAsset];
  if (!base) throw invalid('unknown baseAsset', 'baseAsset');
  if (!qt) throw invalid('unknown quoteAsset', 'quoteAsset');
  if (base === qt) throw invalid('baseAsset and quoteAsset must differ', 'quoteAsset');
  if (!/^\d+$/.test(a.quantity) || BigInt(a.quantity) <= 0n) throw invalid('quantity must be a positive integer string (smallest units)', 'quantity');
  if (!/^\d+(\.\d+)?$/.test(String(a.price)) || Number(a.price) <= 0) throw invalid('price must be a positive decimal string', 'price');
  let appFees; try { appFees = validateAppFees(a.appFees); } catch (e) { throw invalid(e.message, 'appFees'); }
  const A = BigInt(appFees.reduce((x, f) => x + f.fee, 0));
  const deadline = a.deadline ? new Date(a.deadline) : new Date(Date.now() + 7 * 86400_000);
  if (isNaN(deadline)) throw invalid('deadline must be ISO 8601', 'deadline');
  const qty = BigInt(a.quantity);
  // quote-asset amount for `qty` base at `price`, in quote smallest units
  const P = 10n ** 18n, priceE18 = toUnits(String(a.price), 18);
  const quoteAmt = (q) => q * priceE18 * 10n ** BigInt(qt.decimals) / (10n ** BigInt(base.decimals) * P);
  const sell = a.side === 'SELL';
  const inT = sell ? base : qt, outT = sell ? qt : base;
  let fundAmount, swapView;
  if (sell) {
    const minOut = quoteAmt(qty - qty * A / 10000n);
    if (minOut <= 0n) throw invalid('quantity × price is too small', 'quantity');
    fundAmount = qty; swapView = { swapType: 'EXACT_INPUT', originAsset: inT.assetId, destinationAsset: outT.assetId, amountIn: qty.toString(), minAmountOut: minOut.toString() };
  } else {
    const net = quoteAmt(qty) + 1n;
    fundAmount = (net * 10000n + (10000n - A) - 1n) / (10000n - A);
    swapView = { swapType: 'EXACT_OUTPUT', originAsset: inT.assetId, destinationAsset: outT.assetId, maxAmountIn: fundAmount.toString(), amountOut: qty.toString() };
  }
  let qr;
  try {
    qr = await quote({ dry: false, swapType: sell ? 'EXACT_INPUT' : 'EXACT_OUTPUT', slippageTolerance: 0, originAsset: inT.assetId, destinationAsset: outT.assetId, amount: (sell ? qty : qty).toString(), depositType: a.depositType, depositMode: a.depositMode || 'SIMPLE', refundTo: a.refundTo, refundType: a.refundType, recipient: a.recipient, recipientType: a.recipientType, deadline: deadline.toISOString(), appFees }, { authed: true, maxDeadlineMs: 30 * 86400_000, order: true });
  } catch (e) { throw new ApiError(400, 'order-rejected', 'Order rejected', e.message); }
  const s = db.swaps[keyOf(qr.quote.depositAddress, qr.quote.depositMemo)];
  if (sell) Object.assign(s.quoteResponse.quote, { amountOut: swapView.minAmountOut, minAmountOut: swapView.minAmountOut, amountOutFormatted: fromUnits(BigInt(swapView.minAmountOut), outT.decimals) }); // fill exactly at the limit
  const id = 'ord_' + crypto.randomBytes(12).toString('hex');
  s.order = { id, owner, attrs: { ...a, appFees, deadline: deadline.toISOString(), timeInForce: 'GTC', depositMode: a.depositMode || 'SIMPLE' }, swapView, fundAmount: fundAmount.toString(), fillStatus: 'AWAITING_DEPOSIT', createdAt: new Date().toISOString(), fills: [] };
  save();
  return { data: view(s), meta: meta() };
}

function payout(s) {
  const done = (h) => ({ status: 'COMPLETED', txHash: h });
  const o = s.order;
  const w = o.fills.filter(f => f.txHash).map(f => done(f.txHash));
  const refund = o.refundTx ? done(o.refundTx) : o.refundFailed ? { status: 'FAILED', reason: o.refundFailed } : null;
  return { withdrawal: w.at(-1) || null, allWithdrawals: w, refund };
}
function view(s) {
  const o = s.order, a = o.attrs, q = s.quoteResponse.quote, inT = byAsset[s.quoteResponse.quoteRequest.originAsset], outT = byAsset[s.quoteResponse.quoteRequest.destinationAsset];
  const p = payout(s);
  const payoutStatus = s.status === 'FAILED' ? 'FAILED' : (p.withdrawal || p.refund) ? (FINAL.includes(o.fillStatus) ? 'COMPLETED' : 'IN_PROGRESS') : 'NOT_STARTED';
  const dep = String(o.deposited || '0');
  const attributes = { orderType: 'LIMIT', depositAddress: q.depositAddress, ...(s.depositMemo ? { depositMemo: s.depositMemo } : {}), depositMode: a.depositMode, depositType: a.depositType, fillStatus: o.fillStatus, payoutStatus, isPayoutStatusFinal: ['COMPLETED', 'FAILED'].includes(payoutStatus), payouts: p, depositedAmount: dep, depositedAmountFormatted: fromUnits(BigInt(dep), inT.decimals), baseAsset: a.baseAsset, quoteAsset: a.quoteAsset, quantity: a.quantity, swapView: o.swapView, side: a.side, price: String(a.price), appFees: a.appFees, recipient: a.recipient, recipientType: a.recipientType, refundTo: a.refundTo, refundType: a.refundType, estimatedWithdrawFee: '0', estimatedWithdrawFeeFormatted: '0', estimatedRefundFee: '0', estimatedRefundFeeFormatted: '0', confidentiality: a.confidentiality, timeInForce: 'GTC', deadline: a.deadline, createdAt: o.createdAt, partialFills: o.fills.map(f => ({ id: f.id, amountIn: f.amountIn, amountOut: f.amountOut, createdAt: f.at, updatedAt: f.at })) };
  return { type: 'orders', id: o.id, attributes, links: { self: `/v0/orders/${o.id}` } };
}

export const getOrder = (owner, id) => ({ data: view(owned(owner, id)[1]), meta: meta() });
export function listOrders(owner, q) {
  const fs = q.get('filter[fillStatus]')?.split(','), fin = q.get('filter[isPayoutStatusFinal]');
  const size = Math.min(100, Math.max(1, Number(q.get('page[size]') || 20)));
  let items = Object.values(db.swaps).filter(s => s.order?.owner === owner).sort((a, b) => (a.order.createdAt < b.order.createdAt ? 1 : -1)).map(view);
  if (fs) items = items.filter(v => fs.includes(v.attributes.fillStatus));
  if (fin !== null) items = items.filter(v => String(v.attributes.isPayoutStatusFinal) === fin);
  const after = q.get('page[after]');
  if (after) { const i = items.findIndex(v => v.id === after); items = i < 0 ? [] : items.slice(i + 1); }
  const page = items.slice(0, size);
  return { data: page, meta: meta(items.length > size ? { nextCursor: page.at(-1).id } : {}) };
}
export function cancelOrder(owner, id) {
  const [, s] = owned(owner, id);
  if (FINAL.includes(s.order.fillStatus)) throw new ApiError(400, 'order-rejected', 'Order rejected', `order is already ${s.order.fillStatus}`);
  s.order.cancelRequested = true; s.order.fillStatus = 'PENDING_CANCEL'; save();
  return { data: view(s), meta: meta() };
}

// worker hook
hooks.tickOrder = async (addr, s, inT, outT) => {
  const o = s.order;
  if (FINAL.includes(o.fillStatus)) return;
  const acct = s.intentsAccount || addr;
  const bal = await internals.intentsBal(acct, inT.assetId);
  if (bal > BigInt(o.deposited || 0)) { o.deposited = bal.toString(); save(); }
  const end = async (status, reason) => {
    if (bal > 0n) { await internals.refund(addr, s, inT, bal, reason, s.status === 'SUCCESS' ? 'SUCCESS' : 'REFUNDED'); const t = s.txs.findLast(x => x.label === 'refund'); if (t) o.refundTx = t.hash; }
    o.fillStatus = status; save();
  };
  if (o.cancelRequested) return end('CANCELED', 'ORDER_CANCELED');
  if (Date.now() >= new Date(o.attrs.deadline).getTime()) return end('EXPIRED', 'DEADLINE_PASSED');
  if (bal < BigInt(o.fundAmount)) return;
  if (o.fillStatus === 'AWAITING_DEPOSIT') { o.fillStatus = 'OPEN'; internals.set(s, 'PROCESSING'); }
  const p = await prices();
  const af = appFeeSplit(BigInt(o.fundAmount), s.appFees);
  const sv = o.swapView;
  let outAmt;
  if (sv.swapType === 'EXACT_INPUT') {
    const market = internals.convert(BigInt(sv.amountIn) - af.total, inT, outT, p.prices, s.feeBps);
    if (market < BigInt(sv.minAmountOut)) return; // limit not reached
    outAmt = BigInt(sv.minAmountOut); // fill at the limit; maker keeps the improvement
  } else {
    outAmt = BigInt(sv.amountOut);
    const need = internals.grossUp(internals.invert(outAmt, inT, outT, p.prices, s.feeBps), BigInt(s.appFees.reduce((x, f) => x + f.fee, 0)));
    if (need > BigInt(sv.maxAmountIn)) return;
  }
  const before = s.txs.length;
  await internals.settle(addr, s, inT, outT, bal);
  const tx = s.txs.slice(before).find(t => t.label.startsWith('swap'));
  if (s.status === 'SUCCESS' && tx) { o.fills.push({ id: 'fill_' + crypto.randomBytes(6).toString('hex'), amountIn: (s.amountIn || o.fundAmount).toString(), amountOut: outAmt.toString(), at: new Date().toISOString(), txHash: tx.hash }); const r = s.txs.slice(before).find(t => t.label === 'refund'); if (r) o.refundTx = r.hash; o.fillStatus = 'FILLED'; save(); }
};
