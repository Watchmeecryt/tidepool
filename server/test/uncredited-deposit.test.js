// KNOWN_DEPOSIT_TX swaps with nothing credited end as FAILED: after deadline + 24 h, or right after the deadline
// when the submitted EVM deposit tx is confirmed reverted. Also: per-chain explorer links for recorded txs.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';

process.env.DATA_DIR = fs.mkdtempSync(os.tmpdir() + '/tp-uncredited-');
const { db } = await import('../src/store.mjs');
const { statusOf, expireUncredited, UNCREDITED_GRACE_MS, internals, txExplorerUrl } = await import('../src/engine.mjs');

const H = '0x' + '9a'.repeat(32);
function plant(addr, deadlineMs, extra = {}) {
  const deadline = new Date(deadlineMs).toISOString();
  db.swaps[addr] = {
    quoteResponse: {
      correlationId: 'c-' + addr.slice(2, 8), timestamp: new Date().toISOString(),
      quoteRequest: { dry: false, swapType: 'EXACT_INPUT', slippageTolerance: 100, originAsset: 'nep141:usdc.tidepool-sandbox.testnet', depositType: 'INTENTS', destinationAsset: 'nep141:usdt.tidepool-sandbox.testnet', amount: '1000000', refundTo: 'alice.testnet', refundType: 'INTENTS', recipient: 'bob.testnet', recipientType: 'INTENTS', deadline },
      quote: { amountIn: '1000000', minAmountIn: '1000000', amountOut: '990000', minAmountOut: '980000', depositAddress: addr, deadline, timeWhenInactive: deadline },
    },
    status: 'KNOWN_DEPOSIT_TX', updatedAt: new Date().toISOString(),
    txs: [], intentHashes: [], originTxs: [H], destTxs: [], evmTxs: { [H]: 'eth' }, ...extra,
  };
  return db.swaps[addr];
}

test('uncredited KNOWN_DEPOSIT_TX past deadline + 24 h becomes FAILED on /v0/status', () => {
  const addr = '0x' + '11'.repeat(20);
  plant(addr, Date.now() - UNCREDITED_GRACE_MS - 60_000);
  assert.equal(statusOf(addr).status, 'FAILED');
  assert.match(db.swaps[addr].note, /24 hours/);
});

test('uncredited KNOWN_DEPOSIT_TX inside the grace window is unchanged', () => {
  const addr = '0x' + '22'.repeat(20);
  plant(addr, Date.now() - 60_000);
  assert.equal(statusOf(addr).status, 'KNOWN_DEPOSIT_TX');
});

test('a credited or bridging deposit is never expired', () => {
  const old = Date.now() - UNCREDITED_GRACE_MS - 60_000;
  assert.equal(expireUncredited(plant('0x' + '33'.repeat(20), old, { deposited: '1000000' })), false);
  assert.equal(expireUncredited(plant('0x' + '44'.repeat(20), old, { bridgeIn: [{ stage: 'swept', amount: '1' }] })), false);
  assert.equal(expireUncredited(plant('0x' + '55'.repeat(20), old, { txs: [{ label: 'x', hash: 'h' }] })), false);
});

test('reverted EVM deposit tx past the deadline fails at the next tick', async () => {
  const addr = '0x' + '66'.repeat(20);
  const s = plant(addr, Date.now() - 60_000);
  internals.evmReceipt = async (chain, h) => { assert.equal(chain, 'eth'); assert.equal(h, H); return { status: 0 }; };
  internals.intentsBal = async () => { throw new Error('should not get here'); };
  await internals.tick(addr, s);
  assert.equal(s.status, 'FAILED');
  assert.match(s.note, /reverted/);
});

test('successful EVM deposit tx is not failed early', async () => {
  const addr = '0x' + '77'.repeat(20);
  const s = plant(addr, Date.now() - 60_000);
  internals.evmReceipt = async () => ({ status: 1 });
  internals.intentsBal = async () => 0n;
  await internals.tick(addr, s).catch(() => {});
  assert.equal(s.status, 'KNOWN_DEPOSIT_TX');
});

test('explorer links follow the chain each tx was recorded on', () => {
  const s = { evmTxs: { [H]: 'eth', SolSig1: 'sol' } };
  assert.match(txExplorerUrl(s, 'NearHash1'), /^https:\/\/testnet\.nearblocks\.io\/txns\/NearHash1$/);
  assert.match(txExplorerUrl(s, 'SolSig1'), /explorer\.solana\.com\/tx\/SolSig1\?cluster=devnet/);
  assert.match(txExplorerUrl(s, H), new RegExp(`/tx/${H}$`));
  assert.doesNotMatch(txExplorerUrl(s, H), /nearblocks/);
});
