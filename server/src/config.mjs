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
].map(t => ({ ...t, contractAddress: `${t.sub}.${ROOT}`, assetId: `nep141:${t.sub}.${ROOT}`, name: `Tidepool Testnet ${t.symbol} (no value)`, blockchain: 'near' }));

export const toUnits = (s, d) => { const [i, f = ''] = String(s).split('.'); return BigInt(i + (f + '0'.repeat(d)).slice(0, d)); };
export const fromUnits = (v, d) => { const s = BigInt(v).toString().padStart(d + 1, '0'); const i = s.slice(0, -d) || '0'; const f = s.slice(-d).replace(/0+$/, ''); return d ? (f ? `${i}.${f}` : i) : s; };
