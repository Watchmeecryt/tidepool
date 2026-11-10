// Agent API held work: owner approvals, timelock_ms, schedule, execution_cancel, and release from the worker tick.
// NEAR is stubbed: internals.intentsBal / internals.execute are replaced, so nothing touches a network.
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import nacl from 'tweetnacl';
import bs58 from 'bs58';

process.env.DATA_DIR = fs.mkdtempSync(os.tmpdir() + '/aapi-holds-');
process.env.DEPOSIT_MASTER_SEED ||= crypto.randomBytes(32).toString('hex'); // throwaway test seed
const { internals } = await import('../src/engine.mjs');
const { sql } = await import('../src/agent-api/db.js');
const { validatePolicy, scheduleOpen, nextOpen, evaluate } = await import('../src/agent-api/policy.js');
const { runAction, releaseDue, scheduled, applyCancel } = await import('../src/agent-api/executions.js');
const { listApprovals, decideApproval, expireApprovals } = await import('../src/agent-api/approvals.js');
const { generateIntent, submitIntent } = await import('../src/agent-api/owner-intents.js');
const { getAgent, policyView } = await import('../src/agent-api/agents.js');
const { nep413Hash } = await import('../src/near.mjs');
const { TOKENS } = await import('../src/config.mjs');

const USDC = TOKENS.find((t) => !t.chain && t.symbol === 'USDC').assetId;
let balance = 1_000_000_000n;
internals.intentsBal = async () => balance;
const executed = [];
internals.execute = async (signed) => { executed.push(signed); return { ok: true, txHash: 'tx' + executed.length, logs: [] }; };

const owner = nacl.sign.keyPair();
const ownerAcct = Buffer.from(owner.publicKey).toString('hex'), ownerPk = 'ed25519:' + bs58.encode(owner.publicKey);
const base = { frozen: false, actions: ['swap', 'transfer', 'withdraw'], assets: 'any', limits: {}, destinations: { mode: 'any', list: [] }, budget: {} };
const TENANT = 'tenant_test';
function makeAgent(policy) {
  const id = 'agent_' + crypto.randomBytes(6).toString('hex'), now = new Date().toISOString(), p = validatePolicy({ ...base, ...policy });
  sql.prepare("INSERT INTO agents (id, tenant_id, name, status, owner_account, owner_public_key, wallet_account, frozen, policy_json, policy_revision, budget_started_json, created_at, updated_at) VALUES (?,?,?,'ACTIVE',?,?,?,0,?,1,'{}',?,?)")
    .run(id, TENANT, 'held test', ownerAcct, ownerPk, internals.deriveDepositKey(`agent:${id}`).accountId, JSON.stringify(p), now, now);
  sql.prepare('INSERT INTO policy_revisions (agent_id, revision, policy_json, policy_hash, created_at) VALUES (?,?,?,?,?)').run(id, 1, JSON.stringify(p), 'h', now);
  const gid = 'grant_' + id;
  sql.prepare('INSERT INTO grants (id, agent_id, credential, label, issued_at, expires_at) VALUES (?,?,?,?,?,?)').run(gid, id, crypto.randomBytes(32).toString('hex'), 'test', now, new Date(Date.now() + 86400_000).toISOString());
  return { agent: getAgent(TENANT, id), grant: sql.prepare('SELECT * FROM grants WHERE id = ?').get(gid) };
}
const RECIPIENT = 'a'.repeat(64);
const transfer = (a, g, amount = '1000000') => runAction(a, g, 'transfer', { asset: USDC, amount, recipient: RECIPIENT }, 'idem-' + crypto.randomUUID());
const op = (id) => sql.prepare('SELECT * FROM operations WHERE id = ?').get(id);
const settled = async (id) => { for (let i = 0; i < 100 && ['PROCESSING', 'QUEUED'].includes(op(id).status); i++) await new Promise((r) => setTimeout(r, 20)); return op(id); };
const owned = (type, body) => {
  const g = generateIntent(TENANT, { type, ...body });
  return g.then(async (gen) => {
    const p = gen.intent.payload, sig = nacl.sign.detached(nep413Hash(p.message, Buffer.from(p.nonce, 'base64'), p.recipient), owner.secretKey);
    return { gen, status: await submitIntent(TENANT, { type, correlation_id: gen.correlation_id, signed_data: { standard: 'nep413', payload: p, public_key: ownerPk, signature: Buffer.from(sig).toString('base64') } }) };
  });
};

test('policy: owner_approval, timelock_ms and schedule validate like the official shapes', () => {
  const p = validatePolicy({ ...base, owner_approval: true, timelock_ms: 60_000, schedule: { mode: 'only', time_zone: 'Europe/Berlin', windows: [{ days: ['mon', 'fri'], start: '09:00', end: '17:00' }] } });
  assert.equal(p.owner_approval, true);
  assert.equal(p.timelock_ms, 60_000);
  assert.deepEqual(p.schedule.windows[0].days, ['mon', 'fri']);
  assert.equal('schedule' in validatePolicy(base), false); // omitted stays omitted
  assert.throws(() => validatePolicy({ ...base, timelock_ms: 2_592_000_001 }), /timelock_ms/);
  assert.throws(() => validatePolicy({ ...base, timelock_ms: 1.5 }), /timelock_ms/);
  assert.throws(() => validatePolicy({ ...base, schedule: { mode: 'only', time_zone: 'Mars/Olympus', windows: [{ days: ['mon'], start: '09:00', end: '10:00' }] } }), /time zone/);
  assert.throws(() => validatePolicy({ ...base, schedule: { mode: 'only', time_zone: 'UTC', windows: [{ days: ['mon'], start: '10:00', end: '09:00' }] } }), /later than start/);
  assert.throws(() => validatePolicy({ ...base, schedule: { mode: 'except', time_zone: 'UTC', windows: [{ days: ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'], start: '00:00', end: '24:00' }] } }), /never allows/);
});

test('schedule windows follow the IANA time zone and report the next open time', () => {
  const s = { mode: 'only', time_zone: 'Europe/Berlin', windows: [{ days: ['mon'], start: '09:00', end: '17:00' }] };
  const mon0830 = Date.parse('2026-11-09T07:30:00Z'), mon0900 = Date.parse('2026-11-09T08:00:00Z'); // Berlin is UTC+1 in November
  assert.equal(scheduleOpen(s, mon0830), false);
  assert.equal(scheduleOpen(s, mon0900), true);
  assert.equal(scheduleOpen(s, Date.parse('2026-11-09T16:00:00Z')), false); // 17:00 Berlin: end is exclusive
  assert.equal(nextOpen(s, mon0830), mon0900);
  assert.equal(scheduleOpen({ ...s, mode: 'except' }, mon0830), true);
  const pol = validatePolicy({ ...base, schedule: s });
  const v = evaluate({ id: 'agent_none', frozen: false, budget_started: {} }, pol, { action: 'transfer', asset: USDC, amount: 1n, usd: 0 }, mon0830);
  assert.deepEqual(v.map((x) => x.code), ['policy_schedule_denied']);
  assert.equal(v[0].meta.available_at, new Date(mon0900).toISOString());
});

test('timelock: work is QUEUED, not charged, then released by the worker tick', async () => {
  const { agent, grant } = makeAgent({ timelock_ms: 60_000, budget: { daily_usd: '1000' } });
  const doc = await transfer(agent, grant);
  assert.equal(doc.status, 'QUEUED');
  assert.ok(Date.parse(doc.details.execute_after) >= Date.now() + 59_000);
  assert.equal(doc.details.delay_ms, 60_000);
  assert.equal(op(doc.correlation_id).counted, 0);
  assert.equal(policyView(getAgent(TENANT, agent.id)).usage.timelock.scheduled_count, 1);
  assert.equal(scheduled(agent).data[0].correlation_id, doc.correlation_id);
  assert.equal(scheduled(agent).data[0].state, 'waiting');
  assert.equal(await releaseDue(Date.now()), 0); // not due yet
  assert.equal(op(doc.correlation_id).status, 'QUEUED');
  assert.equal(await releaseDue(Date.now() + 61_000), 1);
  const done = await settled(doc.correlation_id);
  assert.equal(done.status, 'SUCCESS');
  assert.equal(done.counted, 1);
  assert.ok(done.dispatch_committed_at);
  assert.equal(scheduled(agent).data.length, 0);
});

test('held work reserves its amount: available balance excludes it', async () => {
  const { agent, grant } = makeAgent({ timelock_ms: 60_000 });
  balance = 1_500_000n;
  await transfer(agent, grant, '1000000');
  await assert.rejects(transfer(agent, grant, '1000000'), (e) => e.code === 'insufficient_balance');
  balance = 1_000_000_000n;
});

test('grant and policy are judged again at release', async () => {
  const a1 = makeAgent({ timelock_ms: 1000 });
  const d1 = await transfer(a1.agent, a1.grant);
  sql.prepare('UPDATE grants SET revoked_at = ? WHERE id = ?').run(new Date().toISOString(), a1.grant.id);
  await releaseDue(Date.now() + 2000);
  assert.equal(op(d1.correlation_id).status, 'FAILED');
  assert.equal(op(d1.correlation_id).failure_code, 'grant_revoked');

  const a2 = makeAgent({ timelock_ms: 1000 });
  const d2 = await transfer(a2.agent, a2.grant);
  sql.prepare('UPDATE agents SET frozen = 1 WHERE id = ?').run(a2.agent.id);
  await releaseDue(Date.now() + 2000);
  assert.equal(op(d2.correlation_id).failure_code, 'wallet_frozen');

  const a3 = makeAgent({ timelock_ms: 1000, max_actions_per_hour: 1 }); // the per-hour limit counts dispatched work only
  const d3a = await transfer(a3.agent, a3.grant), d3b = await transfer(a3.agent, a3.grant);
  await releaseDue(Date.now() + 2000); await settled(d3a.correlation_id);
  await releaseDue(Date.now() + 2000);
  const codes = [op(d3a.correlation_id), op(d3b.correlation_id)].map((r) => r.failure_code ?? r.status).sort();
  assert.deepEqual(codes, ['SUCCESS', 'policy_action_limit_exceeded']);
});

test('owner_approval: PENDING_APPROVAL, approve via approval_vote, then dispatch', async () => {
  const { agent, grant } = makeAgent({ owner_approval: true });
  const doc = await transfer(agent, grant);
  assert.equal(doc.status, 'PENDING_APPROVAL');
  assert.match(doc.details.approval_id, /^[0-9a-f-]{36}$/);
  const list = listApprovals(agent.id);
  assert.equal(list.length, 1);
  assert.equal(list[0].status, 'PENDING');
  assert.equal(list[0].request_type, 'transfer');
  assert.equal(list[0].required_approvals, 1);
  assert.equal(list[0].request_data.correlation_id, doc.correlation_id);
  await releaseDue(Date.now() + 10_000);
  assert.equal(op(doc.correlation_id).status, 'PENDING_APPROVAL'); // never released without a vote
  const { gen, status } = await owned('approval_vote', { agent_id: agent.id, approval_id: doc.details.approval_id, verdict: 'approve' });
  assert.equal(gen.preview.approval.verdict, 'approve');
  assert.equal(status.status, 'SUCCESS');
  assert.deepEqual(status.details, { approval_id: doc.details.approval_id, verdict: 'approve' });
  assert.equal(op(doc.correlation_id).status, 'QUEUED');
  await releaseDue(Date.now());
  assert.equal((await settled(doc.correlation_id)).status, 'SUCCESS');
  await assert.rejects(owned('approval_vote', { agent_id: agent.id, approval_id: doc.details.approval_id, verdict: 'reject' }), (e) => e.code === 'approval_closed');
});

test('owner_approval: reject and expiry end the work FAILED', async () => {
  const { agent, grant } = makeAgent({ owner_approval: true, timelock_ms: 5000 });
  const r1 = await transfer(agent, grant), r2 = await transfer(agent, grant);
  decideApproval(agent.id, r1.details.approval_id, 'reject');
  assert.equal(op(r1.correlation_id).failure_code, 'approval_rejected');
  expireApprovals(new Date(Date.now() + 25 * 3600_000).toISOString());
  assert.equal(op(r2.correlation_id).failure_code, 'approval_expired');
  assert.equal(listApprovals(agent.id).length, 0);
});

test('execution_cancel ends QUEUED or PENDING_APPROVAL work, nothing else', async () => {
  const { agent, grant } = makeAgent({ timelock_ms: 60_000 });
  const doc = await transfer(agent, grant);
  const { status } = await owned('execution_cancel', { agent_id: agent.id, correlation_id: doc.correlation_id });
  assert.equal(status.status, 'SUCCESS');
  assert.equal(status.details.cancelled_correlation_id, doc.correlation_id);
  assert.equal(op(doc.correlation_id).status, 'FAILED');
  assert.equal(op(doc.correlation_id).failure_code, 'execution_cancelled');
  assert.throws(() => applyCancel(agent.id, doc.correlation_id), (e) => e.code === 'execution_not_cancellable');
});

test('without holds, actions still run at once', async () => {
  const { agent, grant } = makeAgent({});
  const doc = await transfer(agent, grant);
  assert.equal(doc.status, 'PROCESSING');
  assert.equal((await settled(doc.correlation_id)).status, 'SUCCESS');
});
