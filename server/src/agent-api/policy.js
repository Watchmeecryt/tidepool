// Policy validation and evaluation. The policy is owner-signed (via the intent flow) and enforced off-chain by this API:
// check order is frozen -> action -> asset -> destination -> schedule -> per-transaction limit -> USD budget -> cumulative limits -> action rate.
// Budget, limits and action rate count work by the time it was dispatched (held work is charged when the timelock or approval releases it).
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

export const MAX_TIMELOCK_MS = 2_592_000_000;
const DAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];
const HHMM = /^(?:[01]\d|2[0-3]):[0-5]\d$/;
const fmts = new Map();
const toMin = (t) => (t === '24:00' ? 1440 : Number(t.slice(0, 2)) * 60 + Number(t.slice(3)));
function local(tz, ms) {
  let f = fmts.get(tz);
  if (!f) { f = new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }); fmts.set(tz, f); }
  const p = Object.fromEntries(f.formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
  return { day: p.weekday.toLowerCase().slice(0, 3), min: Number(p.hour) * 60 + Number(p.minute) };
}
/** True when money actions may run at `ms` under `schedule` (weekly windows in an IANA time zone; mode only = inside a window, except = outside every window). */
export function scheduleOpen(schedule, ms = Date.now()) {
  if (!schedule) return true;
  const { day, min } = local(schedule.time_zone, ms);
  const inside = schedule.windows.some((w) => w.days.includes(day) && min >= toMin(w.start) && min < toMin(w.end));
  return schedule.mode === 'only' ? inside : !inside;
}
/** The first time at or after `ms` when the schedule is open (minute precision), or null if it never opens within 8 days. */
export function nextOpen(schedule, ms = Date.now()) {
  if (scheduleOpen(schedule, ms)) return ms;
  for (let t = Math.ceil(ms / 60_000) * 60_000, end = ms + 8 * 86400_000; t <= end; t += 60_000) if (scheduleOpen(schedule, t)) return t;
  return null;
}
function validateSchedule(s) {
  const at = '/policy/schedule';
  if (!s || typeof s !== 'object' || !['only', 'except'].includes(s.mode)) throw bad('policy.schedule must be { mode: "only" | "except", time_zone, windows: [{ days, start, end }] }', at);
  if (typeof s.time_zone !== 'string' || !s.time_zone || s.time_zone.length > 64) throw bad('policy.schedule.time_zone must be an IANA time zone such as "Europe/Berlin"', `${at}/time_zone`);
  try { new Intl.DateTimeFormat('en-US', { timeZone: s.time_zone }); } catch { throw bad(`Unknown time zone "${s.time_zone}"`, `${at}/time_zone`); }
  if (!Array.isArray(s.windows) || s.windows.length < 1 || s.windows.length > 28) throw bad('policy.schedule.windows must list 1 to 28 windows', `${at}/windows`);
  const windows = s.windows.map((w, i) => {
    const wp = `${at}/windows/${i}`;
    if (!w || !Array.isArray(w.days) || w.days.length < 1 || w.days.length > 7 || w.days.some((d) => !DAYS.includes(d))) throw bad(`windows[${i}].days must list days from ${DAYS.join(', ')}`, `${wp}/days`);
    if (typeof w.start !== 'string' || !HHMM.test(w.start)) throw bad(`windows[${i}].start must be "HH:MM" (00:00 to 23:59)`, `${wp}/start`);
    if (typeof w.end !== 'string' || !(HHMM.test(w.end) || w.end === '24:00')) throw bad(`windows[${i}].end must be "HH:MM" (00:01 to 24:00)`, `${wp}/end`);
    if (toMin(w.end) <= toMin(w.start)) throw bad(`windows[${i}].end must be later than start on the same day (split a window that crosses midnight in two)`, `${wp}/end`);
    return { days: [...new Set(w.days)], start: w.start, end: w.end };
  });
  const out = { mode: s.mode, time_zone: s.time_zone, windows };
  if (nextOpen(out) === null) throw bad('policy.schedule never allows an action', at);
  return out;
}

/** Validates and normalizes a complete policy. Fields this testnet service does not implement must stay at their off values. */
export function validatePolicy(p) {
  if (!p || typeof p !== 'object' || Array.isArray(p)) throw bad('policy must be an object', '/policy');
  if (typeof p.frozen !== 'boolean') throw bad('policy.frozen must be a boolean', '/policy/frozen');
  if (!Array.isArray(p.actions) || p.actions.some((a) => !ACTIONS.includes(a))) throw bad(`policy.actions must be an array of ${ACTIONS.join(' | ')}`, '/policy/actions');
  if (p.confidential !== undefined && p.confidential !== false) throw bad('confidential mode is not available on Tidepool: set policy.confidential to false', '/policy/confidential');
  if (p.owner_approval !== undefined && typeof p.owner_approval !== 'boolean') throw bad('policy.owner_approval must be a boolean', '/policy/owner_approval');
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
  const timelock = p.timelock_ms ?? 0;
  if (!Number.isInteger(timelock) || timelock < 0 || timelock > MAX_TIMELOCK_MS) throw bad(`policy.timelock_ms must be an integer from 0 to ${MAX_TIMELOCK_MS} (30 days)`, '/policy/timelock_ms');
  const schedule = p.schedule === undefined || p.schedule === null ? null : validateSchedule(p.schedule);
  if (p.native !== undefined && p.native !== null) throw bad('native accounts are not available on Tidepool: omit policy.native', '/policy/native');
  return { frozen: p.frozen, actions: [...new Set(p.actions)], confidential: false, owner_approval: p.owner_approval === true, assets: p.assets === 'any' ? 'any' : [...new Set(p.assets)], limits, max_actions_per_hour: mah, destinations: { mode: d.mode, list }, budget, timelock_ms: timelock, ...(schedule ? { schedule } : {}) };
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
    const spent = sql.prepare('SELECT COALESCE(SUM(usd),0) s FROM operations WHERE agent_id = ? AND counted = 1 AND usd > 0 AND COALESCE(dispatch_committed_at, created_at) >= ?').get(agent.id, new Date(from).toISOString()).s;
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
  if (policy.schedule && !scheduleOpen(policy.schedule, now)) {
    const at = nextOpen(policy.schedule, now);
    push(403, 'policy_schedule_denied', 'policy', `The policy schedule (${policy.schedule.mode}, ${policy.schedule.time_zone}) does not allow actions now${at ? `; next allowed at ${new Date(at).toISOString()}` : ''}`, at ? { available_at: new Date(at).toISOString() } : undefined);
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
    const rows = sql.prepare("SELECT amount FROM operations WHERE agent_id = ? AND counted = 1 AND asset = ? AND type != 'deposit' AND COALESCE(dispatch_committed_at, created_at) >= ?").all(agent.id, op.asset, new Date(now - ms).toISOString());
    const spent = rows.reduce((s, r) => s + BigInt(r.amount || 0), 0n);
    if (spent + op.amount > BigInt(lim)) push(403, 'policy_limit_exceeded', 'policy', `Amount would exceed the ${kind} limit of ${lim} (already used ${spent})`, { limit: lim });
  }
  if (policy.max_actions_per_hour !== null) {
    const n = sql.prepare("SELECT COUNT(*) n FROM operations WHERE agent_id = ? AND counted = 1 AND type != 'deposit' AND COALESCE(dispatch_committed_at, created_at) >= ?").get(agent.id, new Date(now - 3600_000).toISOString()).n;
    if (n + 1 > policy.max_actions_per_hour) push(403, 'policy_action_limit_exceeded', 'policy', `The policy allows ${policy.max_actions_per_hour} actions per hour`);
  }
  return v;
}
