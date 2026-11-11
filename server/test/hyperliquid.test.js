// Hyperliquid testnet (HyperCore) destination: amount format, EIP-712 usdSend, quote limits.
import test from 'node:test';
import assert from 'node:assert/strict';
import { ethers } from 'ethers';
import { formatUsd, parseUsd, signUsdSend, typedData, signUsdClassTransfer, incoming } from '../src/hyperliquid.js';
import { nativeDepositAddressFor } from '../src/evm.mjs';
import { hypercoreLimits, BadRequest } from '../src/engine.mjs';
import { HYPERCORE_USDC_CAP, HYPERCORE_USDC_MIN, isEvmAddress } from '../src/config.mjs';

const usdc = { kind: 'hypercore', chain: 'hypercore', symbol: 'USDC', decimals: 6 };
const near = { kind: undefined, chain: undefined, symbol: 'USDC', decimals: 6 };
const baseReq = { dry: true, swapType: 'EXACT_INPUT', depositType: 'INTENTS', refundType: 'INTENTS', recipientType: 'DESTINATION_CHAIN' };

test('formatUsd / parseUsd are inverses and drop trailing zeros', () => {
  assert.equal(formatUsd(0n), '0');
  assert.equal(formatUsd(1_000_000n), '1');
  assert.equal(formatUsd(1_500_000n), '1.5');
  assert.equal(formatUsd(1n), '0.000001');
  assert.equal(parseUsd('1'), 1_000_000n);
  assert.equal(parseUsd('1.5'), 1_500_000n);
  assert.equal(parseUsd('0.000001'), 1n);
  assert.equal(parseUsd(formatUsd(123456n)), 123456n);
});

test('recipients are 0x EVM addresses', () => {
  assert.ok(isEvmAddress('0x55F2c8044D790e1b8369508c31c756c0c2Ca0E93'));
  assert.ok(!isEvmAddress('alice.testnet'));
  assert.ok(!isEvmAddress('0x565662f245d0a66f567aa71499589f70fee8c2a5af20e8614429371fbe4f252c')); // 32-byte Sui
});

test('usdSend EIP-712 recovers the treasury signer', async () => {
  const wallet = ethers.Wallet.createRandom();
  const to = '0x0000000000000000000000000000000000000001';
  const signed = await signUsdSend(wallet, to, 1_500_000n, 1_700_000_000_000);
  assert.equal(signed.action.type, 'usdSend');
  assert.equal(signed.action.hyperliquidChain, 'Testnet');
  assert.equal(signed.action.signatureChainId, '0x66eee');
  assert.equal(signed.amount, '1.5');
  const td = typedData(signed.destination, signed.amount, signed.time);
  const recovered = ethers.verifyTypedData(td.domain, td.types, td.message, ethers.Signature.from(signed.signature));
  assert.equal(recovered.toLowerCase(), wallet.address.toLowerCase());
});

test('limits: min and cap both ways, ANY_INPUT refused', () => {
  assert.doesNotThrow(() => hypercoreLimits({ ...baseReq }, near, usdc, 2_000_000n, 2_000_000n));
  assert.doesNotThrow(() => hypercoreLimits({ ...baseReq, dry: false }, near, usdc, 5_000_000n, 5_000_000n));
  assert.throws(() => hypercoreLimits({ ...baseReq }, near, usdc, 1_000_000n, 1_000_000n), (e) => e instanceof BadRequest && e.code === 400 && /Minimum payout to Hyperliquid testnet is 2 USDC/.test(e.message));
  assert.throws(() => hypercoreLimits({ ...baseReq, dry: false }, near, usdc, 1n, HYPERCORE_USDC_MIN - 1n), (e) => e instanceof BadRequest && e.code === 400 && /Minimum payout to Hyperliquid testnet is 2 USDC/.test(e.message));
  assert.throws(() => hypercoreLimits({ ...baseReq }, near, usdc, 1n, HYPERCORE_USDC_CAP + 1n), (e) => e instanceof BadRequest && /capped/.test(e.message));
  assert.throws(() => hypercoreLimits({ ...baseReq, swapType: 'ANY_INPUT' }, near, usdc, 1n, 2_000_000n), (e) => e instanceof BadRequest && /ANY_INPUT/.test(e.message));
  // deposits from HyperCore are allowed (send and receive), with a 2 USDC minimum and no ANY_INPUT
  assert.doesNotThrow(() => hypercoreLimits({ ...baseReq, depositType: 'ORIGIN_CHAIN', refundType: 'ORIGIN_CHAIN', recipientType: 'INTENTS' }, usdc, near, 5_000_000n, 5_000_000n));
  assert.throws(() => hypercoreLimits({ ...baseReq, depositType: 'ORIGIN_CHAIN' }, usdc, near, 1_000_000n, 1_000_000n), (e) => e instanceof BadRequest && /Minimum deposit from Hyperliquid testnet is 2 USDC/.test(e.message));
  assert.throws(() => hypercoreLimits({ ...baseReq, depositType: 'ORIGIN_CHAIN', swapType: 'ANY_INPUT' }, usdc, near, 5_000_000n, 5_000_000n), (e) => e instanceof BadRequest && /ANY_INPUT/.test(e.message));
  assert.throws(() => hypercoreLimits({ ...baseReq, depositType: 'ORIGIN_CHAIN' }, usdc, near, HYPERCORE_USDC_CAP + 1n, 1n), (e) => e instanceof BadRequest && /capped/.test(e.message));
});

test('usdClassTransfer EIP-712 (spot -> perps sweep step) recovers the deposit key', async () => {
  const wallet = ethers.Wallet.createRandom();
  const signed = await signUsdClassTransfer(wallet, 4_000_000n, true, 1_700_000_000_000);
  assert.deepEqual({ type: signed.action.type, amount: signed.action.amount, toPerp: signed.action.toPerp, nonce: signed.action.nonce }, { type: 'usdClassTransfer', amount: '4', toPerp: true, nonce: 1_700_000_000_000 });
  const types = { 'HyperliquidTransaction:UsdClassTransfer': [{ name: 'hyperliquidChain', type: 'string' }, { name: 'amount', type: 'string' }, { name: 'toPerp', type: 'bool' }, { name: 'nonce', type: 'uint64' }] };
  const domain = { name: 'HyperliquidSignTransaction', version: '1', chainId: 0x66eee, verifyingContract: ethers.ZeroAddress };
  const rec = ethers.verifyTypedData(domain, types, { hyperliquidChain: 'Testnet', amount: '4', toPerp: true, nonce: 1_700_000_000_000 }, ethers.Signature.from(signed.signature));
  assert.equal(rec, wallet.address);
});

test('deposit addresses are the per-quote derived EOA, unique per quote', () => {
  const a = nativeDepositAddressFor('master-secret', 'q1'), b = nativeDepositAddressFor('master-secret', 'q2');
  assert.ok(isEvmAddress(a) && isEvmAddress(b) && a !== b);
  assert.equal(a, nativeDepositAddressFor('master-secret', 'q1'));
});

test('incoming() keeps only USDC sends to the address (usdSend and spot send shapes)', async () => {
  const me = '0x00000000000000000000000000000000000000aa';
  const rows = [
    { time: 1, hash: '0x01', delta: { type: 'send', user: '0xbb', destination: me, token: 'USDC', amount: '5.0', fee: '1.0' } },
    { time: 2, hash: '0x02', delta: { type: 'internalTransfer', usdc: '3.5', user: '0xbb', destination: me, fee: '0.0' } },
    { time: 3, hash: '0x03', delta: { type: 'send', user: me, destination: '0xcc', token: 'USDC', amount: '9' } },
    { time: 4, hash: '0x04', delta: { type: 'accountClassTransfer', usdc: '5', toPerp: true } },
    { time: 5, hash: '0x05', delta: { type: 'send', user: '0xbb', destination: me, token: 'PURR', amount: '7' } },
  ];
  const orig = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: true, json: async () => rows });
  try {
    const got = await incoming(me);
    assert.deepEqual(got.map(d => [d.hash, d.amount]), [['0x01', 5_000_000n], ['0x02', 3_500_000n]]);
  } finally { globalThis.fetch = orig; }
});
