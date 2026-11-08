// Agent actions: swap, transfer, withdraw, deposit (+ dry runs), balances, history and execution status.
// Pipeline: grant -> idempotency -> validation -> policy -> wallet lock -> balance -> record -> 202 -> settle on NEAR testnet.
import crypto from 'node:crypto';
import { internals, feeBps, makerBalance, withSigner } from '../engine.mjs';
import { signIntents, keyStore, NETWORK, view, call, parseNear, viewAccount } from '../near.mjs';
import { TOKENS, VERIFIER, MAKER, ROOT, BRIDGE_ACCOUNT, ETH_CAP_WEI, EVM_CHAINS, fromUnits, isEvmAddress, isSolAddress, isStellarAddress, isSuiAddress, normSuiAddress, isXrpAddress, isBtcAddress, isZecAddress, chainOf,
  SOL_PAYOUT_CAP_LAMPORTS, SOL_RENT_MIN_LAMPORTS, XLM_CAP_STROOPS, SUI_CAP_MIST, XRP_CAP_DROPS, BTC_CAP_SATS, BTC_MIN_SATS, ZEC_CAP_ZAT, ZEC_MIN_ZAT } from '../config.mjs';
import * as evm from '../evm.mjs';
import { prices } from '../prices.mjs';
import { drip, nearDripCheck } from '../faucet.mjs';
import { sql } from './db.js';
import { fail } from './errors.js';
import { agentWallet, walletView } from './agents.js';
import { budgetView, evaluate, tokenById, usdValue } from './policy.js';
import { sha256 } from './partner-keys.js';

const bad = (detail, pointer) => fail(400, 'validation_failed', 'request', detail, pointer ? { pointer } : undefined);
const nid = () => `exec_${crypto.randomBytes(12).toString('hex')}`;
const busy = new Set();
const ATOMIC = /^[1-9]\d{0,38}$/;
const isImplicit = (s) => /^[0-9a-f]{64}$/.test(s);
const ACCOUNT = /^(([a-z\d]+[-_])*[a-z\d]+\.)*([a-z\d]+[-_])*[a-z\d]+$/;
export const KINDS = ['swap', 'transfer', 'withdraw', 'deposit'];

export async function tokenList() {
  const p = await prices(), at = new Date(p.at || Date.now()).toISOString(), exp = new Date((p.at || Date.now()) + 60_000).toISOString();
  return TOKENS.map((t) => ({ asset_id: t.assetId, symbol: t.symbol, decimals: t.decimals, blockchain: t.blockchain, price: p.prices[t.assetId] ?? null, price_updated_at: at, price_expires_at: exp }));
}

export function requireGrant(agent, token) {
  if (!token) throw fail(401, 'grant_required', 'grant', 'This call needs an agent grant: send the ngt_ token in the x-grant-token header (issue one with a grant_issue owner intent)');
  const g = sql.prepare('SELECT * FROM grants WHERE credential = ? AND agent_id = ?').get(sha256(String(token)), agent.id);
  if (!g) throw fail(403, 'grant_invalid', 'grant', 'This grant token is not valid for this agent');
  if (g.revoked_at) throw fail(403, 'grant_revoked', 'grant', 'This grant was revoked by the owner');
  if (Date.parse(g.expires_at) <= Date.now()) throw fail(403, 'grant_expired', 'grant', 'This grant has expired');
  return g;
}

const asset = (id, field) => {
  const t = typeof id === 'string' && tokenById(id);
  if (!t) throw fail(400, 'unsupported_token', 'request', `Unknown asset ${id}. List supported assets with GET /v1/tokens`, { pointer: `/${field}` });
  return t;
};
const amountOf = (v, field = 'amount') => {
  if (typeof v !== 'string' || !ATOMIC.test(v)) throw bad(`${field} must be a positive integer string in the asset's smallest unit`, `/${field}`);
  return BigInt(v);
};
async function recipientOf(r) {
  if (typeof r !== 'string' || !r) throw bad('recipient is required', '/recipient');
  if (isImplicit(r)) return r;
  if (!ACCOUNT.test(r) || r.length < 2 || r.length > 64) throw fail(400, 'invalid_address', 'request', `${r} is not a valid NEAR account id`, { pointer: '/recipient' });
  if (!(await viewAccount(r))) throw fail(400, 'invalid_address', 'request', `NEAR testnet account ${r} does not exist`, { pointer: '/recipient' });
  return r;
}

// Non-EVM payout chains Tidepool's /v0 already supports (testnets only): address check, native symbol, per-payout cap and minimum (same limits as /v0).
const OTHER = {
  sol: { ok: isSolAddress, native: 'SOL', cap: SOL_PAYOUT_CAP_LAMPORTS, min: SOL_RENT_MIN_LAMPORTS },
  stellar: { ok: isStellarAddress, native: 'XLM', cap: XLM_CAP_STROOPS },
  sui: { ok: isSuiAddress, native: 'SUI', cap: SUI_CAP_MIST },
  xrp: { ok: isXrpAddress, native: 'XRP', cap: XRP_CAP_DROPS },
  btc: { ok: isBtcAddress, native: 'BTC', cap: BTC_CAP_SATS, min: BTC_MIN_SATS },
  zec: { ok: isZecAddress, native: 'ZEC', cap: ZEC_CAP_ZAT, min: ZEC_MIN_ZAT },
};
async function normalize(kind, body, agent) {
  if (!body || typeof body !== 'object') throw bad('body must be a JSON object');
  if (body.confidential) throw fail(400, 'unsupported_feature', 'request', 'Confidential mode is not available on Tidepool testnet', { pointer: '/confidential' });
  const p = await prices();
  if (kind === 'swap') {
    const inT = asset(body.origin_asset, 'origin_asset'), outT = asset(body.destination_asset, 'destination_asset');
    if (inT.assetId === outT.assetId) throw bad('origin_asset and destination_asset must differ', '/destination_asset');
    const amount = amountOf(body.amount);
    const minOut = body.min_amount_out === undefined ? null : amountOf(body.min_amount_out, 'min_amount_out');
    if (!p.prices[inT.assetId] || !p.prices[outT.assetId]) throw fail(503, 'route_unavailable', 'provider', 'No price is available for this pair right now');
    const fee = feeBps(inT, outT, true), out = internals.convert(amount, inT, outT, p.prices, fee);
    if (out <= 0n) throw fail(400, 'amount_too_low', 'request', 'Amount is too small to produce any output', { min_amount: undefined });
    return { kind, asset: inT.assetId, amount, token: inT, outT, out, fee, minOut, prices: p.prices, usd: usdValue(inT, amount, p.prices),
      request: { origin_asset: inT.assetId, destination_asset: outT.assetId, asset: inT.assetId, amount: amount.toString(), min_amount_out: minOut?.toString() ?? null, chain: 'near', recipient: null, memo: null, confidential: false } };
  }
  if (kind === 'transfer' || kind === 'withdraw') {
    const t = asset(body.asset, 'asset'), amount = amountOf(body.amount);
    let chain = 'near', memo = null, recipient;
    if (kind === 'withdraw') {
      chain = String(body.chain ?? '').toLowerCase();
      const evmChain = EVM_CHAINS.find((c) => c.key === chain && c.deployed);
      if (chain === 'near') {
        if (t.chain) throw fail(400, 'route_unavailable', 'request', `${t.symbol} (${t.blockchain}) is a bridged asset; ${t.kind === 'evm' ? `withdraw it with chain "${t.chain}" to an EVM address, or ` : ''}withdraw a NEAR-native test token with chain "near"`, { pointer: '/asset' });
        recipient = await recipientOf(body.recipient);
        if (body.memo !== undefined && body.memo !== null) { if (typeof body.memo !== 'string' || body.memo.length > 128) throw bad('memo must be a string of at most 128 characters', '/memo'); memo = body.memo; }
      } else if (evmChain) {
        if (t.chain !== chain) throw fail(400, 'route_unavailable', 'request', `${t.symbol} (${t.blockchain}) cannot be withdrawn to ${evmChain.name}; use the bridged token whose blockchain is "${chain}" (see GET /v1/tokens)`, { pointer: '/asset' });
        if (!isEvmAddress(body.recipient)) throw fail(400, 'invalid_address', 'request', `${body.recipient} is not a valid 0x EVM address`, { pointer: '/recipient' });
        recipient = body.recipient;
        if (body.memo) throw bad('memo is not supported for EVM withdrawals', '/memo');
        if (t.native) { // native ETH: same cap and treasury floor as /v0
          if (amount > ETH_CAP_WEI) throw fail(400, 'route_unavailable', 'request', `ETH on ${evmChain.name} is capped at ${fromUnits(ETH_CAP_WEI, t.decimals)} ETH per payout (same limit as /v0)`, { pointer: '/amount' });
          if ((await evm.nativeShortfall(chain, amount).catch(() => 0n)) !== null) throw fail(503, 'route_unavailable', 'provider', `The ${evmChain.name} treasury is low on ETH right now; try again later or use a smaller amount`);
        }
      } else if (OTHER[chain] && chainOf(chain)?.deployed) {
        const o = OTHER[chain];
        if (t.chain !== chain) throw fail(400, 'route_unavailable', 'request', `${t.symbol} (${t.blockchain}) cannot be withdrawn to ${chainOf(chain).name}; use a token whose blockchain is "${chain}" (see GET /v1/tokens)`, { pointer: '/asset' });
        if (!o.ok(body.recipient)) throw fail(400, 'invalid_address', 'request', `${body.recipient} is not a valid ${chainOf(chain).name} address`, { pointer: '/recipient' });
        recipient = chain === 'sui' ? normSuiAddress(body.recipient) : body.recipient;
        if (body.memo) throw bad(`memo is not supported for ${chainOf(chain).name} withdrawals`, '/memo');
        if (t.symbol === o.native) {
          if (amount > o.cap) throw fail(400, 'route_unavailable', 'request', `${o.native} on ${chainOf(chain).name} is capped at ${fromUnits(o.cap, t.decimals)} ${o.native} per payout (same limit as /v0)`, { pointer: '/amount' });
          if (o.min && amount < o.min) throw fail(400, 'route_unavailable', 'request', `The minimum ${o.native} payout on ${chainOf(chain).name} is ${fromUnits(o.min, t.decimals)} ${o.native} (same limit as /v0)`, { pointer: '/amount' });
        }
      } else throw fail(400, 'route_unavailable', 'request', `Tidepool testnet withdraws to NEAR testnet accounts (chain "near") and to the testnets /v0 can pay out on (${[...EVM_CHAINS.filter((c) => c.deployed).map((c) => c.key), ...Object.keys(OTHER).filter((k) => chainOf(k)?.deployed)].map((c) => '"' + c + '"').join(', ')}). Other chains are not available.`, { pointer: '/chain' });
    } else recipient = await recipientOf(body.recipient);
    return { kind, asset: t.assetId, amount, token: t, prices: p.prices, usd: usdValue(t, amount, p.prices), destination: { chain, address: recipient, memo }, recipient,
      request: { origin_asset: null, destination_asset: null, asset: t.assetId, amount: amount.toString(), min_amount_out: null, chain, recipient, memo, confidential: false } };
  }
  const inT = asset(body.origin_asset, 'origin_asset'), outT = body.destination_asset ? asset(body.destination_asset, 'destination_asset') : inT;
  const amount = body.amount === undefined ? null : amountOf(body.amount);
  return { kind, asset: inT.assetId, amount: amount ?? 0n, token: inT, outT, prices: p.prices, usd: null, faucet: body.testnet_faucet === true,
    request: { origin_asset: inT.assetId, destination_asset: outT.assetId, asset: inT.assetId, amount: amount?.toString() ?? null, min_amount_out: null, chain: inT.blockchain, recipient: null, memo: null, confidential: false } };
}

const balanceOf = (agent, assetId) => internals.intentsBal(agent.wallet_account, assetId);
const spendOp = (n) => ({ action: n.kind, asset: n.asset, destAsset: n.outT?.assetId, amount: n.amount, destination: n.destination, usd: n.usd });

function opDoc(r, agent) {
  const d = JSON.parse(r.details_json || '{}'), req = JSON.parse(r.request_json);
  const g = r.grant_id ? sql.prepare('SELECT id, label FROM grants WHERE id = ?').get(r.grant_id) : null;
  return {
    correlation_id: r.id, agent_id: r.agent_id, status: r.status, failure_code: r.failure_code, created_at: r.created_at, updated_at: r.updated_at, dispatch_committed_at: r.dispatch_committed_at, grant: g, type: r.type,
    details: { action: r.type, request: req, near_account_id: agent.wallet_account, provider_status: d.provider_status ?? null, intent_hash: d.intent_hash ?? null, tx_hash: d.tx_hash ?? null, destination_tx_hash: d.destination_tx_hash ?? d.tx_hash ?? null, ...(d.destination_chain ? { destination_chain: d.destination_chain, destination_tx_url: d.destination_tx_url ?? null } : {}),
      amount_out: d.amount_out ?? null, expected_amount_out: d.expected_amount_out ?? null, deposit_address: d.deposit_address ?? null, memo: null, min_amount: null, expires_at: d.expires_at ?? null, refund_to: null, failure_reason: r.failure_detail ?? null,
      ...(d.instructions ? { instructions: d.instructions } : {}) },
  };
}

export async function dryRun(agent, kind, body) {
  const n = await normalize(kind, body, agent), warnings = [];
  for (const v of evaluate(agent, agent.policy, spendOp(n))) warnings.push({ code: v.code, detail: v.detail, ...(v.meta?.available_at ? { available_at: v.meta.available_at } : {}) });
  const bal = await balanceOf(agent, n.asset);
  if (bal < n.amount) warnings.push({ code: 'insufficient_balance', detail: `The wallet holds ${bal} of ${n.asset}, needs ${n.amount}`, available_amount: bal.toString() });
  const feeUsd = n.usd != null && kind === 'swap' ? (n.usd * n.fee) / 10000 : 0;
  const quote = kind === 'swap'
    ? { origin_asset: n.asset, destination_asset: n.outT.assetId, amount_in: n.amount.toString(), amount_out: n.out.toString(), min_amount_out: n.minOut?.toString() ?? n.out.toString(), fee_bps: n.fee, price_in_usd: n.prices[n.asset], price_out_usd: n.prices[n.outT.assetId], expires_at: new Date(Date.now() + 60_000).toISOString() }
    : { asset: n.asset, amount: n.amount.toString(), chain: n.request.chain, recipient: n.request.recipient, network_fee: '0' };
  if (kind === 'swap' && n.minOut !== null && n.out < n.minOut) warnings.push({ code: 'min_amount_out_not_met', detail: `The quote returns ${n.out}, below min_amount_out ${n.minOut}` });
  return { dry: true, type: kind, quote, spend: { amount_usd: n.usd, budget: budgetView(agent, agent.policy) }, owner_approval: false, fee: { amount_usd: feeUsd, percent: kind === 'swap' ? n.fee / 100 : 0 }, warnings };
}

export async function runAction(agent, grant, kind, body, idemKey, ip) {
  if (!idemKey) throw fail(400, 'idempotency_key_required', 'request', 'Send an Idempotency-Key header (any unique string, 8-128 chars). Retries with the same key and body return the original result.');
  if (!/^[\w.:-]{8,128}$/.test(idemKey)) throw bad('Idempotency-Key must be 8-128 characters of [A-Za-z0-9_.:-]');
  const reqHash = sha256(JSON.stringify(body ?? null));
  const prev = sql.prepare('SELECT * FROM operations WHERE agent_id = ? AND grant_id = ? AND idem_key = ?').get(agent.id, grant.id, idemKey);
  if (prev) {
    if (prev.req_hash !== reqHash) throw fail(409, 'idempotency_conflict', 'request', 'This Idempotency-Key was already used with a different request body');
    return opDoc(prev, agent);
  }
  const n = await normalize(kind, body, agent);
  if (busy.has(agent.id)) throw fail(409, 'wallet_busy', 'api', 'Another action on this agent is still running. Retry in a few seconds.');
  busy.add(agent.id);
  let started = false;
  try {
    if (kind !== 'deposit') {
      const v = evaluate(agent, agent.policy, spendOp(n))[0];
      if (v) throw fail(v.status, v.code, v.layer, v.detail, v.meta);
      const bal = await balanceOf(agent, n.asset);
      if (bal < n.amount) throw fail(409, 'insufficient_balance', 'balance', `The wallet holds ${bal} of ${n.asset} and needs ${n.amount}. Fund it with a deposit.`, { available_amount: bal.toString() });
      if (kind === 'swap') {
        if (n.minOut !== null && n.out < n.minOut) throw fail(409, 'min_amount_out_not_met', 'provider', `The current quote returns ${n.out}, below min_amount_out ${n.minOut}`);
        if ((await makerBalance(n.outT.assetId)) < n.out) throw fail(503, 'route_unavailable', 'provider', `The testnet market maker has no ${n.outT.symbol} inventory for this size right now`);
      }
    }
    if (kind === 'deposit' && n.faucet) {
      throw fail(403, 'site_only', 'provider', 'testnet_faucet is not available via the API. Claim test tokens manually on the site faucet page: https://app.usetidepool.tech/faucet');
      try { nearDripCheck(agentWallet(agent.id).accountId, ip); } catch (e) { sql.prepare('INSERT INTO faucet_rejects (agent_id, wallet_account, reason, created_at) VALUES (?,?,?,?)').run(agent.id, agent.wallet_account, String(e.message).slice(0, 200), new Date().toISOString()); throw fail(429, 'rate_limited', 'provider', e.message, { retry_after_seconds: e.extra?.available_at ? Math.max(1, Math.ceil((Date.parse(e.extra.available_at) - Date.now()) / 1000)) : 3600 }); }
    }
    const id = nid(), now = new Date().toISOString();
    const baseline = kind === 'deposit' && !n.faucet ? (await balanceOf(agent, n.outT.assetId)).toString() : null;
    const details = kind === 'deposit' ? { deposit_address: agent.wallet_account, baseline, asset: n.outT.assetId, expires_at: new Date(Date.now() + 86400_000).toISOString(), provider_status: n.faucet ? 'PROCESSING' : 'AWAITING_DEPOSIT', instructions: depositHelp(agent, n) } : { provider_status: 'PROCESSING', ...(kind === 'swap' ? { expected_amount_out: n.out.toString() } : {}) };
    sql.prepare('INSERT INTO operations (id, agent_id, tenant_id, grant_id, type, status, idem_key, req_hash, request_json, details_json, asset, amount, usd, counted, dispatch_committed_at, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
      .run(id, agent.id, agent.tenant_id, grant.id, kind, kind === 'deposit' && !n.faucet ? 'PENDING_DEPOSIT' : 'PROCESSING', idemKey, reqHash, JSON.stringify(n.request), JSON.stringify(details), n.asset, n.amount.toString(), n.usd ?? 0, kind === 'deposit' ? 0 : 1, now, now, now);
    if (kind === 'deposit' && !n.faucet) return opDoc(sql.prepare('SELECT * FROM operations WHERE id = ?').get(id), agent);
    started = true;
    settle(id, agent, n, ip).finally(() => busy.delete(agent.id));
    return opDoc(sql.prepare('SELECT * FROM operations WHERE id = ?').get(id), agent);
  } finally { if (!started) busy.delete(agent.id); }
}

const depositHelp = (agent, n) => n.faucet ? 'testnet_faucet: the free Tidepool faucet is crediting the default test tokens into this wallet.'
  : n.token.chain ? `Create a /v0 quote with recipientType INTENTS and recipient ${agent.wallet_account}, then send ${n.token.symbol} on ${n.token.blockchain} to the deposit address it returns.`
  : `Call ft_transfer_call on ${n.token.nearContract} with receiver_id ${VERIFIER} and msg ${agent.wallet_account}. Or pass testnet_faucet:true to get free test tokens.`;

function finish(id, status, patch = {}, failure) {
  const r = sql.prepare('SELECT * FROM operations WHERE id = ?').get(id), d = { ...JSON.parse(r.details_json || '{}'), ...patch, provider_status: status };
  const now = new Date().toISOString();
  sql.prepare('UPDATE operations SET status = ?, details_json = ?, failure_code = ?, failure_detail = ?, counted = ?, updated_at = ? WHERE id = ?')
    .run(status, JSON.stringify(d), failure?.code ?? null, failure?.detail ?? null, status === 'SUCCESS' ? r.counted : 0, now, id);
}

async function settle(id, agent, n, ip) {
  try {
    const { keyPair, accountId } = agentWallet(agent.id);
    if (n.kind === 'deposit') {
      await drip({ accountId, mode: 'intents' }, ip, { trusted: true });
      return finish(id, 'SUCCESS');
    }
    let intents;
    if (n.kind === 'swap') intents = [{ intent: 'token_diff', diff: { [n.asset]: (-n.amount).toString(), [n.outT.assetId]: n.out.toString() } }];
    else if (n.kind === 'transfer') intents = [{ intent: 'transfer', receiver_id: n.recipient, tokens: { [n.asset]: n.amount.toString() } }];
    else if (n.token.chain) { // bridged token: burn it from the verifier to the bridge account; the relayer then releases the ERC-20 on the EVM chain
      if (!(await view(n.token.nearContract, 'storage_balance_of', { account_id: BRIDGE_ACCOUNT })))
        await withSigner(ROOT, () => call(ROOT, n.token.nearContract, 'storage_deposit', { account_id: BRIDGE_ACCOUNT, registration_only: true }, { deposit: parseNear(0.00125) }));
      intents = [{ intent: 'ft_withdraw', token: n.token.nearContract, receiver_id: BRIDGE_ACCOUNT, amount: n.amount.toString(), memo: `WITHDRAW_TO:${n.recipient}` }];
    } else {
      if (!(await view(n.token.nearContract, 'storage_balance_of', { account_id: n.recipient })))
        await withSigner(ROOT, () => call(ROOT, n.token.nearContract, 'storage_deposit', { account_id: n.recipient, registration_only: true }, { deposit: parseNear(0.00125) }));
      intents = [{ intent: 'ft_withdraw', token: n.token.nearContract, receiver_id: n.recipient, amount: n.amount.toString(), ...(n.destination.memo ? { memo: n.destination.memo } : {}) }];
    }
    const signed = [signIntents({ signerId: accountId, verifier: VERIFIER, keyPair, intents })];
    if (n.kind === 'swap') signed.unshift(signIntents({ signerId: MAKER, verifier: VERIFIER, keyPair: await keyStore.getKey(NETWORK, MAKER), intents: [{ intent: 'token_diff', diff: { [n.asset]: n.amount.toString(), [n.outT.assetId]: (-n.out).toString() } }] }));
    const r = await internals.execute(signed);
    const hashes = internals.hashesFrom(r.logs || []);
    if (!r.ok) return finish(id, 'FAILED', { tx_hash: r.txHash ?? null }, { code: 'execution_failed', detail: `NEAR testnet rejected the intents: ${(r.failures || []).join('; ').slice(0, 300)}` });
    if (n.kind === 'withdraw' && n.token.chain) {
      let dest;
      try {
        if (n.token.kind === 'evm' && !n.token.native) {
          const rid = evm.releaseId(`agent-api:${id}`);
          if (!(await evm.isReleased(n.token.chain, rid))) dest = await evm.release(n.token.chain, rid, n.token.evmAddress, n.recipient, n.amount);
        } else dest = (await internals.payoutBridged(id, n.token, n.recipient, n.amount))[0];
      } catch (e) {
        return finish(id, 'NEEDS_REVIEW', { tx_hash: r.txHash ?? null }, { code: 'release_failed', detail: `The NEAR side settled but the ${n.token.chain} payout failed: ${String(e.message || e).slice(0, 200)}` });
      }
      const url = n.token.kind === 'evm' && dest ? evm.evmTxUrl(n.token.chain, dest) : null;
      return finish(id, 'SUCCESS', { tx_hash: r.txHash, intent_hash: hashes[hashes.length - 1] ?? null, destination_chain: n.token.chain, ...(dest ? { destination_tx_hash: dest, destination_tx_url: url } : {}) });
    }
    finish(id, 'SUCCESS', { tx_hash: r.txHash, intent_hash: hashes[hashes.length - 1] ?? null, ...(n.kind === 'swap' ? { amount_out: n.out.toString() } : {}) });
  } catch (e) {
    const rate = e.code === 429;
    finish(id, 'FAILED', {}, { code: rate ? 'rate_limited' : 'execution_failed', detail: String(e.message || e).slice(0, 300) });
  }
}

/** Refreshes a pending deposit by comparing the wallet balance with the one at request time. */
async function refreshDeposit(r, agent) {
  const d = JSON.parse(r.details_json);
  if (Date.now() > Date.parse(d.expires_at)) return finish(r.id, 'FAILED', {}, { code: 'deposit_expired', detail: 'No deposit arrived within 24 hours' });
  const bal = await internals.intentsBal(agent.wallet_account, d.asset);
  if (bal > BigInt(d.baseline)) finish(r.id, 'SUCCESS', { amount_out: (bal - BigInt(d.baseline)).toString() });
}

export async function operationStatus(tenantId, corr, { refresh = false, getAgent }) {
  let r = sql.prepare('SELECT * FROM operations WHERE id = ? AND tenant_id = ?').get(corr, tenantId);
  if (!r) return null;
  const agent = getAgent(r.agent_id);
  if (r.status === 'PENDING_DEPOSIT' && refresh !== 'false') { await refreshDeposit(r, agent).catch(() => {}); r = sql.prepare('SELECT * FROM operations WHERE id = ?').get(corr); }
  return opDoc(r, agent);
}

export async function balances(agent, { asset: only } = {}) {
  const list = only ? [asset(only, 'asset')] : TOKENS, p = await prices();
  const raw = await view(VERIFIER, 'mt_batch_balance_of', { account_id: agent.wallet_account, token_ids: list.map((t) => t.assetId) });
  const at = new Date(p.at || Date.now()).toISOString(), exp = new Date((p.at || Date.now()) + 60_000).toISOString();
  const rows = list.map((t, i) => ({ asset_id: t.assetId, symbol: t.symbol, decimals: t.decimals, blockchain: t.blockchain, price: p.prices[t.assetId] ?? null, price_updated_at: at, price_expires_at: exp,
    balance_raw: String(raw[i]), balance: fromUnits(raw[i], t.decimals), available_raw: String(raw[i]), available: fromUnits(raw[i], t.decimals) }));
  return { near_account_id: agent.wallet_account, source: 'intents', balances: only ? rows : rows.filter((b) => b.balance_raw !== '0') };
}

export function history(agent, { cursor, limit, include_unpaid } = {}) {
  const n = Math.min(Math.max(parseInt(limit, 10) || 50, 1), 200);
  const rows = sql.prepare(`SELECT * FROM operations WHERE agent_id = ? ${cursor ? 'AND created_at < ?' : ''} ${include_unpaid === 'true' ? '' : "AND status != 'PENDING_DEPOSIT'"} ORDER BY created_at DESC, id DESC LIMIT ?`).all(...[agent.id, ...(cursor ? [String(cursor)] : []), n + 1]);
  return { data: rows.slice(0, n).map((r) => opDoc(r, agent)), next_cursor: rows.length > n ? rows[n - 1].created_at : null };
}
export { walletView };
