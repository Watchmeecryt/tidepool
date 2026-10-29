import test from 'node:test';
import assert from 'node:assert/strict';
import * as bitcoin from 'bitcoinjs-lib';
import { isBtcAddress, chainOf, BTC_CHAIN, BTC_CAP_SATS, BTC_MIN_SATS } from '../src/config.mjs';
import * as btc from '../src/btc.mjs';
import { makeBridge, UtxoError } from '../src/utxo.mjs';
import { utxoLimits, BadRequest } from '../src/engine.mjs';
import { resolveIntentAssets, CHAIN_ALIASES } from '../src/faucet-assets.mjs';

const MASTER = Buffer.alloc(32, 5);
const NET = bitcoin.networks.testnet;

test('Bitcoin testnet4 address validation: tb1 segwit and legacy testnet addresses only', () => {
  const a = btc.depositAddressFor(MASTER, 'q1');
  assert.match(a, /^tb1q[a-z0-9]{38}$/);
  assert.ok(isBtcAddress(a) && isBtcAddress('tb1qy2tthlq2ntnjvk40payyuwpnzaf365h02ze0qr') && isBtcAddress('mipcBbFg9gMiCh81Kj8tqqdgoZub1ZJRfn'));
  assert.ok(!isBtcAddress('bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq'), 'mainnet address');
  assert.ok(!isBtcAddress('tb1qy2tthlq2ntnjvk40payyuwpnzaf365h02ze0qs'), 'bad checksum');
  assert.ok(!isBtcAddress('0x' + 'ab'.repeat(20)) && !isBtcAddress('tmQHJUqvNXfXD4DqVm2ohTtfCKCZa83EPt5') && !isBtcAddress('alice.testnet'));
  assert.equal(chainOf('btc'), BTC_CHAIN);
});

test('per-quote deposit addresses are deterministic and unique', () => {
  assert.equal(btc.depositAddressFor(MASTER, 'q1'), btc.depositAddressFor(MASTER, 'q1'));
  assert.notEqual(btc.depositAddressFor(MASTER, 'q1'), btc.depositAddressFor(MASTER, 'q2'));
  assert.notEqual(btc.depositAddressFor(MASTER, 'q1'), btc.depositAddressFor(Buffer.alloc(32, 6), 'q1'));
});

// ---- an in-memory chain behind the real signer, to exercise utxo.mjs (coin selection, sweeps, sign-first idempotence) ----
function fakeChain({ treasuryKey }) {
  const utxos = new Map(); // "txid:vout" -> {txid, vout, value, spk, conf}
  const seen = new Map(); // txid -> 'mempool'
  let n = 0, fail = 0, broadcasts = [];
  const fund = (key, value, conf = 1) => { const txid = (++n).toString(16).padStart(64, '0'); utxos.set(`${txid}:0`, { txid, vout: 0, value: BigInt(value), spk: key.spk, conf }); return `${txid}:0`; };
  const A = {
    ...btc.bridge.A, treasury: () => treasuryKey,
    utxos: async (addr) => { const spk = btc.bridge.A.spkOf(addr); return [...utxos.values()].filter(u => u.spk.equals(spk)).map(({ txid, vout, value, conf }) => ({ txid, vout, value, conf })); },
    txStatus: async (txid) => (seen.has(txid) ? 'mempool' : 'unknown'),
    broadcast: async (hex) => {
      if (fail > 0) { fail--; throw new UtxoError('node unavailable', { transient: true }); }
      const tx = bitcoin.Transaction.fromHex(hex), id = tx.getId();
      broadcasts.push(id);
      if (seen.has(id)) return;
      for (const i of tx.ins) if (!utxos.has(`${Buffer.from(i.hash).reverse().toString('hex')}:${i.index}`)) throw new UtxoError('transaction rejected: bad-txns-inputs-missingorspent');
      for (const i of tx.ins) utxos.delete(`${Buffer.from(i.hash).reverse().toString('hex')}:${i.index}`);
      tx.outs.forEach((o, v) => utxos.set(`${id}:${v}`, { txid: id, vout: v, value: o.value, spk: Buffer.from(o.script), conf: 0 }));
      seen.set(id, 'mempool');
    },
  };
  return { A, fund, utxos, broadcasts: () => broadcasts, failNext: (k) => { fail = k; }, confirmAll: () => utxos.forEach(u => { u.conf = 1; }) };
}
const setup = () => {
  const treasuryKey = btc.depositKeypair(Buffer.alloc(32, 1), 'treasury');
  const chain = fakeChain({ treasuryKey });
  return { treasuryKey, chain, bridge: makeBridge({ ...chain.A, name: 'btc-test-' + Math.random() }) };
};

test('sweep moves every confirmed deposit output into the treasury; fee is absorbed, credited amount is the deposit', async () => {
  const { treasuryKey, chain, bridge } = setup();
  const dep = btc.depositKeypair(MASTER, 'sw1');
  chain.fund(dep, 60_000); chain.fund(dep, 40_000); chain.fund(dep, 5_000, 0); // the last one is unconfirmed
  const s = { bridgeIn: [] };
  const { ready, unconfirmed } = await bridge.depositUtxos(dep.address, s);
  assert.equal(ready.length, 2); assert.equal(unconfirmed.length, 1);
  const rec = {};
  const p0 = bridge.prepareSweep(dep, ready);
  assert.equal(p0.amount, 100_000n);
  assert.equal(await bridge.drive(rec, async () => bridge.prepareSweep(dep, ready), () => {}), 'confirmed');
  const treasuryOut = [...chain.utxos.values()].filter(u => u.spk.equals(treasuryKey.spk));
  assert.equal(treasuryOut.length, 1);
  assert.equal(treasuryOut[0].value, 100_000n - bridge.A.fee(2, 1));
  s.bridgeIn.push({ inputs: p0.inputs, stage: 'swept' });
  // a node that still lists the swept outputs (lagging index) must not make them sweepable again
  assert.equal((await bridge.depositUtxos(dep.address, { bridgeIn: [{ inputs: ready.map(u => `${u.txid}:${u.vout}`) }] })).ready.length, 0);
});

test('drive is idempotent: the same signed bytes are re-broadcast after a transient failure, never re-signed', async () => {
  const { chain, bridge } = setup();
  const dep = btc.depositKeypair(MASTER, 'sw2');
  chain.fund(dep, 50_000);
  const rec = {}; let builds = 0;
  const build = async () => { builds++; return bridge.prepareSweep(dep, (await bridge.depositUtxos(dep.address, { bridgeIn: [] })).ready); };
  chain.failNext(1);
  await assert.rejects(bridge.drive(rec, build, () => {}), /node unavailable/);
  assert.ok(rec.txid && rec.hex, 'signed tx is recorded before broadcast');
  const first = rec.txid;
  assert.equal(await bridge.drive(rec, build, () => {}), 'confirmed');
  assert.equal(builds, 1); assert.equal(rec.txid, first);
  assert.equal(await bridge.drive(rec, build, () => {}), 'confirmed'); // once accepted: pure status lookups
  assert.equal(builds, 1); assert.equal(chain.broadcasts().filter(x => x === first).length, 1);
});

test('payouts: coin selection, change, and back-to-back payouts never reuse an input (unconfirmed change is tracked)', async () => {
  const { treasuryKey, chain, bridge } = setup();
  chain.fund(treasuryKey, 400_000); chain.fund(treasuryKey, 300_000);
  const dest = btc.depositAddressFor(MASTER, 'dest');
  const r1 = {}, r2 = {}, r3 = {};
  assert.equal(await bridge.drive(r1, (c) => bridge.preparePayout(dest, 250_000n, c), () => {}), 'confirmed');
  assert.equal(await bridge.drive(r2, (c) => bridge.preparePayout(dest, 250_000n, c), () => {}), 'confirmed');
  assert.notEqual(r1.txid, r2.txid);
  assert.equal(new Set([...r1.spends, ...r2.spends]).size, r1.spends.length + r2.spends.length);
  const got = [...chain.utxos.values()].filter(u => u.spk.equals(btc.bridge.A.spkOf(dest)));
  assert.deepEqual(got.map(u => u.value), [250_000n, 250_000n]);
  assert.ok((await bridge.treasuryBalance()) < 200_000n);
  await assert.rejects(bridge.drive(r3, (c) => bridge.preparePayout(dest, 500_000n, c), () => {}), (e) => e instanceof UtxoError && e.transient && /too little/.test(e.message));
  await assert.rejects(bridge.preparePayout(dest, 100n), (e) => e.fatal && /dust/.test(e.message));
});

test('a deposit that cannot pay the sweep fee is rejected as fatal, not swept', async () => {
  const { chain, bridge } = setup();
  const dep = btc.depositKeypair(MASTER, 'tiny');
  chain.fund(dep, 400);
  assert.throws(() => bridge.prepareSweep(dep, [{ txid: 'aa'.repeat(32), vout: 0, value: 400n }]), (e) => e.fatal);
  assert.throws(() => bridge.prepareSweep(dep, []), (e) => e.transient);
});

test('limits: BTC is capped and has a minimum on every leg; ANY_INPUT cannot pay out BTC', () => {
  const inT = { kind: 'near' }, outT = { kind: 'btc', native: true }, req = { recipientType: 'DESTINATION_CHAIN', swapType: 'EXACT_INPUT' };
  assert.doesNotThrow(() => utxoLimits(req, inT, outT, 1n, BTC_MIN_SATS));
  assert.throws(() => utxoLimits(req, inT, outT, 1n, BTC_CAP_SATS + 1n), BadRequest);
  assert.throws(() => utxoLimits(req, inT, outT, 1n, BTC_MIN_SATS - 1n), /minimum/);
  assert.throws(() => utxoLimits({ ...req, swapType: 'ANY_INPUT' }, inT, outT, 1n, BTC_MIN_SATS), /ANY_INPUT/);
  assert.throws(() => utxoLimits(req, outT, inT, BTC_CAP_SATS + 1n, 1n), BadRequest);
  assert.throws(() => utxoLimits(req, outT, inT, BTC_MIN_SATS - 1n, 1n), /at least/);
  assert.doesNotThrow(() => utxoLimits(req, { kind: 'sol' }, { kind: 'near' }, 10n ** 30n, 10n ** 30n)); // other pairs are unaffected
});

test('the faucet never drips native BTC/ZEC: the btc and zec aliases resolve to nothing', () => {
  assert.ok(CHAIN_ALIASES.includes('btc') && CHAIN_ALIASES.includes('zec'));
  const pool = [{ assetId: 'nep141:btc.tp-omft.testnet', blockchain: 'btc', symbol: 'BTC', drip: '0' }, { assetId: 'nep141:usdc.tp-omft.testnet', blockchain: 'eth', symbol: 'USDC', drip: '10' }];
  assert.deepEqual(resolveIntentAssets(['btc', 'bitcoin', 'nep141:btc.tp-omft.testnet'], pool), []);
});
