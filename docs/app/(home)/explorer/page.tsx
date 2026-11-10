import type { Metadata } from 'next';
import { SwapExplorer } from '@/components/explorer';

export const metadata: Metadata = {
  title: 'Explorer',
  description: 'Public explorer for Tidepool testnet NEAR Intents swaps: tokens, chains, amounts, status and on-chain links.',
  alternates: { canonical: '/explorer' },
};

export default function ExplorerPage() {
  return (
    <main className="mx-auto w-full max-w-[1200px] flex-1 px-4 py-10 md:px-6">
      <p className="tp-pill mb-4"><span className="tp-live" />Live · testnet</p>
      <h1 className="tp-display text-3xl md:text-4xl">Swap explorer</h1>
      <p className="mt-2 max-w-2xl text-fd-muted-foreground">Every funded swap on the Tidepool testnet, across NEAR and the bridged testnets. Data comes from the public <a className="text-fd-primary underline-offset-4 hover:underline" href="/docs/api-reference/tidepool-explorer-swaps">explorer API</a>. Testnet tokens have no value.</p>
      <SwapExplorer />
    </main>
  );
}
