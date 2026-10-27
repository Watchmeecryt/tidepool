import { source } from '@/lib/source';
import { DocsLayout } from 'fumadocs-ui/layouts/docs';
import { baseOptions } from '@/lib/layout.shared';
import { BRAND } from '@/lib/seo';

export default function Layout({ children }: LayoutProps<'/docs'>) {
  return (
    <DocsLayout tree={source.getPageTree()} {...baseOptions()} sidebar={{ footer: <p className="px-2 pb-1 text-xs text-fd-muted-foreground">Built by <a href={BRAND.builderUrl} target="_blank" rel="noopener" className="font-medium text-fd-foreground underline underline-offset-2">{BRAND.builderHandle}</a></p> }}>
      {children}
    </DocsLayout>
  );
}
