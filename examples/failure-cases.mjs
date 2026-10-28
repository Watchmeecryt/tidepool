// Tidepool failure cases on NEAR testnet: partial deposit, expired quote, overpay, simulated stuck/failed swaps, and API errors.
//
//   TIDEPOOL_URL=https://www.usetidepool.tech node failure-cases.mjs [partial|expired|overpay|stuck|failed|errors|all]
//
// Account: NEAR_ACCOUNT_ID + NEAR_PRIVATE_KEY, or a throwaway testnet account kept in ./.example-account.json
// (same as swap.mjs). Deposits are INTENTS transfers from your verifier balance; the faucet tops it up.
// Every /v0/status change is printed as full JSON. Keys are never printed. Pass --json out.json to save a log.
import fs from 'node:fs';
import crypto from 'node:crypto';
import { connect, keyStores, KeyPair } from 'near-api-js';
import bs58 from 'bs58';

const API = process.env.TIDEPOOL_URL || 'https://www.usetidepool.tech';
const RPC = process.env.NEAR_RPC || 'https://test.rpc.fastnear.com';
const CASE = process.argv.slice(2).find(a => !a.startsWith('--') && !a.endsWith('.json')) || 'all';
const OUT = process.argv.includes('--json') ? process.argv[process.argv.indexOf('--json') + 1] : null;
const log = [];
const say = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const call = async (method, path, body) => {
  const r = await fetch(API + path, { method, headers: { 'content-type': 'application/json', 'x-api-key': process.env.TIDEPOOL_KEY || 'dummy.jwt.token' }, body: body && JSON.stringify(body) });
  return { status: r.status, body: await r.json().catch(() => null) };
};
const api = async (m, p, b) => { const r = await call(m, p, b); if (r.status >= 400) throw new Error(`${m} ${p} ${r.status}: ${r.body?.message}`); return r.body; };

// ---- account ----
const keyStore = new keyStores.InMemoryKeyStore();
let accountId = process.env.NEAR_ACCOUNT_ID;
if (accountId) await keyStore.setKey('testnet', accountId, KeyPair.fromString(process.env.NEAR_PRIVATE_KEY));
else {
  const f = new URL('./.example-account.json', import.meta.url);
  if (!fs.existsSync(f)) {
    const kp = KeyPair.fromRandom('ed25519'); const id = `tidepool-try-${crypto.randomBytes(4).toString('hex')}.testnet`;
    const r = await fetch('https://helper.nearprotocol.com/account', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ newAccountId: id, newAccountPublicKey: kp.getPublicKey().toString() }) });
    if (!r.ok) throw new Error('could not create a testnet account: ' + r.status);
    fs.writeFileSync(f, JSON.stringify({ accountId: id, privateKey: kp.toString() }), { mode: 0o600 });
  }
  const k = JSON.parse(fs.readFileSync(f)); accountId = k.accountId; await keyStore.setKey('testnet', accountId, KeyPair.fromString(k.privateKey));
}
const near = await connect({ networkId: 'testnet', nodeUrl: RPC, keyStore });
const me = await near.account(accountId);
const tokens = await api('GET', '/v0/tokens');
const USDC = tokens.find(t => t.symbol === 'USDC'), WNEAR = tokens.find(t => t.symbol === 'wNEAR');
const verifier = (await api('GET', '/v0/health')).verifier;
say('account', accountId, 'verifier', verifier);
try { await api('POST', '/v0/faucet', { accountId, mode: 'intents' }); say('faucet: topped up intents balance'); } catch (e) { say('faucet skipped:', e.message); }

// ---- helpers ----
const quote = (deadlineMs, extra = {}) => api('POST', '/v0/quote', {
  dry: false, swapType: 'EXACT_INPUT', slippageTolerance: 100, originAsset: USDC.assetId, destinationAsset: WNEAR.assetId,
  amount: '5000000', depositType: 'INTENTS', refundTo: accountId, refundType: 'INTENTS', recipient: accountId, recipientType: 'INTENTS',
  deadline: new Date(Date.now() + deadlineMs).toISOString(), ...extra,
});
async function deposit(depositAddress, amount) {
  const kp = await keyStore.getKey('testnet', accountId); const pk = kp.getPublicKey().toString();
  if (!(await me.viewFunction({ contractId: verifier, methodName: 'has_public_key', args: { account_id: accountId, public_key: pk } })))
    await me.functionCall({ contractId: verifier, methodName: 'add_public_key', args: { public_key: pk }, attachedDeposit: 1n, gas: 30_000_000_000_000n });
  const nonce = crypto.randomBytes(32); if (nonce[0] === 0x56 && nonce[1] === 0x28) nonce[0] ^= 0xff;
  const message = JSON.stringify({ signer_id: accountId, verifying_contract: verifier, deadline: new Date(Date.now() + 120_000).toISOString(), nonce: nonce.toString('base64'), intents: [{ intent: 'transfer', receiver_id: depositAddress, tokens: { [USDC.assetId]: amount } }] });
  const s = x => { const b = Buffer.from(x); const l = Buffer.alloc(4); l.writeUInt32LE(b.length); return Buffer.concat([l, b]); };
  const tag = Buffer.alloc(4); tag.writeUInt32LE(2 ** 31 + 413);
  const hash = crypto.createHash('sha256').update(Buffer.concat([tag, s(message), nonce, s(verifier), Buffer.from([0])])).digest();
  const signed = { standard: 'nep413', payload: { message, nonce: nonce.toString('base64'), recipient: verifier }, public_key: pk, signature: 'ed25519:' + bs58.encode(Buffer.from(kp.sign(hash).signature)) };
  const out = await me.functionCall({ contractId: verifier, methodName: 'execute_intents', args: { signed: [signed] }, gas: 100_000_000_000_000n });
  const txHash = out.transaction.hash;
  say(`deposited ${amount} tx https://testnet.nearblocks.io/txns/${txHash}`);
  await api('POST', '/v0/deposit/submit', { txHash, depositAddress, nearSenderAccount: accountId });
  return txHash;
}
// Poll /v0/status, printing the full JSON on every status change, until a final status (or timeout).
async function watch(name, depositAddress, timeoutMs = 240_000) {
  let last; const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const st = await api('GET', `/v0/status?depositAddress=${depositAddress}`);
    if (st.status !== last) { last = st.status; say(`[${name}] status ${st.status}`); console.log(JSON.stringify(st, null, 2)); log.push({ case: name, at: new Date().toISOString(), status: st }); }
    if (['SUCCESS', 'REFUNDED', 'FAILED'].includes(st.status)) return st;
    await sleep(3000);
  }
  throw new Error(`${name}: no final status after ${timeoutMs / 1000}s (last ${last})`);
}

// ---- cases ----
const cases = {
  // Deposit half of amountIn. Status sits at INCOMPLETE_DEPOSIT, then REFUNDED (PARTIAL_DEPOSIT) once the deadline passes.
  async partial() {
    const q = await quote(75_000); const { depositAddress, amountIn, minAmountIn, deadline } = q.quote;
    say('[partial] quote', depositAddress, 'amountIn', amountIn, 'minAmountIn', minAmountIn, 'deadline', deadline);
    const tx = await deposit(depositAddress, (BigInt(amountIn) / 2n).toString());
    const st = await watch('partial', depositAddress); log.push({ case: 'partial', depositTx: tx, depositAddress }); return st;
  },
  // Quote with a 65 s deadline, wait it out, then deposit the full amount: REFUNDED (DEADLINE_PASSED).
  async expired() {
    const q = await quote(65_000); const { depositAddress, amountIn, deadline } = q.quote;
    say('[expired] quote', depositAddress, 'deadline', deadline, '- waiting for it to pass');
    await watch('expired', depositAddress, 1).catch(() => {});
    await sleep(new Date(deadline).getTime() - Date.now() + 5_000);
    const tx = await deposit(depositAddress, amountIn);
    const st = await watch('expired', depositAddress); log.push({ case: 'expired', depositTx: tx, depositAddress }); return st;
  },
  // Deposit 1.5x amountIn: SUCCESS, and the excess comes back as swapDetails.refundedAmount.
  async overpay() {
    const q = await quote(600_000); const { depositAddress, amountIn } = q.quote;
    const tx = await deposit(depositAddress, (BigInt(amountIn) * 3n / 2n).toString());
    const st = await watch('overpay', depositAddress); log.push({ case: 'overpay', depositTx: tx, depositAddress }); return st;
  },
  // Tidepool-only `simulate: "STUCK"`: the deposit is seen, the swap goes PROCESSING and never settles, then it is
  // REFUNDED (DEADLINE_PASSED) at the quote deadline. Reproduces a client's view of a slow or down 1Click. Remove `simulate` on mainnet.
  async stuck() {
    const q = await quote(65_000, { simulate: 'STUCK' }); const { depositAddress, amountIn, deadline } = q.quote;
    say('[stuck] quote', depositAddress, 'deadline', deadline, 'tidepool', JSON.stringify(q.tidepool));
    const tx = await deposit(depositAddress, amountIn);
    const st = await watch('stuck', depositAddress); log.push({ case: 'stuck', depositTx: tx, depositAddress }); return st;
  },
  // Tidepool-only `simulate: "FAILED"`: PROCESSING, then FAILED, and the deposit is refunded (SWAP_FAILED).
  async failed() {
    const q = await quote(600_000, { simulate: 'FAILED' }); const { depositAddress, amountIn } = q.quote;
    say('[failed] quote', depositAddress, 'tidepool', JSON.stringify(q.tidepool));
    const tx = await deposit(depositAddress, amountIn);
    const st = await watch('failed', depositAddress); log.push({ case: 'failed', depositTx: tx, depositAddress }); return st;
  },
  // API errors you should handle before any funds move.
  async errors() {
    const show = async (label, r) => { say(`[errors] ${label}: HTTP ${(r = await r).status}`, JSON.stringify(r.body)); log.push({ case: 'errors', label, http: r.status, body: r.body }); };
    const body = { dry: false, swapType: 'EXACT_INPUT', slippageTolerance: 100, originAsset: USDC.assetId, destinationAsset: WNEAR.assetId, amount: '5000000', depositType: 'INTENTS', refundTo: accountId, refundType: 'INTENTS', recipient: accountId, recipientType: 'INTENTS' };
    await show('deadline 30 s ahead', call('POST', '/v0/quote', { ...body, deadline: new Date(Date.now() + 30_000).toISOString() }));
    await show('deadline in the past', call('POST', '/v0/quote', { ...body, deadline: new Date(Date.now() - 60_000).toISOString() }));
    await show('deadline not a date', call('POST', '/v0/quote', { ...body, deadline: 'tomorrow' }));
    await show('simulate not STUCK or FAILED', call('POST', '/v0/quote', { ...body, deadline: new Date(Date.now() + 600_000).toISOString(), simulate: 'BOOM' }));
    await show('deadline 2 days ahead', call('POST', '/v0/quote', { ...body, deadline: new Date(Date.now() + 48 * 3600_000).toISOString() }));
    const bogus = crypto.randomBytes(32).toString('hex');
    await show('status of an unknown deposit address', call('GET', `/v0/status?depositAddress=${bogus}`));
    await show('submit a deposit for an unknown address', call('POST', '/v0/deposit/submit', { txHash: '8HAgViUuMBZ6bMSU3g6tMx5df6FFpevyHkQTLLcWqZzK', depositAddress: bogus }));
  },
};
const run = CASE === 'all' ? ['errors', 'overpay', 'partial', 'expired', 'stuck', 'failed'] : [CASE];
for (const c of run) {
  const st = await cases[c]();
  if (st) { const d = st.swapDetails; say(`[${c}] final ${st.status}`, JSON.stringify({ refundReason: d.refundReason, refundedAmount: d.refundedAmountFormatted, amountOut: d.amountOutFormatted })); for (const t of st.tidepool?.explorer || []) say('  ', t.label, t.url); }
}
if (OUT) fs.writeFileSync(OUT, JSON.stringify(log, null, 2));
