#!/usr/bin/env node
// Runs the OFFICIAL @near-intents-agent-api/sdk against Tidepool (needs Node 24+).
//   npm i @near-intents-agent-api/sdk && node examples/agent-api-sdk-e2e.js [baseUrl]
// The owner is a throwaway local ed25519 implicit account (no on-chain wallet is created).
import crypto from 'node:crypto';
import { createAgentApi, createGrantCredential } from '@near-intents-agent-api/sdk';

const BASE = (process.argv[2] || process.env.TIDEPOOL_URL || 'https://www.usetidepool.tech').replace(/\/$/, '');
const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const b58 = (buf) => { let n = BigInt('0x' + buf.toString('hex')), s = ''; while (n > 0n) { s = B58[Number(n % 58n)] + s; n /= 58n; } for (const b of buf) { if (b) break; s = '1' + s; } return s; };
const u32 = (n) => { const b = Buffer.alloc(4); b.writeUInt32LE(n); return b; };
const bstr = (s) => { const x = Buffer.from(s); return Buffer.concat([u32(x.length), x]); };
const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
const raw = Buffer.from(publicKey.export({ format: 'jwk' }).x, 'base64url');
const owner = { type: 'near', account_id: raw.toString('hex'), public_key: 'ed25519:' + b58(raw) };
const signPayload = (p) => crypto.sign(null, crypto.createHash('sha256').update(Buffer.concat([u32(2 ** 31 + 413), bstr(p.message), Buffer.from(p.nonce, 'base64'), bstr(p.recipient), Buffer.from([0])])).digest(), privateKey).toString('base64');
const sign = (intent) => ({ ...intent, public_key: owner.public_key, signature: signPayload(intent.payload) });

let pass = 0, fail = 0;
async function step(name, fn) {
  try { const note = await fn(); pass++; console.log(`PASS  ${name}${note ? '  - ' + note : ''}`); }
  catch (e) { fail++; console.log(`FAIL  ${name}  - ${String(e?.message || e).slice(0, 300)}`); }
}
const must = (c, m) => { if (!c) throw new Error(m); };

console.log(`Official SDK against ${BASE}\n`);
let api, as, agentId, tokens, usdc, other, baseUsdc;
const settled = async (id) => { for (;;) { const s = await api.getStatus(id, { waitMs: 30000 }); if (!['PROCESSING', 'QUEUED'].includes(s.status)) return s; } };
const ownerIntent = async (req) => { const g = await api.generateIntent(req); await api.submitIntent({ type: g.type, correlation_id: g.correlation_id, signed_data: sign(g.intent) }); const st = await settled(g.correlation_id); must(st.status === 'SUCCESS', `${req.type} ${st.status}`); return g; };
const act = async (call) => { const r = await call; const st = await settled(r.correlation_id); must(st.status === 'SUCCESS', `${st.status} ${st.failure_code || ''}`); return st; };

await step('1. POST /v1/keys, createAgentApi({ baseUrl, apiKey }), whoami', async () => {
  const r = await (await fetch(BASE + '/v1/keys', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).json();
  api = createAgentApi({ apiKey: r.api_key, baseUrl: BASE });
  must((await api.whoami()), 'whoami');
});
await step('2. getNetwork, getTokens, getLatestRelease', async () => {
  must((await api.getNetwork()).network, 'network');
  tokens = await api.getTokens(); must(tokens.length > 5, 'tokens');
  usdc = tokens.find((t) => t.symbol === 'USDC' && t.blockchain === 'near'); other = tokens.find((t) => t.symbol !== 'USDC' && t.blockchain === 'near' && t.price);
  baseUsdc = tokens.find((t) => t.symbol === 'USDC' && t.blockchain === 'base');
  const rel = await api.getLatestRelease(); must(rel.version && rel.compose_hash, 'release'); return rel.version;
});
await step('3. agent_create via generateIntent + submitIntent', async () => {
  const policy = { frozen: false, actions: ['swap', 'transfer', 'withdraw'], confidential: false, owner_approval: false, assets: 'any', limits: {}, max_actions_per_hour: null, destinations: { mode: 'any', list: [] }, budget: { daily_usd: '500', weekly_usd: null, monthly_usd: null } };
  agentId = (await ownerIntent({ type: 'agent_create', name: 'sdk e2e', owner, policy })).agent_id; return agentId;
});
await step('4. grant_issue + forGrant(token)', async () => {
  const { token, commitment } = createGrantCredential();
  await ownerIntent({ type: 'grant_issue', agent_id: agentId, label: 'sdk', credential: commitment, expires_at: new Date(Date.now() + 86400000).toISOString() });
  as = api.forGrant(token);
});
await step('5. getAgent, getWallet, getPolicy, getBalances', async () => {
  must((await api.getAgent(agentId)).name, 'agent'); must((await api.getWallet(agentId)).near_account_id, 'wallet');
  must((await api.getPolicy(agentId)).revision >= 1, 'policy'); must(Array.isArray((await api.getBalances(agentId)).balances), 'balances');
});
await step('6. deposit (testnet faucet)', async () => { await act(as.deposit(agentId, { origin_asset: usdc.asset_id, testnet_faucet: true })); });
await step('7. dry swap then real swap', async () => {
  const body = { origin_asset: usdc.asset_id, destination_asset: other.asset_id, amount: '10000000' };
  must((await as.swap(agentId, { ...body, dry: true })).dry === true, 'dry flag'); await act(as.swap(agentId, body));
});
await step('8. transfer + withdraw (NEAR)', async () => {
  await act(as.transfer(agentId, { asset: usdc.asset_id, amount: '1000000', recipient: owner.account_id }));
  await act(as.withdraw(agentId, { asset: usdc.asset_id, amount: '1000000', chain: 'near', recipient: owner.account_id }));
});
await step('9. bridged withdraw to Base Sepolia', async () => {
  must(baseUsdc, 'no Base USDC listed');
  await act(as.swap(agentId, { origin_asset: usdc.asset_id, destination_asset: baseUsdc.asset_id, amount: '10000000' }));
  const to = '0x' + crypto.randomBytes(20).toString('hex');
  const st = await act(as.withdraw(agentId, { asset: baseUsdc.asset_id, amount: '4000000', chain: 'base', recipient: to }));
  must(st.details?.destination_tx_hash, 'no destination tx'); return st.details.destination_tx_hash;
});
await step('10. getHistory', async () => { const h = await api.getHistory(agentId); must(h.data.length >= 5, 'history'); return h.data.length + ' operations'; });
console.log(`\n${pass}/${pass + fail} steps passed`);
process.exit(fail ? 1 : 0);
