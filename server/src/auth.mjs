// /v0/auth/* and /v0/account/*: testnet session tokens. Free; any wallet that can sign gets one.
// Tokens are HS256 JWTs signed with a server secret (JWT_SECRET, else derived from DEPOSIT_MASTER_SEED).
import crypto from 'node:crypto';
import bs58 from 'bs58';
import nacl from 'tweetnacl';
import { ethers } from 'ethers';
import { nep413Hash, rpc, view } from './near.mjs';
import { VERIFIER, TOKENS, fromUnits } from './config.mjs';
import { db } from './store.mjs';
import { BadRequest } from './engine.mjs';

const SECRET = process.env.JWT_SECRET || crypto.createHmac('sha256', process.env.DEPOSIT_MASTER_SEED || 'tidepool-dev').update('tidepool-jwt-v1').digest('hex');
export const ACCESS_TTL = 3600, REFRESH_TTL = 30 * 86400;
const b64u = (b) => Buffer.from(b).toString('base64url');
export function signJwt(claims, ttl) {
  const now = Math.floor(Date.now() / 1000);
  const h = b64u(JSON.stringify({ alg: 'HS256', typ: 'JWT' })), p = b64u(JSON.stringify({ iss: 'tidepool-testnet', iat: now, exp: now + ttl, jti: crypto.randomUUID(), ...claims }));
  return `${h}.${p}.${b64u(crypto.createHmac('sha256', SECRET).update(`${h}.${p}`).digest())}`;
}
export function verifyJwt(tok, typ) {
  const [h, p, sig] = String(tok || '').split('.');
  if (!sig) return null;
  const want = b64u(crypto.createHmac('sha256', SECRET).update(`${h}.${p}`).digest());
  if (want.length !== sig.length || !crypto.timingSafeEqual(Buffer.from(want), Buffer.from(sig))) return null;
  try { const c = JSON.parse(Buffer.from(p, 'base64url')); if (c.exp < Date.now() / 1000 || (typ && c.typ !== typ)) return null; return c; } catch { return null; }
}
export const bearer = (req) => (/^Bearer\s+(\S+)/i.exec(req.headers.authorization || '') || [])[1];
export const sessionOf = (req) => verifyJwt(bearer(req), 'access');

class Unauthorized extends BadRequest { constructor(m) { super(m, 401); } }
const ed = (s) => bs58.decode(String(s).replace(/^ed25519:/, ''));

async function ownsKey(accountId, publicKey) {
  if (/^[0-9a-f]{64}$/.test(accountId)) return Buffer.from(ed(publicKey)).toString('hex') === accountId; // implicit account
  try { if (await view(VERIFIER, 'has_public_key', { account_id: accountId, public_key: publicKey })) return true; } catch {}
  try { await rpc('query', { request_type: 'view_access_key', finality: 'final', account_id: accountId, public_key: publicKey }); return true; } catch { return false; }
}
const parse = (m) => { try { return JSON.parse(m); } catch { throw new BadRequest('signed message must be JSON (DefusePayload) with signer_id'); } };

/** Verifies a MultiPayload signature and returns the signer account id. Supports nep413, raw_ed25519, erc191. */
export async function verifySigned(sd) {
  if (!sd || typeof sd !== 'object') throw new BadRequest('signedData is required');
  let signer, msg;
  if (sd.standard === 'nep413') {
    const { message, nonce, recipient } = sd.payload || {};
    if (!message || !nonce || !recipient) throw new BadRequest('nep413 payload needs message, nonce, recipient');
    msg = parse(message); signer = msg.signer_id;
    const ok = nacl.sign.detached.verify(nep413Hash(message, Buffer.from(nonce, 'base64'), recipient), ed(sd.signature), ed(sd.public_key));
    if (!ok) throw new Unauthorized('Signature verification failed');
    if (!signer || !(await ownsKey(signer, sd.public_key))) throw new Unauthorized(`public_key is not a key of ${signer}`);
  } else if (sd.standard === 'raw_ed25519') {
    msg = parse(sd.payload); signer = msg.signer_id;
    if (!nacl.sign.detached.verify(Buffer.from(sd.payload, 'utf8'), ed(sd.signature), ed(sd.public_key))) throw new Unauthorized('Signature verification failed');
    if (!signer || !(await ownsKey(signer, sd.public_key))) throw new Unauthorized(`public_key is not a key of ${signer}`);
  } else if (sd.standard === 'erc191') {
    msg = parse(sd.payload); signer = String(msg.signer_id || '').toLowerCase();
    const raw = Buffer.from(bs58.decode(String(sd.signature).replace(/^secp256k1:/, '')));
    if (raw.length !== 65) throw new BadRequest('erc191 signature must be 65 bytes (secp256k1:base58)');
    if (raw[64] < 27) raw[64] += 27;
    let addr; try { addr = ethers.verifyMessage(sd.payload, '0x' + raw.toString('hex')).toLowerCase(); } catch { throw new Unauthorized('Signature verification failed'); }
    if (addr !== signer) throw new Unauthorized('Signature verification failed');
  } else throw new BadRequest(`standard ${sd.standard} is not supported for authentication on Tidepool testnet (supported: nep413, raw_ed25519, erc191)`);
  if (msg.deadline && new Date(msg.deadline).getTime() < Date.now()) throw new Unauthorized('signed message deadline has passed');
  return signer;
}

export async function authenticate(body) {
  const sub = await verifySigned(body?.signedData);
  return { accessToken: signJwt({ sub, typ: 'access' }, ACCESS_TTL), refreshToken: signJwt({ sub, typ: 'refresh' }, REFRESH_TTL), expiresIn: ACCESS_TTL, refreshExpiresIn: REFRESH_TTL };
}
export function refresh(body) {
  const c = verifyJwt(body?.refreshToken, 'refresh');
  if (!c) throw new Unauthorized('Invalid or expired refresh token');
  return { accessToken: signJwt({ sub: c.sub, typ: 'access' }, ACCESS_TTL), expiresIn: ACCESS_TTL };
}

export async function balances(sub, tokenIds) {
  const ids = tokenIds?.length ? tokenIds : TOKENS.map(t => t.assetId);
  const bals = await view(VERIFIER, 'mt_batch_balance_of', { account_id: sub, token_ids: ids });
  return { balances: ids.map((tokenId, i) => ({ tokenId, available: String(bals[i] ?? '0'), source: 'private' })).filter(b => tokenIds?.length || b.available !== '0') };
}

const arr = (v) => (v === null || v === undefined || v === '' ? [] : String(v).split(','));
export function history(sub, q) {
  if (q.get('prevCursor') && q.get('nextCursor')) throw new BadRequest('Pass either prevCursor or nextCursor, not both');
  const limit = Math.min(100, Math.max(1, Number(q.get('limit') || 20)));
  const statuses = q.getAll('status').flatMap(arr), dts = q.getAll('depositType').flatMap(arr), rts = q.getAll('recipientType').flatMap(arr), fts = q.getAll('refundType').flatMap(arr);
  const search = q.get('search'), da = q.get('depositAddress'), dm = q.get('depositMemo');
  let items = Object.entries(db.swaps).filter(([, s]) => {
    const r = s.quoteResponse.quoteRequest;
    return [r.recipient, r.refundTo, s.sender, s.signer].filter(Boolean).map(x => x.toLowerCase()).includes(sub.toLowerCase());
  }).map(([k, s]) => ({ k, s, at: s.quoteResponse.timestamp }));
  items.sort((a, b) => (a.at < b.at ? 1 : -1));
  const pub = (st) => (st === 'KNOWN_DEPOSIT_TX' ? 'PENDING_DEPOSIT' : st);
  items = items.filter(({ s }) => {
    const r = s.quoteResponse.quoteRequest, q2 = s.quoteResponse.quote;
    if (statuses.length && !statuses.includes(pub(s.status))) return false;
    if (da && q2.depositAddress?.toLowerCase() !== da.toLowerCase()) return false;
    if (da && dm && s.depositMemo !== dm) return false;
    if (search) { const hay = [q2.depositAddress, r.recipient, r.refundTo, s.sender, ...s.originTxs, ...s.txs.map(t => t.hash)].filter(Boolean).join(' ').toLowerCase(); if (!hay.includes(search.toLowerCase())) return false; }
    const n = Math.max(dts.length, rts.length, fts.length);
    if (n) { let any = false; for (let i = 0; i < n; i++) { const m = (v, x) => !v || v === 'null' || v === x; if (m(dts[i], r.depositType) && m(rts[i], r.recipientType) && m(fts[i], r.refundType)) any = true; } if (!any) return false; }
    return true;
  });
  const prev = q.get('prevCursor'), next = q.get('nextCursor');
  const dec = (c) => { try { return Buffer.from(c, 'base64url').toString(); } catch { throw new BadRequest('invalid cursor'); } };
  if (prev) items = items.filter(i => i.at < dec(prev));
  if (next) items = items.filter(i => i.at > dec(next)).slice(-limit);
  items = items.slice(0, limit);
  const out = items.map(({ s }) => {
    const r = s.quoteResponse.quoteRequest, qq = s.quoteResponse.quote;
    const inT = TOKENS.find(t => t.assetId === r.originAsset), outT = TOKENS.find(t => t.assetId === r.destinationAsset);
    return { status: pub(s.status), depositType: r.depositType, recipientType: r.recipientType, createdAt: s.quoteResponse.timestamp, depositAddress: qq.depositAddress, depositMemo: s.depositMemo ?? null, originAsset: r.originAsset, amountInFormatted: s.amountIn ? fromUnits(s.amountIn, inT.decimals) : qq.amountInFormatted, amountInUsd: qq.amountInUsd, destinationAsset: r.destinationAsset, amountOutFormatted: s.amountOut ? fromUnits(s.amountOut, outT.decimals) : qq.amountOutFormatted, amountOutUsd: qq.amountOutUsd, recipient: r.recipient, quoteTransactions: s.originTxs.map(h => ({ sender: s.sender || s.signer || '', txHash: h })), refundTo: r.refundTo, refundType: r.refundType, refundReason: s.refundReason ?? null, refundedAmountFormatted: s.refunded ? fromUnits(s.refunded, inT.decimals) : '0', refundedAmountUsd: '0', refundFee: null, refundFeeFormatted: '0' };
  });
  const res = { items: out };
  if (items.length) { res.nextCursor = Buffer.from(items[0].at).toString('base64url'); res.prevCursor = Buffer.from(items.at(-1).at).toString('base64url'); }
  return res;
}
