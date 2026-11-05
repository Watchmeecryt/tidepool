import test from 'node:test';
import assert from 'node:assert/strict';
import { suiOmftSub, isSuiAddress, normSuiAddress, SUI_CAP_MIST, SUI_DECIMALS, chainOf, SUI_CHAIN } from '../src/config.mjs';
import * as sui from '../src/sui.mjs';
import { suiLimits, BadRequest, suggestAsset } from '../src/engine.mjs';
import { resolveIntentAssets, CHAIN_ALIASES } from '../src/faucet-assets.mjs';

test('omft sub-id of Sui USDC matches the one 1Click lists on mainnet (keccak256 of the coin type)', () => {
  assert.equal(suiOmftSub('0xdba34672e30cb065b1f93e3ab55318768fd6fef66c15942c9f7cb846e2f900e7::usdc::USDC'), 'sui-c1b81ecaf27933252d31a963bc5e9458f13c18ce');
  assert.match(suiOmftSub('0x2::sui::SUI'), /^sui-[0-9a-f]{40}$/);
});

test('Sui address validation is strict (0x + 64 hex)', () => {
  const a = '0x' + 'ab'.repeat(32);
  assert.ok(isSuiAddress(a) && isSuiAddress(a.toUpperCase().replace('0X', '0x')));
  assert.ok(!isSuiAddress('0x' + 'ab'.repeat(20)));
  assert.ok(!isSuiAddress('0x' + 'zz'.repeat(32)));
  assert.ok(!isSuiAddress('alice.testnet'));
  assert.equal(normSuiAddress('0x' + 'AB'.repeat(32)), a);
  assert.equal(chainOf('sui'), SUI_CHAIN);
});

test('per-quote deposit addresses are deterministic, unique per quote and master', () => {
  const m = Buffer.alloc(32, 7);
  const a = sui.depositAddressFor(m, 'q1'), b = sui.depositAddressFor(m, 'q2');
  assert.ok(isSuiAddress(a));
  assert.equal(a, sui.depositAddressFor(m, 'q1'));
  assert.notEqual(a, b);
  assert.notEqual(a, sui.depositAddressFor(Buffer.alloc(32, 8), 'q1'));
  assert.equal(sui.depositKeypair(m, 'q1').kp.toSuiAddress(), a);
});

const SUI = { kind: 'sui', native: true, symbol: 'SUI', decimals: SUI_DECIMALS };
const USDC = { kind: 'sui', symbol: 'USDC', decimals: 6 };
const NEAR_USDC = { symbol: 'USDC', decimals: 6 };
const req = (o = {}) => ({ swapType: 'EXACT_INPUT', depositType: 'ORIGIN_CHAIN', refundType: 'ORIGIN_CHAIN', recipientType: 'DESTINATION_CHAIN', ...o });

test('SUI cap is 0.005 SUI, enforced on every SUI leg; Sui coins are not capped', () => {
  assert.equal(SUI_CAP_MIST, 5_000_000n);
  assert.doesNotThrow(() => suiLimits(req(), SUI, NEAR_USDC, 5_000_000n, 1n));
  assert.throws(() => suiLimits(req(), SUI, NEAR_USDC, 5_000_001n, 1n), (e) => e instanceof BadRequest && /capped at 0.005 SUI/.test(e.message));
  assert.throws(() => suiLimits(req({ depositType: 'INTENTS' }), NEAR_USDC, SUI, 1n, 5_000_001n), (e) => e instanceof BadRequest && /capped at 0.005 SUI/.test(e.message));
  assert.doesNotThrow(() => suiLimits(req({ depositType: 'INTENTS' }), NEAR_USDC, SUI, 1n, 5_000_000n));
  assert.doesNotThrow(() => suiLimits(req(), USDC, NEAR_USDC, 10n ** 15n, 1n));
});

test('SUI payouts reject ANY_INPUT', () => {
  assert.throws(() => suiLimits(req({ swapType: 'ANY_INPUT' }), NEAR_USDC, SUI, 1n, 1n), (e) => e instanceof BadRequest && /ANY_INPUT/.test(e.message));
});

test('faucet: the `sui` chain alias expands to verifier-only SUI, USDC and USDT', () => {
  assert.ok(CHAIN_ALIASES.includes('sui'));
  const pool = [
    { assetId: 'nep141:sui.tp-omft.testnet', blockchain: 'sui', symbol: 'SUI', drip: '0.5' },
    { assetId: 'nep141:sui-aa.tp-omft.testnet', blockchain: 'sui', symbol: 'USDC', drip: '100' },
    { assetId: 'nep141:sui-bb.tp-omft.testnet', blockchain: 'sui', symbol: 'USDT', drip: '100' },
    { assetId: 'nep141:sol.tp-omft.testnet', blockchain: 'sol', symbol: 'SOL', drip: '0.05' },
    { assetId: 'usdc.tp.testnet', blockchain: 'near', symbol: 'USDC', drip: '100' },
  ];
  assert.deepEqual(resolveIntentAssets(['sui'], pool).map(t => t.symbol), ['SUI', 'USDC', 'USDT']);
});

test('1Click mainnet Sui ids resolve to the testnet assets', { skip: !SUI_CHAIN.deployed }, () => {
  const id = (sym) => SUI_CHAIN.tokens.find(t => t.symbol === sym).assetId;
  assert.equal(suggestAsset('nep141:sui.omft.near'), id('SUI'));
  assert.equal(suggestAsset('nep141:sui-c1b81ecaf27933252d31a963bc5e9458f13c18ce.omft.near'), id('USDC'));
});
