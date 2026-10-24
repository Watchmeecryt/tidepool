import Link from 'next/link';
import { SwapFlow } from '@/components/diagrams';

const ORIGIN = 'https://www.usetidepool.tech';

const features = [
  { t: 'Official verifier', d: 'defuse v0.4.2, byte-identical to the GitHub release and re-checked by /v0/health.' },
  { t: '1Click API shapes', d: 'Same /v0/quote, /v0/status and schemas. The official TypeScript SDK works with one line changed.' },
  { t: 'A real maker', d: 'Quotes every pair from live prices and settles atomically with signed intents.' },
  { t: 'Refunds you can test', d: 'Partial deposits, missed deadlines and slippage all refund on chain, exactly like production.' },
  { t: 'Faucet built in', d: 'USDC, USDT, wNEAR, wBTC, ETH and XAUT to a wallet or an intents balance, in one call.' },
  { t: 'Agent-ready docs', d: 'llms.txt, llms-full.txt, AGENTS.md, OpenAPI and every page as Markdown.' },
];

export default function HomePage() {
  return (
    <main className="flex flex-1 flex-col">
      <section className="relative overflow-hidden border-b">
        <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(60%_60%_at_50%_0%,color-mix(in_oklab,var(--color-fd-primary)_22%,transparent),transparent)]" />
        <div className="relative mx-auto max-w-5xl px-6 pb-16 pt-20 text-center">
          <span className="inline-flex items-center gap-2 rounded-full border bg-fd-card px-3 py-1 text-xs text-fd-muted-foreground">
            <span className="size-1.5 rounded-full bg-emerald-500" /> Live on NEAR testnet
          </span>
          <h1 className="mt-6 text-4xl font-semibold tracking-tight sm:text-6xl">
            Test NEAR Intents swaps<br /><span className="text-fd-primary">before they cost anything.</span>
          </h1>
          <p className="mx-auto mt-5 max-w-2xl text-lg text-fd-muted-foreground">
            Tidepool is a 1Click-compatible testnet sandbox: the official verifier, test tokens, a live maker and the same Swap API. Point your app or agent at it and run the full flow end to end.
          </p>
          <div className="mt-8 flex flex-wrap justify-center gap-3">
            <Link href="/docs/quickstart" className="rounded-lg bg-fd-primary px-5 py-2.5 text-sm font-semibold text-fd-primary-foreground shadow-sm">Quickstart</Link>
            <Link href="/docs/guides/faucet" className="rounded-lg border bg-fd-card px-5 py-2.5 text-sm font-semibold">Get test tokens</Link>
            <Link href="/docs/api-reference" className="rounded-lg border bg-fd-card px-5 py-2.5 text-sm font-semibold">API reference</Link>
          </div>
          <pre className="mx-auto mt-10 max-w-2xl overflow-x-auto rounded-xl border bg-fd-card p-4 text-left font-mono text-[13px] shadow-sm"><span className="text-fd-muted-foreground">// the only change from mainnet 1Click</span>{'\n'}OpenAPI.BASE = <span className="text-fd-primary">&apos;{ORIGIN}&apos;</span>;</pre>
        </div>
      </section>

      <section className="mx-auto w-full max-w-5xl px-6 py-14">
        <h2 className="text-center text-2xl font-semibold">How a swap flows</h2>
        <SwapFlow />
        <div className="mt-8 grid gap-4 sm:grid-cols-3">
          {[['1', 'Quote', 'POST /v0/quote returns a price and a one-time deposit address.'], ['2', 'Deposit', 'Send amountIn to that address on NEAR or inside the verifier.'], ['3', 'Settle', 'The maker fills it in one execute_intents call. Poll /v0/status for SUCCESS.']].map(([n, t, d]) => (
            <div key={n} className="rounded-xl border bg-fd-card p-5">
              <div className="flex size-8 items-center justify-center rounded-full bg-fd-primary/15 text-sm font-bold text-fd-primary">{n}</div>
              <div className="mt-3 font-semibold">{t}</div>
              <p className="mt-1 text-sm text-fd-muted-foreground">{d}</p>
            </div>
          ))}
        </div>
      </section>

      <section className="border-y bg-fd-card/50">
        <div className="mx-auto grid max-w-5xl gap-4 px-6 py-14 sm:grid-cols-2 lg:grid-cols-3">
          {features.map(f => (
            <div key={f.t} className="rounded-xl border bg-fd-background p-5">
              <div className="font-semibold">{f.t}</div>
              <p className="mt-1.5 text-sm text-fd-muted-foreground">{f.d}</p>
            </div>
          ))}
        </div>
      </section>

      <section className="mx-auto w-full max-w-5xl px-6 py-14 text-center">
        <h2 className="text-2xl font-semibold">Built for humans and agents</h2>
        <p className="mx-auto mt-3 max-w-xl text-fd-muted-foreground">Every page ships as Markdown, with one-click Copy and Open in ChatGPT or Claude.</p>
        <div className="mt-6 flex flex-wrap justify-center gap-2 font-mono text-sm">
          {['/llms.txt', '/llms-full.txt', '/AGENTS.md', '/openapi.json', '/docs/quickstart.md'].map(h => <a key={h} href={h} className="rounded-md border bg-fd-card px-3 py-1.5 hover:border-fd-primary">{h}</a>)}
        </div>
      </section>

      <footer className="border-t py-8 text-center text-xs text-fd-muted-foreground">
        Tidepool is community-built and not affiliated with NEAR, Defuse or 1Click. Testnet only; test tokens have no value.
      </footer>
    </main>
  );
}
