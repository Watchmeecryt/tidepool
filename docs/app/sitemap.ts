import type { MetadataRoute } from 'next';
import { source } from '@/lib/source';
import { LASTMOD, SITE } from '@/lib/seo';
export const dynamic = 'force-static';
export default function sitemap(): MetadataRoute.Sitemap {
  const now = new Date().toISOString();
  return [
    { url: `${SITE}/`, lastModified: LASTMOD[':home'] || now, changeFrequency: 'weekly', priority: 1 },
    ...source.getPages().map((p) => ({
      url: `${SITE}${p.url}`, lastModified: LASTMOD[p.slugs.join('/')] || now,
      changeFrequency: 'weekly' as const, priority: p.slugs.length === 0 ? 0.9 : p.slugs[0] === 'quickstart' ? 0.9 : 0.7,
    })),
  ];
}
