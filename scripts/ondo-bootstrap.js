#!/usr/bin/env node
// Deploy Tidepool Ondo test tokens on Base Sepolia + NEAR NEP-141 mirrors (tp-omdep.testnet).
// Idempotent. Keys from env / .secrets; never printed.
import fs from 'node:fs';
import { ethers } from '../server/node_modules/ethers/lib.esm/index.js';
import { KeyPair } from '../server/node_modules/near-api-js/lib/index.js';
import { loadKeys, account, call, mustCall, view, viewAccount, parseNear, TGAS, keyStore, NETWORK } from '../server/src/near.mjs';
import { ROOT, VERIFIER, MAKER, toUnits } from '../server/src/config.mjs';

const OMDEP = process.env.TIDEPOOL_OMDEP || 'tp-omdep.testnet';
const SECRETS = new URL('../.secrets/', import.meta.url).pathname;
const DEP = new URL('../server/src/ondo-deployments.json', import.meta.url);
const CAT = JSON.parse(fs.readFileSync(new URL('../server/src/ondo-catalog.json', import.meta.url)));
const ART = JSON.parse(fs.readFileSync(new URL('../contracts/evm/artifacts.json', import.meta.url)));
const WASM = fs.readFileSync(new URL('../contracts/token/target/near/tidepool_token.wasm', import.meta.url));

await loadKeys({ dir: SECRETS });
const deployments = JSON.parse(fs.readFileSync(DEP, 'utf8'));
deployments.chain ||= 'base';
deployments.chainId ||= 84532;
deployments.tokens ||= {};
deployments.txs ||= [];
const saveDep = () => fs.writeFileSync(DEP, JSON.stringify(deployments, null, 2) + '\n');
const log = (label, h) => { deployments.txs.push({ label, hash: h, at: new Date().toISOString() }); saveDep(); console.log('  ', label, typeof h === 'string' ? h.slice(0, 18) + '…' : h); };

const rpc = process.env.BASE_SEPOLIA_RPC || 'https://sepolia.base.org';
const provider = new ethers.JsonRpcProvider(rpc, 84532, { staticNetwork: true });
const key = process.env.TIDEPOOL_EVM_RELAYER_KEY;
if (!key) throw new Error('TIDEPOOL_EVM_RELAYER_KEY required');
const wallet = new ethers.NonceManager(new ethers.Wallet(key, provider));
const relayerAddr = await wallet.getAddress();
const gasEth = ethers.formatEther(await provider.getBalance(relayerAddr));
console.log(`== Base Sepolia Ondo deploy: relayer ${relayerAddr}, gas ${gasEth} ETH`);
if (Number(gasEth) < 0.01) {
  console.error(`INSUFFICIENT_GAS need ~0.05 ETH on Base Sepolia for ${CAT.length} deploys; have ${gasEth}`);
  process.exit(2);
}

const vault = JSON.parse(fs.readFileSync(new URL('../server/src/bridge-deployments.json', import.meta.url))).base?.vault;
if (!vault) throw new Error('base vault missing in bridge-deployments.json');
deployments.vault = vault;

async function deployToken(meta) {
  const f = new ethers.ContractFactory(ART.TidepoolTestToken.abi, ART.TidepoolTestToken.bytecode, wallet);
  const drip = toUnits('1', meta.decimals); // 1 token per faucet drip
  const ct = await f.deploy(`Tidepool Testnet ${meta.symbol} (Ondo, no value)`, meta.symbol, meta.decimals, drip);
  const rc = await ct.deploymentTransaction().wait(1);
  const addr = await ct.getAddress();
  log(`deploy ${meta.symbol}`, rc.hash);
  return addr;
}

for (const meta of CAT) {
  if (deployments.tokens[meta.symbol]?.address) continue;
  const address = await deployToken(meta);
  deployments.tokens[meta.symbol] = { address, decimals: meta.decimals, mainnetAddress: meta.mainnetAddress };
  saveDep();
}

// Back vault with inventory (10_000 of each)
for (const meta of CAT) {
  const t = deployments.tokens[meta.symbol];
  if (!t?.address || t.vaultBacked) continue;
  const c = new ethers.Contract(t.address, ART.TidepoolTestToken.abi, wallet);
  const amt = toUnits('10000', meta.decimals);
  const bal = await c.balanceOf(vault);
  if (bal < amt) {
    const rc = await (await c.mint(vault, amt - bal)).wait(1);
    log(`mint vault ${meta.symbol}`, rc.hash);
  }
  t.vaultBacked = true; saveDep();
}
console.log('== EVM done,', Object.keys(deployments.tokens).length, 'tokens');

// ---- NEAR: OMDEP parent + one NEP-141 per token ----
const FUND = parseNear(0.45); // lean funding; FT wasm ~160KB
if (!(await viewAccount(OMDEP).catch(() => null))) {
  console.log('== create', OMDEP);
  const kp = KeyPair.fromRandom('ed25519');
  const r = await mustCall(ROOT, 'testnet', 'create_account', { new_account_id: OMDEP, new_public_key: kp.getPublicKey().toString() }, { deposit: parseNear(2), gas: 100n * TGAS });
  fs.writeFileSync(SECRETS + OMDEP + '.json', JSON.stringify({ account_id: OMDEP, public_key: kp.getPublicKey().toString(), private_key: kp.toString() }), { mode: 0o600 });
  await keyStore.setKey(NETWORK, OMDEP, kp);
  log(`create ${OMDEP}`, r.txHash);
} else {
  try { await loadKeys({ dir: SECRETS }); } catch {}
}

for (const meta of CAT) {
  const evm = deployments.tokens[meta.symbol].address.toLowerCase();
  const id = `bnb-${evm}.${OMDEP}`;
  const assetId = `nep141:${id}`;
  deployments.tokens[meta.symbol].nearContract = id;
  deployments.tokens[meta.symbol].assetId = assetId;
  saveDep();

  if (!(await viewAccount(id).catch(() => null))) {
    console.log('== create', id);
    const kp = KeyPair.fromRandom('ed25519');
    const parent = await viewAccount(OMDEP);
    if (BigInt(parent.amount) < FUND + parseNear(0.3)) {
      log(`fund ${OMDEP}`, (await (await account(ROOT)).sendMoney(OMDEP, FUND + parseNear(0.5))).transaction.hash);
    }
    const r = await (await account(OMDEP)).createAccount(id, kp.getPublicKey(), FUND);
    fs.writeFileSync(SECRETS + id + '.json', JSON.stringify({ account_id: id, public_key: kp.getPublicKey().toString(), private_key: kp.toString() }), { mode: 0o600 });
    await keyStore.setKey(NETWORK, id, kp);
    log(`create ${id}`, r.transaction.hash);
  } else {
    // ensure key is loaded if we have secrets file
    try {
      const raw = JSON.parse(fs.readFileSync(SECRETS + id + '.json', 'utf8'));
      await keyStore.setKey(NETWORK, id, KeyPair.fromString(raw.private_key));
    } catch {}
  }

  const acct = await viewAccount(id);
  if (acct.code_hash === '11111111111111111111111111111111') {
    log(`deploy ${id}`, (await (await account(id)).deployContract(WASM)).transaction.hash);
    log(`init ${id}`, (await mustCall(id, id, 'new', {
      owner_id: ROOT,
      name: `Tidepool Testnet ${meta.symbol} (Ondo on Base Sepolia, no value)`,
      symbol: meta.symbol,
      decimals: meta.decimals,
    })).txHash);
  }
  for (const a of [VERIFIER, ROOT]) {
    if (!(await view(id, 'storage_balance_of', { account_id: a }))) {
      log(`storage ${a} ${meta.symbol}`, (await mustCall(ROOT, id, 'storage_deposit', { account_id: a, registration_only: true }, { deposit: parseNear(0.00125) })).txHash);
    }
  }
  if (BigInt(await view(VERIFIER, 'mt_balance_of', { account_id: MAKER, token_id: assetId })) === 0n) {
    const amt = toUnits('10000', meta.decimals).toString();
    log(`mint ${meta.symbol}`, (await mustCall(ROOT, id, 'mint', { account_id: ROOT, amount: amt })).txHash);
    log(`deposit maker ${meta.symbol}`, (await mustCall(ROOT, id, 'ft_transfer_call', { receiver_id: VERIFIER, amount: amt, msg: MAKER }, { deposit: 1n, gas: 150n * TGAS })).txHash);
  }
  deployments.tokens[meta.symbol].nearReady = true;
  saveDep();
}
deployments.live = true;
deployments.omdep = OMDEP;
saveDep();
console.log('== done live=', deployments.live, 'count=', Object.keys(deployments.tokens).length);
