// Minimal NEAR testnet helpers for Tidepool. Keys come from env (TIDEPOOL_KEYS JSON) or a local
// gitignored .secrets dir during bootstrap. Keys are never logged.
import fs from 'node:fs';
import crypto from 'node:crypto';
import { connect, keyStores, KeyPair, transactions, utils, providers } from 'near-api-js';
import bs58 from 'bs58';
import nacl from 'tweetnacl';

export const NETWORK = 'testnet';
// Ordered NEAR RPC failover list. NEAR_RPC_URLS (comma separated) overrides; NEAR_RPC (legacy) stays first.
const DEFAULT_RPCS = ['https://test.rpc.fastnear.com', 'https://near-testnet.drpc.org', 'https://testnet-rpc.intea.rs', 'https://rpc.testnet.near.org'];
export const RPC_URLS = [...new Set([process.env.NEAR_RPC, ...(process.env.NEAR_RPC_URLS ? process.env.NEAR_RPC_URLS.split(',') : DEFAULT_RPCS)].map(u => u?.trim()).filter(Boolean))];
export const RPC = RPC_URLS[0];
const COOLDOWN_429_MS = Number(process.env.NEAR_RPC_COOLDOWN_MS || 30_000);
const cooldown = new Map(); // url -> until (ms)
const isTxMethod = (m) => /^(broadcast_tx|send_tx|tx$|EXPERIMENTAL_tx)/.test(m);
// Transient = provider problem (rate limit, 5xx, timeout, network), safe to retry on another node.
// Note: retrying broadcast of the SAME signed tx is idempotent (same hash); we never re-sign here.
function transient(e, status) {
  if (status === 429 || status === 408 || (status >= 500 && status < 600)) return true;
  const s = String(e?.message || e) + ' ' + String(e?.type || '') + ' ' + JSON.stringify(e?.rpc || '');
  return /429|rate.?limit|too many requests|timeout|timed out|fetch failed|failed to fetch|ECONNRESET|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|socket|network|unavailable|Internal server error|bad gateway|RetriesExceeded|Unexpected token|invalid json/i.test(s)
    && !/InvalidNonce|InvalidTransaction|InvalidSignature|NotEnoughBalance|AccountDoesNotExist|UNKNOWN_ACCOUNT|MethodNotFound|CodeDoesNotExist|FunctionCallError|ActionError/i.test(s);
}
function orderedUrls() {
  const now = Date.now();
  const ok = RPC_URLS.filter(u => !(cooldown.get(u) > now));
  return ok.length ? [...ok, ...RPC_URLS.filter(u => !ok.includes(u))] : [...RPC_URLS];
}
/** Runs fn(url) against each provider in order until one doesn't fail transiently. */
async function withFailover(method, fn) {
  let last;
  for (const url of orderedUrls()) {
    const timeoutMs = isTxMethod(method) ? 60_000 : 15_000;
    let timer;
    try {
      return await Promise.race([fn(url), new Promise((_, rej) => { timer = setTimeout(() => rej(Object.assign(new Error(`timeout after ${timeoutMs}ms`), { status: 408 })), timeoutMs); })]);
    } catch (e) {
      const status = e?.status ?? (typeof e?.cause === 'number' ? e.cause : undefined);
      if (!transient(e, status)) throw e;
      if (status === 429 || /429|rate.?limit|too many/i.test(String(e?.message) + JSON.stringify(e?.rpc || ''))) cooldown.set(url, Date.now() + COOLDOWN_429_MS);
      console.warn(`[near-rpc] ${method} via ${new URL(url).host} failed (${String(e?.message || e).slice(0, 120)}); trying next provider`);
      last = e;
    } finally { clearTimeout(timer); }
  }
  throw last;
}
class FailoverJsonRpcProvider extends providers.JsonRpcProvider {
  constructor(urls) { super({ url: urls[0] }, { retries: 1 }); this.pool = Object.fromEntries(urls.map(u => [u, new providers.JsonRpcProvider({ url: u }, { retries: 1 })])); }
  sendJsonRpc(method, params) { return withFailover(method, (url) => this.pool[url].sendJsonRpc(method, params)); }
}
export const nearProvider = new FailoverJsonRpcProvider(RPC_URLS);
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
async function conn() { return near ||= await connect({ networkId: NETWORK, nodeUrl: RPC, provider: nearProvider, keyStore }); }
export async function account(id) { return (await conn()).account(id); }

export async function rpc(method, params) {
  for (let i = 0; i < 3; i++) {
    try {
      return await withFailover(method, async (url) => {
        const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
        if (!res.ok) throw Object.assign(new Error(`HTTP ${res.status}`), { status: res.status });
        const r = await res.json();
        if (r.error) { const e = new Error(JSON.stringify(r.error).slice(0, 300)); e.rpc = r.error; if (r.error.code === -429) e.status = 429; throw e; }
        return r.result;
      });
    } catch (e) { if (i === 2 || !transient(e, e.status)) throw e; await new Promise(r => setTimeout(r, 1000 * (i + 1))); }
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
