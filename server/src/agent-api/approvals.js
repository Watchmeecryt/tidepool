// Owner approvals (policy.owner_approval): an outgoing action waits in PENDING_APPROVAL until the owner signs an
// approval_vote owner intent. Approve moves it to QUEUED (the worker dispatches it, after any timelock); reject or
// expiry ends it FAILED. Nothing is charged to the budget until dispatch.
import crypto from 'node:crypto';
import { sql } from './db.js';
import { fail } from './errors.js';
import { agentWallet } from './agents.js';

export const APPROVAL_TTL_MS = 24 * 3600_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function createApproval(agent, operationId, type, request, now = new Date()) {
  const id = crypto.randomUUID(), hash = crypto.createHash('sha256').update(JSON.stringify({ type, request })).digest('hex');
  sql.prepare('INSERT INTO approvals (id, agent_id, operation_id, request_type, request_json, request_hash, status, expires_at, created_at) VALUES (?,?,?,?,?,?,?,?,?)')
    .run(id, agent.id, operationId, type, JSON.stringify(request), hash, 'PENDING', new Date(now.getTime() + APPROVAL_TTL_MS).toISOString(), now.toISOString());
  return id;
}

/** Ends approvals past their expiry (and their operations, FAILED approval_expired). */
export function expireApprovals(now = new Date().toISOString()) {
  const rows = sql.prepare("SELECT id, operation_id FROM approvals WHERE status = 'PENDING' AND expires_at <= ?").all(now);
  for (const r of rows) sql.transaction(() => {
    sql.prepare("UPDATE approvals SET status = 'EXPIRED', decided_at = ? WHERE id = ? AND status = 'PENDING'").run(now, r.id);
    sql.prepare("UPDATE operations SET status = 'FAILED', failure_code = 'approval_expired', failure_detail = 'The owner did not vote before the approval expired', counted = 0, updated_at = ? WHERE id = ? AND status = 'PENDING_APPROVAL'").run(now, r.operation_id);
  })();
  return rows.length;
}

const walletKey = (agentId) => { try { return agentWallet(agentId).keyPair.getPublicKey().toString(); } catch { return null; } };
export const approvalView = (r) => ({
  approval_id: r.id, wallet_id: r.agent_id, wallet_pubkey: walletKey(r.agent_id), request_hash: r.request_hash,
  status: r.status, request_type: r.request_type, request_data: { correlation_id: r.operation_id, ...JSON.parse(r.request_json) }, required_approvals: 1, expires_at: r.expires_at,
});

export function listApprovals(agentId) {
  expireApprovals();
  return sql.prepare("SELECT * FROM approvals WHERE agent_id = ? AND status = 'PENDING' ORDER BY created_at").all(agentId).map(approvalView);
}

export function getApproval(agentId, approvalId, { pending = false } = {}) {
  expireApprovals();
  if (typeof approvalId !== 'string' || !UUID.test(approvalId)) throw fail(400, 'validation_failed', 'request', 'approval_id must be a UUID', { pointer: '/approval_id' });
  const r = sql.prepare('SELECT * FROM approvals WHERE id = ? AND agent_id = ?').get(approvalId, agentId);
  if (!r) throw fail(404, 'approval_not_found', 'request', `No approval ${approvalId} on this agent`);
  if (pending && r.status !== 'PENDING') throw fail(409, 'approval_closed', 'request', `This approval is already ${r.status}`);
  return r;
}

/** Applies an owner verdict: approve -> the operation is QUEUED for the worker; reject -> FAILED approval_rejected. */
export function decideApproval(agentId, approvalId, verdict, now = new Date().toISOString()) {
  const r = getApproval(agentId, approvalId, { pending: true });
  sql.prepare('UPDATE approvals SET status = ?, decided_at = ? WHERE id = ?').run(verdict === 'approve' ? 'APPROVED' : 'REJECTED', now, r.id);
  if (verdict === 'approve') sql.prepare("UPDATE operations SET status = 'QUEUED', updated_at = ? WHERE id = ? AND status = 'PENDING_APPROVAL'").run(now, r.operation_id);
  else sql.prepare("UPDATE operations SET status = 'FAILED', failure_code = 'approval_rejected', failure_detail = 'The owner rejected this action', counted = 0, updated_at = ? WHERE id = ? AND status = 'PENDING_APPROVAL'").run(now, r.operation_id);
  return { approval_id: r.id, verdict };
}
