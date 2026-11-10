// execute_intents that landed while the RPC reported an error (timeout / 429): pendingExec + verifier nonce recovery,
// the /admin "needs attention" flag, and the one-off repair of a swap whose landed tx was never recorded.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';

process.env.DATA_DIR = fs.mkdtempSync(os.tmpdir() + '/tp-exec-rec-');
const { db } = await import('../src/store.mjs');
const { internals, EXEC_TTL_MS, repairLandedSwap } = await import('../src/engine.mjs');

const USDC = 'nep141:usdc.tidepool-sandbox.testnet', USDT = 'nep141:usdt.tidepool-sandbox.testnet';
const future = new Date(Date.now() + 600_000).toISOString();
function plant(addr, extra = {}) {
  db.swaps[addr] = {
    quoteResponse: {
      correlationId: 'c-' + addr.slice(0, 6), timestamp: new Date().toISOString(),
      quoteRequest: { dry: false, swapType: 'EXACT_INPUT', slippageTolerance: 100, originAsset: USDC, depositType: 'INTENTS', destinationAsset: USDT, amount: '1000000', refundTo: 'alice.testnet', refundType: 'INTENTS', recipient: 'bob.testnet', recipientType: 'INTENTS', deadline: future },
      quote: { amountIn: '1000000', minAmountIn: '1000000', amountOut: '990000', minAmountOut: '980000', depositAddress: addr, deadline: future, timeWhenInactive: future },
    },
    status: 'PROCESSING', updatedAt: new Date().toISOString(), deposited: '1000000',
    txs: [], intentHashes: [], originTxs: [], destTxs: [], ...extra,
  };
  return db.swaps[addr];
}
const nonceUsed = (used) => { internals.view = async (c, m) => { assert.equal(m, 'is_nonce_used'); return used; }; };

test('recover: landed settle (nonce used) finishes SUCCESS with the recorded amounts', async () => {
  const s = plant('a1'.repeat(32), { pendingExec: { kind: 'settle', signer: 'a1'.repeat(32), nonce: 'n1', at: Date.now(), out: '990000', excess: '0', extra: { amountIn: '1000000', amountOut: '990000' } } });
  nonceUsed(true);
  await internals.recoverExec('a1'.repeat(32), s);
  assert.equal(s.status, 'SUCCESS');
  assert.equal(s.amountOut, '990000');
  assert.equal(s.pendingExec, undefined);
  assert.match(s.note, /recovered/);
});

test('recover: unused nonce waits during the intent lifetime, then clears for a normal retry', async () => {
  const s = plant('a2'.repeat(32), { pendingExec: { kind: 'settle', signer: 'x', nonce: 'n2', at: Date.now(), out: '1', excess: '0', extra: {} } });
  nonceUsed(false);
  await internals.recoverExec('a2'.repeat(32), s);
  assert.ok(s.pendingExec, 'kept while the intent may still land');
  assert.equal(s.status, 'PROCESSING');
  s.pendingExec.at = Date.now() - EXEC_TTL_MS - 60_000;
  await internals.recoverExec('a2'.repeat(32), s);
  assert.equal(s.pendingExec, undefined);
  assert.equal(s.status, 'PROCESSING');
});

test('recover: landed refund finishes with the refund status and reason', async () => {
  const s = plant('a3'.repeat(32), { pendingExec: { kind: 'refund', signer: 'x', nonce: 'n3', at: Date.now(), amount: '1000000', reason: 'DEADLINE_PASSED', status: 'REFUNDED' } });
  nonceUsed(true);
  await internals.recoverExec('a3'.repeat(32), s);
  assert.equal(s.status, 'REFUNDED');
  assert.equal(s.refundReason, 'DEADLINE_PASSED');
  assert.equal(s.refunded, '1000000');
});

test('tick: pendingExec is checked before anything else', async () => {
  const s = plant('a4'.repeat(32), { pendingExec: { kind: 'settle', signer: 'x', nonce: 'n4', at: Date.now(), out: '990000', excess: '0', extra: { amountOut: '990000' } } });
  nonceUsed(true);
  internals.intentsBal = async () => { throw new Error('balance must not be read'); };
  await internals.tick('a4'.repeat(32), s);
  assert.equal(s.status, 'SUCCESS');
});

test('tick: PROCESSING with zero balance and no swap tx is flagged for /admin', async () => {
  const s = plant('a5'.repeat(32));
  internals.intentsBal = async () => 0n;
  await internals.tick('a5'.repeat(32), s);
  assert.equal(s.status, 'PROCESSING');
  assert.match(s.attention, /zero intents balance/);
});

test('repair: a landed but unrecorded swap tx is verified, recorded and finished', async () => {
  const addr = 'a6'.repeat(32);
  const s = plant(addr, { deposited: '1010000', attention: 'x' });
  const ev = { standard: 'dip4', event: 'token_diff', data: [{ intent_hash: 'H1', account_id: addr, diff: { [USDC]: '-1000000', [USDT]: '990000' } }] };
  internals.rpc = async (m, p) => { assert.equal(m, 'tx'); assert.equal(p.tx_hash, 'TX1'); return { status: { SuccessValue: '' }, transaction: { receiver_id: 'verifier.tidepool-sandbox.testnet' }, receipts_outcome: [{ outcome: { status: { SuccessValue: '' }, logs: ['EVENT_JSON:' + JSON.stringify(ev)] } }] }; };
  assert.equal(await repairLandedSwap(addr, s, 'TX1'), true);
  assert.equal(s.status, 'SUCCESS');
  assert.equal(s.amountIn, '1000000');
  assert.equal(s.amountOut, '990000');
  assert.equal(s.refunded, '10000');
  assert.deepEqual(s.txs.map(t => t.hash), ['TX1']);
  assert.equal(s.attention, undefined);
  assert.equal(await repairLandedSwap(addr, s, 'TX1'), false, 'idempotent');
});
