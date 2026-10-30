import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
process.env.DATA_DIR = fs.mkdtempSync(os.tmpdir() + '/tp-ours-');
const { isOurs, ourList, OUR_PREFIXES } = await import('../src/analytics.mjs');

test('our wallets are hidden, case-insensitively for 0x addresses', () => {
  for (const w of ['tidepool-sandbox.testnet', 'verifier.tidepool-sandbox.testnet', 'alice.testnet', 'privacei.testnet',
    '0x55F2c8044D790e1b8369508c31c756c0c2Ca0E93', '0x55f2c8044d790e1b8369508c31c756c0c2ca0e93', '0X55F2C8044D790E1B8369508C31C756C0C2CA0E93',
    'tb1qy2tthlq2ntnjvk40payyuwpnzaf365h02ze0qr', 'GDXABUSRHP4YA5CELHLNJQ4M3TX2BSJ6PEMDFCG2RA4PQLAQLRMFFQAN', 'rwJx1hzscZ6THJwhDwmtPQj4YjhvysFyLd',
    'BEijzwSQpWxbgQQ5NfBePxUzHgLoc2vrApPe8G4St55Q', '0x565662F245D0A66F567AA71499589F70FEE8C2A5AF20E8614429371FBE4F252C',
    'base-0x38d81431b9f76d9699af7517040d5221d9dea252.tp-omft.testnet'])
    assert.ok(isOurs(w), w);
});

test('prefix patterns match throwaway accounts', () => {
  for (const w of ['tidepool-try-deadbeef.testnet', 'tp-app-e2e-1234abcd.testnet', 'tp-fund-0000aaaa.testnet']) assert.ok(isOurs(w), w);
  assert.ok(OUR_PREFIXES.includes('tp-app-e2e-') && OUR_PREFIXES.includes('tidepool-try-'));
});

test('external wallets stay visible', () => {
  for (const w of ['jubayir69.testnet', 'jubayirnear.testnet', 'ajotest1.testnet', 'lt-dopusk-1.testnet', '0x1111111111111111111111111111111111111111', 'notours-tidepool-try-x.testnet', '', undefined])
    assert.ok(!isOurs(w), String(w));
});

test('ourList is non-empty and covers the root', () => assert.ok(ourList().includes('tidepool-sandbox.testnet') && ourList().length > 40));
