import test from 'node:test';
import assert from 'node:assert/strict';
import { runDemo, demoInfo, DemoRefused, DEMO } from '../src/demo.mjs';

test('demo: amount is fixed and info lists limits', () => {
  assert.equal(DEMO.amount, '1000000');
  const i = demoInfo();
  assert.equal(i.endpoint, 'POST /v0/demo/run');
  assert.ok(i.limits.perIpPerHour >= 1 && i.limits.concurrent === 1);
});
test('demo: rejects an unknown flow with 400 before touching anything', async () => {
  await assert.rejects(() => runDemo({ body: { flow: 'bogus' }, ip: '1.2.3.4', origin: 'x', base: 'http://127.0.0.1:1' }), (e) => e instanceof DemoRefused && e.code === 400);
});
test('demo: refuses when the demo key is not configured', async () => {
  await assert.rejects(() => runDemo({ body: {}, ip: '1.2.3.4', origin: 'x', base: 'http://127.0.0.1:1' }), (e) => e instanceof DemoRefused && e.code === 503);
});
