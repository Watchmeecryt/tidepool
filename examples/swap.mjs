// End-to-end Tidepool swap: faucet -> dry quote -> live quote -> deposit -> submit -> status.
//
//   TIDEPOOL_URL=https://... node swap.mjs              INTENTS deposit (signed NEP-413 transfer), payout to wallet
//   TIDEPOOL_URL=https://... node swap.mjs --origin     ORIGIN_CHAIN deposit (plain ft_transfer), payout inside the verifier
//   TIDEPOOL_URL=https://... node swap.mjs --refund     deposit half of amountIn, short deadline, expect REFUNDED
//
// Account: set NEAR_ACCOUNT_ID + NEAR_PRIVATE_KEY, or the script creates a throwaway testnet account
// through the public helper and keeps its key in ./.example-account.json (gitignored). Keys are never printed.
import fs from 'node:fs';
import crypto from 'node:crypto';
import { connect, keyStores, KeyPair } from 'near-api-js';
import bs58 from 'bs58';

const API = process.env.TIDEPOOL_URL || 'http://localhost:8787';
const RPC = process.env.NEAR_RPC || 'https://test.rpc.fastnear.com';
const MODE = process.argv.includes('--refund') ? 'refund' : process.argv.includes('--origin') ? 'origin' : 'intents';
const FROM = process.env.FROM || 'USDC', TO = process.env.TO || 'wNEAR', AMOUNT = process.env.AMOUNT || '5';
const say = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const api = async (method, path, body) => {
  const r = await fetch(API + path, { method, headers: { 'content-type': 'application/json', 'x-api-key': process.env.TIDEPOOL_KEY || 'dummy.jwt.token' }, body: body && JSON.stringify(body) });
  const j = await r.json(); if (!r.ok) throw new Error(`${method} ${path} ${r.status}: ${j.message}`); return j;
};

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
say('account', accountId);

const tokens = await api('GET', '/v0/tokens');
const tIn = tokens.find(t => t.symbol === FROM), tOut = tokens.find(t => t.symbol === TO);
const verifier = (await api('GET', '/v0/health')).verifier;
const units = (s, d) => { const [i, f = ''] = String(s).split('.'); return (BigInt(i + (f + '0'.repeat(d)).slice(0, d))).toString(); };

// ---- 1. faucet (skip quietly if rate limited) ----
try {
  const f = await api('POST', '/v0/faucet', { accountId, mode: MODE === 'origin' ? 'wallet' : 'intents' });
  say('faucet', f.transactions.map(t => t.explorerUrl).join(' '));
} catch (e) { say('faucet skipped:', e.message); }

// ---- 2. quotes ----
const base = {
  swapType: 'EXACT_INPUT', slippageTolerance: 100, originAsset: tIn.assetId, destinationAsset: tOut.assetId, amount: units(AMOUNT, tIn.decimals),
  depositType: MODE === 'origin' ? 'ORIGIN_CHAIN' : 'INTENTS', refundTo: accountId, refundType: MODE === 'origin' ? 'ORIGIN_CHAIN' : 'INTENTS',
  recipient: accountId, recipientType: MODE === 'origin' ? 'INTENTS' : 'DESTINATION_CHAIN',
};
const dry = await api('POST', '/v0/quote', { ...base, dry: true, deadline: new Date(Date.now() + 600_000).toISOString() });
say(`dry quote: ${dry.quote.amountInFormatted} ${FROM} -> ${dry.quote.amountOutFormatted} ${TO} (min ${dry.quote.minAmountOut})`);
const live = await api('POST', '/v0/quote', { ...base, dry: false, deadline: new Date(Date.now() + (MODE === 'refund' ? 75_000 : 600_000)).toISOString() });
const { depositAddress, amountIn } = live.quote;
say('live quote', live.correlationId, 'depositAddress', depositAddress, 'deadline', live.quote.deadline);

// ---- 3. deposit ----
const amount = MODE === 'refund' ? (BigInt(amountIn) / 2n).toString() : amountIn;
let txHash;
if (MODE === 'origin') {
  await me.functionCall({ contractId: tIn.contractAddress, methodName: 'storage_deposit', args: { account_id: depositAddress, registration_only: true }, attachedDeposit: 1_250_000_000_000_000_000_000n, gas: 30_000_000_000_000n });
  const out = await me.functionCall({ contractId: tIn.contractAddress, methodName: 'ft_transfer', args: { receiver_id: depositAddress, amount }, attachedDeposit: 1n, gas: 30_000_000_000_000n });
  txHash = out.transaction.hash;
} else {
  // A NEP-413 signed `transfer` intent from our verifier balance to the deposit address.
  const kp = await keyStore.getKey('testnet', accountId);
  // Named accounts must register their key with the verifier once (implicit accounts need not).
  const pk = kp.getPublicKey().toString();
  if (!(await me.viewFunction({ contractId: verifier, methodName: 'has_public_key', args: { account_id: accountId, public_key: pk } }))) {
    await me.functionCall({ contractId: verifier, methodName: 'add_public_key', args: { public_key: pk }, attachedDeposit: 1n, gas: 30_000_000_000_000n });
    say('registered key with verifier');
  }
  const nonce = crypto.randomBytes(32); if (nonce[0] === 0x56 && nonce[1] === 0x28) nonce[0] ^= 0xff;
  const message = JSON.stringify({ signer_id: accountId, verifying_contract: verifier, deadline: new Date(Date.now() + 120_000).toISOString(), nonce: nonce.toString('base64'), intents: [{ intent: 'transfer', receiver_id: depositAddress, tokens: { [tIn.assetId]: amount } }] });
  const s = (x) => { const b = Buffer.from(x); const l = Buffer.alloc(4); l.writeUInt32LE(b.length); return Buffer.concat([l, b]); };
  const tag = Buffer.alloc(4); tag.writeUInt32LE(2 ** 31 + 413);
  const hash = crypto.createHash('sha256').update(Buffer.concat([tag, s(message), nonce, s(verifier), Buffer.from([0])])).digest();
  const signed = { standard: 'nep413', payload: { message, nonce: nonce.toString('base64'), recipient: verifier }, public_key: kp.getPublicKey().toString(), signature: 'ed25519:' + bs58.encode(Buffer.from(kp.sign(hash).signature)) };
  const out = await me.functionCall({ contractId: verifier, methodName: 'execute_intents', args: { signed: [signed] }, gas: 100_000_000_000_000n });
  txHash = out.transaction.hash;
}
say(`deposited ${amount} (${MODE}) tx https://testnet.nearblocks.io/txns/${txHash}`);
await api('POST', '/v0/deposit/submit', { txHash, depositAddress, nearSenderAccount: accountId });

// ---- 4. status ----
let last;
for (;;) {
  const st = await api('GET', `/v0/status?depositAddress=${depositAddress}`);
  if (st.status !== last) { say('status', st.status); last = st.status; }
  if (['SUCCESS', 'REFUNDED', 'FAILED'].includes(st.status)) {
    const d = st.swapDetails;
    say(JSON.stringify({ amountIn: d.amountInFormatted, amountOut: d.amountOutFormatted, refunded: d.refundedAmountFormatted, refundReason: d.refundReason, intentHashes: d.intentHashes }));
    for (const t of st.tidepool?.explorer || []) say(' ', t.label, t.url);
    process.exit(st.status === (MODE === 'refund' ? 'REFUNDED' : 'SUCCESS') ? 0 : 1);
  }
  await new Promise(r => setTimeout(r, 3000));
}
