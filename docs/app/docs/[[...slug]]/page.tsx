import { source } from '@/lib/source';
import {
  DocsBody,
  DocsDescription,
  DocsPage,
  DocsTitle,
  MarkdownCopyButton,
  ViewOptionsPopover,
} from 'fumadocs-ui/layouts/docs/page';
import { notFound } from 'next/navigation';
import { getMDXComponents } from '@/components/mdx';
import type { Metadata } from 'next';
import { createRelativeLink } from 'fumadocs-ui/mdx';
import { getPageMarkdownUrl, gitConfig } from '@/lib/shared';
import { BRAND, LASTMOD, OG_IMAGE, SITE, ldJson } from '@/lib/seo';

const SUFFIX = ` Part of ${BRAND.name}, the ${BRAND.affiliationShort} 1Click API testnet sandbox for NEAR Intents.`;
const describe = (d?: string) => { const base = d || BRAND.description; return base.length < 110 ? `${/[.!?]$/.test(base) ? base : `${base}.`}${SUFFIX}` : base; };

export default async function Page(props: PageProps<'/docs/[[...slug]]'>) {
  const params = await props.params;
  const page = source.getPage(params.slug);
  if (!page) notFound();

  const MDX = page.data.body;
  const markdownUrl = getPageMarkdownUrl(page).url;

  return (
    <DocsPage toc={page.data.toc} full={page.data.full}>
      <DocsTitle>{page.data.title}</DocsTitle>
      <DocsDescription className="mb-0">{page.data.description}</DocsDescription>
      <div className="flex flex-row gap-2 items-center border-b pb-6">
        <MarkdownCopyButton markdownUrl={markdownUrl} />
        <ViewOptionsPopover
          markdownUrl={markdownUrl}
          githubUrl={`https://github.com/${gitConfig.user}/${gitConfig.repo}/blob/${gitConfig.branch}/content/docs/${page.path}`}
        />
      </div>
      <script type="application/ld+json" dangerouslySetInnerHTML={ldJson(jsonLd(page))} />
      <DocsBody>
        <MDX
          components={getMDXComponents({
            // this allows you to link to other pages with relative file paths
            a: createRelativeLink(source, page),
          })}
        />
      </DocsBody>
      <p className="mt-10 border-t pt-4 text-xs text-fd-muted-foreground">{BRAND.affiliation}. {BRAND.affiliationLong} Testnet only; test tokens have no value.</p>
    </DocsPage>
  );
}

export async function generateStaticParams() {
  return source.generateParams();
}

function jsonLd(page: NonNullable<ReturnType<typeof source.getPage>>) {
  const url = `${SITE}${page.url}`;
  const crumbs = [{ name: BRAND.name, url: `${SITE}/` }, { name: 'Docs', url: `${SITE}/docs` }];
  if (page.slugs.length) crumbs.push({ name: page.data.title, url });
  return {
    '@context': 'https://schema.org',
    '@graph': [
      { '@type': 'BreadcrumbList', itemListElement: crumbs.map((c, i) => ({ '@type': 'ListItem', position: i + 1, name: c.name, item: c.url })) },
      { '@type': 'TechArticle', headline: page.data.title, description: describe(page.data.description), url, mainEntityOfPage: url,
        image: `${SITE}${OG_IMAGE.url}`, dateModified: LASTMOD[page.slugs.join('/')] || undefined, inLanguage: 'en',
        about: ['NEAR Intents', '1Click API', 'testnet'], isPartOf: { '@type': 'WebSite', '@id': `${SITE}/#website`, name: BRAND.name, url: SITE },
        publisher: { '@type': 'Organization', '@id': `${SITE}/#org`, name: BRAND.name, url: SITE, description: BRAND.affiliationLong } },
    ],
  };
}

export async function generateMetadata(props: PageProps<'/docs/[[...slug]]'>): Promise<Metadata> {
  const params = await props.params;
  const page = source.getPage(params.slug);
  if (!page) notFound();
  const description = describe(page.data.description);
  const title = page.slugs.length ? page.data.title : 'Docs: NEAR Intents testnet sandbox (1Click API-compatible)';
  const full = `${title} · ${BRAND.name} (NEAR Intents testnet)`;
  return {
    title, description,
    alternates: { canonical: page.url },
    openGraph: { type: 'article', siteName: BRAND.name, title: full, description, url: page.url, images: [OG_IMAGE] },
    twitter: { card: 'summary_large_image', title: full, description, images: [OG_IMAGE.url] },
  };
}
