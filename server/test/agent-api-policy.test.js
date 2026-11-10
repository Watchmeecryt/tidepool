import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';

process.env.DATA_DIR = fs.mkdtempSync(os.tmpdir() + '/aapi-');
const { validatePolicy, evaluate, policyHash } = await import('../src/agent-api/policy.js');
const { TOKENS } = await import('../src/config.mjs');

const A = TOKENS[0].assetId, B = TOKENS[1].assetId;
const base = { frozen: false, actions: ['swap', 'transfer'], assets: 'any', limits: {}, destinations: { mode: 'any', list: [] }, budget: {} };
const agent = { id: 'agent_x', frozen: false, budget_started: {} };
const op = (o) => ({ action: 'swap', asset: A, destAsset: B, amount: 10n, usd: 1, ...o });
const codes = (policy, o) => evaluate(agent, validatePolicy(policy), op(o)).map((v) => v.code);

test('validatePolicy fills defaults and rejects unsupported features', () => {
  const p = validatePolicy(base);
  assert.equal(p.max_actions_per_hour, null);
  assert.equal(p.timelock_ms, 0);
  assert.equal(policyHash(p), policyHash(validatePolicy(base)));
  assert.throws(() => validatePolicy({ ...base, confidential: true }), /confidential/);
  assert.throws(() => validatePolicy({ ...base, owner_approval: 'yes' }), /owner_approval/);
  assert.throws(() => validatePolicy({ ...base, actions: ['mint'] }), /actions/);
  assert.throws(() => validatePolicy({ ...base, limits: { daily: { [A]: '-1' } } }), /atomic/);
});

test('actions, assets and destinations are enforced', () => {
  assert.deepEqual(codes(base, {}), []);
  assert.deepEqual(codes({ ...base, actions: ['transfer'] }, {}), ['policy_action_denied']);
  assert.deepEqual(codes({ ...base, assets: [A] }, {}), ['policy_asset_denied']);
  const only = { ...base, destinations: { mode: 'only', list: [{ action: 'transfer', address: 'alice.testnet', confidential: false }] } };
  assert.deepEqual(codes(only, { action: 'transfer', destAsset: undefined, destination: { chain: 'near', address: 'bob.testnet' } }), ['policy_destination_denied']);
  assert.deepEqual(codes(only, { action: 'transfer', destAsset: undefined, destination: { chain: 'near', address: 'alice.testnet' } }), []);
});

test('limits, budget and freeze are enforced', () => {
  assert.deepEqual(codes({ ...base, limits: { per_transaction: { [A]: '5' } } }, {}), ['policy_transaction_limit_exceeded']);
  assert.deepEqual(codes({ ...base, limits: { daily: { [A]: '10' } } }, {}), []);
  assert.deepEqual(codes({ ...base, limits: { daily: { [A]: '9' } } }, {}), ['policy_limit_exceeded']);
  const budget = { ...base, budget: { daily_usd: '0.5' } };
  const a = { ...agent, budget_started: { daily_usd: new Date().toISOString() } };
  assert.deepEqual(evaluate(a, validatePolicy(budget), op({})).map((v) => v.code), ['spend_budget_exceeded']);
  assert.deepEqual(evaluate(a, validatePolicy(budget), op({ usd: null })).map((v) => v.code), ['spend_price_unavailable']);
  assert.deepEqual(codes({ ...base, frozen: true }, {}), ['wallet_frozen']);
});
