// Agent API owner wallets: EVM owners (EIP-712 and ERC-191), passkey owners (WebAuthn P-256),
// and the agent_archive / agent_restore / agent_delete intents. No network: balances are stubbed.
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import { Wallet } from 'ethers';

process.env.DATA_DIR = fs.mkdtempSync(os.tmpdir() + '/aapi-owners-');
process.env.DEPOSIT_MASTER_SEED ||= crypto.randomBytes(32).toString('hex'); // throwaway test seed
const { internals } = await import('../src/engine.mjs');
const { sql } = await import('../src/agent-api/db.js');
const { generateIntent, submitIntent } = await import('../src/agent-api/owner-intents.js');
const { agentView, getAgent, requireActive } = await import('../src/agent-api/agents.js');
const { validateOwner } = await import('../src/agent-api/owner-signing.js');
const { TOKENS } = await import('../src/config.mjs');

let holdings = TOKENS.map(() => '0');
internals.view = async (_c, method) => { assert.equal(method, 'mt_batch_balance_of'); return holdings; };

const TENANT = 'tenant_owners';
const policy = { frozen: false, actions: ['transfer'], assets: 'any', limits: {}, destinations: { mode: 'any', list: [] }, budget: {} };
const b64u = (b) => Buffer.from(b).toString('base64url');

// ---- signers: each returns signed_data for a generate-intent response ----
const evm = Wallet.createRandom(); // local key, never funded
const evmOwner = { type: 'evm', address: evm.address, chain_id: 11155111, public_key: evm.signingKey.publicKey };
const signEip712 = async (gen) => { const { EIP712Domain, ...types } = gen.intent.payload.types; return { standard: 'eip712', payload: gen.intent.payload, signature: await evm.signTypedData(gen.intent.payload.domain, types, gen.intent.payload.message) }; };
const signErc191 = async (gen) => ({ standard: 'erc191', payload: { message: gen.intent.payload.message.intent }, signature: await evm.signMessage(gen.intent.payload.message.intent) });

const pk = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
const passOwner = { type: 'passkey', credential_id: b64u(crypto.randomBytes(16)), public_key: b64u(pk.publicKey.export({ type: 'spki', format: 'der' })), rp_id: 'example.com', origin: 'https://app.example.com' };
function signPasskey(gen, { flags = 0x05, origin = passOwner.origin, key = pk.privateKey } = {}) {
  const cdj = Buffer.from(JSON.stringify({ type: 'webauthn.get', challenge: gen.intent.payload.challenge, origin, crossOrigin: false }));
  const auth = Buffer.concat([crypto.createHash('sha256').update(passOwner.rp_id).digest(), Buffer.from([flags]), Buffer.from([0, 0, 0, 1])]);
  const signature = crypto.sign('sha256', Buffer.concat([auth, crypto.createHash('sha256').update(cdj).digest()]), { key, dsaEncoding: 'der' });
  return { standard: 'webauthn', payload: gen.intent.payload, credential: { id: passOwner.credential_id, rawId: passOwner.credential_id, type: 'public-key', response: { clientDataJSON: b64u(cdj), authenticatorData: b64u(auth), signature: b64u(signature) } } };
}
const run = async (body, sign) => { const gen = await generateIntent(TENANT, body); return { gen, status: await submitIntent(TENANT, { type: body.type, correlation_id: gen.correlation_id, signed_data: await sign(gen) }) }; };
const create = async (owner, sign) => (await run({ type: 'agent_create', name: 'owner test', owner, policy }, sign)).gen.agent_id;

test('owner validation: EVM key must match the address, passkey origin must be on rp_id', async () => {
  await assert.rejects(validateOwner({ ...evmOwner, public_key: Wallet.createRandom().signingKey.publicKey }), /does not belong/);
  await assert.rejects(validateOwner({ ...evmOwner, chain_id: 0 }), /chain_id/);
  await assert.rejects(validateOwner({ ...passOwner, origin: 'https://evil.test' }), /rp_id/);
  await assert.rejects(validateOwner({ ...passOwner, public_key: 'nope' }), /P-256/);
  await assert.rejects(validateOwner({ type: 'solana' }), (e) => e.code === 'unsupported_owner_type');
});

test('EVM owner: agent_create signed with EIP-712, later intents with ERC-191', async () => {
  const id = await create(evmOwner, signEip712);
  const a = getAgent(TENANT, id), v = agentView(a);
  assert.equal(a.status, 'ACTIVE');
  assert.deepEqual(v.owner, { type: 'evm', address: evm.address, chain_id: 11155111, public_key: evmOwner.public_key });
  assert.equal(v.owner_account, null);
  const { gen, status } = await run({ type: 'agent_freeze', agent_id: id }, signErc191);
  assert.equal(gen.intent.standard, 'eip712');
  assert.equal(gen.intent.payload.domain.chainId, 11155111);
  assert.equal(status.status, 'SUCCESS');
  assert.equal(getAgent(TENANT, id).frozen, true);
  // a different EVM key cannot sign for this owner
  const other = Wallet.createRandom();
  await assert.rejects(run({ type: 'agent_unfreeze', agent_id: id }, async (g) => ({ standard: 'erc191', payload: { message: g.intent.payload.message.intent }, signature: await other.signMessage(g.intent.payload.message.intent) })), (e) => e.code === 'owner_signature_invalid');
  await assert.rejects(run({ type: 'agent_unfreeze', agent_id: id }, async (g) => ({ standard: 'nep413', payload: {}, signature: 'x' })), (e) => e.code === 'intent_standard_mismatch');
});

test('passkey owner: WebAuthn assertion with user verification, bound to origin and rp_id', async () => {
  const id = await create(passOwner, signPasskey);
  assert.deepEqual(agentView(getAgent(TENANT, id)).owner, passOwner);
  const { gen, status } = await run({ type: 'agent_freeze', agent_id: id }, signPasskey);
  assert.equal(gen.intent.standard, 'webauthn');
  assert.equal(gen.intent.payload.rpId, 'example.com');
  assert.equal(status.status, 'SUCCESS');
  await assert.rejects(run({ type: 'agent_unfreeze', agent_id: id }, (g) => signPasskey(g, { flags: 0x01 })), /user verification/);
  await assert.rejects(run({ type: 'agent_unfreeze', agent_id: id }, (g) => signPasskey(g, { origin: 'https://other.example.com' })), /origin/);
  await assert.rejects(run({ type: 'agent_unfreeze', agent_id: id }, (g) => signPasskey(g, { key: crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' }).privateKey })), /does not verify/);
});

test('agent_archive blocks actions until agent_restore; agent_delete needs an empty wallet', async () => {
  const id = await create(evmOwner, signEip712);
  const arch = await run({ type: 'agent_archive', agent_id: id }, signEip712);
  assert.deepEqual(arch.status.details, { archived: true });
  const a = getAgent(TENANT, id);
  assert.equal(agentView(a).archived, true);
  assert.throws(() => requireActive(a), (e) => e.code === 'agent_archived');
  await assert.rejects(generateIntent(TENANT, { type: 'agent_freeze', agent_id: id }), (e) => e.code === 'agent_archived');
  await assert.rejects(generateIntent(TENANT, { type: 'agent_archive', agent_id: id }), (e) => e.code === 'agent_archived');
  const rest = await run({ type: 'agent_restore', agent_id: id }, signEip712);
  assert.deepEqual(rest.status.details, { archived: false });
  assert.equal(getAgent(TENANT, id).status, 'ACTIVE');

  holdings = TOKENS.map((_, i) => (i === 0 ? '5' : '0'));
  await assert.rejects(generateIntent(TENANT, { type: 'agent_delete', agent_id: id }), (e) => e.code === 'wallet_not_empty');
  holdings = TOKENS.map(() => '0');
  const gen = await generateIntent(TENANT, { type: 'agent_delete', agent_id: id });
  assert.equal(gen.preview.deletion.assets_lost, false);
  holdings = TOKENS.map((_, i) => (i === 0 ? '5' : '0')); // funds arrived after generate: still refused at submit
  await assert.rejects(submitIntent(TENANT, { type: 'agent_delete', correlation_id: gen.correlation_id, signed_data: await signEip712(gen) }), (e) => e.code === 'wallet_not_empty');
  holdings = TOKENS.map(() => '0');
  const del = await run({ type: 'agent_delete', agent_id: id }, signEip712);
  assert.equal(del.status.status, 'SUCCESS');
  assert.equal(del.status.details.deleted, true);
  assert.equal(getAgent(TENANT, id).status, 'DELETED');
  assert.equal(sql.prepare('SELECT COUNT(*) n FROM grants WHERE agent_id = ? AND revoked_at IS NULL').get(id).n, 0);
  assert.throws(() => requireActive(getAgent(TENANT, id)), (e) => e.code === 'agent_deleted');
});
