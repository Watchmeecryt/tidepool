import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';

process.env.DATA_DIR = fs.mkdtempSync(os.tmpdir() + '/tp-treasury-');
const {
  HEADROOM, NEAR_LOW_YOCTO, EVM_GAS_LOW_WEI, FAUCET_SOURCES,
  spendableNearYocto, thresholdUnits, statusOf, shortAddr, addressExplorer,
  sortRows, rowOf, scrubError, resetTreasuryCache,
} = await import('../src/treasury.js');
const { ETH_CAP_WEI, ETH_RESERVE_WEI, XRP_CAP_DROPS, XRP_RESERVE_DROPS, toUnits } = await import('../src/config.mjs');

test('spendable NEAR subtracts storage stake (0.00001 NEAR/byte)', () => {
  const yocto = (n) => toUnits(String(n), 24);
  assert.equal(spendableNearYocto(null), 0n);
  // 5 NEAR, 100_000 bytes of storage => 1 NEAR staked, 4 spendable
  assert.equal(spendableNearYocto({ amount: String(yocto(5)), storage_usage: 100_000 }), yocto(4));
  assert.equal(spendableNearYocto({ amount: String(yocto(1)), storage_usage: 200_000 }), 0n);
});

test('low threshold is about 10 claims or max-size payouts', () => {
  assert.equal(HEADROOM, 10);
  assert.equal(thresholdUnits({ drip: toUnits('100', 6) }), toUnits('1000', 6));
  assert.equal(thresholdUnits({ cap: ETH_CAP_WEI, reserve: ETH_RESERVE_WEI }), ETH_CAP_WEI * 10n + ETH_RESERVE_WEI);
  assert.equal(thresholdUnits({ cap: XRP_CAP_DROPS, reserve: XRP_RESERVE_DROPS }), XRP_CAP_DROPS * 10n + XRP_RESERVE_DROPS);
  assert.equal(thresholdUnits({ floor: EVM_GAS_LOW_WEI }), EVM_GAS_LOW_WEI);
  assert.equal(thresholdUnits({ drip: 1n, cap: 5n, reserve: 2n }), 5n * 10n + 2n); // conservative (higher) of the two
  assert.equal(thresholdUnits({}), 0n);
  assert.equal(NEAR_LOW_YOCTO, 2n * 10n ** 24n);
});

test('status: empty, low, ok, error', () => {
  assert.equal(statusOf(0n, 100n), 'empty');
  assert.equal(statusOf(-1n, 100n), 'empty');
  assert.equal(statusOf(50n, 100n), 'low');
  assert.equal(statusOf(100n, 100n), 'ok');
  assert.equal(statusOf(500n, 100n), 'ok');
  assert.equal(statusOf(null, 100n), 'error');
  assert.equal(statusOf(500n, 100n, { error: 'boom' }), 'error');
});

test('short addresses and per-chain explorer links', () => {
  assert.equal(shortAddr('maker.tidepool-sandbox.testnet'), 'maker.tide…estnet');
  assert.equal(shortAddr('tidepool-sandbox.testnet'), 'tidepool-sandbox.testnet'); // 24 chars
  assert.equal(shortAddr('0x55F2c8044D790e1b8369508c31c756c0c2Ca0E93'), '0x55F2…0E93');
  assert.equal(shortAddr('rwJx1hzscZ6THJwhDwmtPQj4YjhvysFyLd'), 'rwJx1hzscZ…ysFyLd');
  assert.equal(addressExplorer('near', 'maker.tidepool-sandbox.testnet'), 'https://testnet.nearblocks.io/address/maker.tidepool-sandbox.testnet');
  assert.equal(addressExplorer('eth', '0x55F2c8044D790e1b8369508c31c756c0c2Ca0E93'), 'https://sepolia.etherscan.io/address/0x55F2c8044D790e1b8369508c31c756c0c2Ca0E93');
  assert.equal(addressExplorer('base', '0x55F2c8044D790e1b8369508c31c756c0c2Ca0E93'), 'https://sepolia.basescan.org/address/0x55F2c8044D790e1b8369508c31c756c0c2Ca0E93');
  assert.equal(addressExplorer('arb', '0x55F2c8044D790e1b8369508c31c756c0c2Ca0E93'), 'https://sepolia.arbiscan.io/address/0x55F2c8044D790e1b8369508c31c756c0c2Ca0E93');
  assert.equal(addressExplorer('bsc', '0x55F2c8044D790e1b8369508c31c756c0c2Ca0E93'), 'https://testnet.bscscan.com/address/0x55F2c8044D790e1b8369508c31c756c0c2Ca0E93');
  assert.equal(addressExplorer('sol', 'BEijzwSQpWxbgQQ5NfBePxUzHgLoc2vrApPe8G4St55Q'), 'https://explorer.solana.com/address/BEijzwSQpWxbgQQ5NfBePxUzHgLoc2vrApPe8G4St55Q?cluster=devnet');
  assert.equal(addressExplorer('stellar', 'GBWLJSU3XF6NKHBY25VSDVVKIYS2ATCHHUVYLNWSARHLOLDDXSP2BA4Z'), 'https://stellar.expert/explorer/testnet/account/GBWLJSU3XF6NKHBY25VSDVVKIYS2ATCHHUVYLNWSARHLOLDDXSP2BA4Z');
  assert.equal(addressExplorer('sui', '0x565662f245d0a66f567aa71499589f70fee8c2a5af20e8614429371fbe4f252c'), 'https://suiscan.xyz/testnet/account/0x565662f245d0a66f567aa71499589f70fee8c2a5af20e8614429371fbe4f252c');
  assert.equal(addressExplorer('btc', 'tb1qy2tthlq2ntnjvk40payyuwpnzaf365h02ze0qr'), 'https://mempool.space/testnet4/address/tb1qy2tthlq2ntnjvk40payyuwpnzaf365h02ze0qr');
  assert.equal(addressExplorer('zec', 'tmQHJUqvNXfXD4DqVm2ohTtfCKCZa83EPt5'), 'https://testnet.zcashexplorer.app/address/tmQHJUqvNXfXD4DqVm2ohTtfCKCZa83EPt5');
  assert.equal(addressExplorer('xrp', 'rwJx1hzscZ6THJwhDwmtPQj4YjhvysFyLd'), 'https://testnet.xrpl.org/accounts/rwJx1hzscZ6THJwhDwmtPQj4YjhvysFyLd');
  assert.ok(FAUCET_SOURCES.includes('tidepool-f1.testnet') && FAUCET_SOURCES.length === 4);
});

test('rows sort Empty/Error/Low before OK, and errors never include RPC URLs', () => {
  const mk = (status, token, extra = {}) => ({ status, chainName: 'NEAR Testnet', chain: 'near', role: 'maker', token, kind: 'native', ...extra });
  const sorted = sortRows([mk('ok', 'USDC'), mk('low', 'ETH'), mk('empty', 'NEAR'), mk('error', 'XRP'), mk('ok', 'USDT'), mk('low', 'BTC')]);
  assert.deepEqual(sorted.map((r) => r.status + ':' + r.token), ['empty:NEAR', 'error:XRP', 'low:BTC', 'low:ETH', 'ok:USDC', 'ok:USDT']);
  assert.equal(scrubError('failed https://secret-rpc.example/path?key=abc timeout'), 'failed [rpc] timeout');
  const r = rowOf({ chain: 'eth', chainName: 'Ethereum Sepolia', account: '0x55F2c8044D790e1b8369508c31c756c0c2Ca0E93', role: 'relayer', token: 'ETH', kind: 'native', decimals: 18, threshold: EVM_GAS_LOW_WEI, error: new Error('HTTP 429 from https://ethereum-sepolia-rpc.publicnode.com') });
  assert.equal(r.status, 'error');
  assert.equal(r.accountShort, '0x55F2…0E93');
  assert.ok(r.explorer.startsWith('https://sepolia.etherscan.io/address/'));
  assert.ok(!/https?:\/\/\S*rpc/i.test(r.error));
  assert.ok(!r.error.includes('publicnode'));
  resetTreasuryCache();
});
