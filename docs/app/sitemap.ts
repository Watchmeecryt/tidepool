import type { MetadataRoute } from 'next';
import { source } from '@/lib/source';
import { LASTMOD, SITE } from '@/lib/seo';
export const dynamic = 'force-static';
// Google ignores <priority> and <changefreq>, so only <lastmod> is emitted. If a page has no recorded
// git date we omit lastmod rather than stamp the build time (a fake lastmod on every deploy erodes trust).
export default function sitemap(): MetadataRoute.Sitemap {
  return [
    { url: `${SITE}/`, lastModified: LASTMOD[':home'] || undefined },
    ...source.getPages().map((p) => ({ url: `${SITE}${p.url}`, lastModified: LASTMOD[p.slugs.join('/')] || undefined })),
  ];
}
