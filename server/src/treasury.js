// Admin treasury snapshot: spendable balances for every account Tidepool pays or funds from.
// Fetched on the server with a short cache so /admin does not hammer RPCs. Never logs secrets or RPC URLs.
import {
  ROOT, MAKER, VERIFIER, TOKENS, ONDO_TOKENS, EVM_CHAINS,
  SOL_CHAIN, STELLAR_CHAIN, SUI_CHAIN, BTC_CHAIN, ZEC_CHAIN, XRP_CHAIN,
  ETH_CAP_WEI, ETH_RESERVE_WEI, SOL_PAYOUT_CAP_LAMPORTS, SOL_RENT_MIN_LAMPORTS,
  XLM_CAP_STROOPS, SUI_CAP_MIST, XRP_CAP_DROPS, XRP_RESERVE_DROPS,
  BTC_CAP_SATS, ZEC_CAP_ZAT, STELLAR_DECIMALS, SUI_DECIMALS, XRP_DECIMALS,
  toUnits, fromUnits, chainOf,
} from './config.mjs';
import { view, viewAccount, accountUrl as nearAccountUrl } from './near.mjs';
import * as evm from './evm.mjs';
import * as sol from './solana.mjs';
import * as stellar from './stellar.mjs';
import * as sui from './sui.mjs';
import * as xrp from './xrp.mjs';
import * as btc from './btc.mjs';
import * as zec from './zec.mjs';

export const HEADROOM = 10; // "low" = fewer than about this many faucet claims or max-size payouts
export const CACHE_MS = 60_000;
export const NEAR_LOW_YOCTO = 2n * 10n ** 24n; // 2 spendable NEAR, same default as the verifier storage warning
export const EVM_GAS_LOW_WEI = 20_000_000_000_000_000n; // 0.02 ETH/tBNB when the chain has no native payout cap
export const FAUCET_SOURCES = ['tidepool-f1.testnet', 'tidepool-f2.testnet', 'tidepool-f3.testnet', 'tidepool-f4.testnet'];
const NEAR_CONCURRENCY = 3;
const STATUS_RANK = { empty: 0, error: 1, low: 2, ok: 3 };

export const scrubError = (e) => String(e?.message || e).replace(/https?:\/\/\S+/gi, '[rpc]').replace(/\s+/g, ' ').trim().slice(0, 160);

export function spendableNearYocto(acct) {
  if (!acct) return 0n;
  const amount = BigInt(acct.amount || 0);
  const stake = BigInt(acct.storage_usage || 0) * 10n ** 19n; // 0.00001 NEAR per byte
  return amount > stake ? amount - stake : 0n;
}

export function thresholdUnits({ drip = 0n, cap = 0n, reserve = 0n, floor = 0n } = {}) {
  const parts = [];
  if (drip > 0n) parts.push(drip * BigInt(HEADROOM));
  if (cap > 0n) parts.push(cap * BigInt(HEADROOM) + reserve);
  if (floor > 0n) parts.push(floor);
  return parts.length ? parts.reduce((a, b) => (a > b ? a : b)) : 0n;
}

export function statusOf(balance, threshold, { error } = {}) {
  if (error) return 'error';
  if (balance === null || balance === undefined) return 'error';
  if (balance <= 0n) return 'empty';
  if (threshold > 0n && balance < threshold) return 'low';
  return 'ok';
}

export function shortAddr(addr) {
  const s = String(addr || '');
  if (s.length <= 16) return s;
  if (/^0x[0-9a-fA-F]+$/.test(s)) return `${s.slice(0, 6)}…${s.slice(-4)}`;
  if (s.length <= 24) return s;
  return `${s.slice(0, 10)}…${s.slice(-6)}`;
}

export function addressExplorer(chainKey, addr) {
  if (!addr) return null;
  if (chainKey === 'near' || !chainKey) return nearAccountUrl(addr);
  if (chainKey === 'sol') return sol.addrUrl(addr);
  if (chainKey === 'stellar') return stellar.accountUrl(addr);
  if (chainKey === 'sui') return sui.addrUrl(addr);
  if (chainKey === 'btc') return btc.addrUrl(addr);
  if (chainKey === 'zec') return zec.addrUrl(addr);
  if (chainKey === 'xrp') return xrp.accountUrl(addr);
  const c = chainOf(chainKey);
  return c?.explorer ? `${c.explorer}/address/${addr}` : null;
}

export function sortRows(rows) {
  return [...rows].sort((a, b) => (STATUS_RANK[a.status] ?? 9) - (STATUS_RANK[b.status] ?? 9)
    || String(a.chainName || a.chain).localeCompare(String(b.chainName || b.chain))
    || String(a.role).localeCompare(String(b.role))
    || String(a.token).localeCompare(String(b.token))
    || String(a.kind).localeCompare(String(b.kind)));
}

export function rowOf({ chain, chainName, account, role, token, kind, decimals, balance, threshold, error, assetId }) {
  const status = statusOf(error ? null : balance, threshold || 0n, { error });
  return {
    chain, chainName, account, accountShort: shortAddr(account), explorer: addressExplorer(chain, account),
    role, token, kind, assetId: assetId || null,
    balance: error || balance == null ? null : fromUnits(balance, decimals),
    balanceRaw: error || balance == null ? null : String(balance),
    threshold: fromUnits(threshold || 0n, decimals),
    thresholdRaw: String(threshold || 0n),
    status,
    error: error ? scrubError(error) : null,
  };
}

function tokenCap(t) {
  if (!t) return 0n;
  if (t.native && t.kind === 'evm') return ETH_CAP_WEI;
  if (t.symbol === 'SOL' && t.native) return SOL_PAYOUT_CAP_LAMPORTS;
  if (t.symbol === 'XLM' && t.native) return XLM_CAP_STROOPS;
  if (t.symbol === 'SUI' && t.native) return SUI_CAP_MIST;
  if (t.symbol === 'XRP' && t.native) return XRP_CAP_DROPS;
  if (t.symbol === 'BTC' && t.native) return BTC_CAP_SATS;
  if (t.symbol === 'ZEC' && t.native) return ZEC_CAP_ZAT;
  return 0n;
}

function tokenReserve(t) {
  if (t?.native && t.kind === 'evm') return ETH_RESERVE_WEI;
  if (t?.symbol === 'XRP' && t.native) return XRP_RESERVE_DROPS;
  return 0n;
}

function tokenDrip(t) {
  if (!t?.drip || t.drip === '0') return 0n;
  return toUnits(t.drip, t.decimals);
}

function mintedOnDemand(t) {
  // Sui test coins and Solana SPL: faucet and payouts mint; a low treasury balance is not a stock-out.
  return Boolean(t && !t.native && (t.kind === 'sui' || t.kind === 'sol'));
}

function tokenThreshold(t, extra = {}) {
  if (mintedOnDemand(t)) return thresholdUnits(extra);
  return thresholdUnits({ drip: tokenDrip(t), cap: tokenCap(t), reserve: tokenReserve(t), ...extra });
}

async function mapLimit(items, n, fn) {
  const out = new Array(items.length);
  let i = 0;
  const worker = async () => {
    while (i < items.length) {
      const idx = i++;
      out[idx] = await fn(items[idx], idx);
    }
  };
  await Promise.all(Array.from({ length: Math.min(n, items.length) || 1 }, worker));
  return out;
}

async function nearRows() {
  const rows = [];
  const accounts = [
    { id: ROOT, role: 'root' },
    { id: MAKER, role: 'maker' },
    { id: VERIFIER, role: 'verifier' },
    ...FAUCET_SOURCES.map((id) => ({ id, role: 'faucet source' })),
  ];
  const infos = await mapLimit(accounts, NEAR_CONCURRENCY, async (a) => {
    try { return { ...a, acct: await viewAccount(a.id) }; }
    catch (e) { return { ...a, acct: null, error: e }; }
  });
  for (const a of infos) {
    if (!a.acct && !a.error && a.role === 'faucet source') continue; // deleted bootstrap funders
    if (!a.acct && a.error) {
      rows.push(rowOf({ chain: 'near', chainName: 'NEAR Testnet', account: a.id, role: a.role, token: 'NEAR', kind: 'native', decimals: 24, threshold: NEAR_LOW_YOCTO, error: a.error }));
      continue;
    }
    if (!a.acct) {
      rows.push(rowOf({ chain: 'near', chainName: 'NEAR Testnet', account: a.id, role: a.role, token: 'NEAR', kind: 'native', decimals: 24, balance: 0n, threshold: NEAR_LOW_YOCTO }));
      continue;
    }
    rows.push(rowOf({ chain: 'near', chainName: 'NEAR Testnet', account: a.id, role: a.role, token: 'NEAR', kind: 'native', decimals: 24, balance: spendableNearYocto(a.acct), threshold: NEAR_LOW_YOCTO }));
  }

  // Wallet-faucet mints from root; swap/intents inventory lives in the verifier as MT, so NEP-141
  // balances on maker are not an operational stock and are omitted (they are typically zero).
  const inventory = [...TOKENS, ...ONDO_TOKENS];
  try {
    const bals = await view(VERIFIER, 'mt_batch_balance_of', { account_id: MAKER, token_ids: inventory.map((t) => t.assetId) });
    inventory.forEach((t, i) => {
      rows.push(rowOf({ chain: 'near', chainName: 'NEAR Testnet', account: MAKER, role: 'maker', token: t.ondo ? `${t.symbol} (Ondo)` : (t.chain ? `${t.symbol} (${chainOf(t.chain)?.name || t.chain})` : t.symbol), kind: 'intents', decimals: t.decimals, assetId: t.assetId, balance: BigInt(bals[i] || 0), threshold: tokenThreshold(t) }));
    });
  } catch (e) {
    rows.push(rowOf({ chain: 'near', chainName: 'NEAR Testnet', account: MAKER, role: 'maker', token: 'intents inventory', kind: 'intents', decimals: 0, threshold: 0n, error: e }));
  }
  return rows;
}

async function evmRows() {
  const rows = [];
  const relayer = evm.relayerAddress();
  for (const c of EVM_CHAINS.filter((x) => x.deployed)) {
    const gasSymbol = c.key === 'bsc' ? 'tBNB' : 'ETH';
    const gasThreshold = c.nativeEth ? thresholdUnits({ cap: ETH_CAP_WEI, reserve: ETH_RESERVE_WEI }) : EVM_GAS_LOW_WEI;
    if (relayer) {
      try {
        const gas = BigInt(await evm.ethBalance(c.key, relayer));
        rows.push(rowOf({ chain: c.key, chainName: c.name, account: relayer, role: 'relayer', token: gasSymbol, kind: 'native', decimals: 18, balance: gas, threshold: gasThreshold }));
      } catch (e) {
        rows.push(rowOf({ chain: c.key, chainName: c.name, account: relayer, role: 'relayer', token: gasSymbol, kind: 'native', decimals: 18, threshold: gasThreshold, error: e }));
      }
    } else {
      rows.push(rowOf({ chain: c.key, chainName: c.name, account: 'unconfigured', role: 'relayer', token: gasSymbol, kind: 'native', decimals: 18, threshold: gasThreshold, error: 'relayer not configured' }));
    }
    if (!c.vault) continue;
    for (const t of c.tokens || []) {
      if (!t.evmAddress) continue;
      const label = t.ondo ? `${t.symbol} (Ondo)` : t.symbol;
      try {
        const bal = await evm.erc20Balance(c.key, t.evmAddress, c.vault);
        rows.push(rowOf({ chain: c.key, chainName: c.name, account: c.vault, role: 'vault', token: label, kind: 'erc20', decimals: t.decimals, assetId: t.assetId, balance: bal, threshold: tokenThreshold(t) }));
      } catch (e) {
        rows.push(rowOf({ chain: c.key, chainName: c.name, account: c.vault, role: 'vault', token: label, kind: 'erc20', decimals: t.decimals, assetId: t.assetId, threshold: tokenThreshold(t), error: e }));
      }
    }
  }
  return rows;
}

async function solRows() {
  if (!SOL_CHAIN.relayer) return [];
  const rows = [];
  const addr = SOL_CHAIN.relayer;
  const tokens = SOL_CHAIN.tokens || [];
  for (const t of tokens) {
    const extra = t.native ? { floor: SOL_RENT_MIN_LAMPORTS * BigInt(HEADROOM) } : {};
    try {
      const bal = await sol.depositBalance(t, addr);
      rows.push(rowOf({ chain: 'sol', chainName: SOL_CHAIN.name, account: addr, role: 'relayer', token: t.symbol, kind: t.native ? 'native' : 'spl', decimals: t.decimals, assetId: t.assetId, balance: bal, threshold: tokenThreshold(t, extra) }));
    } catch (e) {
      rows.push(rowOf({ chain: 'sol', chainName: SOL_CHAIN.name, account: addr, role: 'relayer', token: t.symbol, kind: t.native ? 'native' : 'spl', decimals: t.decimals, assetId: t.assetId, threshold: tokenThreshold(t, extra), error: e }));
    }
  }
  return rows;
}

async function stellarRows() {
  if (!STELLAR_CHAIN.treasury) return [];
  const addr = STELLAR_CHAIN.treasury;
  try {
    const acc = await stellar.account(addr);
    return (STELLAR_CHAIN.tokens || []).map((t) => rowOf({
      chain: 'stellar', chainName: STELLAR_CHAIN.name, account: addr, role: 'treasury', token: t.symbol,
      kind: t.native ? 'native' : 'classic', decimals: STELLAR_DECIMALS, assetId: t.assetId,
      balance: stellar.balanceOf(acc, t), threshold: tokenThreshold(t),
    }));
  } catch (e) {
    return [rowOf({ chain: 'stellar', chainName: STELLAR_CHAIN.name, account: addr, role: 'treasury', token: 'XLM', kind: 'native', decimals: STELLAR_DECIMALS, threshold: tokenThreshold(STELLAR_CHAIN.tokens?.find((t) => t.native)), error: e })];
  }
}

async function suiRows() {
  if (!SUI_CHAIN.treasury) return [];
  const addr = SUI_CHAIN.treasury;
  const rows = [];
  for (const t of SUI_CHAIN.tokens || []) {
    try {
      const bal = await sui.depositBalance(t, addr);
      rows.push(rowOf({ chain: 'sui', chainName: SUI_CHAIN.name, account: addr, role: 'treasury', token: t.symbol, kind: t.native ? 'native' : 'coin', decimals: t.decimals || SUI_DECIMALS, assetId: t.assetId, balance: bal, threshold: tokenThreshold(t) }));
    } catch (e) {
      rows.push(rowOf({ chain: 'sui', chainName: SUI_CHAIN.name, account: addr, role: 'treasury', token: t.symbol, kind: t.native ? 'native' : 'coin', decimals: t.decimals || SUI_DECIMALS, assetId: t.assetId, threshold: tokenThreshold(t), error: e }));
    }
  }
  return rows;
}

async function xrpRows() {
  if (!XRP_CHAIN.treasury) return [];
  const addr = XRP_CHAIN.treasury;
  const t = (XRP_CHAIN.tokens || [])[0];
  const threshold = tokenThreshold(t);
  try {
    const spendable = await xrp.spendable();
    if (spendable === null) return [rowOf({ chain: 'xrp', chainName: XRP_CHAIN.name, account: addr, role: 'treasury', token: 'XRP', kind: 'native', decimals: XRP_DECIMALS, assetId: t?.assetId, threshold, error: 'RPC unreachable' })];
    return [rowOf({ chain: 'xrp', chainName: XRP_CHAIN.name, account: addr, role: 'treasury', token: 'XRP', kind: 'native', decimals: XRP_DECIMALS, assetId: t?.assetId, balance: spendable, threshold })];
  } catch (e) {
    return [rowOf({ chain: 'xrp', chainName: XRP_CHAIN.name, account: addr, role: 'treasury', token: 'XRP', kind: 'native', decimals: XRP_DECIMALS, assetId: t?.assetId, threshold, error: e })];
  }
}

async function utxoRows(chain, mod) {
  if (!chain.treasury) return [];
  const t = (chain.tokens || [])[0];
  const threshold = tokenThreshold(t);
  const symbol = chain.symbol || t?.symbol;
  try {
    const bal = await mod.treasuryBalance();
    return [rowOf({ chain: chain.key, chainName: chain.name, account: chain.treasury, role: 'treasury', token: symbol, kind: 'native', decimals: 8, assetId: t?.assetId, balance: bal, threshold })];
  } catch (e) {
    return [rowOf({ chain: chain.key, chainName: chain.name, account: chain.treasury, role: 'treasury', token: symbol, kind: 'native', decimals: 8, assetId: t?.assetId, threshold, error: e })];
  }
}

export async function collectTreasury() {
  const groups = await Promise.allSettled([
    nearRows(), evmRows(), solRows(), stellarRows(), suiRows(), xrpRows(),
    utxoRows(BTC_CHAIN, btc), utxoRows(ZEC_CHAIN, zec),
  ]);
  const rows = [];
  for (const g of groups) {
    if (g.status === 'fulfilled') rows.push(...g.value);
    else rows.push(rowOf({ chain: 'near', chainName: 'Treasury', account: '-', role: 'snapshot', token: 'error', kind: 'native', decimals: 0, threshold: 0n, error: g.reason }));
  }
  const sorted = sortRows(rows);
  const count = (s) => sorted.filter((r) => r.status === s).length;
  return {
    at: new Date().toISOString(),
    cacheSeconds: CACHE_MS / 1000,
    headroom: HEADROOM,
    counts: { total: sorted.length, empty: count('empty'), low: count('low'), error: count('error'), ok: count('ok') },
    rows: sorted,
  };
}

let cache = { at: 0, value: null, inflight: null };
export function resetTreasuryCache() { cache = { at: 0, value: null, inflight: null }; }

export async function fetchTreasury({ refresh = false } = {}) {
  if (!refresh && cache.value && Date.now() - cache.at < CACHE_MS) return { ...cache.value, cached: true };
  if (cache.inflight && !refresh) {
    const value = await cache.inflight;
    return { ...value, cached: Date.now() - cache.at < CACHE_MS };
  }
  const pending = collectTreasury();
  cache.inflight = pending;
  try {
    const value = await pending;
    cache = { at: Date.now(), value, inflight: null };
    return { ...value, cached: false };
  } catch (e) {
    cache.inflight = null;
    throw e;
  }
}
