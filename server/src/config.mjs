import fs from 'node:fs';
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
    const t = { ...b, sub: `${c.key}-${b.symbol.toLowerCase()}`, chain: c.key, blockchain: c.blockchain, evmAddress: evm, contractAddress: evm, nearContract: near, assetId: `nep141:${near}`, name: `Tidepool Testnet ${b.symbol} on ${c.name} (bridged, no value)` };
    if (c.deployed) TOKENS.push(t);
    c.tokens = [...(c.tokens || []), t];
  }
}
export const chainOf = (key) => EVM_CHAINS.find(c => c.key === key);
export const isEvmAddress = (s) => typeof s === 'string' && /^0x[0-9a-fA-F]{40}$/.test(s);

export const toUnits = (s, d) => { const [i, f = ''] = String(s).split('.'); return BigInt(i + (f + '0'.repeat(d)).slice(0, d)); };
export const fromUnits = (v, d) => { const s = BigInt(v).toString().padStart(d + 1, '0'); const i = s.slice(0, -d) || '0'; const f = s.slice(-d).replace(/0+$/, ''); return d ? (f ? `${i}.${f}` : i) : s; };
