// Public swap explorer (/v0/explorer/*): a read-only, public-safe view of funded swaps for /explorer.
// Every field here is already public through /v0/status or on chain (deposit address, amounts, addresses,
// explorer links). No notes, intents accounts, IPs, keys, fee internals or treasury data.
import { db } from './store.mjs';
import { usageCounts } from './admin.mjs';
import { TOKENS, ONDO_TOKENS, fromUnits, chainOf } from './config.mjs';
import { txExplorerUrl, statusPrices } from './engine.mjs';

const byAsset = Object.fromEntries([...TOKENS, ...ONDO_TOKENS].map(t => [t.assetId, t]));
export const STATUSES = ['SUCCESS', 'PROCESSING', 'KNOWN_DEPOSIT_TX', 'INCOMPLETE_DEPOSIT', 'REFUNDED', 'FAILED'];
const chainKey = (t) => t?.chain || t?.blockchain || 'near';
const chainName = (k) => k === 'near' ? 'NEAR Testnet' : chainOf(k)?.name || k;
const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };

function side(assetId, units, fallbackFmt, unitPx) {
  const t = byAsset[assetId], k = chainKey(t);
  const amount = units && t ? fromUnits(units, t.decimals) : fallbackFmt || null;
  return { assetId, symbol: t?.symbol || String(assetId).replace(/^nep141:/, '').split('.')[0], chain: k, chainName: chainName(k), amount, amountUsd: amount != null && unitPx ? (num(amount) * unitPx).toFixed(2) : null };
}
// Funded swaps only (a deposit was seen), not unpaid quotes and not simulate=STUCK/FAILED test fixtures.
const funded = (s) => s.status !== 'PENDING_DEPOSIT' && !(s.status === 'FAILED' && !s.deposited && !s.txs?.length) && !s.simulate;

export function publicSwap(key, s) {
  const qr = s.quoteResponse, q = qr.quoteRequest, qq = qr.quote || {}, px = statusPrices(s);
  const [depositAddress, depositMemo] = key.split('#');
  return {
    depositAddress, depositMemo: depositMemo || null, status: s.status, swapType: q.swapType,
    createdAt: qr.timestamp, updatedAt: s.updatedAt,
    from: side(q.originAsset, s.amountIn || s.deposited, qq.amountInFormatted, px.in),
    to: side(q.destinationAsset, s.amountOut, s.status === 'SUCCESS' ? qq.amountOutFormatted : null, px.out),
    sender: s.sender || q.refundTo || null, recipient: q.recipient || null,
    txs: (s.txs || []).map(t => ({ label: t.label || 'tx', url: txExplorerUrl(s, t.hash) })),
  };
}

let cache = { at: 0, rows: [] };
function rows() {
  if (Date.now() - cache.at > 5000) cache = { at: Date.now(), rows: Object.entries(db.swaps).filter(([, s]) => funded(s)).map(([k, s]) => publicSwap(k, s)).sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt))) };
  return cache.rows;
}

export function explorerSwaps(params) {
  const status = String(params.get('status') || '').toUpperCase(), chain = String(params.get('chain') || '').toLowerCase(), q = String(params.get('search') || '').trim().toLowerCase();
  const limit = Math.min(100, Math.max(1, parseInt(params.get('limit'), 10) || 25)), page = Math.max(1, parseInt(params.get('page'), 10) || 1);
  let list = rows();
  if (status) list = list.filter(r => r.status === status);
  if (chain) list = list.filter(r => r.from.chain === chain || r.to.chain === chain);
  if (q) list = list.filter(r => [r.depositAddress, r.sender, r.recipient, r.from.symbol, r.to.symbol, ...r.txs.map(t => t.url)].some(v => v && String(v).toLowerCase().includes(q)));
  return { data: list.slice((page - 1) * limit, page * limit), page, limit, total: list.length, totalPages: Math.max(1, Math.ceil(list.length / limit)) };
}

export function explorerStats() {
  const all = rows(), day = Date.now() - 86400_000, ok = all.filter(r => r.status === 'SUCCESS');
  const vol = (l) => l.reduce((a, r) => a + num(r.from.amountUsd), 0).toFixed(2);
  const chains = {};
  for (const r of all) for (const k of new Set([r.from.chain, r.to.chain])) chains[k] = (chains[k] || 0) + 1;
  return {
    totalSwaps: all.length, success: ok.length, refunded: all.filter(r => r.status === 'REFUNDED').length, failed: all.filter(r => r.status === 'FAILED').length,
    processing: all.filter(r => !['SUCCESS', 'REFUNDED', 'FAILED'].includes(r.status)).length,
    volumeUsd: vol(ok), swaps24h: all.filter(r => Date.parse(r.createdAt) >= day).length, volume24hUsd: vol(ok.filter(r => Date.parse(r.createdAt) >= day)),
    uniqueAddresses: new Set(all.flatMap(r => [r.sender, r.recipient]).filter(Boolean)).size,
    ...usageCounts(),
    chains: Object.entries(chains).sort((a, b) => b[1] - a[1]).map(([chain, swaps]) => ({ chain, chainName: chainName(chain), swaps })),
    note: 'Testnet only: USD values use testnet price feeds and the tokens have no value.',
  };
}

// 120 requests per minute per IP across /v0/explorer/*.
const hits = new Map();
export function explorerLimited(ip) {
  const now = Date.now(), h = (hits.get(ip) || []).filter(t => now - t < 60_000);
  h.push(now); hits.set(ip, h);
  if (hits.size > 5000) for (const [k, v] of hits) if (!v.some(t => now - t < 60_000)) hits.delete(k);
  return h.length > 120;
}
