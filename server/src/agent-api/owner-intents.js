// Owner intents: generate-intent -> the owner's NEAR key signs the NEP-413 payload -> submit-intent -> status.
// Supported: agent_create, policy_update, agent_freeze, agent_unfreeze, grant_issue, grant_revoke, execution_cancel, approval_vote.
import crypto from 'node:crypto';
import nacl from 'tweetnacl';
import bs58 from 'bs58';
import { rpc, nep413Hash } from '../near.mjs';
import { sql } from './db.js';
import { fail } from './errors.js';
import { agentWallet, applyPolicy, getAgent, ownerView, policyView, rowToAgent } from './agents.js';
import { budgetStarts, policyHash, validatePolicy } from './policy.js';
import { MAX_AGENTS_PER_KEY } from './partner-keys.js';
import { decideApproval, getApproval } from './approvals.js';
import { applyCancel, cancelHeld } from './executions.js';

export const TYPES = ['agent_create', 'policy_update', 'agent_freeze', 'agent_unfreeze', 'grant_issue', 'grant_revoke', 'execution_cancel', 'approval_vote'];
const OTHER_TYPES = ['agent_archive', 'agent_restore', 'agent_delete'];
export const RECIPIENT = 'tidepool-agent-api';
const TTL_MS = 5 * 60_000;
const ACCOUNT = /^(([a-z\d]+[-_])*[a-z\d]+\.)*([a-z\d]+[-_])*[a-z\d]+$/;
const bad = (detail, pointer) => fail(400, 'validation_failed', 'request', detail, pointer ? { pointer } : undefined);
const id = (p) => `${p}_${crypto.randomBytes(12).toString('hex')}`;
const hashReq = (o) => crypto.createHash('sha256').update(JSON.stringify(o)).digest('hex');

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
  if (/^[0-9a-f]{64}$/.test(accountId)) {
    if (pk.toString('hex') !== accountId) throw fail(403, 'owner_key_not_full_access', 'auth', 'An implicit account can only be owned by its own key');
    return;
  }
  if (!ACCOUNT.test(accountId) || accountId.length < 2 || accountId.length > 64) throw bad('owner.account_id is not a valid NEAR account id', '/owner/account_id');
  let key;
  try { key = await rpc('query', { request_type: 'view_access_key', finality: 'final', account_id: accountId, public_key: publicKey }); }
  catch (e) {
    if (e.rpc) throw fail(403, 'owner_key_not_full_access', 'auth', `${publicKey} is not an access key of ${accountId} on NEAR testnet`);
    throw fail(502, 'provider_unavailable', 'provider', 'Could not reach NEAR testnet to check the owner key, retry shortly');
  }
  if (key.permission !== 'FullAccess') throw fail(403, 'owner_key_not_full_access', 'auth', `${publicKey} is not a full-access key of ${accountId}`);
}

function intentStatus(r) {
  let status = r.status, failure = r.failure_code;
  if (status === 'PENDING_SIGNATURE' && Date.now() > Date.parse(r.expires_at)) { status = 'FAILED'; failure = 'intent_expired'; }
  const result = r.result_json ? JSON.parse(r.result_json) : null;
  const base = { correlation_id: r.id, agent_id: r.agent_id, status, failure_code: failure, created_at: r.created_at, updated_at: r.updated_at, dispatch_committed_at: null, grant: null, type: r.type };
  const p = JSON.parse(r.payload_json);
  const details = {
    agent_create: { revision: result?.revision ?? null, policy_hash: result?.policy_hash ?? null, transaction_hash: null, agent_id: r.agent_id },
    policy_update: { revision: result?.revision ?? null, policy_hash: result?.policy_hash ?? null, transaction_hash: null },
    agent_freeze: { revision: result?.revision ?? null, policy_hash: result?.policy_hash ?? null, transaction_hash: null },
    agent_unfreeze: { revision: result?.revision ?? null, policy_hash: result?.policy_hash ?? null, transaction_hash: null },
    grant_issue: { grant: result?.grant ?? null },
    grant_revoke: { grant_id: result?.grant_id ?? p.preview.grant_id ?? null, committed_correlation_ids: result?.committed_correlation_ids ?? null, committed_truncated: result ? false : null },
    execution_cancel: { cancelled_correlation_id: result?.cancelled_correlation_id ?? null },
    approval_vote: { approval_id: result?.approval_id ?? p.preview.approval?.approval_id ?? null, verdict: result?.verdict ?? p.preview.approval?.verdict ?? null },
  }[r.type];
  return { ...base, details };
}
export const ownerIntentStatus = (r) => intentStatus(r);

export const grantView = (g, agent) => ({
  grant_id: g.id, wallet_id: g.agent_id, issued_at: g.issued_at, expires_at: g.expires_at, revoked_at: g.revoked_at, revoked_reason: g.revoked_at ? 'owner_revoked' : null, owner_epoch: 0,
  label: g.label, credential: g.credential,
  owner_message: { domain: 'tidepool-agent-api.agent-grant.v1', owner: ownerView(agent), tenant_id: agent.tenant_id, wallet_id: g.agent_id, credential: g.credential, network: 'testnet', issued_at_ms: Date.parse(g.issued_at), expires_at_ms: Date.parse(g.expires_at), owner_epoch: 0, nonce: g.id, recipient: RECIPIENT },
});

export async function generateIntent(tenantId, body, idemKey) {
  if (!body || typeof body !== 'object') throw bad('body must be a JSON object');
  const { type } = body;
  if (OTHER_TYPES.includes(type)) throw fail(400, 'unsupported_intent_type', 'request', `"${type}" is not available on Tidepool testnet. Supported: ${TYPES.join(', ')}`);
  if (!TYPES.includes(type)) throw bad(`type must be one of ${TYPES.join(', ')}`, '/type');
  const reqHash = hashReq(body);
  if (idemKey) {
    const prev = sql.prepare('SELECT * FROM owner_intents WHERE tenant_id = ? AND idem_key = ?').get(tenantId, idemKey);
    if (prev) {
      if (prev.req_hash !== reqHash) throw fail(409, 'idempotency_conflict', 'request', 'This Idempotency-Key was already used with a different request body');
      return JSON.parse(prev.payload_json);
    }
  }
  const now = new Date(), nonce = crypto.randomBytes(32).toString('base64'), expiresAt = new Date(now.getTime() + TTL_MS).toISOString();
  let agent, agentId, details, preview;
  if (type === 'agent_create') {
    if (typeof body.name !== 'string' || !body.name.trim() || body.name.length > 80) throw bad('name must be 1-80 characters', '/name');
    if (body.external_user_id !== undefined && (typeof body.external_user_id !== 'string' || body.external_user_id.length > 128)) throw bad('external_user_id must be a string of at most 128 characters', '/external_user_id');
    const o = body.owner;
    if (!o || o.type !== 'near') throw fail(400, 'unsupported_owner_type', 'request', 'Only NEAR testnet owners are supported on Tidepool: owner = { type: "near", account_id, public_key }', { pointer: '/owner/type' });
    const policy = validatePolicy(body.policy);
    const n = sql.prepare("SELECT COUNT(*) n FROM agents WHERE tenant_id = ? AND (status = 'ACTIVE' OR created_at > ?)").get(tenantId, new Date(now.getTime() - TTL_MS).toISOString()).n;
    if (n >= MAX_AGENTS_PER_KEY) throw fail(429, 'quota_exceeded', 'request', `At most ${MAX_AGENTS_PER_KEY} agents per API key on Tidepool testnet. Get another free key with POST /v1/keys.`);
    await assertFullAccessKey(o.account_id, o.public_key);
    agentId = id('agent');
    const wallet = agentWallet(agentId);
    sql.prepare('INSERT INTO agents (id, tenant_id, name, external_user_id, status, owner_account, owner_public_key, wallet_account, frozen, policy_json, policy_revision, budget_started_json, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
      .run(agentId, tenantId, body.name.trim(), body.external_user_id ?? null, 'PENDING', o.account_id, o.public_key, wallet.accountId, policy.frozen ? 1 : 0, JSON.stringify(policy), 0, '{}', now.toISOString(), now.toISOString());
    agent = getAgent(tenantId, agentId, { allowPending: true });
    details = { name: agent.name, policy_hash: policyHash(policy), policy };
    preview = { summary: `Create agent "${agent.name}" owned by ${o.account_id} with wallet ${wallet.accountId}`, revision: 1, policy_hash: policyHash(policy), policy };
  } else {
    if (typeof body.agent_id !== 'string') throw bad('agent_id is required', '/agent_id');
    agent = getAgent(tenantId, body.agent_id);
    agentId = agent.id;
    if (type === 'policy_update') {
      const policy = validatePolicy(body.policy);
      if (!Number.isInteger(body.expected_revision)) throw bad('expected_revision must be the current policy revision (integer)', '/expected_revision');
      if (body.expected_revision !== agent.policy_revision) throw fail(409, 'policy_revision_conflict', 'request', `The policy is at revision ${agent.policy_revision}, not ${body.expected_revision}. Read it again and request a fresh signature.`);
      if (policy.frozen !== agent.frozen) throw bad('policy.frozen must match the current state: use agent_freeze / agent_unfreeze to change it', '/policy/frozen');
      details = { expected_revision: agent.policy_revision, policy_hash: policyHash(policy), policy };
      preview = { summary: `Replace the policy of "${agent.name}" (revision ${agent.policy_revision} -> ${agent.policy_revision + 1})`, revision: agent.policy_revision + 1, previous_revision: agent.policy_revision, policy_hash: policyHash(policy), policy };
    } else if (type === 'agent_freeze' || type === 'agent_unfreeze') {
      const freeze = type === 'agent_freeze';
      if (agent.frozen === freeze) throw fail(409, freeze ? 'already_frozen' : 'not_frozen', 'request', `The agent is ${freeze ? 'already frozen' : 'not frozen'}`);
      const next = { ...agent.policy, frozen: freeze };
      details = { expected_revision: agent.policy_revision, policy_hash: policyHash(next) };
      preview = { summary: `${freeze ? 'Freeze' : 'Unfreeze'} "${agent.name}"`, revision: agent.policy_revision + 1, previous_revision: agent.policy_revision, policy_hash: policyHash(next), policy: next };
    } else if (type === 'grant_issue') {
      if (typeof body.label !== 'string' || !body.label.trim() || body.label.length > 64) throw bad('label must be 1-64 characters', '/label');
      if (typeof body.credential !== 'string' || !/^[0-9a-f]{64}$/.test(body.credential)) throw bad('credential must be the 64-hex SHA-256 commitment of your ngt_ grant token (createGrantCredential().commitment)', '/credential');
      const exp = Date.parse(body.expires_at);
      if (!Number.isFinite(exp) || exp <= Date.now() + 60_000 || exp > Date.now() + 366 * 86400_000) throw bad('expires_at must be an ISO time between 1 minute and 365 days from now', '/expires_at');
      if (sql.prepare('SELECT 1 FROM grants WHERE credential = ?').get(body.credential)) throw fail(409, 'grant_credential_reused', 'request', 'This credential commitment was already used: create a new grant token');
      if (sql.prepare('SELECT COUNT(*) n FROM grants WHERE agent_id = ? AND revoked_at IS NULL AND expires_at > ?').get(agentId, now.toISOString()).n >= 50) throw fail(429, 'quota_exceeded', 'request', 'At most 50 live grants per agent');
      details = { label: body.label.trim(), credential: body.credential, expires_at: new Date(exp).toISOString() };
      preview = { summary: `Issue grant "${details.label}" to "${agent.name}" until ${details.expires_at}` };
    } else if (type === 'execution_cancel') {
      if (typeof body.correlation_id !== 'string') throw bad('correlation_id is required: the QUEUED or PENDING_APPROVAL execution to cancel', '/correlation_id');
      const op = cancelHeld(agentId, body.correlation_id);
      details = { correlation_id: op.id };
      preview = { summary: `Cancel the ${op.status} ${op.type} ${op.id} of "${agent.name}" before it runs` };
    } else if (type === 'approval_vote') {
      if (!['approve', 'reject'].includes(body.verdict)) throw bad('verdict must be "approve" or "reject"', '/verdict');
      const ap = getApproval(agentId, body.approval_id, { pending: true });
      details = { approval_id: ap.id, verdict: body.verdict, request_hash: ap.request_hash };
      preview = { summary: `${body.verdict === 'approve' ? 'Approve' : 'Reject'} the ${ap.request_type} ${ap.operation_id} of "${agent.name}"`, approval: { approval_id: ap.id, request_type: ap.request_type, request_hash: ap.request_hash, verdict: body.verdict } };
    } else {
      const g = sql.prepare('SELECT * FROM grants WHERE id = ? AND agent_id = ?').get(String(body.grant_id), agentId);
      if (!g) throw fail(404, 'grant_not_found', 'request', `No grant ${body.grant_id} on this agent`);
      if (g.revoked_at) throw fail(409, 'grant_already_revoked', 'request', 'This grant is already revoked');
      details = { grant_id: g.id };
      preview = { summary: `Revoke grant "${g.label}" of "${agent.name}"`, grant_id: g.id };
    }
  }
  const message = JSON.stringify({ domain: 'tidepool-agent-api.v1', network: 'testnet', type, agent_id: agentId, owner: agent.owner_account, tenant_id: tenantId, expires_at: expiresAt, nonce, details });
  const corr = id('intent');
  const response = { correlation_id: corr, type, agent_id: agentId, status: 'PENDING_SIGNATURE', expires_at: expiresAt, signer: ownerView(agent), intent: { standard: 'nep413', payload: { message, recipient: RECIPIENT, nonce } }, preview };
  sql.prepare('INSERT INTO owner_intents (id, tenant_id, agent_id, type, status, request_json, payload_json, signer, idem_key, req_hash, expires_at, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)')
    .run(corr, tenantId, agentId, type, 'PENDING_SIGNATURE', JSON.stringify(body), JSON.stringify(response), agent.owner_public_key, idemKey || null, reqHash, expiresAt, now.toISOString(), now.toISOString());
  return response;
}

export function submitIntent(tenantId, body) {
  if (!body || typeof body.correlation_id !== 'string' || !body.signed_data) throw bad('body must be { type, correlation_id, signed_data }');
  const r = sql.prepare('SELECT * FROM owner_intents WHERE id = ? AND tenant_id = ?').get(body.correlation_id, tenantId);
  if (!r) throw fail(404, 'intent_not_found', 'request', `No intent ${body.correlation_id} for this API key`);
  if (body.type !== r.type) throw fail(409, 'intent_type_mismatch', 'request', `This intent is a ${r.type}, not ${body.type}`);
  if (r.status === 'SUCCESS') return ownerIntentStatus(r); // replay
  if (Date.now() > Date.parse(r.expires_at)) throw fail(409, 'intent_expired', 'request', 'This intent expired: generate a new one');
  const sd = body.signed_data, stored = JSON.parse(r.payload_json).intent.payload;
  if (sd.standard !== 'nep413') throw fail(400, 'intent_standard_mismatch', 'request', 'signed_data.standard must be "nep413"');
  if (JSON.stringify([sd.payload?.message, sd.payload?.nonce, sd.payload?.recipient]) !== JSON.stringify([stored.message, stored.nonce, stored.recipient])) throw fail(400, 'intent_payload_mismatch', 'request', 'signed_data.payload must be exactly the payload returned by generate-intent');
  if (sd.public_key !== r.signer) throw fail(403, 'owner_signature_invalid', 'auth', 'signed_data.public_key is not the owner key of this agent');
  const sig = decodeSig(sd.signature);
  let ok = false;
  try { ok = !!sig && nacl.sign.detached.verify(nep413Hash(stored.message, Buffer.from(stored.nonce, 'base64'), stored.recipient), sig, Buffer.from(bs58.decode(sd.public_key.slice(8)))); } catch { ok = false; }
  if (!ok) throw fail(403, 'owner_signature_invalid', 'auth', 'The owner signature does not verify for this payload');

  const now = new Date().toISOString();
  const req = JSON.parse(r.request_json), tx = sql.transaction(() => {
    const agentRow = sql.prepare('SELECT * FROM agents WHERE id = ?').get(r.agent_id);
    if (r.type === 'agent_create') {
      const policy = JSON.parse(agentRow.policy_json);
      sql.prepare("UPDATE agents SET status = 'ACTIVE', updated_at = ? WHERE id = ?").run(now, r.agent_id);
      return applyPolicy(r.agent_id, policy, budgetStarts({}, policy, now));
    }
    const a = rowToAgent(agentRow);
    if (r.type === 'policy_update' || r.type === 'agent_freeze' || r.type === 'agent_unfreeze') {
      if (JSON.parse(r.payload_json).preview.previous_revision !== a.policy_revision) throw fail(409, 'policy_revision_conflict', 'request', 'The policy changed since this intent was generated: read it again and request a fresh signature');
      const policy = r.type === 'policy_update' ? validatePolicy(req.policy) : { ...a.policy, frozen: r.type === 'agent_freeze' };
      return applyPolicy(a.id, policy, budgetStarts(a.budget_started, policy, now));
    }
    if (r.type === 'grant_issue') {
      const d = JSON.parse(r.payload_json).intent.payload.message, det = JSON.parse(d).details, gid = id('grant');
      if (sql.prepare('SELECT 1 FROM grants WHERE credential = ?').get(det.credential)) throw fail(409, 'grant_credential_reused', 'request', 'This credential commitment was already used');
      sql.prepare('INSERT INTO grants (id, agent_id, credential, label, issued_at, expires_at) VALUES (?,?,?,?,?,?)').run(gid, a.id, det.credential, det.label, now, det.expires_at);
      return { grant: grantView(sql.prepare('SELECT * FROM grants WHERE id = ?').get(gid), a) };
    }
    if (r.type === 'execution_cancel') return applyCancel(a.id, req.correlation_id, now);
    if (r.type === 'approval_vote') return decideApproval(a.id, req.approval_id, req.verdict, now);
    const gid = req.grant_id;
    sql.prepare('UPDATE grants SET revoked_at = ? WHERE id = ? AND agent_id = ? AND revoked_at IS NULL').run(now, gid, a.id);
    const inflight = sql.prepare("SELECT id FROM operations WHERE grant_id = ? AND status = 'PROCESSING'").all(gid).map((x) => x.id); // held work of this grant fails grant_revoked at dispatch
    return { grant_id: gid, committed_correlation_ids: inflight };
  });
  const result = tx();
  sql.prepare("UPDATE owner_intents SET status = 'SUCCESS', result_json = ?, updated_at = ? WHERE id = ?").run(JSON.stringify(result), now, r.id);
  return ownerIntentStatus(sql.prepare('SELECT * FROM owner_intents WHERE id = ?').get(r.id));
}

export const getOwnerIntent = (tenantId, corr) => {
  const r = sql.prepare('SELECT * FROM owner_intents WHERE id = ? AND tenant_id = ?').get(corr, tenantId);
  return r ? ownerIntentStatus(r) : null;
};
export const agentOwnerIntents = (agentId, limit = 200) => sql.prepare("SELECT * FROM owner_intents WHERE agent_id = ? AND status = 'SUCCESS' ORDER BY created_at DESC LIMIT ?").all(agentId, limit).map(ownerIntentStatus);
export { policyView };
