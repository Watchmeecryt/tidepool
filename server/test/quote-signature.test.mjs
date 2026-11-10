// Quote signatures must verify with the official 1Click SDK (byte-for-byte scheme).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import { KeyPair } from 'near-api-js';
import { verifyQuoteSignature } from '@defuse-protocol/one-click-sdk-typescript';

process.env.DATA_DIR = fs.mkdtempSync(os.tmpdir() + '/tp-qsig-');
const { signQuote } = await import('../src/engine.mjs');

const kp = KeyPair.fromRandom('ed25519');
const pub = kp.getPublicKey().toString();
const signed = (body) => ({ ...body, signature: signQuote(body, kp) });

const request = {
  dry: true,
  swapType: 'EXACT_INPUT',
  slippageTolerance: 100,
  originAsset: 'nep141:usdc.tidepool-sandbox.testnet',
  depositType: 'INTENTS',
  destinationAsset: 'nep141:usdt.tidepool-sandbox.testnet',
  amount: '1000000',
  refundTo: 'alice.testnet',
  refundType: 'INTENTS',
  recipient: 'bob.testnet',
  recipientType: 'INTENTS',
  deadline: '2030-01-01T00:00:00.000Z',
};
const amounts = {
  amountIn: '1000000',
  amountInFormatted: '1',
  amountInUsd: '1.00',
  minAmountIn: '1000000',
  amountOut: '990000',
  amountOutFormatted: '0.99',
  amountOutUsd: '0.99',
  minAmountOut: '980100',
};

test('dry quote from the engine verifies with verifyQuoteSignature', () => {
  const resp = signed({
    correlationId: '550e8400-e29b-41d4-a716-446655440000',
    timestamp: '2026-11-10T20:00:00.000Z',
    quoteRequest: { ...request, dry: true, appFees: [{ recipient: 'fees.testnet', fee: 50 }], depositMode: 'SIMPLE', sessionId: 's1', connectedWallets: ['alice.testnet'] },
    quote: { ...amounts, timeEstimate: 10 },
  });
  assert.equal(verifyQuoteSignature(resp, pub), true);
  assert.equal(verifyQuoteSignature(resp), false, 'the default 1Click key must not verify Tidepool signatures');
});

test('non-dry quote from the engine verifies with verifyQuoteSignature', () => {
  const resp = signed({
    correlationId: '550e8400-e29b-41d4-a716-446655440001',
    timestamp: '2026-11-10T20:00:01.000Z',
    quoteRequest: { ...request, dry: false, referral: 'tidepool-docs', quoteWaitingTimeMs: 3000 },
    quote: {
      ...amounts,
      depositAddress: 'quotedep.testnet',
      depositMemo: '123456789012',
      deadline: '2030-01-01T00:00:00.000Z',
      timeWhenInactive: '2030-01-01T00:00:00.000Z',
      timeEstimate: 10,
    },
  });
  assert.equal(verifyQuoteSignature(resp, pub), true);
  const tampered = { ...resp, quote: { ...resp.quote, depositAddress: 'other.testnet' } };
  assert.equal(verifyQuoteSignature(tampered, pub), false);
});
