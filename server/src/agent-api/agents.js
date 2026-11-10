// Agent rows, their derived wallets and the public views of agents, wallets and policies.
import { internals } from '../engine.mjs';
import { TOKENS, VERIFIER } from '../config.mjs';
import { sql } from './db.js';
import { fail } from './errors.js';
import { budgetView, policyHash } from './policy.js';

export const rowToAgent = (r) => r && { ...r, frozen: !!r.frozen, policy: JSON.parse(r.policy_json), budget_started: JSON.parse(r.budget_started_json) };

/** Reads an agent of this tenant: ACTIVE, ARCHIVED and DELETED agents can be read; PENDING ones only with allowPending. */
export function getAgent(tenantId, id, { allowPending = false } = {}) {
  const a = rowToAgent(sql.prepare('SELECT * FROM agents WHERE id = ?').get(String(id)));
  if (!a || a.tenant_id !== tenantId || (a.status === 'PENDING' && !allowPending)) throw fail(404, 'agent_not_found', 'request', `No agent ${id} for this API key`);
  return a;
}
/** Refuses actions and owner changes on an agent that is not ACTIVE. */
export function requireActive(a) {
  if (a.status === 'ARCHIVED') throw fail(409, 'agent_archived', 'request', 'This agent is archived: restore it with an agent_restore owner intent first');
  if (a.status === 'DELETED') throw fail(410, 'agent_deleted', 'request', 'This agent was deleted');
  if (a.status !== 'ACTIVE') throw fail(404, 'agent_not_found', 'request', `No agent ${a.id} for this API key`);
  return a;
}
/** Non-zero verifier balances of the agent wallet: [{ asset_id, symbol, decimals, blockchain, balance_raw }]. */
export async function walletHoldings(a) {
  const raw = await internals.view(VERIFIER, 'mt_batch_balance_of', { account_id: a.wallet_account, token_ids: TOKENS.map((t) => t.assetId) });
  return TOKENS.map((t, i) => ({ asset_id: t.assetId, symbol: t.symbol, decimals: t.decimals, blockchain: t.blockchain, balance_raw: String(raw[i]) })).filter((b) => b.balance_raw !== '0');
}

/** The agent's wallet is an implicit NEAR account derived from the server seed: nothing is stored and nothing is created on chain. */
export const agentWallet = (agentId) => internals.deriveDepositKey(`agent:${agentId}`);

export const ownerView = (a) => (a.owner_json ? JSON.parse(a.owner_json) : { type: 'near', account_id: a.owner_account, public_key: a.owner_public_key });
export const walletView = (a) => ({ wallet_id: a.id, near_account_id: a.wallet_account, evm_account_id: null, solana_account_id: null });
export const agentView = (a) => ({
  agent_id: a.id, id: a.id, name: a.name, external_user_id: a.external_user_id, status: a.status, archived: a.status === 'ARCHIVED', deleted: a.status === 'DELETED', frozen: a.frozen,
  owner: ownerView(a), owner_account: a.owner_json ? null : { account_id: a.owner_account, public_key: a.owner_public_key, authority: 'wallet' }, wallet: walletView(a),
  cooldowns: { policy_change_available_at: null, unfreeze_available_at: null }, created_at: a.created_at,
});
export function policyView(a) {
  const rev = sql.prepare('SELECT * FROM policy_revisions WHERE agent_id = ? AND revision = ?').get(a.id, a.policy_revision);
  return {
    wallet_id: a.id, revision: a.policy_revision, policy_hash: rev?.policy_hash ?? null, status: 'APPLIED', applied_at: rev?.created_at ?? null, transaction_hash: null,
    provider_policy_synced: true, cooldowns: { policy_change_available_at: null, unfreeze_available_at: null }, policy: a.policy,
    usage: { budget: budgetView(a, a.policy), timelock: { delay_ms: a.policy.timelock_ms || 0, scheduled_count: sql.prepare("SELECT COUNT(*) n FROM operations WHERE agent_id = ? AND status = 'QUEUED'").get(a.id).n } },
  };
}

/** Stores a new policy revision and makes it live (policy changes apply immediately on Tidepool). */
export function applyPolicy(agentId, policy, budgetStarted) {
  const a = rowToAgent(sql.prepare('SELECT * FROM agents WHERE id = ?').get(agentId));
  const revision = a.policy_revision + 1, now = new Date().toISOString();
  sql.prepare('INSERT INTO policy_revisions (agent_id, revision, policy_json, policy_hash, created_at) VALUES (?,?,?,?,?)').run(agentId, revision, JSON.stringify(policy), policyHash(policy), now);
  sql.prepare('UPDATE agents SET policy_json = ?, policy_revision = ?, frozen = ?, budget_started_json = ?, updated_at = ? WHERE id = ?').run(JSON.stringify(policy), revision, policy.frozen ? 1 : 0, JSON.stringify(budgetStarted), now, agentId);
  return { revision, policy_hash: policyHash(policy) };
}
