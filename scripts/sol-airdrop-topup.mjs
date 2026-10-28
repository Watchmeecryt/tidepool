// Idempotent devnet SOL top-up for the Tidepool Solana treasury (the relayer). Testnet only.
//  - requests devnet airdrops (~2 SOL per try) with polite, backing-off retries
//  - stops as soon as the treasury holds TARGET SOL (default 5), and does nothing if it already does
//  - prints ONLY the balance before and after (never keys or RPC URLs)
// Uses requestAirdrop on your SOLANA_DEVNET_RPC provider, then the public devnet RPC (api.devnet.solana.com). Does NOT use faucet.solana.com
// (it asks AI agents not to). NOTE: the public node's RPC faucet is currently closed, so set SOLANA_DEVNET_RPC to a provider with a devnet faucet.
// The treasury is found from SOLANA_RELAYER_KEY, .secrets/solana-relayer.key, SOLANA_TREASURY or bridge-deployments.json.
// Usage:  node scripts/sol-airdrop-topup.mjs            (TARGET_SOL=5 MAX_TRIES=8 AIRDROP_SOL=2 to override)
import fs from 'node:fs';
import nacl from 'tweetnacl';
import bs58 from 'bs58';

const TARGET = Number(process.env.TARGET_SOL || 5) * 1e9;
const PER_TRY = Math.min(2, Number(process.env.AIRDROP_SOL || 2)) * 1e9; // public devnet caps a single airdrop at 2 SOL
const MAX_TRIES = Number(process.env.MAX_TRIES || 8);
// Tries SOLANA_AIRDROP_RPC, then your SOLANA_DEVNET_RPC provider (Alchemy/Helius/QuickNode/Triton run devnet faucets), then the public node.
const ENDPOINTS = [...(process.env.SOLANA_AIRDROP_RPC || '').split(','), process.env.SOLANA_DEVNET_RPC, 'https://api.devnet.solana.com'].map(s => s?.trim()).filter(Boolean);
const ROOT = new URL('../', import.meta.url);

function treasury() {
  if (process.env.SOLANA_TREASURY) return process.env.SOLANA_TREASURY;
  let raw = process.env.SOLANA_RELAYER_KEY;
  const f = new URL('.secrets/solana-relayer.key', ROOT);
  if (!raw && fs.existsSync(f)) raw = fs.readFileSync(f, 'utf8');
  if (raw) {
    raw = raw.trim();
    const sk = raw.startsWith('[') ? Uint8Array.from(JSON.parse(raw)) : bs58.decode(raw);
    return bs58.encode(nacl.sign.keyPair.fromSecretKey(sk).publicKey);
  }
  const dep = JSON.parse(fs.readFileSync(new URL('server/src/bridge-deployments.json', ROOT), 'utf8')).sol;
  if (dep?.relayer) return dep.relayer;
  throw new Error('no Solana treasury found (run scripts/bridge-solana-bootstrap.mjs first, or set SOLANA_TREASURY)');
}
async function rpc(method, params) {
  let last;
  for (const url of ENDPOINTS) {
    try {
      const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), signal: AbortSignal.timeout(20_000) });
      const j = await r.json().catch(() => ({}));
      if (j.error) throw new Error(`${method}: ${j.error.message}`);
      if (!r.ok) throw new Error(`${method}: HTTP ${r.status}`);
      return j.result;
    } catch (e) { last = e; }
  }
  throw last;
}
const sol = (l) => (l / 1e9).toFixed(4);
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const balance = async (a) => (await rpc('getBalance', [a, { commitment: 'confirmed' }])).value;

const addr = treasury();
const before = await balance(addr);
console.log(`treasury balance before: ${sol(before)} SOL`);
let bal = before;
for (let i = 0; i < MAX_TRIES && bal < TARGET; i++) {
  const want = Math.min(PER_TRY, TARGET - bal + 1e6);
  try {
    const sig = await rpc('requestAirdrop', [addr, Math.floor(Math.max(want, 1e8))]);
    for (let w = 0; w < 30; w++) { // wait up to ~60s for the airdrop to land
      await sleep(2000);
      const st = (await rpc('getSignatureStatuses', [[sig]])).value[0];
      if (st?.err) throw new Error('airdrop tx failed');
      if (st && ['confirmed', 'finalized'].includes(st.confirmationStatus)) break;
    }
    bal = await balance(addr);
  } catch (e) {
    const wait = Math.min(120, 15 * 2 ** i);
    console.log(`airdrop try ${i + 1}/${MAX_TRIES} not granted (${String(e.message).slice(0, 80)}); waiting ${wait}s`);
    await sleep(wait * 1000);
    bal = await balance(addr).catch(() => bal);
  }
}
const after = await balance(addr);
console.log(`treasury balance after: ${sol(after)} SOL${after >= TARGET ? ' (target reached)' : after > before ? ' (below target; rerun later, devnet limits airdrops per IP)' : ' (no airdrop granted; rerun later)'}`);
