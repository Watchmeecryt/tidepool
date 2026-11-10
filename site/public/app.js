// Page actions, faucet widget and status widget. No framework.
document.querySelectorAll('[data-copy-md]').forEach(b => b.addEventListener('click', async () => {
  const md = await fetch(b.dataset.copyMd).then(r => r.text());
  await navigator.clipboard.writeText(md); const t = b.textContent; b.textContent = 'Copied'; setTimeout(() => (b.textContent = t), 1500);
}));
document.querySelectorAll('.prose pre').forEach(pre => { pre.title = 'Click to copy'; pre.addEventListener('dblclick', () => navigator.clipboard.writeText(pre.innerText)); });
const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

const fw = document.getElementById('faucet-widget');
if (fw) {
  fw.innerHTML = `<form class="card" id="ff"><div class="row"><div><label for="acct">Testnet account</label><input id="acct" placeholder="alice.testnet" required autocomplete="off"/></div><div><label for="mode">Send to</label><select id="mode"><option value="wallet">Wallet (NEP-141)</option><option value="intents">Verifier balance</option></select></div><button>Send tokens</button></div><div class="msg" id="fm"></div></form>`;
  document.getElementById('ff').addEventListener('submit', async e => {
    e.preventDefault(); const m = document.getElementById('fm'), btn = e.target.querySelector('button');
    btn.disabled = true; m.className = 'msg'; m.textContent = 'Sending… this takes a few seconds.';
    try {
      const r = await fetch('/v0/faucet', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ accountId: document.getElementById('acct').value.trim(), mode: document.getElementById('mode').value }) });
      const j = await r.json(); if (!r.ok) throw new Error(j.message);
      m.className = 'msg ok'; m.innerHTML = 'Sent: ' + j.drips.map(d => `${esc(d.amount)} ${esc(d.symbol)}`).join(', ') + '<br/>' + j.transactions.map(t => `<a target="_blank" href="${esc(t.explorerUrl)}">${esc(t.txHash.slice(0, 10))}…</a>`).join(' ');
    } catch (err) { m.className = 'msg err'; m.textContent = err.message; } finally { btn.disabled = false; }
  });
}

const sw = document.getElementById('status-widget');
if (sw) {
  const load = async () => {
    try {
      const h = await fetch('/v0/health').then(r => r.json()); const c = h.checks;
      const d = (ok, warn) => `<span class="dot ${ok ? 'ok' : warn ? '' : 'bad'}"></span>`;
      sw.innerHTML = `<div class="checks">
        <div class="check"><b>NEAR testnet RPC</b>${d(c.rpc.ok)}${c.rpc.ok ? 'block ' + c.rpc.height : 'down'}</div>
        <div class="check"><b>Verifier code</b>${d(c.verifier.ok)}${c.verifier.ok ? 'matches release' : 'mismatch'}</div>
        <div class="check"><b>Price feed</b>${d(c.prices.ok, true)}${esc(c.prices.source)}</div>
        <div class="check"><b>Swaps</b>${d(true)}${h.swaps.success} done · ${h.swaps.refunded} refunded · ${h.swaps.failed} failed · ${h.swaps.expired} expired · ${h.swaps.active} active</div></div>
        <h3>Maker inventory</h3><table><tr>${Object.keys(c.makerInventory.balances || {}).map(k => `<th>${esc(k)}</th>`).join('')}</tr><tr>${Object.values(c.makerInventory.balances || {}).map(v => `<td>${esc(Number(v).toLocaleString())}</td>`).join('')}</tr></table>
        ${h.recent?.length ? `<h3>Recent swaps</h3><table><tr><th>Pair</th><th>Status</th><th>When (UTC)</th><th>Tx</th></tr>${h.recent.map(r => `<tr><td>${esc(r.pair)}</td><td>${esc(r.status)}</td><td>${esc(r.updatedAt.replace('T', ' ').slice(0, 19))}</td><td>${r.tx ? `<a target="_blank" href="${esc(r.tx)}">NearBlocks</a>` : ''}</td></tr>`).join('')}</table>` : ''}
        <p style="font-size:13px;color:#557471">Verifier ${esc(h.verifier)} · sha256 <code>${esc(h.verifierWasmSha256)}</code></p>`;
    } catch (e) { sw.innerHTML = '<p>Could not reach /v0/health.</p>'; }
  };
  load(); setInterval(load, 15000);
}
