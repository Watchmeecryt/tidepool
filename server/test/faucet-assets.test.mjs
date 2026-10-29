import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveIntentAssets, CHAIN_ALIASES, isBridgedToken } from '../src/faucet-assets.mjs';
import { TOKENS, NEAR_TOKENS, SOL_CHAIN, STELLAR_CHAIN } from '../src/config.mjs';

const syms = (l) => l.map(t => `${t.blockchain}/${t.symbol}`).sort();

test('chain aliases expand to that chain\'s bridged test tokens', () => {
  assert.deepEqual(syms(resolveIntentAssets(['base'])), ['base/USDC', 'base/USDT']);
  assert.deepEqual(syms(resolveIntentAssets(['sol'])), ['sol/SOL', 'sol/USDC', 'sol/USDT']);
  assert.deepEqual(syms(resolveIntentAssets(['Stellar'])), ['stellar/USDC', 'stellar/USDT', 'stellar/XLM']);
  assert.deepEqual(syms(resolveIntentAssets(['solana'])), syms(resolveIntentAssets(['sol'])));
});

test('bridged = every bridged chain, never a NEAR token', () => {
  const l = resolveIntentAssets(['bridged']);
  assert.ok(l.length >= 12 && l.every(isBridgedToken));
});

test('SOL drips 0.05 and XLM drips 5 (verifier tokens only); native wallet drips stay off', () => {
  assert.equal(TOKENS.find(t => t.assetId === SOL_CHAIN.tokens.find(x => x.native).assetId).drip, '0.05');
  assert.equal(STELLAR_CHAIN.tokens.find(x => x.native).drip, '5');
  // the wallet-style drips (solDrip/stellarDrip) pick `!native` tokens, so SOL/XLM are never sent to wallets
  assert.ok(SOL_CHAIN.tokens.filter(t => !t.native).every(t => t.symbol === 'USDC' || t.symbol === 'USDT'));
});

test('asset ids and NEAR symbols still work; symbols do not match bridged tokens; duplicates collapse', () => {
  const id = TOKENS.find(t => t.blockchain === 'base' && t.symbol === 'USDC').assetId;
  assert.deepEqual(resolveIntentAssets([id, 'base', 'base']).filter(t => t.symbol === 'USDC').length, 1);
  assert.deepEqual(syms(resolveIntentAssets(['USDC'])), ['near/USDC']);
  assert.deepEqual(resolveIntentAssets(['nope']), []);
});

test('wallet pool (NEAR tokens only) yields no bridged tokens; defaults are unchanged', () => {
  assert.deepEqual(resolveIntentAssets(['bridged', 'sol'], NEAR_TOKENS), []);
  assert.equal(NEAR_TOKENS.length, 6);
  assert.ok(CHAIN_ALIASES.includes('bridged'));
});
