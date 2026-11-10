import { test } from 'node:test';
import assert from 'node:assert/strict';
import { db } from '../src/store.mjs';
import { drip } from '../src/faucet.mjs';
import { setFaucetCheckers, assertHuman, assertNearEligible } from '../src/faucet-guard.js';

const HOUR = 3600_000;
const wipe = (p) => { for (const k of Object.keys(db.faucet || {})) if (k.toLowerCase().startsWith(p.toLowerCase())) delete db.faucet[k]; };

test('faucet: brand-new NEAR account is rejected with 403', async () => {
  setFaucetCheckers({ nearExists: async () => true, nearCreatedAt: async () => Date.now() - HOUR });
  wipe('fresh-bot.testnet');
  await assert.rejects(() => drip({ accountId: 'fresh-bot.testnet', mode: 'intents' }, '198.51.100.1'), (e) => e.code === 403 && e.extra.reason === 'account_too_new' && /3 hours/.test(e.message));
  assert.equal(Object.keys(db.faucet).some(k => k.startsWith('fresh-bot.testnet')), false, 'rejected claim must not consume the claim slot');
});

test('faucet: NEAR account at least 3 hours old passes the age check', async () => {
  setFaucetCheckers({ nearExists: async () => true, nearCreatedAt: async () => Date.now() - 3 * HOUR });
  await assertNearEligible('old-enough.testnet');
});

test('faucet: missing NEAR account is rejected with 403', async () => {
  setFaucetCheckers({ nearExists: async () => false });
  await assert.rejects(() => drip({ accountId: 'ghost-bot.testnet', mode: 'intents' }, '198.51.100.2'), (e) => e.code === 403 && e.extra.reason === 'account_not_found');
});

test('faucet: EVM address with no Sepolia activity is rejected with 403', async () => {
  setFaucetCheckers({ evmActive: async () => false });
  const a = '0x' + 'cd'.repeat(20); wipe(a);
  await assert.rejects(() => drip({ chain: 'eth', address: a }, '198.51.100.3'), (e) => e.code === 403 && e.extra.reason === 'address_inactive');
});

test('faucet: IP cap is 2 claims per 3 hours', async () => {
  setFaucetCheckers({ evmActive: async () => true });
  const ip = '198.51.100.9';
  for (let i = 0; i < 2; i++) { const a = '0x' + String(i + 1).repeat(40); wipe(a); try { await drip({ chain: 'eth', address: a }, ip); } catch (e) { assert.notEqual(e.code, 429); } }
  const a = '0x' + '7'.repeat(40); wipe(a);
  await assert.rejects(() => drip({ chain: 'eth', address: a }, ip), (e) => e.code === 429 && /3 hours/.test(e.message) && e.extra.retryAfterSeconds > 0);
});

test('faucet: captcha only enforced when TURNSTILE_SECRET is set', async () => {
  delete process.env.TURNSTILE_SECRET;
  await assertHuman({}, '1.2.3.4', false);
  process.env.TURNSTILE_SECRET = 'test-secret';
  try {
    await assert.rejects(() => assertHuman({}, '1.2.3.4', false), (e) => e.code === 403 && e.extra.reason === 'captcha_required');
    await assertHuman({}, '1.2.3.4', true); // valid API key bypasses
  } finally { delete process.env.TURNSTILE_SECRET; }
});
