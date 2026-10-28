import defaultMdxComponents from 'fumadocs-ui/mdx';
import { Tab, Tabs } from 'fumadocs-ui/components/tabs';
import { Step, Steps } from 'fumadocs-ui/components/steps';
import { Accordion, Accordions } from 'fumadocs-ui/components/accordion';
import { TypeTable } from 'fumadocs-ui/components/type-table';
import type { MDXComponents } from 'mdx/types';
import { StatusLifecycle, SwapFlow } from './diagrams';
import { FaucetWidget, StatusWidget, TryIt } from './live';
import { DemoVideo, DocsHero } from './ocean';
import { H1, H2, H3, H4, H5, H6 } from './heading';

export function getMDXComponents(components?: MDXComponents) {
  return {
    ...defaultMdxComponents,
    h1: H1, h2: H2, h3: H3, h4: H4, h5: H5, h6: H6,
    Tab, Tabs, Step, Steps, Accordion, Accordions, TypeTable,
    SwapFlow, StatusLifecycle, FaucetWidget, StatusWidget, TryIt, DocsHero, DemoVideo,
    ...components,
  } satisfies MDXComponents;
}

export const useMDXComponents = getMDXComponents;

declare global {
  type MDXProvidedComponents = ReturnType<typeof getMDXComponents>;
}
