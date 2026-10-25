import brand from '@/brand.json';
import lastmod from '@/lib/lastmod.json';

// All affiliation / branding wording comes from brand.json (single source of truth).
export const BRAND = brand;
export const SITE = brand.origin;
export const OG_IMAGE = { url: '/og.png', width: 1200, height: 630, alt: `${brand.name}: ${brand.tagline} (${brand.affiliationShort})` };
export const LASTMOD = lastmod as Record<string, string>;

export const organization = {
  '@type': 'Organization', '@id': `${SITE}/#org`, name: brand.name, url: SITE,
  logo: `${SITE}/icon-512.png`, sameAs: [brand.xUrl], description: `${brand.name} is a ${brand.affiliationShort} project. ${brand.affiliationLong}`,
};
export const website = {
  '@type': 'WebSite', '@id': `${SITE}/#website`, name: brand.name, url: SITE, description: brand.description,
  publisher: { '@id': `${SITE}/#org` }, inLanguage: 'en',
};
export const software = {
  '@type': ['SoftwareApplication', 'WebAPI'], '@id': `${SITE}/#app`, name: `${brand.name}: ${brand.tagline}`,
  url: SITE, description: brand.description, applicationCategory: 'DeveloperApplication', operatingSystem: 'Any',
  offers: { '@type': 'Offer', price: '0', priceCurrency: 'USD' }, isAccessibleForFree: true,
  documentation: `${SITE}/docs`, termsOfService: `${SITE}/docs/resources/trust-model`,
  provider: { '@id': `${SITE}/#org` }, keywords: brand.keywords.join(', '),
  potentialAction: { '@type': 'ReadAction', target: `${SITE}/openapi.json` },
};
export const ldJson = (data: unknown) => ({ __html: JSON.stringify(data).replace(/</g, '\\u003c') });
