import type { BaseLayoutProps } from 'fumadocs-ui/layouts/shared';
import { renderIcon } from '@/lib/icons';
import { Logo } from '@/components/logo';

export function baseOptions(): BaseLayoutProps {
  return {
    nav: {
      title: (<><Logo /><span className="font-semibold tracking-tight">Tidepool</span><span className="ms-1 rounded-full border border-fd-primary/30 bg-fd-primary/10 px-2 py-0.5 text-[11px] font-medium text-fd-primary">testnet</span></>),
    },
    links: [
      { icon: renderIcon('BookOpen'), text: 'Docs', url: '/docs', active: 'nested-url' },
      { icon: renderIcon('Code'), text: 'API reference', url: '/docs/api-reference' },
      { icon: renderIcon('Drop'), text: 'Faucet', url: '/docs/guides/faucet' },
      { icon: renderIcon('Heartbeat'), text: 'Status', url: '/docs/status' },
      { type: 'button', icon: renderIcon('ArrowSquareOut'), text: 'Launch app', url: 'https://app.usetidepool.tech', external: true, secondary: false },
    ],
  };
}
