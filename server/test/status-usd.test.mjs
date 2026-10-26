// Regression: refunds (no settlement prices stored) must still report USD values in /v0/status.
import test from 'node:test';
import assert from 'node:assert/strict';
import { statusPrices } from '../src/engine.mjs';

const quoteResponse = { quote: { amountIn: '5000000', amountInFormatted: '5', amountInUsd: '4.9985', amountOut: '1', amountOutFormatted: '2.5', amountOutUsd: '4.9800' } };

test('refund without settlement prices falls back to quote unit prices', () => {
  const px = statusPrices({ quoteResponse });
  assert.equal(px.in.toFixed(4), '0.9997');
  assert.equal(px.out.toFixed(4), '1.9920');
  assert.equal((5 * px.in).toFixed(4), '4.9985'); // refundedAmountUsd for a full 5 USDC refund
});

test('settled swaps keep settlement prices', () => {
  assert.deepEqual(statusPrices({ quoteResponse, prices: { in: 1.01, out: 2 } }), { in: 1.01, out: 2 });
});

test('missing quote data gives 0, not NaN', () => {
  assert.deepEqual(statusPrices({ quoteResponse: { quote: { amountInFormatted: '0' } } }), { in: 0, out: 0 });
});
