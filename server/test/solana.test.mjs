import test from 'node:test';
import assert from 'node:assert/strict';
import nacl from 'tweetnacl';
import bs58 from 'bs58';
import { solOmftSub, isSolAddress, SOL_PAYOUT_CAP_LAMPORTS, SOL_RENT_MIN_LAMPORTS } from '../src/config.mjs';
import * as sol from '../src/solana.mjs';
import { solLimits, BadRequest } from '../src/engine.mjs';

test('official omft asset-id derivation matches 1Click mainnet ids', () => {
  assert.equal(solOmftSub('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'), 'sol-5ce3bf3a31af18be40ba30f721101b4341690186'); // USDC
  assert.equal(solOmftSub('Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB'), 'sol-c800a4bd850783ccb82c2b2c7e84175443606352'); // USDT
});

test('base58 address validation is strict and case-preserving', () => {
  assert.ok(isSolAddress('7YttLkHDoNj9wyDur5pM1ejNaAvT9X4eqaYcHQqtj2G5'));
  assert.ok(!isSolAddress('0x38d81431B9f76d9699AF7517040D5221D9dEA252'));
  assert.ok(!isSolAddress('alice.testnet'));
  assert.ok(!isSolAddress('7YttLkHDoNj9wyDur5pM1ejN')); // too short
  assert.ok(!isSolAddress('0OIl' + '7YttLkHDoNj9wyDur5pM1ejNaAvT9X4eqaYcHQ')); // invalid base58 chars
});

test('associated token address vector (checked against @solana/spl-token)', () => {
  assert.equal(sol.ataOf('7YttLkHDoNj9wyDur5pM1ejNaAvT9X4eqaYcHQqtj2G5', 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'), '9XorNZB6QQNKNTD9yoC3x2S43gimwk6zt6GZpFwsThem');
});

test('ed25519 on-curve check', () => {
  assert.equal(sol.onCurve(Buffer.from('5866666666666666666666666666666666666666666666666666666666666666', 'hex')), true); // base point
  assert.equal(sol.onCurve(nacl.sign.keyPair().publicKey), true);
  assert.equal(sol.onCurve(new Uint8Array(32).fill(0xff)), false); // y >= p
});

test('deposit keypair derivation is deterministic and per-quote', () => {
  const a = sol.depositAddressFor('seed', 'q1'), b = sol.depositAddressFor('seed', 'q1'), c = sol.depositAddressFor('seed', 'q2');
  assert.equal(a, b); assert.notEqual(a, c); assert.ok(isSolAddress(a));
});

test('built transactions carry valid signatures and the fee payer first', () => {
  const payer = nacl.sign.keyPair(), dep = nacl.sign.keyPair(), to = nacl.sign.keyPair().publicKey;
  const bh = bs58.encode(nacl.randomBytes(32));
  const t = sol.buildTx({ feePayer: payer.publicKey, blockhash: bh, signers: [payer, dep], instructions: [sol.ix.systemTransfer(dep.publicKey, payer.publicKey, 1_000_000n), sol.ix.systemTransfer(payer.publicKey, to, 5n)] });
  const raw = Buffer.from(t.raw, 'base64');
  assert.equal(raw[0], 2); // two signatures
  const s0 = raw.subarray(1, 65), s1 = raw.subarray(65, 129), msg = raw.subarray(129);
  assert.ok(nacl.sign.detached.verify(msg, s0, payer.publicKey));
  assert.ok(nacl.sign.detached.verify(msg, s1, dep.publicKey));
  assert.equal(t.sig, bs58.encode(s0));
  assert.deepEqual([...msg.subarray(0, 3)], [2, 0, 1]); // 2 signers, 0 readonly signed, 1 readonly unsigned (system program)
});

const SOL = { kind: 'sol', native: true, symbol: 'SOL', decimals: 9 };
const USDC = { kind: 'sol', symbol: 'USDC', decimals: 6 };
const NEAR_USDC = { symbol: 'USDC', decimals: 6 };
const req = (o = {}) => ({ swapType: 'EXACT_INPUT', depositType: 'ORIGIN_CHAIN', refundType: 'ORIGIN_CHAIN', recipientType: 'DESTINATION_CHAIN', ...o });

test('SOL cap is 0.005 SOL (5,000,000 lamports) and is enforced at quote time on every SOL leg', () => {
  assert.equal(SOL_PAYOUT_CAP_LAMPORTS, 5_000_000n);
  assert.ok(SOL_RENT_MIN_LAMPORTS < SOL_PAYOUT_CAP_LAMPORTS);
  // SOL in: at the cap passes, one lamport over is rejected with a clear message
  assert.doesNotThrow(() => solLimits(req(), SOL, NEAR_USDC, 5_000_000n, 1_000_000n));
  assert.throws(() => solLimits(req(), SOL, NEAR_USDC, 5_000_001n, 1_000_000n), (e) => e instanceof BadRequest && /capped at 0\.005 SOL/.test(e.message) && e.code === 400);
  assert.throws(() => solLimits(req({ refundType: 'INTENTS' }), SOL, NEAR_USDC, 50_000_000n, 1n), BadRequest); // 0.05 SOL is now far over the cap
  // SOL out: payout cap, with a clear error; ANY_INPUT can't pay SOL out
  assert.doesNotThrow(() => solLimits(req(), NEAR_USDC, SOL, 1n, 5_000_000n));
  assert.throws(() => solLimits(req(), NEAR_USDC, SOL, 1n, 5_000_001n), /capped at 0\.005 SOL/);
  assert.throws(() => solLimits(req({ swapType: 'ANY_INPUT' }), NEAR_USDC, SOL, 1n, 1_000_000n), /ANY_INPUT/);
  // INTENTS-side legs are capped too (it is a SOL swap)
  assert.throws(() => solLimits(req({ recipientType: 'INTENTS' }), NEAR_USDC, SOL, 1n, 6_000_000n), /capped/);
});

test('SOL rent minimum and SPL legs', () => {
  assert.throws(() => solLimits(req(), SOL, NEAR_USDC, 100_000n, 1n), /rent-exempt minimum/);
  assert.throws(() => solLimits(req(), NEAR_USDC, SOL, 1n, 100_000n), /rent-exempt minimum/);
  assert.doesNotThrow(() => solLimits(req(), USDC, NEAR_USDC, 5_000_000_000n, 5_000_000_000n)); // SPL tokens are not capped
  assert.doesNotThrow(() => solLimits(req({ recipientType: 'INTENTS' }), NEAR_USDC, SOL, 1n, 1_000n)); // intents credit: no on-chain account to fund
});
