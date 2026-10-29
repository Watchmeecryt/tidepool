import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import * as bitcoin from 'bitcoinjs-lib';
import * as ecc from 'tiny-secp256k1';
import { isZecAddress, decodeZecAddress, chainOf, ZEC_CHAIN, ZEC_CAP_ZAT } from '../src/config.mjs';
import * as zec from '../src/zec.mjs';

const fx = JSON.parse(fs.readFileSync(new URL('./fixtures/zec-v5-testnet.json', import.meta.url), 'utf8'));
// parse a transparent-only v5 tx from the chain
function parse(f) {
  const buf = Buffer.from(f.hex, 'hex'); let o = 0;
  const rd = (n) => { const b = buf.subarray(o, o + n); o += n; return Buffer.from(b); };
  const cs = () => buf[o++];
  rd(4); rd(4); const branchId = rd(4).readUInt32LE(0), lockTime = rd(4).readUInt32LE(0), expiry = rd(4).readUInt32LE(0);
  const inputs = [];
  for (let n = cs(), i = 0; i < n; i++) { const txid = Buffer.from(rd(32)).reverse().toString('hex'); const vout = rd(4).readUInt32LE(0); const ss = rd(cs()); rd(4); inputs.push({ txid, vout, ss, value: BigInt(f.prevs[i].value), prevSpk: Buffer.from(f.prevs[i].spk, 'hex') }); }
  const outputs = [];
  for (let n = cs(), i = 0; i < n; i++) { const value = rd(8).readBigUInt64LE(0); outputs.push({ value, spk: rd(cs()) }); }
  return { branchId, lockTime, expiry, inputs, outputs, tail: buf.subarray(o) };
}

test('ZIP-244 txid digest and serialization reproduce real v5 transactions on Zcash testnet', () => {
  for (const f of fx) {
    const t = parse(f);
    assert.equal(t.branchId, zec.NU7_BRANCH_ID);
    assert.deepEqual([...t.tail], [0, 0, 0]);
    assert.equal(zec.txidV5(t), f.txid);
    assert.equal(zec.serializeV5(t, t.inputs.map(i => i.ss)).toString('hex'), f.hex);
  }
});

test('ZIP-244 signature digest verifies the signatures of real on-chain SIGHASH_ALL p2pkh inputs', () => {
  for (const f of fx) {
    const t = parse(f);
    t.inputs.forEach((i, n) => {
      const len = i.ss[0], { signature, hashType } = bitcoin.script.signature.decode(i.ss.subarray(1, 1 + len)), pub = i.ss.subarray(2 + len);
      assert.equal(hashType, 1);
      assert.ok(ecc.verify(zec.sighashV5(t, n), pub, signature), `signature of input ${n} of ${f.txid} must verify`);
    });
  }
});

test('signV5 builds a transaction whose own signatures verify and whose txid matches the digest', () => {
  const m = Buffer.alloc(32, 9);
  const dep = zec.depositKeypair(m, 'q1'), tre = zec.depositKeypair(m, 'treasury-stand-in');
  const t = { branchId: zec.NU7_BRANCH_ID, expiry: 4_600_000, lockTime: 0,
    inputs: [{ txid: 'ab'.repeat(32), vout: 1, value: 1_000_000n, prevSpk: dep.spk, key: dep }, { txid: 'cd'.repeat(32), vout: 0, value: 500_000n, prevSpk: dep.spk, key: dep }],
    outputs: [{ value: 1_480_000n, spk: tre.spk }] };
  const { txid, hex } = zec.signV5(t);
  assert.equal(txid, zec.txidV5(t));
  const p = parse({ hex, prevs: t.inputs.map(i => ({ value: i.value.toString(), spk: i.prevSpk.toString('hex') })) });
  assert.equal(zec.txidV5(p), txid);
  p.inputs.forEach((i, n) => { const len = i.ss[0], { signature } = bitcoin.script.signature.decode(i.ss.subarray(1, 1 + len)); assert.ok(ecc.verify(zec.sighashV5(p, n), i.ss.subarray(2 + len), signature)); assert.ok(i.ss.subarray(2 + len).equals(dep.pub)); });
});

test('transparent address validation: tm... p2pkh and t2... p2sh only', () => {
  const m = Buffer.alloc(32, 7);
  const a = zec.depositAddressFor(m, 'q1');
  assert.match(a, /^tm[1-9A-HJ-NP-Za-km-z]{33}$/);
  assert.ok(isZecAddress(a) && isZecAddress('tmQHJUqvNXfXD4DqVm2ohTtfCKCZa83EPt5'));
  assert.equal(decodeZecAddress(a).type, 'p2pkh');
  assert.ok(!isZecAddress('t1Hsc1LR8yKnbbe3twRp88p6vFfC5t7DLbs'), 'mainnet t1 address');
  assert.ok(!isZecAddress('tmQHJUqvNXfXD4DqVm2ohTtfCKCZa83EPt6'), 'bad checksum');
  assert.ok(!isZecAddress('ztestsapling1' + 'q'.repeat(70)), 'shielded addresses are not supported');
  assert.ok(!isZecAddress('0x' + 'ab'.repeat(20)) && !isZecAddress('tb1qy2tthlq2ntnjvk40payyuwpnzaf365h02ze0qr'));
  assert.equal(chainOf('zec'), ZEC_CHAIN);
  assert.equal(zec.spkOfAddress(a).length, 25);
  assert.throws(() => zec.spkOfAddress('nope'));
});

test('per-quote deposit addresses are deterministic and unique per quote and master', () => {
  const m = Buffer.alloc(32, 7);
  assert.equal(zec.depositAddressFor(m, 'q1'), zec.depositAddressFor(m, 'q1'));
  assert.notEqual(zec.depositAddressFor(m, 'q1'), zec.depositAddressFor(m, 'q2'));
  assert.notEqual(zec.depositAddressFor(m, 'q1'), zec.depositAddressFor(Buffer.alloc(32, 8), 'q1'));
});

test('ZIP-317 fee: 5000 zat per logical action, at least two', () => {
  assert.equal(zec.feeZip317(1, 1), 10_000n);
  assert.equal(zec.feeZip317(1, 2), 10_000n);
  assert.equal(zec.feeZip317(3, 2), 15_000n);
  assert.ok(ZEC_CAP_ZAT >= 10_000_000n);
});

test('the treasury key (when present on this machine) derives the published treasury address', { skip: !zec.relayerConfigured() && !fs.existsSync(new URL('../../.secrets/zec-treasury.key', import.meta.url)) }, () => {
  assert.equal(zec.treasury().address, 'tmQHJUqvNXfXD4DqVm2ohTtfCKCZa83EPt5');
});
