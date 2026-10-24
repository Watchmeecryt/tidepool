import Link from 'next/link';

/** Animated aurora + wave backdrop. Pure CSS/SVG, GPU transforms only, paused under prefers-reduced-motion. */
export function Aurora({ className = '' }: { className?: string }) {
  return (
    <div aria-hidden="true" className={`tp-aurora ${className}`}>
      <span className="tp-blob tp-blob-1" />
      <span className="tp-blob tp-blob-2" />
      <span className="tp-blob tp-blob-3" />
      <div className="tp-grid" />
    </div>
  );
}

export function Waves() {
  const d = (y: number, a: number) => `M0 ${y} C 240 ${y - a}, 480 ${y + a}, 720 ${y} S 1200 ${y - a}, 1440 ${y} S 1920 ${y + a}, 2160 ${y} S 2640 ${y - a}, 2880 ${y} V 200 H 0 Z`;
  return (
    <div aria-hidden="true" className="tp-waves">
      <svg viewBox="0 0 2880 200" preserveAspectRatio="none" className="tp-wave tp-wave-1"><path d={d(90, 34)} /></svg>
      <svg viewBox="0 0 2880 200" preserveAspectRatio="none" className="tp-wave tp-wave-2"><path d={d(120, 26)} /></svg>
      <svg viewBox="0 0 2880 200" preserveAspectRatio="none" className="tp-wave tp-wave-3"><path d={d(150, 18)} /></svg>
    </div>
  );
}

/** Hero for the docs introduction page. */
export function DocsHero() {
  return (
    <div className="tp-docs-hero not-prose">
      <Aurora />
      <div className="relative">
        <span className="tp-pill"><span className="tp-live" /> Live on NEAR testnet</span>
        <h2 className="tp-display mt-4 text-3xl sm:text-5xl">Dive into <span className="tp-gradient-text">Tidepool</span></h2>
        <p className="mt-3 max-w-xl text-fd-muted-foreground">The official verifier, six test tokens, a live maker and the 1Click Swap API, all on testnet. Change one base URL and ship.</p>
        <div className="mt-6 flex flex-wrap gap-3">
          <Link href="/docs/quickstart" className="tp-btn tp-btn-primary">Quickstart →</Link>
          <Link href="/docs/guides/first-swap" className="tp-btn tp-btn-ghost">First swap in 5 min</Link>
        </div>
        <div className="mt-6 grid grid-cols-3 gap-3 sm:max-w-md">
          {[['6', 'test tokens'], ['4', 'API endpoints'], ['~5s', 'to SUCCESS']].map(([n, l]) => (
            <div key={l} className="tp-stat"><b>{n}</b><span>{l}</span></div>
          ))}
        </div>
      </div>
      <Waves />
    </div>
  );
}
