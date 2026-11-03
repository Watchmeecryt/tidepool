// Policy validation and evaluation. The policy is owner-signed (via the intent flow) and enforced off-chain by this API:
// check order is frozen -> action -> asset -> destination -> per-transaction limit -> USD budget -> cumulative limits -> action rate.
import crypto from 'node:crypto';
import { TOKENS, fromUnits } from '../config.mjs';
import { sql } from './db.js';
import { fail } from './errors.js';

export const ACTIONS = ['swap', 'transfer', 'withdraw'];
export const tokenById = (id) => TOKENS.find((t) => t.assetId === id);
const AMOUNT = /^[0-9]{1,40}$/;
const USD = /^[0-9]{1,12}(\.[0-9]{1,6})?$/;
const bad = (detail, pointer) => fail(400, 'validation_failed', 'request', detail, pointer ? { pointer } : undefined);
const WINDOWS = { hourly: 3600_000, daily: 24 * 3600_000, monthly: 30 * 24 * 3600_000 };
const PERIODS = { daily_usd: 24 * 3600_000, weekly_usd: 7 * 24 * 3600_000, monthly_usd: 30 * 24 * 3600_000 };

/** Validates and normalizes a complete policy. Fields this testnet service does not implement must stay at their off values. */
export function validatePolicy(p) {
  if (!p || typeof p !== 'object' || Array.isArray(p)) throw bad('policy must be an object', '/policy');
  if (typeof p.frozen !== 'boolean') throw bad('policy.frozen must be a boolean', '/policy/frozen');
  if (!Array.isArray(p.actions) || p.actions.some((a) => !ACTIONS.includes(a))) throw bad(`policy.actions must be an array of ${ACTIONS.join(' | ')}`, '/policy/actions');
  if (p.confidential !== undefined && p.confidential !== false) throw bad('confidential mode is not available on Tidepool: set policy.confidential to false', '/policy/confidential');
  if (p.owner_approval !== undefined && p.owner_approval !== false) throw bad('owner_approval is not available on Tidepool: set policy.owner_approval to false', '/policy/owner_approval');
  if (p.assets !== 'any' && (!Array.isArray(p.assets) || p.assets.some((a) => !tokenById(a)))) throw bad('policy.assets must be "any" or a list of asset ids from GET /v1/tokens', '/policy/assets');
  const limits = {};
  for (const [kind, per] of Object.entries(p.limits || {})) {
    if (!['per_transaction', 'hourly', 'daily', 'monthly'].includes(kind)) throw bad(`unknown limit "${kind}"`, `/policy/limits/${kind}`);
    if (!per || typeof per !== 'object') throw bad(`limits.${kind} must map asset id -> atomic amount`, `/policy/limits/${kind}`);
    for (const [asset, v] of Object.entries(per)) {
      if (!tokenById(asset)) throw bad(`unknown asset "${asset}" in limits.${kind}`, `/policy/limits/${kind}`);
      if (typeof v !== 'string' || !AMOUNT.test(v)) throw bad(`limits.${kind}.${asset} must be an atomic amount string`, `/policy/limits/${kind}/${asset}`);
    }
    limits[kind] = { ...per };
  }
  const mah = p.max_actions_per_hour ?? null;
  if (mah !== null && !(Number.isInteger(mah) && mah >= 0)) throw bad('policy.max_actions_per_hour must be null or a non-negative integer', '/policy/max_actions_per_hour');
  const d = p.destinations;
  if (!d || !['any', 'only', 'except'].includes(d.mode) || !Array.isArray(d.list)) throw bad('policy.destinations must be { mode: "any" | "only" | "except", list: [...] }', '/policy/destinations');
  const list = d.list.map((e, i) => {
    if (e?.action === 'withdraw' && typeof e.chain === 'string' && typeof e.address === 'string') return { action: 'withdraw', chain: e.chain.toLowerCase(), address: e.address, memo: e.memo ?? null };
    if (e?.action === 'transfer' && typeof e.address === 'string') return { action: 'transfer', address: e.address, confidential: false };
    throw bad('destination entries are { action: "withdraw", chain, address, memo } or { action: "transfer", address, confidential }', `/policy/destinations/list/${i}`);
  });
  const budget = {};
  for (const k of Object.keys(PERIODS)) {
    const v = p.budget?.[k] ?? null;
    if (v !== null && !(typeof v === 'string' && USD.test(v))) throw bad(`policy.budget.${k} must be null or a USD decimal string`, `/policy/budget/${k}`);
    budget[k] = v;
  }
  if (p.timelock_ms !== undefined && p.timelock_ms !== 0) throw bad('timelock_ms is not available on Tidepool: set it to 0', '/policy/timelock_ms');
  if (p.schedule !== undefined && p.schedule !== null) throw bad('schedule is not available on Tidepool: omit it', '/policy/schedule');
  if (p.native !== undefined && p.native !== null) throw bad('native accounts are not available on Tidepool: omit policy.native', '/policy/native');
  return { frozen: p.frozen, actions: [...new Set(p.actions)], confidential: false, owner_approval: false, assets: p.assets === 'any' ? 'any' : [...new Set(p.assets)], limits, max_actions_per_hour: mah, destinations: { mode: d.mode, list }, budget, timelock_ms: 0 };
}

export const policyHash = (p) => crypto.createHash('sha256').update(JSON.stringify(p)).digest('hex');

/** Budget period bookkeeping: each cap runs in fixed periods starting when it was switched on. */
export function budgetStarts(prev, policy, now = new Date().toISOString()) {
  const out = {};
  for (const k of Object.keys(PERIODS)) if (policy.budget[k] !== null) out[k] = prev?.[k] || now;
  return out;
}
const periodStart = (startedIso, len, now = Date.now()) => { const s = Date.parse(startedIso); return s + Math.floor((now - s) / len) * len; };

export const usdValue = (token, amount, prices) => { const px = prices?.[token.assetId]; return px == null ? null : Number(fromUnits(amount, token.decimals)) * px; };

export function budgetView(agent, policy, now = Date.now()) {
  const view = {};
  for (const [k, len] of Object.entries(PERIODS)) {
    const key = k.replace('_usd', '');
    const cap = policy.budget[k];
    const started = agent.budget_started?.[k];
    if (cap === null || !started) { view[key] = { limit_usd: null, spent_usd: null, remaining_usd: null, resets_at: null }; continue; }
    const from = periodStart(started, len, now);
    const spent = sql.prepare('SELECT COALESCE(SUM(usd),0) s FROM operations WHERE agent_id = ? AND counted = 1 AND usd > 0 AND created_at >= ?').get(agent.id, new Date(from).toISOString()).s;
    view[key] = { limit_usd: cap, spent_usd: spent.toFixed(6), remaining_usd: Math.max(0, Number(cap) - spent).toFixed(6), resets_at: new Date(from + len).toISOString() };
  }
  return view;
}

const sameAddr = (a, b) => (/^0x[0-9a-fA-F]{40}$/.test(a) ? a.toLowerCase() === String(b).toLowerCase() : a === b);
const destMatches = (policy, action, dest) => policy.destinations.list.some((e) => e.action === action && sameAddr(e.address, dest.address) && (action !== 'withdraw' || (e.chain === dest.chain && (e.memo ?? null) === (dest.memo ?? null))));

/**
 * Returns the ordered list of reasons this action would be refused (empty = allowed).
 * op: { action, asset, amount (BigInt), destination?: { chain, address, memo }, usd (number|null) }
 */
export function evaluate(agent, policy, op, now = Date.now()) {
  const v = [];
  const push = (status, code, layer, detail, meta) => v.push({ status, code, layer, detail, meta });
  if (agent.frozen || policy.frozen) push(409, 'wallet_frozen', 'policy', 'The agent is frozen by its owner');
  if (!policy.actions.includes(op.action)) push(403, 'policy_action_denied', 'policy', `The policy does not allow "${op.action}"`);
  const assets = [op.asset, ...(op.action === 'swap' ? [op.destAsset] : [])].filter(Boolean);
  for (const a of assets) if (policy.assets !== 'any' && !policy.assets.includes(a)) push(403, 'policy_asset_denied', 'policy', `The policy does not allow asset ${a}`);
  if (op.destination && policy.destinations.mode !== 'any') {
    const hit = destMatches(policy, op.action, op.destination);
    if ((policy.destinations.mode === 'only' && !hit) || (policy.destinations.mode === 'except' && hit)) push(403, 'policy_destination_denied', 'policy', `The policy does not allow sending to ${op.destination.address}`);
  }
  const cap = policy.limits.per_transaction?.[op.asset];
  if (cap !== undefined && op.amount > BigInt(cap)) push(403, 'policy_transaction_limit_exceeded', 'policy', `Amount exceeds the per-transaction limit of ${cap}`, { limit: cap });
  const anyBudget = Object.values(policy.budget).some((x) => x !== null);
  if (anyBudget && op.usd === null) push(409, 'spend_price_unavailable', 'budget', 'No USD price is available for this asset, so the budget cannot be checked');
  if (anyBudget && op.usd !== null) {
    const bv = budgetView(agent, policy, now);
    for (const [key, b] of Object.entries(bv)) if (b.limit_usd !== null && Number(b.spent_usd) + op.usd > Number(b.limit_usd) + 1e-9)
      push(403, 'spend_budget_exceeded', 'budget', `This would exceed the ${key} USD budget of ${b.limit_usd} (spent ${b.spent_usd})`, { available_at: b.resets_at });
  }
  for (const [kind, ms] of Object.entries(WINDOWS)) {
    const lim = policy.limits[kind]?.[op.asset];
    if (lim === undefined) continue;
    const rows = sql.prepare("SELECT amount FROM operations WHERE agent_id = ? AND counted = 1 AND asset = ? AND type != 'deposit' AND created_at >= ?").all(agent.id, op.asset, new Date(now - ms).toISOString());
    const spent = rows.reduce((s, r) => s + BigInt(r.amount || 0), 0n);
    if (spent + op.amount > BigInt(lim)) push(403, 'policy_limit_exceeded', 'policy', `Amount would exceed the ${kind} limit of ${lim} (already used ${spent})`, { limit: lim });
  }
  if (policy.max_actions_per_hour !== null) {
    const n = sql.prepare("SELECT COUNT(*) n FROM operations WHERE agent_id = ? AND counted = 1 AND type != 'deposit' AND created_at >= ?").get(agent.id, new Date(now - 3600_000).toISOString()).n;
    if (n + 1 > policy.max_actions_per_hour) push(403, 'policy_action_limit_exceeded', 'policy', `The policy allows ${policy.max_actions_per_hour} actions per hour`);
  }
  return v;
}
