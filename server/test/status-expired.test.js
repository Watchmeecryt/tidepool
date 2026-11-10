// Unpaid quotes past deadline stay PENDING_DEPOSIT (1Click has no EXPIRED status).
// The old path that persisted FAILED is repaired back to PENDING_DEPOSIT.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';

process.env.DATA_DIR = fs.mkdtempSync(os.tmpdir() + '/tp-status-exp-');
const { db } = await import('../src/store.mjs');
const {
  statusOf, isExpiredUnpaid, isExpiredUnpaidMarkedFailed,
  restoreExpiredUnpaidFailed, swapStats, EXPIRED_UNPAID_NOTE,
} = await import('../src/engine.mjs');

const past = new Date(Date.now() - 60_000).toISOString();
const future = new Date(Date.now() + 600_000).toISOString();
const baseQuote = (deadline, depositAddress) => ({
  correlationId: 'c-' + depositAddress.slice(0, 8),
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

test('status: unpaid quote past deadline stays PENDING_DEPOSIT', () => {
  const addr = 'aa'.repeat(32);
  plant(addr, { deadline: past });
  const out = statusOf(addr);
  assert.equal(out.status, 'PENDING_DEPOSIT');
  assert.equal(db.swaps[addr].status, 'PENDING_DEPOSIT');
  assert.equal(out.tidepool.note, EXPIRED_UNPAID_NOTE);
  assert.equal(isExpiredUnpaid(db.swaps[addr]), true);
});

test('status: unpaid quote before deadline stays PENDING_DEPOSIT with no expired note', () => {
  const addr = 'bb'.repeat(32);
  plant(addr, { deadline: future });
  const out = statusOf(addr);
  assert.equal(out.status, 'PENDING_DEPOSIT');
  assert.equal(db.swaps[addr].status, 'PENDING_DEPOSIT');
  assert.notEqual(out.tidepool.note, EXPIRED_UNPAID_NOTE);
  assert.equal(isExpiredUnpaid(db.swaps[addr]), false);
});

test('status: funded (non-PENDING) swaps past deadline are unchanged', () => {
  const addr = 'cc'.repeat(32);
  plant(addr, { status: 'PROCESSING', deadline: past, extra: { deposited: '1000000' } });
  assert.equal(statusOf(addr).status, 'PROCESSING');
  assert.equal(db.swaps[addr].status, 'PROCESSING');
});

test('status: wrongly marked unpaid FAILED is restored to PENDING_DEPOSIT', () => {
  const addr = 'dd'.repeat(32);
  plant(addr, { status: 'FAILED', deadline: past, extra: { note: EXPIRED_UNPAID_NOTE } });
  assert.equal(isExpiredUnpaidMarkedFailed(db.swaps[addr]), true);
  const out = statusOf(addr);
  assert.equal(out.status, 'PENDING_DEPOSIT');
  assert.equal(db.swaps[addr].status, 'PENDING_DEPOSIT');
  assert.equal(out.tidepool.note, EXPIRED_UNPAID_NOTE);
});


test('status: unpaid FAILED with a tick-error note (HTTP 429) is restored', () => {
  const addr = '33'.repeat(32);
  plant(addr, { status: 'FAILED', deadline: past, extra: { note: 'HTTP 429' } });
  assert.equal(isExpiredUnpaidMarkedFailed(db.swaps[addr]), true);
  const out = statusOf(addr);
  assert.equal(out.status, 'PENDING_DEPOSIT');
  assert.equal(db.swaps[addr].status, 'PENDING_DEPOSIT');
  assert.equal(out.tidepool.note, EXPIRED_UNPAID_NOTE);
});
test('restoreExpiredUnpaidFailed: flips only unpaid-expired FAILED rows', () => {
  const unpaid = 'ee'.repeat(32);
  const sim = 'ff'.repeat(32);
  const uncredited = '11'.repeat(32);
  const refundFail = '22'.repeat(32);
  plant(unpaid, { status: 'FAILED', deadline: past, extra: { note: EXPIRED_UNPAID_NOTE } });
  plant(sim, { status: 'FAILED', deadline: past, extra: { simulate: 'FAILED', deposited: '1000000', refunded: '1000000', refundReason: 'SWAP_FAILED', note: 'Simulated FAILED' } });
  plant(uncredited, { status: 'FAILED', deadline: past, extra: { originTxs: ['0xabc'], note: 'No deposit was credited within 24 hours after the deadline' } });
  plant(refundFail, { status: 'FAILED', deadline: past, extra: { deposited: '1000000', txs: [{ label: 'refund', hash: 'h' }], note: 'refund failed: timeout' } });
  const summary = restoreExpiredUnpaidFailed();
  assert.equal(db.swaps[unpaid].status, 'PENDING_DEPOSIT');
  assert.equal(db.swaps[sim].status, 'FAILED');
  assert.equal(db.swaps[uncredited].status, 'FAILED');
  assert.equal(db.swaps[refundFail].status, 'FAILED');
  assert.ok(summary.repaired >= 1);
  assert.equal(summary.counts.simulate_FAILED >= 1, true);
  assert.equal(isExpiredUnpaidMarkedFailed(db.swaps[sim]), false);
  assert.equal(isExpiredUnpaidMarkedFailed(db.swaps[uncredited]), false);
  assert.equal(isExpiredUnpaidMarkedFailed(db.swaps[refundFail]), false);
});

test('swapStats: expired unpaid quotes are counted separately from failed and active', () => {
  // isolate: only the swaps planted in this file exist in this temp DATA_DIR, but earlier tests added rows.
  const stats = swapStats();
  assert.equal(stats.expired >= 1, true);
  assert.equal(stats.total, Object.keys(db.swaps).length);
  assert.equal(stats.success + stats.refunded + stats.failed + stats.expired + stats.active, stats.total);
  // A still-live unpaid quote (future deadline) is active, not expired.
  const live = Object.values(db.swaps).filter(s => s.status === 'PENDING_DEPOSIT' && !isExpiredUnpaid(s)).length;
  const expired = Object.values(db.swaps).filter(s => isExpiredUnpaid(s)).length;
  const failed = Object.values(db.swaps).filter(s => s.status === 'FAILED').length;
  assert.equal(stats.expired, expired);
  assert.equal(stats.failed, failed);
  assert.ok(live + expired + failed <= stats.total);
});
