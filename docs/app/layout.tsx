import { Inter, JetBrains_Mono, Bricolage_Grotesque } from 'next/font/google';
import type { Metadata, Viewport } from 'next';
import { Provider } from '@/components/provider';
import { BRAND, OG_IMAGE, SITE } from '@/lib/seo';
import './global.css';

const inter = Inter({ subsets: ['latin'], variable: '--font-sans' });
const display = Bricolage_Grotesque({ subsets: ['latin'], variable: '--font-display', weight: ['500', '600', '700', '800'] });
const mono = JetBrains_Mono({ subsets: ['latin'], variable: '--font-mono' });

const defaultTitle = `${BRAND.name}: free 1Click API testnet sandbox for NEAR Intents (${BRAND.affiliationShort})`;

export const metadata: Metadata = {
  metadataBase: new URL(SITE),
  title: { template: `%s · ${BRAND.name} (NEAR Intents testnet)`, default: defaultTitle },
  description: BRAND.description,
  keywords: BRAND.keywords,
  applicationName: BRAND.name,
  authors: [{ name: `${BRAND.name} (${BRAND.affiliationShort})`, url: SITE }],
  alternates: { canonical: '/' },
  manifest: '/site.webmanifest',
  icons: {
    icon: [{ url: '/favicon.ico', sizes: '32x32' }, { url: '/favicon.svg', type: 'image/svg+xml' }, { url: '/favicon-32x32.png', sizes: '32x32', type: 'image/png' }, { url: '/favicon-16x16.png', sizes: '16x16', type: 'image/png' }],
    apple: [{ url: '/apple-touch-icon.png', sizes: '180x180' }],
  },
  openGraph: { type: 'website', siteName: BRAND.name, title: defaultTitle, description: BRAND.description, url: '/', locale: 'en_US', images: [OG_IMAGE] },
  twitter: { card: 'summary_large_image', site: BRAND.xHandle, creator: BRAND.xHandle, title: defaultTitle, description: BRAND.description, images: [OG_IMAGE.url] },
  robots: { index: true, follow: true, googleBot: { index: true, follow: true, 'max-image-preview': 'large', 'max-snippet': -1 } },
  other: { 'llms-txt': `${SITE}/llms.txt` },
};

export const viewport: Viewport = { themeColor: BRAND.themeColor };

export default function Layout({ children }: LayoutProps<'/'>) {
  return (
    <html lang="en" className={`${inter.variable} ${mono.variable} ${display.variable} ${inter.className}`} suppressHydrationWarning>
      <head>
        <link rel="alternate" type="text/plain" title="llms.txt" href="/llms.txt" />
        <link rel="alternate" type="application/json" title="OpenAPI" href="/openapi.json" />
      </head>
      <body className="flex flex-col min-h-screen">
        <Provider>{children}</Provider>
      </body>
    </html>
  );
}
