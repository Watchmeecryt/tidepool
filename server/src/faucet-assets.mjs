// Resolves the `assets` list of an intents-mode faucet request. Pure (no I/O) so it can be unit tested.
// Accepts asset ids, NEAR symbols (native tokens only), and chain aliases that expand to the bridged test tokens of that chain
// (USDC/USDT everywhere, plus the verifier-only test SOL, XLM and SUI; native BTC, ZEC and XRP are never dripped, so btc/zec/xrp resolve to nothing): sol, stellar, sui, btc, zec, xrp, base, arb, eth, bridged (= every bridged chain).
import { TOKENS } from './config.mjs';

export const CHAIN_ALIASES = ['sol', 'stellar', 'sui', 'btc', 'zec', 'xrp', 'base', 'arb', 'eth', 'bsc', 'bridged'];
const ALIAS_MAP = { solana: 'sol', xlm: 'stellar', bitcoin: 'btc', zcash: 'zec', ripple: 'xrp' };

export function resolveIntentAssets(assets, pool = TOKENS) {
  const out = new Map();
  for (const raw of assets) {
    const a = String(raw);
    const alias = ALIAS_MAP[a.toLowerCase()] || a.toLowerCase();
    if (CHAIN_ALIASES.includes(alias) && !pool.some(t => t.assetId === a)) {
      for (const t of pool) if (t.blockchain !== 'near' && (alias === 'bridged' || t.blockchain === alias)) out.set(t.assetId, t);
      continue;
    }
    for (const t of pool) if (t.assetId === a || (t.blockchain === 'near' && t.symbol === a)) out.set(t.assetId, t);
  }
  return [...out.values()].filter(t => Number(t.drip) > 0);
}
export const isBridgedToken = (t) => t.blockchain !== 'near';
