// Top up the maker's testnet-SOL inventory in the verifier to TARGET (default 100 SOL). NEAR test token only: uses no devnet SOL.
// Usage: node scripts/sol-maker-topup.mjs [targetSol]
import fs from 'node:fs';
import { loadKeys, mustCall, view, TGAS } from '../server/src/near.mjs';
import { ROOT, VERIFIER, MAKER, OMFT, toUnits } from '../server/src/config.mjs';
const DEP = new URL('../server/src/bridge-deployments.json', import.meta.url);
await loadKeys({ dir: new URL('../.secrets/', import.meta.url).pathname });
const id = `sol.${OMFT}`, assetId = `nep141:${id}`, target = toUnits(process.argv[2] || '100', 9);
const have = BigInt(await view(VERIFIER, 'mt_balance_of', { account_id: MAKER, token_id: assetId }));
console.log(`maker SOL before: ${Number(have) / 1e9}`);
if (have < target) {
  const amt = (target - have).toString();
  const m = await mustCall(ROOT, id, 'mint', { account_id: ROOT, amount: amt });
  const t = await mustCall(ROOT, id, 'ft_transfer_call', { receiver_id: VERIFIER, amount: amt, msg: MAKER }, { deposit: 1n, gas: 150n * TGAS });
  console.log('mint', m.txHash); console.log('deposit', t.txHash);
  const d = JSON.parse(fs.readFileSync(DEP, 'utf8'));
  d.sol.inventory.SOL = String(process.argv[2] || '100');
  (d.sol.txs ||= []).push({ label: 'top up maker SOL inventory (mint)', hash: m.txHash }, { label: 'top up maker SOL inventory (deposit)', hash: t.txHash });
  fs.writeFileSync(DEP, JSON.stringify(d, null, 2) + '\n');
}
console.log(`maker SOL after: ${Number(BigInt(await view(VERIFIER, 'mt_balance_of', { account_id: MAKER, token_id: assetId }))) / 1e9}`);
