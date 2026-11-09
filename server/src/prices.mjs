// USD prices from CoinGecko's public API, cached 60s, with static fallbacks if the feed is down.
// Ondo prices prefer mainnet 1Click (?ondoTokens=1) and fall back to catalog fallbacks (CoinGecko often lacks them).
import { TOKENS } from './config.mjs';
let cache = { at: 0, source: 'fallback', prices: Object.fromEntries(TOKENS.map(t => [t.assetId, t.fallback])) };
let inflight = null;
let ondoCache = { at: 0, bySymbol: {} };

async function fetchOndoPrices() {
  if (Date.now() - ondoCache.at < 60_000 && Object.keys(ondoCache.bySymbol).length) return ondoCache.bySymbol;
  try {
    const r = await fetch('https://1click.chaindefuser.com/v0/tokens?ondoTokens=1', { signal: AbortSignal.timeout(8000), headers: { accept: 'application/json' } });
    if (!r.ok) throw new Error('1click ' + r.status);
    const all = await r.json();
    const bySymbol = {};
    for (const t of all) if (typeof t.symbol === 'string' && t.symbol.endsWith('on') && t.price > 0) bySymbol[t.symbol] = t.price;
    // also match by coingeckoId
    ondoCache = { at: Date.now(), bySymbol };
    return bySymbol;
  } catch {
    return ondoCache.bySymbol;
  }
}

/** @param {Array<{assetId:string,coingeckoId?:string,fallback:number,symbol:string,ondo?:boolean}>} extra */
export async function prices(extra = []) {
  if (Date.now() - cache.at < 60_000 && !extra.length) return cache;
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
      cache = { ...cache, at: Date.now(), source: cache.source === 'coingecko' ? 'coingecko-stale' : 'fallback', error: String(e.message) };
    } finally { inflight = null; }
    return cache;
  })();
  const base = await inflight;
  if (!extra.length) return base;
  const ondoPx = await fetchOndoPrices();
  const prices = { ...base.prices };
  for (const t of extra) {
    prices[t.assetId] = ondoPx[t.symbol] ?? t.fallback;
  }
  return { ...base, prices };
}
