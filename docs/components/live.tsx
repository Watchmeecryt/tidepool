'use client';
import { useEffect, useState } from 'react';

const ORIGIN = process.env.NEXT_PUBLIC_TIDEPOOL_URL || '';

export function FaucetWidget() {
  const [accountId, setAccount] = useState('');
  const [mode, setMode] = useState('wallet');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string; txs?: { assetId?: string; amount: string; explorerUrl: string }[] } | null>(null);
  async function go(e: React.FormEvent) {
    e.preventDefault(); setBusy(true); setMsg(null);
    try {
      const r = await fetch(`${ORIGIN}/v0/faucet`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ accountId: accountId.trim(), mode }) });
      const j = await r.json();
      if (!r.ok) setMsg({ ok: false, text: j.message || `Error ${r.status}` });
      else setMsg({ ok: true, text: `Sent ${j.drips.map((d: { amount: string; symbol: string }) => `${d.amount} ${d.symbol}`).join(', ')} to ${j.accountId} (${j.mode}).`, txs: j.transactions });
    } catch (err) { setMsg({ ok: false, text: String(err) }); }
    setBusy(false);
  }
  return (
    <form onSubmit={go} className="not-prose my-6 rounded-2xl border bg-fd-card p-5 shadow-sm">
      <div className="grid gap-3 sm:grid-cols-[1fr_190px_auto] sm:items-end">
        <label className="text-sm font-medium">Testnet account
          <input required value={accountId} onChange={e => setAccount(e.target.value)} placeholder="you.testnet" className="mt-1.5 w-full rounded-lg border bg-fd-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-fd-ring" />
        </label>
        <label className="text-sm font-medium">Send to
          <select value={mode} onChange={e => setMode(e.target.value)} className="mt-1.5 w-full rounded-lg border bg-fd-background px-3 py-2 text-sm">
            <option value="wallet">Wallet (NEP-141)</option>
            <option value="intents">Intents balance</option>
          </select>
        </label>
        <button disabled={busy} className="rounded-lg bg-fd-primary px-4 py-2 text-sm font-semibold text-fd-primary-foreground disabled:opacity-60">{busy ? 'Sending…' : 'Get test tokens'}</button>
      </div>
      {msg && <div className={`mt-3 text-sm ${msg.ok ? 'text-fd-primary' : 'text-red-600'}`}>{msg.text}
        {msg.txs && <ul className="mt-2 list-disc ps-5">{msg.txs.map(t => <li key={t.explorerUrl}><a className="underline" href={t.explorerUrl} target="_blank" rel="noreferrer">{t.assetId ? t.assetId.split(':')[1].split('.')[0] : 'batch'} transaction</a></li>)}</ul>}
      </div>}
    </form>
  );
}

type Health = { ok: boolean; verifier: string; verifierWasmSha256: string; checks: Record<string, { ok: boolean; height?: number; ms?: number; source?: string; codeHashHex?: string; balances?: Record<string, string> }>; swaps: Record<string, number>; recent: { status: string; pair: string; updatedAt: string; tx?: string }[] };
export function StatusWidget() {
  const [h, setH] = useState<Health | null>(null);
  const [err, setErr] = useState('');
  useEffect(() => {
    const load = () => fetch(`${ORIGIN}/v0/health`).then(r => r.json()).then(setH).catch(e => setErr(String(e)));
    load(); const t = setInterval(load, 15000); return () => clearInterval(t);
  }, []);
  if (err) return <p className="text-red-600">Could not reach the API: {err}</p>;
  if (!h) return <p className="text-fd-muted-foreground">Loading live status…</p>;
  const Dot = ({ ok }: { ok: boolean }) => <span className={`inline-block size-2.5 rounded-full ${ok ? 'bg-emerald-500' : 'bg-amber-500'}`} />;
  const c = h.checks;
  const cards: [string, boolean, string][] = [
    ['NEAR testnet RPC', c.rpc?.ok, c.rpc?.ok ? `block ${c.rpc.height} · ${c.rpc.ms} ms` : 'unreachable'],
    ['Verifier code', c.verifier?.ok, c.verifier?.ok ? 'matches defuse v0.4.2' : 'hash mismatch'],
    ['Price feed', c.prices?.source === 'coingecko', c.prices?.source || '?'],
    ['Maker inventory', c.makerInventory?.ok, c.makerInventory?.ok ? 'online' : 'error'],
  ];
  return (
    <div className="not-prose my-6 space-y-5">
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {cards.map(([t, ok, d]) => <div key={t} className="rounded-xl border bg-fd-card p-4"><div className="flex items-center gap-2 text-sm text-fd-muted-foreground"><Dot ok={ok} />{t}</div><div className="mt-1 font-medium">{d}</div></div>)}
      </div>
      {c.makerInventory?.balances && <div className="rounded-xl border bg-fd-card p-4"><div className="mb-2 text-sm text-fd-muted-foreground">Maker inventory (intents balances)</div><div className="grid grid-cols-3 gap-2 font-mono text-sm sm:grid-cols-6">{Object.entries(c.makerInventory.balances).map(([k, v]) => <div key={k}><b>{k}</b><br />{Number(v).toLocaleString()}</div>)}</div></div>}
      <div className="rounded-xl border bg-fd-card p-4 text-sm"><b>Swaps:</b> {h.swaps.total} total · {h.swaps.success} success · {h.swaps.refunded} refunded · {h.swaps.active} active
        {h.recent?.length > 0 && <ul className="mt-2 space-y-1">{h.recent.map(r => <li key={r.updatedAt}><code>{r.status}</code> {r.pair} · {new Date(r.updatedAt).toUTCString()} {r.tx && <a className="underline" href={r.tx} target="_blank" rel="noreferrer">tx</a>}</li>)}</ul>}
      </div>
    </div>
  );
}

export function TryIt({ method, path, body }: { method: 'GET' | 'POST'; path: string; body?: string }) {
  const [b, setB] = useState(body || '');
  const [p, setP] = useState(path);
  const [out, setOut] = useState('');
  const [busy, setBusy] = useState(false);
  async function run() {
    setBusy(true); setOut('');
    try {
      const r = await fetch(`${ORIGIN}${p}`, { method, headers: method === 'POST' ? { 'content-type': 'application/json' } : {}, body: method === 'POST' ? b : undefined });
      const t = await r.text(); let pretty = t; try { pretty = JSON.stringify(JSON.parse(t), null, 2); } catch {}
      setOut(`HTTP ${r.status}\n\n${pretty}`);
    } catch (e) { setOut(String(e)); }
    setBusy(false);
  }
  return (
    <div className="not-prose my-6 rounded-2xl border bg-fd-card">
      <div className="flex items-center gap-2 border-b px-4 py-2.5 text-sm">
        <span className={`tp-method ${method === 'GET' ? 'tp-get' : 'tp-post'}`}>{method}</span>
        <input value={p} onChange={e => setP(e.target.value)} className="flex-1 bg-transparent font-mono outline-none" />
        <button onClick={run} disabled={busy} className="rounded-md bg-fd-primary px-3 py-1.5 text-xs font-semibold text-fd-primary-foreground disabled:opacity-60">{busy ? 'Sending…' : 'Send request'}</button>
      </div>
      {method === 'POST' && <textarea value={b} onChange={e => setB(e.target.value)} rows={Math.min(16, b.split('\n').length + 1)} className="w-full resize-y bg-transparent p-4 font-mono text-xs outline-none" />}
      {out && <pre className="max-h-96 overflow-auto border-t p-4 font-mono text-xs">{out}</pre>}
    </div>
  );
}
