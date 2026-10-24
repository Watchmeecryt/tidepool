import { Inter, JetBrains_Mono } from 'next/font/google';
import type { Metadata } from 'next';
import { Provider } from '@/components/provider';
import './global.css';

const inter = Inter({ subsets: ['latin'], variable: '--font-sans' });
const mono = JetBrains_Mono({ subsets: ['latin'], variable: '--font-mono' });

export const metadata: Metadata = {
  metadataBase: new URL('https://tidepool-production-8594.up.railway.app'),
  title: { template: '%s · Tidepool', default: 'Tidepool · a 1Click-compatible testnet sandbox for NEAR Intents' },
  description: 'Community-built testnet sandbox for NEAR Intents: the official verifier, test tokens, a live maker and the 1Click Swap API shapes. Not affiliated with NEAR or 1Click.',
  icons: { icon: '/favicon.svg' },
};

export default function Layout({ children }: LayoutProps<'/'>) {
  return (
    <html lang="en" className={`${inter.variable} ${mono.variable} ${inter.className}`} suppressHydrationWarning>
      <body className="flex flex-col min-h-screen">
        <Provider>{children}</Provider>
      </body>
    </html>
  );
}
