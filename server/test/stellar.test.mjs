import test from 'node:test';
import assert from 'node:assert/strict';
import { Asset, Networks, Keypair } from '@stellar/stellar-base';
import { stellarOmftSub, stellarSacId, isStellarAddress, XLM_CAP_STROOPS, STELLAR_DECIMALS } from '../src/config.mjs';
import * as stellar from '../src/stellar.mjs';
import { stellarLimits, BadRequest } from '../src/engine.mjs';

const ISSUER = 'GDXABUSRHP4YA5CELHLNJQ4M3TX2BSJ6PEMDFCG2RA4PQLAQLRMFFQAN';

test('SAC contract id derivation matches the known mainnet Circle USDC contract', () => {
  const usdc = new Asset('USDC', 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN');
  assert.equal(usdc.contractId(Networks.PUBLIC), 'CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75');
});

test('omft sub-ids are stable, per-asset (USDC and USDT share an issuer) and 40 hex chars', () => {
  const a = stellarOmftSub('USDC', ISSUER), b = stellarOmftSub('USDT', ISSUER);
  assert.match(a, /^stellar-[0-9a-f]{40}$/);
  assert.notEqual(a, b);
  assert.equal(a, stellarOmftSub('USDC', ISSUER));
  assert.ok(stellarSacId('USDC', ISSUER).startsWith('C'));
});

test('Stellar address validation is strict', () => {
  assert.ok(isStellarAddress(ISSUER));
  assert.ok(isStellarAddress(Keypair.random().publicKey()));
  assert.ok(!isStellarAddress('0x38d81431B9f76d9699AF7517040D5221D9dEA252'));
  assert.ok(!isStellarAddress('alice.testnet'));
  assert.ok(!isStellarAddress(ISSUER.slice(0, -1) + 'A')); // bad checksum
  assert.ok(!isStellarAddress('S' + ISSUER.slice(1)));
});

test('amount formatting uses 7 decimals', () => {
  assert.equal(STELLAR_DECIMALS, 7);
  assert.equal(stellar.amountStr(10_000_000n), '1.0000000');
  assert.equal(stellar.amountStr(1n), '0.0000001');
  assert.equal(stellar.unitsOf('12.5'), 125_000_000n);
});

const XLM = { kind: 'stellar', native: true, symbol: 'XLM', decimals: 7 };
const USDC = { kind: 'stellar', symbol: 'USDC', decimals: 7 };
const NEAR_USDC = { symbol: 'USDC', decimals: 6 };
const req = (o = {}) => ({ swapType: 'EXACT_INPUT', depositType: 'ORIGIN_CHAIN', depositMode: 'MEMO', refundType: 'ORIGIN_CHAIN', recipientType: 'DESTINATION_CHAIN', ...o });

test('XLM cap is 100 XLM, enforced on every XLM leg', () => {
  assert.equal(XLM_CAP_STROOPS, 1_000_000_000n);
  assert.doesNotThrow(() => stellarLimits(req(), XLM, NEAR_USDC, 1_000_000_000n, 1n));
  assert.throws(() => stellarLimits(req(), XLM, NEAR_USDC, 1_000_000_001n, 1n), (e) => e instanceof BadRequest && /capped at 100 XLM/.test(e.message));
  assert.throws(() => stellarLimits(req({ depositType: 'INTENTS' }), NEAR_USDC, XLM, 1n, 1_000_000_001n), (e) => e instanceof BadRequest && /capped at 100 XLM/.test(e.message));
  assert.doesNotThrow(() => stellarLimits(req({ depositType: 'INTENTS' }), NEAR_USDC, XLM, 1n, 1_000_000_000n));
  assert.doesNotThrow(() => stellarLimits(req(), USDC, NEAR_USDC, 10n ** 15n, 1n)); // issued assets are not capped
});

test('Stellar origin requires depositMode MEMO and rejects ANY_INPUT', () => {
  assert.throws(() => stellarLimits(req({ depositMode: 'SIMPLE' }), XLM, NEAR_USDC, 1n, 1n), (e) => e instanceof BadRequest && /depositMode MEMO/.test(e.message));
  assert.throws(() => stellarLimits(req({ swapType: 'ANY_INPUT' }), USDC, NEAR_USDC, 1n, 1n), (e) => e instanceof BadRequest && /ANY_INPUT/.test(e.message));
});
