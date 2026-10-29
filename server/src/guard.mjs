// One step at a time per transaction slot. Every sign-first driver (utxo/stellar/sui/solana/xrp) funnels through this: the engine can reach the
// same payout/sweep slot from more than one path (worker tick, status poll, a slow earlier tick still awaiting RPC). Two concurrent
// steps on an UNSIGNED slot would each build + sign their own transaction (different inputs/blockhash/sequence) and pay out twice
// (this is how the XRP testnet treasury once paid one swap four times). A second caller simply reports 'pending' and the next tick resumes.
const inflight = new WeakSet();
export async function exclusive(rec, step) {
  if (inflight.has(rec)) return 'pending';
  inflight.add(rec);
  try { return await step(); } finally { inflight.delete(rec); }
}
