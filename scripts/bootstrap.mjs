// One-time testnet bootstrap for Tidepool. Idempotent: skips finished steps.
// Keys live in ../.secrets (gitignored) and are never printed.
import fs from 'node:fs';
import { KeyPair } from 'near-api-js';
import { loadKeys, account, call, mustCall, view, viewAccount, parseNear, TGAS, keyStore, NETWORK } from '../server/src/near.mjs';
import { ROOT, VERIFIER, MAKER, TOKENS, toUnits, VERIFIER_WASM_SHA256 } from '../server/src/config.mjs';
import crypto from 'node:crypto';

const SECRETS = new URL('../.secrets/', import.meta.url).pathname;
await loadKeys({ dir: SECRETS });
const step = (s) => console.log('==', s);
const W = (p) => fs.readFileSync(new URL(p, import.meta.url));
const txs = [];
const log = (label, h) => { txs.push({ label, h }); console.log('  ', label, h); };

for (const f of ['tidepool-f1.testnet', 'tidepool-f2.testnet', 'tidepool-f3.testnet', 'tidepool-f4.testnet']) {
  if (!(await viewAccount(f))) continue;
  step(`sweep ${f} -> ${ROOT}`);
  const r = await (await account(f)).deleteAccount(ROOT); log('sweep ' + f, r.transaction.hash);
  fs.rmSync(SECRETS + f + '.json', { force: true });
}

async function sub(name, near) {
  const id = `${name}.${ROOT}`;
  if (await viewAccount(id)) return id;
  step(`create ${id}`);
  const kp = KeyPair.fromRandom('ed25519');
  const r = await (await account(ROOT)).createAccount(id, kp.getPublicKey(), parseNear(near)); log('create ' + id, r.transaction.hash);
  fs.writeFileSync(SECRETS + id + '.json', JSON.stringify({ account_id: id, public_key: kp.getPublicKey().toString(), private_key: kp.toString() }), { mode: 0o600 });
  await keyStore.setKey(NETWORK, id, kp);
  return id;
}
const hasCode = async (id) => (await viewAccount(id))?.code_hash !== '11111111111111111111111111111111';
async function deploy(id, wasmPath, init, args) {
  if (!(await hasCode(id))) { step(`deploy ${id}`); const r = await (await account(id)).deployContract(W(wasmPath)); log('deploy ' + id, r.transaction.hash); }
  const r = await call(id, id, init, args, { gas: 100n * TGAS });
  if (r.ok) log('init ' + id, r.txHash);
  else if (!r.failures.join().match(/already been initialized|AlreadyInitialized|already initialized/i)) throw new Error(r.failures.join());
}

const wasm = W('../contracts/verifier/defuse.wasm');
if (crypto.createHash('sha256').update(wasm).digest('hex') !== VERIFIER_WASM_SHA256) throw new Error('verifier wasm sha256 mismatch');
await sub('verifier', 16);
await deploy(VERIFIER, '../contracts/verifier/defuse.wasm', 'new', { config: { wnear_id: 'wrap.testnet', fees: { fee: 0, fee_collector: ROOT }, roles: { super_admins: [ROOT], admins: {}, grantees: {} } } });
await sub('maker', 1.5);

for (const t of TOKENS) {
  await sub(t.sub, 2.2);
  await deploy(t.contractAddress, '../contracts/token/target/near/tidepool_token.wasm', 'new', { owner_id: ROOT, name: t.name, symbol: t.symbol, decimals: t.decimals });
  if (!(await view(t.contractAddress, 'storage_balance_of', { account_id: VERIFIER }))) {
    step(`register verifier on ${t.symbol}`);
    log('storage ' + t.symbol, (await mustCall(ROOT, t.contractAddress, 'storage_deposit', { account_id: VERIFIER, registration_only: true }, { deposit: parseNear(0.00125) })).txHash);
  }
  const have = BigInt(await view(VERIFIER, 'mt_balance_of', { account_id: MAKER, token_id: t.assetId }));
  if (have === 0n) {
    step(`maker inventory ${t.symbol}`);
    const amt = toUnits(t.inventory, t.decimals).toString();
    log('mint ' + t.symbol, (await mustCall(ROOT, t.contractAddress, 'mint', { account_id: ROOT, amount: amt })).txHash);
    log('deposit ' + t.symbol, (await mustCall(ROOT, t.contractAddress, 'ft_transfer_call', { receiver_id: VERIFIER, amount: amt, msg: MAKER }, { deposit: 1n, gas: 150n * TGAS })).txHash);
  }
}
fs.writeFileSync(new URL('../deployment.json', import.meta.url), JSON.stringify({ root: ROOT, verifier: VERIFIER, maker: MAKER, verifierWasmSha256: VERIFIER_WASM_SHA256, tokens: TOKENS.map(t => t.assetId), bootstrapTxs: txs }, null, 2));
console.log('done');
