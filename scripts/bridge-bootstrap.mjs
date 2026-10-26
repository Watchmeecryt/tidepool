// Testnet EVM bridge bootstrap for one chain (base | arb | eth). Idempotent.
//  1. EVM: deploy TidepoolTestToken USDC + USDT and TidepoolVault (relayer = TIDEPOOL_EVM_RELAYER_KEY),
//     back the vault with test ERC-20s.
//  2. NEAR: create tp-omft.testnet (once) and one NEP-141 per ERC-20 at <chain>-<erc20>.tp-omft.testnet,
//     owner = Tidepool root (minter for bridge credits), register the verifier and give the maker inventory.
// Usage: TIDEPOOL_EVM_RELAYER_KEY=... node scripts/bridge-bootstrap.mjs base
// Keys are read from ../.secrets and env and never printed.
import fs from 'node:fs';
import { ethers } from '../server/node_modules/ethers/lib.esm/index.js';
import { KeyPair } from 'near-api-js';
import { loadKeys, account, call, mustCall, view, viewAccount, parseNear, TGAS, keyStore, NETWORK } from '../server/src/near.mjs';
import { ROOT, VERIFIER, MAKER, OMFT, EVM_CHAINS, toUnits } from '../server/src/config.mjs';

const chainKey = process.argv[2];
const c = EVM_CHAINS.find(x => x.key === chainKey);
if (!c) throw new Error('usage: bridge-bootstrap.mjs base|arb|eth');
const SECRETS = new URL('../.secrets/', import.meta.url).pathname;
const DEP = new URL('../server/src/bridge-deployments.json', import.meta.url);
const ART = JSON.parse(fs.readFileSync(new URL('../contracts/evm/artifacts.json', import.meta.url)));
await loadKeys({ dir: SECRETS });
const deployments = JSON.parse(fs.readFileSync(DEP, 'utf8'));
const d = deployments[c.key] ||= { name: c.name, chainId: c.chainId, tokens: {}, txs: [] };
const saveDep = () => fs.writeFileSync(DEP, JSON.stringify(deployments, null, 2) + '\n');
const log = (label, h) => { d.txs.push({ label, hash: h }); saveDep(); console.log('  ', label, h); };

const provider = new ethers.JsonRpcProvider(c.rpc, c.chainId, { staticNetwork: true });
const wallet = new ethers.NonceManager(new ethers.Wallet(process.env.TIDEPOOL_EVM_RELAYER_KEY, provider));
const relayerAddr = await wallet.getAddress();
console.log(`== ${c.name}: relayer ${relayerAddr}, gas ${ethers.formatEther(await provider.getBalance(relayerAddr))} ETH`);

async function deploy(name, args, label) {
  const f = new ethers.ContractFactory(ART[name].abi, ART[name].bytecode, wallet);
  const ct = await f.deploy(...args);
  const rc = await ct.deploymentTransaction().wait(1);
  log(label, rc.hash);
  d.deployBlock ||= rc.blockNumber;
  return await ct.getAddress();
}
const BRIDGED = [{ symbol: 'USDC', decimals: 6 }, { symbol: 'USDT', decimals: 6 }];
for (const b of BRIDGED) {
  if (d.tokens[b.symbol]) continue;
  d.tokens[b.symbol] = await deploy('TidepoolTestToken', [`Tidepool Testnet ${b.symbol} (no value)`, b.symbol, b.decimals, toUnits('100', b.decimals)], `deploy ${b.symbol}`);
  saveDep();
}
if (!d.vault) { d.vault = await deploy('TidepoolVault', [relayerAddr], 'deploy TidepoolVault'); d.forwarderInitCodeHash = ART.forwarderInitCodeHash; saveDep(); }
const vault = new ethers.Contract(d.vault, ART.TidepoolVault.abi, wallet);
const salt = ethers.keccak256(ethers.toUtf8Bytes('tidepool-selftest'));
if ((await vault.depositAddress(salt)) !== ethers.getCreate2Address(d.vault, salt, d.forwarderInitCodeHash)) throw new Error('deposit address derivation mismatch');
for (const b of BRIDGED) {
  const t = new ethers.Contract(d.tokens[b.symbol], ART.TidepoolTestToken.abi, wallet);
  if ((await t.balanceOf(d.vault)) === 0n) log(`back vault with ${b.symbol}`, (await (await t.mint(d.vault, toUnits('200000', b.decimals))).wait(1)).hash);
}

// ---- NEAR side ----
const step = (s) => console.log('==', s);
if (!(await viewAccount(OMFT))) {
  step(`create ${OMFT}`);
  const kp = KeyPair.fromRandom('ed25519');
  const r = await mustCall(ROOT, 'testnet', 'create_account', { new_account_id: OMFT, new_public_key: kp.getPublicKey().toString() }, { deposit: parseNear(0.5), gas: 100n * TGAS });
  fs.writeFileSync(SECRETS + OMFT + '.json', JSON.stringify({ account_id: OMFT, public_key: kp.getPublicKey().toString(), private_key: kp.toString() }), { mode: 0o600 });
  await keyStore.setKey(NETWORK, OMFT, kp);
  log(`create ${OMFT}`, r.txHash);
}
const WASM = fs.readFileSync(new URL('../contracts/token/target/near/tidepool_token.wasm', import.meta.url));
for (const b of BRIDGED) {
  const id = `${c.key}-${d.tokens[b.symbol].toLowerCase()}.${OMFT}`;
  const assetId = `nep141:${id}`;
  if (!(await viewAccount(id))) {
    step(`create ${id}`);
    const kp = KeyPair.fromRandom('ed25519');
    // fund the parent so it can create the token account
    const need = parseNear(1.95);
    const parent = await viewAccount(OMFT);
    if (BigInt(parent.amount) < need + parseNear(0.2)) log(`fund ${OMFT}`, (await (await account(ROOT)).sendMoney(OMFT, need)).transaction.hash);
    const r = await (await account(OMFT)).createAccount(id, kp.getPublicKey(), need - parseNear(0.05));
    fs.writeFileSync(SECRETS + id + '.json', JSON.stringify({ account_id: id, public_key: kp.getPublicKey().toString(), private_key: kp.toString() }), { mode: 0o600 });
    await keyStore.setKey(NETWORK, id, kp);
    log(`create ${id}`, r.transaction.hash);
  }
  if ((await viewAccount(id)).code_hash === '11111111111111111111111111111111') {
    log(`deploy ${id}`, (await (await account(id)).deployContract(WASM)).transaction.hash);
    log(`init ${id}`, (await mustCall(id, id, 'new', { owner_id: ROOT, name: `Tidepool Testnet ${b.symbol} on ${c.name} (bridged, no value)`, symbol: b.symbol, decimals: b.decimals })).txHash);
  }
  for (const acct of [VERIFIER, ROOT]) if (!(await view(id, 'storage_balance_of', { account_id: acct }))) log(`storage ${acct} on ${b.symbol}`, (await mustCall(ROOT, id, 'storage_deposit', { account_id: acct, registration_only: true }, { deposit: parseNear(0.00125) })).txHash);
  if (BigInt(await view(VERIFIER, 'mt_balance_of', { account_id: MAKER, token_id: assetId })) === 0n) {
    const amt = toUnits('200000', b.decimals).toString();
    log(`mint maker inventory ${b.symbol}`, (await mustCall(ROOT, id, 'mint', { account_id: ROOT, amount: amt })).txHash);
    log(`deposit maker inventory ${b.symbol}`, (await mustCall(ROOT, id, 'ft_transfer_call', { receiver_id: VERIFIER, amount: amt, msg: MAKER }, { deposit: 1n, gas: 150n * TGAS })).txHash);
  }
}
console.log('done', c.key, JSON.stringify({ vault: d.vault, tokens: d.tokens }));
