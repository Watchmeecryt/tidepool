#!/usr/bin/env node
// End-to-end test of the Tidepool Agent API (NEAR testnet). Plain fetch + node:crypto, no dependencies.
//   node examples/agent-api-e2e.js [baseUrl]        (default: https://www.usetidepool.tech)
// Uses a throwaway local ed25519 key as the owner (an implicit NEAR account: no wallet is created on chain).
import crypto from 'node:crypto';

const BASE = (process.argv[2] || process.env.TIDEPOOL_URL || 'https://www.usetidepool.tech').replace(/\/$/, '');
const results = [];
let key, agent, grantToken, owner;

const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const b58 = (buf) => { let n = BigInt('0x' + buf.toString('hex')), s = ''; while (n > 0n) { s = B58[Number(n % 58n)] + s; n /= 58n; } for (const b of buf) { if (b) break; s = '1' + s; } return s; };
const u32 = (n) => { const b = Buffer.alloc(4); b.writeUInt32LE(n); return b; };
const bstr = (s) => { const x = Buffer.from(s); return Buffer.concat([u32(x.length), x]); };

function makeOwner() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const raw = Buffer.from(publicKey.export({ format: 'jwk' }).x, 'base64url');
  return { privateKey, account_id: raw.toString('hex'), public_key: 'ed25519:' + b58(raw) };
}
const sign = (o, p) => {
  const hash = crypto.createHash('sha256').update(Buffer.concat([u32(2 ** 31 + 413), bstr(p.message), Buffer.from(p.nonce, 'base64'), bstr(p.recipient), Buffer.from([0])])).digest();
  return crypto.sign(null, hash, o.privateKey).toString('base64');
};

async function api(method, path, { body, grant, idem, headers } = {}) {
  const res = await fetch(BASE + '/v1' + path, { method, headers: { 'content-type': 'application/json', ...(key ? { authorization: 'Bearer ' + key } : {}), ...(grant ? { 'x-grant-token': grant } : {}), ...(idem ? { 'idempotency-key': idem } : {}), ...headers }, body: body ? JSON.stringify(body) : undefined });
  const json = await res.json().catch(() => ({}));
  return { status: res.status, json };
}
const idem = () => 'e2e-' + crypto.randomUUID();
async function step(name, fn) {
  const t = Date.now();
  try { const note = await fn(); results.push({ name, ok: true }); console.log(`PASS  ${name}${note ? '  - ' + note : ''}  (${Date.now() - t} ms)`); }
  catch (e) { results.push({ name, ok: false }); console.log(`FAIL  ${name}  - ${String(e.message).slice(0, 400)}`); }
}
const expect = (cond, msg) => { if (!cond) throw new Error(msg); };
const need = (r, status, what) => expect(r.status === status, `${what}: expected HTTP ${status}, got ${r.status} ${JSON.stringify(r.json).slice(0, 300)}`);

async function owned(type, body) {
  const g = await api('POST', '/generate-intent', { body: { type, ...body }, idem: idem() });
  need(g, 201, `generate-intent ${type}`);
  const intent = g.json.intent.payload;
  const s = await api('POST', '/submit-intent', { body: { type, correlation_id: g.json.correlation_id, signed_data: { standard: 'nep413', payload: intent, public_key: owner.public_key, signature: sign(owner, intent) } } });
  need(s, 202, `submit-intent ${type}`);
  const st = await api('GET', `/status?correlation_id=${g.json.correlation_id}&wait_ms=10000`);
  expect(st.json.status === 'SUCCESS', `${type} status ${st.json.status} ${st.json.failure_code}`);
  return { gen: g.json, status: st.json };
}
async function action(kind, body, { grant = grantToken, want = 'SUCCESS' } = {}) {
  const r = await api('POST', `/agents/${agent}/${kind}`, { body, grant, idem: idem() });
  need(r, 202, kind);
  const st = await api('GET', `/status?correlation_id=${r.json.correlation_id}&wait_ms=30000`);
  expect(st.json.status === want, `${kind} status ${st.json.status}: ${st.json.failure_code} ${st.json.details?.failure_reason}`);
  return st.json;
}

const policy = (extra = {}) => ({ frozen: false, actions: ['swap', 'transfer', 'withdraw'], confidential: false, owner_approval: false, assets: 'any', limits: {}, max_actions_per_hour: null, destinations: { mode: 'any', list: [] }, budget: { daily_usd: null, weekly_usd: null, monthly_usd: null }, timelock_ms: 0, ...extra });

console.log(`Tidepool Agent API e2e against ${BASE}\n`);
let tokens, usdc, near, wnear;
await step('1. get a free API key (POST /v1/keys)', async () => { const r = await api('POST', '/keys', { body: { name: 'e2e-test' } }); need(r, 201, 'keys'); key = r.json.api_key; expect(key.startsWith('naa_'), 'key prefix'); });
await step('2. whoami + tokens', async () => {
  need(await api('GET', '/whoami'), 200, 'whoami');
  const r = await api('GET', '/tokens'); need(r, 200, 'tokens'); tokens = r.json.data;
  const near_ = tokens.filter((t) => t.blockchain === 'near');
  usdc = near_.find((t) => t.symbol === 'USDC'); near = near_.find((t) => t.symbol !== 'USDC' && t.price); wnear = near_.find((t) => t.symbol === 'USDT') || near;
  expect(usdc && near, 'need a NEAR USDC and one other NEAR token'); return `${tokens.length} tokens`;
});
await step('3. agent_create (nep413 owner signature)', async () => {
  owner = makeOwner();
  const r = await owned('agent_create', { name: 'e2e agent', owner: { type: 'near', account_id: owner.account_id, public_key: owner.public_key }, policy: policy({ limits: { per_transaction: { [usdc.asset_id]: '50000000' } } }) });
  agent = r.status.agent_id;
  const g = await api('GET', `/agents/${agent}`); need(g, 200, 'get agent'); return agent;
});
await step('4. grant_issue', async () => {
  grantToken = 'ngt_' + crypto.randomBytes(32).toString('base64url');
  const r = await owned('grant_issue', { agent_id: agent, label: 'e2e', credential: crypto.createHash('sha256').update(grantToken).digest('hex'), expires_at: new Date(Date.now() + 86400_000).toISOString() });
  expect(r.status.details.grant, 'grant missing');
});
await step('5. deposit (testnet faucet) + balances', async () => {
  const st = await action('deposit', { origin_asset: usdc.asset_id, testnet_faucet: true });
  const b = await api('GET', `/agents/${agent}/balances`); need(b, 200, 'balances');
  expect(b.json.balances.some((x) => x.asset_id === usdc.asset_id && BigInt(x.balance_raw) > 0n), 'no USDC balance after faucet');
  return `${b.json.balances.length} funded assets`;
});
await step('6. swap dry run', async () => { const r = await api('POST', `/agents/${agent}/swap`, { body: { origin_asset: usdc.asset_id, destination_asset: near.asset_id, amount: '10000000', dry: true } }); need(r, 200, 'dry swap'); expect(r.json.dry === true && r.json.quote.amount_out, 'no quote'); return `out ${r.json.quote.amount_out}`; });
let swapOut;
await step('7. swap (real)', async () => { const st = await action('swap', { origin_asset: usdc.asset_id, destination_asset: near.asset_id, amount: '10000000' }); swapOut = st.details.amount_out; expect(st.details.tx_hash, 'no tx hash'); return `tx ${st.details.tx_hash}`; });
await step('8. transfer (to the owner account)', async () => { const st = await action('transfer', { asset: usdc.asset_id, amount: '1000000', recipient: owner.account_id }); return `tx ${st.details.tx_hash}`; });
await step('9. withdraw (to a NEAR testnet account)', async () => { const st = await action('withdraw', { asset: usdc.asset_id, amount: '1000000', chain: 'near', recipient: owner.account_id }); return `tx ${st.details.tx_hash}`; });
await step('9b. bridged withdraw: swap to Base Sepolia USDC, withdraw to an EVM address', async () => {
  const baseUsdc = tokens.find((t) => t.blockchain === 'base' && t.symbol === 'USDC');
  expect(baseUsdc, 'no Base Sepolia USDC bridge listed');
  const sw = await action('swap', { origin_asset: usdc.asset_id, destination_asset: baseUsdc.asset_id, amount: '10000000' });
  const to = '0x' + crypto.randomBytes(20).toString('hex'), amt = (BigInt(sw.details.amount_out) / 2n).toString();
  const d = await api('POST', `/agents/${agent}/withdraw`, { body: { asset: baseUsdc.asset_id, amount: amt, chain: 'base', recipient: to, dry: true } }); need(d, 200, 'dry withdraw');
  const st = await action('withdraw', { asset: baseUsdc.asset_id, amount: amt, chain: 'base', recipient: to });
  expect(st.details.destination_tx_hash && st.details.destination_chain === 'base', `no destination tx: ${JSON.stringify(st.details).slice(0, 200)}`);
  return `base tx ${st.details.destination_tx_hash}`;
});
await step('9c. withdraw to an unsupported chain is rejected (route_unavailable)', async () => {
  const r = await api('POST', `/agents/${agent}/withdraw`, { body: { asset: usdc.asset_id, amount: '1000', chain: 'sol', recipient: owner.account_id }, grant: grantToken, idem: idem() });
  expect(r.status === 400 && r.json.errors[0].code === 'route_unavailable', `expected route_unavailable, got ${r.status} ${JSON.stringify(r.json).slice(0, 200)}`);
});
await step('9d. GET /v1/releases/latest', async () => {
  const r = await api('GET', '/releases/latest'); need(r, 200, 'releases/latest');
  expect(r.json.version && r.json.compose_hash && r.json.status === 'active', 'unexpected release shape'); return r.json.version;
});
await step('10. history + idempotent replay', async () => {
  const h = await api('GET', `/agents/${agent}/history`); need(h, 200, 'history');
  expect(h.json.data.filter((x) => x.status === 'SUCCESS').length >= 4, `expected 4+ successful operations, got ${h.json.data.length}`);
  const k = idem(), body = { asset: usdc.asset_id, amount: '1', recipient: owner.account_id };
  const a = await api('POST', `/agents/${agent}/transfer`, { body, grant: grantToken, idem: k }), b = await api('POST', `/agents/${agent}/transfer`, { body, grant: grantToken, idem: k });
  expect(a.json.correlation_id === b.json.correlation_id, 'replay returned a different execution');
  const c = await api('POST', `/agents/${agent}/transfer`, { body: { ...body, amount: '2' }, grant: grantToken, idem: k });
  expect(c.status === 409 && c.json.errors[0].code === 'idempotency_conflict', 'conflicting body not rejected');
  await api('GET', `/status?correlation_id=${a.json.correlation_id}&wait_ms=20000`);
  return `${h.json.data.length} operations`;
});
await step('11. policy violation: per-transaction limit', async () => {
  const r = await api('POST', `/agents/${agent}/transfer`, { body: { asset: usdc.asset_id, amount: '60000000', recipient: owner.account_id }, grant: grantToken, idem: idem() });
  expect(r.status === 403 && r.json.errors[0].code === 'policy_transaction_limit_exceeded' && r.json.errors[0].layer === 'policy', `expected policy_transaction_limit_exceeded, got ${r.status} ${JSON.stringify(r.json).slice(0, 200)}`);
  return r.json.errors[0].code;
});
await step('12. policy_update (deny withdraw) then withdraw is rejected', async () => {
  const cur = await api('GET', `/agents/${agent}/policy`);
  await owned('policy_update', { agent_id: agent, expected_revision: cur.json.revision, policy: { ...cur.json.policy, actions: ['swap', 'transfer'] } });
  const r = await api('POST', `/agents/${agent}/withdraw`, { body: { asset: usdc.asset_id, amount: '1000', chain: 'near', recipient: owner.account_id }, grant: grantToken, idem: idem() });
  expect(r.status === 403 && r.json.errors[0].code === 'policy_action_denied', `expected policy_action_denied, got ${r.status}`);
});
await step('13. freeze blocks actions, unfreeze restores', async () => {
  await owned('agent_freeze', { agent_id: agent });
  const r = await api('POST', `/agents/${agent}/transfer`, { body: { asset: usdc.asset_id, amount: '1000', recipient: owner.account_id }, grant: grantToken, idem: idem() });
  expect(r.status === 409 && r.json.errors[0].code === 'wallet_frozen', `expected wallet_frozen, got ${r.status}`);
  await owned('agent_unfreeze', { agent_id: agent });
});
await step('14. grant_revoke then action is rejected', async () => {
  const gs = await api('GET', `/agents/${agent}/grants`);
  await owned('grant_revoke', { agent_id: agent, grant_id: gs.json.data[0].grant_id });
  const r = await api('POST', `/agents/${agent}/transfer`, { body: { asset: usdc.asset_id, amount: '1000', recipient: owner.account_id }, grant: grantToken, idem: idem() });
  expect(r.status === 403 && r.json.errors[0].code === 'grant_revoked', `expected grant_revoked, got ${r.status}`);
});

const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} steps passed`);
process.exit(failed ? 1 : 0);
