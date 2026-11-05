// Native ETH (delivery only) on the EVM testnets: token catalog, assetIds, per-swap cap and /v0 + /v1 consistency. No network is touched.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
process.env.DATA_DIR = fs.mkdtempSync(os.tmpdir() + '/tp-eth-');
const { TOKENS, ETH_CAP_WEI, ETH_RESERVE_WEI, EVM_CHAINS } = await import('../src/config.mjs');
const { ethLimits, BadRequest, suggestAsset } = await import('../src/engine.mjs');
const { resolveIntentAssets } = await import('../src/faucet-assets.mjs');

const native = (chain) => TOKENS.find((t) => t.native && t.kind === 'evm' && t.chain === chain);
const CHAINS = ['eth', 'base', 'arb'];

test('native ETH is listed for Ethereum, Base and Arbitrum Sepolia under tp-omft.testnet', () => {
  for (const c of CHAINS) {
    const t = native(c);
    assert.ok(t, c);
    assert.equal(t.assetId, `nep141:${c}.tp-omft.testnet`);
    assert.equal(t.symbol, 'ETH');
    assert.equal(t.decimals, 18);
    assert.equal(t.blockchain, c);
    assert.equal(t.evmAddress, undefined, 'native: no ERC-20 contract');
    assert.equal(Number(t.drip), 0, 'never dripped by the faucet');
  }
  assert.equal(new Set(CHAINS.map((c) => native(c).assetId)).size, 3);
  // the near-side test ETH keeps its own id
  assert.ok(TOKENS.some((t) => t.blockchain === 'near' && t.symbol === 'ETH' && t.assetId !== native('eth').assetId));
  // the EVM vault tokens are unchanged: native ETH is not an ERC-20 of the vault
  for (const c of EVM_CHAINS) assert.ok((c.tokens || []).every((t) => t.evmAddress));
});

test('1Click mainnet native ETH ids map to the Tidepool tokens', () => {
  for (const [main, c] of [['nep141:eth.omft.near', 'eth'], ['nep141:base.omft.near', 'base'], ['nep141:arb.omft.near', 'arb']]) {
    assert.equal(suggestAsset(main), native(c).assetId, main);
  }
});

test('faucet intents mode never drips native ETH (testnet ETH is not minted)', () => {
  for (const c of CHAINS) assert.ok(!resolveIntentAssets([c]).some((t) => t.native));
});

const req = (o = {}) => ({ swapType: 'EXACT_OUTPUT', recipientType: 'DESTINATION_CHAIN', depositType: 'INTENTS', ...o });
const usdt = TOKENS.find((t) => t.chain === 'eth' && t.symbol === 'USDT');
const cap = ETH_CAP_WEI;

test('cap: 0.01 ETH by default, clear 400 over it, exactly the cap is fine', () => {
  assert.equal(cap, 10_000_000_000_000_000n);
  assert.ok(ETH_RESERVE_WEI > 0n && ETH_RESERVE_WEI < cap);
  for (const c of CHAINS) {
    const eth = native(c);
    ethLimits(req(), usdt, eth, 1n, cap); // at the cap
    assert.throws(() => ethLimits(req(), usdt, eth, 1n, cap + 1n), (e) => e instanceof BadRequest && e.code === 400 && /capped at 0\.01 ETH/.test(e.message) && e.extra?.capWei === cap.toString());
    assert.throws(() => ethLimits(req({ swapType: 'EXACT_INPUT' }), eth, usdt, cap + 1n, 1n), /capped at 0\.01 ETH/, 'ETH as the input leg is capped too');
  }
});

test('delivery only: no ORIGIN_CHAIN deposits of native ETH, no ANY_INPUT payouts', () => {
  const eth = native('eth');
  assert.throws(() => ethLimits(req({ depositType: 'ORIGIN_CHAIN' }), eth, usdt, 1n, 1n), /delivery-only/);
  assert.throws(() => ethLimits(req({ swapType: 'ANY_INPUT' }), usdt, eth, 1n, 1n), /ANY_INPUT/);
  ethLimits(req({ swapType: 'ANY_INPUT', recipientType: 'INTENTS' }), usdt, eth, 1n, 1n); // INTENTS recipients stay inside the verifier
  ethLimits(req({ depositType: 'ORIGIN_CHAIN' }), usdt, usdt, 1n, 1n); // other tokens unaffected
});
