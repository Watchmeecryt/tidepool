// Upgrade the six token contracts (state-compatible), allow the faucet signer(s) to mint, then hand ownership to NEW_OWNER.
import fs from 'node:fs';
import { loadKeys, account, mustCall, view, txUrl } from '../server/src/near.mjs';
import { ROOT, MAKER, TOKENS } from '../server/src/config.mjs';
const NEW_OWNER = process.env.NEW_OWNER; if (!NEW_OWNER) throw new Error('NEW_OWNER required');
await loadKeys({ dir: new URL('../.secrets', import.meta.url).pathname });
const wasm = fs.readFileSync(new URL('../contracts/token/target/near/tidepool_token.wasm', import.meta.url));
const out = [];
for (const t of TOKENS) {
  const id = t.contractAddress;
  const d = await (await account(id)).deployContract(wasm);
  out.push([t.symbol, 'upgrade code', txUrl(d.transaction.hash)]);
  for (const m of [ROOT, MAKER]) if (!(await view(id, 'is_minter', { account_id: m }))) out.push([t.symbol, `add_minter ${m}`, txUrl((await mustCall(ROOT, id, 'add_minter', { account_id: m })).txHash)]);
  if ((await view(id, 'owner_id')) !== NEW_OWNER) out.push([t.symbol, `set_owner ${NEW_OWNER}`, txUrl((await mustCall(ROOT, id, 'set_owner', { new_owner: NEW_OWNER })).txHash)]);
  out.push([t.symbol, 'owner_id now', await view(id, 'owner_id'), 'supply', await view(id, 'ft_total_supply')]);
}
console.log(out.map(r => r.join(' | ')).join('\n'));
