'use client';
import { useEffect, useState } from 'react';

const ORIGIN = process.env.NEXT_PUBLIC_TIDEPOOL_URL || '';

type FaucetChain = 'near' | 'eth' | 'base' | 'arb' | 'sol' | 'stellar' | 'sui';
const ISSUER = 'GDXABUSRHP4YA5CELHLNJQ4M3TX2BSJ6PEMDFCG2RA4PQLAQLRMFFQAN';
const CHAINS: Record<FaucetChain, { label: string; placeholder: string; valid: (v: string) => boolean; hint: string; gas?: string; gasUrl?: string }> = {
  near: { label: 'NEAR testnet', placeholder: 'you.testnet', valid: v => /^[a-z0-9._-]{2,64}$/.test(v), hint: 'a NEAR testnet account id like you.testnet' },
  eth: { label: 'Ethereum Sepolia', placeholder: '0x… (40 hex characters)', valid: v => /^0x[0-9a-fA-F]{40}$/.test(v), hint: 'an EVM address (0x…)', gas: 'Sepolia ETH', gasUrl: 'https://cloud.google.com/application/web3/faucet/ethereum/sepolia' },
  base: { label: 'Base Sepolia', placeholder: '0x… (40 hex characters)', valid: v => /^0x[0-9a-fA-F]{40}$/.test(v), hint: 'an EVM address (0x…)', gas: 'Base Sepolia ETH', gasUrl: 'https://docs.base.org/base-chain/network-information/network-faucets' },
  arb: { label: 'Arbitrum Sepolia', placeholder: '0x… (40 hex characters)', valid: v => /^0x[0-9a-fA-F]{40}$/.test(v), hint: 'an EVM address (0x…)', gas: 'Arbitrum Sepolia ETH', gasUrl: 'https://faucet.quicknode.com/arbitrum/sepolia' },
  sol: { label: 'Solana devnet', placeholder: 'Base58 wallet address', valid: v => /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(v), hint: 'a Solana wallet address (base58)', gas: 'devnet SOL', gasUrl: 'https://faucet.solana.com' },
  stellar: { label: 'Stellar testnet', placeholder: 'G… (56 characters)', valid: v => /^G[A-Z2-7]{55}$/.test(v), hint: 'a Stellar public key (G…) that already exists and trusts USDC and USDT', gas: 'test XLM (Friendbot)', gasUrl: 'https://friendbot.stellar.org' },
  sui: { label: 'Sui testnet', placeholder: '0x… (64 hex characters)', valid: v => /^0x[0-9a-fA-F]{64}$/.test(v), hint: 'a Sui address (0x followed by 64 hex characters)', gas: 'testnet SUI', gasUrl: 'https://faucet.sui.io' },
};
const BRIDGED_CHOICES: [string, string][] = [
  ['native', 'Default: the six NEAR test tokens'],
  ['eth', 'Bridged from Ethereum Sepolia: USDC + USDT (100 each)'],
  ['base', 'Bridged from Base Sepolia: USDC + USDT (100 each)'],
  ['arb', 'Bridged from Arbitrum Sepolia: USDC + USDT (100 each)'],
  ['sol', 'Bridged from Solana devnet: USDC + USDT (100 each) + test SOL (0.05)'],
  ['stellar', 'Bridged from Stellar testnet: USDC + USDT (100 each) + test XLM (5)'],
  ['sui', 'Bridged from Sui testnet: USDC + USDT (100 each) + test SUI (0.5)'],
  ['bridged', 'Bridged from every chain above (bridged tokens only)'],
];

export function FaucetWidget() {
  const [chain, setChain] = useState<FaucetChain>('near');
  const [accountId, setAccount] = useState('');
  const [mode, setMode] = useState('wallet');
  const [bridged, setBridged] = useState('native');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string; txs?: { assetId?: string; amount?: string; explorerUrl: string }[] } | null>(null);
  const c = CHAINS[chain];
  const value = accountId.trim();
  const invalid = value.length > 0 && !c.valid(value);
  async function go(e: React.FormEvent) {
    e.preventDefault(); setMsg(null);
    if (!c.valid(value)) { setMsg({ ok: false, text: `That does not look like ${c.hint}.` }); return; }
    setBusy(true);
    try {
      const body = chain === 'near'
        ? { accountId: value, mode, ...(mode === 'intents' && bridged !== 'native' ? { assets: [bridged] } : {}) }
        : { chain, address: value };
      const r = await fetch(`${ORIGIN}/v0/faucet`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
      const j = await r.json();
      if (!r.ok) setMsg({ ok: false, text: j.message || `Error ${r.status}` });
      else setMsg({ ok: true, text: `Sent ${j.drips.map((d: { amount: string; symbol: string }) => `${d.amount} ${d.symbol}`).join(', ')} to ${j.accountId || j.address} (${chain === 'near' ? j.mode : c.label}).`, txs: j.transactions });
    } catch (err) { setMsg({ ok: false, text: String(err) }); }
    setBusy(false);
  }
  const field = 'mt-1.5 w-full rounded-lg border bg-fd-background px-3 py-2 text-sm';
  return (
    <form onSubmit={go} className="not-prose my-6 rounded-2xl border bg-fd-card p-5 shadow-sm">
      <div className="grid gap-3 sm:grid-cols-[210px_1fr] sm:items-end">
        <label className="text-sm font-medium">1. Pick a chain
          <select value={chain} onChange={e => { setChain(e.target.value as FaucetChain); setMsg(null); }} className={field}>
            <option value="near">NEAR testnet (default)</option>
            <option value="eth">Ethereum Sepolia</option>
            <option value="base">Base Sepolia</option>
            <option value="arb">Arbitrum Sepolia</option>
            <option value="sol">Solana devnet</option>
            <option value="stellar">Stellar testnet</option>
            <option value="sui">Sui testnet</option>
          </select>
        </label>
        <label className="text-sm font-medium">2. Paste {chain === 'near' ? 'your testnet account' : 'your address on that chain'}
          <input required value={accountId} onChange={e => setAccount(e.target.value)} placeholder={c.placeholder} spellCheck={false} autoComplete="off" aria-invalid={invalid} className={`${field} outline-none focus:ring-2 focus:ring-fd-primary ${invalid ? 'border-red-500' : ''}`} />
          {invalid && <span className="mt-1 block text-xs font-normal text-red-600">Expected {c.hint}.</span>}
        </label>
      </div>
      {chain === 'near' && (
        <div className="mt-3 grid gap-3 sm:grid-cols-2">
          <label className="text-sm font-medium">3. Where should they land?
            <select value={mode} onChange={e => setMode(e.target.value)} className={field}>
              <option value="wallet">Wallet (NEP-141 balance)</option>
              <option value="intents">Intents balance (inside the verifier)</option>
            </select>
          </label>
          {mode === 'intents' && (
            <label className="text-sm font-medium">4. Which tokens?
              <select value={bridged} onChange={e => setBridged(e.target.value)} className={field}>
                {BRIDGED_CHOICES.map(([k, l]) => <option key={k} value={k}>{l}</option>)}
              </select>
            </label>
          )}
        </div>
      )}
      <div className="mt-3 rounded-lg bg-fd-muted/50 p-3 text-sm leading-relaxed">
        {chain === 'near' && mode === 'wallet' && <p><b>NEAR wallet:</b> mints the six NEAR test tokens (100 USDC, 100 USDT, 40 wNEAR, 0.001 wBTC, 0.03 ETH, 0.03 XAUT) into the account's NEP-141 wallet balances. The account must already exist on testnet.</p>}
        {chain === 'near' && mode === 'intents' && bridged === 'native' && <p><b>NEAR intents balance:</b> credits the same six NEAR test tokens inside the Tidepool verifier, ready to swap. Works for any account id, even one that does not exist yet. Pick a bridged option to receive USDC and USDT from another chain instead.</p>}
        {chain === 'near' && mode === 'intents' && bridged !== 'native' && <p><b>Bridged tokens in your verifier balance:</b> the maker credits the chosen chain's test tokens (<code>nep141:…tp-omft.testnet</code>) to your intents balance on NEAR. They are not sent to any wallet on that chain; to receive them on a chain, pick that chain above. Bridged drips have their own hourly limit, so they do not use up your default drip.</p>}
        {chain !== 'near' && <p><b>{c.label}:</b> our backend sends <b>100 test USDC and 100 test USDT</b> straight to that address on {c.label}. {chain === 'sol' && 'Your token accounts are created for you.'}{chain === 'stellar' && <>The account must already exist and trust both assets (issuer <code className="break-all">{ISSUER}</code>, codes <code>USDC</code> and <code>USDT</code>): add a <code>changeTrust</code> for each first.</>} Native gas is <b>not</b> included: get {c.gas} from <a className="underline" href={c.gasUrl} target="_blank" rel="noreferrer">the chain's own faucet</a>.</p>}
        <p className="mt-2 text-xs opacity-80">Limits: one claim per address every 24 hours (all variants), six per IP per hour. Test tokens have no value.</p>
      </div>
      <button disabled={busy} className="mt-3 rounded-lg bg-fd-primary px-4 py-2 text-sm font-semibold text-fd-primary-foreground disabled:opacity-60">{busy ? 'Sending…' : 'Get test tokens'}</button>
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
  const Dot = ({ ok }: { ok: boolean }) => <span className={`inline-block size-2.5 rounded-full ${ok ? 'bg-[var(--otc-ok)]' : 'bg-[var(--otc-gold)]'}`} />;
  const c = h.checks;
  const cards: [string, boolean, string][] = [
    ['NEAR testnet RPC', c.rpc?.ok, c.rpc?.ok ? `block ${c.rpc.height} · ${c.rpc.ms} ms` : 'unreachable'],
    ['Verifier code', c.verifier?.ok, c.verifier?.ok ? 'matches defuse v0.4.5' : 'hash mismatch'],
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
