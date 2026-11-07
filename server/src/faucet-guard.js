// Faucet anti-farming checks: wallet-age eligibility (NEAR via NearBlocks, EVM via Sepolia nonce/balance) and optional
// Cloudflare Turnstile. All checks answer 403 JSON via BadRequest. Secrets are never logged.
import { BadRequest } from './engine.mjs';
import { viewAccount } from './near.mjs';

export const MIN_ACCOUNT_AGE_MS = Number(process.env.FAUCET_MIN_ACCOUNT_AGE_MS || 24 * 60 * 60_000);
const NEARBLOCKS = process.env.NEARBLOCKS_API || 'https://api-testnet.nearblocks.io';

/** NEAR account creation time in ms, null if NearBlocks has no record, undefined if the lookup failed. */
async function nearCreatedAt(id) {
  try {
    const r = await fetch(`${NEARBLOCKS}/v3/accounts/${encodeURIComponent(id)}`, { signal: AbortSignal.timeout(8000) });
    if (!r.ok) return r.status === 404 ? null : undefined;
    const ts = (await r.json())?.data?.created?.block_timestamp;
    return ts ? Number(BigInt(ts) / 1_000_000n) : null;
  } catch { return undefined; }
}

const checkers = {
  nearExists: async (id) => !!(await viewAccount(id)),
  nearCreatedAt,
  evmActive: async (chainKey, addr) => {
    const { provider } = await import('./evm.mjs');
    for (const k of [...new Set(['eth', chainKey])]) {
      try { const p = provider(k); if ((await p.getTransactionCount(addr, 'latest')) > 0 || (await p.getBalance(addr)) > 0n) return true; } catch {}
    }
    return false;
  },
};
/** Test hook: replace the network lookups. */
export function setFaucetCheckers(over) { Object.assign(checkers, over); }

export async function assertNearEligible(accountId) {
  if (!(await checkers.nearExists(accountId))) throw new BadRequest(`${accountId} does not exist on NEAR testnet. The faucet only serves existing accounts that are at least 24 hours old.`, 403, { reason: 'account_not_found' });
  if (/^[0-9a-f]{64}$/.test(accountId)) return; // implicit accounts have no creation record; existence (funded) is enough
  const at = await checkers.nearCreatedAt(accountId);
  if (at === undefined) return; // indexer unavailable: fail open rather than block real builders
  if (at === null || Date.now() - at < MIN_ACCOUNT_AGE_MS) {
    const available_at = at ? new Date(at + MIN_ACCOUNT_AGE_MS).toISOString() : undefined;
    throw new BadRequest(`${accountId} is too new for the faucet: accounts must be at least 24 hours old${available_at ? ` (eligible after ${available_at})` : ''}.`, 403, { reason: 'account_too_new', available_at });
  }
}

export async function assertEvmEligible(chainKey, addr) {
  if (!(await checkers.evmActive(chainKey, addr))) throw new BadRequest(`${addr} has no on-chain activity. The faucet only serves EVM addresses that have sent a transaction or hold some ETH on Ethereum Sepolia (get Sepolia ETH from a public faucet first).`, 403, { reason: 'address_inactive' });
}

/** If TURNSTILE_SECRET is set, require a valid Turnstile token (body.turnstileToken) or a valid naa_ API key. */
export async function assertHuman(body, ip, hasValidApiKey) {
  const secret = process.env.TURNSTILE_SECRET;
  if (!secret) return;
  if (hasValidApiKey) return;
  const token = body?.turnstileToken;
  if (typeof token !== 'string' || !token) throw new BadRequest('Captcha required: send turnstileToken from the faucet page, or an API key (Authorization: Bearer naa_..., free from POST /v1/keys).', 403, { reason: 'captcha_required' });
  let ok = false;
  try {
    const r = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', { method: 'POST', body: new URLSearchParams({ secret, response: token, ...(ip ? { remoteip: ip } : {}) }), signal: AbortSignal.timeout(8000) });
    ok = (await r.json())?.success === true;
  } catch {}
  if (!ok) throw new BadRequest('Captcha verification failed: reload the faucet page and try again.', 403, { reason: 'captcha_failed' });
}
