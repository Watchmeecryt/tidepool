import type { MetadataRoute } from 'next';
import { SITE } from '@/lib/seo';
export const dynamic = 'force-static';
const AI = ['GPTBot', 'OAI-SearchBot', 'ChatGPT-User', 'ClaudeBot', 'Claude-User', 'Claude-SearchBot', 'anthropic-ai', 'PerplexityBot', 'Perplexity-User', 'Google-Extended', 'Applebot-Extended', 'CCBot', 'Bingbot', 'Googlebot'];
export default function robots(): MetadataRoute.Robots {
  return {
    rules: [{ userAgent: '*', allow: '/', disallow: '/admin' }, ...AI.map((userAgent) => ({ userAgent, allow: '/', disallow: '/admin' }))],
    sitemap: `${SITE}/sitemap.xml`, host: SITE,
  };
}
