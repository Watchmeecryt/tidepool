// Bitcoin testnet4 / Zcash testnet bridge bootstrap. Idempotent: every step checks what already exists. Testnet only.
//  1. The treasury/relayer key (.secrets/btc-treasury.key or .secrets/zec-treasury.key: a 32-byte hex HD seed, mode 0600). Fund the
//     treasury address from the public faucets (tBTC: cypherfaucet.com/btc-testnet, TAZ: faucet.testnet.valargroup.dev).
//  2. NEAR: nep141:btc.tp-omft.testnet / nep141:zec.tp-omft.testnet (8 decimals, like 1Click's nep141:btc.omft.near / zec.omft.near),
//     owned by the Tidepool root (minter for bridge credits), verifier registered, maker inventory deposited into the verifier.
//  3. Records the treasury and txs in server/src/bridge-deployments.json (`btc` / `zec`), setting live=true last.
// Usage: node scripts/bridge-utxo-bootstrap.mjs btc|zec   (or scripts/bridge-btc-bootstrap.mjs / bridge-zec-bootstrap.mjs)
// Secret keys are read from ../.secrets and never printed.
import fs from 'node:fs';

const kind = process.argv[2];
if (!['btc', 'zec'].includes(kind)) throw new Error('usage: node scripts/bridge-utxo-bootstrap.mjs btc|zec');
const SECRETS = new URL('../.secrets/', import.meta.url).pathname;
const DEP = new URL('../server/src/bridge-deployments.json', import.meta.url);
const META = {
  btc: { symbol: 'BTC', label: 'Bitcoin Testnet4', inventory: '20', mod: '../server/src/btc.mjs' },
  zec: { symbol: 'ZEC', label: 'Zcash Testnet', inventory: '2000', mod: '../server/src/zec.mjs' },
}[kind];
const deployments = JSON.parse(fs.readFileSync(DEP, 'utf8'));
const d = deployments[kind] ||= { name: META.label, network: kind === 'btc' ? 'testnet4' : 'testnet', txs: [] };
d.txs ||= [];
d.inventory ||= { [META.symbol]: META.inventory };
// the treasury address is derived from the secret seed (never printed) by the server module of the chain
const saveDep = () => fs.writeFileSync(DEP, JSON.stringify(deployments, null, 2) + '\n');
if (!d.treasury) {
  process.env[kind === 'btc' ? 'BTC_TREASURY_KEY' : 'ZEC_TREASURY_KEY'] ||= fs.readFileSync(SECRETS + `${kind}-treasury.key`, 'utf8').trim();
  d.treasury = (await import(META.mod)).treasury().address;
}
d.live ??= false;
saveDep();
// server modules read bridge-deployments.json at import time, so load them only now
const { loadKeys, account: nearAccount, mustCall, view, viewAccount, parseNear, TGAS, keyStore, NETWORK } = await import('../server/src/near.mjs');
const { ROOT, VERIFIER, MAKER, OMFT, toUnits } = await import('../server/src/config.mjs');
const { KeyPair } = await import('near-api-js');
await loadKeys({ dir: SECRETS });
const chain = await import(META.mod);
if (chain.treasury().address !== d.treasury) throw new Error('treasury key does not match the recorded treasury address');
console.log(`== ${META.label}: treasury ${d.treasury}`);

const step = (s) => console.log('==', s);
const log = (label, hash) => { d.txs.push({ label, hash }); saveDep(); console.log('  ', label, hash); };
if (!(await viewAccount(OMFT))) throw new Error(`${OMFT} is missing: run scripts/bridge-bootstrap.mjs for an EVM chain first`);
const WASM = fs.readFileSync(new URL('../contracts/token/target/near/tidepool_token.wasm', import.meta.url));
const b = { symbol: META.symbol, id: `${kind}.${OMFT}`, decimals: 8, name: `Tidepool Testnet ${META.symbol} on ${META.label} (bridged, no value)` };
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
