// Minimal NEAR testnet helpers for Tidepool. Keys come from env (TIDEPOOL_KEYS JSON) or a local
// gitignored .secrets dir during bootstrap. Keys are never logged.
import fs from 'node:fs';
import crypto from 'node:crypto';
import { connect, keyStores, KeyPair, transactions, utils } from 'near-api-js';
import bs58 from 'bs58';
import nacl from 'tweetnacl';

export const NETWORK = 'testnet';
export const RPC = process.env.NEAR_RPC || 'https://test.rpc.fastnear.com';
export const EXPLORER = 'https://testnet.nearblocks.io';
export const TGAS = 10n ** 12n;
export const keyStore = new keyStores.InMemoryKeyStore();
let near;

export async function loadKeys({ dir, env } = {}) {
  if (env) for (const [id, sk] of Object.entries(JSON.parse(env))) await keyStore.setKey(NETWORK, id, KeyPair.fromString(sk));
  if (dir && fs.existsSync(dir)) for (const f of fs.readdirSync(dir).filter(f => f.endsWith('.json'))) {
    const k = JSON.parse(fs.readFileSync(dir + '/' + f, 'utf8'));
    await keyStore.setKey(NETWORK, k.account_id, KeyPair.fromString(k.private_key));
  }
}
async function conn() { return near ||= await connect({ networkId: NETWORK, nodeUrl: RPC, keyStore }); }
export async function account(id) { return (await conn()).account(id); }

export async function rpc(method, params) {
  for (let i = 0; i < 4; i++) {
    try {
      const r = await fetch(RPC, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) }).then(r => r.json());
      if (r.error) { const e = new Error(JSON.stringify(r.error).slice(0, 300)); e.rpc = r.error; throw e; }
      return r.result;
    } catch (e) { if (e.rpc || i === 3) throw e; await new Promise(r => setTimeout(r, 500 * (i + 1))); }
  }
}
export async function view(contract, method, args = {}) {
  for (let i = 0; ; i++) {
    const r = await rpc('query', { request_type: 'call_function', finality: 'optimistic', account_id: contract, method_name: method, args_base64: Buffer.from(JSON.stringify(args)).toString('base64') });
    if (r.result) return JSON.parse(Buffer.from(r.result).toString() || 'null');
    if (i >= 3) throw new Error(`view ${contract}.${method}: ${r.error || 'no result'}`);
    await new Promise(res => setTimeout(res, 1000));
  }
}
export async function viewAccount(id) {
  try { return await rpc('query', { request_type: 'view_account', finality: 'optimistic', account_id: id }); }
  catch (e) { if (JSON.stringify(e.rpc || '').includes('UNKNOWN_ACCOUNT') || String(e.message).includes('does not exist')) return null; throw e; }
}

/** Sends a function call, never throws on on-chain failure. */
export async function call(signer, contractId, methodName, args = {}, { gas = 100n * TGAS, deposit = 0n } = {}) {
  const acc = await account(signer);
  const out = await acc.signAndSendTransaction({ receiverId: contractId, actions: [transactions.functionCall(methodName, args, gas, deposit)], returnError: true });
  const fails = [out.status?.Failure, ...out.receipts_outcome.map(r => r.outcome.status.Failure)].filter(Boolean);
  let value = null;
  if (out.status?.SuccessValue) { try { value = JSON.parse(Buffer.from(out.status.SuccessValue, 'base64').toString()); } catch {} }
  const msg = (f) => f?.ActionError?.kind?.FunctionCallError?.ExecutionError || JSON.stringify(f).slice(0, 300);
  return { txHash: out.transaction.hash, ok: fails.length === 0, value, failures: fails.map(msg), logs: out.receipts_outcome.flatMap(r => r.outcome.logs) };
}
export async function mustCall(...a) { const r = await call(...a); if (!r.ok) { const e = new Error(`${a[2]} failed: ${r.failures.join('; ')}`); e.txHash = r.txHash; throw e; } return r; }
export async function sendNear(from, to, yocto) { const acc = await account(from); const out = await acc.sendMoney(to, yocto); return out.transaction.hash; }

export const parseNear = (n) => BigInt(utils.format.parseNearAmount(String(n)));
export const txUrl = (h) => `${EXPLORER}/txns/${h}`;
export const accountUrl = (a) => `${EXPLORER}/address/${a}`;

/** Per-quote deposit key, derived from a server secret so no per-quote key is stored. */
export function deriveDepositKey(master, quoteId) {
  const seed = crypto.createHmac('sha256', master).update(`tidepool-deposit:${quoteId}`).digest();
  const kp = nacl.sign.keyPair.fromSeed(seed);
  const keyPair = KeyPair.fromString('ed25519:' + bs58.encode(Buffer.from(kp.secretKey)));
  return { keyPair, accountId: Buffer.from(kp.publicKey).toString('hex') };
}

// NEP-413 signing for the verifier's MultiPayload
const NEP413_TAG = 2 ** 31 + 413;
const bstr = (s) => { const b = Buffer.from(s, 'utf8'); const l = Buffer.alloc(4); l.writeUInt32LE(b.length); return Buffer.concat([l, b]); };
export function nep413Hash(message, nonce, recipient) {
  const tag = Buffer.alloc(4); tag.writeUInt32LE(NEP413_TAG);
  return crypto.createHash('sha256').update(Buffer.concat([tag, bstr(message), nonce, bstr(recipient), Buffer.from([0])])).digest();
}
export function signIntents({ signerId, verifier, intents, keyPair, ttlMs = 120_000 }) {
  const nonce = crypto.randomBytes(32);
  if (nonce[0] === 0x56 && nonce[1] === 0x28) nonce[0] ^= 0xff; // avoid the versioned-nonce prefix
  const message = JSON.stringify({ signer_id: signerId, verifying_contract: verifier, deadline: new Date(Date.now() + ttlMs).toISOString(), nonce: nonce.toString('base64'), intents });
  const sig = keyPair.sign(nep413Hash(message, nonce, verifier)).signature;
  return { standard: 'nep413', payload: { message, nonce: nonce.toString('base64'), recipient: verifier }, public_key: keyPair.getPublicKey().toString(), signature: 'ed25519:' + bs58.encode(Buffer.from(sig)) };
}
