// Public explorer: only funded, non-simulated swaps, and only public-safe fields.
import test from 'node:test';
import assert from 'node:assert/strict';
import { db } from '../src/store.mjs';
import { TOKENS } from '../src/config.mjs';
import { explorerSwaps, explorerStats, explorerLimited } from '../src/explorer.js';

const usdc = TOKENS.find(t => t.symbol === 'USDC'), usdt = TOKENS.find(t => t.symbol === 'USDT');
const swap = (status, extra = {}) => ({ quoteResponse: { correlationId: 'c', timestamp: new Date().toISOString(), quoteRequest: { swapType: 'EXACT_INPUT', originAsset: usdc.assetId, destinationAsset: usdt.assetId, recipient: 'bob.testnet', refundTo: 'alice.testnet' }, quote: { amountIn: '1000000', amountInFormatted: '1', amountInUsd: '1.0000', amountOutFormatted: '0.99', amountOutUsd: '0.9900' } }, status, updatedAt: new Date().toISOString(), txs: [], intentHashes: [], originTxs: [], destTxs: [], intentsAccount: 'secret-internal', note: 'internal note', ...extra });

test('explorer lists funded swaps with public fields only', () => {
  const saved = db.swaps; db.swaps = { aaa: swap('SUCCESS', { amountIn: '1000000', amountOut: '990000', deposited: '1000000' }), bbb: swap('PENDING_DEPOSIT'), ccc: swap('FAILED', { simulate: 'FAILED', deposited: '1' }) };
  try {
    const r = explorerSwaps(new URLSearchParams('limit=10'));
    assert.equal(r.total, 1);
    const s = r.data[0];
    assert.equal(s.depositAddress, 'aaa'); assert.equal(s.from.symbol, 'USDC'); assert.equal(s.to.amount, '0.99'); assert.equal(s.from.amountUsd, '1.00');
    const txt = JSON.stringify(r);
    assert.ok(!txt.includes('secret-internal') && !txt.includes('internal note'));
    assert.equal(explorerSwaps(new URLSearchParams('status=REFUNDED')).total, 0);
    assert.equal(explorerSwaps(new URLSearchParams('search=bob')).total, 1);
    const st = explorerStats(); assert.equal(st.totalSwaps, 1); assert.equal(st.volumeUsd, '1.00');
  } finally { db.swaps = saved; }
});

test('explorer rate limit trips after 120 requests a minute', () => {
  let limited = false; for (let i = 0; i < 121; i++) limited = explorerLimited('203.0.113.9');
  assert.equal(limited, true);
});
