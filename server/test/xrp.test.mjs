import test from 'node:test';
import assert from 'node:assert/strict';
import { Wallet, classicAddressToXAddress } from 'xrpl';
import { XRP_CAP_DROPS, XRP_DECIMALS, parseXrpAddress, isXrpAddress } from '../src/config.mjs';
import * as xrp from '../src/xrp.mjs';
import { xrpLimits, BadRequest } from '../src/engine.mjs';

const ADDR = Wallet.generate().classicAddress;
const XRP = { kind: 'xrp', native: true, symbol: 'XRP', decimals: 6 };
const NEAR_USDC = { symbol: 'USDC', decimals: 6 };
const req = (o = {}) => ({ swapType: 'EXACT_INPUT', depositType: 'ORIGIN_CHAIN', depositMode: 'MEMO', refundType: 'ORIGIN_CHAIN', recipientType: 'DESTINATION_CHAIN', ...o });

test('XRP uses 6 decimals and a 100 XRP cap', () => {
  assert.equal(XRP_DECIMALS, 6);
  assert.equal(XRP_CAP_DROPS, 100_000_000n);
});

test('XRP address validation is strict', () => {
  assert.ok(isXrpAddress(ADDR));
  assert.ok(isXrpAddress('rwJx1hzscZ6THJwhDwmtPQj4YjhvysFyLd'));
  assert.ok(!isXrpAddress('0x38d81431B9f76d9699AF7517040D5221D9dEA252'));
  assert.ok(!isXrpAddress('alice.testnet'));
  assert.ok(!isXrpAddress(ADDR.slice(0, -1) + (ADDR.endsWith('a') ? 'b' : 'a'))); // bad checksum
  assert.ok(!isXrpAddress(''));
});

test('X-addresses are parsed into an address plus a destination tag', () => {
  const x = classicAddressToXAddress(ADDR, 4242, true);
  const p = parseXrpAddress(x);
  assert.ok(p);
  assert.equal(p.address ?? p.classicAddress, ADDR);
  assert.equal(String(p.tag), '4242');
});

test('destination tags are uint32 and never 0', () => {
  for (let i = 0; i < 200; i++) {
    const t = Number(xrp.newTag());
    assert.ok(Number.isInteger(t) && t >= 1 && t <= 0xffffffff);
  }
});

test('drops formatting', () => {
  assert.equal(xrp.dropsStr(1_500_000n), '1500000');
  assert.equal(xrp.unitsOf('1500000'), 1_500_000n);
});

test('XRP cap is 100 XRP, enforced on every XRP leg', () => {
  assert.doesNotThrow(() => xrpLimits(req(), XRP, NEAR_USDC, 100_000_000n, 1n));
  assert.throws(() => xrpLimits(req(), XRP, NEAR_USDC, 100_000_001n, 1n), (e) => e instanceof BadRequest && /capped at 100 XRP/.test(e.message));
  assert.throws(() => xrpLimits(req({ depositType: 'INTENTS' }), NEAR_USDC, XRP, 1n, 100_000_001n), (e) => e instanceof BadRequest && /capped at 100 XRP/.test(e.message));
  assert.doesNotThrow(() => xrpLimits(req({ depositType: 'INTENTS' }), NEAR_USDC, XRP, 1n, 100_000_000n));
});

test('XRP origin requires depositMode MEMO and rejects ANY_INPUT', () => {
  assert.throws(() => xrpLimits(req({ depositMode: 'SIMPLE' }), XRP, NEAR_USDC, 1n, 1n), (e) => e instanceof BadRequest && /depositMode MEMO/.test(e.message));
  assert.throws(() => xrpLimits(req({ swapType: 'ANY_INPUT' }), XRP, NEAR_USDC, 1n, 1n), (e) => e instanceof BadRequest && /ANY_INPUT/.test(e.message));
  assert.throws(() => xrpLimits(req({ swapType: 'ANY_INPUT', depositType: 'INTENTS' }), NEAR_USDC, XRP, 1n, 1n), (e) => e instanceof BadRequest && /ANY_INPUT/.test(e.message));
});

test('checkDestination rejects malformed addresses without network access', async () => {
  const e = await xrp.checkDestination('not-an-address', 1_000_000n, 'recipient');
  assert.ok(e && /XRP/i.test(e));
});
