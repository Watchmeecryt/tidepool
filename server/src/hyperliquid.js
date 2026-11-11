// Hyperliquid testnet (HyperCore) payouts and deposits. The existing EVM relayer
// key signs a gasless EIP-712 usdSend so USDC lands in the recipient's perps balance.
// Never logs keys or API URLs.
import { ethers } from 'ethers';
import { HYPERCORE_CHAIN } from './config.mjs';
import { exclusive } from './guard.mjs';

const INFO = 'https://api.hyperliquid-testnet.xyz/info';
const EXCHANGE = 'https://api.hyperliquid-testnet.xyz/exchange';
const SIG_CHAIN_ID = '0x66eee';
const DOMAIN = {
  name: 'HyperliquidSignTransaction',
  version: '1',
  chainId: 0x66eee,
  verifyingContract: '0x0000000000000000000000000000000000000000',
};
const USD_SEND_TYPES = {
  'HyperliquidTransaction:UsdSend': [
    { name: 'hyperliquidChain', type: 'string' },
    { name: 'destination', type: 'string' },
    { name: 'amount', type: 'string' },
    { name: 'time', type: 'uint64' },
  ],
};

const KEY = process.env.TIDEPOOL_EVM_RELAYER_KEY;
export const treasuryAddress = () => (KEY ? new ethers.Wallet(KEY).address : null);
export const relayerConfigured = () => {
  const addr = treasuryAddress();
  return Boolean(addr && HYPERCORE_CHAIN.treasury && addr.toLowerCase() === String(HYPERCORE_CHAIN.treasury).toLowerCase());
};

export function formatUsd(units) {
  const n = BigInt(units);
  const sign = n < 0n ? '-' : '';
  const a = n < 0n ? -n : n;
  const whole = a / 1_000_000n;
  const frac = (a % 1_000_000n).toString().padStart(6, '0').replace(/0+$/, '');
  return `${sign}${whole}${frac ? `.${frac}` : ''}`;
}
export function parseUsd(s) {
  const t = String(s ?? '').trim();
  if (!/^-?\d+(\.\d+)?$/.test(t)) return 0n;
  const neg = t.startsWith('-');
  const [w, f = ''] = (neg ? t.slice(1) : t).split('.');
  const frac = (f + '000000').slice(0, 6);
  const v = BigInt(w) * 1_000_000n + BigInt(frac);
  return neg ? -v : v;
}

async function post(url, body) {
  const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`Hyperliquid request failed (HTTP ${r.status})`);
  return data;
}

export async function withdrawable(addr = treasuryAddress()) {
  if (!addr) return null;
  const st = await post(INFO, { type: 'clearinghouseState', user: ethers.getAddress(addr) });
  return parseUsd(st?.withdrawable ?? '0');
}
export const treasuryBalance = () => withdrawable();

export const addrUrl = (a) => `${HYPERCORE_CHAIN.explorer}/explorer/address/${a}`;
export const txUrl = (h) => `${HYPERCORE_CHAIN.explorer}/explorer/${h}`;

export function typedData(destination, amount, time) {
  return {
    domain: DOMAIN,
    types: USD_SEND_TYPES,
    primaryType: 'HyperliquidTransaction:UsdSend',
    message: { hyperliquidChain: 'Testnet', destination, amount, time },
  };
}

export async function signUsdSend(wallet, to, amountUnits, time = Date.now()) {
  const destination = ethers.getAddress(to);
  const amount = formatUsd(amountUnits);
  const raw = await wallet.signTypedData(DOMAIN, USD_SEND_TYPES, { hyperliquidChain: 'Testnet', destination, amount, time });
  const sig = ethers.Signature.from(raw);
  const action = { type: 'usdSend', hyperliquidChain: 'Testnet', signatureChainId: SIG_CHAIN_ID, destination, amount, time };
  return { action, nonce: time, signature: { r: sig.r, s: sig.s, v: sig.v }, time, destination, amount };
}

const CLASS_TYPES = {
  'HyperliquidTransaction:UsdClassTransfer': [
    { name: 'hyperliquidChain', type: 'string' },
    { name: 'amount', type: 'string' },
    { name: 'toPerp', type: 'bool' },
    { name: 'nonce', type: 'uint64' },
  ],
};
// Spot -> perps move inside one account (deposits sent from the Hyperliquid UI land in spot).
export async function signUsdClassTransfer(wallet, amountUnits, toPerp = true, time = Date.now()) {
  const amount = formatUsd(amountUnits);
  const raw = await wallet.signTypedData(DOMAIN, CLASS_TYPES, { hyperliquidChain: 'Testnet', amount, toPerp, nonce: time });
  const sig = ethers.Signature.from(raw);
  const action = { type: 'usdClassTransfer', hyperliquidChain: 'Testnet', signatureChainId: SIG_CHAIN_ID, amount, toPerp, nonce: time };
  return { action, nonce: time, signature: { r: sig.r, s: sig.s, v: sig.v }, time, amount };
}

// ---- deposits: a per-quote HyperCore address (the same derived EOA as native EVM deposits) ----
export async function spotUsdc(addr) {
  const st = await post(INFO, { type: 'spotClearinghouseState', user: ethers.getAddress(addr) });
  const b = (st?.balances || []).find(x => x.coin === 'USDC');
  return b ? parseUsd(b.total) - parseUsd(b.hold || '0') : 0n;
}
export async function depositBalances(addr) {
  const [perps, spot] = await Promise.all([withdrawable(addr), spotUsdc(addr)]);
  return { perps: perps || 0n, spot: spot > 0n ? spot : 0n };
}
// Incoming USDC transfers (usdSend or spot send) to addr, newest last: [{ hash, amount, from, time }].
export async function incoming(addr, startTime = 0) {
  const a = String(addr).toLowerCase();
  const rows = await post(INFO, { type: 'userNonFundingLedgerUpdates', user: ethers.getAddress(addr), startTime });
  return (Array.isArray(rows) ? rows : []).filter(r => ['send', 'internalTransfer', 'spotTransfer'].includes(r.delta?.type) && String(r.delta.destination || '').toLowerCase() === a && (r.delta.token ?? 'USDC') === 'USDC')
    .map(r => ({ hash: r.hash, amount: parseUsd(r.delta.amount ?? r.delta.usdc ?? '0'), from: r.delta.user, time: r.time }));
}
export const sweepClass = (wallet, amountUnits) => signUsdClassTransfer(wallet, amountUnits, true);
export function sweepSend(wallet, amountUnits) {
  if (!HYPERCORE_CHAIN.treasury) throw new Error('Hyperliquid treasury is not configured');
  return signUsdSend(wallet, HYPERCORE_CHAIN.treasury, amountUnits);
}

export function prepare(to, amountUnits) {
  if (!KEY) throw new Error('Hyperliquid treasury is not configured');
  return signUsdSend(new ethers.Wallet(KEY), to, amountUnits);
}

function alreadyApplied(msg) {
  return /duplicate|already|nonce/i.test(String(msg || ''));
}

export async function submit(signed) {
  const body = await post(EXCHANGE, { action: signed.action, nonce: signed.nonce, signature: signed.signature });
  if (body.status === 'ok') return body;
  const msg = body.response || body.message || JSON.stringify(body);
  if (alreadyApplied(msg)) return { status: 'ok', response: msg };
  throw new Error(String(msg).slice(0, 200));
}

async function step(rec, build, persist) {
  if (rec.hash && rec.status === 'ok') return 'confirmed';
  if (!rec.action) {
    Object.assign(rec, await build());
    persist();
  }
  try {
    await submit(rec);
    rec.status = 'ok';
    rec.hash = String(rec.time || rec.nonce);
    persist();
    return 'confirmed';
  } catch (e) {
    const msg = String(e.message || e);
    if (alreadyApplied(msg) && rec.time) {
      rec.status = 'ok'; rec.hash = String(rec.time); persist(); return 'confirmed';
    }
    if (/insufficient|not enough/i.test(msg)) throw e;
    rec.lastError = msg.slice(0, 160);
    persist();
    return 'pending';
  }
}

export const drive = (rec, build, persist) => exclusive(rec, () => step(rec, build, persist));

export async function hypercoreHealth() {
  const addr = HYPERCORE_CHAIN.treasury || treasuryAddress();
  if (!addr) return { ok: false, name: HYPERCORE_CHAIN.name, configured: false };
  try {
    const bal = await withdrawable(addr);
    return { ok: relayerConfigured() && bal !== null, name: HYPERCORE_CHAIN.name, treasury: addr, usdc: bal == null ? null : formatUsd(bal), configured: relayerConfigured() };
  } catch (e) {
    return { ok: false, name: HYPERCORE_CHAIN.name, treasury: addr, configured: relayerConfigured(), error: 'unreachable' };
  }
}
