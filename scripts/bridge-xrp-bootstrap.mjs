// XRP Ledger testnet bridge bootstrap. Idempotent: every step checks what already exists. Testnet only.
//  1. The treasury/relayer key (.secrets/xrp-treasury.key: an XRPL family seed, mode 0600), generated if missing and funded from the
//     OFFICIAL XRPL Testnet faucet (https://faucet.altnet.rippletest.net/accounts, 100 XRP per request, no captcha) up to ~400 XRP.
//  2. NEAR: nep141:xrp.tp-omft.testnet (6 decimals, like 1Click's nep141:xrp.omft.near), owned by the Tidepool root (minter for
//     bridge credits), verifier registered, maker inventory deposited into the verifier.
//  3. Records the treasury and txs in server/src/bridge-deployments.json (`xrp`), setting live=true last.
// Usage: node scripts/bridge-xrp-bootstrap.mjs. The seed is read from ../.secrets and never printed.
import fs from 'node:fs';
import { Wallet } from 'xrpl';

const SECRETS = new URL('../.secrets/', import.meta.url).pathname;
const DEP = new URL('../server/src/bridge-deployments.json', import.meta.url);
const kind = 'xrp';
const META = { symbol: 'XRP', label: 'XRP Ledger Testnet', inventory: '20000' };
const deployments = JSON.parse(fs.readFileSync(DEP, 'utf8'));
const d = deployments[kind] ||= { name: META.label, network: 'testnet', txs: [] };
d.txs ||= [];
d.inventory ||= { [META.symbol]: META.inventory };
const saveDep = () => fs.writeFileSync(DEP, JSON.stringify(deployments, null, 2) + '\n');
const keyFile = SECRETS + 'xrp-treasury.key';
if (!fs.existsSync(keyFile)) fs.writeFileSync(keyFile, Wallet.generate().seed + '\n', { mode: 0o600 });
const wallet = Wallet.fromSeed(fs.readFileSync(keyFile, 'utf8').trim());
d.treasury ||= wallet.classicAddress;
if (d.treasury !== wallet.classicAddress) throw new Error('treasury key does not match the recorded treasury address');
d.live ??= false;
saveDep();
process.env.XRP_TREASURY_KEY ||= fs.readFileSync(keyFile, 'utf8').trim();
// server modules read bridge-deployments.json at import time, so load them only now
const { loadKeys, account: nearAccount, mustCall, view, viewAccount, parseNear, TGAS, keyStore, NETWORK } = await import('../server/src/near.mjs');
const { ROOT, VERIFIER, MAKER, OMFT, toUnits } = await import('../server/src/config.mjs');
const { KeyPair } = await import('near-api-js');
const X = await import('../server/src/xrp.mjs');
await loadKeys({ dir: SECRETS });
console.log(`== ${META.label}: treasury ${d.treasury}`);

const step = (s) => console.log('==', s);
const log = (label, hash) => { d.txs.push({ label, hash }); saveDep(); console.log('  ', label, hash); };
// fund the treasury from the official faucet up to ~400 XRP (100 XRP per request)
for (let i = 0; i < 4; i++) {
  const acc = await X.account(d.treasury, 'validated').catch(() => null);
  if (acc && BigInt(acc.Balance) >= 350_000_000n) break;
  const r = await X.faucet(d.treasury);
  log(`fund treasury from the official XRPL faucet (+${r.amount} XRP)`, r.transactionHash);
  await new Promise(r => setTimeout(r, 6000));
}
if (!(await viewAccount(OMFT))) throw new Error(`${OMFT} is missing: run scripts/bridge-bootstrap.mjs for an EVM chain first`);
const WASM = fs.readFileSync(new URL('../contracts/token/target/near/tidepool_token.wasm', import.meta.url));
const b = { symbol: META.symbol, id: `${kind}.${OMFT}`, decimals: 6, name: `Tidepool Testnet ${META.symbol} on ${META.label} (bridged, no value)` };
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
d.live = true; saveDep();
console.log(`done ${kind}`, JSON.stringify({ treasury: d.treasury, asset: assetId }));
