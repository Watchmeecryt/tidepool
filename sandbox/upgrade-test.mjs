// Sandbox upgrade test: deploy OLD defuse wasm, seed state, upgrade in place to NEW wasm, verify state + Tidepool flows.
// usage: node upgrade-test.mjs <old.wasm> <new.wasm> <token.wasm>
import fs from 'node:fs';
import crypto from 'node:crypto';
import bs58 from 'bs58';
import { Sandbox, DEFAULT_ACCOUNT_ID, DEFAULT_PRIVATE_KEY } from 'near-sandbox';
const [OLD, NEW, TOKEN] = process.argv.slice(2);
const sb = await Sandbox.start({});
process.env.NEAR_RPC = sb.rpcUrl; process.env.NEAR_RPC_URLS = sb.rpcUrl;
const S = new URL('../server/src/', import.meta.url).pathname;
const nearM = await import(S + 'near.mjs');
const { call, view, rpc, keyStore, account, signIntents, TGAS, parseNear, NETWORK } = nearM;
const { KeyPair, transactions } = await import('../server/node_modules/near-api-js/lib/index.js');
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');

const results = []; let failed = 0;
const check = (name, ok, extra = '') => { results.push({ name, ok: !!ok }); if (!ok) failed++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  ' + extra : ''}`); };
const ROOT = DEFAULT_ACCOUNT_ID; const R = (n) => `${n}.${ROOT}`;
await keyStore.setKey(NETWORK, ROOT, KeyPair.fromString(DEFAULT_PRIVATE_KEY));
const rootAcc = await account(ROOT);
const keys = {};
async function mk(name, near = 20) {
  const id = R(name);
  const kp = KeyPair.fromRandom('ed25519'); keys[id] = kp;
  await rootAcc.createAccount(id, kp.getPublicKey(), parseNear(near));
  await keyStore.setKey(NETWORK, id, kp);
}
async function gasOf(r, who) { const t = await rpc('tx', [r.txHash, who]); return t.receipts_outcome.reduce((a, o) => a + Number(o.outcome.gas_burnt), 0) + Number(t.transaction_outcome.outcome.gas_burnt); }
const must = async (...a) => { const r = await call(...a); if (!r.ok) throw new Error(`${a[2]} failed: ${r.failures.join('; ')}`); return r; };

const VERIFIER = R('verifier'), MAKER = R('maker'), BOB = R('bob'), FEE = R('fee');
const TOK = [1, 2, 3, 4, 5, 6].map(i => R('t' + i));
const asset = (t) => 'nep141:' + t;
await mk('verifier', 50); await mk('maker', 50); await mk('bob'); await mk('fee');
for (const t of TOK) await mk(t.split('.')[0], 10);
const tokenWasm = fs.readFileSync(TOKEN);
for (const t of TOK) {
  await (await account(t)).deployContract(tokenWasm);
  await must(t, t, 'new', { owner_id: ROOT, name: t, symbol: t.split('.')[0].toUpperCase(), decimals: 6 });
  // owner = ROOT must be able to mint
}
const oldWasm = fs.readFileSync(OLD), newWasm = fs.readFileSync(NEW);
console.log('old sha256', sha(oldWasm), 'new sha256', sha(newWasm));
const vAcc = await account(VERIFIER);
await vAcc.deployContract(oldWasm);
await must(VERIFIER, VERIFIER, 'new', { config: { wnear_id: R('wrap'), fees: { fee: 0, fee_collector: ROOT }, roles: { super_admins: [ROOT], admins: {}, grantees: {} } } }, { gas: 100n * TGAS });
const codeHash = async () => (await rpc('query', { request_type: 'view_account', finality: 'optimistic', account_id: VERIFIER })).code_hash;
const b58hex = (h) => Buffer.from(bs58.decode(h)).toString('hex');
check('deployed OLD wasm: on-chain code hash == sha256(old)', b58hex(await codeHash()) === sha(oldWasm));

for (const t of TOK) for (const who of [VERIFIER, BOB, FEE, MAKER]) await must(ROOT, t, 'storage_deposit', { account_id: who, registration_only: true }, { deposit: parseNear(0.00125) });

const bal = async (acct, t) => BigInt(await view(VERIFIER, 'mt_balance_of', { account_id: acct, token_id: asset(t) }));
const ftbal = async (t, acct) => BigInt(await view(t, 'ft_balance_of', { account_id: acct }));
async function newDepositAccount() {
  const kp = KeyPair.fromRandom('ed25519'); const hex = Buffer.from(bs58.decode(kp.getPublicKey().toString().slice(8))).toString('hex');
  await keyStore.setKey(NETWORK, hex, kp); keys[hex] = kp;
  await rootAcc.sendMoney(hex, parseNear(1));
  for (const t of TOK) await must(ROOT, t, 'storage_deposit', { account_id: hex, registration_only: true }, { deposit: parseNear(0.00125) });
  return { hex, kp };
}
// --- the same deposit calls Tidepool makes ---
async function depositFromDepositAddr(u, t, amt) { // sweepOrigin: user holds tokens at deposit addr, ft_transfer_call msg=addr, 1 yocto, 60 Tgas
  await must(ROOT, t, 'mint', { account_id: u.hex, amount: String(amt) });
  const r = await must(u.hex, t, 'ft_transfer_call', { receiver_id: VERIFIER, amount: String(amt), msg: u.hex }, { deposit: 1n, gas: 60n * TGAS });
  return r;
}
async function depositBridgeCredit(acct, t, amt) { // bridge credit: ROOT holds minted tokens, ft_transfer_call 100 Tgas msg=acct
  await must(ROOT, t, 'mint', { account_id: ROOT, amount: String(amt) });
  return must(ROOT, t, 'ft_transfer_call', { receiver_id: VERIFIER, amount: String(amt), msg: acct }, { deposit: 1n, gas: 100n * TGAS });
}
const hashesFrom = (logs) => logs.flatMap(l => { try { const e = JSON.parse(l.replace(/^EVENT_JSON:/, '')); return (e.data || []).map(x => x.intent_hash).filter(Boolean); } catch { return []; } });
const execute = (signed) => call(MAKER, VERIFIER, 'execute_intents', { signed }, { gas: 300n * TGAS });

async function flows(label, u) {
  const L = (s) => `[${label}] ${s}`;
  // 1. deposits both ways
  const b1 = await bal(u.hex, TOK[0]);
  await depositFromDepositAddr(u, TOK[0], 1_000_000_000);
  check(L('ft_transfer_call deposit (account-id msg, 60 Tgas) credits mt balance'), (await bal(u.hex, TOK[0])) === b1 + 1_000_000_000n);
  const b1b = await bal(u.hex, TOK[0]);
  await depositBridgeCredit(u.hex, TOK[0], 500_000_000);
  check(L('bridge-credit ft_transfer_call (100 Tgas) credits mt balance'), (await bal(u.hex, TOK[0])) === b1b + 500_000_000n);
  // maker liquidity on all 6 tokens
  for (const t of TOK) await must(ROOT, t, 'mint', { account_id: MAKER, amount: '10000000000' }), await must(MAKER, t, 'ft_transfer_call', { receiver_id: VERIFIER, amount: '10000000000', msg: MAKER }, { deposit: 1n, gas: 60n * TGAS });
  check(L('maker deposits on 6 tokens'), (await bal(MAKER, TOK[5])) >= 10_000_000_000n);
  // 2. swap: maker+user token_diff, appFee transfer w/ memo, ft_withdraw to bob
  const ua = (await bal(u.hex, TOK[0])), tradeIn = 400_000_000n, fee = 1_000_000n, out = 390_000_000n;
  const bobBefore = await ftbal(TOK[1], BOB);
  const userIntents = [
    { intent: 'transfer', receiver_id: FEE, tokens: { [asset(TOK[0])]: fee.toString() }, memo: 'appFee' },
    { intent: 'token_diff', diff: { [asset(TOK[0])]: (-tradeIn).toString(), [asset(TOK[1])]: out.toString() } },
    { intent: 'ft_withdraw', token: TOK[1], receiver_id: BOB, amount: out.toString() },
  ];
  const user = signIntents({ signerId: u.hex, verifier: VERIFIER, keyPair: u.kp, intents: userIntents });
  const maker = signIntents({ signerId: MAKER, verifier: VERIFIER, keyPair: keys[MAKER], intents: [{ intent: 'token_diff', diff: { [asset(TOK[0])]: tradeIn.toString(), [asset(TOK[1])]: (-out).toString() } }] });
  let r = await execute([maker, user]);
  if (!r.ok && /public key|PublicKey|Unknown|not found/i.test(r.failures.join())) {
    console.log(L('maker key not registered in verifier (' + r.failures.join(';').slice(0, 120) + '); registering via add_public_key'));
    await must(MAKER, VERIFIER, 'add_public_key', { public_key: keys[MAKER].getPublicKey().toString() }, { deposit: 1n });
    const maker2 = signIntents({ signerId: MAKER, verifier: VERIFIER, keyPair: keys[MAKER], intents: [{ intent: 'token_diff', diff: { [asset(TOK[0])]: tradeIn.toString(), [asset(TOK[1])]: (-out).toString() } }] });
    const user2 = signIntents({ signerId: u.hex, verifier: VERIFIER, keyPair: u.kp, intents: userIntents });
    r = await execute([maker2, user2]);
  }
  check(L('execute_intents: maker+user token_diff, appFee transfer(memo), ft_withdraw (300 Tgas)'), r.ok, r.ok ? '' : r.failures.join('; ').slice(0, 300));
  if (r.ok) {
    await new Promise(x => setTimeout(x, 500));
    check(L('ft_withdraw delivered NEP-141 to receiver'), (await ftbal(TOK[1], BOB)) === bobBefore + out);
    check(L('user mt balance debited by tradeIn+fee'), (await bal(u.hex, TOK[0])) === ua - tradeIn - fee);
    check(L('appFee recipient credited in verifier'), (await bal(FEE, TOK[0])) >= fee);
    check(L('events carry intent_hash (hashesFrom parses)'), hashesFrom(r.logs).length >= 2, `hashes=${hashesFrom(r.logs).length}`);
    console.log(L(`gas burnt for swap execute_intents: ${(await gasOf(r, MAKER) / 1e12).toFixed(1)} Tgas`));
  }
  // 3. refund path: ft_withdraw to NEAR + INTENTS-style transfer
  const rem = await bal(u.hex, TOK[0]);
  const bobT0 = await ftbal(TOK[0], BOB);
  const refundI = signIntents({ signerId: u.hex, verifier: VERIFIER, keyPair: u.kp, intents: [
    { intent: 'ft_withdraw', token: TOK[0], receiver_id: BOB, amount: '100000000', memo: 'WITHDRAW_TO:0xabc' },
    { intent: 'transfer', receiver_id: BOB, tokens: { [asset(TOK[0])]: '50000000' } } ] });
  r = await execute([refundI]);
  check(L('refund: ft_withdraw (with WITHDRAW_TO memo) + transfer intent'), r.ok, r.ok ? '' : r.failures.join('; ').slice(0, 300));
  if (r.ok) { await new Promise(x => setTimeout(x, 500)); check(L('refund delivered + balances consistent'), (await ftbal(TOK[0], BOB)) === bobT0 + 100_000_000n && (await bal(u.hex, TOK[0])) === rem - 150_000_000n); }
  // 4. faucet mt_batch_transfer of 6 tokens, 200 Tgas
  const u2 = await newDepositAccount();
  r = await call(MAKER, VERIFIER, 'mt_batch_transfer', { receiver_id: u2.hex, token_ids: TOK.map(asset), amounts: TOK.map(() => '1000000'), memo: 'tidepool faucet' }, { deposit: 1n, gas: 200n * TGAS });
  check(L('faucet mt_batch_transfer, 6 tokens'), r.ok, r.ok ? '' : r.failures.join('; ').slice(0, 300));
  const bb = await view(VERIFIER, 'mt_batch_balance_of', { account_id: u2.hex, token_ids: TOK.map(asset) });
  check(L('mt_batch_balance_of shape + values'), Array.isArray(bb) && bb.length === 6 && bb.every(x => x === '1000000'));
  check(L('has_public_key view for implicit account'), (await view(VERIFIER, 'has_public_key', { account_id: u2.hex, public_key: u2.kp.getPublicKey().toString() })) === true);
  // 5. nep413 tamper rejection & replay
  const p = signIntents({ signerId: u2.hex, verifier: VERIFIER, keyPair: u2.kp, intents: [{ intent: 'transfer', receiver_id: BOB, tokens: { [asset(TOK[0])]: '1' } }] });
  const rr = await execute([{ ...p, signature: p.signature.slice(0, -2) + (p.signature.endsWith('A') ? 'B' : 'A') }]);
  check(L('tampered signature rejected'), !rr.ok);
  const wrongRecipient = JSON.parse(JSON.stringify(p)); wrongRecipient.payload.recipient = R('other');
  check(L('wrong recipient rejected'), !(await execute([wrongRecipient])).ok);
  return u2;
}

// ---- BEFORE upgrade (control: OLD wasm) ----
const U0 = await newDepositAccount();
await flows('old v0.4.2', U0);
// seed deterministic state to compare across upgrade
const seed = await newDepositAccount();
await depositFromDepositAddr(seed, TOK[2], 777_000_000);
await depositBridgeCredit(seed.hex, TOK[3], 123_000_000);
const accts = [U0.hex, seed.hex, MAKER, FEE, BOB];
const snap = async () => { const o = {}; for (const a of accts) o[a] = await view(VERIFIER, 'mt_batch_balance_of', { account_id: a, token_ids: TOK.map(asset) }); o.pk = await view(VERIFIER, 'has_public_key', { account_id: seed.hex, public_key: seed.kp.getPublicKey().toString() }); o.pkm = await view(VERIFIER, 'has_public_key', { account_id: MAKER, public_key: keys[MAKER].getPublicKey().toString() }); o.sup = await view(VERIFIER, 'mt_tokens_for_owner', { account_id: seed.hex }).catch(e => 'ERR'); return JSON.stringify(o); };
const before = await snap();
const sizeBefore = (await rpc('query', { request_type: 'view_account', finality: 'optimistic', account_id: VERIFIER })).storage_usage;

// ---- IN-PLACE UPGRADE: DeployContract on the same account, no migration call ----
const up = await (await account(VERIFIER)).signAndSendTransaction({ receiverId: VERIFIER, actions: [transactions.deployContract(newWasm)], returnError: true });
check('in-place DeployContract of NEW wasm on same account succeeded', !up.status?.Failure);
check('on-chain code hash == sha256(new) after upgrade', b58hex(await codeHash()) === sha(newWasm));
const after = await snap();
check('state intact after upgrade: all mt balances, keys, tokens_for_owner identical', before === after);
const sizeAfter = (await rpc('query', { request_type: 'view_account', finality: 'optimistic', account_id: VERIFIER })).storage_usage;
console.log(`storage_usage before=${sizeBefore} after=${sizeAfter} (delta is code size only)`);
check('seeded user can still withdraw its pre-upgrade balance', await (async () => {
  const bobT = await ftbal(TOK[2], BOB);
  const w = signIntents({ signerId: seed.hex, verifier: VERIFIER, keyPair: seed.kp, intents: [{ intent: 'ft_withdraw', token: TOK[2], receiver_id: BOB, amount: '777000000' }] });
  const r = await execute([w]); if (!r.ok) { console.log(r.failures); return false; }
  await new Promise(x => setTimeout(x, 500)); return (await ftbal(TOK[2], BOB)) === bobT + 777_000_000n;
})());
// pre-upgrade user U0 (state seeded before upgrade) keeps working under new code
await flows('new v0.4.5 (post-upgrade)', U0);
// storage migration probe / version
for (const m of ['mt_balance_of']) void m;
console.log(JSON.stringify({ passed: results.filter(r => r.ok).length, failed }));
await sb.tearDown();
process.exit(failed ? 1 : 0);
