import type { BaseLayoutProps } from 'fumadocs-ui/layouts/shared';
import { Logo } from '@/components/logo';

export function baseOptions(): BaseLayoutProps {
  return {
    nav: {
      title: (<><Logo /><span className="font-semibold tracking-tight">Tidepool</span><span className="ms-1 rounded-full border border-fd-primary/30 bg-fd-primary/10 px-2 py-0.5 text-[11px] font-medium text-fd-primary">testnet</span></>),
    },
    links: [
      { text: 'Docs', url: '/docs', active: 'nested-url' },
      { text: 'API reference', url: '/docs/api-reference' },
      { text: 'Faucet', url: '/docs/guides/faucet' },
      { text: 'Status', url: '/docs/status' },
      { type: 'button', text: 'Launch app', url: 'https://app.usetidepool.tech', external: true, secondary: false },
    ],
  };
}
