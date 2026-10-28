// Solana devnet bridge bootstrap. Idempotent: every step checks what already exists. Testnet/devnet only.
//  1. Solana: relayer/treasury keypair (.secrets/solana-relayer.key), our own devnet USDC + USDT SPL mints (mint authority = relayer;
//     keypairs in .secrets/solana-mint-{usdc,usdt}.key so a devnet reset can be re-created at the SAME addresses), treasury ATAs
//     backed with test tokens.
//  2. NEAR: nep141:sol.tp-omft.testnet (SOL, 9 dec) and nep141:sol-<keccak20(mint)>.tp-omft.testnet (SPL, 6 dec) owned by the Tidepool
//     root (minter for bridge credits), verifier registered, and a small maker inventory deposited into the verifier.
//  3. Records mints, relayer and txs in server/src/bridge-deployments.json (`sol`), setting live=true last.
// Usage: node scripts/bridge-solana-bootstrap.mjs      (fund the treasury first: node scripts/sol-airdrop-topup.mjs)
// Secret keys are read from ../.secrets and never printed.
import fs from 'node:fs';
import nacl from 'tweetnacl';
import { KeyPair } from 'near-api-js';
import { loadKeys, account, mustCall, view, viewAccount, parseNear, TGAS, keyStore, NETWORK } from '../server/src/near.mjs';
import { ROOT, VERIFIER, MAKER, OMFT, toUnits, solOmftSub } from '../server/src/config.mjs';
import * as sol from '../server/src/solana.mjs';

const SECRETS = new URL('../.secrets/', import.meta.url).pathname;
const DEP = new URL('../server/src/bridge-deployments.json', import.meta.url);
const writeKey = (file) => { if (!fs.existsSync(file)) { fs.writeFileSync(file, JSON.stringify(Array.from(nacl.sign.keyPair().secretKey)), { mode: 0o600 }); console.log('generated', file.split('/').pop()); } };
writeKey(SECRETS + 'solana-relayer.key'); writeKey(SECRETS + 'solana-mint-usdc.key'); writeKey(SECRETS + 'solana-mint-usdt.key');
await loadKeys({ dir: SECRETS }); // NEAR keys (*.json); the Solana keys above are *.key so loadKeys skips them

const deployments = JSON.parse(fs.readFileSync(DEP, 'utf8'));
const relayer = sol.relayer();
const mints = { USDC: sol.keypairFromFile(SECRETS + 'solana-mint-usdc.key'), USDT: sol.keypairFromFile(SECRETS + 'solana-mint-usdt.key') };
const d = deployments.sol ||= { name: 'Solana Devnet', cluster: 'devnet', txs: [] };
Object.assign(d, { relayer: relayer.address, tokens: { USDC: mints.USDC.address, USDT: mints.USDT.address }, inventory: { SOL: '100', USDC: '200000', USDT: '200000' } });
d.live ??= false;
const saveDep = () => fs.writeFileSync(DEP, JSON.stringify(deployments, null, 2) + '\n');
const log = (label, hash) => { d.txs.push({ label, hash }); saveDep(); console.log('  ', label, hash); };
saveDep();

const bal = await sol.account(relayer.address);
console.log(`== Solana devnet: treasury ${relayer.address}, ${(Number(bal?.lamports ?? 0n) / 1e9).toFixed(4)} SOL`);
if ((bal?.lamports ?? 0n) < 20_000_000n) throw new Error('treasury needs >= 0.02 SOL: run node scripts/sol-airdrop-topup.mjs first');

const SPL = [{ symbol: 'USDC', decimals: 6 }, { symbol: 'USDT', decimals: 6 }];
for (const b of SPL) {
  const mk = mints[b.symbol];
  if (!(await sol.account(mk.address))) {
    const rent = await sol.minRent(82);
    log(`create ${b.symbol} mint ${mk.address}`, await sol.sendAndConfirm([sol.ix.systemCreateAccount(relayer.publicKey, mk.publicKey, rent, 82, sol.TOKEN_PROGRAM), sol.ix.initializeMint2(mk.publicKey, b.decimals, relayer.publicKey)], [mk]));
  }
  const t = { native: false, mint: mk.address, decimals: b.decimals };
  if ((await sol.treasuryBalance(t)) === 0n) {
    const amt = toUnits(d.inventory[b.symbol], b.decimals);
    log(`back treasury with ${b.symbol}`, await sol.sendAndConfirm([sol.ix.createAtaIdempotent(relayer.publicKey, relayer.address, mk.address), sol.ix.mintTo(mk.address, sol.ataOf(relayer.address, mk.address), relayer.publicKey, amt)]));
  }
}

// ---- NEAR side ----
const step = (s) => console.log('==', s);
if (!(await viewAccount(OMFT))) throw new Error(`${OMFT} is missing: run scripts/bridge-bootstrap.mjs for an EVM chain first`);
const WASM = fs.readFileSync(new URL('../contracts/token/target/near/tidepool_token.wasm', import.meta.url));
const NEAR_TOKENS = [
  { symbol: 'SOL', decimals: 9, id: `sol.${OMFT}`, name: 'Tidepool Testnet SOL on Solana Devnet (bridged, no value)' },
  ...SPL.map(b => ({ ...b, id: `${solOmftSub(mints[b.symbol].address)}.${OMFT}`, name: `Tidepool Testnet ${b.symbol} on Solana Devnet (bridged, no value)` })),
];
for (const b of NEAR_TOKENS) {
  const id = b.id, assetId = `nep141:${id}`;
  if (!(await viewAccount(id))) {
    step(`create ${id}`);
    const kp = KeyPair.fromRandom('ed25519');
    const need = parseNear(1.95);
    const parent = await viewAccount(OMFT);
    if (BigInt(parent.amount) < need + parseNear(0.2)) log(`fund ${OMFT}`, (await (await account(ROOT)).sendMoney(OMFT, need)).transaction.hash);
    // persist the key BEFORE creating the account so an interrupted run can never orphan it
    fs.writeFileSync(SECRETS + id + '.json', JSON.stringify({ account_id: id, public_key: kp.getPublicKey().toString(), private_key: kp.toString() }), { mode: 0o600 });
    const r = await (await account(OMFT)).createAccount(id, kp.getPublicKey(), need - parseNear(0.05));
    await keyStore.setKey(NETWORK, id, kp);
    log(`create ${id}`, r.transaction.hash);
  }
  if ((await viewAccount(id)).code_hash === '11111111111111111111111111111111') {
    log(`deploy ${id}`, (await (await account(id)).deployContract(WASM)).transaction.hash);
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
console.log('done sol', JSON.stringify({ relayer: relayer.address, tokens: d.tokens, assets: NEAR_TOKENS.map(b => `nep141:${b.id}`) }));
