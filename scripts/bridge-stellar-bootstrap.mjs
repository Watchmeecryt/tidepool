// Stellar testnet bridge bootstrap. Idempotent: every step checks what already exists. Testnet only.
//  1. Stellar: treasury/relayer + issuer keypairs (.secrets/stellar-{treasury,issuer}.key, mode 0600), both funded by Friendbot,
//     our own classic test assets USDC and USDT (issuer = ours), treasury trustlines + backing balance.
//  2. NEAR: nep141:stellar.tp-omft.testnet (XLM, 7 dec) and nep141:stellar-<keccak20(SAC id)>.tp-omft.testnet (USDC/USDT, 7 dec)
//     owned by the Tidepool root (minter for bridge credits), verifier registered, maker inventory deposited into the verifier.
//  3. Records treasury, issuer and txs in server/src/bridge-deployments.json (`stellar`), setting live=true last.
// Usage: node scripts/bridge-stellar-bootstrap.mjs      Secret keys are read from ../.secrets and never printed.
import fs from 'node:fs';
import { Keypair, TransactionBuilder, Operation, Asset, Networks, Account } from '@stellar/stellar-base';

const SECRETS = new URL('../.secrets/', import.meta.url).pathname;
const DEP = new URL('../server/src/bridge-deployments.json', import.meta.url);
const genKey = (file) => { if (!fs.existsSync(file)) { fs.writeFileSync(file, Keypair.random().secret() + '\n', { mode: 0o600 }); console.log('generated', file.split('/').pop()); } return Keypair.fromSecret(fs.readFileSync(file, 'utf8').trim()); };
const treasury = genKey(SECRETS + 'stellar-treasury.key'), issuer = genKey(SECRETS + 'stellar-issuer.key');
const deployments = JSON.parse(fs.readFileSync(DEP, 'utf8'));
const d = deployments.stellar ||= { name: 'Stellar Testnet', network: 'testnet', txs: [] };
Object.assign(d, { treasury: treasury.publicKey(), issuer: issuer.publicKey(), tokens: { USDC: { code: 'USDC', issuer: issuer.publicKey() }, USDT: { code: 'USDT', issuer: issuer.publicKey() } }, inventory: { XLM: '100000', USDC: '200000', USDT: '200000' } });
d.live ??= false;
const saveDep = () => fs.writeFileSync(DEP, JSON.stringify(deployments, null, 2) + '\n');
const log = (label, hash) => { d.txs.push({ label, hash }); saveDep(); console.log('  ', label, hash); };
saveDep();

// server modules read bridge-deployments.json at import time, so load them only now
const { loadKeys, account: nearAccount, mustCall, view, viewAccount, parseNear, TGAS, keyStore, NETWORK } = await import('../server/src/near.mjs');
const { ROOT, VERIFIER, MAKER, OMFT, toUnits, stellarOmftSub } = await import('../server/src/config.mjs');
const { KeyPair } = await import('near-api-js');
const st = await import('../server/src/stellar.mjs');
await loadKeys({ dir: SECRETS });

async function submitAs(kp, addOps) {
  const acc = await st.horizon(`/accounts/${kp.publicKey()}`);
  const b = new TransactionBuilder(new Account(kp.publicKey(), acc.sequence), { fee: '2000', networkPassphrase: Networks.TESTNET, timebounds: { minTime: 0, maxTime: Math.floor(Date.now() / 1000) + 120 } });
  addOps(b); const tx = b.build(); tx.sign(kp);
  const r = await st.horizon('/transactions', { method: 'POST', form: { tx: tx.toEnvelope().toXDR('base64') } });
  return r.hash;
}
console.log(`== Stellar testnet: treasury ${treasury.publicKey()}, issuer ${issuer.publicKey()}`);
for (const kp of [issuer, treasury]) if (!(await st.account(kp.publicKey()))) { await st.friendbot(kp.publicKey()); console.log('  friendbot funded', kp.publicKey()); }
const tre = await st.account(treasury.publicKey());
for (const sym of ['USDC', 'USDT']) {
  const t = { code: sym, issuer: issuer.publicKey(), symbol: sym };
  if (!st.hasTrustline(tre, t)) log(`treasury trustline ${sym}`, await submitAs(treasury, b => b.addOperation(Operation.changeTrust({ asset: new Asset(sym, issuer.publicKey()) }))));
  const cur = st.balanceOf(await st.account(treasury.publicKey()), t);
  const want = toUnits(d.inventory[sym], 7) * 5n; // 5x the maker inventory: the treasury only pays out what NEAR-side users burn
  if (cur < want / 2n) log(`issue ${want - cur} stroops of ${sym} to treasury`, await submitAs(issuer, b => b.addOperation(Operation.payment({ destination: treasury.publicKey(), asset: new Asset(sym, issuer.publicKey()), amount: st.amountStr(want - cur) }))));
}

// ---- NEAR side ----
const step = (s) => console.log('==', s);
if (!(await viewAccount(OMFT))) throw new Error(`${OMFT} is missing: run scripts/bridge-bootstrap.mjs for an EVM chain first`);
const WASM = fs.readFileSync(new URL('../contracts/token/target/near/tidepool_token.wasm', import.meta.url));
const NEAR_TOKENS = [
  { symbol: 'XLM', id: `stellar.${OMFT}`, name: 'Tidepool Testnet XLM on Stellar Testnet (bridged, no value)' },
  ...['USDC', 'USDT'].map(s => ({ symbol: s, id: `${stellarOmftSub(s, issuer.publicKey())}.${OMFT}`, name: `Tidepool Testnet ${s} on Stellar Testnet (bridged, no value)` })),
].map(b => ({ ...b, decimals: 7 }));
for (const b of NEAR_TOKENS) {
  const id = b.id, assetId = `nep141:${id}`;
  if (!(await viewAccount(id))) {
    step(`create ${id}`);
    const kp = KeyPair.fromRandom('ed25519');
    const need = parseNear(1.95);
    const parent = await viewAccount(OMFT);
    if (BigInt(parent.amount) < need + parseNear(0.2)) log(`fund ${OMFT}`, (await (await nearAccount(ROOT)).sendMoney(OMFT, need)).transaction.hash);
    // persist the key BEFORE creating the account so an interrupted run can never orphan it
    fs.writeFileSync(SECRETS + id + '.json', JSON.stringify({ account_id: id, public_key: kp.getPublicKey().toString(), private_key: kp.toString() }), { mode: 0o600 });
    const r = await (await nearAccount(OMFT)).createAccount(id, kp.getPublicKey(), need - parseNear(0.05));
    await keyStore.setKey(NETWORK, id, kp);
    log(`create ${id}`, r.transaction.hash);
  }
  if ((await viewAccount(id)).code_hash === '11111111111111111111111111111111') {
    log(`deploy ${id}`, (await (await nearAccount(id)).deployContract(WASM)).transaction.hash);
    log(`init ${id}`, (await mustCall(id, id, 'new', { owner_id: ROOT, name: b.name, symbol: b.symbol, decimals: b.decimals })).txHash);
  }
  for (const acct of [VERIFIER, ROOT]) if (!(await view(id, 'storage_balance_of', { account_id: acct }))) log(`storage ${acct} on ${b.symbol}`, (await mustCall(ROOT, id, 'storage_deposit', { account_id: acct, registration_only: true }, { deposit: parseNear(0.00125) })).txHash);
  if (BigInt(await view(VERIFIER, 'mt_balance_of', { account_id: MAKER, token_id: assetId })) === 0n) {
    const amt = toUnits(d.inventory[b.symbol], b.decimals).toString();
    log(`mint maker inventory ${b.symbol}`, (await mustCall(ROOT, id, 'mint', { account_id: ROOT, amount: amt })).txHash);
    log(`deposit maker inventory ${b.symbol}`, (await mustCall(ROOT, id, 'ft_transfer_call', { receiver_id: VERIFIER, amount: amt, msg: MAKER }, { deposit: 1n, gas: 150n * TGAS })).txHash);
  }
}
d.live = true; saveDep();
console.log('done stellar', JSON.stringify({ treasury: d.treasury, issuer: d.issuer, assets: NEAR_TOKENS.map(b => `nep141:${b.id}`) }));
