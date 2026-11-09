// Unpaid quotes past deadline become FAILED on /v0/status (persisted). Funded swaps are unchanged.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';

process.env.DATA_DIR = fs.mkdtempSync(os.tmpdir() + '/tp-status-exp-');
const { db } = await import('../src/store.mjs');
const { statusOf } = await import('../src/engine.mjs');

const past = new Date(Date.now() - 60_000).toISOString();
const future = new Date(Date.now() + 600_000).toISOString();
const baseQuote = (deadline, depositAddress) => ({
  correlationId: 'c1',
  timestamp: new Date().toISOString(),
  quoteRequest: {
    dry: false, swapType: 'EXACT_INPUT', slippageTolerance: 100,
    originAsset: 'nep141:usdc.tidepool-sandbox.testnet', depositType: 'INTENTS',
    destinationAsset: 'nep141:usdt.tidepool-sandbox.testnet', amount: '1000000',
    refundTo: 'alice.testnet', refundType: 'INTENTS',
    recipient: 'bob.testnet', recipientType: 'INTENTS', deadline,
  },
  quote: {
    amountIn: '1000000', amountInFormatted: '1', amountInUsd: '1', minAmountIn: '1000000',
    amountOut: '1000000', amountOutFormatted: '1', amountOutUsd: '1', minAmountOut: '990000',
    timeEstimate: 60, depositAddress, deadline, timeWhenInactive: deadline,
  },
});

function plant(addr, { status = 'PENDING_DEPOSIT', deadline, extra = {} } = {}) {
  db.swaps[addr] = {
    quoteResponse: baseQuote(deadline, addr),
    status, updatedAt: new Date().toISOString(),
    txs: [], intentHashes: [], originTxs: [], destTxs: [],
    ...extra,
  };
}

test('status: unpaid quote past deadline becomes FAILED and persists', () => {
  const addr = 'aa'.repeat(32);
  plant(addr, { deadline: past });
  const out = statusOf(addr);
  assert.equal(out.status, 'FAILED');
  assert.equal(db.swaps[addr].status, 'FAILED');
  assert.match(db.swaps[addr].note || '', /deadline/i);
  assert.equal(statusOf(addr).status, 'FAILED'); // still FAILED on re-read
});

test('status: unpaid quote before deadline stays PENDING_DEPOSIT', () => {
  const addr = 'bb'.repeat(32);
  plant(addr, { deadline: future });
  assert.equal(statusOf(addr).status, 'PENDING_DEPOSIT');
  assert.equal(db.swaps[addr].status, 'PENDING_DEPOSIT');
});

test('status: funded (non-PENDING) swaps past deadline are unchanged', () => {
  const addr = 'cc'.repeat(32);
  plant(addr, { status: 'PROCESSING', deadline: past, extra: { deposited: '1000000' } });
  assert.equal(statusOf(addr).status, 'PROCESSING');
  assert.equal(db.swaps[addr].status, 'PROCESSING');
});
