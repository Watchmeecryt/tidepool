import { BRAND } from '@/lib/seo';
export const dynamic = 'force-static';
export function GET() {
  const m = {
    name: `${BRAND.name}: ${BRAND.tagline}`, short_name: BRAND.name,
    description: `${BRAND.description} ${BRAND.affiliationLong}`, start_url: '/', scope: '/', display: 'standalone',
    theme_color: BRAND.themeColor, background_color: BRAND.backgroundColor,
    icons: [
      { src: '/icon-192.png', sizes: '192x192', type: 'image/png' },
      { src: '/icon-512.png', sizes: '512x512', type: 'image/png' },
      { src: '/icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
      { src: '/favicon.svg', sizes: 'any', type: 'image/svg+xml' },
    ],
  };
  return new Response(JSON.stringify(m, null, 2), { headers: { 'content-type': 'application/manifest+json' } });
}
