'use client';
import { useEffect, useState } from 'react';

const ORIGIN = process.env.NEXT_PUBLIC_TIDEPOOL_URL || '';
type Side = { assetId: string; symbol: string; chain: string; chainName: string; amount: string | null; amountUsd: string | null };
type Swap = { depositAddress: string; depositMemo: string | null; status: string; swapType: string; createdAt: string; updatedAt: string; from: Side; to: Side; sender: string | null; recipient: string | null; txs: { label: string; url: string }[] };
type Page = { data: Swap[]; page: number; limit: number; total: number; totalPages: number };
type Stats = { totalSwaps: number; success: number; refunded: number; failed: number; processing: number; volumeUsd: string; swaps24h: number; volume24hUsd: string; uniqueAddresses: number; chains: { chain: string; chainName: string; swaps: number }[] };

const CHAINS = ['near', 'eth', 'base', 'arb', 'bsc', 'sol', 'stellar', 'sui', 'xrp', 'btc', 'zec', 'hypercore'];
const STATUS: Record<string, [string, string]> = {
  SUCCESS: ['Success', 'text-[var(--otc-ok)] bg-[var(--otc-ok-wash)]'],
  REFUNDED: ['Refunded', 'text-[var(--otc-brand)] bg-[var(--otc-gold-wash)]'],
  FAILED: ['Failed', 'text-[var(--otc-bad)] bg-[var(--otc-bad-wash)]'],
};
const usd = (v: string | number) => `$${Number(v).toLocaleString('en-US', { maximumFractionDigits: Number(v) >= 1000 ? 0 : 2 })}`;
const amt = (v: string | null) => v == null ? '—' : Number(v).toLocaleString('en-US', { maximumFractionDigits: Number(v) >= 1 ? 4 : 8 });
const short = (a?: string | null) => !a ? '—' : a.length > 18 ? `${a.slice(0, 8)}…${a.slice(-6)}` : a;
function ago(t: string) {
  const s = Math.max(0, (Date.now() - Date.parse(t)) / 1000);
  return s < 60 ? `${Math.floor(s)}s ago` : s < 3600 ? `${Math.floor(s / 60)}m ago` : s < 86400 ? `${Math.floor(s / 3600)}h ago` : `${Math.floor(s / 86400)}d ago`;
}
const fallback = (e: React.SyntheticEvent<HTMLImageElement>) => { const i = e.currentTarget; if (!i.src.endsWith('/explorer/fallback.svg')) i.src = '/explorer/fallback.svg'; };

function TokenIcon({ s }: { s: Side }) {
  return (
    <span className="relative inline-block size-8 shrink-0">
      <img src={`/explorer/tokens/${s.symbol.toLowerCase()}.png`} onError={fallback} alt={s.symbol} width={32} height={32} className="size-8 rounded-full bg-fd-muted" />
      <img src={`/explorer/chains/${s.chain}.svg`} onError={fallback} alt={s.chainName} title={s.chainName} width={16} height={16} className="absolute -right-1 -bottom-1 size-4 rounded-full border-2 border-fd-card bg-white object-contain p-px" />
    </span>
  );
}
function Asset({ s }: { s: Side }) {
  return (
    <div className="flex items-center gap-2.5">
      <TokenIcon s={s} />
      <div className="leading-tight"><div className="font-medium tabular-nums">{amt(s.amount)} <span className="text-fd-muted-foreground">{s.symbol}</span></div><div className="text-xs text-fd-muted-foreground">{s.amountUsd ? usd(s.amountUsd) : s.chainName}</div></div>
    </div>
  );
}
const Stat = ({ k, v }: { k: string; v: React.ReactNode }) => <div className="rounded-xl border bg-fd-card p-4 shadow-[var(--tp-shadow)]"><div className="text-xs text-fd-muted-foreground">{k}</div><div className="mt-1 text-2xl font-medium tabular-nums">{v}</div></div>;

export function SwapExplorer() {
  const [stats, setStats] = useState<Stats | null>(null);
  const [res, setRes] = useState<Page | null>(null);
  const [err, setErr] = useState('');
  const [page, setPage] = useState(1);
  const [status, setStatus] = useState('');
  const [chain, setChain] = useState('');
  const [q, setQ] = useState('');
  const [search, setSearch] = useState('');

  useEffect(() => { fetch(`${ORIGIN}/v0/explorer/stats`).then(r => r.json()).then(setStats).catch(() => {}); }, []);
  useEffect(() => {
    let live = true;
    const load = () => {
      const p = new URLSearchParams({ page: String(page), limit: '25' });
      if (status) p.set('status', status); if (chain) p.set('chain', chain); if (search) p.set('search', search);
      fetch(`${ORIGIN}/v0/explorer/swaps?${p}`).then(r => r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))).then(d => { if (live) { setRes(d); setErr(''); } }).catch(e => live && setErr(e.message));
    };
    load();
    const t = setInterval(load, 15000);
    return () => { live = false; clearInterval(t); };
  }, [page, status, chain, search]);

  const sel = 'h-9 rounded-full border bg-fd-card px-3 text-sm';
  return (
    <div className="mt-8 space-y-6">
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Stat k="Total swaps" v={stats ? stats.totalSwaps.toLocaleString() : '—'} />
        <Stat k="Volume (successful)" v={stats ? usd(stats.volumeUsd) : '—'} />
        <Stat k="Swaps, last 24h" v={stats ? stats.swaps24h.toLocaleString() : '—'} />
        <Stat k="Unique addresses" v={stats ? stats.uniqueAddresses.toLocaleString() : '—'} />
      </div>
      {stats && stats.chains.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {stats.chains.map(c => <button key={c.chain} type="button" onClick={() => { setChain(chain === c.chain ? '' : c.chain); setPage(1); }} className={`inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs transition ${chain === c.chain ? 'border-fd-primary bg-[var(--otc-gold-wash)]' : 'bg-fd-card hover:bg-fd-accent'}`}><img src={`/explorer/chains/${c.chain}.svg`} onError={fallback} alt="" width={14} height={14} className="size-3.5 rounded-full bg-white object-contain" />{c.chainName}<span className="text-fd-muted-foreground tabular-nums">{c.swaps}</span></button>)}
        </div>
      )}
      <div className="rounded-2xl border bg-fd-card shadow-[var(--tp-shadow)]">
        <form className="flex flex-wrap items-center gap-2 border-b p-3" onSubmit={e => { e.preventDefault(); setSearch(q.trim()); setPage(1); }}>
          <input value={q} onChange={e => setQ(e.target.value)} placeholder="Search address, deposit address, token or tx" className="h-9 min-w-0 flex-1 rounded-full border bg-fd-background px-4 text-sm outline-none focus:border-fd-primary" />
          <select aria-label="Status" value={status} onChange={e => { setStatus(e.target.value); setPage(1); }} className={sel}><option value="">All statuses</option><option value="SUCCESS">Success</option><option value="PROCESSING">Processing</option><option value="REFUNDED">Refunded</option><option value="FAILED">Failed</option></select>
          <select aria-label="Chain" value={chain} onChange={e => { setChain(e.target.value); setPage(1); }} className={sel}><option value="">All chains</option>{CHAINS.map(c => <option key={c} value={c}>{c === 'hypercore' ? 'Hyperliquid' : c.toUpperCase()}</option>)}</select>
          <button type="submit" className="tp-btn tp-btn-primary h-9 py-0">Search</button>
        </form>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[860px] text-sm">
            <thead><tr className="text-left text-xs text-fd-muted-foreground">{['Time', 'From', '', 'To', 'Status', 'Sender', 'Recipient', 'Deposit', 'Txs'].map((h, i) => <th key={i} className="px-4 py-2.5 font-medium">{h}</th>)}</tr></thead>
            <tbody>
              {res?.data.map(s => {
                const [label, cls] = STATUS[s.status] || ['Processing', 'text-fd-muted-foreground bg-fd-muted'];
                return (
                  <tr key={s.depositAddress + (s.depositMemo || '')} className="border-t hover:bg-fd-accent/50">
                    <td className="whitespace-nowrap px-4 py-3 text-fd-muted-foreground" title={new Date(s.createdAt).toUTCString()}>{ago(s.createdAt)}</td>
                    <td className="px-4 py-3"><Asset s={s.from} /></td>
                    <td className="px-1 text-fd-muted-foreground">→</td>
                    <td className="px-4 py-3"><Asset s={s.to} /></td>
                    <td className="px-4 py-3"><span className={`rounded-full px-2.5 py-1 text-xs font-medium ${cls}`}>{label}</span></td>
                    <td className="px-4 py-3 font-mono text-xs" title={s.sender || ''}>{short(s.sender)}</td>
                    <td className="px-4 py-3 font-mono text-xs" title={s.recipient || ''}>{short(s.recipient)}</td>
                    <td className="px-4 py-3 font-mono text-xs" title={s.depositAddress}>{short(s.depositAddress)}{s.depositMemo ? <span className="text-fd-muted-foreground"> #{s.depositMemo}</span> : null}</td>
                    <td className="whitespace-nowrap px-4 py-3 text-xs">{s.txs.length ? s.txs.slice(-3).map((t, i) => <a key={i} href={t.url} target="_blank" rel="noopener noreferrer" title={t.label} className="me-2 text-fd-primary hover:underline">{i === s.txs.slice(-3).length - 1 ? 'Final' : `#${i + 1}`} ↗</a>) : '—'}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {!res && !err && <p className="p-6 text-center text-sm text-fd-muted-foreground">Loading swaps…</p>}
          {err && <p className="p-6 text-center text-sm text-[var(--otc-bad)]">Could not load swaps ({err}).</p>}
          {res && res.data.length === 0 && <p className="p-6 text-center text-sm text-fd-muted-foreground">No swaps match.</p>}
        </div>
        {res && res.total > 0 && (
          <div className="flex items-center justify-between border-t px-4 py-3 text-sm text-fd-muted-foreground">
            <span>{res.total.toLocaleString()} swaps · page {res.page} of {res.totalPages}</span>
            <div className="flex gap-2">
              <button type="button" disabled={page <= 1} onClick={() => setPage(page - 1)} className="rounded-full border bg-fd-card px-3 py-1 disabled:opacity-40">← Prev</button>
              <button type="button" disabled={page >= res.totalPages} onClick={() => setPage(page + 1)} className="rounded-full border bg-fd-card px-3 py-1 disabled:opacity-40">Next →</button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
