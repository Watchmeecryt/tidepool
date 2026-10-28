import fs from 'node:fs';
import bs58 from 'bs58';
import { keccak256 } from 'ethers';
// Tidepool deployment config: testnet accounts and the test token list.
export const ROOT = process.env.TIDEPOOL_ROOT || 'tidepool-sandbox.testnet';
export const VERIFIER = `verifier.${ROOT}`;
export const MAKER = `maker.${ROOT}`;
export const VERIFIER_WASM_SHA256 = 'f67f9559b3b512c52dfa11723a28b9119bcf773ac01780370d6409e5f1fb20e5'; // near/intents release defuse/v0.4.2
export const VERIFIER_RELEASE = 'https://github.com/near/intents/releases/tag/defuse/v0.4.2';

// Test tokens mirror common 1Click assets. Testnet only, no value, not bridged.
export const TOKENS = [
  { sub: 'usdc', symbol: 'USDC', decimals: 6, coingeckoId: 'usd-coin', fallback: 1, drip: '100', inventory: '2000000' },
  { sub: 'usdt', symbol: 'USDT', decimals: 6, coingeckoId: 'tether', fallback: 1, drip: '100', inventory: '2000000' },
  { sub: 'wnear', symbol: 'wNEAR', decimals: 24, coingeckoId: 'near', fallback: 2.5, drip: '40', inventory: '800000' },
  { sub: 'wbtc', symbol: 'wBTC', decimals: 8, coingeckoId: 'bitcoin', fallback: 100000, drip: '0.001', inventory: '20' },
  { sub: 'eth', symbol: 'ETH', decimals: 18, coingeckoId: 'ethereum', fallback: 3500, drip: '0.03', inventory: '600' },
  { sub: 'xaut', symbol: 'XAUT', decimals: 6, coingeckoId: 'tether-gold', fallback: 3000, drip: '0.03', inventory: '600' },
].map(t => ({ ...t, contractAddress: `${t.sub}.${ROOT}`, nearContract: `${t.sub}.${ROOT}`, assetId: `nep141:${t.sub}.${ROOT}`, name: `Tidepool Testnet ${t.symbol} (no value)`, blockchain: 'near' }));
export const NEAR_TOKENS = TOKENS.slice();

// ---- Testnet EVM bridges (trusted relayer run by Tidepool; testnet only) ----
// Bridged assets mirror 1Click's omft naming: nep141:<chain>-<erc20 address>.<OMFT>, e.g.
// nep141:base-0xabc...def.tp-omft.testnet  (mainnet: nep141:base-0x8335...omft.near).
export const OMFT = process.env.TIDEPOOL_OMFT || 'tp-omft.testnet';
export const BRIDGE_ACCOUNT = ROOT; // receives ft_withdraw from the verifier for EVM payouts
export const EVM_CHAINS = [
  { key: 'base', blockchain: 'base', name: 'Base Sepolia', chainId: 84532, rpc: process.env.BASE_SEPOLIA_RPC || 'https://sepolia.base.org', explorer: 'https://sepolia.basescan.org' },
  { key: 'arb', blockchain: 'arb', name: 'Arbitrum Sepolia', chainId: 421614, rpc: process.env.ARB_SEPOLIA_RPC || 'https://sepolia-rollup.arbitrum.io/rpc', explorer: 'https://sepolia.arbiscan.io' },
  { key: 'eth', blockchain: 'eth', name: 'Ethereum Sepolia', chainId: 11155111, rpc: process.env.SEPOLIA_RPC || 'https://ethereum-sepolia-rpc.publicnode.com', explorer: 'https://sepolia.etherscan.io' },
];
const DEPLOYED = JSON.parse(fs.readFileSync(new URL('./bridge-deployments.json', import.meta.url), 'utf8'));
const BRIDGED = [
  { symbol: 'USDC', decimals: 6, coingeckoId: 'usd-coin', fallback: 1, drip: '100', inventory: '200000' },
  { symbol: 'USDT', decimals: 6, coingeckoId: 'tether', fallback: 1, drip: '100', inventory: '200000' },
];
for (const c of EVM_CHAINS) {
  const d = DEPLOYED[c.key];
  c.deployed = Boolean(d?.vault && d.live);
  if (!d?.vault) continue;
  Object.assign(c, { vault: d.vault, deployBlock: d.deployBlock, forwarderInitCodeHash: d.forwarderInitCodeHash });
  for (const b of BRIDGED) {
    const evm = d.tokens?.[b.symbol];
    if (!evm) continue;
    const near = `${c.key}-${evm.toLowerCase()}.${OMFT}`;
    const t = { ...b, kind: 'evm', sub: `${c.key}-${b.symbol.toLowerCase()}`, chain: c.key, blockchain: c.blockchain, evmAddress: evm, contractAddress: evm, nearContract: near, assetId: `nep141:${near}`, name: `Tidepool Testnet ${b.symbol} on ${c.name} (bridged, no value)` };
    if (c.deployed) TOKENS.push(t);
    c.tokens = [...(c.tokens || []), t];
  }
}

// ---- Solana devnet bridge (trusted relayer run by Tidepool; devnet only) ----
// Official 1Click/omft naming for Solana: native SOL is nep141:sol.omft.near; an SPL token is
// nep141:sol-<last 20 bytes of keccak256(mint pubkey bytes), hex>.omft.near. We mirror it under tp-omft.testnet.
export const solOmftSub = (mint) => 'sol-' + keccak256(bs58.decode(mint)).slice(-40);
export const SOL_PAYOUT_CAP_LAMPORTS = BigInt(process.env.SOL_PAYOUT_CAP_LAMPORTS || 5_000_000); // 0.005 SOL cap on any SOL swap leg, payout or refund (enforced at quote time)
export const SOL_RENT_MIN_LAMPORTS = 890_880n; // rent-exempt minimum of a 0-data account: smaller SOL transfers to a fresh address fail on-chain
export const SOL_CHAIN = { key: 'sol', blockchain: 'sol', kind: 'sol', name: 'Solana Devnet', cluster: 'devnet', explorer: 'https://explorer.solana.com' };
export const isSolAddress = (s) => {
  if (typeof s !== 'string' || s.length < 32 || s.length > 44) return false;
  try { return bs58.decode(s).length === 32; } catch { return false; }
};
const SD = DEPLOYED.sol;
SOL_CHAIN.deployed = Boolean(SD?.relayer && SD.live && SD.tokens?.USDC && SD.tokens?.USDT);
if (SD?.relayer) {
  SOL_CHAIN.relayer = SD.relayer;
  SOL_CHAIN.tokens = [];
  const common = { chain: 'sol', kind: 'sol', blockchain: 'sol' };
  const sol = { ...common, sub: 'sol', symbol: 'SOL', decimals: 9, coingeckoId: 'solana', fallback: 150, drip: '0', inventory: SD.inventory?.SOL || '1', native: true,
    nearContract: `sol.${OMFT}`, assetId: `nep141:sol.${OMFT}`, name: 'Tidepool Testnet SOL on Solana Devnet (bridged, no value)' };
  const spl = BRIDGED.filter(b => SD.tokens?.[b.symbol]).map(b => { const mint = SD.tokens[b.symbol], sub = solOmftSub(mint);
    return { ...b, ...common, sub: `sol-${b.symbol.toLowerCase()}`, mint, contractAddress: mint, nearContract: `${sub}.${OMFT}`, assetId: `nep141:${sub}.${OMFT}`, name: `Tidepool Testnet ${b.symbol} on Solana Devnet (bridged, no value)` }; });
  for (const t of [sol, ...spl]) { if (SOL_CHAIN.deployed) TOKENS.push(t); SOL_CHAIN.tokens.push(t); }
}
export const chainOf = (key) => key === 'sol' ? SOL_CHAIN : EVM_CHAINS.find(c => c.key === key);
export const isEvmAddress = (s) => typeof s === 'string' && /^0x[0-9a-fA-F]{40}$/.test(s);

export const toUnits = (s, d) => { const [i, f = ''] = String(s).split('.'); return BigInt(i + (f + '0'.repeat(d)).slice(0, d)); };
export const fromUnits = (v, d) => { const s = BigInt(v).toString().padStart(d + 1, '0'); const i = s.slice(0, -d) || '0'; const f = s.slice(-d).replace(/0+$/, ''); return d ? (f ? `${i}.${f}` : i) : s; };
