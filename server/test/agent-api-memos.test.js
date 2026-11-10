import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import { Wallet, classicAddressToXAddress } from 'xrpl';
import { Keypair, TransactionBuilder, Account, Networks, Asset } from '@stellar/stellar-base';
import nacl from 'tweetnacl';

process.env.DATA_DIR ||= fs.mkdtempSync(os.tmpdir() + '/aapi-memo-');
const { withdrawMemo, stellarMemo } = await import('../src/agent-api/memos.js');
const { validatePolicy, evaluate } = await import('../src/agent-api/policy.js');
const stellar = await import('../src/stellar.mjs');
const sol = await import('../src/solana.mjs');

const code = (fn) => { try { fn(); return null; } catch (e) { return e.code; } };
const XRP_ADDR = Wallet.generate().classicAddress;

test('memos are refused on chains that carry none, with a clear error', () => {
  for (const [chain, name] of [['eth-sepolia', 'Ethereum Sepolia'], ['sui', 'Sui Testnet'], ['btc', 'Bitcoin Testnet4'], ['zec', 'Zcash Testnet']]) {
    let err; try { withdrawMemo(chain, '123', 'x', name); } catch (e) { err = e; }
    assert.equal(err.code, 'validation_failed');
    assert.equal(err.meta.pointer, '/memo');
    assert.match(err.message, new RegExp(`not supported for ${name} withdrawals`));
  }
  assert.equal(withdrawMemo('eth-sepolia', undefined, 'x'), null);
  assert.equal(withdrawMemo('sui', '', 'x'), null);
});

test('Stellar: a uint64 number is MEMO_ID, anything else MEMO_TEXT of at most 28 bytes', () => {
  assert.deepEqual(stellarMemo('18446744073709551615'), { type: 'id', value: '18446744073709551615' });
  assert.deepEqual(stellarMemo('18446744073709551616'), { type: 'text', value: '18446744073709551616' });
  assert.deepEqual(stellarMemo('0042'), { type: 'text', value: '0042' }); // leading zeros stay text, nothing is lost
  assert.equal(withdrawMemo('stellar', 'invoice 7', 'G'), 'invoice 7');
  assert.equal(code(() => withdrawMemo('stellar', 'x'.repeat(29), 'G')), 'validation_failed');
  const kp = Keypair.random(), dest = Keypair.random().publicKey();
  const build = (memo) => { const b = new TransactionBuilder(new Account(kp.publicKey(), '1'), { fee: '100', networkPassphrase: Networks.TESTNET, timebounds: { minTime: 0, maxTime: 0 } }); stellar.payoutOps({ native: true }, dest, 10_000_000n, true, memo)(b); return b.build(); };
  assert.equal(build('123456789').memo.type, 'id');
  assert.equal(build('123456789').memo.value.toString(), '123456789');
  assert.equal(build('hello').memo.type, 'text');
  assert.equal(build('hello').memo.value.toString(), 'hello');
  assert.equal(build(undefined).memo.type, 'none');
  assert.equal(build('x').operations[0].type, 'payment');
});

test('XRP: a memo is the destination tag, and must agree with an X-address tag', () => {
  assert.equal(withdrawMemo('xrp', '4242', XRP_ADDR), '4242');
  assert.equal(withdrawMemo('xrp', '4294967295', XRP_ADDR), '4294967295');
  assert.equal(code(() => withdrawMemo('xrp', '4294967296', XRP_ADDR)), 'validation_failed');
  assert.equal(code(() => withdrawMemo('xrp', 'hello', XRP_ADDR)), 'validation_failed');
  const x = classicAddressToXAddress(XRP_ADDR, 4242, true);
  assert.equal(withdrawMemo('xrp', '4242', x), '4242'); // same tag twice is fine
  let err; try { withdrawMemo('xrp', '7', x); } catch (e) { err = e; }
  assert.match(err.message, /conflicts with memo 7/);
});

test('Solana: the memo is one Memo program instruction after the transfer', () => {
  const m = sol.ix.memo('order 42');
  assert.equal(Buffer.from(m.programId).toString('hex'), Buffer.from(sol.MEMO_PROGRAM).toString('hex'));
  assert.deepEqual(m.keys, []);
  assert.equal(m.data.toString(), 'order 42');
  const kp = nacl.sign.keyPair(), to = nacl.sign.keyPair().publicKey;
  const tx = sol.buildTx({ feePayer: kp.publicKey, instructions: [sol.ix.systemTransfer(kp.publicKey, to, 5000n), m], blockhash: '11111111111111111111111111111111', signers: [kp] });
  assert.ok(tx.message.includes(Buffer.from('order 42')));
  assert.equal(withdrawMemo('sol', 'é'.repeat(128), 'S').length, 128); // 256 bytes
  assert.equal(code(() => withdrawMemo('sol', 'é'.repeat(129), 'S')), 'validation_failed');
});

test('policy destinations match on chain, address and memo', () => {
  const policy = validatePolicy({ frozen: false, actions: ['withdraw'], assets: 'any', limits: {}, destinations: { mode: 'only', list: [{ action: 'withdraw', chain: 'xrp', address: XRP_ADDR, memo: '4242' }] }, budget: {} });
  const op = (memo) => ({ action: 'withdraw', asset: 'nep141:x', amount: 1n, usd: 0, destination: { chain: 'xrp', address: XRP_ADDR, memo } });
  const agent = { id: 'agent_memo', frozen: false, budget_started: {} };
  assert.deepEqual(evaluate(agent, policy, op('4242')).map((v) => v.code), []);
  assert.deepEqual(evaluate(agent, policy, op('1')).map((v) => v.code), ['policy_destination_denied']);
  assert.deepEqual(evaluate(agent, policy, op(null)).map((v) => v.code), ['policy_destination_denied']);
});
