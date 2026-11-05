// Native ETH bootstrap for the EVM testnet bridges (ORIGIN_CHAIN deposits + DESTINATION_CHAIN payouts). Idempotent: every step checks what already exists. Testnet only.
//  NEAR side per chain: nep141:<chain>.tp-omft.testnet (18 decimals, like 1Click's nep141:eth.omft.near / base.omft.near / arb.omft.near),
//  owned by the Tidepool root, verifier registered, maker inventory deposited. Payouts are plain
//  ETH transfers from the existing relayer (TIDEPOOL_EVM_RELAYER_KEY), so keep the relayer funded from the public faucets.
//  Records the txs in server/src/bridge-deployments.json (`<chain>.nativeEth`), setting live=true last.
// Usage: node scripts/bridge-native-eth-bootstrap.js eth|base|arb [inventoryEth]   (keys are read from ../.secrets and never printed)
import fs from 'node:fs';
import { KeyPair } from 'near-api-js';

const chainKey = process.argv[2];
const SECRETS = new URL('../.secrets/', import.meta.url).pathname;
const DEP = new URL('../server/src/bridge-deployments.json', import.meta.url);
const deployments = JSON.parse(fs.readFileSync(DEP, 'utf8'));
const d = deployments[chainKey];
if (!['eth', 'base', 'arb'].includes(chainKey) || !d?.vault) throw new Error('usage: node scripts/bridge-native-eth-bootstrap.js eth|base|arb [inventoryEth] (run bridge-bootstrap.mjs for the chain first)');
const n = d.nativeEth ||= { txs: [], live: false };
n.inventory ||= process.argv[3] || (chainKey === 'eth' ? '0.05' : '0.02');
const saveDep = () => fs.writeFileSync(DEP, JSON.stringify(deployments, null, 2) + '\n');
saveDep();
const { loadKeys, account: nearAccount, mustCall, view, viewAccount, parseNear, TGAS, keyStore, NETWORK } = await import('../server/src/near.mjs');
const { ROOT, VERIFIER, MAKER, OMFT, toUnits } = await import('../server/src/config.mjs');
await loadKeys({ dir: SECRETS });

const log = (label, hash) => { n.txs.push({ label, hash }); saveDep(); console.log('  ', label, hash); };
if (!(await viewAccount(OMFT))) throw new Error(`${OMFT} is missing: run scripts/bridge-bootstrap.mjs for an EVM chain first`);
const WASM = fs.readFileSync(new URL('../contracts/token/target/near/tidepool_token.wasm', import.meta.url));
const label = d.name;
const id = `${chainKey}.${OMFT}`, assetId = `nep141:${id}`, decimals = 18;
if (!(await viewAccount(id))) {
  console.log('==', `create ${id}`);
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
  log(`init ${id}`, (await mustCall(id, id, 'new', { owner_id: ROOT, name: `Tidepool Testnet ETH on ${label} (bridged, no value)`, symbol: 'ETH', decimals })).txHash);
}
// the bridge account receives ft_withdraw burns for payouts: register it too
for (const acct of [VERIFIER, ROOT]) if (!(await view(id, 'storage_balance_of', { account_id: acct }))) log(`storage ${acct} on ETH`, (await mustCall(ROOT, id, 'storage_deposit', { account_id: acct, registration_only: true }, { deposit: parseNear(0.00125) })).txHash);
if (BigInt(await view(VERIFIER, 'mt_balance_of', { account_id: MAKER, token_id: assetId })) === 0n) {
  const amt = toUnits(n.inventory, decimals).toString();
  log(`mint maker inventory ETH`, (await mustCall(ROOT, id, 'mint', { account_id: ROOT, amount: amt })).txHash);
  log(`deposit maker inventory ETH`, (await mustCall(ROOT, id, 'ft_transfer_call', { receiver_id: VERIFIER, amount: amt, msg: MAKER }, { deposit: 1n, gas: 150n * TGAS })).txHash);
}
n.live = true; saveDep();
console.log('done', chainKey, JSON.stringify({ asset: assetId, inventory: n.inventory }));
