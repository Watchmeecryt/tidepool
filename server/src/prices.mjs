// USD prices from CoinGecko's public API, cached 60s, with static fallbacks if the feed is down.
import { TOKENS } from './config.mjs';
let cache = { at: 0, source: 'fallback', prices: Object.fromEntries(TOKENS.map(t => [t.assetId, t.fallback])) };
let inflight = null;
export async function prices() {
  if (Date.now() - cache.at < 60_000) return cache;
  inflight ||= (async () => {
    try {
      const ids = [...new Set(TOKENS.map(t => t.coingeckoId))].join(',');
      const r = await fetch(`https://api.coingecko.com/api/v3/simple/price?ids=${ids}&vs_currencies=usd`, { signal: AbortSignal.timeout(5000), headers: { accept: 'application/json' } });
      if (!r.ok) throw new Error('coingecko ' + r.status);
      const j = await r.json();
      const p = {};
      for (const t of TOKENS) { const v = j[t.coingeckoId]?.usd; if (!(v > 0)) throw new Error('missing ' + t.coingeckoId); p[t.assetId] = v; }
      cache = { at: Date.now(), source: 'coingecko', prices: p };
    } catch (e) {
      // keep last good prices; mark source; retry in 60s
      cache = { ...cache, at: Date.now(), source: cache.source === 'coingecko' ? 'coingecko-stale' : 'fallback', error: String(e.message) };
    } finally { inflight = null; }
    return cache;
  })();
  return inflight;
}
