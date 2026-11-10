// Hyperliquid testnet (HyperCore) destination bootstrap. Idempotent. Testnet only.
// Reuses the existing EVM relayer address as the HyperCore treasury (no new wallet).
// Deploys nep141:hypercore.tp-omft.testnet (6 decimals), registers storage, mints maker inventory
// into the verifier, then sets live=true in server/src/bridge-deployments.json.
// Usage: node scripts/bridge-hyperliquid-bootstrap.js
// Never prints keys.
import fs from 'node:fs';
import { createRequire } from 'node:module';
const SECRETS = new URL('../.secrets/', import.meta.url).pathname;
const DEP = new URL('../server/src/bridge-deployments.json', import.meta.url);
const { relayerAddress } = await import('../server/src/evm.mjs');
const TREASURY = relayerAddress() || '0x55F2c8044D790e1b8369508c31c756c0c2Ca0E93';
const deployments = JSON.parse(fs.readFileSync(DEP, 'utf8'));
const d = deployments.hypercore ||= { name: 'Hyperliquid Testnet', network: 'testnet', txs: [] };
d.txs ||= [];
d.inventory ||= { USDC: '200000' };
d.treasury ||= TREASURY;
if (d.treasury.toLowerCase() !== TREASURY.toLowerCase()) throw new Error('recorded treasury does not match the EVM relayer address');
d.treasury = TREASURY;
d.live ??= false;
const saveDep = () => fs.writeFileSync(DEP, JSON.stringify(deployments, null, 2) + '\n');
saveDep();

const { loadKeys, account: nearAccount, mustCall, view, viewAccount, parseNear, TGAS, keyStore, NETWORK } = await import('../server/src/near.mjs');
const { ROOT, VERIFIER, MAKER, OMFT, toUnits } = await import('../server/src/config.mjs');
const { KeyPair } = createRequire(new URL('../server/package.json', import.meta.url))('near-api-js');
await loadKeys({ dir: SECRETS });
console.log('== Hyperliquid Testnet: treasury', d.treasury);

const log = (label, hash) => { d.txs.push({ label, hash }); saveDep(); console.log('  ', label, hash); };
if (!(await viewAccount(OMFT))) throw new Error(`${OMFT} is missing: run an EVM bridge bootstrap first`);
const WASM = fs.readFileSync(new URL('../contracts/token/target/near/tidepool_token.wasm', import.meta.url));
const id = `hypercore.${OMFT}`, assetId = `nep141:${id}`, decimals = 6, symbol = 'USDC';
const name = 'Tidepool Testnet USDC on Hyperliquid Testnet (HyperCore, no value)';
if (!(await viewAccount(id))) {
  const kp = KeyPair.fromRandom('ed25519');
  const need = parseNear(1.95);
  const parent = await viewAccount(OMFT);
  if (BigInt(parent.amount) < need + parseNear(0.2)) log(`fund ${OMFT}`, (await (await nearAccount(ROOT)).sendMoney(OMFT, need)).transaction.hash);
  fs.writeFileSync(SECRETS + id + '.json', JSON.stringify({ account_id: id, public_key: kp.getPublicKey().toString(), private_key: kp.toString() }), { mode: 0o600 });
  const r = await (await nearAccount(OMFT)).createAccount(id, kp.getPublicKey(), need - parseNear(0.05));
  await keyStore.setKey(NETWORK, id, kp);
  log(`create ${id}`, r.transaction.hash);
}
if ((await viewAccount(id)).code_hash === '11111111111111111111111111111111') {
  log(`deploy ${id}`, (await (await nearAccount(id)).deployContract(WASM)).transaction.hash);
  log(`init ${id}`, (await mustCall(id, id, 'new', { owner_id: ROOT, name, symbol, decimals })).txHash);
}
for (const acct of [VERIFIER, ROOT]) if (!(await view(id, 'storage_balance_of', { account_id: acct }))) log(`storage ${acct} on ${symbol}`, (await mustCall(ROOT, id, 'storage_deposit', { account_id: acct, registration_only: true }, { deposit: parseNear(0.00125) })).txHash);
if (BigInt(await view(VERIFIER, 'mt_balance_of', { account_id: MAKER, token_id: assetId })) === 0n) {
  const amt = toUnits(d.inventory.USDC, decimals).toString();
  log(`mint maker inventory ${symbol}`, (await mustCall(ROOT, id, 'mint', { account_id: ROOT, amount: amt })).txHash);
  log(`deposit maker inventory ${symbol}`, (await mustCall(ROOT, id, 'ft_transfer_call', { receiver_id: VERIFIER, amount: amt, msg: MAKER }, { deposit: 1n, gas: 150n * TGAS })).txHash);
}
d.live = true; saveDep();
console.log('done hypercore', JSON.stringify({ treasury: d.treasury, asset: assetId }));
