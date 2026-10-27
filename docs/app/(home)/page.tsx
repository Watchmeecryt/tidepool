import Link from 'next/link';
import { SwapFlow } from '@/components/diagrams';
import { Aurora, Waves } from '@/components/ocean';
import { BRAND, ldJson, organization, software, website } from '@/lib/seo';

const ORIGIN = 'https://www.usetidepool.tech';

const features = [
  { t: 'Official verifier', d: 'defuse v0.4.2, byte-identical to the GitHub release and re-checked by /v0/health.' },
  { t: '1Click API shapes', d: 'Same /v0/quote, /v0/status and schemas. The official TypeScript SDK works with one line changed.' },
  { t: 'A real maker', d: 'Quotes every pair from live prices and settles atomically with signed intents.' },
  { t: 'Refunds you can test', d: 'Partial deposits, missed deadlines and slippage all refund on chain, exactly like production.' },
  { t: 'Faucet built in', d: 'USDC, USDT, wNEAR, wBTC, ETH and XAUT to a wallet or an intents balance, in one call.' },
  { t: 'Agent-ready docs', d: 'llms.txt, llms-full.txt, AGENTS.md, OpenAPI and every page as Markdown.' },
];


const icon = (d: string) => <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={d} /></svg>;
const ICONS = [
  'M12 2l8 4v6c0 5-3.5 8.5-8 10-4.5-1.5-8-5-8-10V6l8-4z M9 12l2 2 4-4',
  'M4 7h16M4 12h10M4 17h7 M17 14l3 3-3 3',
  'M3 17c3-4 6-4 9 0s6 4 9 0 M3 11c3-4 6-4 9 0s6 4 9 0',
  'M3 12a9 9 0 1 0 3-6.7L3 8 M3 3v5h5',
  'M12 3c3 4 6 7 6 11a6 6 0 0 1-12 0c0-4 3-7 6-11z',
  'M8 9l-4 3 4 3 M16 9l4 3-4 3 M13 5l-2 14',
];
export default function HomePage() {
  return (
    <main className="flex flex-1 flex-col">
      <section className="relative overflow-hidden border-b border-fd-border/60">
        <Aurora />
        <div className="relative mx-auto max-w-6xl px-6 pb-20 pt-16 sm:pt-24">
          <div className="grid items-center gap-12 lg:grid-cols-[1.15fr_1fr]">
            <div className="text-center lg:text-left">
              <span className="tp-pill tp-rise"><span className="tp-live" /> Live on NEAR testnet · defuse v0.4.2</span>
              <h1 className="tp-display tp-rise tp-d1 mt-6 text-[2.6rem] sm:text-7xl">
                Test NEAR Intents<br />swaps <span className="tp-gradient-text">before they<br className="hidden sm:block" /> cost anything.</span>
              </h1>
              <p className="tp-rise tp-d2 mx-auto mt-4 max-w-xl rounded-lg border border-fd-border/60 px-3 py-2 text-sm text-fd-muted-foreground lg:mx-0"><strong>Trust model:</strong> a community-operated testnet environment. Tidepool runs the maker and derives the deposit-address keys. Testnet only; never send real assets. <Link href="/docs/resources/trust-model" className="underline">Details</Link></p>
              <p className="tp-rise tp-d2 mx-auto mt-6 max-w-xl text-lg text-fd-muted-foreground lg:mx-0">
                Tidepool is a free, community-built testnet version of the 1Click API: NEAR's unmodified verifier, test tokens, a live maker and the same Swap API endpoints. Point your app or agent at one free 1Click testnet endpoint and run the full flow end to end.
              </p>
              <div className="tp-rise tp-d3 mt-8 flex flex-wrap justify-center gap-3 lg:justify-start">
                <Link href="/docs/quickstart" className="tp-btn tp-btn-primary">Run your first test swap →</Link>
                <Link href="/docs/guides/faucet" className="tp-btn tp-btn-ghost">Get test tokens</Link>
                <a href="https://github.com/zer0plugyut-afk/tidepool-examples" className="tp-btn tp-btn-ghost">Examples repo</a>
              </div>
            </div>
            <div className="tp-rise tp-d4 tp-terminal mx-auto w-full max-w-xl">
              <div className="tp-terminal-bar"><i /><i /><i /><span className="ms-2">swap.ts</span></div>
              <pre><span className="c">{'// the only change from mainnet 1Click'}</span>{'\n'}<span className="k">import</span> {'{ OpenAPI, OneClickService }'} <span className="k">from</span> <span className="s">&apos;@defuse-protocol/one-click-sdk-typescript&apos;</span>;{'\n\n'}OpenAPI.BASE = <span className="s">&apos;{ORIGIN}&apos;</span>;{'\n\n'}<span className="k">const</span> q = <span className="k">await</span> OneClickService.getQuote({'{'}{'\n'}  originAsset: <span className="s">&apos;nep141:usdc…&apos;</span>,{'\n'}  destinationAsset: <span className="s">&apos;nep141:wnear…&apos;</span>,{'\n'}  amount: <span className="n">&apos;5000000&apos;</span>, dry: <span className="n">false</span>,{'\n'}{'}'});{'\n'}<span className="c">{'// → depositAddress, then poll /v0/status → SUCCESS'}</span></pre>
            </div>
          </div>
        </div>
        <Waves />
      </section>

      <section className="mx-auto w-full max-w-6xl px-6 py-20">
        <p className="text-center text-xs font-semibold uppercase tracking-[.2em] text-fd-primary">The flow</p>
        <h2 className="tp-display mt-3 text-center text-3xl sm:text-5xl">Quote. Deposit. <span className="tp-gradient-text">Settle.</span></h2>
        <div className="tp-glass mt-10 p-4 sm:p-6"><SwapFlow /></div>
        <div className="mt-6 grid gap-4 sm:grid-cols-3">
          {[['01', 'Quote', 'POST /v0/quote returns a price and a one-time deposit address.'], ['02', 'Deposit', 'Send amountIn to that address on NEAR or inside the verifier.'], ['03', 'Settle', 'The maker fills it in one execute_intents call. Poll /v0/status for SUCCESS.']].map(([n, t, d]) => (
            <div key={n} className="tp-glass p-6">
              <div className="tp-display text-4xl text-fd-primary/80">{n}</div>
              <div className="mt-3 text-lg font-semibold">{t}</div>
              <p className="mt-1 text-sm text-fd-muted-foreground">{d}</p>
            </div>
          ))}
        </div>
      </section>

      <section className="relative overflow-hidden border-y border-fd-border/60">
        <Aurora className="opacity-60" />
        <div className="relative mx-auto max-w-6xl px-6 py-20">
          <h2 className="tp-display text-center text-3xl sm:text-5xl">Production-shaped, <span className="tp-gradient-text">zero-risk.</span></h2>
          <div className="mt-10 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {features.map((f, i) => (
              <div key={f.t} className="tp-glass p-6">
                <div className="tp-icon">{icon(ICONS[i])}</div>
                <div className="mt-4 text-lg font-semibold">{f.t}</div>
                <p className="mt-1.5 text-sm text-fd-muted-foreground">{f.d}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      <section className="mx-auto w-full max-w-3xl px-6 pt-20 text-center">
        <h2 className="tp-display text-3xl sm:text-4xl">A testnet-compatible <span className="tp-gradient-text">1Click API</span></h2>
        <p className="mt-4 text-fd-muted-foreground">Mainnet 1Click moves real funds, so Tidepool works as a 1Click API alternative for development and CI: a NEAR Intents 1Click sandbox with the same request and response fields. When you are ready, switch the base URL back to 1Click. {BRAND.affiliationLong}</p>
      </section>

      <section className="mx-auto w-full max-w-6xl px-6 py-20">
        <div className="tp-glass overflow-hidden p-8 text-center sm:p-12">
          <h2 className="tp-display text-3xl sm:text-4xl">Built for humans <span className="tp-gradient-text">and agents</span></h2>
          <p className="mx-auto mt-3 max-w-xl text-fd-muted-foreground">Every page ships as Markdown, with one-click Copy and Open in ChatGPT or Claude.</p>
          <div className="mt-7 flex flex-wrap justify-center gap-2 font-mono text-sm">
            {['/llms.txt', '/llms-full.txt', '/AGENTS.md', '/openapi.json', '/docs/quickstart.md'].map(h => <a key={h} href={h} className="tp-btn tp-btn-ghost !px-3 !py-1.5 !text-[13px] !font-medium">{h}</a>)}
          </div>
        </div>
      </section>

      <footer className="border-t border-fd-border/60 py-10 text-center text-xs text-fd-muted-foreground">
        <p className="font-medium">{BRAND.affiliation}</p>
        <p className="mt-1">{BRAND.affiliationLong} Testnet only; test tokens have no value.</p>
      </footer>
      <script type="application/ld+json" dangerouslySetInnerHTML={ldJson({ '@context': 'https://schema.org', '@graph': [organization, website, software] })} />
    </main>
  );
}
