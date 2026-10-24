// Creates demo sub-accounts of the Tidepool root for end-to-end tests. Keys -> ../.secrets (never printed).
import fs from 'node:fs';
import { KeyPair } from 'near-api-js';
import { loadKeys, account, viewAccount, parseNear } from '../server/src/near.mjs';
import { ROOT } from '../server/src/config.mjs';
const SECRETS = new URL('../.secrets/', import.meta.url).pathname;
await loadKeys({ dir: SECRETS });
for (const name of process.argv.slice(2)) {
  const id = `${name}.${ROOT}`;
  if (await viewAccount(id)) { console.log('exists', id); continue; }
  const kp = KeyPair.fromRandom('ed25519');
  const r = await (await account(ROOT)).createAccount(id, kp.getPublicKey(), parseNear(1));
  fs.writeFileSync(SECRETS + id + '.json', JSON.stringify({ account_id: id, public_key: kp.getPublicKey().toString(), private_key: kp.toString() }), { mode: 0o600 });
  console.log('created', id, r.transaction.hash);
}
