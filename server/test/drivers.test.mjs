// Regression tests for the duplicate-payout bug found on the XRP bridge: two concurrent steps on one UNSIGNED payout slot must never
// both build + sign. Every sign-first driver must build exactly once, and the loser reports 'pending'.
import test from 'node:test';
import assert from 'node:assert/strict';
import { exclusive } from '../src/guard.mjs';
import { makeBridge } from '../src/utxo.mjs';
import * as stellar from '../src/stellar.mjs';
import * as sui from '../src/sui.mjs';
import * as sol from '../src/solana.mjs';
import * as xrp from '../src/xrp.mjs';
import * as btc from '../src/btc.mjs';
import { utxoPollDue } from '../src/engine.mjs';

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
// a slow build that then fails: no network is ever touched, and a second concurrent build would show up in the counter
function counting() { const c = { n: 0 }; c.build = async () => { c.n++; await sleep(40); throw new Error('stop here'); }; return c; }
async function twice(drive) {
  const rec = {}, c = counting();
  const res = await Promise.allSettled([drive(rec, c.build, () => {}), drive(rec, c.build, () => {})]);
  assert.equal(c.n, 1, 'exactly one transaction is built and signed for one slot');
  assert.equal(res.filter(r => r.status === 'fulfilled' && r.value === 'pending').length, 1, 'the loser just reports pending');
  assert.equal(res.filter(r => r.status === 'rejected').length, 1);
  // once the first step finished the slot is free again (a later tick may proceed)
  await Promise.allSettled([drive(rec, c.build, () => {})]);
  assert.equal(c.n, 2);
}

test('exclusive(): one step at a time per slot, released on success and on error', async () => {
  const rec = {}; let runs = 0;
  const [a, b] = await Promise.all([exclusive(rec, async () => { runs++; await sleep(20); return 'confirmed'; }), exclusive(rec, async () => { runs++; return 'confirmed'; })]);
  assert.deepEqual([a, b], ['confirmed', 'pending']); assert.equal(runs, 1);
  await assert.rejects(exclusive(rec, async () => { throw new Error('x'); }));
  assert.equal(await exclusive(rec, async () => 'ok'), 'ok');
  assert.equal(await exclusive({}, async () => 'other slot'), 'other slot');
});

test('UTXO (BTC/ZEC) drive: concurrent drives of one payout slot build once', async () => {
  const A = { name: 'dup', minConf: 1, dust: 1n, treasury: () => ({}), utxos: async () => [], txStatus: async () => 'unknown', broadcast: async () => {}, fee: () => 1n };
  await twice(makeBridge(A).drive);
});
test('UTXO drive: an unsigned slot that is driven concurrently never pays twice even when the first build succeeds', async () => {
  let n = 0, pending = false;
  const A = { name: 'dup2', minConf: 1, dust: 1n, treasury: () => ({}), utxos: async () => [], txStatus: async (id) => (pending ? 'mempool' : 'unknown'), broadcast: async () => { pending = true; }, fee: () => 1n };
  const b = makeBridge(A), rec = {};
  const build = async () => { n++; await sleep(30); return { txid: `t${n}`.padEnd(64, '0'), hex: '00', spends: [`in${n}:0`], outs: [] }; };
  const res = await Promise.all([b.drive(rec, build, () => {}), b.drive(rec, build, () => {}), b.drive(rec, build, () => {})]);
  assert.equal(n, 1);
  assert.deepEqual(res.sort(), ['confirmed', 'pending', 'pending']);
  assert.equal(rec.txid, 't1'.padEnd(64, '0'));
});
test('Stellar drive: concurrent drives of one payout slot build once', () => twice(stellar.drive));
test('Sui drive: concurrent drives of one payout slot build once', () => twice(sui.drive));
test('Solana drive: concurrent drives of one payout slot build once', () => twice(sol.drive));
test('XRP drive: concurrent drives of one payout slot build once', () => twice(xrp.drive));

test('Stellar: tx_bad_seq alone never causes a re-sign (our own tx may have consumed the sequence before Horizon ingested it)', async () => {
  const real = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    url = String(url);
    if (init?.method === 'POST') return new Response(JSON.stringify({ title: 'Transaction Failed', extras: { result_codes: { transaction: 'tx_bad_seq' } } }), { status: 400 });
    if (url.includes('/ledgers')) return new Response(JSON.stringify({ _embedded: { records: [{ closed_at: new Date().toISOString() }] } }), { status: 200 });
    return new Response('{}', { status: 404 });
  };
  try {
    const rec = { hash: 'ab'.repeat(32), xdr: 'AAAA', maxTime: Math.floor(Date.now() / 1000) + 120 };
    let built = 0;
    assert.equal(await stellar.drive(rec, async () => { built++; return {}; }, () => {}), 'pending');
    assert.equal(built, 0);
    assert.equal(rec.hash, 'ab'.repeat(32), 'the signed tx is kept until it provably expired');
  } finally { globalThis.fetch = real; }
});

test('engine: deposit-address polls are rate limited per address', () => {
  assert.equal(utxoPollDue('tb1qtest', 20_000, 1000), true);
  assert.equal(utxoPollDue('tb1qtest', 20_000, 5000), false);
  assert.equal(utxoPollDue('tb1qtest', 20_000, 21_001), true);
  assert.equal(utxoPollDue('tb1qother', 20_000, 5000), true);
});

// ---- BTC Esplora layer: shared cache, in-flight dedupe, 429 backoff + failover ----
const ADDR = 'tb1qxpxe7fj62yc73f2nk4pd6upv7pq458u0rghh5s';
function esplora(handlers) {
  const calls = [];
  const real = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    url = String(url); const host = new URL(url).host; const path = url.slice(url.indexOf('/api') + 4);
    calls.push(`${host}${path}`);
    const h = handlers[host]; if (!h) return new Response('no', { status: 500 });
    return h(path, init);
  };
  return { calls, restore: () => { globalThis.fetch = real; } };
}
const ok = (v) => new Response(typeof v === 'string' ? v : JSON.stringify(v), { status: 200 });
test('BTC API: concurrent reads share one request and are cached; broadcast invalidates', async () => {
  process.env.BTC_API_GAP_MS = '0'; btc.resetApiState();
  const e = esplora({ 'mempool.space': (p) => p.startsWith('/address/') ? ok([{ txid: 'a'.repeat(64), vout: 0, value: 1000, status: { confirmed: true, block_height: 100 } }]) : p === '/blocks/tip/height' ? ok('105') : p === '/v1/fees/recommended' ? ok({ halfHourFee: 3 }) : new Response('x', { status: 500 }) });
  try {
    const rs = await Promise.all(Array.from({ length: 8 }, () => btc.bridge.A.utxos(ADDR)));
    assert.equal(rs[0][0].conf, 6);
    await btc.bridge.A.utxos(ADDR);
    assert.equal(e.calls.filter(c => c.includes('/address/')).length, 1, '9 reads, 1 address request');
    assert.equal(e.calls.filter(c => c.includes('/blocks/tip/height')).length, 1);
  } finally { e.restore(); }
});
test('BTC API: a 429 backs the endpoint off (no hammering) and the next endpoint serves', async () => {
  btc.resetApiState();
  const e = esplora({
    'mempool.space': () => new Response('slow down', { status: 429, headers: { 'retry-after': '60' } }),
    'blockstream.info': (p) => p === '/blocks/tip/height' ? ok('200') : p.startsWith('/address/') ? ok([]) : ok({ halfHourFee: 2 }),
  });
  try {
    await btc.bridge.A.utxos(ADDR);
    const first = e.calls.filter(c => c.startsWith('mempool.space')).length;
    assert.ok(first >= 1);
    await btc.bridge.A.utxos('tb1q0000000000000000000000000000000000000'); // a different address: not cached
    await btc.bridge.A.txStatus('b'.repeat(64));
    assert.equal(e.calls.filter(c => c.startsWith('mempool.space')).length, first, 'the rate-limited endpoint is left alone during its backoff');
    assert.ok(e.calls.some(c => c.startsWith('blockstream.info/address/')));
  } finally { e.restore(); }
});
test('BTC API: when every endpoint is rate limited the read fails fast and transient (no request storm)', async () => {
  btc.resetApiState();
  const e = esplora({ 'mempool.space': () => new Response('', { status: 429 }), 'blockstream.info': () => new Response('', { status: 429 }), 'mempool.ninja': () => new Response('', { status: 429 }) });
  try {
    await assert.rejects(btc.bridge.A.utxos(ADDR), (err) => err.transient === true);
    const n = e.calls.length;
    await assert.rejects(btc.bridge.A.utxos(ADDR), (err) => err.transient === true);
    await assert.rejects(btc.bridge.A.utxos(ADDR), (err) => err.transient === true);
    assert.equal(e.calls.length, n, 'no further requests while all endpoints are backing off');
  } finally { e.restore(); btc.resetApiState(); }
});
