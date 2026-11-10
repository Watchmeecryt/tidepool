// Owner wallets and how they sign owner intents (all verified off-chain by this API):
//   near    { type, account_id, public_key }                 -> nep413 (ed25519 full-access key)
//   evm     { type, address, chain_id, public_key }           -> eip712 typed data (or erc191 personal_sign of payload.message.intent)
//   passkey { type, credential_id, public_key, rp_id, origin } -> webauthn assertion (P-256, user verification required)
import crypto from 'node:crypto';
import nacl from 'tweetnacl';
import bs58 from 'bs58';
import { computeAddress, getAddress, isAddress, verifyMessage, verifyTypedData } from 'ethers';
import { rpc, nep413Hash } from '../near.mjs';
import { fail } from './errors.js';

export const OWNER_TYPES = ['near', 'evm', 'passkey'];
export const RECIPIENT = 'tidepool-agent-api';
const ACCOUNT = /^(([a-z\d]+[-_])*[a-z\d]+\.)*([a-z\d]+[-_])*[a-z\d]+$/;
const bad = (detail, pointer) => fail(400, 'validation_failed', 'request', detail, pointer ? { pointer } : undefined);
const sigInvalid = (detail) => fail(403, 'owner_signature_invalid', 'auth', detail);
const b64u = (b) => Buffer.from(b).toString('base64url');
const unb64 = (s) => (typeof s === 'string' && /^[A-Za-z0-9+/_=-]*$/.test(s) ? Buffer.from(s, 'base64url') : null);

// ---------- NEAR ----------
const decodeSig = (s) => {
  const raw = String(s).replace(/^ed25519:/, '');
  for (const b of [() => (/^[0-9a-f]{128}$/i.test(raw) ? Buffer.from(raw, 'hex') : null), () => Buffer.from(bs58.decode(raw)), () => Buffer.from(raw, 'base64')]) {
    try { const x = b(); if (x?.length === 64) return x; } catch { /* try the next encoding */ }
  }
  return null;
};
/** A NEAR owner is any account with a full-access ed25519 key; an implicit account (64 hex chars) is its own key. */
async function assertFullAccessKey(accountId, publicKey) {
  if (typeof publicKey !== 'string' || !publicKey.startsWith('ed25519:')) throw bad('owner.public_key must look like "ed25519:<base58>"', '/owner/public_key');
  let pk; try { pk = Buffer.from(bs58.decode(publicKey.slice(8))); } catch { pk = null; }
  if (pk?.length !== 32) throw bad('owner.public_key is not a valid ed25519 key', '/owner/public_key');
  if (typeof accountId === 'string' && /^[0-9a-f]{64}$/.test(accountId)) {
    if (pk.toString('hex') !== accountId) throw fail(403, 'owner_key_not_full_access', 'auth', 'An implicit account can only be owned by its own key');
    return;
  }
  if (typeof accountId !== 'string' || !ACCOUNT.test(accountId) || accountId.length < 2 || accountId.length > 64) throw bad('owner.account_id is not a valid NEAR account id', '/owner/account_id');
  let key;
  try { key = await rpc('query', { request_type: 'view_access_key', finality: 'final', account_id: accountId, public_key: publicKey }); }
  catch (e) {
    if (e.rpc) throw fail(403, 'owner_key_not_full_access', 'auth', `${publicKey} is not an access key of ${accountId} on NEAR testnet`);
    throw fail(502, 'provider_unavailable', 'provider', 'Could not reach NEAR testnet to check the owner key, retry shortly');
  }
  if (key.permission !== 'FullAccess') throw fail(403, 'owner_key_not_full_access', 'auth', `${publicKey} is not a full-access key of ${accountId}`);
}

// ---------- EVM ----------
function evmKeyAddress(publicKey) {
  if (typeof publicKey !== 'string' || !/^0x(0[23][0-9a-fA-F]{64}|04[0-9a-fA-F]{128})$/.test(publicKey)) throw bad('owner.public_key must be the secp256k1 public key as 0x hex (33-byte compressed or 65-byte uncompressed)', '/owner/public_key');
  try { return computeAddress(publicKey); } catch { throw bad('owner.public_key is not a valid secp256k1 point', '/owner/public_key'); }
}
const EIP712_TYPES = { OwnerIntent: [{ name: 'intent', type: 'string' }, { name: 'nonce', type: 'string' }, { name: 'recipient', type: 'string' }] };
const EIP712_DOMAIN_TYPE = [{ name: 'name', type: 'string' }, { name: 'version', type: 'string' }, { name: 'chainId', type: 'uint256' }];

// ---------- passkey (WebAuthn, ES256) ----------
/** owner.public_key: base64url SPKI DER, or the raw uncompressed P-256 point (0x04..., hex or base64url). */
export function p256Key(publicKey) {
  if (typeof publicKey !== 'string' || !publicKey) throw bad('owner.public_key must be a P-256 public key (base64url SPKI, or the uncompressed point 04... as hex or base64url)', '/owner/public_key');
  const raw = /^(0x)?04[0-9a-fA-F]{128}$/.test(publicKey) ? Buffer.from(publicKey.replace(/^0x/, ''), 'hex') : unb64(publicKey);
  try {
    if (raw?.length === 65 && raw[0] === 4) return crypto.createPublicKey({ key: { kty: 'EC', crv: 'P-256', x: b64u(raw.subarray(1, 33)), y: b64u(raw.subarray(33)) }, format: 'jwk' });
    const k = crypto.createPublicKey({ key: raw, format: 'der', type: 'spki' });
    if (k.asymmetricKeyDetails?.namedCurve === 'prime256v1') return k;
  } catch { /* fall through */ }
  throw bad('owner.public_key is not a valid P-256 public key', '/owner/public_key');
}

/** Validates an owner wallet from agent_create and returns the normalized owner object stored with the agent. */
export async function validateOwner(o) {
  if (!o || typeof o !== 'object' || !OWNER_TYPES.includes(o.type)) throw fail(400, 'unsupported_owner_type', 'request', 'owner.type must be "near" { account_id, public_key }, "evm" { address, chain_id, public_key } or "passkey" { credential_id, public_key, rp_id, origin }', { pointer: '/owner/type' });
  if (o.type === 'near') { await assertFullAccessKey(o.account_id, o.public_key); return { type: 'near', account_id: o.account_id, public_key: o.public_key }; }
  if (o.type === 'evm') {
    if (typeof o.address !== 'string' || !isAddress(o.address)) throw bad('owner.address must be a 0x EVM address', '/owner/address');
    if (!Number.isSafeInteger(o.chain_id) || o.chain_id <= 0) throw bad('owner.chain_id must be a positive integer chain id (it goes into the EIP-712 domain)', '/owner/chain_id');
    if (evmKeyAddress(o.public_key) !== getAddress(o.address)) throw bad('owner.public_key does not belong to owner.address', '/owner/public_key');
    return { type: 'evm', address: getAddress(o.address), chain_id: o.chain_id, public_key: o.public_key };
  }
  if (typeof o.credential_id !== 'string' || !unb64(o.credential_id)?.length || o.credential_id.length > 1024) throw bad('owner.credential_id must be the base64url credential id', '/owner/credential_id');
  p256Key(o.public_key);
  if (typeof o.rp_id !== 'string' || !/^[a-z0-9.-]{1,253}$/i.test(o.rp_id)) throw bad('owner.rp_id must be the relying party id (a domain such as example.com)', '/owner/rp_id');
  let origin; try { origin = new URL(o.origin); } catch { origin = null; }
  if (!origin || !['https:', 'http:'].includes(origin.protocol) || origin.origin !== o.origin) throw bad('owner.origin must be an origin such as https://example.com', '/owner/origin');
  if (origin.hostname !== o.rp_id && !origin.hostname.endsWith('.' + o.rp_id)) throw bad('owner.origin must be on owner.rp_id or one of its subdomains', '/owner/origin');
  return { type: 'passkey', credential_id: o.credential_id, public_key: o.public_key, rp_id: o.rp_id, origin: o.origin };
}

/** The identity string an owner's intents are signed by (stored as owner_intents.signer). */
export const signerOf = (owner) => (owner.type === 'evm' ? owner.address : owner.type === 'passkey' ? owner.credential_id : owner.public_key);

/** Builds the payload the owner's wallet signs: nep413 for NEAR owners, eip712 for EVM owners, webauthn for passkeys. */
export function intentFor(owner, message, nonce) {
  if (owner.type === 'evm') return { standard: 'eip712', payload: { domain: { name: 'Tidepool Agent API', version: '1', chainId: owner.chain_id }, types: { EIP712Domain: EIP712_DOMAIN_TYPE, ...EIP712_TYPES }, primaryType: 'OwnerIntent', message: { intent: message, nonce, recipient: RECIPIENT } } };
  if (owner.type === 'passkey') return { standard: 'webauthn', payload: { challenge: b64u(crypto.createHash('sha256').update(`${RECIPIENT}\n${nonce}\n${message}`).digest()), rpId: owner.rp_id, allowCredentials: [{ id: owner.credential_id, type: 'public-key' }], userVerification: 'required', timeout: 300_000 } };
  return { standard: 'nep413', payload: { message, recipient: RECIPIENT, nonce } };
}

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
/** Verifies signed_data from submit-intent against the stored intent. Throws a JSON:API error on any mismatch. */
export function verifyOwnerSignature(owner, intent, sd) {
  const mismatch = () => fail(400, 'intent_payload_mismatch', 'request', 'signed_data.payload must be exactly the payload returned by generate-intent');
  if (owner.type === 'near') {
    if (sd.standard !== 'nep413') throw fail(400, 'intent_standard_mismatch', 'request', 'signed_data.standard must be "nep413" for a NEAR owner');
    const p = intent.payload;
    if (!same([sd.payload?.message, sd.payload?.nonce, sd.payload?.recipient], [p.message, p.nonce, p.recipient])) throw mismatch();
    if (sd.public_key !== owner.public_key) throw sigInvalid('signed_data.public_key is not the owner key of this agent');
    const sig = decodeSig(sd.signature);
    let ok = false;
    try { ok = !!sig && nacl.sign.detached.verify(nep413Hash(p.message, Buffer.from(p.nonce, 'base64'), p.recipient), sig, Buffer.from(bs58.decode(sd.public_key.slice(8)))); } catch { ok = false; }
    if (!ok) throw sigInvalid('The owner signature does not verify for this payload');
    return;
  }
  if (owner.type === 'evm') {
    const p = intent.payload, { EIP712Domain, ...types } = p.types;
    let signer = null;
    if (sd.standard === 'eip712') {
      if (!same(sd.payload?.domain, p.domain) || !same(sd.payload?.message, p.message) || sd.payload?.primaryType !== p.primaryType) throw mismatch();
      try { signer = verifyTypedData(p.domain, types, p.message, sd.signature); } catch { signer = null; }
    } else if (sd.standard === 'erc191') { // personal_sign of the intent message text, for wallets without typed-data support
      if (sd.payload?.message !== p.message.intent) throw mismatch();
      try { signer = verifyMessage(p.message.intent, sd.signature); } catch { signer = null; }
    } else throw fail(400, 'intent_standard_mismatch', 'request', 'signed_data.standard must be "eip712" (or "erc191") for an EVM owner');
    if (!signer || signer !== owner.address) throw sigInvalid(`The signature does not recover to the owner address ${owner.address}`);
    return;
  }
  if (sd.standard !== 'webauthn') throw fail(400, 'intent_standard_mismatch', 'request', 'signed_data.standard must be "webauthn" for a passkey owner');
  if (sd.payload?.challenge !== intent.payload.challenge) throw mismatch();
  const c = sd.credential, r = c?.response;
  if (!c || c.type !== 'public-key' || c.id !== owner.credential_id) throw sigInvalid('signed_data.credential is not the owner passkey of this agent');
  const cdjRaw = unb64(r?.clientDataJSON), auth = unb64(r?.authenticatorData), sig = unb64(r?.signature);
  if (!cdjRaw || !auth || !sig || auth.length < 37) throw sigInvalid('signed_data.credential.response must carry base64url clientDataJSON, authenticatorData and signature');
  let cd; try { cd = JSON.parse(cdjRaw.toString('utf8')); } catch { cd = null; }
  if (cd?.type !== 'webauthn.get') throw sigInvalid('clientDataJSON.type must be "webauthn.get"');
  if (cd.challenge !== intent.payload.challenge) throw sigInvalid('clientDataJSON.challenge is not the generated challenge');
  if (cd.origin !== owner.origin) throw sigInvalid(`clientDataJSON.origin must be ${owner.origin}`);
  if (!auth.subarray(0, 32).equals(crypto.createHash('sha256').update(owner.rp_id).digest())) throw sigInvalid(`authenticatorData is not for rp_id ${owner.rp_id}`);
  if ((auth[32] & 0x05) !== 0x05) throw sigInvalid('The passkey assertion needs user presence and user verification');
  let ok = false;
  try { ok = crypto.verify('sha256', Buffer.concat([auth, crypto.createHash('sha256').update(cdjRaw).digest()]), { key: p256Key(owner.public_key), dsaEncoding: 'der' }, sig); } catch { ok = false; }
  if (!ok) throw sigInvalid('The passkey signature does not verify for this challenge');
}
