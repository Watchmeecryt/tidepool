// Withdrawal memos for the Agent API: what each payout chain can carry and how a memo string maps onto it.
//   near    -> ft_withdraw memo (text, at most 128 characters)
//   stellar -> MEMO_ID when the memo is a uint64 number without leading zeros, else MEMO_TEXT (at most 28 bytes)
//   xrp     -> DestinationTag (uint32 number); must agree with a tag encoded in an X-address recipient
//   sol     -> one Memo program instruction (UTF-8, at most 256 bytes)
// Every other chain (EVM, Sui, Bitcoin, Zcash) has no memo field, so a memo there is refused.
import { parseXrpAddress } from '../config.mjs';
import { fail } from './errors.js';

export const MEMO_CHAINS = ['near', 'stellar', 'xrp', 'sol'];
const U64_MAX = 18446744073709551615n, U32_MAX = 4294967295;
const bad = (detail) => fail(400, 'validation_failed', 'request', detail, { pointer: '/memo' });
const bytes = (s) => Buffer.byteLength(s, 'utf8');

/** Stellar memo type for a memo string: { type: 'id' | 'text', value }. */
export function stellarMemo(memo) {
  if (/^(0|[1-9]\d{0,19})$/.test(memo) && BigInt(memo) <= U64_MAX) return { type: 'id', value: memo };
  return { type: 'text', value: memo };
}

/**
 * Validates `memo` for a withdrawal to `chain`/`recipient` and returns the normalized memo string (or null).
 * chainName is only used in error text.
 */
export function withdrawMemo(chain, memo, recipient, chainName = chain) {
  if (memo === undefined || memo === null) return null;
  if (typeof memo !== 'string') throw bad('memo must be a string');
  if (memo === '') return null;
  if (!MEMO_CHAINS.includes(chain)) throw bad(`memo is not supported for ${chainName} withdrawals: ${chainName} payouts carry no memo field. Omit memo (memos work on chains near, stellar, xrp and sol).`);
  if (memo.length > 256) throw bad('memo must be at most 256 characters');
  if (chain === 'near') {
    if (memo.length > 128) throw bad('memo must be a string of at most 128 characters');
    return memo;
  }
  if (chain === 'stellar') {
    const m = stellarMemo(memo);
    if (m.type === 'text' && bytes(memo) > 28) throw bad('A Stellar memo is either a number up to 18446744073709551615 (sent as MEMO_ID) or text of at most 28 bytes (sent as MEMO_TEXT)');
    return m.value;
  }
  if (chain === 'xrp') {
    if (!/^(0|[1-9]\d{0,9})$/.test(memo) || Number(memo) > U32_MAX) throw bad('An XRP Ledger memo is the destination tag: a whole number from 0 to 4294967295');
    const tag = Number(memo), p = parseXrpAddress(recipient);
    if (p?.tag !== undefined && Number(p.tag) !== tag) throw fail(400, 'validation_failed', 'request', `recipient is an X-address that already encodes destination tag ${p.tag}, which conflicts with memo ${tag}. Send one or the other, or make them match.`, { pointer: '/memo' });
    return String(tag);
  }
  if (bytes(memo) > 256) throw bad('A Solana memo must be at most 256 bytes of UTF-8');
  return memo;
}
