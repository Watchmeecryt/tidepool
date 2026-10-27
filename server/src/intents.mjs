// Signed-intent flow (1Click /v0/generate-intent + /v0/submit-intent): the user's own Intents account
// funds a quote's deposit address with a transfer intent they sign; we relay it to the verifier.
import crypto from 'node:crypto';
import { VERIFIER, MAKER, TOKENS } from './config.mjs';
import { db, save } from './store.mjs';
import { BadRequest, internals, keyOf, withSigner } from './engine.mjs';
import { call, TGAS, txUrl } from './near.mjs';

const GEN_STANDARDS = ['nep413', 'raw_ed25519', 'erc191', 'tip191', 'sep53'];
const SUBMIT_STANDARDS = ['nep413', 'raw_ed25519', 'erc191', 'tip191', 'sep53', 'webauthn', 'ton_connect'];

function findSwap(depositAddress) {
  const s = db.swaps[keyOf(depositAddress)];
  if (!s) throw new BadRequest('Unknown depositAddress');
  return s;
}
const fundingAmount = (s) => (s.order ? s.order.fundAmount : s.quoteResponse.quote.amountIn);

export function generateIntent(b) {
  if (b?.type !== 'swap_transfer') throw new BadRequest('type must be swap_transfer');
  for (const k of ['standard', 'signerId', 'depositAddress']) if (!b[k]) throw new BadRequest(`${k} is required`);
  if (!GEN_STANDARDS.includes(b.standard)) throw new BadRequest(`standard ${b.standard} is not supported by Tidepool generate-intent (supported: ${GEN_STANDARDS.join(', ')})`);
  const s = findSwap(b.depositAddress);
  const r = s.quoteResponse.quoteRequest;
  if (r.depositType !== 'INTENTS') throw new BadRequest('generate-intent requires a quote with depositType INTENTS');
  if (!['PENDING_DEPOSIT', 'KNOWN_DEPOSIT_TX', 'INCOMPLETE_DEPOSIT'].includes(s.status) && !(s.order && s.order.fillStatus === 'AWAITING_DEPOSIT')) throw new BadRequest(`quote is ${s.status}; it can no longer be funded`);
  const deadline = new Date(s.quoteResponse.quote.deadline);
  if (deadline.getTime() < Date.now()) throw new BadRequest('quote deadline has passed');
  const signerId = b.standard === 'erc191' ? String(b.signerId).toLowerCase() : b.signerId;
  const nonce = crypto.randomBytes(32); if (nonce[0] === 0x56 && nonce[1] === 0x28) nonce[0] ^= 0xff;
  const intents = [{ intent: 'transfer', receiver_id: s.intentsAccount, tokens: { [r.originAsset]: fundingAmount(s) } }];
  const msg = { signer_id: signerId, verifying_contract: VERIFIER, deadline: new Date(Math.min(deadline.getTime(), Date.now() + 15 * 60_000)).toISOString(), nonce: nonce.toString('base64'), intents };
  const message = JSON.stringify(msg);
  const intent = b.standard === 'nep413' ? { standard: 'nep413', payload: { message, nonce: nonce.toString('base64'), recipient: VERIFIER } } : { standard: b.standard, payload: message };
  s.generated = { signerId, standard: b.standard, at: new Date().toISOString() }; save();
  return { intent, correlationId: s.quoteResponse.correlationId };
}

const messageOf = (sd) => {
  const m = sd.standard === 'nep413' ? sd.payload?.message : sd.standard === 'ton_connect' ? sd.payload?.text : sd.standard === 'webauthn' ? sd.payload : sd.payload;
  try { return JSON.parse(m); } catch { return null; }
};

export async function submitIntent(b) {
  if (b?.type !== 'swap_transfer') throw new BadRequest('type must be swap_transfer');
  const sd = b.signedData;
  if (!sd || !SUBMIT_STANDARDS.includes(sd.standard)) throw new BadRequest(`signedData.standard must be one of ${SUBMIT_STANDARDS.join(', ')}`);
  const msg = messageOf(sd);
  const tr = msg?.intents?.find(i => i.intent === 'transfer');
  if (!tr) throw new BadRequest('signed intent must contain the transfer intent from /v0/generate-intent');
  const entry = Object.entries(db.swaps).find(([, s]) => s.intentsAccount === tr.receiver_id);
  if (!entry) throw new BadRequest('transfer receiver is not a Tidepool deposit address');
  const [addr, s] = entry;
  const r = await withSigner(MAKER, () => call(MAKER, VERIFIER, 'execute_intents', { signed: [sd] }, { gas: 300n * TGAS }));
  if (!r.ok) throw new BadRequest('Verifier rejected the signed intent: ' + r.failures.join('; ').slice(0, 400));
  const hashes = internals.hashesFrom(r.logs);
  s.signer = msg.signer_id; s.sender = msg.signer_id;
  s.intentHashes.push(...hashes); s.originTxs.push(r.txHash);
  s.txs.push({ label: 'user-signed transfer intent (submit-intent)', hash: r.txHash });
  if (s.status === 'PENDING_DEPOSIT') internals.set(s, 'KNOWN_DEPOSIT_TX'); else save();
  return { intentHash: hashes[0] || '', correlationId: s.quoteResponse.correlationId, tidepool: { txHash: r.txHash, explorerUrl: txUrl(r.txHash), depositAddress: addr } };
}
