// Create a fresh testnet account through the public testnet helper. Key written to ../.secrets (gitignored), never printed.
import { KeyPair } from 'near-api-js';
import fs from 'node:fs';
const id = process.argv[2];
const kp = KeyPair.fromRandom('ed25519');
const r = await fetch('https://helper.nearprotocol.com/account', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ newAccountId: id, newAccountPublicKey: kp.getPublicKey().toString() }) });
console.log(id, r.status, (await r.text()).slice(0, 120));
if (r.ok) fs.writeFileSync(new URL(`../.secrets/${id}.json`, import.meta.url), JSON.stringify({ account_id: id, public_key: kp.getPublicKey().toString(), private_key: kp.toString() }), { mode: 0o600 });
