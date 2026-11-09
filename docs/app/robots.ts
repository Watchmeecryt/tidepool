import type { MetadataRoute } from 'next';
import { SITE } from '@/lib/seo';
export const dynamic = 'force-static';
const AI = ['GPTBot', 'OAI-SearchBot', 'ChatGPT-User', 'ClaudeBot', 'Claude-User', 'Claude-SearchBot', 'anthropic-ai', 'PerplexityBot', 'Perplexity-User', 'Google-Extended', 'Applebot-Extended', 'CCBot', 'Bingbot', 'Googlebot'];
const disallow = ['/admin', '/v0', '/v0/', '/balances', '/withdraw', '/policy/', '/transfer', '/v1/'];
export default function robots(): MetadataRoute.Robots {
  return {
    rules: [{ userAgent: '*', allow: '/', disallow }, ...AI.map((userAgent) => ({ userAgent, allow: '/', disallow }))],
    sitemap: `${SITE}/sitemap.xml`, host: SITE,
  };
}
