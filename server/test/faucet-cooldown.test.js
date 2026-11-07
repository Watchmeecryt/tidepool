import { test } from 'node:test';
import assert from 'node:assert/strict';
import { db } from '../src/store.mjs';
import { drip, nearDripCheck } from '../src/faucet.mjs';
import { BadRequest } from '../src/engine.mjs';
import { setFaucetCheckers } from '../src/faucet-guard.js';

setFaucetCheckers({ nearExists: async () => true, nearCreatedAt: async () => 0, evmActive: async () => true });

const DAY = 7 * 24 * 60 * 60_000;
const ADDR = '0x' + 'ab'.repeat(20);
const NEAR = 'cooldown-bot.testnet';

function wipe(prefix) {
  for (const k of Object.keys(db.faucet || {})) {
    if (k.startsWith(prefix) || k.toLowerCase().startsWith(prefix.toLowerCase())) delete db.faucet[k];
  }
}

test('faucet: same EVM address is blocked across chains for 24h', async () => {
  wipe(ADDR.toLowerCase());
  db.faucet[`${ADDR.toLowerCase()}:base`] = Date.now() - 60_000; // claimed base a minute ago
  await assert.rejects(
    () => drip({ chain: 'eth', address: ADDR }, '203.0.113.9'),
    (e) => e instanceof BadRequest && e.code === 429 && e.extra?.available_at && e.extra?.retryAfterSeconds > 0
      && /7 days/.test(e.message),
  );
  await assert.rejects(
    () => drip({ chain: 'base', address: ADDR.toUpperCase().replace('0X', '0x') }, '203.0.113.10'),
    (e) => e.code === 429,
  );
  wipe(ADDR.toLowerCase());
});

test('faucet: NEAR claim blocks wallet, intents and bridged for 24h', async () => {
  wipe(NEAR);
  db.faucet[`${NEAR}:wallet`] = Date.now();
  await assert.rejects(() => drip({ accountId: NEAR, mode: 'intents' }, '203.0.113.11'), (e) => e.code === 429 && /7 days/.test(e.message));
  assert.throws(() => nearDripCheck(NEAR, '203.0.113.12'), (e) => e.code === 429 && !!e.extra?.available_at);
  wipe(NEAR);
});

test('faucet: claim older than 24h is allowed past the cooldown check', async () => {
  wipe(ADDR.toLowerCase());
  db.faucet[`${ADDR.toLowerCase()}:arb`] = Date.now() - DAY - 60_000;
  // Will fail later (mint/network) or on IP; we only assert it is NOT a 429 from the 24h window.
  try {
    await drip({ chain: 'base', address: ADDR }, '203.0.113.13');
  } catch (e) {
    assert.notEqual(e.code, 429, `unexpected 429 after cooldown: ${e.message}`);
  }
  wipe(ADDR.toLowerCase());
});

test('faucet: 429 payload includes retryAfter and available_at', async () => {
  wipe(NEAR);
  const at = Date.now() - 1000;
  db.faucet[`${NEAR}:intents`] = at;
  try {
    await drip({ accountId: NEAR, mode: 'wallet' }, '203.0.113.14');
    assert.fail('expected 429');
  } catch (e) {
    assert.equal(e.code, 429);
    assert.equal(e.extra.available_at, new Date(at + DAY).toISOString());
    assert.equal(e.extra.retryAfter, e.extra.available_at);
    assert.ok(e.extra.retryAfterSeconds >= DAY / 1000 - 5);
  }
  wipe(NEAR);
});

test('faucet: concurrent claims for one address cannot both pass the 24h check (regression)', async () => {
  const A = '0x' + 'cd'.repeat(20);
  wipe(A);
  setFaucetCheckers({ nearExists: async () => true, nearCreatedAt: async () => 0, evmActive: () => new Promise((_, rej) => setTimeout(() => rej(new BadRequest('not eligible', 403)), 50)) });
  const first = drip({ chain: 'eth', address: A }, '203.0.113.30');
  await assert.rejects(() => drip({ chain: 'base', address: A.toUpperCase().replace('0X', '0x') }, '203.0.113.31'), (e) => e.code === 429);
  await assert.rejects(first, (e) => e.code === 403);
  assert.equal(Object.keys(db.faucet).some(k => k.startsWith(A)), false, 'rejected claim releases its slot');
  setFaucetCheckers({ nearExists: async () => true, nearCreatedAt: async () => 0, evmActive: async () => true });
  wipe(A);
});
