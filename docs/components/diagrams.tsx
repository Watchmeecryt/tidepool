const teal = 'var(--otc-brand)';
function Box({ x, y, w, h, title, sub, solid }: { x: number; y: number; w: number; h: number; title: string; sub?: string; solid?: boolean }) {
  return (
    <g>
      <rect x={x} y={y} width={w} height={h} rx={14} fill={solid ? 'var(--otc-text)' : 'var(--color-fd-card)'} stroke={solid ? 'var(--otc-text)' : 'var(--color-fd-border)'} />
      <text x={x + w / 2} y={y + h / 2 - (sub ? 4 : -5)} textAnchor="middle" fontSize={15} fontWeight={600} fill={solid ? 'var(--otc-bg)' : 'var(--color-fd-foreground)'}>{title}</text>
      {sub && <text x={x + w / 2} y={y + h / 2 + 16} textAnchor="middle" fontSize={12} fill={solid ? 'var(--otc-border-alt)' : 'var(--color-fd-muted-foreground)'}>{sub}</text>}
    </g>
  );
}
function Arrow({ d, label, lx, ly, dashed }: { d: string; label?: string; lx?: number; ly?: number; dashed?: boolean }) {
  return (
    <g>
      <path d={d} stroke={teal} strokeWidth={2} fill="none" markerEnd="url(#tp-ar)" strokeDasharray={dashed ? '5 5' : undefined} />
      {label && <text x={lx} y={ly} textAnchor="middle" fontSize={12} fontWeight={500} fill={teal}>{label}</text>}
    </g>
  );
}
const Defs = () => (
  <defs><marker id="tp-ar" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M0 0L10 5L0 10z" fill={teal} /></marker></defs>
);

/** Your app → quote → deposit address → verifier ↔ maker → recipient */
export function SwapFlow() {
  return (
    <figure className="tp-diagram">
      <svg viewBox="0 0 900 260" role="img" aria-label="Swap flow">
        <Defs />
        <g fontFamily="var(--font-sans), sans-serif">
          <Box x={10} y={95} w={150} h={70} title="Your app" sub="wallet · agent · SDK" />
          <Box x={250} y={10} w={170} h={64} title="Tidepool API" sub="/v0/quote · /v0/status" />
          <Box x={250} y={185} w={170} h={64} title="Deposit address" sub="unique per quote" />
          <Box x={500} y={90} w={180} h={80} title="Intents verifier" sub="official defuse contract" solid />
          <Box x={760} y={20} w={130} h={64} title="Maker" sub="Tidepool solver" />
          <Box x={760} y={176} w={130} h={64} title="Recipient" sub="wallet or intents" />
          <Arrow d="M160 115 L246 50" label="1 quote" lx={190} ly={70} />
          <Arrow d="M160 145 L246 210" label="2 deposit" lx={186} ly={200} />
          <Arrow d="M420 205 L496 150" label="3 sweep" lx={474} ly={196} />
          <Arrow d="M680 110 L756 60" label="4 settle" lx={706} ly={70} />
          <Arrow d="M756 74 L684 122" dashed />
          <Arrow d="M680 150 L756 200" label="5 pay out" lx={700} ly={196} />
        </g>
      </svg>
      <figcaption>Get a quote with a deposit address, send tokens to it, and Tidepool settles a signed token swap with the maker on the verifier. Unfilled deposits go back to <code>refundTo</code>.</figcaption>
    </figure>
  );
}

/** PENDING_DEPOSIT → KNOWN_DEPOSIT_TX → PROCESSING → SUCCESS, with INCOMPLETE_DEPOSIT / REFUNDED / FAILED branches */
export function StatusLifecycle() {
  const S = ({ x, y, t, c = 'var(--color-fd-card)', f = 'var(--color-fd-foreground)', w = 170 }: { x: number; y: number; t: string; c?: string; f?: string; w?: number }) => (
    <g><rect x={x} y={y} width={w} height={42} rx={21} fill={c} stroke="var(--color-fd-border)" /><text x={x + w / 2} y={y + 26} textAnchor="middle" fontSize={13} fontWeight={600} fontFamily="var(--font-mono), monospace" fill={f}>{t}</text></g>
  );
  return (
    <figure className="tp-diagram">
      <svg viewBox="0 0 920 250" role="img" aria-label="Status lifecycle">
        <Defs />
        <g fontFamily="var(--font-sans), sans-serif">
          <S x={10} y={40} t="PENDING_DEPOSIT" />
          <S x={240} y={40} t="KNOWN_DEPOSIT_TX" w={180} />
          <S x={480} y={40} t="PROCESSING" w={150} />
          <S x={700} y={40} t="SUCCESS" w={150} c="var(--otc-ok-wash)" f="var(--otc-ok)" />
          <S x={240} y={170} t="INCOMPLETE_DEPOSIT" w={200} />
          <S x={500} y={170} t="REFUNDED" w={150} c="var(--otc-gold-wash)" f="var(--otc-brand)" />
          <S x={700} y={170} t="FAILED" w={150} c="var(--otc-bad-wash)" f="var(--otc-bad)" />
          <Arrow d="M180 61 L236 61" label="tx seen" lx={208} ly={30} />
          <Arrow d="M420 61 L476 61" label="full deposit" lx={448} ly={30} />
          <Arrow d="M630 61 L696 61" label="settled" lx={663} ly={30} />
          <Arrow d="M330 82 L330 166" label="partial" lx={364} ly={130} />
          <Arrow d="M440 191 L496 191" label="deadline" lx={468} ly={235} />
          <Arrow d="M555 82 L575 166" label="settle failed" lx={612} ly={130} />
          <Arrow d="M90 82 Q90 225 496 205" label="deadline, nothing usable" lx={190} ly={238} dashed />
          <Arrow d="M650 191 L696 191" label="refund failed" lx={672} ly={160} dashed />
        </g>
      </svg>
      <figcaption>Every status value is the same string 1Click returns. <code>SUCCESS</code>, <code>REFUNDED</code> and <code>FAILED</code> are final.</figcaption>
    </figure>
  );
}
