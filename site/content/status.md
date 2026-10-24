# Status

Live health of the Tidepool testnet service. This page reads [`/v0/health`](/v0/health).

<div id="status-widget"><p>Loading…</p></div>

## What is checked

- **RPC:** NEAR testnet RPC reachable.
- **Verifier:** the code hash at `{{VERIFIER}}` equals the sha256 of the official release wasm (`{{SHA}}`).
- **Prices:** CoinGecko feed fresh. If it is down, Tidepool keeps the last good prices or uses static fallbacks.
- **Maker inventory:** the maker's balances inside the verifier.
