// Sui testnet bridge bootstrap. Idempotent: every step checks what already exists. Testnet only.
//  1. Sui: the treasury/relayer key (.secrets/sui-treasury.key, a suiprivkey1... string, mode 0600; fund it at https://faucet.sui.io, e.g.
//     `sui client faucet --address <treasury>` then split a coin object out of the faucet's address balance) and Tidepool's own test Move
//     coins TUSDC and TUSDT (scripts/sui-coins, published with `sui client publish`; the treasury holds both TreasuryCaps and mints payouts).
//     The package id and the TreasuryCap ids are passed as SUI_PACKAGE / SUI_CAP_USDC / SUI_CAP_USDT (or already recorded in the json).
//  2. NEAR: nep141:sui.tp-omft.testnet (SUI, 9 dec) and nep141:sui-<keccak20(coin type)>.tp-omft.testnet (USDC/USDT, 6 dec)
//     owned by the Tidepool root (minter for bridge credits), verifier registered, maker inventory deposited into the verifier.
//  3. Records treasury, package, caps and txs in server/src/bridge-deployments.json (`sui`), setting live=true last.
// Usage: node scripts/bridge-sui-bootstrap.mjs      Secret keys are read from ../.secrets and never printed.
import fs from 'node:fs';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { decodeSuiPrivateKey } from '@mysten/sui/cryptography';

const SECRETS = new URL('../.secrets/', import.meta.url).pathname;
const DEP = new URL('../server/src/bridge-deployments.json', import.meta.url);
const treasury = Ed25519Keypair.fromSecretKey(decodeSuiPrivateKey(fs.readFileSync(SECRETS + 'sui-treasury.key', 'utf8').trim()).secretKey);
const deployments = JSON.parse(fs.readFileSync(DEP, 'utf8'));
const d = deployments.sui ||= { name: 'Sui Testnet', network: 'testnet', txs: [] };
const pkg = process.env.SUI_PACKAGE || d.package;
const caps = { USDC: process.env.SUI_CAP_USDC || d.tokens?.USDC?.treasuryCap, USDT: process.env.SUI_CAP_USDT || d.tokens?.USDT?.treasuryCap };
if (!pkg || !caps.USDC || !caps.USDT) throw new Error('publish scripts/sui-coins first and pass SUI_PACKAGE, SUI_CAP_USDC, SUI_CAP_USDT');
Object.assign(d, { treasury: treasury.toSuiAddress(), package: pkg, inventory: { SUI: '100000', USDC: '200000', USDT: '200000' },
  tokens: { USDC: { coinType: `${pkg}::tusdc::TUSDC`, treasuryCap: caps.USDC }, USDT: { coinType: `${pkg}::tusdt::TUSDT`, treasuryCap: caps.USDT } } });
d.live ??= false;
const saveDep = () => fs.writeFileSync(DEP, JSON.stringify(deployments, null, 2) + '\n');
const log = (label, hash) => { d.txs.push({ label, hash }); saveDep(); console.log('  ', label, hash); };
saveDep();

// server modules read bridge-deployments.json at import time, so load them only now
const { loadKeys, account: nearAccount, mustCall, view, viewAccount, parseNear, TGAS, keyStore, NETWORK } = await import('../server/src/near.mjs');
const { ROOT, VERIFIER, MAKER, OMFT, toUnits, suiOmftSub } = await import('../server/src/config.mjs');
const { KeyPair } = await import('near-api-js');
const sui = await import('../server/src/sui.mjs');
await loadKeys({ dir: SECRETS });

console.log(`== Sui testnet: treasury ${d.treasury}, package ${pkg}`);
// the treasury must own both TreasuryCaps (proved by minting 1 base unit of each) and hold SUI coin objects for gas
const gas = await sui.coinsOf(d.treasury, '0x2::sui::SUI');
if (gas.reduce((a, c) => a + c.balance, 0n) < 1_000_000_000n) throw new Error('treasury holds under 1 SUI in coin objects; fund it first (https://faucet.sui.io)');
const probe = await sui.sendAndConfirm(() => sui.prepareFaucetMint(d.treasury, Object.entries(d.tokens).map(([symbol, v]) => ({ symbol, ...v, dripUnits: 1n }))));
log('verify TreasuryCaps (mint 1 base unit of each test coin to the treasury)', probe);

// ---- NEAR side ----
const step = (s) => console.log('==', s);
if (!(await viewAccount(OMFT))) throw new Error(`${OMFT} is missing: run scripts/bridge-bootstrap.mjs for an EVM chain first`);
const WASM = fs.readFileSync(new URL('../contracts/token/target/near/tidepool_token.wasm', import.meta.url));
const NEAR_TOKENS = [
  { symbol: 'SUI', id: `sui.${OMFT}`, decimals: 9, name: 'Tidepool Testnet SUI on Sui Testnet (bridged, no value)' },
  ...['USDC', 'USDT'].map(s => ({ symbol: s, decimals: 6, id: `${suiOmftSub(d.tokens[s].coinType)}.${OMFT}`, name: `Tidepool Testnet ${s} on Sui Testnet (bridged, no value)` })),
];
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
console.log('done sui', JSON.stringify({ treasury: d.treasury, package: d.package, assets: NEAR_TOKENS.map(b => `nep141:${b.id}`) }));
